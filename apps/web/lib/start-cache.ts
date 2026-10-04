/**
 * What the app showed last, kept on this device so a cold start shows it at once and then refreshes it quietly.
 * A phone discards a page in the background, and every return used to be a blank screen until the network
 * answered: the chat, the team and Today now reappear as they were, in the same frame as the app.
 *
 * Kept in localStorage per section, small (the chat's last messages, the latest snapshot, Today's lists), and only
 * ever as a first frame: the next answer from the PC replaces it. Entries older than MAX_AGE_MS are ignored.
 */
const PREFIX = "chief.start.";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_CHARS = 400_000;

type Stored<T> = { at: number; scope: string; value: T };

/** The last value saved for `section` under `scope` (a thread, a profile), or null. */
export function readStart<T>(section: string, scope = "", now = Date.now()): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + section);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored<T>;
    if (stored.scope !== scope || now - stored.at > MAX_AGE_MS) return null;
    return stored.value;
  } catch {
    return null;
  }
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Save `value` for the next start, a moment later (a burst of updates writes once). Too large: not kept. */
export function writeStart<T>(section: string, value: T, scope = "", delayMs = 800) {
  if (typeof window === "undefined") return;
  clearTimeout(pending.get(section));
  pending.set(
    section,
    setTimeout(() => {
      pending.delete(section);
      try {
        const text = JSON.stringify({ at: Date.now(), scope, value } satisfies Stored<T>);
        if (text.length > MAX_CHARS) window.localStorage.removeItem(PREFIX + section);
        else window.localStorage.setItem(PREFIX + section, text);
      } catch {
        /* storage full or blocked: the next start simply waits for the network */
      }
    }, delayMs),
  );
}

/** Forget everything kept (sign-in changed, tests). */
export function clearStart() {
  try {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith(PREFIX)) window.localStorage.removeItem(key);
  } catch {
    /* nothing kept */
  }
}
