import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The desktop app's own log: one JSON object per line in `logs/main.jsonl` (boot steps, supervisor events,
 * refused IPC, errors), rotated at 5 MB with three older files kept. Every line passes through `redact`, so the
 * bridge token, the session secret and anything that looks like a credential never reach the disk.
 *
 * The children's raw output (gateway.log, dashboard.log) is rotated with the same helper.
 */
export type LogLevel = "info" | "warn" | "error";

export const LOG_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;

/** Move `file` to `file.1` (and `.1` to `.2`…, dropping the oldest) once it is over `maxBytes`. */
export function rotate(file: string, maxBytes = LOG_BYTES, keep = LOG_KEEP): void {
  try {
    if (!existsSync(file) || statSync(file).size < maxBytes) return;
    rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    renameSync(file, `${file}.1`);
  } catch {
    /* a log that can't rotate keeps growing; never stop the app for it */
  }
}

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]"],
  [/\b(token|secret|password|passwd|api[_-]?key|key|ticket|open)=([^&\s"']{6,})/gi, "$1=[redacted]"],
  // JSON pairs: "api_key": "…", "token": "…" (settings and replies written into a log line).
  [/("(?:[a-z_]*api[_-]?key|[a-z_]*token|[a-z_]*secret|password|authorization)"\s*:\s*)"[^"]{6,}"/gi, '$1"[redacted]"'],
  [/\b(ghp|gho|ghs|github_pat|sk|xox[abp]|glpat|hf|sk_live|rk_live)[-_][A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
  // Telegram bot tokens and JSON web tokens.
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  // The Windows user name in home paths (a report travels; who sent it is in the e-mail already).
  [/([A-Za-z]:[\\/]+Users[\\/]+)(?!Public\b|Default\b)[^\\/"'\s]+/gi, "$1<user>"],
];

export class Logger {
  private secrets = new Set<string>();

  constructor(
    private readonly dir: () => string,
    private readonly file = "main.jsonl",
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A value that must never be written (the bridge token, the session secret). */
  addSecret(value: string): void {
    if (value && value.length >= 8) this.secrets.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join("[redacted]");
    for (const [re, to] of PATTERNS) out = out.replace(re, to);
    return out;
  }

  write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    try {
      const dir = this.dir();
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, this.file);
      rotate(file);
      const line = JSON.stringify({ at: this.now().toISOString(), level, event, ...fields }, (_key, value) => (value instanceof Error ? { message: value.message, stack: value.stack } : value));
      appendFileSync(file, `${this.redact(line)}\n`);
    } catch {
      /* logging never stops the app */
    }
  }

  info(event: string, fields?: Record<string, unknown>) {
    this.write("info", event, fields);
  }
  warn(event: string, fields?: Record<string, unknown>) {
    this.write("warn", event, fields);
  }
  error(event: string, fields?: Record<string, unknown>) {
    this.write("error", event, fields);
  }
}
