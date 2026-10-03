"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { DeepseekChip } from "@/components/deepseek-chip";
import { SettingsIcon } from "@/components/icons";
import { ResourceStatus } from "@/components/resource-status";
import { Tip } from "@/components/ui/popovers";
import { Sheet } from "@/components/ui/sheet";
import { fetchHealth, type HermesCompat } from "@/lib/bridge";
import { summarizeHealth, useHealthEntries } from "@/lib/health-store";
import { SPRING } from "@/lib/motion";
import { shortcutText } from "@/lib/shortcuts";
import { useSpeechLog, type SpeechLogEntry } from "@/lib/speech-log";
import { useAssistantName } from "@/lib/identity";

export type LinkState = { connected: boolean; authFailed?: boolean };

function useNow(stepMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(t);
  }, [stepMs]);
  return now;
}

const STARTED = typeof window === "undefined" ? 0 : Date.now();

/** What the connection dot says: its state, the words for it (empty when healthy) and their color. */
export function useLinkLabel({ connected, authFailed }: LinkState) {
  const entries = useHealthEntries();
  const now = useNow();
  const verdict = summarizeHealth(entries, now, STARTED);
  const state = authFailed ? "auth" : !connected ? "down" : verdict.state;
  const label =
    state === "auth"
      ? "Bridge auth failed"
      : state === "down"
        ? "Reconnecting…"
        : state === "degraded" && verdict.worst
          ? `${verdict.worst.label} ${verdict.worst.error ? "error" : `stale ${Math.floor(verdict.ageMs / 1000)}s`}`
          : "";
  const text = state === "degraded" ? "text-warn" : "text-danger";
  return { state, label, text };
}

/**
 * Header status: one honest dot. Degraded states say what is wrong in words, never color alone.
 * `quiet` leaves the words to the header's own status line (the phone's chat header has no room).
 */
export function ConnectionDot({ connected, authFailed, onOpen, quiet = false }: LinkState & { onOpen?: () => void; quiet?: boolean }) {
  const { state, label, text } = useLinkLabel({ connected, authFailed });
  const color = state === "ok" ? "bg-ok" : state === "degraded" ? "bg-warn" : "bg-danger";
  return (
    <Tip label={label ? `${label} · show status` : "Connection status"}>
      <button
        type="button"
        onClick={onOpen}
        className="press flex h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full px-2"
        aria-label={label ? `Connection: ${label}. Show status` : "Connection healthy. Show status"}
      >
        <span className="relative flex h-2.5 w-2.5">
          {state !== "ok" ? <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${color}`} /> : null}
          <span className={`relative h-2.5 w-2.5 rounded-full ${color} ${state === "ok" ? "shadow-[0_0_8px_rgb(var(--c-ok)/0.6)]" : ""}`} />
        </span>
        <AnimatePresence initial={false}>
          {label && !quiet ? (
            <motion.span
              key={label}
              className={`whitespace-nowrap text-caption font-medium ${text}`}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0, transition: SPRING.snappy }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
            >
              {label}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </button>
    </Tip>
  );
}

export function StatusSheet({ open, onClose, connected, authFailed, phone, deepseek = false }: LinkState & { open: boolean; onClose: () => void; phone: boolean; deepseek?: boolean }) {
  const entries = useHealthEntries();
  const assistant = useAssistantName();
  return (
    <Sheet open={open} onClose={onClose} title="Status" subtitle="What this window can reach right now" side={phone ? "bottom" : "right"}>
      <div className="space-y-5 px-4 pb-6">
        <section className="rounded-card border border-line bg-card p-4">
          <div className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${authFailed ? "bg-danger" : connected ? "bg-ok" : "bg-danger"}`} />
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium text-fg">{assistant}&apos;s gateway</p>
              <p className="text-callout text-fg-3">
                {authFailed ? "Bridge token does not match the plugin." : connected ? "Connected and answering on this PC." : "Not answering. It will reconnect on its own."}
              </p>
            </div>
          </div>
        </section>
        <section>
          <h3 className="mb-2 px-1 text-callout font-medium text-fg-2">Live data</h3>
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-card">
            {entries.length === 0 ? <li className="px-4 py-3 text-callout text-fg-3">Waiting for the first update…</li> : null}
            {entries.map((entry) => (
              <li key={entry.label} className="px-4 py-3 text-callout">
                <ResourceStatus
                  label={entry.label}
                  health={{ updatedAt: entry.updatedAt, error: entry.error, pendingSince: entry.pendingSince, failures: entry.failures }}
                  staleAfter={entry.staleAfter}
                />
                {entry.error ? <p className="mt-0.5 truncate text-caption text-fg-3">{entry.error}</p> : null}
              </li>
            ))}
          </ul>
        </section>
        <HermesFeatures open={open} />
        <VoiceLog />
        {deepseek ? (
        <section>
          <h3 className="mb-2 px-1 text-callout font-medium text-fg-2">DeepSeek pricing</h3>
          <div className="rounded-card border border-line bg-card px-4 py-3">
            <DeepseekChip detail />
          </div>
        </section>
        ) : null}
      </div>
    </Sheet>
  );
}

/** Hermes features the bridge can't reach in this Hermes (an upstream change): said plainly, never silently off. */
export function hermesSummary(compat: HermesCompat | undefined): { tone: "ok" | "warn" | "muted"; text: string } {
  if (!compat || compat.pending) return { tone: "muted", text: "Checking the parts of Hermes the app uses…" };
  const off = Object.entries(compat.features || {}).filter(([, ok]) => !ok).map(([name]) => name);
  if (!off.length) return { tone: "ok", text: `Everything the app uses is there (${Object.keys(compat.features || {}).length} features).` };
  return { tone: "warn", text: `Not working with this Hermes: ${off.join(", ")}. An app update fixes this; Settings → About → Create diagnostics has the details.` };
}

function HermesFeatures({ open }: { open: boolean }) {
  const [compat, setCompat] = useState<HermesCompat | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    void fetchHealth(ac.signal).then((h) => setCompat(h.hermes));
    return () => ac.abort();
  }, [open]);
  const summary = hermesSummary(compat);
  return (
    <section>
      <h3 className="mb-2 px-1 text-callout font-medium text-fg-2">Hermes</h3>
      <p className={`rounded-card border border-line bg-card px-4 py-3 text-callout ${summary.tone === "ok" ? "text-fg-2" : summary.tone === "warn" ? "text-warn" : "text-fg-3"}`}>{summary.text}</p>
    </section>
  );
}

const OUTCOME: Record<SpeechLogEntry["outcome"], { label: string; tone: string }> = {
  played: { label: "Played", tone: "text-ok" },
  failed: { label: "Failed", tone: "text-danger" },
  stalled: { label: "Stalled", tone: "text-danger" },
  missed: { label: "Missed", tone: "text-warn" },
  cancelled: { label: "Stopped", tone: "text-fg-3" },
  skipped: { label: "Not replayed", tone: "text-fg-3" },
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

/** The last speech attempts: if a reply is ever silent again, this says why (PLAN-2026-09-23 §1). */
function VoiceLog() {
  const log = useSpeechLog();
  return (
    <section>
      <h3 className="mb-2 px-1 text-callout font-medium text-fg-2">Voice</h3>
      <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-card">
        {log.length === 0 ? <li className="px-4 py-3 text-callout text-fg-3">No replies spoken on this device yet.</li> : null}
        {log.slice(0, 8).map((entry) => {
          const o = OUTCOME[entry.outcome];
          const detail = entry.outcome === "skipped" ? entry.reason || "" : [
            entry.firstSoundMs !== undefined ? `sound after ${seconds(entry.firstSoundMs)}` : "no sound",
            entry.parts > 1 ? `${entry.parts} parts` : "",
            entry.hidden ? "app hidden" : "",
            entry.reason && entry.outcome !== "played" ? entry.reason : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={`${entry.at}-${entry.preview}`} className="flex items-baseline gap-3 px-4 py-2.5">
              <span className="tabular w-19 shrink-0 whitespace-nowrap font-mono text-caption text-fg-3">
                {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-callout text-fg-2">{entry.preview || "Reply"}</p>
                <p className="line-clamp-2 text-caption text-fg-3">{detail}</p>
              </div>
              <span className={`shrink-0 text-caption font-medium ${o.tone}`}>{o.label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Dot + gear, used in every surface header. */
export function HeaderStatus({
  connected,
  authFailed,
  onOpenStatus,
  onOpenSettings,
  quiet,
}: LinkState & { onOpenStatus?: () => void; onOpenSettings?: () => void; quiet?: boolean }) {
  return (
    <div className="flex shrink-0 items-center">
      <ConnectionDot connected={connected} authFailed={authFailed} onOpen={onOpenStatus} quiet={quiet} />
      {onOpenSettings ? (
        <Tip label="Settings" shortcut={shortcutText("settings")}>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className="press flex h-11 w-11 items-center justify-center rounded-full text-fg-2 hover:bg-fill-2 hover:text-fg"
          >
            <SettingsIcon size={20} />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}
