import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { boardFor, buildBoards, columnFor, forgetRecentWalks, kickoff, parseTasks, rankToday, readVaultTasks } from "@/lib/server/today-index";

const TODAY = "2026-10-01";

describe("parseTasks", () => {
  it("reads status, dates, priority and #waiting, and cleans the text", () => {
    const tasks = parseTasks(
      "10 Projects/Garden.md",
      [
        "- [ ] Call the plumber ⏫ 📅 2026-10-02",
        "  - [/] Draft the budget 🔼 ⏳ 2026-09-30",
        "- [x] Book flights ✅ 2026-09-30",
        "- [-] Old idea",
        "* [ ] Waiting on Sam's quote #waiting",
        "- [ ] Water plants 🔁 every week 📅 2026-10-05 🔺",
        "- plain bullet",
        "```",
        "- [ ] not a task inside code",
        "```",
      ].join("\n"),
    );
    expect(tasks.map((t) => [t.text, t.status])).toEqual([
      ["Call the plumber", "open"],
      ["Draft the budget", "progress"],
      ["Book flights", "done"],
      ["Old idea", "cancelled"],
      ["Waiting on Sam's quote", "open"],
      ["Water plants", "open"],
    ]);
    expect(tasks[0]).toMatchObject({ due: "2026-10-02", priority: "high", line: 1 });
    expect(tasks[1]).toMatchObject({ scheduled: "2026-09-30", priority: "medium" });
    expect(tasks[2].doneDate).toBe("2026-09-30");
    expect(tasks[4].waiting).toBe(true);
    expect(tasks[5]).toMatchObject({ due: "2026-10-05", priority: "highest" });
  });

  it("gives identical lines distinct, stable ids", () => {
    const a = parseTasks("Inbox.md", "- [ ] Same\n- [ ] Same");
    const b = parseTasks("Inbox.md", "\n\n- [ ] Same\n- [ ] Same");
    expect(a[0].id).not.toBe(a[1].id);
    expect(b.map((t) => t.id)).toEqual(a.map((t) => t.id));
  });
});

describe("columns and boards", () => {
  const t = (line: string, file = "10 Projects/Garden.md") => parseTasks(file, line)[0];
  it("sorts tasks into the Today columns", () => {
    expect(columnFor(t("- [ ] Overdue 📅 2026-09-20"), TODAY)).toBe("This Week");
    expect(columnFor(t("- [ ] Soon 📅 2026-10-08"), TODAY)).toBe("This Week");
    expect(columnFor(t("- [ ] Later 📅 2026-10-12"), TODAY)).toBe("Next Week");
    expect(columnFor(t("- [ ] Someday"), TODAY)).toBe("Backlog");
    expect(columnFor(t("- [ ] Urgent ⏫"), TODAY)).toBe("This Week");
    expect(columnFor(t("- [/] Doing"), TODAY)).toBe("In Progress");
    expect(columnFor(t("- [ ] Chase #waiting 📅 2026-09-01"), TODAY)).toBe("Waiting On");
    expect(columnFor(t("- [x] Done"), TODAY)).toBe("Done");
  });

  it("groups by project or area note, otherwise by top folder", () => {
    expect(boardFor("10 Projects/Garden.md")).toEqual({ name: "Garden", file: "10 Projects/Garden.md" });
    expect(boardFor("10 Projects/House move/Boxes.md")).toEqual({ name: "House move", file: "10 Projects/House move" });
    expect(boardFor("00 Inbox/Welcome.md")).toEqual({ name: "Inbox", file: "00 Inbox" });
    expect(boardFor("Journal/Daily/2026-10-01.md")).toEqual({ name: "Journal", file: "Journal" });
    expect(boardFor("Loose.md")).toEqual({ name: "Notes", file: "" });
  });

  it("counts open, overdue, waiting and in-progress per board and ranks Today", () => {
    const tasks = [
      ...parseTasks("10 Projects/Garden.md", "- [ ] Buy seeds 📅 2026-09-28\n- [ ] Plan beds 📅 2026-10-01\n- [/] Dig\n- [ ] Ask Sam #waiting\n- [x] Old ✅ 2026-09-01"),
      ...parseTasks("00 Inbox/Note.md", "- [ ] Someday idea\n- [ ] Call bank 📅 2026-10-02"),
    ];
    const boards = buildBoards(tasks, TODAY, false);
    expect(boards.map((b) => b.board_name)).toEqual(["Inbox", "Garden"]);
    const garden = boards[1];
    expect([garden.open_count, garden.overdue_count, garden.waiting_count, garden.in_progress_count]).toEqual([4, 1, 1, 1]);
    expect(garden.columns.Done).toBeUndefined();
    expect(buildBoards(tasks, TODAY, true)[1].columns.Done.count).toBe(1);

    const ranked = rankToday(boards, TODAY);
    expect(ranked.map((i) => [i.text, i.when_label])).toEqual([
      ["Buy seeds", "3d overdue"],
      ["Plan beds", "due today"],
      ["Dig", "in progress"],
      ["Call bank", "tomorrow"],
    ]);
    expect(ranked[0].urgency).toBe("hot");
    expect(ranked[0].card?.board_file).toBe("10 Projects/Garden.md");
  });
});

describe("kickoff", () => {
  const boards = buildBoards(parseTasks("10 Projects/Garden.md", "- [ ] Buy seeds 📅 2026-09-28"), TODAY, false);
  const id = boards[0].columns["This Week"].cards[0].id;
  it("tells Chief exactly which line to change", () => {
    expect(kickoff({ intent: "task.complete", board_name: "Garden", card_id: id }, boards, TODAY)).toBe(
      'Please mark this task done in my Second Brain: "Buy seeds" (`10 Projects/Garden.md`, line 1). Tick it and add ✅ 2026-10-01.',
    );
    expect(kickoff({ intent: "task.reschedule", board_name: "Garden", card_id: id, due: "2026-10-09" }, boards, TODAY)).toContain("to 2026-10-09 (📅 2026-10-09)");
    expect(kickoff({ intent: "task.discuss", board_name: "Garden", card_id: id, user_message: "Which shop?" }, boards, TODAY)).toMatch(/My note: Which shop\?$/);
    expect(kickoff({ intent: "area.brief", board_name: "Garden" }, boards, TODAY)).toContain("What's outstanding in Garden?");
  });
  it("refuses stale or incomplete requests", () => {
    expect(() => kickoff({ intent: "task.complete", board_name: "Garden", card_id: "gone" }, boards, TODAY)).toThrow(/changed/);
    expect(() => kickoff({ intent: "task.reschedule", board_name: "Garden", card_id: id, due: "soon" }, boards, TODAY)).toThrow(/due date/);
    expect(() => kickoff({ intent: "focus.discuss", board_name: "Nope" }, boards, TODAY)).toThrow(/no longer/);
  });
});

describe("readVaultTasks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chief-today-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };

  it("reads notes, skips templates, archive, raw sources and hidden folders, and follows edits", async () => {
    put("10 Projects/Garden.md", "- [ ] Buy seeds");
    put("Templates/Project.md", "- [ ] Template task");
    put("90 Archive/Old.md", "- [ ] Archived task");
    put("40 Knowledge/raw/articles/a.md", "- [ ] Quoted task");
    put("40 Knowledge/concepts/x.md", "- [ ] Knowledge task");
    put(".obsidian/x.md", "- [ ] Hidden");
    put("notes.txt", "- [ ] Not markdown");
    const first = await readVaultTasks(root);
    expect(first.map((t) => t.text).sort()).toEqual(["Buy seeds", "Knowledge task"]);

    put("10 Projects/Garden.md", "- [ ] Buy seeds\n- [ ] Plant them");
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(root, "10 Projects/Garden.md"), later, later);
    rmSync(path.join(root, "40 Knowledge/concepts/x.md"));
    // Requests within 2 seconds share one walk (Today asks for several views at once).
    expect(await readVaultTasks(root)).toBe(await readVaultTasks(root));
    forgetRecentWalks();
    expect((await readVaultTasks(root)).map((t) => t.text).sort()).toEqual(["Buy seeds", "Plant them"]);
  });
});
