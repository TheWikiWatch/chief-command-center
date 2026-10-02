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

/**
 * Response headers for every page and route. They live here, not in lib/: Next's config loader doesn't resolve
 * local imports (tests import them from this file).
 *
 * - Nothing may frame the dashboard (`frame-ancestors 'none'`, `X-Frame-Options`): over Tailscale, any site open
 *   on the phone could otherwise load it in a frame and trick a tap on "Allow" (identity comes from the network,
 *   and requests made inside the frame pass the Origin check).
 * - The page talks only to its own server (`connect-src 'self'`), and loads scripts, styles, fonts, pictures and
 *   media only from itself (plus `data:`/`blob:` for previews and spoken replies). Even injected markup in a reply
 *   can't send anything to another host or pull in a tracking image.
 * - Inline scripts stay allowed: Next's bootstrap is inline. A per-request nonce would need dynamic rendering of
 *   every page and is a later step; the connect/img/frame limits above are what stop data leaving.
 */
export function contentSecurityPolicy(dev: boolean): string {
  const script = ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", ...(dev ? ["'unsafe-eval'"] : [])];
  const connect = ["'self'", "data:", "blob:", ...(dev ? ["ws:"] : [])];
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function securityHeaders(dev: boolean): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(dev) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // External links never carry the dashboard's address (a tailnet host name) to the site they open.
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=(), usb=()" },
  ];
}

const config = (phase: string): NextConfig => ({
  // The desktop app runs the production server from `.next/standalone` (server.js plus only the
  // node_modules it needs); packaging copies `.next/static` and `public` next to it.
  output: "standalone",
  // This folder is the app's root, even though the repository root has a package-lock.json too (its Python
  // tooling): otherwise Next traces from the repository root and nests the server under standalone/apps/web.
  outputFileTracingRoot: process.cwd(),
  // Hide the floating Next.js N badge in next dev (errors still surface).
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/devIndicators
  devIndicators: false,
  allowedDevOrigins: phase === PHASE_DEVELOPMENT_SERVER ? ["127.0.0.1", "localhost", ...serveHosts()] : [],
  // KaTeX stays out of the bundle (lib/no-katex.ts): math in replies shows as code instead of typeset.
  turbopack: { root: process.cwd(), resolveAlias: { "rehype-katex": "./lib/no-katex.ts" } },
  experimental: {
    // Above the bridge's 80 MB /send cap. Next truncates (not rejects) bodies past this.
    // Composer limits live in lib/upload-limits.ts.
    proxyClientMaxBodySize: "110mb",
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(phase === PHASE_DEVELOPMENT_SERVER),
      },
    ];
  },
});

export default config;
