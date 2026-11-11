import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { activeWork, backupRunning } from "../src/active-work";
import { createQuitter, type QuitDeps, type Work } from "../src/quitting";

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function harness(over: Partial<QuitDeps> = {}, works: Work[] = []) {
  const calls: string[] = [];
  let clock = 0;
  const idle: Work = { busy: false, reasons: [] };
  const deps: QuitDeps = {
    work: async () => works.shift() ?? idle,
    external: () => false,
    ask: async () => (calls.push("ask"), "quit"),
    showWaiting: async (reasons) => void calls.push(`waiting:${reasons.join(",")}`),
    reopen: async () => void calls.push("reopen"),
    closing: () => void calls.push("closing"),
    showClosing: () => void calls.push("closing-screen"),
    hide: () => void calls.push("hide"),
    stopNotifier: () => void calls.push("notifier"),
    pauseServe: async () => void calls.push("pause-serve"),
    stopWeb: async () => void calls.push("stop-web"),
    stopGateway: async () => void calls.push("stop-gateway"),
    relaunch: (args) => void calls.push(`relaunch:${args.join(" ")}`),
    exit: () => void calls.push("exit"),
    log: () => undefined,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setTimeout(r, 0));
    },
    now: () => clock,
    ...over,
  };
  return { quitter: createQuitter(deps), calls };
}

const busy = (reason: string): Work => ({ busy: true, reasons: [reason] });

describe("quitting", () => {
  it("every way out takes the same shutdown: phone access paused, the dashboard server and Chief stopped, then exit", async () => {
    const { quitter, calls } = harness();
    await quitter.quit();
    expect(calls).toEqual(["closing", "notifier", "pause-serve", "stop-web", "stop-gateway", "exit"]);

    // The update handing over (and the start screen's Quit) used to exit at once, leaving phone access on a dead port.
    const handOff = harness();
    await handOff.quitter.shutdown({ hide: true });
    expect(handOff.calls).toEqual(["closing", "hide", "notifier", "pause-serve", "stop-web", "stop-gateway", "exit"]);
  });

  it("one at a time: a second Quit joins the first instead of asking again", async () => {
    let answer!: (c: "wait" | "quit" | "cancel") => void;
    const { quitter, calls } = harness({ ask: () => (calls.push("ask"), new Promise((r) => (answer = r))) }, [busy("Writing a report")]);
    const first = quitter.quit();
    await settle();
    const second = quitter.quit();
    expect(second).toBe(first);
    answer("quit");
    await first;
    expect(calls.filter((c) => c === "ask")).toHaveLength(1);
    expect(calls.filter((c) => c === "exit")).toHaveLength(1);
    // Shutting down already: any later quit or shutdown is the same one.
    await quitter.shutdown();
    expect(calls.filter((c) => c === "exit")).toHaveLength(1);
  });

  it("Cancel keeps everything running, and a later Quit asks again", async () => {
    const { quitter, calls } = harness({ ask: async () => (calls.push("ask"), "cancel") }, [busy("a"), busy("a")]);
    await quitter.quit();
    expect(calls).toEqual(["ask"]);
    await quitter.quit();
    expect(calls).toEqual(["ask", "ask"]);
  });

  it("Wait for Chief shows the waiting screen, then quits once Chief is done", async () => {
    const { quitter, calls } = harness({ ask: async () => (calls.push("ask"), "wait") }, [busy("Writing a report"), busy("Writing a report")]);
    await quitter.quit();
    expect(calls).toEqual(["ask", "waiting:Writing a report", "closing", "notifier", "pause-serve", "stop-web", "stop-gateway", "exit"]);
  });

  it("the waiting screen's Quit now stops at once; Keep running goes back to the dashboard", async () => {
    const forever = { busy: true, reasons: ["Running a routine"] };
    const now = harness({ ask: async () => "wait", work: async () => forever });
    const quitting = now.quitter.quit();
    await settle();
    expect(now.calls).toContain("waiting:Running a routine");
    now.quitter.answer("quit");
    await quitting;
    expect(now.calls.at(-1)).toBe("exit");

    const stay = harness({ ask: async () => "wait", work: async () => forever });
    const staying = stay.quitter.quit();
    await settle();
    stay.quitter.answer("stay");
    await staying;
    expect(stay.calls).toContain("reopen");
    expect(stay.calls).not.toContain("exit");
  });

  it("a wait that runs out asks again", async () => {
    const asked: string[] = [];
    const { quitter, calls } = harness(
      { ask: async () => (asked.push("ask"), asked.length === 1 ? "wait" : "quit"), work: async () => busy("still going"), waitMs: 6000, pollMs: 2000 },
    );
    await quitter.quit();
    expect(asked).toHaveLength(2);
    expect(calls.at(-1)).toBe("exit");
  });

  it("another launcher's Chief isn't waited for or stopped", async () => {
    const { quitter, calls } = harness({ external: () => true }, [busy("x")]);
    await quitter.quit();
    expect(calls).not.toContain("ask");
    expect(calls).not.toContain("stop-gateway");
    expect(calls).toContain("stop-web");
  });

  it("a launch while closing opens the app again once it has exited", async () => {
    let release!: () => void;
    const { quitter, calls } = harness({ stopGateway: () => new Promise<void>((r) => (release = r)) });
    const closing = quitter.shutdown();
    await settle();
    expect(quitter.closing).toBe(true);
    quitter.relaunchAfter(["--action=today"]);
    release();
    await closing;
    expect(calls.slice(-2)).toEqual(["relaunch:--action=today", "exit"]);
  });

  it("a backup the dashboard is making is work: Quit asks first, as for a reply", async () => {
    // Before: a manual backup runs under the dashboard server, and Quit (or Restart to update) ended it without a word.
    const { quitter, calls } = harness({ ask: async (reasons) => (calls.push(`ask:${reasons.join(",")}`), "cancel") }, [activeWork({ backup: true })]);
    await quitter.quit();
    expect(calls).toEqual(["ask:A backup is running."]);
  });

  it("a slow stop gets the closing screen; a quick one doesn't flash it", async () => {
    let release!: () => void;
    const slow = harness({ feedbackMs: 5, stopGateway: () => new Promise<void>((r) => (release = r)) });
    const closing = slow.quitter.shutdown();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await closing;
    expect(slow.calls).toContain("closing-screen");

    const quick = harness({ feedbackMs: 50 });
    await quick.quitter.shutdown();
    await new Promise((r) => setTimeout(r, 70));
    expect(quick.calls).not.toContain("closing-screen");
  });
});

describe("a running backup", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "chief-backup-lock-"));
  afterAll(() => rmSync(appDir, { recursive: true, force: true }));
  const startedAt = Date.parse("2026-11-10T10:00:00Z");
  const record = (pid: number, at = startedAt) => writeFileSync(path.join(appDir, "backup-running.json"), JSON.stringify({ pid, kind: "manual", startedAt: at }));
  const engine = async () => ({ path: "C:\\App\\resources\\payload\\tools\\python-3.14\\python.exe", startedMs: startedAt + 300 });

  it("is read from the dashboard's record: the engine's pid, still a Python that started with the backup", async () => {
    expect(await backupRunning(appDir, engine, startedAt + 60_000)).toBe(false); // no record
    record(4242);
    expect(await backupRunning(appDir, engine, startedAt + 60_000)).toBe(true);
    // The engine is gone, or Windows gave its pid to another program since.
    expect(await backupRunning(appDir, async () => null, startedAt + 60_000)).toBe(false);
    expect(await backupRunning(appDir, async () => ({ path: "C:\\Tools\\editor.exe", startedMs: startedAt }), startedAt + 60_000)).toBe(false);
    expect(await backupRunning(appDir, async () => ({ path: "C:\\Python\\python.exe", startedMs: startedAt + 3_600_000 }), startedAt + 4_000_000)).toBe(false);
    // Over six hours old, like the dashboard's own rule.
    expect(await backupRunning(appDir, engine, startedAt + 7 * 3600 * 1000)).toBe(false);
    writeFileSync(path.join(appDir, "backup-running.json"), "{ half a reco");
    expect(await backupRunning(appDir, engine, startedAt + 60_000)).toBe(false);
  });

  it("says so in the reasons, with Chief or without it", () => {
    expect(activeWork({ backup: true })).toEqual({ busy: true, reasons: ["A backup is running."] });
    expect(activeWork({ generating: true, backup: true }, "Nova").reasons).toEqual(["Nova is writing a reply.", "A backup is running."]);
  });
});
