import { describe, expect, it } from "vitest";

import { plainCustomEmoji } from "@/lib/emoji";
import { pulseLine, type Pulse } from "@/lib/ops";

const base: Pulse = { ok: true, grand: 12, in_mold: null, unstained: null, stained: null, poured: null, last_pour: { date: "2026-10-01", time: "9:00", summary: "" }, demold_time: "15:00", in_mold_skus: [] };

describe("an Ops service's live count", () => {
  it("reads in neutral words when the service sends none", () => {
    expect(pulseLine(base)).toEqual({ label: "Pulse", detail: "12 in progress · last 9:00 · next 15:00" });
    expect(pulseLine(base, { short: true })).toEqual({ label: "Pulse", detail: "12 in progress · next 15:00" });
  });

  it("uses the service's own words when it sends them", () => {
    const own = { ...base, label: "Workshop", unit: "pieces", last_label: "started", next_label: "ready" };
    expect(pulseLine(own)).toEqual({ label: "Workshop", detail: "12 pieces · started 9:00 · ready 15:00" });
  });
});

describe("custom emoji from older chat platforms", () => {
  it("show as :name: text and never as an outside image", () => {
    expect(plainCustomEmoji("done <:party:123456789012> and <a:wave:98765432109>")).toBe("done :party: and :wave:");
    expect(plainCustomEmoji("plain <not:an:emoji>")).toBe("plain <not:an:emoji>");
  });
});
