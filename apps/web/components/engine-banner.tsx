"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { RefreshCwIcon } from "@/components/icons";
import { desktop, type EngineState } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";
import { LAYER } from "@/lib/layers";
import { EASE } from "@/lib/motion";

/**
 * Desktop app only: what the app's supervisor knows about Chief's engine (apps/desktop/src/supervisor.ts), said
 * plainly at the top of the window. "Restarting" while it backs off after a crash, "Stopped · trying again in
 * 9 min" with Try now once it gave up for a while, and a short "Back" once it recovers. Nothing shows while all
 * is well, or for an engine another launcher runs.
 */
export type EngineMessage = { tone: "warn" | "danger" | "ok"; text: string; retry: boolean } | null;

export function engineMessage(state: EngineState | null, assistant: string, wasDown: boolean): EngineMessage {
  if (!state || state.external) return null;
  const g = state.gateway;
  if (g.state === "failed") {
    const minutes = Math.max(1, Math.ceil(g.retryInMs / 60_000));
    return { tone: "danger", text: `${assistant} stopped. Trying again in ${minutes} min.`, retry: true };
  }
  if (g.state === "backoff" || (g.state === "starting" && wasDown)) return { tone: "warn", text: `${assistant}'s engine stopped. Restarting…`, retry: false };
  if (g.state === "running" && wasDown) return { tone: "ok", text: `${assistant} restarted and is back.`, retry: false };
  return null;
}

const TONE = {
  warn: "border-warn/40 text-warn",
  danger: "border-danger/40 text-danger",
  ok: "border-ok/40 text-ok",
};

export function EngineBanner() {
  const assistant = useAssistantName();
  const [state, setState] = useState<EngineState | null>(null);
  const [wasDown, setWasDown] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastState = useRef<EngineState | null>(null);

  useEffect(() => {
    const d = desktop();
    if (!d?.onEngine) return;
    const apply = (next: EngineState) => {
      const down = next.gateway.state === "backoff" || next.gateway.state === "failed";
      if (down) setWasDown(true);
      lastState.current = next;
      setState(next);
    };
    void d.engine?.().then(apply, () => undefined);
    return d.onEngine(apply);
  }, []);

  // "Back" shows for a few seconds, then the banner goes.
  useEffect(() => {
    if (!wasDown || state?.gateway.state !== "running") return;
    const t = window.setTimeout(() => setWasDown(false), 6000);
    return () => window.clearTimeout(t);
  }, [wasDown, state]);

  // The countdown ticks once a minute while Chief is stopped.
  const [, tick] = useState(0);
  useEffect(() => {
    if (state?.gateway.state !== "failed") return;
    const t = window.setInterval(() => {
      if (lastState.current) lastState.current = { ...lastState.current, gateway: { ...lastState.current.gateway, retryInMs: Math.max(0, lastState.current.gateway.retryInMs - 60_000) } };
      setState(lastState.current);
      tick((n) => n + 1);
    }, 60_000);
    return () => window.clearInterval(t);
  }, [state?.gateway.state]);

  const message = engineMessage(state, assistant, wasDown);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] flex justify-center px-3" style={{ zIndex: LAYER.notice }}>
      <AnimatePresence>
        {message ? (
          <motion.div
            key={message.tone}
            role={message.tone === "danger" ? "alert" : "status"}
            className={`pointer-events-auto flex max-w-[min(34rem,100%)] items-center gap-3 rounded-full border bg-raised/95 py-1.5 pl-4 pr-1.5 text-callout font-medium shadow-e3 ${TONE[message.tone]}`}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE.enter } }}
            exit={{ opacity: 0, y: -8, transition: { duration: 0.16 } }}
          >
            <span className="min-w-0 truncate py-1">{message.text}</span>
            {message.retry ? (
              <button
                type="button"
                disabled={busy}
                className="press flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-line-2 bg-fill-1 px-3 text-callout text-fg hover:bg-fill-2 disabled:opacity-60"
                onClick={() => {
                  setBusy(true);
                  void desktop()
                    ?.retryChief?.()
                    .then((next) => next && setState(next))
                    .finally(() => setBusy(false));
                }}
              >
                <RefreshCwIcon size={14} />
                {busy ? "Starting…" : "Try now"}
              </button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
