import { promises as fs } from "node:fs";

import {
  EMPTY_FOCUS,
  EMPTY_PULSE,
  POLL_SECONDS,
  buildBoards,
  isoDay,
  kickoff,
  meta,
  rankToday,
  readVaultTasks,
  type LaunchRequest,
} from "@/lib/server/today-index";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function exists(root: string): Promise<boolean> {
  try {
    return (await fs.stat(root)).isDirectory();
  } catch {
    return false;
  }
}

/** The Ops API's Today endpoints, answered from the Second Brain (lib/server/today-index.ts). Read-only. */
export async function vaultToday(req: Request, path: string[], root: string): Promise<Response> {
  const op = path[0];
  if (op === "health") return json({ ok: true, source: "vault" });
  const here = await exists(root);
  const today = isoDay(new Date());
  if (op === "settings") {
    if (req.method !== "GET") return json({ ok: false, error: "Change the Second Brain folder in Settings." }, 400);
    return json({ vault_path: root, hermes_cmd: "", poll_seconds: POLL_SECONDS, vault_exists: here });
  }
  if (op === "focus") return json(EMPTY_FOCUS);
  if (op === "pulse") return json(EMPTY_PULSE);
  const tasks = here ? await readVaultTasks(root) : [];
  const includeDone = new URL(req.url).searchParams.get("include_done") === "true";
  const boards = buildBoards(tasks, today, includeDone && op === "boards");
  switch (op) {
    case "meta":
      return json(meta(root, here, buildBoards(tasks, today, false)));
    case "boards":
      return json({ boards, errors: [] });
    case "today": {
      const items = rankToday(boards, today);
      return json({ date: today, items, due_today_count: items.filter((i) => i.when_label === "due today").length });
    }
    case "attention": {
      const flat = boards.flatMap((b) =>
        Object.values(b.columns).flatMap((col) => col.cards.map((c) => ({ ...c, board_name: b.board_name, ui_label: b.ui_label, color: b.color }))),
      );
      return json({ overdue: flat.filter((c) => !c.checked && (c.overdue_days ?? 0) > 0), waiting: flat.filter((c) => !c.checked && c.column === "Waiting On") });
    }
    case "launch": {
      if (req.method !== "POST") return json({ ok: false, error: "Unsupported operation" }, 404);
      const body = (await req.json().catch(() => ({}))) as LaunchRequest;
      try {
        return json({ ok: true, kickoff: kickoff(body, boards, today) });
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : "Could not prepare that." }, 409);
      }
    }
    default:
      return json({ ok: false, error: "Unsupported operation" }, 404);
  }
}
