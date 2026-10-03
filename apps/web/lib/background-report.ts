/**
 * Hermes hands the chief the results of its background work as a message in the chief's own conversation: a
 * finished delegation ("[ASYNC DELEGATION BATCH COMPLETE — …]"), one task of a batch failing early, or a background
 * command ending ("[IMPORTANT: Background process …]"). They are written for the chief (instructions, every task's
 * raw findings, transcript paths) and the transcript stores them as a user message, so shown as they are they
 * were a wall of text from the owner. This reads them into something the chat can show compactly; the formats
 * are Hermes's tools/process_registry_notifications.py.
 */

export type ReportTask = {
  goal: string;
  status: string;
  ok: boolean;
  /** Hit its iteration cap: the findings may be incomplete. */
  truncated: boolean;
  seconds: number | null;
  /** The findings, in the subagent's own words (markdown), without the chief-only bookkeeping lines. */
  body: string;
};

export type BackgroundReport =
  | { kind: "tasks"; ok: boolean; tasks: ReportTask[]; seconds: number | null; error: string }
  | { kind: "taskFailed"; task: ReportTask; index: number; of: number }
  | { kind: "commands"; ok: boolean; commands: CommandResult[] }
  | { kind: "note"; text: string };

export type CommandResult = { id: string; command: string; status: string; ok: boolean; exitCode: string; output: string };

const DONE = new Set(["completed", "success"]);
// Lines meant only for the chief: where to find a transcript, process hand-offs, retry advice.
const BOOKKEEPING = /^(Full live transcript|Live transcript|Handed off to you|Child left|Child's process|Task index \d+ transcript|Owner working tree|Last persisted unit status)/;

export function isBackgroundReport(text: string): boolean {
  return /^\[(ASYNC DELEGATION (BATCH COMPLETE|COMPLETE|TASK FAILED)|IMPORTANT: |Background process \S+ heartbeat)/.test(text.trimStart());
}

const secondsOf = (raw: string | undefined): number | null => {
  const n = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
};

const cleanBody = (lines: string[]): string =>
  lines
    .filter((l) => !BOOKKEEPING.test(l.trim()) && !l.startsWith("[TRUNCATED — subagent hit its iteration cap"))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");

export function parseBackgroundReport(raw: string): BackgroundReport | null {
  const text = String(raw || "").replace(/\r\n/g, "\n").trim();
  if (!isBackgroundReport(text)) return null;
  if (text.startsWith("[ASYNC DELEGATION BATCH COMPLETE")) return batch(text);
  if (text.startsWith("[ASYNC DELEGATION COMPLETE")) return single(text);
  if (text.startsWith("[ASYNC DELEGATION TASK FAILED")) return taskFailed(text);
  const commands = commandResults(text);
  if (commands.length) return { kind: "commands", ok: commands.every((c) => c.ok), commands };
  // A watch match, a heartbeat or a notice about a watch: a short line is enough.
  const first = text.replace(/^\[(IMPORTANT: )?/, "").split("\n")[0].replace(/\]$/, "");
  return { kind: "note", text: first };
}

function batch(text: string): BackgroundReport {
  const lines = text.split("\n");
  const total = /Total duration: ([\d.]+)s/.exec(text)?.[1];
  const errorAt = lines.indexOf("--- ERROR ---");
  const tasks: ReportTask[] = [];
  let current: { head: RegExpExecArray; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const [, icon, , , goal = "", meta] = current.head;
    const status = /status=([\w-]+)/.exec(meta)?.[1] || "?";
    const truncated = icon === "⚠" || meta.includes("TRUNCATED");
    tasks.push({ goal: goal.trim(), status, ok: DONE.has(status) && !truncated, truncated, seconds: secondsOf(/(?:^|, )([\d.]+)s(?:,|$)/.exec(meta)?.[1]), body: cleanBody(current.body) });
  };
  for (const line of lines) {
    const head = /^--- ([✓✗⚠]) TASK (\d+)\/(\d+)(?:: (.*?))?\s{2}\((.*)\) ---$/.exec(line);
    if (head) {
      flush();
      current = { head, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  const error = errorAt >= 0 ? lines.slice(errorAt + 1).join(" ").replace(/^The batch did not complete successfully:\s*/, "").trim() : "";
  return { kind: "tasks", ok: !error && tasks.length > 0 && tasks.every((t) => t.ok), tasks, seconds: secondsOf(total), error };
}

function single(text: string): BackgroundReport {
  const goal = /^Original goal: (.*)$/m.exec(text)?.[1] || "";
  const statusLine = /^Status: (\S+)\s+API calls: \S+\s+Duration: ([\d.]+)s(.*)$/m.exec(text);
  const status = statusLine?.[1] || "?";
  const truncated = !!statusLine?.[3]?.includes("TRUNCATED");
  const at = text.indexOf("--- RESULT ---");
  const body = at >= 0 ? cleanBody(text.slice(at + "--- RESULT ---".length).split("\n")) : "";
  const task: ReportTask = { goal, status, ok: DONE.has(status) && !truncated, truncated, seconds: secondsOf(statusLine?.[2]), body };
  return { kind: "tasks", ok: task.ok, tasks: [task], seconds: task.seconds, error: "" };
}

function taskFailed(text: string): BackgroundReport {
  const head = /^\[ASYNC DELEGATION TASK FAILED — [^,\]]+, task (\d+)\/(\d+)\]/.exec(text);
  const goal = /^Task: (.*)$/m.exec(text)?.[1] || "";
  const statusLine = /^Status: (\S+)\s+Duration: ([\d.?]+)s/m.exec(text);
  const error = /^Error: (.*)$/m.exec(text)?.[1] || "";
  return {
    kind: "taskFailed",
    index: Number(head?.[1] || 1),
    of: Number(head?.[2] || 1),
    task: { goal, status: statusLine?.[1] || "failed", ok: false, truncated: false, seconds: secondsOf(statusLine?.[2]), body: error },
  };
}

function commandResults(text: string): CommandResult[] {
  const out: CommandResult[] = [];
  const re = /\[IMPORTANT: Background process (\S+) (.+?) \(exit code ([^)]*?)\)\.\n([\s\S]*?)(?=\n\n\[IMPORTANT: Background process |$)/g;
  for (const m of text.matchAll(re)) {
    const [, id, status, exitCode, rest] = m;
    const command = /^Command: (.*)$/m.exec(rest)?.[1] || "";
    const at = rest.indexOf("Output:\n");
    const output = (at >= 0 ? rest.slice(at + "Output:\n".length) : "").replace(/\]\s*$/, "").trimEnd();
    out.push({ id, command, status: status.trim(), ok: exitCode.trim() === "0", exitCode: exitCode.trim(), output });
  }
  return out;
}

/** "5m 40s", "45s", "1h 2m": a duration for the collapsed line. */
export function durationLabel(seconds: number | null): string {
  if (seconds === null) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** How many parts need a look (shown beside the title as a short amber tag, so the title stays short on a phone). */
export function reportIssues(report: BackgroundReport): number {
  if (report.kind === "tasks") return report.error ? Math.max(1, report.tasks.length) : report.tasks.filter((t) => !t.ok).length;
  if (report.kind === "commands") return report.commands.filter((c) => !c.ok).length;
  return report.kind === "taskFailed" ? 1 : 0;
}

/** The collapsed line: what came back, in a few words. */
export function reportTitle(report: BackgroundReport): string {
  if (report.kind === "tasks") {
    if (report.error) return "Background work didn't finish";
    if (report.tasks.length === 1) return `${report.tasks[0].ok ? "Background task finished" : "Background task didn't finish"}: ${report.tasks[0].goal || "a task"}`;
    return `${report.tasks.length} background tasks`;
  }
  if (report.kind === "taskFailed") return `A background task failed (${report.index} of ${report.of}): ${report.task.goal || "a task"}`;
  if (report.kind === "commands") {
    if (report.commands.length === 1) return `${report.commands[0].ok ? "Background command finished" : "Background command failed"}: ${report.commands[0].command || report.commands[0].id}`;
    return `${report.commands.length} background commands`;
  }
  return report.text;
}
