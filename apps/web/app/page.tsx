"use client";

import { useSyncExternalStore } from "react";

import { CommandShell } from "@/components/command-shell";

const subscribe = () => () => {};

export default function HomePage() {
  // The server can't know a phone from a desktop, so it sends the bare canvas: rendering the desktop layout first
  // made a phone reloading the app show it for a moment before switching (the screen "cutting out").
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return mounted ? <CommandShell /> : <div className="h-app bg-canvas" />;
}
