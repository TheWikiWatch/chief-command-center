/**
 * While the app is hidden, polls run no faster than this. Returning to the app refreshes at once,
 * so a hidden phone or background tab stops spending battery and data on 0.8s polls.
 */
export const HIDDEN_MIN_MS = 5_000;
/** Hidden longer than this, a request still open on return is given up and sent again. */
export const RESUME_FRESH_MS = 3_000;

/**
 * One request per resource, with immediate refresh after returning to the app. `wake` subscribes to something
 * that should refresh it at once (the live channel, lib/live.ts) and returns how to unsubscribe.
 */
export function poll(
  run: (signal: AbortSignal) => Promise<void>,
  interval: number | (() => number),
  opts: { wake?: (fire: () => void) => () => void } = {},
): () => void {
  let stopped = false;
  let inFlight = false;
  let rerun = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const next = () => {
    const base = typeof interval === "function" ? interval() : interval;
    return document.visibilityState === "hidden" ? Math.max(base, HIDDEN_MIN_MS) : base;
  };
  const tick = async () => {
    if (stopped) return;
    if (inFlight) { rerun = true; return; }
    clearTimeout(timer);
    inFlight = true;
    controller = new AbortController();
    try { await run(controller.signal); } catch { /* resource owner reports errors */ }
    finally {
      inFlight = false;
      if (!stopped) {
        const delay = rerun ? 0 : next();
        rerun = false;
        timer = setTimeout(() => void tick(), delay);
      }
    }
  };
  const resume = () => {
    if (document.visibilityState !== "hidden") void tick();
  };
  // Back from the background (or back online): a request left open meanwhile is often dead, because a phone freezes or
  // drops it, and waiting out its timeout made the chat look stale for half a minute with nothing wrong. Start afresh.
  let hiddenAt = 0;
  const fresh = (force: boolean) => {
    if (document.visibilityState === "hidden") return;
    if (inFlight && (force || (hiddenAt && Date.now() - hiddenAt > RESUME_FRESH_MS))) {
      rerun = true;
      controller?.abort();
    }
    hiddenAt = 0;
    void tick();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") hiddenAt = hiddenAt || Date.now();
    else fresh(false);
  };
  const onOnline = () => fresh(true);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  const unwake = opts.wake?.(resume);
  void tick();
  return () => {
    stopped = true;
    unwake?.();
    controller?.abort();
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
  };
}
