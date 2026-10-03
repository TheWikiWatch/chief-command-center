import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { BackgroundReportCard } from "@/components/chat/background-report-card";

const samples = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "background-reports.json"), "utf8")) as Record<string, string>;

afterEach(cleanup);

it("is one collapsed line that opens to a row per task, and each row to its findings", () => {
  render(<BackgroundReportCard text={samples.batch} />);
  const line = screen.getByRole("button", { name: /3 background tasks/ });
  expect(line.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("2 issues")).toBeTruthy();
  expect(screen.queryByText("5m 40s")).toBeNull(); // with issues the tag takes the room; each task keeps its own time
  expect(screen.queryByText(/ASYNC DELEGATION/)).toBeNull(); // the chief's instructions never show
  fireEvent.click(line);
  const flights = screen.getByRole("button", { name: /Compare the three cheapest flights to Lisbon/ });
  expect(screen.getByText("Stopped early: the findings may be incomplete")).toBeTruthy();
  expect(screen.getByText("Didn't finish (error)")).toBeTruthy();
  expect(screen.queryByText(/TAP, 212 EUR/)).toBeNull();
  fireEvent.click(flights);
  expect(screen.getByText(/TAP, 212 EUR/)).toBeTruthy();
  expect(screen.queryByText(/task-0\.jsonl/)).toBeNull(); // transcript paths are for the chief
});

it("shows background commands with their output, and a plain note without opening", () => {
  render(<BackgroundReportCard text={samples.two_commands} />);
  fireEvent.click(screen.getByRole("button", { name: /2 background commands/ }));
  fireEvent.click(screen.getByRole("button", { name: /pytest -q/ }));
  expect(screen.getByText("2 failed, 40 passed")).toBeTruthy();
  expect(screen.getByText("exit 1")).toBeTruthy();
  cleanup();
  render(<BackgroundReportCard text={samples.watch} />);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
});
