import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { Sheet } from "@/components/ui/sheet";

// The desktop app draws minimize, maximize and close over the window's top-right corner (globals.css --wco).
// A right-hand panel over the whole window reaches that corner, so its header keeps clear of them; without it
// a click on the panel's close button hits the window's maximize button instead (seen on Team & Routines).
afterEach(cleanup);

const header = () => screen.getByRole("button", { name: "Close" }).closest("header")!;

it("a right-hand panel over the window keeps its close button clear of the window buttons", () => {
  render(
    <Sheet open onClose={() => {}} side="right" title="Team & Routines">
      body
    </Sheet>,
  );
  expect(header().className).toContain("titlebar-clear");
});

it("panels away from the window's corner keep their usual padding", () => {
  for (const props of [{ side: "bottom" as const }, { side: "center" as const }, { side: "right" as const, scope: "container" as const }]) {
    const { unmount } = render(
      <Sheet open onClose={() => {}} title="A panel" {...props}>
        body
      </Sheet>,
    );
    expect(header().className).not.toContain("titlebar-clear");
    unmount();
  }
});
