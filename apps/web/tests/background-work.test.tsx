import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { BackgroundWork, backgroundTaskCount, elapsedLabel } from "@/components/chat/background-work";
import type { BackgroundUnit } from "@/lib/types";

const now = Date.now() / 1000;
const units: BackgroundUnit[] = [
  { id: "d1", status: "running", since: now - 187, tasks: [{ goal: "Research lane 1", step: "Searching the web" }, { goal: "Research lane 2", step: "Reading a web page" }] },
  { id: "d2", status: "stalling", since: now - 40, tasks: [{ goal: "Research lane 3", step: "Quiet for a while" }] },
];

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("says how many tasks run in the background and for how long, and opens to each goal and step", () => {
  render(<BackgroundWork units={units} assistant="Chief" />);
  const toggle = screen.getByRole("button", { name: /3 tasks in the background/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText(/^3:0\d$/)).toBeTruthy(); // since the oldest task started
  expect(screen.queryByText("Research lane 1")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  for (const text of ["Research lane 1", "Searching the web", "Research lane 2", "Reading a web page", "Research lane 3", "Quiet for a while"]) expect(screen.getByText(text)).toBeTruthy();
  expect(localStorage.getItem("chief.backgroundWork.open")).toBe("1"); // remembered for next time
});

it("shows nothing when no work is running", () => {
  const { container } = render(<BackgroundWork units={[]} assistant="Chief" />);
  expect(container.innerHTML).toBe("");
});

it("counts tasks across units and labels the time plainly", () => {
  expect(backgroundTaskCount(units)).toBe(3);
  expect([elapsedLabel(7), elapsedLabel(187), elapsedLabel(3725)]).toEqual(["0:07", "3:07", "1:02:05"]);
});
