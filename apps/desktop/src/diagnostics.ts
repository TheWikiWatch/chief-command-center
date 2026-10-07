import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Settings → About → Create diagnostics: the app's logs, the bridge's log, crash dumps and versions in one zip
 * the owner looks at and sends themselves. Nothing leaves the PC on its own. Text files pass through the log's
 * redaction (tokens, secrets, credential-looking values) on the way in.
 */
export type DiagnosticsSource = { dir: string; prefix: string; pattern: RegExp; text: boolean };

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Copy matching files from each source into `staging/<prefix>/`, redacting text; returns what was included. */
export function collect(sources: DiagnosticsSource[], staging: string, redact: (text: string) => string): string[] {
  const included: string[] = [];
  for (const source of sources) {
    if (!source.dir || !existsSync(source.dir)) continue;
    for (const name of readdirSync(source.dir)) {
      const from = path.join(source.dir, name);
      if (!source.pattern.test(name) || !statSync(from).isFile()) continue;
      const to = path.join(staging, source.prefix, name);
      mkdirSync(path.dirname(to), { recursive: true });
      const size = statSync(from).size;
      if (source.text) {
        // The newest part of a log over the size limit is the useful part.
        const buffer = readFileSync(from);
        const tail = size > MAX_FILE_BYTES ? buffer.subarray(size - MAX_FILE_BYTES) : buffer;
        writeFileSync(to, redact(tail.toString("utf8")));
      } else if (size <= MAX_FILE_BYTES) copyFileSync(from, to);
      else continue;
      included.push(`${source.prefix}/${name}`);
    }
  }
  return included;
}

/** Zip a folder's contents with Windows' own PowerShell (no extra library in the app), off the main thread. */
export function zipFolder(folder: string, out: string): Promise<{ ok: boolean; error?: string }> {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `Compress-Archive -Path ${q(path.join(folder, "*"))} -DestinationPath ${q(out)} -Force`],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "Windows took too long to make the zip." });
    }, 120_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: (stderr || "Windows couldn't make the zip.").trim().slice(0, 300) });
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
  });
}

export async function createDiagnostics(opts: {
  sources: DiagnosticsSource[];
  info: Record<string, unknown>;
  redact: (text: string) => string;
  out: string;
}): Promise<{ ok: boolean; files?: string[]; error?: string }> {
  const staging = mkdtempSync(path.join(tmpdir(), "chief-diagnostics-"));
  try {
    const files = collect(opts.sources, staging, opts.redact);
    writeFileSync(path.join(staging, "about.json"), opts.redact(JSON.stringify({ ...opts.info, files }, null, 2)));
    writeFileSync(
      path.join(staging, "README.txt"),
      "Chief Command Center diagnostics.\r\n\r\nLogs, crash dumps and versions from this PC. Tokens and passwords were removed, but logs can mention\r\nfile names and bits of what Chief was doing: look through them before sending.\r\n",
    );
    const zipped = await zipFolder(staging, opts.out);
    return zipped.ok ? { ok: true, files } : { ok: false, error: zipped.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
