"use client";

import { useAttentiveGaze } from "@/lib/use-attentive-gaze";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import "blobatar/gaze.css";

import { poll } from "@/lib/poll";
import { useResourceHealth } from "@/components/resource-status";
import { ChiefPresence } from "@/components/presence";
import { ApprovalSheet } from "@/components/chat/approval-sheet";
import { botIdentity } from "@/lib/bot-identity";
import { ChatHeader, type ChiefMood } from "@/components/chat/chat-header";
import { VoiceMode } from "@/components/chat/voice-mode";
import { FollowupCards, followupAsk, useFollowupWatch } from "@/components/chat/followup-cards";
import { Composer, type PendingFile } from "@/components/chat/composer";
import { Thread } from "@/components/chat/thread";
import { CheckIcon, PaperclipIcon, XIcon } from "@/components/icons";
import { type MicStatus } from "@/components/mic-button";
import { meterStream } from "@/lib/audio-level";
import { fx } from "@/lib/fx";
import { fetchEarlier, fetchTranscript, fetchVoiceConfig, resolveApproval, sendToChief, speakText, stopTurn, type OutboundAttachment } from "@/lib/bridge";
import { VOICE_FALLBACK_EVENT } from "@/lib/voice-events";
import { SHOW_APPROVAL_EVENT } from "@/lib/open-target";
import { chatTone, isMachineNote } from "@/lib/chat-tone";
import { computeThinkingChrome, shouldClearPendingReply } from "@/lib/thinking-chrome";
import { visibleMessages } from "@/lib/compact-filter";
import { fullPhotosOn, useDashboardPrefs, VOICE_EVENT } from "@/lib/dashboard-prefs";
import {
  currentSpeakEpoch,
  enqueueSpeechParts,
  enqueueSpeechTask,
  getSpeechPhase,
  loadSpeakHighWater,
  persistSpeakHighWater,
  blobToDataUrl,
  speakableText,
  stopSpeech,
  subscribeSpeaking,
  toggleSpeechPause,
} from "@/lib/voice-client";
import type { ApprovalChoice, ChatAttachment, ChatMessage, ExecApproval, Person, Transcript } from "@/lib/types";
import { admitFiles } from "@/lib/upload-limits";
import { shrinkImage } from "@/lib/image-shrink";
import { retryable, type QueuedSend } from "@/lib/outbox";
import { useOutbox } from "@/components/chat/use-outbox";
import { splitSpeech } from "@/lib/speech-chunks";
import { logSpeech } from "@/lib/speech-log";
import { dropReplays, planSpeech, sameText, type SpeechCandidate } from "@/lib/replay-guard";
import { useAssistantName, assistantName } from "@/lib/identity";

/** A reply that was not read aloud: it failed, arrived while you were away, or was held behind a newer one. */
type SpeechFailure = { id: number; script: string; reason: string; missed?: boolean; held?: boolean };

/** The unsent message survives a reload (Android can drop the app from memory mid-thought). */
const DRAFT_KEY = "chief-chat-draft";

export type ChatSend = (text: string) => Promise<void>;

export function ChiefChat({
  chief,
  people = [],
  lookAtEl,
  connected,
  authFailed,
  approval,
  onSendReady,
  compact,
  onThinkingChange,
  onApprovalResolved,
  onApprovalUpdate,
  onOpenSettings,
  onOpenStatus,
}: {
  chief: Person | undefined;
  /** The fleet, for faces on follow-up reminders. */
  people?: Person[];
  lookAtEl: HTMLElement | null;
  connected: boolean;
  authFailed?: boolean;
  approval?: ExecApproval | null;
  onSendReady?: (send: ChatSend | null) => void;
  compact?: boolean;
  onThinkingChange?: (thinking: boolean) => void;
  onApprovalResolved?: (requestId: string) => void;
  /** The pending approval as the bridge reported it with the transcript (so the shell needn't poll it). */
  onApprovalUpdate?: (approval: ExecApproval | null) => void;
  onOpenSettings?: () => void;
  onOpenStatus?: () => void;
}) {
  const assistant = useAssistantName();
  const lookAtRef = useRef(lookAtEl);
  lookAtRef.current = lookAtEl;
  const { ref } = useAttentiveGaze(() => lookAtRef.current);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const lastIdRef = useRef(0);
  const [text, setText] = useState("");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) setText((current) => current || saved);
    } catch {
      /* private mode */
    }
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        if (text) localStorage.setItem(DRAFT_KEY, text);
        else localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* private mode */
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [text]);
  // Files dragged over the chat (desktop): a drop target over the whole pane.
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const [busy, setBusy] = useState(false);
  const [pendingReply, setPendingReply] = useState(false);
  const busyRef = useRef(false);
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  generatingRef.current = generating;
  // Messages to send once the chief finishes the current turn ("Send after"), oldest first.
  const [afterQueue, setAfterQueue] = useState<{ id: string; text: string }[]>([]);
  // What was added to running work this session, so its stored copy keeps the "Added while working" tag.
  const steeredTexts = useRef(new Set<string>());
  const [stopping, setStopping] = useState(false);
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const [approvalError, setApprovalError] = useState("");
  const [sendError, setSendError] = useState("");
  const [sendNotice, setSendNotice] = useState("");
  // Once the bridge can hold requests (?wait=), the chat long-polls: a reply shows the moment it
  // lands, and an idle chat makes one request every 25s instead of one every 2.5s.
  const [longpoll, setLongpoll] = useState(false);
  const longpollRef = useRef(false);
  const bridgeState = useRef({ generating: false, approval: "" });
  const quickReturns = useRef(0);
  const approvalUpdate = useRef(onApprovalUpdate);
  approvalUpdate.current = onApprovalUpdate;
  const transcriptHealth = useResourceHealth("Chat", longpoll ? 40_000 : 5_000);
  const [earlier, setEarlier] = useState<{ more: boolean; loading: boolean; error: string }>({ more: true, loading: false, error: "" });
  const awaitingRef = useRef(false);
  useEffect(() => { setApprovalError(""); }, [approval?.requestId]);
  const [approvalMin, setApprovalMin] = useState(false);
  useEffect(() => { setApprovalMin(false); }, [approval?.requestId]);
  // A tapped approval notification brings the sheet back up if it was minimized to the pill.
  useEffect(() => {
    const show = () => setApprovalMin(false);
    window.addEventListener(SHOW_APPROVAL_EVENT, show);
    return () => window.removeEventListener(SHOW_APPROVAL_EVENT, show);
  }, []);
  const stopMicMeter = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopMicMeter.current?.(), []);
  const prefs = useDashboardPrefs(!!compact);
  const fontPx = prefs.fontPx;
  const speakOn = prefs.speakOn;
  const [voiceHint, setVoiceHint] = useState("");
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceLabel, setVoiceLabel] = useState("");
  const [micStatus, setMicStatus] = useState<MicStatus>({ state: "idle", cancelling: false });
  const micPrev = useRef<MicStatus>({ state: "idle", cancelling: false });
  const speakFloor = useRef<number | null>(null);
  const spokenIds = useRef(new Set<number>());
  /** Text of replies already read aloud this session: a copy of one is never read again. */
  const spokenTexts = useRef(new Set<string>());
  const [speechFailures, setSpeechFailures] = useState<SpeechFailure[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const historyPrimed = useRef(false);
  const sessionKeyRef = useRef("");
  const approvalCue = useRef("");
  const approvalChime = useRef("");
  useEffect(() => {
    if (!approval?.requestId || approvalChime.current === approval.requestId) return;
    approvalChime.current = approval.requestId;
    fx("approval");
  }, [approval?.requestId]);
  const retrySend = useRef<{ signature: string; id: string } | null>(null);
  // Messages waiting for Chief (lib/outbox.ts): sent in order when he is reachable again.
  const onQueuedDelivered = useCallback((item: QueuedSend, previews: string[]) => {
    const images = item.files.filter(f => f.mime.startsWith("image/"));
    const bubble: ChatMessage = {
      id: Date.now(),
      role: "user",
      content: item.text,
      timestamp: new Date().toISOString(),
      delivery: "sent",
      attachments: previews.map((path, i) => ({ path, name: images[i]?.name || "photo", kind: "image", mime: images[i]?.mime || "image/jpeg" })),
    };
    if (previews.length) sentPreviews.current.set(bubble.id, previews);
    setMessages(m => [...m, bubble]);
    setPendingReply(true);
    fx("send");
  }, []);
  const onQueuedDropped = useCallback((item: QueuedSend, reason: string) => {
    setSendError(`A queued message wasn't sent: ${reason}${item.text ? " Its text is back in your draft." : ""}`);
    if (item.text) setText(current => (current.trim() ? current : item.text));
    fx("error");
  }, []);
  const outbox = useOutbox({ ready: connected && !authFailed, onDelivered: onQueuedDelivered, onDropped: onQueuedDropped });
  const cancelQueued = useCallback(
    (queueId: string) => {
      const item = outbox.cancel(queueId);
      if (item?.text) setText(current => (current.trim() ? current : item.text));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outbox.cancel],
  );
  // Previews of sent files (blob: URLs) are released once their "Sending…" bubble is replaced.
  const sentPreviews = useRef(new Map<number, string[]>());
  useEffect(() => {
    for (const [id, urls] of sentPreviews.current) {
      if (messages.some((m) => m.id === id)) continue;
      for (const url of urls) URL.revokeObjectURL(url);
      sentPreviews.current.delete(id);
    }
  }, [messages]);
  useEffect(
    () => () => {
      for (const urls of sentPreviews.current.values()) for (const url of urls) URL.revokeObjectURL(url);
      sentPreviews.current.clear();
    },
    [],
  );
  // "preparing" (voice being made, no sound yet) is shown apart from "playing" (sound coming out).
  const speechPhase = useSyncExternalStore(subscribeSpeaking, getSpeechPhase, () => "idle" as const);
  const paused = speechPhase === "paused";

  const visible = useMemo(
    () => visibleMessages(messages, prefs.compactChat),
    [messages, prefs.compactChat],
  );
  // Messages waiting in the outbox show after the thread, with Cancel.
  const threadMessages = useMemo(() => {
    const tagged = steeredTexts.current.size
      ? visible.map((m) => (m.role === "user" && !m.steered && steeredTexts.current.has(m.content.trim()) ? { ...m, steered: true } : m))
      : visible;
    return outbox.bubbles.length ? [...tagged, ...outbox.bubbles] : tagged;
  }, [visible, outbox.bubbles]);
  const awaiting = computeThinkingChrome({
    connected,
    pendingReply,
    busy,
    generating,
    approval: !!approval,
    // Thinking must see the full transcript, not the Compact-filtered list
    messages: messages.filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "tool" || m.role === "system",
    ),
  });

  awaitingRef.current = awaiting;

  useEffect(() => {
    if (micStatus.state === "recording" || micStatus.state === "transcribing") setVoiceHint("");
  }, [micStatus.state]);

  useEffect(() => {
    let alive = true;
    let base = "";
    // When VoiceStudio (or another plugin engine) failed and Edge spoke instead, say so for 10 minutes.
    let fallbackUntil = 0;
    let clear = 0;
    const show = () => {
      if (!alive || !base) return;
      const fallback = Date.now() < fallbackUntil;
      setVoiceLabel(fallback ? `${base} \u00b7 Edge fallback` : base);
      window.clearTimeout(clear);
      if (fallback) clear = window.setTimeout(show, fallbackUntil - Date.now() + 50);
    };
    const load = () => {
      fetchVoiceConfig()
        .then((cfg) => {
          if (!alive) return;
          if (cfg.missing) {
            base = "";
            setVoiceLabel("Voice not loaded — relaunch Chief Command Center");
            return;
          }
          const stt = cfg.stt?.provider || "local";
          const tts = cfg.tts?.provider || "edge";
          base = `Voice \u00b7 ${stt} / ${tts}`;
          const at = cfg.tts?.fallback?.at;
          if (at) fallbackUntil = Math.max(fallbackUntil, at * 1000 + 600_000);
          show();
        })
        .catch(() => {
          if (alive) setVoiceLabel("");
        });
    };
    const onFallback = () => {
      fallbackUntil = Date.now() + 600_000;
      show();
    };
    load();
    window.addEventListener(VOICE_EVENT, load);
    window.addEventListener(VOICE_FALLBACK_EVENT, onFallback);
    return () => {
      alive = false;
      window.clearTimeout(clear);
      window.removeEventListener(VOICE_EVENT, load);
      window.removeEventListener(VOICE_FALLBACK_EVENT, onFallback);
    };
  }, []);

  useEffect(() => {
    onThinkingChange?.(awaiting);
  }, [awaiting, onThinkingChange]);
  useEffect(() => {
    if (shouldClearPendingReply({ pendingReply, messages, generating, busy })) {
      setPendingReply(false);
    }
  }, [messages, pendingReply, generating, busy]);


  useEffect(() => {
    return () => onThinkingChange?.(false);
  }, [onThinkingChange]);

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

  const applyTranscript = useCallback(
    (data: Transcript, after: number) => {
      setGenerating(!!data.generating);
      if (historyPrimed.current && data.sessionKey !== sessionKeyRef.current) {
        historyPrimed.current = false;
        lastIdRef.current = 0;
        setMessages([]);
        setEarlier({ more: true, loading: false, error: "" });
        earlierCursor.current = null;
        stopSpeech();
        if (after) return;
      }
      const canPrime = !!(data.sessionKey || (data.messages || []).length);
      if (!historyPrimed.current) {
        if (after) {
          lastIdRef.current = 0;
          return;
        }
        if (!canPrime) return;
        lastIdRef.current = data.lastId || 0;
        setMessages(data.messages || []);
        primeFromSnapshot(data);
        return;
      }
      lastIdRef.current = data.lastId || after;
      if (!after) {
        setMessages(data.messages || []);
        if (data.sessionKey && data.sessionKey !== sessionKeyRef.current) primeFromSnapshot(data);
        return;
      }
      if (data.messages?.length) {
        setMessages((prev) => mergeMsgs(prev, data.messages));
        const replays = data.messages.filter((m) => m.replay).length;
        if (replays) {
          // Hermes compacted Chief's context and re-sent the conversation it kept. Not new: not shown or spoken.
          logSpeech({
            at: Date.now(),
            preview: "Context compaction",
            parts: 0,
            outcome: "skipped",
            reason: `${replays} earlier ${replays === 1 ? "message was" : "messages were"} re-sent after compaction; not shown or read again`,
            hidden: document.visibilityState === "hidden",
            metered: false,
          });
        }
        if (data.messages.some((m) => !m.replay && m.role === "assistant" && chatTone(m) === "reply" && (m.content || "").trim())) fx("reply");
      }
    },
    [primeFromSnapshot],
  );

  useEffect(() => poll(async signal => {
    const after = historyPrimed.current ? lastIdRef.current || 0 : 0;
    // What the bridge last told us, not local guesses: a difference would return the long-poll at once.
    const live = longpollRef.current && after ? { wait: 25, gen: bridgeState.current.generating, approval: bridgeState.current.approval } : undefined;
    const started = Date.now();
    try {
      const data = await fetchTranscript(after, signal, live);
      if (signal.aborted) return;
      applyTranscript(data, after);
      bridgeState.current = { generating: !!data.generating, approval: data.approval?.requestId || "" };
      if ("approval" in data) approvalUpdate.current?.(data.approval ?? null);
      if (data.longpoll && !longpollRef.current) {
        longpollRef.current = true;
        setLongpoll(true);
      }
      // A long-poll that keeps coming straight back (a bridge that can't hold) must not spin.
      quickReturns.current = live && Date.now() - started < 300 && !data.messages.length ? quickReturns.current + 1 : 0;
      transcriptHealth.success();
    } catch (error) {
      if (!signal.aborted) transcriptHealth.failure(error);
    }
  }, () => (longpollRef.current ? (quickReturns.current > 3 ? 2500 : 150) : awaitingRef.current ? 800 : 2500)), [applyTranscript]);

  // Load earlier: pages of older rows before the oldest one shown.
  // Where the next page starts: the bridge's cursor, so rows skipped here are never asked for again.
  const earlierCursor = useRef<number | null>(null);
  const loadEarlier = useCallback(async () => {
    const oldest = messages.reduce((n, m) => (m.id > 0 && m.id < 1e12 ? Math.min(n, m.id) : n), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(oldest)) return;
    let before = Math.min(oldest, earlierCursor.current ?? oldest);
    // Earlier pages include the conversation archived at Chief's last compaction; the thread already
    // shows its kept tail as the copies Hermes re-inserted (flagged replay), so skip their originals.
    const copies = new Set(messages.filter(m => m.replay).map(m => `${m.role}|${sameText(m.content || "")}`));
    const have = new Set(messages.map(m => m.id));
    setEarlier(e => ({ ...e, loading: true, error: "" }));
    try {
      let found: ChatMessage[] = [];
      let more = true;
      // A page can be all tool calls or copies: read on (a few pages) until something shows.
      for (let page = 0; page < 3 && more && !found.length; page++) {
        const data = await fetchEarlier(before);
        found = data.messages.filter(m => !have.has(m.id) && !m.replay && m.id < oldest && !copies.has(`${m.role}|${sameText(m.content || "")}`));
        more = !!data.more;
        before = typeof data.cursor === "number" ? Math.min(before, data.cursor) : before;
      }
      earlierCursor.current = before;
      if (found.length) setMessages(prev => [...found.filter(m => !prev.some(p => p.id === m.id)), ...prev]);
      setEarlier({ more, loading: false, error: "" });
    } catch (error) {
      setEarlier(e => ({ ...e, loading: false, error: error instanceof Error ? error.message : "Couldn't load earlier messages" }));
    }
  }, [messages]);

  useEffect(() => {
    if (!pendingReply || generating || busy) return;
    const timer = window.setTimeout(() => setPendingReply(false), 21_000);
    return () => window.clearTimeout(timer);
  }, [pendingReply, generating, busy]);

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

  function addFiles(list: FileList | null) {
    const picked = Array.from(list || []);
    if (!picked.length) return;
    setSendError("");
    // Photos are shrunk on this device first (lib/image-shrink.ts) unless Settings says full size.
    void Promise.all(picked.map(file => (fullPhotosOn() ? file : shrinkImage(file)))).then(admit);
  }

  function admit(incoming: File[]) {
    setPendingFiles(current => {
      const next = [...current];
      const { accepted, error } = admitFiles(current.map(item => ({ name: item.name, size: item.file.size })), incoming);
      if (error) setSendError(error);
      for (const file of accepted) {
        const mime = file.type || "application/octet-stream";
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${next.length}`,
          name: file.name || "file",
          mime,
          previewUrl: URL.createObjectURL(file),
          file,
        });
      }
      return next;
    });
  }

  function removeFile(id: string) {
    setPendingFiles(current => {
      const target = current.find(item => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter(item => item.id !== id);
    });
  }

  async function sendBody(body: string, files: PendingFile[] = pendingFiles): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed && !files.length) throw new Error("Message is empty.");
    if (busyRef.current) throw new Error("A message is still sending. Try again when it finishes.");
    if (authFailed) throw new Error(`${assistantName()} is unavailable. Your message has been kept.`);
    if (!connected) {
      // Chief is unreachable: the message waits in the outbox and goes when he is back.
      await outbox.enqueue(newSendId(), trimmed, files.map(file => ({ name: file.name, mime: file.mime, blob: file.file })));
      releasePending(files);
      setSendError("");
      showNotice(`${assistantName()} is offline. Your message will go once they're back.`);
      fx("send");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setPendingReply(true);
    setSendError("");
    setSendNotice("");
    const localAttachments: ChatAttachment[] = files.map(file => ({
      path: file.previewUrl || file.name,
      name: file.name,
      kind: file.mime.startsWith("image/") ? "image" : file.mime.startsWith("video/") ? "video" : file.mime.startsWith("audio/") ? "audio" : "file",
      mime: file.mime,
    }));
    // Sent while the chief works: it is added to that work (steer mode), not a new turn.
    const steered = generatingRef.current && !files.length;
    if (steered) steeredTexts.current.add(trimmed);
    const optimistic: ChatMessage = {
      id: Date.now(),
      role: "user",
      content: trimmed,
      timestamp: new Date().toISOString(),
      attachments: localAttachments.filter(item => item.path || item.name),
      ...(steered ? { steered: true } : {}),
    };
    setMessages(m => [...m, optimistic]);
    // Retrying the same draft reuses its id, so a send that timed out after Chief got it is not doubled.
    const signature = JSON.stringify([trimmed, files.map(file => file.id)]);
    if (retrySend.current?.signature !== signature) retrySend.current = { signature, id: newSendId() };
    const clientId = retrySend.current.id;
    try {
      const attachments: OutboundAttachment[] = await Promise.all(files.map(async file => ({
        name: file.name,
        mime: file.mime,
        data_url: await blobToDataUrl(file.file),
      })));
      const result = await sendToChief(trimmed, attachments, clientId);
      // Accepted by the bridge but refused: not something a retry fixes.
      if (!result.ok) throw Object.assign(new Error(result.error || `${assistantName()} did not accept the message.`), { status: 422 });
      retrySend.current = null;
      setPendingFiles(current => current.filter(item => !files.some(file => file.id === item.id)));
      const previews = files.map(file => file.previewUrl).filter((url): url is string => !!url);
      if (previews.length) sentPreviews.current.set(optimistic.id, previews);
      // Chief has it; the bubble stays until the transcript brings the stored copy.
      setMessages(m => m.map(item => (item === optimistic ? { ...item, delivery: "sent" } : item)));
      showNotice(steered ? `Added to what ${assistantName()} is doing.` : `Sent to ${assistantName()}.`);
      fx("send");
    } catch (error) {
      setPendingReply(false);
      setMessages(m => m.filter(item => item !== optimistic));
      if (retryable(error)) {
        // The network or the gateway, not the message: queue it under the same id, so if it did reach
        // Chief before the failure the bridge drops the repeat.
        retrySend.current = null;
        const reason = error instanceof Error ? error.message : `${assistantName()} is unreachable`;
        await outbox.enqueue(clientId, trimmed, files.map(file => ({ name: file.name, mime: file.mime, blob: file.file })), reason);
        releasePending(files);
        showNotice(`Couldn't reach ${assistantName()}. Queued; it will retry on its own.`);
        return;
      }
      const detail = error instanceof Error ? error.message : "Send failed.";
      setSendError(`${detail} Your draft has been kept.`);
      fx("error");
      throw error;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  function showNotice(text: string) {
    setSendNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setSendNotice(""), 4000);
  }

  /** Stop the chief's current turn (Hermes's /stop). The partial reply stays in the thread. */
  async function stopWork() {
    if (stopping) return;
    setStopping(true);
    try {
      const res = await stopTurn();
      if (!res.ok) throw new Error(res.error || "Couldn't stop.");
      setPendingReply(false);
      showNotice(`Stopped ${assistantName()}.`);
      fx("send");
    } catch (error) {
      setSendError(error instanceof Error ? `${error.message}` : "Couldn't stop.");
      fx("error");
    } finally {
      setStopping(false);
    }
  }

  /** "Send after": the draft waits as a chip and goes, in order, once the chief finishes. */
  function sendAfter() {
    const draft = text.trim();
    if (!draft) return;
    setAfterQueue((q) => [...q, { id: newSendId(), text: draft }]);
    setText("");
    showNotice(`Will send when ${assistantName()} finishes.`);
  }

  /** Files now owned by the outbox leave the composer (their composer previews are released). */
  function releasePending(files: PendingFile[]) {
    setPendingFiles(current => current.filter(item => !files.some(file => file.id === item.id)));
    for (const file of files) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
  }
  // Send-after chips go one at a time, each when the chief is idle again (the send itself makes him busy).
  useEffect(() => {
    if (!afterQueue.length || generating || busy || !connected || authFailed) return;
    const timer = setTimeout(() => {
      if (generatingRef.current || busyRef.current) return;
      const [next, ...rest] = afterQueue;
      setAfterQueue(rest);
      void sendBody(next.text, []).catch(() => setAfterQueue((q) => [next, ...q]));
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [afterQueue, generating, busy, connected, authFailed]);

  const sendRef = useRef<ChatSend>(sendBody);
  sendRef.current = sendBody;
  useEffect(() => {
    onSendReady?.(body => sendRef.current(body));
    return () => onSendReady?.(null);
  }, [onSendReady]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body && !pendingFiles.length) return;
    try { await sendBody(body, pendingFiles); setText(""); } catch (error) { setSendError(error instanceof Error ? error.message : "Send failed. Your draft has been kept."); }
  }

  function chooseApproval(choice: ApprovalChoice) {
    if (!approval || resolvingRef.current) return;
    const requestId = approval.requestId;
    resolvingRef.current = true;
    setResolving(true);
    setApprovalError("");
    void resolveApproval(requestId, choice)
      .then((result) => {
        if (!result.ok || !result.resolved) throw new Error(result.error || "That approval is no longer pending. Wait for the next update.");
        if (choice === "always") fx("confirm");
        onApprovalResolved?.(requestId);
      })
      .catch((error) => {
        setApprovalError(error instanceof Error ? error.message : "Approval failed. Check its status before retrying.");
        fx("error");
      })
      .finally(() => {
        resolvingRef.current = false;
        setResolving(false);
      });
  }

  const mood: ChiefMood = approval
    ? "approval"
    : micStatus.state === "recording"
      ? "listening"
      : paused
        ? "paused"
        : speechPhase === "playing"
          ? "speaking"
          : speechPhase === "preparing"
            ? "preparing"
            : awaiting
            ? "thinking"
            : !connected || authFailed
              ? "offline"
              : "online";
  const chiefFace = chief ? <ChiefPresence chief={chief} size={36} mood={mood} gazeRef={ref} /> : null;
  const followups = useFollowupWatch(messages, { primed: historyPrimed.current && messages.length > 0, busy: awaiting || busy });

  const onMicStatus = (next: MicStatus) => {
    const prev = micPrev.current;
    if (prev.state !== "recording" && next.state === "recording") fx("voice", "start");
    else if (prev.state === "recording" && next.state === "transcribing") fx("voice", "stop");
    else if (next.state === "recording" && next.cancelling !== prev.cancelling) fx("voice", "cancel");
    micPrev.current = next;
    setMicStatus(next);
  };
  const onTranscript = async (spoken: string) => {
    setVoiceHint("");
    setText(spoken);
    await sendBody(spoken);
    setText("");
  };
  const onMicStream = (stream: MediaStream | null) => {
    stopMicMeter.current?.();
    stopMicMeter.current = stream ? meterStream("mic", stream) : undefined;
  };
  const lastYou = voiceOpen ? lastText(visible, (m) => m.role === "user" && !isMachineNote(chatTone(m))) : "";
  const lastReply = voiceOpen ? lastText(visible, (m) => m.role === "assistant" && chatTone(m) === "reply") : "";

  // Files can be added while Chief is offline too: they wait in the outbox with the message.
  const canAttach = !authFailed && !busy;
  const draggingFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");

  return (
    <div
      className="chief-chat relative flex h-full flex-col bg-pane"
      style={{ ["--chat-fs" as string]: `${fontPx}px` }}
      onDragEnter={(e) => {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDropping(true);
      }}
      onDragOver={(e) => {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = canAttach ? "copy" : "none";
      }}
      onDragLeave={(e) => {
        if (!draggingFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDropping(false);
      }}
      onDrop={(e) => {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        if (canAttach) addFiles(e.dataTransfer.files);
      }}
    >
      {dropping ? (
        <div className="pointer-events-none absolute inset-2 z-50 grid place-items-center rounded-card border-2 border-dashed border-accent/60 bg-canvas/80 backdrop-blur-sm">
          <p className="flex items-center gap-2 text-headline text-fg">
            <PaperclipIcon size={20} className="text-accent-text" />
            {canAttach ? `Drop files for ${assistant}` : `${assistant} can't take files right now`}
          </p>
        </div>
      ) : null}
      <ChatHeader
        chief={chief}
        mood={mood}
        voiceLabel={voiceLabel}
        connected={connected}
        authFailed={authFailed}
        compact={compact}
        onPauseToggle={() => toggleSpeechPause()}
        onStop={() => {
          stopSpeech();
          setSpeechFailures([]);
        }}
        onOpenStatus={onOpenStatus}
        onOpenSettings={onOpenSettings}
        onVoiceMode={() => setVoiceOpen(true)}
        face={chiefFace}
      />
      <ChatAurora mood={mood} color={chief ? botIdentity({ id: chief.id, name: chief.name, color: chief.color, shape: chief.shape, custom: chief.custom, isChief: true }).color : undefined} />
      <Thread
        messages={threadMessages}
        onCancelQueued={cancelQueued}
        earlier={messages.length ? earlier : undefined}
        onLoadEarlier={loadEarlier}
        chief={chief}
        awaiting={awaiting}
        waitingApproval={!!approval}
        connected={connected}
        authFailed={authFailed}
        onSuggestion={(s) => setText(s)}
      />
      <form onSubmit={onSubmit} className="shrink-0">
        <div className="px-4 pb-2 empty:hidden">
          <FollowupCards
            items={followups}
            people={people}
            chief={chief}
            disabled={!connected || !!authFailed || busy}
            onAsk={(item) => sendBody(followupAsk(item))}
          />
        </div>
        <div className="space-y-1.5 px-4 empty:hidden">
          {sendError ? (
            <p role="alert" className="text-callout text-danger">
              {sendError}
            </p>
          ) : null}
          {sendNotice ? (
            <p role="status" className="flex items-center gap-1.5 text-caption text-fg-3">
              <CheckIcon size={13} className="text-ok" />
              {sendNotice}
            </p>
          ) : null}
          {voiceHint ? <p className="text-callout text-accent-text">{voiceHint}</p> : null}
          {micStatus.state === "transcribing" ? <p className="shimmer-text text-callout font-medium">Transcribing…</p> : null}
          {speechFailures.length ? (
            <div role="alert" className="flex flex-wrap items-center gap-x-2 text-callout text-warn">
              {speechFailures.every(item => item.held) ? (
                <span>
                  {speechFailures.length} earlier {speechFailures.length === 1 ? "reply wasn't" : "replies weren't"} read aloud.
                </span>
              ) : speechFailures.every(item => item.missed || item.held) ? (
                <span>
                  Missed {speechFailures.length} {speechFailures.length === 1 ? "reply" : "replies"} while you were away.
                </span>
              ) : (
                <span>
                  Could not speak {speechFailures.length} {speechFailures.length === 1 ? "reply" : "replies"}. {speechFailureReason(speechFailures)}
                </span>
              )}
              <button type="button" className="min-h-11 font-medium underline" onClick={retrySpeech}>
                {speechFailures.every(item => item.missed || item.held) ? "Play" : "Retry speech"}
              </button>
            </div>
          ) : null}
        </div>
        <ApprovalSheet
          approval={approval}
          minimized={approvalMin}
          resolving={resolving}
          error={approvalError}
          onMinimize={() => setApprovalMin(true)}
          onExpand={() => setApprovalMin(false)}
          onChoose={chooseApproval}
        />
        {afterQueue.length ? (
          <ul className="flex flex-col gap-1.5 px-4 pb-2" aria-label={`Waiting to send when ${assistantName()} finishes`}>
            {afterQueue.map((item) => (
              <li key={item.id} className="flex items-center gap-2 rounded-card border border-line-2 bg-card px-3 py-2">
                <span className="shrink-0 text-caption text-fg-3">After {assistantName()} finishes:</span>
                <span className="min-w-0 flex-1 truncate text-callout text-fg">{item.text}</span>
                {generating ? (
                  <button
                    type="button"
                    className="press min-h-9 shrink-0 rounded-full px-2.5 text-caption font-medium text-fg-2 hover:text-fg"
                    onClick={() => {
                      setAfterQueue((q) => q.filter((x) => x.id !== item.id));
                      void sendBody(item.text, []).catch(() => setAfterQueue((q) => [item, ...q]));
                    }}
                  >
                    Add now
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove: ${item.text}`}
                  className="press grid size-9 shrink-0 place-items-center rounded-full text-fg-3 hover:text-fg"
                  onClick={() => setAfterQueue((q) => q.filter((x) => x.id !== item.id))}
                >
                  <XIcon size={15} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <Composer
          text={text}
          onText={setText}
          pendingFiles={pendingFiles}
          onAddFiles={addFiles}
          onRemoveFile={removeFile}
          connected={connected && !authFailed}
          offline={!connected && !authFailed}
          busy={busy}
          micStatus={micStatus}
          onMicStatus={onMicStatus}
          onTranscript={onTranscript}
          onMicError={setVoiceHint}
          onMicStream={onMicStream}
          phone={!!compact}
          working={generating && connected && !authFailed}
          onStop={stopping ? undefined : () => void stopWork()}
          onSendAfter={sendAfter}
        />
      </form>
      <VoiceMode
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        chief={chief}
        mood={mood}
        micStatus={micStatus}
        connected={connected && !authFailed}
        busy={busy}
        lastYou={lastYou}
        lastReply={lastReply}
        speakOn={speakOn}
        hint={voiceHint}
        onEnableSpeech={() => prefs.setSpeak(true)}
        onPauseToggle={() => toggleSpeechPause()}
        onStop={() => {
          stopSpeech();
          setSpeechFailures([]);
        }}
        onMicStatus={onMicStatus}
        onTranscript={onTranscript}
        onMicError={setVoiceHint}
        onMicStream={onMicStream}
      />
    </div>
  );
}

/** Plain text of the newest message matching `pick`, for voice mode's captions. */
function lastText(list: ChatMessage[], pick: (m: ChatMessage) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (!pick(list[i])) continue;
    const text = (list[i].content || "")
      .replace(/MEDIA:\s*.+?(?=\s+MEDIA:|$)/gi, "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[*_`#>]+/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  }
  return "";
}

function newSendId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* insecure context */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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

function speechFailureReason(items: SpeechFailure[]) {
  return Array.from(new Set(items.map(item => item.reason).filter(Boolean))).join(" ");
}

/** An all-day session keeps growing; the oldest rows go once the chat holds this many. */
export const MAX_KEPT_MESSAGES = 600;


/**
 * New rows after the ones we have; each user row that arrived replaces one "Sending…" bubble.
 * The stored text can differ from what was typed (whitespace, inlined file notes, attachment-only
 * sends), so match loosely, oldest bubble first, rather than leave a bubble stuck forever.
 */
export function mergeMsgs(prev: ChatMessage[], incoming: ChatMessage[]) {
  const stable = prev.filter((m) => m.id < 1e12);
  let optimistic = prev.filter((m) => m.id >= 1e12);
  const seen = new Set(stable.map((m) => m.id));
  // Compaction copies are history the thread already shows (lib/replay-guard.ts).
  const extra = dropReplays(stable, incoming).filter((m) => !seen.has(m.id));
  const merged = extra.length ? [...stable, ...extra] : stable;
  for (const row of extra) {
    if (row.role !== "user" || !optimistic.length) continue;
    const body = sameText(row.content || "");
    let at = optimistic.findIndex((o) => sameText(o.content || "") === body);
    if (at < 0 && body) at = optimistic.findIndex((o) => !!sameText(o.content || "") && body.includes(sameText(o.content || "")));
    if (at < 0 && row.attachments?.length) at = optimistic.findIndex((o) => !!o.attachments?.length && !sameText(o.content || ""));
    if (at >= 0) optimistic = optimistic.filter((_, i) => i !== at);
  }
  const kept = merged.length > MAX_KEPT_MESSAGES ? merged.slice(merged.length - MAX_KEPT_MESSAGES) : merged;
  return [...kept, ...optimistic];
}

/** Ambient aurora behind the top of the thread (§4.4): CSS only, brighter while Chief thinks or speaks. */
function ChatAurora({ mood, color }: { mood: ChiefMood; color?: string }) {
  return (
    <div aria-hidden className="chat-aurora" data-mood={mood} style={color ? ({ ["--chief" as string]: color } as CSSProperties) : undefined}>
      <span className="au-a" />
      <span className="au-b" />
    </div>
  );
}
