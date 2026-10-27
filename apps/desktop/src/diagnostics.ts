import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { systemCwd, systemTool } from "./guards";

/**
 * Settings → About → Create diagnostics: the app's logs, the bridge's log, crash dumps and versions in one zip
 * the owner looks at and sends themselves. Nothing leaves the PC on its own. Text files pass through the log's
 * redaction (tokens, secrets, credential-looking values) on the way in.
 *
 * It runs in the main process, which also draws the window: files are read asynchronously, logs only their newest
 * part, and the work yields between files, so saving diagnostics never freezes the app.
 */
export type DiagnosticsSource = { dir: string; prefix: string; pattern: RegExp; text: boolean };

/** A crash dump over this size is left out. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** How much of each log goes in: its newest part (redacting a whole 5 MB log, times a dozen, held the window up). */
export const LOG_TAIL_BYTES = 2 * 1024 * 1024;

const breathe = () => new Promise<void>((r) => setImmediate(r));

/** The last `max` bytes of a file, from its first whole line on when it was cut. */
export async function readTail(file: string, max = LOG_TAIL_BYTES): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, size - length + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const tail = buffer.subarray(0, read);
    if (length === size) return tail.toString("utf8");
    // Cut mid-line (and maybe mid-character): start at the next whole line.
    const newline = tail.indexOf(0x0a);
    return (newline >= 0 ? tail.subarray(newline + 1) : tail).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Copy matching files from each source into `staging/<prefix>/`, redacting text; returns what was included. */
export async function collect(sources: DiagnosticsSource[], staging: string, redact: (text: string) => string): Promise<string[]> {
  const included: string[] = [];
  for (const source of sources) {
    if (!source.dir) continue;
    const names = await fs.readdir(source.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!source.pattern.test(name)) continue;
      const from = path.join(source.dir, name);
      const stat = await fs.stat(from).catch(() => null);
      if (!stat?.isFile()) continue;
      if (!source.text && stat.size > MAX_FILE_BYTES) continue;
      const to = path.join(staging, source.prefix, name);
      await fs.mkdir(path.dirname(to), { recursive: true });
      if (source.text) await fs.writeFile(to, redact(await readTail(from)));
      else await fs.copyFile(from, to);
      included.push(`${source.prefix}/${name}`);
      await breathe();
    }
  }
  return included;
}

/**
 * Zip a folder's contents with Windows' own PowerShell (no extra library in the app), off the main thread. The error is
 * a sentence for the owner; what PowerShell said is in `detail`, for the log.
 */
export function zipFolder(folder: string, out: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const failed = "Windows couldn't make the zip file. Try again, or save it in another folder.";
  return new Promise((resolve) => {
    const child = spawn(
      systemTool("powershell"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `Compress-Archive -Path ${q(path.join(folder, "*"))} -DestinationPath ${q(out)} -Force`],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], cwd: systemCwd() },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "Windows took too long to make the zip file. Try again.", detail: "Compress-Archive timed out" });
    }, 120_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: failed, detail: (stderr || `exit code ${code}`).trim().slice(0, 300) });
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: failed, detail: e.message });
    });
  });
}

export async function createDiagnostics(opts: {
  sources: DiagnosticsSource[];
  info: Record<string, unknown>;
  redact: (text: string) => string;
  out: string;
}): Promise<{ ok: boolean; files?: string[]; error?: string; detail?: string }> {
  const staging = await fs.mkdtemp(path.join(tmpdir(), "chief-diagnostics-"));
  try {
    const files = await collect(opts.sources, staging, opts.redact);
    await fs.writeFile(path.join(staging, "about.json"), opts.redact(JSON.stringify({ ...opts.info, files }, null, 2)));
    await fs.writeFile(
      path.join(staging, "README.txt"),
      "Chief Command Center diagnostics.\r\n\r\nLogs, crash dumps and versions from this PC. Tokens and passwords were removed, but logs can mention\r\nfile names and bits of what Chief was doing: look through them before sending.\r\n",
    );
    const zipped = await zipFolder(staging, opts.out);
    return zipped.ok ? { ok: true, files } : { ok: false, error: zipped.error, detail: zipped.detail };
  } catch (e) {
    return { ok: false, error: "The diagnostics couldn't be gathered. Try again.", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
