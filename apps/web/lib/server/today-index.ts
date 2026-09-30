import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Board, ColumnData, FocusCard, Meta, Pulse, TaskCard, TodayItem } from "@/lib/ops";

/**
 * Today without a task service: open tasks read straight from the Second Brain's Markdown, in the same
 * shapes the Ops API returns so the Today tab works unchanged (PLAN-2026-09-30 §13).
 *
 * Tasks are checkbox lines with the Obsidian Tasks date syntax (AGENTS.md in the template):
 *   - [ ] Call the plumber ⏫ 📅 2026-10-02 #waiting
 * `[ ]` open, `[/]` in progress, `[x]` done, `[-]` cancelled; 📅 due, ⏳ scheduled, ✅ done date;
 * priority 🔺 ⏫ 🔼 🔽. A board is one project or area note, or a top-level folder (Inbox, Journal, …).
 * Read-only: nothing here writes the vault. Files are re-read only when their mtime changes.
 */

export const OPEN_COLUMNS = ["In Progress", "This Week", "Waiting On", "Next Week", "Backlog"] as const;
const DONE = "Done";
const SKIP_DIRS = new Set([".obsidian", ".git", ".trash", "_trash", ".stfolder", "node_modules", "Templates", "Attachments", "Bases", "90 Archive"]);
const SKIP_PATHS = ["40 Knowledge/raw"];
const PER_NOTE_FOLDERS = new Set(["10 Projects", "20 Areas"]);
const MAX_FILES = 8000;
const MAX_BYTES = 1_000_000;
const PALETTE = ["#6aa9ff", "#f2a05a", "#7bd88f", "#c792ea", "#ff8f8f", "#5fd4d4", "#e6c86e", "#9aa7ff", "#ff9ec7", "#8fd1a8"];

const TASK = /^\s*[-*+] \[([ xX/\-])\] (.+)$/;
const FENCE = /^\s*(```|~~~)/;
const DATE = "(\\d{4}-\\d{2}-\\d{2})";
const DUE = new RegExp(`📅\\s*${DATE}`);
const SCHEDULED = new RegExp(`⏳\\s*${DATE}`);
const DONE_DATE = new RegExp(`✅\\s*${DATE}`);
const FIELD = new RegExp(`(?:📅|⏳|✅|🛫|➕|❌)\\s*${DATE}`, "g");
const RECUR = /🔁[^📅⏳✅🛫➕❌🔺⏫🔼🔽#]*/gu;
const PRIORITY = /[🔺⏫🔼🔽]️?/gu;
const WAITING = /(^|\s)#waiting(?:[-/][\w-]+)?\b/i;

export type ParsedTask = {
  id: string;
  file: string;
  line: number;
  raw: string;
  text: string;
  status: "open" | "progress" | "done" | "cancelled";
  due: string | null;
  scheduled: string | null;
  doneDate: string | null;
  priority: "highest" | "high" | "medium" | "low" | null;
  waiting: boolean;
};

export function parseTasks(file: string, content: string): ParsedTask[] {
  const out: ParsedTask[] = [];
  const seen = new Map<string, number>();
  let fenced = false;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = TASK.exec(line);
    if (!m) continue;
    const mark = m[1];
    const body = m[2];
    const text = body
      .replace(FIELD, " ")
      .replace(RECUR, " ")
      .replace(PRIORITY, " ")
      .replace(WAITING, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const key = `${file}\n${body.trim()}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.push({
      id: createHash("sha1").update(`${key}\n${n}`).digest("hex").slice(0, 12),
      file,
      line: i + 1,
      raw: line,
      text,
      status: mark === " " ? "open" : mark === "/" ? "progress" : mark === "-" ? "cancelled" : "done",
      due: DUE.exec(body)?.[1] ?? null,
      scheduled: SCHEDULED.exec(body)?.[1] ?? null,
      doneDate: DONE_DATE.exec(body)?.[1] ?? null,
      priority: body.includes("🔺") ? "highest" : body.includes("⏫") ? "high" : body.includes("🔼") ? "medium" : body.includes("🔽") ? "low" : null,
      waiting: WAITING.test(body),
    });
  }
  return out;
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export function columnFor(task: ParsedTask, today: string): string {
  if (task.status === "done" || task.status === "cancelled") return DONE;
  if (task.status === "progress") return "In Progress";
  if (task.waiting) return "Waiting On";
  const when = [task.due, task.scheduled].filter(Boolean).sort()[0] as string | undefined;
  if (when) {
    const ahead = daysBetween(today, when);
    if (ahead <= 7) return "This Week";
    if (ahead <= 14) return "Next Week";
    return "Backlog";
  }
  return task.priority === "highest" || task.priority === "high" ? "This Week" : "Backlog";
}

export type BoardKey = { name: string; file: string };

/** Which board a note's tasks belong to. */
export function boardFor(file: string): BoardKey {
  const parts = file.split("/");
  if (parts.length === 1) return { name: "Notes", file: "" };
  const top = parts[0];
  if (PER_NOTE_FOLDERS.has(top)) {
    const name = parts.length === 2 ? parts[1].replace(/\.md$/i, "") : parts[1];
    return { name, file: parts.length === 2 ? file : `${top}/${parts[1]}` };
  }
  return { name: top.replace(/^\d+\s+/, ""), file: top };
}

function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const PRIORITY_COLOR: Record<string, TaskCard["priority"]> = { highest: "red", high: "red", medium: "yellow", low: "green" };

function card(task: ParsedTask, column: string, today: string): TaskCard {
  return {
    id: task.id,
    text: task.text,
    raw_line: task.raw,
    column,
    checked: task.status === "done" || task.status === "cancelled",
    priority: task.priority ? PRIORITY_COLOR[task.priority] : null,
    due: task.due,
    overdue_days: task.due ? daysBetween(task.due, today) : null,
    task_note: task.file,
    blockers: [],
    notes: [],
    completed_date: task.doneDate,
    cancelled: task.status === "cancelled",
    line_no: task.line,
  };
}

// ---------------------------------------------------------------- reading the vault

type FileTasks = { mtime: number; tasks: ParsedTask[] };
const fileCache = new Map<string, Map<string, FileTasks>>();

async function walk(root: string): Promise<{ files: { rel: string; abs: string; mtime: number; size: number }[]; truncated: boolean }> {
  const files: { rel: string; abs: string; mtime: number; size: number }[] = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") || SKIP_PATHS.includes(childRel)) continue;
        stack.push(childRel);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const abs = path.join(root, childRel);
        try {
          const st = await fs.stat(abs);
          files.push({ rel: childRel, abs, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* vanished mid-walk */
        }
        if (files.length >= MAX_FILES) return { files, truncated: true };
      }
    }
  }
  return { files, truncated: false };
}

export async function readVaultTasks(root: string): Promise<ParsedTask[]> {
  const cache = fileCache.get(root) ?? new Map<string, FileTasks>();
  fileCache.set(root, cache);
  const { files } = await walk(root);
  const live = new Set<string>();
  const all: ParsedTask[] = [];
  for (const f of files) {
    live.add(f.rel);
    let hit = cache.get(f.rel);
    if (!hit || hit.mtime !== f.mtime) {
      let tasks: ParsedTask[] = [];
      if (f.size <= MAX_BYTES) {
        try {
          tasks = parseTasks(f.rel, await fs.readFile(f.abs, "utf8"));
        } catch {
          tasks = [];
        }
      }
      hit = { mtime: f.mtime, tasks };
      cache.set(f.rel, hit);
    }
    all.push(...hit.tasks);
  }
  for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
  return all;
}

// ---------------------------------------------------------------- Ops-shaped views

export type TodayIndex = { boards: Board[]; tasks: ParsedTask[]; today: string };

export function buildBoards(tasks: ParsedTask[], today: string, includeDone: boolean, mtimeOf: (file: string) => number = () => 0): Board[] {
  const boards = new Map<string, Board>();
  for (const task of tasks) {
    const column = columnFor(task, today);
    if (column === DONE && !includeDone) continue;
    const key = boardFor(task.file);
    let board = boards.get(key.name);
    if (!board) {
      board = {
        board_name: key.name,
        board_file: key.file,
        ui_label: key.name,
        color: colorFor(key.name),
        columns: Object.fromEntries([...OPEN_COLUMNS, ...(includeDone ? [DONE] : [])].map((c) => [c, { count: 0, cards: [], collapsed: c === DONE } as ColumnData])),
        mtime: 0,
        open_count: 0,
        overdue_count: 0,
        waiting_count: 0,
        in_progress_count: 0,
      };
      boards.set(key.name, board);
    }
    const c = card(task, column, today);
    const col = board.columns[column];
    col.cards.push(c);
    col.count += 1;
    board.mtime = Math.max(board.mtime, mtimeOf(task.file));
    if (column === DONE) continue;
    board.open_count += 1;
    if ((c.overdue_days ?? 0) > 0) board.overdue_count += 1;
    if (column === "Waiting On") board.waiting_count += 1;
    if (column === "In Progress") board.in_progress_count += 1;
  }
  for (const board of boards.values()) {
    for (const col of Object.values(board.columns)) {
      col.cards.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.line_no - b.line_no);
    }
  }
  const order = (b: Board) => (b.board_name === "Inbox" ? 0 : b.board_file.startsWith("10 Projects") ? 1 : b.board_file.startsWith("20 Areas") ? 2 : 3);
  return [...boards.values()].filter((b) => b.open_count > 0 || includeDone).sort((a, b) => order(a) - order(b) || a.ui_label.localeCompare(b.ui_label));
}

function weekday(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
}

/** Rank what to do first: overdue, due today, scheduled, in progress, top priority, due soon. */
export function rankToday(boards: Board[], today: string, limit = 12): TodayItem[] {
  const scored: { score: number; item: TodayItem }[] = [];
  for (const board of boards) {
    for (const name of OPEN_COLUMNS) {
      for (const c of board.columns[name]?.cards ?? []) {
        const ahead = c.due ? daysBetween(today, c.due) : null;
        const task = c;
        let score = 0;
        let when = "";
        let urgency = "normal";
        if (ahead != null && ahead < 0) {
          score = 100 + Math.min(-ahead, 60);
          when = `${-ahead}d overdue`;
          urgency = "hot";
        } else if (ahead === 0) {
          score = 90;
          when = "due today";
          urgency = "soon";
        } else if (name === "In Progress") {
          score = 70;
          when = "in progress";
        } else if (task.priority === "red" && name !== "Waiting On") {
          score = 60;
          when = ahead != null ? (ahead === 1 ? "tomorrow" : weekday(c.due!)) : "top priority";
        } else if (ahead != null && ahead <= 3) {
          score = 50 - ahead;
          when = ahead === 1 ? "tomorrow" : weekday(c.due!);
          urgency = ahead === 1 ? "soon" : "normal";
        }
        if (!score) continue;
        if (name === "Waiting On") {
          score -= 5;
          when = `waiting · ${when}`;
        }
        if (task.priority === "red") score += 3;
        scored.push({
          score,
          item: {
            kind: "task",
            id: c.id,
            text: c.text,
            why: name,
            when_label: when,
            urgency,
            board_name: board.board_name,
            ui_label: board.ui_label,
            color: board.color,
            card: { ...c, board_name: board.board_name, ui_label: board.ui_label, color: board.color, board_file: board.board_file },
          },
        });
      }
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.item.text.localeCompare(b.item.text)).slice(0, limit).map((s) => s.item);
}

export const POLL_SECONDS = 15;

export function meta(root: string, exists: boolean, boards: Board[]): Meta & { source: "vault" } {
  return {
    vault_path: root,
    vault_exists: exists,
    lock_present: false,
    overdue_total: boards.reduce((n, b) => n + b.overdue_count, 0),
    open_total: boards.reduce((n, b) => n + b.open_count, 0),
    board_count: boards.length,
    poll_seconds: POLL_SECONDS,
    generated_at: new Date().toISOString(),
    source: "vault",
  };
}

export const EMPTY_FOCUS: { as_of: null; stale: false; cards: FocusCard[] } = { as_of: null, stale: false, cards: [] };
export const EMPTY_PULSE: Pulse = { ok: true, grand: null, in_mold: null, unstained: null, stained: null, poured: null, last_pour: null, demold_time: null, in_mold_skus: [] };

// ---------------------------------------------------------------- hand-off to Chief

export type LaunchRequest = {
  intent?: string;
  board_name?: string;
  card_id?: string | null;
  user_message?: string;
  due?: string | null;
  blocker?: string | null;
};

/** The chat message a Today action sends to Chief. The agent makes the change; the app never writes. */
export function kickoff(req: LaunchRequest, boards: Board[], today: string): string {
  const board = boards.find((b) => b.board_name === req.board_name);
  if (!board) throw new Error("That area is no longer in your Second Brain.");
  const note = (req.user_message || "").trim();
  const tail = note ? `\n\nMy note: ${note}` : "";
  const where = board.board_file ? `\`${board.board_file}\`` : "my Second Brain";
  if (req.intent === "focus.discuss") return `Let's talk about ${board.ui_label} (${where} in my Second Brain).${tail}`;
  if (req.intent === "area.brief") return `What's outstanding in ${board.ui_label}? Check ${where} in my Second Brain and give me a short brief.${tail}`;
  const c = Object.values(board.columns).flatMap((col) => col.cards).find((x) => x.id === req.card_id);
  if (!c) throw new Error("That task changed since Today last looked. Refresh and try again.");
  const task = `"${c.text}" (\`${c.task_note}\`, line ${c.line_no})`;
  switch (req.intent) {
    case "task.complete":
      return `Please mark this task done in my Second Brain: ${task}. Tick it and add ✅ ${today}.${tail}`;
    case "task.reschedule": {
      const due = /^\d{4}-\d{2}-\d{2}$/.test(req.due || "") ? req.due : null;
      if (!due) throw new Error("Choose a new due date.");
      return `Please move the due date of ${task} to ${due} (📅 ${due}).${tail}`;
    }
    case "task.block": {
      const blocker = (req.blocker || "").trim();
      return `This task is blocked: ${task}.${blocker ? ` Blocker: ${blocker}.` : ""} Tag it #waiting and note the blocker under it.${tail}`;
    }
    case "task.update":
      return `Update on ${task}:${note ? ` ${note}` : " (no details yet — ask me)."}`;
    default:
      return `Let's talk about this task from my Second Brain: ${task}.${tail}`;
  }
}
