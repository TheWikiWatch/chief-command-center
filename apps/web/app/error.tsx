"use client";

import { useEffect } from "react";

import { ErrorView } from "@/components/ui/error-boundary";
import { reloadForNewBuild } from "@/lib/recover";

/** Something broke while drawing the app: a calm screen in the app's look with a way back, never a blank or white page. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reloadForNewBuild(error);
  }, [error]);
  return (
    <div className="h-app">
      {/* The desktop window has no title bar: this strip moves it (its buttons below are outside it). */}
      <div aria-hidden className="app-drag fixed inset-x-0 top-0 h-[60px]" />
      <ErrorView onRetry={reset} />
    </div>
  );
}
