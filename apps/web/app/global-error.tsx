"use client";

import { useEffect, useSyncExternalStore, type CSSProperties } from "react";

import { reloadForNewBuild } from "@/lib/recover";

/*
 * The app's last look on this device (lib/app-look.ts keeps it under "chief-app-look"), read here directly: this page
 * stands in for the whole app, so nothing else (the look's hook, the stylesheet) can be counted on.
 */
const LOOK_KEY = "chief-app-look";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

function lightLook(): boolean {
  try {
    const mode = (JSON.parse(localStorage.getItem(LOOK_KEY) || "{}") as { mode?: unknown }).mode;
    return mode === "light" || (mode === "system" && window.matchMedia(LIGHT_QUERY).matches);
  } catch {
    return false;
  }
}

function subscribe(changed: () => void) {
  const media = window.matchMedia(LIGHT_QUERY);
  media.addEventListener("change", changed);
  window.addEventListener("storage", changed);
  return () => {
    media.removeEventListener("change", changed);
    window.removeEventListener("storage", changed);
  };
}

const COLORS = {
  dark: { canvas: "#09090B", fg: "#FAFAFA", fg2: "#A1A1AA", line: "#3F3F46" },
  light: { canvas: "#F6F6F8", fg: "#18181B", fg2: "#484850", line: "rgb(0 0 0 / 0.2)" },
};

/** The last resort, when even the app's frame failed: plain styles, since the stylesheet may be what's missing. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reloadForNewBuild(error);
  }, [error]);
  // Dark on the server (the app's default), the owner's own look once in the browser.
  const light = useSyncExternalStore(subscribe, lightLook, () => false);
  const c = COLORS[light ? "light" : "dark"];
  const button = { minHeight: 44, padding: "0 20px", borderRadius: 999, font: "inherit", cursor: "pointer", WebkitAppRegion: "no-drag" } as CSSProperties;
  return (
    <html lang="en" style={{ backgroundColor: c.canvas, colorScheme: light ? "light" : "dark" }}>
      <body style={{ margin: 0, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, backgroundColor: c.canvas, color: c.fg, fontFamily: "system-ui, sans-serif", textAlign: "center", padding: 24 }}>
        {/* The desktop window has no title bar: this strip moves it (the window's own buttons sit at its right). */}
        <div aria-hidden style={{ position: "fixed", top: 0, left: 0, right: 0, height: 60, WebkitAppRegion: "drag" } as CSSProperties} />
        <p style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Something went wrong</p>
        <p style={{ maxWidth: 360, margin: 0, color: c.fg2 }}>Your chief is fine; only the app&apos;s view stopped.</p>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" onClick={reset} style={{ ...button, border: "none", background: c.fg, color: c.canvas }}>
            Try again
          </button>
          <button type="button" onClick={() => window.location.reload()} style={{ ...button, border: `1px solid ${c.line}`, background: "transparent", color: c.fg }}>
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
