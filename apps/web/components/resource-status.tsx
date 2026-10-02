"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { forgetHealth, reportHealth } from "@/lib/health-store";

export type ResourceHealth = { updatedAt: number | null; error: string | null };

/**
 * Tracks one polled resource. With a label it also reports into the shared health store,
 * which feeds the header connection dot and the status sheet.
 */
export function useResourceHealth(label?: string, staleAfter = 5_000) {
  // Held outside React state: a successful poll must not re-render the component that owns it.
  // Only the store's subscribers (the connection dot and status sheet) update.
  const health = useRef<ResourceHealth>({ updatedAt: null, error: null });
  const config = useRef({ label, staleAfter });
  config.current = { label, staleAfter };
  const report = useCallback(() => {
    const { label: name, staleAfter: window } = config.current;
    if (name) reportHealth({ label: name, updatedAt: health.current.updatedAt, error: health.current.error, staleAfter: window });
  }, []);
  const success = useCallback(() => {
    health.current = { updatedAt: Date.now(), error: null };
    report();
  }, [report]);
  const failure = useCallback((error: unknown) => {
    health.current = { ...health.current, error: error instanceof Error ? error.message : "Unavailable" };
    report();
  }, [report]);
  useEffect(() => {
    report();
  }, [report, label, staleAfter]);
  useEffect(() => {
    if (!label) return;
    return () => forgetHealth(label);
  }, [label]);
  // One object for the component's life, so effects and callbacks can list it as a dependency.
  return useMemo(() => ({ success, failure }), [success, failure]);
}

export function ResourceStatus({ label, health, staleAfter = 5_000 }: { label: string; health: ResourceHealth; staleAfter?: number }) {
  const [now, setNow] = useState<number | null>(null);
  const [started] = useState(Date.now);
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const age = now === null ? 0 : Math.max(0, now - (health.updatedAt ?? started));
  const stale = !!health.error || age >= staleAfter;
  const detail = health.updatedAt === null ? "waiting for first update" : `updated ${Math.floor(age / 1000)}s ago`;
  return <span className={stale ? "text-warn" : "text-fg-3"} title={health.error || detail}>
    {label}: {stale ? `stale (${detail})` : health.updatedAt === null ? "connecting" : detail}
    {health.error ? <span className="sr-only"> — {health.error}</span> : null}
  </span>;
}
