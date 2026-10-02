/**
 * The keyboard map, in one place: the shortcut handler in the shell, the command palette's hints and the "?"
 * sheet all read it. `mod` is Ctrl on Windows and Linux, ⌘ on a Mac.
 */
export type ShortcutId = "palette" | "settings" | "surface1" | "surface2" | "surface3" | "surface4" | "composer" | "help" | "newThread" | "voice";

export type Shortcut = { id: ShortcutId; keys: string[]; label: string; desktopOnly?: boolean };

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", keys: ["mod", "K"], label: "Search commands and places" },
  { id: "composer", keys: ["/"], label: "Write to the chief" },
  { id: "newThread", keys: ["mod", "Alt", "N"], label: "New thread" },
  { id: "voice", keys: ["mod", "Shift", "V"], label: "Voice mode" },
  { id: "surface1", keys: ["mod", "1"], label: "Fleet", desktopOnly: true },
  { id: "surface2", keys: ["mod", "2"], label: "Today", desktopOnly: true },
  { id: "surface3", keys: ["mod", "3"], label: "Vault", desktopOnly: true },
  { id: "settings", keys: ["mod", ","], label: "Settings" },
  { id: "help", keys: ["?"], label: "Keyboard shortcuts" },
];

export function keyLabel(key: string): string {
  if (key === "mod") return isMac() ? "⌘" : "Ctrl";
  if (key === "Alt") return isMac() ? "⌥" : "Alt";
  if (key === "Shift") return isMac() ? "⇧" : "Shift";
  return key;
}

export function shortcutText(id: ShortcutId): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? s.keys.map(keyLabel).join(isMac() ? "" : "+") : "";
}

/** Which shortcut a key press is, if any. Single keys don't count while typing in a field. */
export function matchShortcut(e: KeyboardEvent, typing: boolean): ShortcutId | null {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (mod && !e.altKey && !e.shiftKey && key === "K") return "palette";
  if (mod && !e.altKey && !e.shiftKey && e.key === ",") return "settings";
  if (mod && e.altKey && !e.shiftKey && (key === "N" || e.code === "KeyN")) return "newThread";
  if (mod && e.shiftKey && !e.altKey && (key === "V" || e.code === "KeyV")) return "voice";
  if (mod && !e.altKey && !e.shiftKey && /^[1-4]$/.test(e.key)) return `surface${e.key}` as ShortcutId;
  if (typing || mod || e.altKey) return null;
  if (e.key === "/") return "composer";
  if (e.key === "?") return "help";
  return null;
}
