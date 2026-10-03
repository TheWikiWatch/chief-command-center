import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

import { durationLabel, isBackgroundReport, parseBackgroundReport, reportIssues, reportTitle } from "@/lib/background-report";
import { chatTone } from "@/lib/chat-tone";

// Made by Hermes's own formatter (tools/process_registry_notifications.py) from synthetic events, so the parser is
// checked against the text Hermes really writes into the chief's conversation.
const samples = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "background-reports.json"), "utf8")) as Record<string, string>;

it("reads a finished batch: each task's goal, outcome, time and findings, without the chief-only lines", () => {
  const r = parseBackgroundReport(samples.batch);
  expect(r?.kind).toBe("tasks");
  if (r?.kind !== "tasks") return;
  expect(r.seconds).toBe(340.2);
  expect(r.tasks.map((t) => [t.goal, t.status, t.ok, t.truncated, t.seconds])).toEqual([
    ["Compare the three cheapest flights to Lisbon", "completed", true, false, 201.5],
    ["Shortlist hotels near Alfama", "completed", false, true, 180],
    ["What is on at the Gulbenkian", "error", false, false, 40],
  ]);
  expect(r.tasks[0].body).toBe("## Flights\n- TAP, 212 EUR, direct\n- Ryanair, 98 EUR, one stop");
  expect(r.tasks[0].body).not.toContain("transcript");
  expect(r.tasks[1].body).toContain("Memmo Alfama");
  expect(r.tasks[1].body).not.toContain("TRUNCATED");
  expect(r.tasks[2].body).toContain("rate limited");
  expect(r.ok).toBe(false);
  expect(reportTitle(r)).toBe("3 background tasks");
  expect(reportIssues(r)).toBe(2);
});

it("reads one finished task, an early task failure and background commands", () => {
  const single = parseBackgroundReport(samples.single);
  expect(single?.kind === "tasks" && [single.tasks[0].goal, single.tasks[0].ok, single.tasks[0].body]).toEqual(["Summarise the findings", true, "All three lanes agree: go in the second week."]);
  expect(reportTitle(single!)).toBe("Background task finished: Summarise the findings");

  const failed = parseBackgroundReport(samples.failed);
  expect(failed?.kind === "taskFailed" && [failed.index, failed.of, failed.task.goal, failed.task.body]).toEqual([3, 4, "Lane C", "model refused the request"]);
  expect(reportTitle(failed!)).toBe("A background task failed (3 of 4): Lane C");

  const two = parseBackgroundReport(samples.two_commands);
  expect(two?.kind === "commands" && two.commands.map((c) => [c.command, c.ok, c.exitCode, c.output])).toEqual([
    ["npm run build", true, "0", "built in 4.2s"],
    ["pytest -q", false, "1", "2 failed, 40 passed"],
  ]);
  expect(reportTitle(two!)).toBe("2 background commands");
  expect(reportIssues(two!)).toBe(1);
  expect(reportTitle(parseBackgroundReport(samples.command_ok)!)).toBe("Background command finished: npm run build");

  const watch = parseBackgroundReport(samples.watch);
  expect(watch?.kind).toBe("note");
});

it("is a background note in the chat only when Hermes wrote it, never the owner's own words", () => {
  for (const text of Object.values(samples)) {
    expect(isBackgroundReport(text)).toBe(true);
    expect(chatTone({ id: 1, role: "user", content: text, timestamp: "" })).toBe("background");
  }
  expect(chatTone({ id: 2, role: "user", content: "[IMPORTANT] remember the milk", timestamp: "" })).toBe("reply");
  expect(chatTone({ id: 3, role: "assistant", content: samples.batch, timestamp: "" })).toBe("reply"); // the chief quoting it
  expect(parseBackgroundReport("hello")).toBeNull();
});

it("labels durations plainly", () => {
  expect([durationLabel(45), durationLabel(340.2), durationLabel(3720), durationLabel(null)]).toEqual(["45s", "5m 40s", "1h 2m", ""]);
});
