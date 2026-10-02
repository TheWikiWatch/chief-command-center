"use client";

import type { ReactNode } from "react";

import { BookOpenIcon } from "@/components/icons";
import { SurfaceTabs, type Surface } from "@/components/surface-tabs";
import { btn } from "@/components/ui/button";

/**
 * Today and Vault before a Second Brain folder exists. Calm, not an error: nothing is broken, there is
 * just nothing to show yet. `onSetUp` opens the Second Brain setup when it is available.
 */
export function SecondBrainNotSetUp({
  title,
  surface,
  onSurface,
  hideTabs = false,
  trailing,
  onSetUp,
}: {
  title: string;
  surface: Surface;
  onSurface: (next: Surface) => void;
  hideTabs?: boolean;
  trailing?: ReactNode;
  onSetUp?: () => void;
}) {
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-pane">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        {hideTabs ? (
          <>
            <h1 className="min-w-0 flex-1 text-headline text-fg">{title}</h1>
            {trailing}
          </>
        ) : (
          <SurfaceTabs surface={surface} onChange={onSurface} />
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <span className="grid size-16 place-items-center rounded-full border border-line-2 bg-card text-fg-3">
          <BookOpenIcon size={28} />
        </span>
        <h2 className="mt-5 text-title text-fg">Your Second Brain isn&apos;t set up yet</h2>
        <p className="mt-2 max-w-sm text-body text-fg-3">
          Choose a notes folder and your chief organizes it with you: tasks show up in Today, and every note is browsable in Vault.
        </p>
        {onSetUp ? (
          <button type="button" onClick={onSetUp} className={btn("primary", "md", "mt-6")}>
            Set up my Second Brain
          </button>
        ) : null}
      </div>
    </div>
  );
}
