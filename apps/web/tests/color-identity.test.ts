import { describe, expect, it } from "vitest";

import { BOT_PALETTE, chiefColor } from "@/lib/bot-identity";
import { CANVAS, contrast, glowColor, MIN_GLOW_CONTRAST, mix, raysPalette } from "@/lib/color";

describe("color identity", () => {
  it("every palette color glows visibly on the canvas", () => {
    for (const color of BOT_PALETTE) expect(contrast(color, CANVAS), color).toBeGreaterThanOrEqual(MIN_GLOW_CONTRAST);
  });

  it("lifts a chosen color too dark to see, and leaves good ones alone", () => {
    expect(contrast(glowColor("#101040"), CANVAS)).toBeGreaterThanOrEqual(MIN_GLOW_CONTRAST);
    expect(glowColor("#00C5F3")).toBe("#00c5f3");
    expect(glowColor("tomato")).toBe("tomato");
    expect(contrast(chiefColor({ id: "chief", color: "#000000" }), CANVAS)).toBeGreaterThanOrEqual(MIN_GLOW_CONTRAST);
  });

  it("the chief keeps its chosen color; others draw from the palette", () => {
    expect(chiefColor({ id: "chief", color: "#58c57e" })).toBe("#58c57e");
    expect(BOT_PALETTE).toContain(chiefColor({ id: "chief" }));
  });

  it("the orbit's rays are the chief's color sinking into the canvas", () => {
    const { colors, bloom } = raysPalette("#00c5f3");
    expect(colors).toHaveLength(4);
    expect(colors[0]).toBe(mix("#00c5f3", CANVAS, 0.45));
    expect(colors[3]).toBe(CANVAS);
    expect(contrast(colors[0], CANVAS)).toBeGreaterThan(contrast(colors[2], CANVAS));
    expect(bloom).toMatch(/^#[0-9a-f]{6}$/);
  });
});
