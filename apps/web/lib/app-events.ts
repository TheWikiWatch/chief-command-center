/**
 * Small app-wide requests that the part of the page that owns the thing answers (the command palette and
 * keyboard shortcuts send them; the chat and its message box listen).
 */
export const OPEN_VOICE_MODE_EVENT = "chief:open-voice-mode";
export const FOCUS_COMPOSER_EVENT = "chief:focus-composer";
export const SET_DRAFT_EVENT = "chief:set-draft";

export function openVoiceMode() {
  window.dispatchEvent(new Event(OPEN_VOICE_MODE_EVENT));
}

export function focusComposer() {
  window.dispatchEvent(new Event(FOCUS_COMPOSER_EVENT));
}

/** Puts text in the message box (never sends it) and focuses it. */
export function setDraft(text: string) {
  window.dispatchEvent(new CustomEvent(SET_DRAFT_EVENT, { detail: { text } }));
}

/** Whether a key press is someone typing (single-key shortcuts stay out of the way then). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
