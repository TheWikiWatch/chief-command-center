import { requestJson } from "@/lib/request";

export type Priority = "red" | "yellow" | "green" | null;

export type Intent =
  | "task.discuss"
  | "task.complete"
  | "task.block"
  | "task.reschedule"
  | "task.update"
  | "focus.discuss"
  | "area.brief";

export type TaskCard = {
  id: string;
  text: string;
  raw_line: string;
  column: string;
  checked: boolean;
  priority: Priority | string | null;
  due: string | null;
  overdue_days: number | null;
  task_note: string | null;
  blockers: string[];
  notes: string[];
  completed_date: string | null;
  cancelled: boolean;
  line_no: number;
  /** A card on a Kanban board (built-in Today); its board is `board_file`, its task note `task_note`. */
  kind?: "checkbox" | "card";
  board_file?: string;
};

export type ColumnData = {
  count: number;
  cards: TaskCard[];
  collapsed: boolean;
};

export type Board = {
  board_name: string;
  board_file: string;
  ui_label: string;
  color: string;
  columns: Record<string, ColumnData>;
  mtime: number;
  open_count: number;
  overdue_count: number;
  waiting_count: number;
  in_progress_count: number;
};

export type FocusCard = {
  board_name: string;
  board_file: string;
  ui_label: string;
  color: string;
  pressure: string;
  detail: string;
  trajectory: string;
  next_human: string;
  next_agent: string;
  blockers: string[];
  open_count: number;
  overdue_count: number;
  waiting_count: number;
  in_progress_count: number;
  confidence: string;
};

export type Meta = {
  vault_path: string;
  vault_exists: boolean;
  lock_present: boolean;
  overdue_total: number;
  open_total: number;
  board_count: number;
  poll_seconds: number;
  generated_at: string;
};

export type Pulse = {
  ok: boolean;
  grand: number | null;
  in_mold: number | null;
  unstained: number | null;
  stained: number | null;
  poured: number | null;
  last_pour: { date: string; time: string | null; summary: string } | null;
  demold_time: string | null;
  in_mold_skus: string[];
};

export type TodayItem = {
  kind: "task" | "pulse";
  id: string;
  text: string;
  why: string;
  when_label: string;
  urgency: string;
  board_name: string;
  ui_label: string;
  color: string;
  card?: TaskCard & { board_name: string; ui_label: string; color: string; board_file: string };
};

export type OpsSettings = {
  vault_path: string;
  hermes_cmd: string;
  poll_seconds: number;
  vault_exists: boolean;
};

export type LaunchTarget = {
  kind: "task" | "focus" | "pulse";
  board_name: string;
  ui_label: string;
  color: string;
  title: string;
  kicker: string;
  card?: TaskCard;
};

const PREFIX = "/api/ops";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(`${PREFIX}${path}`, { cache: "no-store", signal });
}

export async function fetchOpsHealth(signal?: AbortSignal): Promise<{ ok: boolean }> {
  const data = await requestJson<{ ok: boolean }>(`${PREFIX}/health`, { cache: "no-store", signal }, 4000);
  if (!data.ok) throw new Error("Ops API is unavailable");
  return data;
}

export const ops = {
  meta: (signal?: AbortSignal) => getJson<Meta>("/meta", signal),
  boards: (includeDone = false, signal?: AbortSignal) =>
    getJson<{ boards: Board[]; errors: string[] }>(`/boards?include_done=${includeDone}`, signal),
  focus: (signal?: AbortSignal) => getJson<{ as_of: string | null; stale: boolean; cards: FocusCard[] }>("/focus", signal),
  today: (signal?: AbortSignal) => getJson<{ date: string; items: TodayItem[]; due_today_count: number }>("/today", signal),
  pulse: (signal?: AbortSignal) => getJson<Pulse>("/pulse", signal),
  attention: () =>
    getJson<{
      overdue: Array<TaskCard & { board_name: string; ui_label: string; color: string }>;
      waiting: Array<TaskCard & { board_name: string; ui_label: string; color: string }>;
    }>("/attention"),
  settings: () => getJson<OpsSettings>("/settings"),
  // The proxy forwards vault_path only (app/api/ops/[...path]/route.ts).
  saveSettings: async (body: Pick<OpsSettings, "vault_path">) => {
    return requestJson<OpsSettings>(`${PREFIX}/settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  },
  launch: async (body: {
    intent: Intent;
    board_name: string;
    card_id?: string | null;
    user_message?: string;
    due?: string | null;
    blocker?: string | null;
    mode: "chief_inject";
  }) => {
    const data = await requestJson<{ ok?: boolean; kickoff?: string; launch_id?: string; error?: string }>(`${PREFIX}/launch`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, 17_000);
    if (data.ok === false) throw new Error(data.error || "Could not prepare task");
    return data;
  },
};
