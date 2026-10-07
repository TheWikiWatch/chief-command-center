"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

import { btn } from "@/components/ui/button";

/**
 * A screen that broke: calm, dark, and with a way back. Used by the app's error page and by the boundary each
 * surface sits in, so a crash in the Vault or Fleet Health never takes the chat with it (and the other way round).
 */
export function ErrorView({ title = "Something went wrong on this screen", onRetry, compact = false }: { title?: string; onRetry: () => void; compact?: boolean }) {
  return (
    <div role="alert" className={`flex h-full flex-col items-center justify-center gap-4 bg-canvas px-6 text-center ${compact ? "py-10" : ""}`}>
      <p className="text-title text-fg">{title}</p>
      <p className="max-w-sm text-callout text-fg-3">Your chief is fine; only this view stopped. Try again, or reload the app.</p>
      <div className="flex gap-3">
        <button type="button" onClick={onRetry} className={btn("accent")}>
          Try again
        </button>
        <button type="button" onClick={() => window.location.reload()} className={btn("secondary")}>
          Reload
        </button>
      </div>
    </div>
  );
}

type Props = { name: string; children: ReactNode; onError?: (error: Error, name: string) => void };
type State = { error: Error | null };

/** Catches a render error inside one surface and shows ErrorView there; Try again remounts the children. */
export class SurfaceErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, this.props.name);
    if (typeof console !== "undefined") console.error(`[${this.props.name}] screen error`, error, info.componentStack);
  }

  render() {
    if (this.state.error) return <ErrorView onRetry={() => this.setState({ error: null })} compact />;
    return this.props.children;
  }
}
