import { afterEach, expect, it, vi } from "vitest";

import { isChunkError, reloadForNewBuild } from "@/lib/recover";

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

it("knows a stale build's chunk errors from other errors", () => {
  expect(isChunkError(Object.assign(new Error("Loading chunk 42 failed."), { name: "ChunkLoadError" }))).toBe(true);
  expect(isChunkError(new TypeError("Failed to fetch dynamically imported module: /_next/static/chunks/a.js"))).toBe(true);
  expect(isChunkError(new TypeError("Importing a module script failed."))).toBe(true);
  expect(isChunkError(new Error("Cannot read properties of undefined"))).toBe(false);
  expect(isChunkError(null)).toBe(false);
});

it("reloads once for a stale build, and not again within a minute", () => {
  const reload = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as Location);
  const stale = Object.assign(new Error("Loading chunk 7 failed."), { name: "ChunkLoadError" });
  expect(reloadForNewBuild(new Error("a real bug"), 1_000_000)).toBe(false);
  expect(reloadForNewBuild(stale, 1_000_000)).toBe(true);
  expect(reloadForNewBuild(stale, 1_030_000)).toBe(false); // still failing: the error screen shows instead
  expect(reloadForNewBuild(stale, 1_070_000)).toBe(true);
  expect(reload).toHaveBeenCalledTimes(2);
});
