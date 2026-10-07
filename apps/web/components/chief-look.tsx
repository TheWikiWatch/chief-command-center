"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import { BotFace, faceProps } from "@/components/bot-face";
import { chiefColor } from "@/lib/bot-identity";
import { desktop } from "@/lib/desktop";
import { faceSnapshot, hexColor } from "@/lib/face-snapshot";
import { motionReducedNow } from "@/lib/motion";
import type { Person } from "@/lib/types";

const noSubscription = () => () => undefined;

/** The face size the update window gets (it draws it at 56 px, so this stays crisp at 400% scaling). */
const SNAPSHOT_PX = 224;

/**
 * What the desktop app's update window shows of Chief (apps/desktop/src/main.ts readChiefLook): `window.__chiefLook()`
 * gives its face as a PNG, its colour and its name. The face is a still, idle copy kept out of sight, so the snapshot
 * is Chief awake whatever the page shows at that moment (the restart stops the gateway, and the page then dims and
 * puts the visible face to sleep). Only in the desktop app; renders nothing anywhere else.
 */
export function ChiefLookExport({ chief, assistant }: { chief: Person | undefined; assistant: string }) {
  const root = useRef<HTMLDivElement>(null);
  // In the desktop app or not never changes while the page lives; false on the server and in the first render.
  const inApp = useSyncExternalStore(noSubscription, () => !!desktop(), () => false);
  useEffect(() => {
    if (!inApp) return;
    const w = window as unknown as { __chiefLook?: () => Promise<unknown> };
    w.__chiefLook = async () => ({
      png: await faceSnapshot(root.current, SNAPSHOT_PX),
      accent: chief ? hexColor(chiefColor(chief)) : "",
      name: assistant,
      reducedMotion: motionReducedNow(),
    });
    return () => {
      delete w.__chiefLook;
    };
  }, [inApp, chief, assistant]);
  if (!inApp || !chief) return null;
  return (
    <div ref={root} aria-hidden="true" className="pointer-events-none fixed top-0 -left-[9999px]" style={{ width: SNAPSHOT_PX, height: SNAPSHOT_PX }}>
      <BotFace {...faceProps(chief)} ring="idle" size={SNAPSHOT_PX} still />
    </div>
  );
}
