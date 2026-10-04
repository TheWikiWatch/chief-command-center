import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { StatusSheet } from "@/components/connection-status";
import { noteRoundTrip, rateLink, resetLinkQualityForTests, useLinkQuality } from "@/lib/link-quality";

// A tester's phone was "very up and down" while the PC app was fine: the status sheet now says how quickly this
// window reaches the PC, so a slow (relayed) Tailscale link shows as the cause.

afterEach(() => {
  cleanup();
  resetLinkQualityForTests();
});

function Probe() {
  const q = useLinkQuality();
  return <span data-testid="ms">{q.ms ?? "none"}</span>;
}

it("keeps the median of the last few round trips, so one slow check doesn't swing it", () => {
  render(<Probe />);
  expect(screen.getByTestId("ms").textContent).toBe("none");
  act(() => {
    for (const ms of [120, 140, 4000, 130, 125]) noteRoundTrip(ms);
  });
  expect(screen.getByTestId("ms").textContent).toBe("130");
  act(() => {
    for (const ms of [1500, 1600, 1700]) noteRoundTrip(ms);
  });
  expect(screen.getByTestId("ms").textContent).toBe("1500");
});

it("rates the link plainly", () => {
  expect([rateLink(80), rateLink(450), rateLink(1800)]).toEqual(["fast", "ok", "slow"]);
});

it("shows the link in the status sheet, and what to check when it's slow", () => {
  act(() => {
    for (const ms of [1800, 1900, 2100]) noteRoundTrip(ms);
  });
  render(<StatusSheet open onClose={() => {}} connected phone />);
  expect(screen.getByText(/1\.9 s/)).toBeTruthy();
  expect(screen.getByText(/, slow/)).toBeTruthy();
});
