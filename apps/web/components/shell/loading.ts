"use client";

import { useEffect, useState } from "react";

/* Loading the lazily split screens: prefetch when idle, mount a sheet when first opened. */

/**
 * After the first screen is up and the browser is idle, fetch the lazily loaded screens, so opening Settings or
 * the Vault for the first time doesn't wait on the network (they still stay out of the first load).
 */
export function usePrefetchLater() {
  useEffect(() => {
    // Not in tests: the fetch would land after the test file has finished.
    if (process.env.NODE_ENV === "test") return;
    const load = () => {
      void import("@/components/settings-panel");
      void import("@/components/vault-pane");
      void import("@/components/look-drawer");
      void import("@/components/chat/voice-mode");
      void import("@/components/second-brain/sheet");
    };
    const idle = (window as Window & { requestIdleCallback?: (fn: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    const timer = window.setTimeout(() => (idle ? idle(load, { timeout: 4000 }) : load()), 2500);
    return () => window.clearTimeout(timer);
  }, []);
}

/** True from the first time `open` is true: a sheet mounts when first opened and stays (for its exit animation). */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
