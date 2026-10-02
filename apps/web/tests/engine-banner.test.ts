import { describe, expect, it } from "vitest";

import { engineMessage } from "@/components/engine-banner";
import type { EngineState } from "@/lib/desktop";

const state = (gateway: EngineState["gateway"]["state"], retryInMs = 0, external = false): EngineState => ({
  gateway: { state: gateway, detail: "", retryInMs },
  web: { state: "running", detail: "", retryInMs: 0 },
  external,
});

describe("the engine banner", () => {
  it("says nothing while Chief runs, or when another launcher runs it", () => {
    expect(engineMessage(state("running"), "Nova", false)).toBeNull();
    expect(engineMessage(state("failed", 60_000, true), "Nova", true)).toBeNull();
  });
  it("says Chief is restarting, stopped (with when it tries again), and back", () => {
    expect(engineMessage(state("backoff"), "Nova", true)).toEqual({ tone: "warn", text: "Nova's engine stopped. Restarting…", retry: false });
    expect(engineMessage(state("failed", 8.5 * 60_000), "Nova", true)).toEqual({ tone: "danger", text: "Nova stopped. Trying again in 9 min.", retry: true });
    expect(engineMessage(state("running"), "Nova", true)).toEqual({ tone: "ok", text: "Nova restarted and is back.", retry: false });
  });
});
