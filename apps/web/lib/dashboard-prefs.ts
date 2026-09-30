"use client";

import { useSyncExternalStore } from "react";

import { loadSpeakEnabled, loadStayAwake, persistSpeakEnabled, persistStayAwake } from "@/lib/voice-client";

export const FONT_KEY = "chief-chat-font";
export const COMPACT_KEY = "chief-chat-compact";
export const STAY_KEY = "chief-stay-awake";
/** Photos go up full size instead of shrunk to 2048px on the device (lib/image-shrink.ts). */
export const FULL_PHOTOS_KEY = "chief-full-photos";
export const FONT_STEPS = [13, 14, 16, 18, 20] as const;
export const PREFS_EVENT = "chief-dashboard-prefs";
export const VOICE_EVENT = "chief-voice-config";

const SSR_FONT = 14;
const SSR_SPEAK = false;

function readFont(phone: boolean) {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    if ((FONT_STEPS as readonly number[]).includes(n)) return n;
  } catch {
    /* ignore */
  }
  return phone ? 16 : 14;
}

function writeFont(px: number) {
  try {
    localStorage.setItem(FONT_KEY, String(px));
  } catch {
    /* ignore */
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(PREFS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREFS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function notifyVoiceConfig() {
  try {
    window.dispatchEvent(new Event(VOICE_EVENT));
  } catch {
    /* ignore */
  }
}

function emitPrefs() {
  try {
    window.dispatchEvent(new Event(PREFS_EVENT));
  } catch {
    /* ignore */
  }
}


function readCompact() {
  try {
    return localStorage.getItem(COMPACT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCompact(on: boolean) {
  try {
    localStorage.setItem(COMPACT_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function readFullPhotos() {
  try {
    return localStorage.getItem(FULL_PHOTOS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Read outside React (the composer checks it when files are added). */
export const fullPhotosOn = readFullPhotos;

export function useDashboardPrefs(phone: boolean) {
  const fontPx = useSyncExternalStore(subscribe, () => readFont(phone), () => SSR_FONT);
  const speakOn = useSyncExternalStore(subscribe, () => loadSpeakEnabled(phone), () => SSR_SPEAK);
  const compactChat = useSyncExternalStore(subscribe, () => readCompact(), () => false);
  const stayAwake = useSyncExternalStore(subscribe, () => loadStayAwake(), () => false);
  const fullPhotos = useSyncExternalStore(subscribe, readFullPhotos, () => false);

  function setFullPhotos(on: boolean) {
    try {
      localStorage.setItem(FULL_PHOTOS_KEY, on ? "1" : "0");
    } catch {
      /* ignore */
    }
    emitPrefs();
  }

  function setFont(next: number) {
    const px = (FONT_STEPS as readonly number[]).includes(next) ? next : fontPx;
    writeFont(px);
    emitPrefs();
  }

  function setSpeak(on: boolean) {
    persistSpeakEnabled(on);
    emitPrefs();
  }

  function setCompactChat(on: boolean) {
    writeCompact(on);
    emitPrefs();
  }

  function setStayAwake(on: boolean) {
    persistStayAwake(on);
    emitPrefs();
  }

  function bumpFont(dir: 1 | -1) {
    const i = (FONT_STEPS as readonly number[]).indexOf(fontPx as (typeof FONT_STEPS)[number]);
    const idx = Math.min(FONT_STEPS.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir));
    setFont(FONT_STEPS[idx]);
  }

  return { fontPx, speakOn, compactChat, stayAwake, fullPhotos, setFont, setSpeak, setCompactChat, setStayAwake, setFullPhotos, bumpFont };
}
