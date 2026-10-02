import { describe, expect, it } from "vitest";

import { sideLists } from "@/components/today/side-column";
import type { Board, TaskCard } from "@/lib/ops";

const card = (id: string, column: string, due: string | null, extra: Partial<TaskCard> = {}): TaskCard => ({
  id, text: `Task ${id}`, raw_line: "", column, checked: false, priority: null, due, overdue_days: null, task_note: null,
  blockers: [], notes: [], completed_date: null, cancelled: false, line_no: 1, ...extra,
});

const board = (cards: TaskCard[]): Board => {
  const columns: Board["columns"] = {};
  for (const c of cards) (columns[c.column] ??= { count: 0, cards: [], collapsed: false }).cards.push(c);
  return { board_name: "home", board_file: "home.md", ui_label: "Home", color: "#888", columns, mtime: 0, open_count: cards.length, overdue_count: 0, waiting_count: 0, in_progress_count: 0 };
};

describe("Today's side column", () => {
  const now = new Date(2026, 9, 2); // 2 Oct 2026
  const b = board([
    card("w1", "Waiting On", null),
    card("w2", "Waiting On", "2026-10-03", { checked: true }),
    card("d1", "To Do", "2026-10-06"),
    card("d2", "To Do", "2026-10-02"),
    card("late", "To Do", "2026-09-30"),
    card("far", "To Do", "2026-10-20"),
    card("ranked", "To Do", "2026-10-04"),
  ]);

  it("lists open waiting cards, and this week's due cards soonest first, minus the ranked ones", () => {
    const { waiting, week } = sideLists([b], new Set(["ranked"]), now);
    expect(waiting.map((r) => r.card.id)).toEqual(["w1"]);
    expect(week.map((r) => r.card.id)).toEqual(["d2", "d1"]);
  });
});
