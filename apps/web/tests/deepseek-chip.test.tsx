import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DeepseekChip, DeepseekSchedule } from "@/components/deepseek-chip";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "match" })));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows nothing in the header while it's off-peak", () => {
  vi.setSystemTime(new Date("2026-10-10T08:00:00Z")); // a Saturday
  render(<DeepseekChip />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("shows peak as a short pill that opens the week's peak hours", async () => {
  vi.setSystemTime(new Date("2026-10-12T02:00:00Z")); // Monday 01:00-04:00 UTC window
  render(<DeepseekChip />);
  const chip = screen.getByRole("button", { name: /Peak pricing: DeepSeek charges twice/ });
  expect(chip).toHaveTextContent("Peak 2×"); // the narrow-header label; "Peak · 2× until …" is shown when there's room
  expect(chip).toHaveTextContent("Peak · 2× until");
  fireEvent.click(chip);
  expect(await screen.findByText("Peak: twice the price")).toBeInTheDocument();
  expect(screen.getByText(/Peak hours, next 7 days/)).toBeInTheDocument();
});

it("leaves the header when the peak ends, without waiting for a poll", async () => {
  vi.setSystemTime(new Date("2026-10-12T03:59:30Z"));
  render(<DeepseekChip />);
  expect(screen.getByRole("button")).toBeInTheDocument();
  await act(async () => {
    vi.advanceTimersByTime(31_000); // past 04:00 UTC: the timer set for the flip fires
  });
  expect(screen.queryByRole("button")).toBeNull();
});

it("the status sheet always says the state and why", () => {
  vi.setSystemTime(new Date("2026-10-07T02:00:00Z")); // Golden Week
  render(<DeepseekSchedule />);
  expect(screen.getByText("Off-peak: half price")).toBeInTheDocument();
  expect(screen.getByText(/Chinese public holiday: National Day/)).toBeInTheDocument();
});
