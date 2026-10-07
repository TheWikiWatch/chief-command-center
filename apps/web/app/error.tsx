"use client";

import { useEffect } from "react";

import { ErrorView } from "@/components/ui/error-boundary";
import { reloadForNewBuild } from "@/lib/recover";

/** Something broke while drawing the app: a calm, dark screen with a way back, never a blank or white page. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reloadForNewBuild(error);
  }, [error]);
  return (
    <div className="h-app">
      <ErrorView onRetry={reset} />
    </div>
  );
}
