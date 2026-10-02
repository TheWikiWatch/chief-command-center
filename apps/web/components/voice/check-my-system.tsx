"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { AudioLinesIcon, CircleAlertIcon, CircleCheckIcon, DownloadIcon, MicIcon, Volume2Icon } from "@/components/icons";
import { detach, meterStream, readLevel } from "@/lib/audio-level";
import { speakText, transcribeAudio } from "@/lib/bridge";
import { useAssistantName } from "@/lib/identity";
import { loadMicDevice, micConstraints, micProblem, saveMicDevice, saveVoiceCheck, type MicProblem, type VoiceCheckResult } from "@/lib/mic-device";
import { blobToDataUrl, pickRecorderMime, playableAudioUrl } from "@/lib/voice-client";
import { megabytes, speechModel, type SpeechModelStatus } from "@/lib/voice-model-client";
import { field } from "@/components/ui/field";
import { btn } from "@/components/ui/button";

type MicState = "idle" | "testing" | "ok" | "silent" | MicProblem;
type SpeakerState = "idle" | "playing" | "asking" | "heard" | "not-heard" | "failed";
type TypingState = "idle" | "recording" | "transcribing" | "ok" | "no-speech" | "failed";

const SILENCE_MS = 4000;
const HEARD_LEVEL = 0.08;
const RECORD_MS = 5000;

const windows = () => typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/**
 * Check my system: microphone (device, access, level), speakers (a test phrase), and voice typing (the
 * on-device speech model, downloaded only when the owner taps Download). Nothing here sends anything to
 * the chief's conversation. A voice problem never blocks text chat.
 */
export function CheckMySystem({
  onResult,
  silenceMs = SILENCE_MS,
  recordMs = RECORD_MS,
}: {
  onResult?: (result: VoiceCheckResult) => void;
  silenceMs?: number;
  recordMs?: number;
}) {
  const assistant = useAssistantName();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState(loadMicDevice);
  const [mic, setMic] = useState<MicState>("idle");
  const [level, setLevel] = useState(0);
  const [speaker, setSpeaker] = useState<SpeakerState>("idle");
  const [speakerError, setSpeakerError] = useState("");
  const [typing, setTyping] = useState<TypingState>("idle");
  const [heard, setHeard] = useState("");
  const [typingError, setTypingError] = useState("");
  const [model, setModel] = useState<SpeechModelStatus | null>(null);
  const [modelError, setModelError] = useState("");
  const [declined, setDeclined] = useState(false);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);
  const report = useRef(onResult);
  report.current = onResult;

  const listDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices?.enumerateDevices?.();
      setDevices((all || []).filter((d) => d.kind === "audioinput" && d.deviceId !== "communications"));
    } catch {
      setDevices([]);
    }
  }, []);

  const stopMic = useCallback(() => {
    cancelAnimationFrame(raf.current);
    detach("mic");
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setLevel(0);
  }, []);

  const refreshModel = useCallback(async () => {
    try {
      setModel(await speechModel.status());
      setModelError("");
    } catch (e) {
      setModelError(e instanceof Error ? e.message : `Couldn't reach ${assistant}.`);
    }
  }, [assistant]);

  useEffect(() => {
    void listDevices();
    void refreshModel();
    return stopMic;
  }, [listDevices, refreshModel, stopMic]);

  // Follow a running download.
  const downloading = model?.job?.state === "downloading" || model?.job?.state === "verifying";
  useEffect(() => {
    if (!downloading) return;
    const timer = window.setInterval(() => void refreshModel(), 700);
    return () => window.clearInterval(timer);
  }, [downloading, refreshModel]);

  /* ------------------------------------------------ microphone */

  async function testMic() {
    stopMic();
    setMic("testing");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(device) });
      stream.current = s;
      void listDevices(); // labels appear once access is granted
      meterStream("mic", s);
      const started = performance.now();
      let loudest = 0;
      const tick = () => {
        const now = readLevel("mic");
        loudest = Math.max(loudest, now);
        setLevel(now);
        if (loudest >= HEARD_LEVEL) {
          setMic("ok");
        } else if (performance.now() - started > silenceMs) {
          setMic("silent");
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (e) {
      stopMic();
      setMic(micProblem(e));
    }
  }

  function chooseDevice(id: string) {
    setDevice(id);
    saveMicDevice(id);
    if (stream.current) void testMic();
  }

  /* ------------------------------------------------ speakers */

  async function playPhrase() {
    setSpeaker("playing");
    setSpeakerError("");
    try {
      const res = await speakText(`This is ${assistant}. If you can hear me, your speakers work.`, 60_000);
      const url = res.ok ? res.data_url || res.data_urls?.[0] : "";
      if (!url) throw new Error(res.error || "Spoken replies are unavailable right now.");
      const audio = playableAudioUrl(url);
      const el = new Audio(audio.url);
      el.onended = () => audio.revoke();
      await el.play();
      setSpeaker("asking");
    } catch (e) {
      setSpeaker("failed");
      setSpeakerError(
        e instanceof Error && /NotAllowed/i.test(e.name)
          ? "The browser blocked playback. Click Play again."
          : `Voice unavailable${e instanceof Error && e.message ? `: ${e.message}` : ""}. Text replies still work.`,
      );
    }
  }

  /* ------------------------------------------------ voice typing */

  async function sayPhrase() {
    setTyping("recording");
    setHeard("");
    setTypingError("");
    let s: MediaStream | null = null;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(device) });
      const mime = pickRecorderMime();
      const rec = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
      const chunks: Blob[] = [];
      rec.ondataavailable = (ev) => ev.data?.size && chunks.push(ev.data);
      const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
      rec.start();
      await new Promise((r) => window.setTimeout(r, recordMs));
      rec.stop();
      await stopped;
      s.getTracks().forEach((t) => t.stop());
      setTyping("transcribing");
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
      const res = await transcribeAudio(await blobToDataUrl(blob), blob.type);
      if (!res.ok) {
        setTyping("failed");
        setTypingError(res.error || "Voice typing didn't work.");
        if (res.code === "model_missing") void refreshModel();
        return;
      }
      const text = (res.transcript || "").trim();
      if (!text || res.no_speech || res.filtered) {
        setTyping("no-speech");
        return;
      }
      setHeard(text);
      setTyping("ok");
    } catch (e) {
      s?.getTracks().forEach((t) => t.stop());
      setTyping("failed");
      const problem = micProblem(e);
      setTypingError(problem === "denied" ? "Microphone access is blocked (see above)." : e instanceof Error ? e.message : "Voice typing didn't work.");
    }
  }

  async function download(id: string) {
    setModelError("");
    setDeclined(false);
    try {
      const res = await speechModel.download(id);
      if (!res.ok) setModelError(res.error || "The download didn't start.");
    } catch (e) {
      setModelError(e instanceof Error ? e.message : "The download didn't start.");
    }
    await refreshModel();
  }

  /* ------------------------------------------------ result */

  const result: VoiceCheckResult = {
    at: Date.now(),
    mic: mic === "idle" || mic === "testing" ? "skipped" : mic,
    speaker: speaker === "heard" || speaker === "not-heard" || speaker === "failed" ? speaker : "skipped",
    typing: typing === "ok" || typing === "no-speech" || typing === "failed" ? typing : model && !model.stt.ready ? "not-set-up" : "skipped",
  };
  const resultKey = JSON.stringify({ ...result, at: 0 });
  useEffect(() => {
    const value = JSON.parse(resultKey) as VoiceCheckResult;
    if (value.mic === "skipped" && value.speaker === "skipped" && (value.typing === "skipped" || value.typing === "not-set-up")) return;
    const stamped = { ...value, at: Date.now() };
    saveVoiceCheck(stamped);
    report.current?.(stamped);
  }, [resultKey]);

  const job = model?.job;
  const standard = model?.models.find((m) => m.id === model.default);
  const small = model?.models.find((m) => m.id !== model.default);
  const typingReady = !!model?.stt.ready;

  return (
    <div className="space-y-3">
      <Card
        icon={<MicIcon className="size-4" />}
        title="Microphone"
        state={mic === "ok" ? "ok" : mic === "idle" || mic === "testing" ? "idle" : "problem"}
      >
        {devices.length > 1 ? (
          <label className="block text-callout text-fg-2">
            Microphone
            <select
              value={device}
              onChange={(e) => chooseDevice(e.target.value)}
              className={field({ extra: "mt-1.5 w-full" })}
            >
              <option value="">System default</option>
              {devices
                .filter((d) => d.deviceId && d.deviceId !== "default")
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microphone ${i + 1}`}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        {mic === "testing" || mic === "ok" || mic === "silent" ? (
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-fill-2" role="meter" aria-label="Input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
              <div className="h-full rounded-full bg-accent transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <button type="button" onClick={stopMic} className="press min-h-9 rounded-full px-3 text-callout text-fg-3 hover:text-fg-2">
              Stop
            </button>
          </div>
        ) : null}
        <MicMessage state={mic} />
        {mic !== "testing" && mic !== "ok" ? (
          <Action onClick={() => void testMic()}>{mic === "idle" ? "Test my microphone" : "Try again"}</Action>
        ) : null}
      </Card>

      <Card icon={<Volume2Icon className="size-4" />} title="Speakers" state={speaker === "heard" ? "ok" : speaker === "not-heard" || speaker === "failed" ? "problem" : "idle"}>
        {speaker === "asking" ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-callout text-fg-2">Did you hear it?</span>
            <Action onClick={() => setSpeaker("heard")}>Yes</Action>
            <Action subtle onClick={() => setSpeaker("not-heard")}>
              No
            </Action>
          </div>
        ) : (
          <>
            {speaker === "heard" ? <Line tone="ok">Spoken replies work.</Line> : null}
            {speaker === "not-heard" ? <Line tone="problem">Check the volume and which speakers or headphones are selected in Windows, then play it again.</Line> : null}
            {speaker === "failed" ? <Line tone="problem">{speakerError}</Line> : null}
            <Action disabled={speaker === "playing"} onClick={() => void playPhrase()}>
              {speaker === "playing" ? "Playing…" : speaker === "idle" ? "Play a test phrase" : "Play it again"}
            </Action>
          </>
        )}
      </Card>

      <Card icon={<AudioLinesIcon className="size-4" />} title="Voice typing" state={typing === "ok" ? "ok" : typing === "failed" || typing === "no-speech" ? "problem" : "idle"}>
        {!model && !modelError ? <p className="text-callout text-fg-3">Checking…</p> : null}
        {modelError ? <Line tone="problem">{modelError}</Line> : null}
        {model && !typingReady ? (
          downloading && job ? (
            <div className="space-y-2">
              <p className="text-callout text-fg-2">{job.state === "verifying" ? "Checking the download…" : "Downloading the speech model…"}</p>
              <div className="h-2 overflow-hidden rounded-full bg-fill-2" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.received}>
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${job.total ? Math.round((job.received / job.total) * 100) : 0}%` }} />
              </div>
              <p className="font-mono text-caption tabular text-fg-3">
                {megabytes(job.received)} of {megabytes(job.total)}
              </p>
              <Action subtle onClick={() => void speechModel.cancel().then(refreshModel)}>
                Cancel
              </Action>
            </div>
          ) : declined ? (
            <Line tone="idle">Voice typing stays off. Download the model any time from Settings, then Voice. Typing and spoken replies work as usual.</Line>
          ) : (
            <div className="space-y-2">
              <p className="text-callout text-fg-2">
                Voice typing uses a small speech model that runs on this PC, so what you say stays here. Download it now
                {standard ? ` (${megabytes(standard.bytes)} from Hugging Face)` : ""}?
              </p>
              {job?.state === "error" ? <Line tone="problem">{job.error}</Line> : null}
              {job?.state === "cancelled" ? <Line tone="idle">Download paused. It picks up where it stopped.</Line> : null}
              <div className="flex flex-wrap gap-2">
                <Action onClick={() => void download(standard?.id || "base")}>
                  <DownloadIcon className="size-4" />
                  {job?.state === "error" || job?.state === "cancelled" ? "Resume download" : "Download"}
                </Action>
                <Action subtle onClick={() => setDeclined(true)}>
                  Not now
                </Action>
              </div>
              {small ? (
                <button type="button" onClick={() => void download(small.id)} className="press min-h-9 text-callout text-fg-3 underline-offset-2 hover:text-fg-2 hover:underline">
                  Use the smaller model instead ({megabytes(small.bytes)}, less accurate)
                </button>
              ) : null}
            </div>
          )
        ) : null}
        {model && typingReady ? (
          <>
            {typing === "ok" ? <Line tone="ok">We heard: “{heard}”</Line> : null}
            {typing === "no-speech" ? <Line tone="problem">We didn&apos;t catch any words. Speak a little closer to the microphone and try again.</Line> : null}
            {typing === "failed" ? <Line tone="problem">{typingError}</Line> : null}
            <Action disabled={typing === "recording" || typing === "transcribing"} onClick={() => void sayPhrase()}>
              {typing === "recording" ? "Listening… say a short sentence" : typing === "transcribing" ? "Working it out…" : typing === "idle" ? "Say a short phrase" : "Try again"}
            </Action>
            {!model.stt.local ? <p className="text-caption text-fg-3">Voice typing uses {model.stt.provider}.</p> : null}
          </>
        ) : null}
      </Card>
    </div>
  );
}

function MicMessage({ state }: { state: MicState }) {
  switch (state) {
    case "idle":
      return <p className="text-callout text-fg-3">Say something once the test starts; the bar should move.</p>;
    case "testing":
      return <p className="text-callout text-fg-3">Say something…</p>;
    case "ok":
      return <Line tone="ok">Your microphone works.</Line>;
    case "silent":
      return <Line tone="problem">We didn&apos;t hear anything. Check the microphone isn&apos;t muted, or pick another one.</Line>;
    case "denied":
      return (
        <Line tone="problem">
          Microphone access is blocked. Allow it for this app
          {windows() ? (
            <>
              {" "}
              in{" "}
              <a href="ms-settings:privacy-microphone" className="underline underline-offset-2">
                Windows microphone privacy settings
              </a>{" "}
              (and in the browser&apos;s site settings)
            </>
          ) : (
            " in the browser's site settings"
          )}
          , then try again.
        </Line>
      );
    case "missing":
      return <Line tone="problem">No microphone found. Plug one in or pick another, then try again.</Line>;
    case "busy":
      return <Line tone="problem">The microphone is in use by another app, or Windows couldn&apos;t start it. Close the other app and try again.</Line>;
    case "unsupported":
      return <Line tone="problem">This browser can&apos;t record audio here. Use the desktop app, or open the page over HTTPS on your phone.</Line>;
    default:
      return <Line tone="problem">The microphone couldn&apos;t start. Try again.</Line>;
  }
}

function Card({ icon, title, state, children }: { icon: ReactNode; title: string; state: "idle" | "ok" | "problem"; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-card px-4 py-3" aria-label={title}>
      <h3 className="mb-2 flex items-center gap-2 text-body font-medium text-fg">
        <span className="text-fg-3">{icon}</span>
        {title}
        {state === "ok" ? <CircleCheckIcon className="ml-auto size-4 text-ok" aria-label="Works" /> : null}
        {state === "problem" ? <CircleAlertIcon className="ml-auto size-4 text-warn" aria-label="Needs attention" /> : null}
      </h3>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function Line({ tone, children }: { tone: "ok" | "problem" | "idle"; children: ReactNode }) {
  return (
    <p role={tone === "problem" ? "alert" : "status"} className={`text-callout ${tone === "ok" ? "text-ok" : tone === "problem" ? "text-fg-2" : "text-fg-3"}`}>
      {children}
    </p>
  );
}

function Action({ children, onClick, disabled, subtle }: { children: ReactNode; onClick: () => void; disabled?: boolean; subtle?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={btn(subtle ? "secondary" : "primary", "md")}
    >
      {children}
    </button>
  );
}
