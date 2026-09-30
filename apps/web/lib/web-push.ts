"use client";

import { requestJson } from "@/lib/request";

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

/** A device that already enabled push picks up a changed sw.js on the next app load, not days later. */
export async function refreshServiceWorker(): Promise<void> {
  try {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration("/");
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

export async function enableWebPush(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      return { ok: false, error: "Web Push not supported in this browser" };
    }
    const capability = await pushCapability();
    if (!capability.available || !capability.publicKey) return { ok: false, error: "Phone alerts are unavailable on this bridge." };
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, error: "notification permission denied" };
    const reg = await ensureServiceWorker();
    if (!reg) return { ok: false, error: "service worker failed" };
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
    if (!saved.ok) return { ok: false, error: saved.error || "Subscribe failed" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
