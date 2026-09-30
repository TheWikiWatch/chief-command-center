import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

function tailscaleBin() {
  const win = "C:\\Program Files\\Tailscale\\tailscale.exe";
  if (process.platform === "win32" && existsSync(win)) return win;
  return "tailscale";
}

function serveHosts(): string[] {
  const extra: string[] = [];
  const fromEnv = (process.env.CHIEF_DASHBOARD_SERVE_HOST || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (fromEnv) extra.push(fromEnv);
  try {
    const raw = execFileSync(tailscaleBin(), ["status", "--json"], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
    });
    const json = JSON.parse(raw) as { Self?: { DNSName?: string } };
    const dns = String(json.Self?.DNSName || "").replace(/\.$/, "");
    if (dns) extra.push(dns);
  } catch {
    /* Tailscale is optional until Serve is installed */
  }
  return [...new Set(extra)];
}

const config = (phase: string): NextConfig => ({
  // The desktop app runs the production server from `.next/standalone` (server.js plus only the
  // node_modules it needs); packaging copies `.next/static` and `public` next to it.
  output: "standalone",
  // Hide the floating Next.js N badge in next dev (errors still surface).
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/devIndicators
  devIndicators: false,
  allowedDevOrigins: phase === PHASE_DEVELOPMENT_SERVER ? ["127.0.0.1", "localhost", ...serveHosts()] : [],
  experimental: {
    // Above the bridge's 80 MB /send cap. Next truncates (not rejects) bodies past this.
    // Composer limits live in lib/upload-limits.ts.
    middlewareClientMaxBodySize: "110mb",
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Permissions-Policy", value: "microphone=(self)" }],
      },
    ];
  },
});

export default config;
