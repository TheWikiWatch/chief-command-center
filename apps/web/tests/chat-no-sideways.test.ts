import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

// A scroller that only says overflow-y gets overflow-x: auto too, so one too-wide thing in a message let the whole
// conversation slide sideways on a phone (a tester's report). jsdom can't lay out, so this guards the class itself.
it("the chat scrolls up and down only", () => {
  const thread = readFileSync(path.resolve(__dirname, "..", "components", "chat", "thread.tsx"), "utf8");
  const scroller = /ref=\{scroller\}[\s\S]{0,400}?className="([^"]+)"/.exec(thread)?.[1] || "";
  expect(scroller).toContain("overflow-y-auto");
  expect(scroller).toContain("overflow-x-hidden");
});
