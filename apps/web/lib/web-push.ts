"use client";

import { friendlyError, requestJson } from "@/lib/request";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/sw.js");
}

/**
 * At every app load: a device reaching this PC from elsewhere (the phone) registers the worker, which keeps the
 * app's code on it (public/sw.js), and one that has it picks up a changed sw.js now, not days later. The desktop
 * app loads from this PC and doesn't need it.
 */
export async function refreshServiceWorker(): Promise<void> {
  try {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) {
      await navigator.serviceWorker.register("/sw.js");
      return;
    }
    await reg?.update();
  } catch {
    /* offline or unsupported: the browser checks again later */
  }
}

export type PushStatus = "unsupported" | "blocked" | "on" | "off";

/** Whether this device will get phone alerts right now. */
export async function pushStatus(): Promise<PushStatus> {
  try {
    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      return "unsupported";
    }
    if (Notification.permission === "denied") return "blocked";
    if (Notification.permission !== "granted") return "off";
    const reg = await navigator.serviceWorker.getRegistration("/");
    return (await reg?.pushManager.getSubscription()) ? "on" : "off";
  } catch {
    return "off";
  }
}

export async function pushCapability(): Promise<{ available: boolean; publicKey?: string }> {
  try {
    const data = await requestJson<{ publicKey?: string }>("/api/bridge/push/vapidPublicKey", { cache: "no-store" }, 5000);
    return { available: !!data.publicKey, publicKey: data.publicKey };
  } catch { return { available: false }; }
}

/** Said when the browser's permission prompt was declined (callers may word it for their screen). */
export const PUSH_DENIED = "Notifications weren't allowed. Allow them in the browser's site settings, then try again.";

export async function enableWebPush(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      return { ok: false, error: "This browser can't get alerts. On Android, add the app to the home screen from Chrome first." };
    }
    const capability = await pushCapability();
    if (!capability.available || !capability.publicKey) return { ok: false, error: "Alerts aren't available from the PC right now. Try again after the app restarts there." };
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, error: PUSH_DENIED };
    const reg = await ensureServiceWorker();
    if (!reg) return { ok: false, error: "This browser couldn't set up alerts. Reload the page and try again." };
    const publicKey = capability.publicKey;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const saved = await requestJson<{ ok: boolean; error?: string }>("/api/bridge/push/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    if (!saved.ok) return { ok: false, error: saved.error || "The PC didn't save this device. Try again." };
    return { ok: true };
  } catch (e) {
    // The browser's push service refusing or timing out comes back as an AbortError with its own wording.
    if (e instanceof DOMException && (e.name === "AbortError" || e.name === "NotAllowedError")) {
      return { ok: false, error: e.name === "NotAllowedError" ? PUSH_DENIED : "The browser's alert service didn't answer. Try again in a minute." };
    }
    return { ok: false, error: friendlyError(e, "Alerts weren't turned on. Try again.") };
  }
}

/** How many devices get phone alerts (the bridge keeps only their push addresses, so a count is all there is). */
export async function pushDeviceCount(): Promise<number | null> {
  try {
    const data = await requestJson<{ ok: boolean; count?: number }>("/api/bridge/push/subscriptions", { cache: "no-store" }, 5000);
    return data.ok && typeof data.count === "number" ? data.count : null;
  } catch {
    return null;
  }
}

/** One test alert to every registered device. */
export async function sendTestPush(title: string): Promise<{ ok: boolean; sent: number; error?: string }> {
  try {
    const data = await requestJson<{ ok?: boolean; sent?: number; error?: string }>("/api/bridge/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body: "Test alert: phone alerts work.", url: "/" }),
    });
    return { ok: data.ok !== false && !data.error, sent: Number(data.sent || 0), error: data.error };
  } catch (e) {
    return { ok: false, sent: 0, error: friendlyError(e, "The test alert wasn't sent. Try again.") };
  }
}

/** Stop alerts on this device: forget it at the bridge and drop the browser's subscription. */
export async function disableWebPush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return { ok: true };
    await requestJson("/api/bridge/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    await sub.unsubscribe();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendlyError(e, "Alerts weren't turned off. Try again.") };
  }
}
