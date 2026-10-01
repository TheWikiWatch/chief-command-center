import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Phone access (Settings → Phone): the dashboard listens on 127.0.0.1 only, and the phone reaches it through
 * Tailscale Serve, which gives it a private https://<pc>.<tailnet>.ts.net address with a real certificate and
 * adds the viewer's Tailscale login to every request (apps/web/lib/tailnet-guard.ts checks it).
 *
 * The app reads Tailscale's state and, when the owner clicks Turn on, adds one Serve entry: HTTPS on one port →
 * http://127.0.0.1:<dashboard port>. It never touches another entry and never runs `tailscale serve reset`.
 */

/** Serve may expose HTTPS only on these ports. */
export const SERVE_PORTS = [443, 8443, 10000] as const;

export type ServeEntry = { port: number; target: string; ours: boolean };

export type TailscaleState = {
  installed: boolean;
  /** Tailscale's BackendState: Running, NeedsLogin, Stopped, NoState… ("" when not installed or unreadable). */
  backend: string;
  /** This PC's MagicDNS name without the trailing dot, e.g. pc.tailnet.ts.net ("" when unknown). */
  dnsName: string;
  /** The Tailscale login that owns this PC (the default "only you" allow-list). */
  login: string;
  /** HTTPS certificates are on for the tailnet (Serve needs them for a trusted https:// address). */
  https: boolean;
  /** Every HTTPS Serve entry on this PC, and whether it points at the dashboard. */
  serve: ServeEntry[];
  /** Why the state couldn't be read, in plain words ("" when fine). */
  error: string;
};

const LOOPBACK_TARGET = /^(?:http:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)\/?$/i;

/** Parse `tailscale status --json`. */
export function parseStatus(json: string): Pick<TailscaleState, "backend" | "dnsName" | "login" | "https"> {
  const s = JSON.parse(json) as {
    BackendState?: string;
    Self?: { DNSName?: string; UserID?: number };
    User?: Record<string, { LoginName?: string }>;
    CertDomains?: string[] | null;
  };
  const userId = s.Self?.UserID;
  return {
    backend: String(s.BackendState || ""),
    dnsName: String(s.Self?.DNSName || "").replace(/\.$/, ""),
    login: userId !== undefined ? String(s.User?.[String(userId)]?.LoginName || "") : "",
    https: Array.isArray(s.CertDomains) && s.CertDomains.length > 0,
  };
}

/** Parse `tailscale serve status --json` into its HTTPS entries ("/" handlers), marking those that serve `uiPort`. */
export function parseServe(json: string, uiPort: number): ServeEntry[] {
  const text = json.trim();
  if (!text || text === "{}") return [];
  const s = JSON.parse(text) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }> };
  const out: ServeEntry[] = [];
  for (const [hostPort, web] of Object.entries(s.Web || {})) {
    const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
    if (!Number.isFinite(port)) continue;
    const root = web.Handlers?.["/"];
    const target = root?.Proxy || root?.Path || (root?.Text !== undefined ? "text" : "") || Object.keys(web.Handlers || {}).join(", ");
    const m = LOOPBACK_TARGET.exec(root?.Proxy || "");
    out.push({ port, target, ours: !!m && Number(m[1]) === uiPort });
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * Which HTTPS port to use for the dashboard: the one already serving it, else 443 if free, else the first free
 * Serve port. null when every Serve port is taken by something else.
 */
export function choosePort(entries: ServeEntry[], wanted?: number): number | null {
  const ours = entries.find((e) => e.ours);
  if (ours) return ours.port;
  const taken = new Set(entries.map((e) => e.port));
  if (wanted !== undefined) return SERVE_PORTS.includes(wanted as (typeof SERVE_PORTS)[number]) && !taken.has(wanted) ? wanted : null;
  return SERVE_PORTS.find((p) => !taken.has(p)) ?? null;
}

/** The phone's address for a Serve port. */
export function phoneUrl(dnsName: string, port: number): string {
  return dnsName ? `https://${dnsName}${port === 443 ? "" : `:${port}`}` : "";
}

/** Tailscale's consent link, when Serve or HTTPS isn't enabled for the tailnet yet. */
export function consentUrl(output: string): string {
  return /https:\/\/login\.tailscale\.com\/[^\s"']+/.exec(output)?.[0] || "";
}

/** tailscale.exe: the standard install folder, else PATH. "" when not installed. */
export function findTailscale(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    path.join(env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe"),
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Tailscale", "tailscale.exe"),
    ...(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "tailscale.exe")),
  ];
  return candidates.find((p) => existsSync(p)) || "";
}

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; out: string }>;

export const execTailscale: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout || ""}${stderr || ""}` });
    });
  });

export async function readState(uiPort: number, exe = findTailscale(), exec: Exec = execTailscale): Promise<TailscaleState> {
  const blank: TailscaleState = { installed: !!exe, backend: "", dnsName: "", login: "", https: false, serve: [], error: "" };
  if (!exe) return blank;
  const status = await exec(exe, ["status", "--json"], 10_000);
  let base: ReturnType<typeof parseStatus>;
  try {
    base = parseStatus(status.out.slice(status.out.indexOf("{")));
  } catch {
    return { ...blank, error: "Tailscale is installed but isn't answering. Open the Tailscale app, then check again." };
  }
  let serve: ServeEntry[] = [];
  if (base.backend === "Running") {
    const res = await exec(exe, ["serve", "status", "--json"], 10_000);
    try {
      serve = parseServe(res.out.includes("{") ? res.out.slice(res.out.indexOf("{")) : "", uiPort);
    } catch {
      serve = [];
    }
  }
  return { ...blank, ...base, serve };
}

export type ServeResult = { ok: true; port: number } | { ok: false; error: string; consentUrl?: string };

/**
 * Add the dashboard's Serve entry. When the tailnet hasn't allowed Serve or HTTPS yet, Tailscale prints a
 * consent link and waits; the link is returned (the owner opens it, then tries again) and the wait is ended.
 */
export function enableServe(exe: string, port: number, uiPort: number, spawnImpl: typeof spawn = spawn, waitMs = 20_000): Promise<ServeResult> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (r: ServeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve(r);
    };
    const child = spawnImpl(exe, ["serve", "--bg", "--yes", `--https=${port}`, `http://127.0.0.1:${uiPort}`], { windowsHide: true });
    const timer = setTimeout(() => {
      const link = consentUrl(out);
      done(link ? { ok: false, error: "Tailscale needs your permission first.", consentUrl: link } : { ok: false, error: "Tailscale didn't answer in time. Check the Tailscale app, then try again." });
    }, waitMs);
    const take = (chunk: Buffer | string) => {
      out += String(chunk);
      const link = consentUrl(out);
      if (link) done({ ok: false, error: "Tailscale needs your permission first.", consentUrl: link });
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => done({ ok: false, error: "Tailscale couldn't be started." }));
    child.on("close", (code) => {
      if (code === 0) done({ ok: true, port });
      else done({ ok: false, error: plainServeError(out) });
    });
  });
}

/** Remove only the dashboard's own entry on `port`. */
export async function disableServe(exe: string, port: number, uiPort: number, exec: Exec = execTailscale): Promise<ServeResult> {
  const res = await exec(exe, ["serve", "--yes", `--https=${port}`, `http://127.0.0.1:${uiPort}`, "off"], 15_000);
  return res.code === 0 ? { ok: true, port } : { ok: false, error: plainServeError(res.out) };
}

function plainServeError(out: string): string {
  const text = out.trim();
  if (/access denied|permission|operator/i.test(text)) return "Tailscale refused the change for this Windows account. Open the Tailscale app as the same user, then try again.";
  if (/not logged in|NeedsLogin/i.test(text)) return "Tailscale isn't signed in on this PC.";
  const line = text.split(/\r?\n/).find((l) => l.trim()) || "";
  return line ? `Tailscale said: ${line.slice(0, 200)}` : "Tailscale couldn't change its settings.";
}
