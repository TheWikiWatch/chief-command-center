"use client";

import { useEffect, useState } from "react";

import { setup, type SetupStatus } from "@/lib/setup-client";

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
