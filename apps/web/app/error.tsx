"use client";

import { useEffect } from "react";

import { reloadForNewBuild } from "@/lib/recover";

/** Something broke while drawing the app: a calm, dark screen with a way back, never a blank or white page. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reloadForNewBuild(error);
  }, [error]);
  return (
    <div className="flex h-app flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
      <p className="text-title text-fg">Something went wrong on this screen</p>
      <p className="max-w-sm text-callout text-fg-3">Your chief is fine; only this view stopped. Try again, or reload the app.</p>
      <div className="flex gap-3">
        <button type="button" onClick={reset} className="press min-h-11 rounded-full bg-accent-solid px-5 text-callout font-medium text-white">
          Try again
        </button>
        <button type="button" onClick={() => window.location.reload()} className="press min-h-11 rounded-full border border-line px-5 text-callout text-fg-2">
          Reload
        </button>
      </div>
    </div>
  );
}
