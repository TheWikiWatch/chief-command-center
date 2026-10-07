import { describe, expect, it } from "vitest";

import { isOrphan } from "../src/gateway";
import { decidePorts } from "../src/ports";

describe("ports on Retry", () => {
  const saved = { ui: 3000, bridge: 7790 };
  it("keeps a saved port that this run's own child still holds", async () => {
    const taken = new Set([3000, 7790]);
    const probe = async (p: number) => !taken.has(p);
    expect(await decidePorts({ saved, first: false, bridgeHeld: true, uiHeld: true, probe })).toEqual(saved);
    // Before: the dashboard server kept running after a failed start, and Retry moved the window to 3001.
    expect(await decidePorts({ saved, first: false, bridgeHeld: true, uiHeld: false, probe })).toEqual({ ui: 3001, bridge: 7790 });
  });
  it("moves off a port something else holds, and never onto the bridge's", async () => {
    const taken = new Set([3000, 3001, 7790]);
    const probe = async (p: number) => !taken.has(p);
    expect(await decidePorts({ saved, first: false, bridgeHeld: false, uiHeld: false, probe })).toEqual({ ui: 3002, bridge: 7791 });
    expect(await decidePorts({ saved: { ui: 7791, bridge: 7790 }, first: false, bridgeHeld: false, uiHeld: false, probe: async (p) => p !== 7790 && p !== 7791 })).toEqual({ ui: 7793, bridge: 7792 });
  });
  it("a first start takes the defaults when they are free", async () => {
    expect(await decidePorts({ saved: { ui: 3005, bridge: 7795 }, first: true, bridgeHeld: false, uiHeld: false, probe: async (p) => p !== 3005 && p !== 7795 })).toEqual({ ui: 3000, bridge: 7790 });
  });
});

describe("whose gateway is in the pid file", () => {
  const ours = { state: "ours" as const, pid: 42 };
  it("one this run's supervisor is starting or running is never an orphan", () => {
    expect(isOrphan(ours, { state: "running", child: { pid: 7 } })).toBe(false);
    expect(isOrphan(ours, { state: "starting", child: { pid: 7 } })).toBe(false);
  });
  it("one left behind by a crashed run is", () => {
    expect(isOrphan(ours, undefined)).toBe(true);
    expect(isOrphan(ours, { state: "stopped", child: null })).toBe(true);
    expect(isOrphan(ours, { state: "backoff", child: null })).toBe(true);
  });
  it("another launcher's gateway is handled by the owner's choice, not here", () => {
    expect(isOrphan({ state: "foreign", pid: 9, launcher: "x" }, undefined)).toBe(false);
    expect(isOrphan({ state: "none" }, undefined)).toBe(false);
  });
});
