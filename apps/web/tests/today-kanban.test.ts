import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildBoards, columnOf, isKanbanBoard, kickoff, meta, parseBoard, rankToday, readVaultTasks } from "@/lib/server/today-index";

const TODAY = "2026-10-01";

// A board as Obsidian's Kanban plugin writes it (and the agent-first wiki template ships it).
const HOME = [
  "---",
  "",
  "kanban-plugin: board",
  "",
  "---",
  "",
  "## 📥 Backlog",
  "",
  "- [ ] Fix the gate 🔴 @{2026-09-20} [[wiki/tasks/Fix the gate.md]]",
  "    - Hinge is rusted",
  "\t- Waiting on the welder's quote",
  "- [ ] [[wiki/tasks/Paint the shed]]",
  "",
  "## 📋 This Week",
  "",
  "- [ ] **Call the vet** 🟡 @{2026-10-01}",
  "- [ ] Order mulch 🟢 @{2026-10-04}",
  "",
  "## 🔨 In Progress",
  "",
  "- [ ] Sort the garage",
  "",
  "## ⏳ Waiting On",
  "",
  "- [ ] Plumber's quote 🟡 @{2026-09-25}",
  "",
  "## 📅 Next Week",
  "",
  "",
  "## ✅ Done",
  "",
  "- [x] ~~Book flights~~ 🟢 ✅ 2026-09-30",
  "- [ ] ~~Old idea~~ ❌ cancelled 2026-09-12",
  "",
  "%% kanban:settings",
  "```",
  '{"kanban-plugin":"board"}',
  "```",
  "%%",
  "- [ ] not a card (after the settings block)",
].join("\n");

describe("Kanban boards", () => {
  it("recognizes a board only by its properties", () => {
    expect(isKanbanBoard(HOME)).toBe(true);
    expect(isKanbanBoard("﻿---\r\nkanban-plugin: basic\r\n---\r\n\r\n## Todo\r\n")).toBe(true);
    expect(isKanbanBoard("---\ntype: note\n---\n\nSome text\n\n---\n\nkanban-plugin: board\n")).toBe(false);
    expect(isKanbanBoard("# Plain note\n- [ ] task")).toBe(false);
  });

  it("maps column headings, emoji and all", () => {
    expect(["## 📥 Backlog", "## 📋 This Week", "## 🔨 In Progress", "## ⏳ Waiting On", "## 📅 Next Week", "## ✅ Done"].map(columnOf)).toEqual([
      "Backlog",
      "This Week",
      "In Progress",
      "Waiting On",
      "Next Week",
      "Done",
    ]);
    expect(["## 🏃 Sprint", "## Blocked", "## ✅ Published", "## 💡 Ideas"].map(columnOf)).toEqual(["This Week", "Waiting On", "Done", "Backlog"]);
  });

  it("reads cards: column, due, priority, task note, notes and blockers; stops at the settings block", () => {
    const cards = parseBoard("boards/Home.md", HOME);
    expect(cards.map((c) => [c.text, c.card?.column, c.status])).toEqual([
      ["Fix the gate", "Backlog", "open"],
      ["Paint the shed", "Backlog", "open"],
      ["Call the vet", "This Week", "open"],
      ["Order mulch", "This Week", "open"],
      ["Sort the garage", "In Progress", "progress"],
      ["Plumber's quote", "Waiting On", "open"],
      ["Book flights", "Done", "done"],
      ["Old idea", "Done", "cancelled"],
    ]);
    const gate = cards[0];
    expect([gate.due, gate.card?.color, gate.card?.taskNote, gate.line]).toEqual(["2026-09-20", "red", "wiki/tasks/Fix the gate.md", 9]);
    expect(gate.card?.notes).toEqual(["Hinge is rusted"]);
    expect(gate.card?.blockers).toEqual(["Waiting on the welder's quote"]);
    expect(cards[1].card?.taskNote).toBe("wiki/tasks/Paint the shed.md");
    expect(cards[6].doneDate).toBe("2026-09-30");
  });

  it("builds one board per file with the board's own columns and true counts", () => {
    const boards = buildBoards(parseBoard("boards/Home.md", HOME), TODAY, false);
    expect(boards).toHaveLength(1);
    const b = boards[0];
    expect([b.board_name, b.board_file, b.open_count, b.overdue_count, b.waiting_count, b.in_progress_count]).toEqual(["Home", "boards/Home.md", 6, 2, 1, 1]);
    expect(b.columns["This Week"].cards.map((c) => c.text)).toEqual(["Call the vet", "Order mulch"]);
    const gate = b.columns.Backlog.cards.find((c) => c.text === "Fix the gate")!;
    expect([gate.priority, gate.overdue_days, gate.task_note, gate.kind, gate.board_file]).toEqual(["red", 11, "wiki/tasks/Fix the gate.md", "card", "boards/Home.md"]);
    expect(meta("/v", true, boards)).toMatchObject({ open_total: 6, overdue_total: 2, board_count: 1 });
    const today = rankToday(boards, TODAY).map((i) => [i.text, i.when_label]);
    expect(today.slice(0, 3)).toEqual([
      ["Fix the gate", "11d overdue"],
      ["Plumber's quote", "waiting · 6d overdue"],
      ["Call the vet", "due today"],
    ]);
    const withDone = buildBoards(parseBoard("boards/Home.md", HOME), TODAY, true)[0];
    expect(withDone.columns.Done.cards.map((c) => c.text)).toEqual(["Book flights", "Old idea"]);
  });

  it("hands a card to Chief with its board and task note, changed together", () => {
    const boards = buildBoards(parseBoard("boards/Home.md", HOME), TODAY, false);
    const gate = boards[0].columns.Backlog.cards[0];
    const done = kickoff({ intent: "task.complete", board_name: "Home", card_id: gate.id }, boards, TODAY);
    expect(done).toContain("board `boards/Home.md`, line 9; task note `wiki/tasks/Fix the gate.md`");
    expect(done).toContain("✅ 2026-10-01");
    expect(done).toContain("✅ Done");
    const moved = kickoff({ intent: "task.reschedule", board_name: "Home", card_id: gate.id, due: "2026-10-08" }, boards, TODAY);
    expect(moved).toContain("@{2026-10-08} on the board, and `due: 2026-10-08` in its task note");
    const blocked = kickoff({ intent: "task.block", board_name: "Home", card_id: gate.id, blocker: "the welder" }, boards, TODAY);
    expect(blocked).toContain("⏳ Waiting On");
  });
});

describe("task sources", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chief-kanban-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  put("boards/Home.md", HOME);
  put("wiki/daily/2026-10-01.md", "- [ ] a checkbox in a daily note 📅 2026-10-01\n");
  put("raw/conversations/2026-09-01 - Chat.md", "- [ ] a checkbox in a source\n");
  put("drop/inbox.md", "- [ ] waiting to be filed\n");
  put("10 Projects/Garden.md", "- [ ] Plant bulbs 📅 2026-10-03\n");

  it("the agent-first wiki reads boards only", async () => {
    const tasks = await readVaultTasks(root, "boards");
    expect(new Set(tasks.map((t) => t.file))).toEqual(new Set(["boards/Home.md"]));
  });

  it("Organized reads checkboxes and boards, never sources or the drop folder", async () => {
    const files = new Set((await readVaultTasks(root, "all")).map((t) => t.file));
    expect(files).toEqual(new Set(["boards/Home.md", "wiki/daily/2026-10-01.md", "10 Projects/Garden.md"]));
  });
});
