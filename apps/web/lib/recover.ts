/**
 * After an app update the page in a phone's background still names the old build's code chunks, which no longer
 * exist: loading one fails and the page broke. One quiet reload fetches the new build. Guarded, so a chunk that
 * keeps failing for another reason shows the error screen instead of reloading forever.
 */
const KEY = "chief.chunk-reload-at";
const AGAIN_AFTER_MS = 60_000;

export function isChunkError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null;
  const text = `${e?.name || ""} ${e?.message || ""}`;
  return /ChunkLoadError|Loading (CSS )?chunk|dynamically imported module|Importing a module script failed/i.test(text);
}

/** Reload once for a stale-build error; true when a reload was started. */
export function reloadForNewBuild(error: unknown, now = Date.now()): boolean {
  if (typeof window === "undefined" || !isChunkError(error)) return false;
  try {
    const last = Number(window.sessionStorage.getItem(KEY) || 0);
    if (now - last < AGAIN_AFTER_MS) return false;
    window.sessionStorage.setItem(KEY, String(now));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
