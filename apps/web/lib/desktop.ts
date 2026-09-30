/**
 * What the desktop app's preload exposes to the page (Phase 7). In a plain browser none of it exists, and
 * every caller has a browser fallback.
 */
export type ChiefDesktop = {
  /** A native folder picker; resolves to the chosen folder, or null when cancelled. */
  pickFolder?: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>;
  /** A native file picker for opening a file; resolves to its path, or null when cancelled. */
  pickFile?: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  /**
   * Apply the staged restore: stop Chief (asking about work in progress first), swap in the restored data,
   * start Chief and check its health, then finish or roll back. Only the desktop app can stop Chief.
   */
  applyRestore?: () => Promise<{ ok: boolean; error?: string; report?: { remapped: string[]; review: { file: string; line: number; text: string }[]; missing_secrets: string[] } }>;
};

export function desktop(): ChiefDesktop | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { chiefDesktop?: ChiefDesktop }).chiefDesktop ?? null;
}
