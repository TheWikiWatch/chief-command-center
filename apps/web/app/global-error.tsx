"use client";

import { useEffect } from "react";

import { reloadForNewBuild } from "@/lib/recover";

/** The last resort, when even the app's frame failed: plain styles, since the stylesheet may be what's missing. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reloadForNewBuild(error);
  }, [error]);
  const button = { minHeight: 44, padding: "0 20px", borderRadius: 999, font: "inherit", cursor: "pointer" } as const;
  return (
    <html lang="en" style={{ backgroundColor: "#09090B", colorScheme: "dark" }}>
      <body style={{ margin: 0, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, backgroundColor: "#09090B", color: "#FAFAFA", fontFamily: "system-ui, sans-serif", textAlign: "center", padding: 24 }}>
        <p style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Something went wrong</p>
        <p style={{ maxWidth: 360, margin: 0, color: "#A1A1AA" }}>Your chief is fine; only the app&apos;s view stopped.</p>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" onClick={reset} style={{ ...button, border: "none", background: "#FAFAFA", color: "#09090B" }}>
            Try again
          </button>
          <button type="button" onClick={() => window.location.reload()} style={{ ...button, border: "1px solid #3F3F46", background: "transparent", color: "#FAFAFA" }}>
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
