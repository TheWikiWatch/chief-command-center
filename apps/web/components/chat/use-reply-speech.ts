"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { speakText } from "@/lib/bridge";
import { chatTone, isMachineNote } from "@/lib/chat-tone";
import { assistantName } from "@/lib/identity";
import { planSpeech, sameText, type SpeechCandidate } from "@/lib/replay-guard";
import { splitSpeech } from "@/lib/speech-chunks";
import type { ChatMessage, ExecApproval, PendingQuestion, Transcript } from "@/lib/types";
import { currentSpeakEpoch, enqueueSpeechParts, enqueueSpeechTask, loadSpeakHighWater, persistSpeakHighWater, speakableText } from "@/lib/voice-client";

export type SpeechFailure = { id: number; script: string; reason: string; missed?: boolean; held?: boolean };

/**
 * Reading the chief's replies aloud, for one chat.
 *
 * - The speak floor is the newest row already spoken or skipped; it is kept per session (so a reload never reads
 *   history again) and primed from the first snapshot. Rows above it are planned (lib/replay-guard.ts: copies
 *   and compaction repeats are skipped, an older reply waits behind the newest) and spoken in order.
 * - With speech off, the floor follows the newest row. While disconnected, nothing is skipped: replies are
 *   spoken once the connection is back.
 * - A pending approval or a question is read out once.
 * - Failures (and replies held back) are listed for a retry.
 */
export function useReplySpeech({
  visible,
  messages,
  speakOn,
  connected,
  approval,
  question,
}: {
  visible: ChatMessage[];
  messages: ChatMessage[];
  speakOn: boolean;
  connected: boolean;
  approval?: ExecApproval | null;
  question: PendingQuestion | null;
}) {
  const speakFloor = useRef<number | null>(null);
  const spokenIds = useRef(new Set<number>());
  /** Text of replies already read aloud this session: a copy of one is never read again. */
  const spokenTexts = useRef(new Set<string>());
  const [speechFailures, setSpeechFailures] = useState<SpeechFailure[]>([]);
  const historyPrimed = useRef(false);
  const sessionKeyRef = useRef("");
  const approvalCue = useRef("");

  const raiseSpeakFloor = useCallback((id: number) => {
    if (id <= 0 || id >= 1e12) return;
    const next = Math.max(speakFloor.current || 0, id);
    speakFloor.current = next;
    persistSpeakHighWater(sessionKeyRef.current, next);
  }, []);

  const primeFromSnapshot = useCallback((data: Transcript) => {
    const key = data.sessionKey || "";
    if (key !== sessionKeyRef.current) {
      sessionKeyRef.current = key;
      spokenIds.current = new Set();
      setSpeechFailures([]);
    }
    const snapshotMax = (data.messages || []).reduce((n, m) => Math.max(n, m.id || 0), data.lastId || 0);
    const floor = Math.max(loadSpeakHighWater(key), snapshotMax);
    speakFloor.current = floor;
    persistSpeakHighWater(key, floor);
    historyPrimed.current = true;
  }, []);

  useEffect(() => {
    if (!historyPrimed.current) return;
    const floor = speakFloor.current;
    if (floor == null) return;
    if (!speakOn) {
      const max = visible.reduce((n, m) => {
        const id = m.id || 0;
        return id > 0 && id < 1e12 ? Math.max(n, id) : n;
      }, floor);
      if (max > floor) raiseSpeakFloor(max);
      return;
    }
    // While disconnected, wait: replies are spoken when the connection is back (they used to be skipped).
    if (!connected) return;
    const jobEpoch = currentSpeakEpoch();
    const candidates: SpeechCandidate[] = [];
    for (const message of visible) {
      const id = message.id || 0;
      if (id <= floor || id >= 1e12) continue;
      if (spokenIds.current.has(message.id)) continue;
      spokenIds.current.add(message.id);
      if (message.role !== "assistant") continue;
      if (isMachineNote(chatTone(message))) continue;
      const script = speakableText(message.content || "");
      if (script) candidates.push({ message, script });
    }
    const plan = planSpeech(candidates, messages, spokenTexts.current);
    // Copies and repeats are history: move the floor past them so a reload never reads them either.
    for (const { message } of plan.repeats) raiseSpeakFloor(message.id);
    if (plan.held.length) {
      setSpeechFailures(items => [
        ...items.filter(item => !plan.held.some(h => h.message.id === item.id)),
        ...plan.held.map(h => ({ id: h.message.id, script: h.script, reason: "Read the newest reply first", held: true })),
      ]);
    }
    for (const { message, script } of plan.speak) {
      spokenTexts.current.add(sameText(message.content || ""));
      void speakScript(script, jobEpoch).then(result => {
        if (jobEpoch !== currentSpeakEpoch()) return;
        if (result.status === "played") {
          raiseSpeakFloor(message.id);
          setSpeechFailures(items => items.filter(item => item.id !== message.id));
        }
        if (result.status === "failed" || result.status === "missed") {
          setSpeechFailures(items => [
            ...items.filter(item => item.id !== message.id),
            { id: message.id, script, reason: result.reason || "Playback never started", missed: result.status === "missed" },
          ]);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, speakOn, connected, raiseSpeakFloor]);

  useEffect(() => {
    if (!speakOn || !approval?.requestId) return;
    if (approvalCue.current === approval.requestId) return;
    approvalCue.current = approval.requestId;
    const jobEpoch = currentSpeakEpoch();
    void enqueueSpeechTask(async () => {
      const res = await speakText(`${assistantName()} needs your approval`);
      return speechClips(res);
    }, jobEpoch).then(result => {
      if (jobEpoch !== currentSpeakEpoch()) return;
      if (result.status === "played") setSpeechFailures(items => items.filter(item => item.id !== 0));
      if (result.status === "failed") {
        setSpeechFailures(items => [
          ...items.filter(item => item.id !== 0),
          { id: 0, script: `${assistantName()} needs your approval`, reason: result.reason || "Playback never started" },
        ]);
      }
    });
  }, [approval, speakOn]);

  // Voice: the question is read out, so it can be answered without looking.
  const questionCue = useRef("");
  useEffect(() => {
    if (!speakOn || !question?.id || questionCue.current === question.id) return;
    questionCue.current = question.id;
    const script = `${assistantName()} asks: ${question.question}`;
    const jobEpoch = currentSpeakEpoch();
    void enqueueSpeechTask(async () => speechClips(await speakText(script)), jobEpoch);
  }, [question, speakOn]);

  function retrySpeech() {
    const jobs = speechFailures;
    setSpeechFailures([]);
    const jobEpoch = currentSpeakEpoch();
    for (const job of jobs) {
      void speakScript(job.script, jobEpoch).then(result => {
        if (jobEpoch !== currentSpeakEpoch()) return;
        if (result.status === "played" && job.id) raiseSpeakFloor(job.id);
        if (result.status === "failed" || result.status === "missed") {
          setSpeechFailures(items => [...items, { ...job, reason: result.reason || job.reason, missed: result.status === "missed" }]);
        }
      });
    }
  }

  return { speechFailures, setSpeechFailures, retrySpeech, raiseSpeakFloor, primeFromSnapshot, historyPrimed, sessionKeyRef, spokenIds };
}

function speechClips(res: { ok: boolean; data_url?: string; data_urls?: string[]; error?: string }) {
  const urls = (res.data_urls?.length ? res.data_urls : res.data_url ? [res.data_url] : []).filter(Boolean);
  if (!res.ok || !urls.length) throw new Error(res.error || "Speech unavailable");
  return urls;
}

/** A reply as speech parts: a short first part so sound starts quickly, the rest prepared while it plays. */
function speakScript(script: string, jobEpoch: number) {
  const parts = splitSpeech(script).map(text => async () => speechClips(await speakText(text, 45_000)));
  return enqueueSpeechParts(parts, jobEpoch, script.slice(0, 80));
}

export function speechFailureReason(items: SpeechFailure[]) {
  return Array.from(new Set(items.map(item => item.reason).filter(Boolean))).join(" ");
}
