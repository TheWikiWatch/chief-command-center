"use client";

/**
 * Where a tapped notification leads (public/sw.js): a tab, and optionally the approval sheet or the
 * Fleet Health view. An open app gets a `chief-open` message; a cold start gets `?open=` in the URL.
 */
export type OpenTarget = { tab: string; approval?: string; view?: string };

const TABS = new Set(["chat", "today", "fleet", "vault"]);

function clean(raw: { tab?: unknown; approval?: unknown; view?: unknown }): OpenTarget | null {
  const tab = typeof raw.tab === "string" && TABS.has(raw.tab) ? raw.tab : "";
  if (!tab) return null;
  return {
    tab,
    approval: typeof raw.approval === "string" && raw.approval ? raw.approval : undefined,
    view: raw.view === "health" ? "health" : undefined,
  };
}

/** A cold start from a notification: read `?open=` once and drop it from the address bar. */
export function takeLaunchTarget(): OpenTarget | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("open")) return null;
  const target = clean({ tab: params.get("open"), approval: params.get("approval"), view: params.get("view") });
  for (const key of ["open", "approval", "view"]) params.delete(key);
  const rest = params.toString();
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
  } catch {
    /* sandboxed */
  }
  return target;
}

/** A notification tapped while the app is open (the worker focuses it and posts where to go). */
export function subscribeOpenTarget(fn: (target: OpenTarget) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type !== "chief-open") return;
    const target = clean(event.data);
    if (target) fn(target);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

/** Replies and approvals the app now shows on screen: their notifications are old news on this device. */
export const shownOnScreen = (tag: string) => tag === "chief-reply" || tag.startsWith("approval-");

export async function closeNotifications(match: (tag: string) => boolean = shownOnScreen): Promise<number> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return 0;
    const reg = await navigator.serviceWorker.getRegistration("/");
    const list = (await reg?.getNotifications()) || [];
    let closed = 0;
    for (const n of list) {
      if (match(n.tag || "")) {
        n.close();
        closed += 1;
      }
    }
    return closed;
  } catch {
    return 0;
  }
}

/** Asks the chat to bring up the approval sheet (it may be minimized to a pill). */
export const SHOW_APPROVAL_EVENT = "chief-show-approval";
