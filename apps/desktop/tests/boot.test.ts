import { describe, expect, it } from "vitest";

import { createBoot, MISSING_FILES, recoversBoot, type BootDeps } from "../src/boot";

function deps(over: Partial<BootDeps> = {}) {
  const calls: string[] = [];
  const steps: string[] = [];
  let t = 0;
  const base: BootDeps = {
    setStep: (id, state, detail) => steps.push(`${id}:${state}${detail ? `:${detail}` : ""}`),
    showBootPage: async () => void calls.push("page"),
    missing: () => [],
    loadToken: () => void calls.push("token"),
    newerDataError: () => null,
    choosePorts: async () => void calls.push("ports"),
    restoreJournalExists: () => false,
    recover: async () => (calls.push("recover"), { ok: true, action: "none" }),
    provisionKey: () => "k2",
    lastProvisionKey: () => "k1",
    provision: async () => (calls.push("provision"), { ok: true }),
    saveProvisionKey: (k) => void calls.push(`saved:${k}`),
    backupNeeded: () => null,
    backup: async () => (calls.push("backup"), { ok: true }),
    recordStart: () => void calls.push("record"),
    claimGateway: async () => "own",
    startGateway: async () => void calls.push("gateway"),
    gatewayUp: async () => ({ ok: true, voice: true }),
    gatewayDetail: () => "",
    startWeb: async () => (calls.push("web"), { ok: true }),
    openDashboard: async () => void calls.push("dashboard"),
    quit: () => void calls.push("quit"),
    name: () => "Ada",
    now: () => (t += 10),
    log: (event, fields) => void calls.push(`log:${event}${fields?.reason ? `:${fields.reason}` : ""}`),
  };
  return { d: { ...base, ...over }, calls, steps };
}

describe("boot", () => {
  it("runs the steps in order and opens the dashboard once Chief and the dashboard both answer", async () => {
    const { d, calls, steps } = deps();
    expect(await createBoot(d).run()).toBe("ready");
    const order = calls.filter((c) => !c.startsWith("log:"));
    expect(order.slice(0, 6)).toEqual(["page", "token", "ports", "provision", "saved:k2", "record"]);
    expect(order.slice(6, 8).sort()).toEqual(["gateway", "web"]); // started together
    expect(order[8]).toBe("dashboard");
    expect(steps.filter((s) => s.endsWith(":done")).sort()).toEqual(["gateway:done", "prepare:done", "runtime:done", "web:done"]);
    expect(calls).toContain("log:boot.ready");
  });

  it("skips recovery without a restore journal, and provisioning when nothing changed", async () => {
    const { d, calls } = deps({ lastProvisionKey: () => "k2" });
    await createBoot(d).run();
    expect(calls).not.toContain("recover");
    expect(calls).not.toContain("provision");
    expect(calls).toContain("log:boot.provision.skipped");
    const withJournal = deps({ restoreJournalExists: () => true });
    await createBoot(withJournal.d).run();
    expect(withJournal.calls).toContain("recover");
  });

  it("starts the dashboard without waiting for Chief", async () => {
    let releaseGateway!: () => void;
    const { d, calls } = deps({ gatewayUp: () => new Promise((r) => (releaseGateway = () => r({ ok: true })) ) });
    const run = createBoot(d).run();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("web");
    expect(calls).not.toContain("dashboard");
    releaseGateway();
    expect(await run).toBe("ready");
  });

  it("stops at the first failure and says why in plain words, the technical reason in the log; a failed provision isn't remembered", async () => {
    const missing = deps({ missing: () => ["Hermes runtime (C:\\Program Files\\WindowsApps\\x\\hermes.exe)"] });
    expect(await createBoot(missing.d).run()).toBe("error");
    expect(missing.steps).toContain(`runtime:error:${MISSING_FILES}`);
    expect(missing.steps.join(" ")).not.toContain("WindowsApps"); // the path is for the log
    expect(missing.calls).toContain("log:boot.runtime.reason:Hermes runtime (C:\\Program Files\\WindowsApps\\x\\hermes.exe)");
    expect(missing.calls).not.toContain("ports");

    const prov = deps({ provision: async () => ({ ok: false, error: "Preparing Hermes failed (KeyError: 'x')" }) });
    expect(await createBoot(prov.d).run()).toBe("error");
    expect(prov.steps).toContain("prepare:error:The app couldn't get Ada ready for this start. Try again.");
    expect(prov.calls).toContain("log:boot.prepare.reason:Preparing Hermes failed (KeyError: 'x')");
    expect(prov.calls.some((c) => c.startsWith("saved:"))).toBe(false);

    const down = deps({ gatewayUp: async () => ({ ok: false, detail: "No answer yet." }) });
    expect(await createBoot(down.d).run()).toBe("error");
    expect(down.steps).toContain("gateway:error:Ada didn't answer. Try again.");
    expect(down.calls).not.toContain("dashboard");

    // The supervisor's own sentence wins (it says why: stopped, didn't answer).
    const crashed = deps({ gatewayUp: async () => ({ ok: false }), gatewayDetail: () => "It stopped unexpectedly." });
    await createBoot(crashed.d).run();
    expect(crashed.steps).toContain("gateway:error:It stopped unexpectedly.");
  });

  it("one boot at a time: Retry during a boot joins it", async () => {
    let n = 0;
    const { d } = deps({ choosePorts: async () => void n++ });
    const boot = createBoot(d);
    const [a, b] = [boot.run(), boot.run()];
    expect(a).toBe(b);
    await a;
    expect(n).toBe(1);
    await boot.run();
    expect(n).toBe(2);
  });

  it("the owner can quit at the other launcher's question, and an external gateway isn't started", async () => {
    const q = deps({ claimGateway: async () => "quit" });
    expect(await createBoot(q.d).run()).toBe("quit");
    expect(q.calls).toContain("quit");
    const ext = deps({ claimGateway: async () => "external" });
    expect(await createBoot(ext.d).run()).toBe("ready");
    expect(ext.calls).not.toContain("gateway");
  });
});

describe("a start that recovers", () => {
  it("a throw inside a step shows on that step with Retry, and the next run starts clean", async () => {
    let fails = true;
    const { d, steps, calls } = deps({
      choosePorts: async () => {
        if (fails) throw new Error("No free port between 3000 and 3049.");
      },
    });
    const boot = createBoot(d);
    expect(await boot.run()).toBe("error");
    expect(steps).toContain("prepare:error:No free port between 3000 and 3049.");
    expect(calls).toContain("log:boot.unhandled");
    expect(boot.running).toBe(false);
    fails = false;
    expect(await boot.run()).toBe("ready");
  });

  it("a throw while opening the dashboard lands on the web step", async () => {
    const { d, steps } = deps({ openDashboard: async () => Promise.reject(new Error("The page wouldn't load.")) });
    expect(await createBoot(d).run()).toBe("error");
    expect(steps.at(-1)).toBe("web:error:The page wouldn't load.");
  });

  it("a supervisor coming back on its own restarts the boot only while the start screen shows a failure", () => {
    const errored = [{ state: "done" }, { state: "error" }];
    const fine = [{ state: "done" }, { state: "done" }];
    expect(recoversBoot({ type: "state", state: "running" }, errored, false, true)).toBe(true);
    expect(recoversBoot({ type: "state", state: "running" }, errored, true, true)).toBe(false); // a boot is on it already
    expect(recoversBoot({ type: "state", state: "running" }, fine, false, true)).toBe(false);
    expect(recoversBoot({ type: "state", state: "backoff" }, errored, false, true)).toBe(false);
    expect(recoversBoot({ type: "unhealthy" }, errored, false, true)).toBe(false);
  });

  it("never over the dashboard: Chief failing and coming back there leaves the page (and its drafts) alone", () => {
    // Before: the supervisor's "failed" put an error on the gateway step even while the dashboard showed, and its
    // recovery (Try now, the 10-minute retry, a phone restart of the dashboard server) loaded the start screen over it.
    const errored = [{ state: "done" }, { state: "error" }];
    expect(recoversBoot({ type: "state", state: "running" }, errored, false, false)).toBe(false);
  });
});
