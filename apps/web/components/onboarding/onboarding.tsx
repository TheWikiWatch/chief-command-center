"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { ConnectModel } from "@/components/onboarding/connect-model";
import { useAssistantName } from "@/lib/identity";
import { EASE } from "@/lib/motion";
import { setup, type SetupStatus } from "@/lib/setup-client";

/** First-run steps, in order. Later phases add "Your Second Brain" and "Check my system". */
export type OnboardingStep = { id: string; label: string; render: (done: () => void) => ReactNode };

const LATER_KEY = "chief-onboarding-later";

/**
 * Shown when the chief has no working model yet (a fresh install). An install that already works never
 * sees it. "Set up later" hides it for this browser session; the Connection row in Settings stays.
 */
export function useNeedsOnboarding(connected: boolean): { needed: boolean; later: () => void; finish: (s: SetupStatus) => void } {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [deferred, setDeferred] = useState(() => {
    try {
      return sessionStorage.getItem(LATER_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!connected || status) return;
    const controller = new AbortController();
    setup
      .status(controller.signal)
      .then((s) => setStatus(s))
      .catch(() => undefined); // an older bridge without /setup: never block the app on it
    return () => controller.abort();
  }, [connected, status]);
  return {
    needed: !!status && !status.ready && !deferred,
    later: () => {
      try {
        sessionStorage.setItem(LATER_KEY, "1");
      } catch {
        /* private mode */
      }
      setDeferred(true);
    },
    finish: (s) => setStatus(s),
  };
}

export function Onboarding({ extraSteps = [], onLater, onFinished }: { extraSteps?: OnboardingStep[]; onLater: () => void; onFinished: (s: SetupStatus) => void }) {
  const assistant = useAssistantName();
  const [index, setIndex] = useState(0);
  const [connected, setConnected] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const steps: OnboardingStep[] = [
    { id: "model", label: "Connect a model", render: () => <ConnectModel onBusy={setBusy} onDone={setConnected} /> },
    ...extraSteps,
  ];
  const step = steps[index];
  const last = index === steps.length - 1;
  const canContinue = step.id !== "model" || !!connected?.ready;
  const next = () => {
    if (last) onFinished(connected ?? { ready: true, provider: "", model: "", error: "" });
    else setIndex((i) => i + 1);
  };
  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-canvas" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="mx-auto flex min-h-full max-w-xl flex-col px-4 py-8 sm:py-14">
        <header className="mb-8">
          <p className="text-caption uppercase tracking-wide text-fg-3">Welcome</p>
          <h1 id="onboarding-title" className="mt-1 text-display text-fg">
            Set up {assistant === "Chief" ? "your chief" : assistant}
          </h1>
          <ol className="mt-4 flex gap-2" aria-label="Steps">
            {steps.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2 text-caption" aria-current={i === index ? "step" : undefined}>
                <span className={`grid size-5 place-items-center rounded-full font-mono text-[11px] ${i < index ? "bg-ok/20 text-ok" : i === index ? "bg-fg text-canvas" : "bg-white/[0.06] text-fg-3"}`}>{i + 1}</span>
                <span className={i === index ? "text-fg-2" : "text-fg-3"}>{s.label}</span>
              </li>
            ))}
          </ol>
        </header>
        <AnimatePresence mode="wait">
          <motion.div
            key={step.id}
            className="rounded-sheet border border-line bg-pane p-4 sm:p-6"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE.enter } }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.14, ease: EASE.exit } }}
          >
            {step.render(next)}
          </motion.div>
        </AnimatePresence>
        <footer className="mt-6 flex items-center justify-between gap-3">
          <button type="button" onClick={onLater} disabled={busy} className="press min-h-11 rounded-full px-3 text-callout text-fg-3 hover:text-fg-2 disabled:opacity-40">
            Set up later
          </button>
          <button
            type="button"
            onClick={next}
            disabled={!canContinue || busy}
            className="press min-h-11 rounded-full bg-fg px-6 text-callout font-semibold text-canvas disabled:bg-white/10 disabled:text-fg-4"
          >
            {last ? "Start" : "Continue"}
          </button>
        </footer>
      </div>
    </div>
  );
}
