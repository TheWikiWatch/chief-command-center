import { expect, it } from "vitest";

import type { Board, TaskCard, TodayItem } from "@/lib/ops";
import { STALE_DAYS, sectionToday, staleMessage } from "@/lib/today-sections";

let n = 0;
const card = (text: string, extra: Partial<TaskCard> = {}): TaskCard => ({
  id: `c${++n}`, text, raw_line: `- [ ] ${text}`, column: "This Week", checked: false, priority: null, due: null, overdue_days: null,
  task_note: null, blockers: [], notes: [], completed_date: null, cancelled: false, line_no: n, ...extra,
});
/** A card due `ahead` days from today (negative: overdue), as the server computes overdue_days. */
const due = (text: string, ahead: number, extra: Partial<TaskCard> = {}) => card(text, { due: `2026-10-${String(12 + ahead).padStart(2, "0")}`, overdue_days: -ahead, ...extra });
const board = (name: string, columns: Record<string, TaskCard[]>): Board => ({
  board_name: name, board_file: `boards/${name}.md`, ui_label: name, color: "#6aa9ff", mtime: 0, open_count: 0, overdue_count: 0, waiting_count: 0, in_progress_count: 0,
  columns: Object.fromEntries(Object.entries(columns).map(([c, cards]) => [c, { count: cards.length, cards, collapsed: false }])),
});

it("puts everything due today in Today however many old overdue cards there are", () => {
  // The real case: 16 overdue cards outranked two due today, and Today showed only the top 12.
  const old = Array.from({ length: 16 }, (_, i) => due(`Old task ${i + 1}`, -(10 + i * 4)));
  const s = sectionToday([
    board("Work", { "This Week": [due("Pack the stand for Saturday", 0, { priority: "red" }), due("Confirm the venue booking", 0, { priority: "red" })] }),
    board("Side project", { "This Week": old }),
  ]);
  expect(s.today.map((i) => i.text)).toEqual(["Confirm the venue booking", "Pack the stand for Saturday"]);
  expect(s.today.every((i) => i.when_label === "due today")).toBe(true);
  expect(s.overdue.length + s.stale.length).toBe(16);
  expect(s.overdue.every((i) => (i.card?.overdue_days ?? 0) <= STALE_DAYS)).toBe(true);
  expect(s.stale.every((i) => (i.card?.overdue_days ?? 0) > STALE_DAYS)).toBe(true);
});

it("orders each section: due before in progress, newest overdue first, soonest coming up first", () => {
  const s = sectionToday([
    board("A", {
      "In Progress": [card("Drafting the flyer")],
      "This Week": [due("Due today", 0), due("Late 9", -9), due("Late 2", -2), due("Friday", 3), due("Tomorrow", 1), card("Top, no date", { priority: "red" }), card("Plain, no date")],
      "Waiting On": [due("Waiting late", -4)],
      "Next Week": [card("Top next week", { priority: "red" })],
      Backlog: [due("Far off", 20), due("Ancient", -40), card("Parked top", { priority: "red" })],
    }),
  ]);
  expect(s.today.map((i) => i.text)).toEqual(["Due today", "Drafting the flyer"]);
  expect(s.overdue.map((i) => i.text)).toEqual(["Late 2", "Waiting late", "Late 9"]);
  expect(s.overdue[1].when_label).toBe("waiting · 4d overdue");
  expect(s.soon.map((i) => i.text)).toEqual(["Tomorrow", "Friday", "Top next week", "Top, no date"]);
  expect(s.stale.map((i) => i.text)).toEqual(["Ancient"]);
  // Undated, ordinary cards and far-off ones stay on their boards (the Areas and the side column).
  expect([...s.today, ...s.overdue, ...s.soon, ...s.stale].map((i) => i.text)).not.toContain("Plain, no date");
  expect(s.soon.map((i) => i.text)).not.toContain("Far off");
  expect(s.soon.map((i) => i.text)).not.toContain("Parked top"); // Backlog is parked on purpose
});

it("skips done cards, and keeps a task service's own pulse items at the top of Today", () => {
  const pulse: TodayItem = { kind: "pulse", id: "p1", text: "3 orders to ship", why: "", when_label: "", urgency: "normal", board_name: "Shop", ui_label: "Shop", color: "#fff" };
  const s = sectionToday([board("A", { "This Week": [due("Finished", 0, { checked: true }), due("Open", 0)] })], [pulse]);
  expect(s.today.map((i) => i.text)).toEqual(["3 orders to ship", "Open"]);
});

it("asks the chief for suggestions on the stale pile, never to change boards on its own", () => {
  const s = sectionToday([board("Side project", { "This Week": [due("Domain check", -72)] })]);
  const msg = staleMessage(s.stale);
  expect(msg).toContain("- Domain check (Side project, 72d overdue)");
  expect(msg).toContain("Wait for my OK before you change any board.");
});
