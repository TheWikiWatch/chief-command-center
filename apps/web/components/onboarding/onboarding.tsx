"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ConnectModel } from "@/components/onboarding/connect-model";
import { SecondBrainSetup } from "@/components/second-brain/setup";
import { CheckMySystem } from "@/components/voice/check-my-system";
import { RestoreFlow } from "@/components/backup/restore-flow";
import { useAssistantName } from "@/lib/identity";
import { EASE } from "@/lib/motion";
import { secondBrain, type SetupStatus } from "@/lib/setup-client";
import { useModal } from "@/lib/use-modal";
import { btn } from "@/components/ui/button";

/**
 * First-run steps, in order: connect a model, the Second Brain, then Check my system.
 * An optional step can be skipped; `complete` marks it done so the footer says Continue instead of Skip.
 */
export { useNeedsOnboarding } from "@/lib/use-needs-onboarding";

export type OnboardingStep = { id: string; label: string; optional?: boolean; render: (complete: () => void) => ReactNode };

export function Onboarding({
  extraSteps = [],
  onLater,
  onFinished,
  onAskChief,
}: {
  extraSteps?: OnboardingStep[];
  onLater: () => void;
  onFinished: (s: SetupStatus) => void;
  onAskChief?: (text: string) => Promise<void>;
}) {
  const assistant = useAssistantName();
  const [index, setIndex] = useState(0);
  const [connected, setConnected] = useState<SetupStatus | null>(null);
  const [completed, setCompleted] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // Full screen over the app: focus starts inside, Tab stays inside, and the app behind is inert.
  const dialog = useRef<HTMLDivElement>(null);
  const trapTab = useModal(dialog, { inert: true });
  // A fresh profile still has Hermes's stock persona: give it the chief's default (never touches an edited SOUL).
  useEffect(() => {
    void secondBrain.seedSoul().catch(() => undefined);
  }, []);
  const steps: OnboardingStep[] = [
    { id: "model", label: "Connect a model", render: () => <ConnectModel onBusy={setBusy} onDone={setConnected} /> },
    {
      id: "second-brain",
      label: "Your Second Brain",
      optional: true,
      render: (complete) => <SecondBrainSetup onBusy={setBusy} onDone={complete} onAskChief={onAskChief} />,
    },
    {
      id: "system",
      label: "Check my system",
      optional: true,
      render: (complete) => (
        <section className="space-y-4">
          <div>
            <h2 className="text-title text-fg">Check my system</h2>
            <p className="mt-1 text-callout text-fg-3">
              Make sure {assistant} can hear you and you can hear {assistant}. Everything here is optional; typing always works.
            </p>
          </div>
          <CheckMySystem onResult={complete} />
        </section>
      ),
    },
    ...extraSteps,
  ];
  const step = steps[index];
  const last = index === steps.length - 1;
  const canContinue = step.id !== "model" || !!connected?.ready;
  const skipping = !!step.optional && !completed.has(step.id);
  const complete = (id: string) => () => setCompleted((prev) => new Set(prev).add(id));
  const next = () => {
    if (last) onFinished(connected ?? { ready: true, provider: "", model: "", error: "" });
    else setIndex((i) => i + 1);
  };
  return (
    // The dialog itself keeps Tab inside it (lib/use-modal.ts).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div ref={dialog} tabIndex={-1} onKeyDown={trapTab} className="fixed inset-0 z-60 overflow-y-auto bg-canvas outline-hidden" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      {/* The desktop app's title bar is the page's own: this strip moves the window during first run. */}
      <div aria-hidden className="app-drag sticky top-0 z-10 -mb-10 h-10" />
      <div className="app-clickable mx-auto flex min-h-full max-w-xl flex-col px-4 py-8 sm:py-14">
        <header className="mb-8">
          <p className="text-caption font-medium text-fg-3">Welcome</p>
          <h1 id="onboarding-title" className="mt-1 text-display text-fg">
            Set up {assistant === "Chief" ? "your chief" : assistant}
          </h1>
          <ol className="mt-4 flex flex-wrap gap-x-3 gap-y-2" aria-label="Steps">
            {steps.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2 text-caption" aria-current={i === index ? "step" : undefined}>
                <span className={`grid size-5 place-items-center rounded-full font-mono text-micro ${i < index ? "bg-ok/20 text-ok" : i === index ? "bg-fg text-canvas" : "bg-fill-2 text-fg-3"}`}>{i + 1}</span>
                <span className={i === index ? "text-fg-2" : "text-fg-3"}>{s.label}</span>
              </li>
            ))}
          </ol>
        </header>
        {index === 0 && !restoring ? (
          <button type="button" onClick={() => setRestoring(true)} className="press -mt-4 mb-4 min-h-10 text-callout text-fg-3 underline-offset-2 hover:text-fg-2 hover:underline">
            New PC? Restore from a backup
          </button>
        ) : null}
        <AnimatePresence mode="wait">
          <motion.div
            key={restoring ? "restore" : step.id}
            className="rounded-sheet border border-line bg-pane p-4 sm:p-6"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE.enter } }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.14, ease: EASE.exit } }}
          >
            {restoring ? <RestoreFlow onClose={() => setRestoring(false)} /> : step.render(complete(step.id))}
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
            className={btn("primary", "md", "px-6")}
          >
            {skipping ? "Skip for now" : last ? "Start" : "Continue"}
          </button>
        </footer>
      </div>
    </div>
  );
}
