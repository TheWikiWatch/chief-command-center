/**
 * What the desktop app's preload exposes to the page (Phase 7). In a plain browser none of it exists, and
 * every caller has a browser fallback.
 */
export type ChiefDesktop = {
  /** A native folder picker; resolves to the chosen folder, or null when cancelled. */
  pickFolder?: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>;
};

export function desktop(): ChiefDesktop | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { chiefDesktop?: ChiefDesktop }).chiefDesktop ?? null;
}
