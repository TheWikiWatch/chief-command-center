import { afterEach, expect, it, vi } from "vitest";

import { MAX_EDGE, shrinkImage, shrinkPlan } from "@/lib/image-shrink";

afterEach(() => vi.unstubAllGlobals());

it("shrinks camera photos to a 2048px long edge as JPEG", () => {
  expect(shrinkPlan("image/jpeg", 6_000_000, 4032, 3024)).toEqual({ width: MAX_EDGE, height: 1536, type: "image/jpeg" });
  expect(shrinkPlan("image/webp", 3_000_000, 3000, 4000)).toEqual({ width: 1536, height: MAX_EDGE, type: "image/jpeg" });
  // Small in pixels but a heavy file: re-encoded at the same size.
  expect(shrinkPlan("image/jpeg", 2_000_000, 1600, 1200)).toEqual({ width: 1600, height: 1200, type: "image/jpeg" });
});

it("leaves small photos, GIFs and unknown types alone", () => {
  expect(shrinkPlan("image/jpeg", 300_000, 1200, 900)).toBeNull();
  expect(shrinkPlan("image/gif", 9_000_000, 4000, 3000)).toBeNull();
  expect(shrinkPlan("application/pdf", 9_000_000, 4000, 3000)).toBeNull();
  expect(shrinkPlan("image/jpeg", 9_000_000, 0, 0)).toBeNull();
});

it("keeps PNG screenshots PNG and only scales them when they are larger than 2048px", () => {
  expect(shrinkPlan("image/png", 5_000_000, 1920, 1080)).toBeNull();
  expect(shrinkPlan("image/png", 9_000_000, 2880, 1800)).toEqual({ width: MAX_EDGE, height: 1280, type: "image/png" });
});

it("sends the original when the browser can't decode it or the copy isn't smaller", async () => {
  const photo = new File([new Uint8Array(10)], "IMG_1.HEIC", { type: "image/heic" });
  expect(await shrinkImage(photo)).toBe(photo); // no createImageBitmap here
  vi.stubGlobal("createImageBitmap", async () => {
    throw new Error("unsupported");
  });
  expect(await shrinkImage(photo)).toBe(photo);
});
