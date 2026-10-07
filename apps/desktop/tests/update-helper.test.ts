import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { handOff, type HandOffDeps, helperCopy, markReady, parseStageLine, readResult, readyFile, resultFile, resultMessage, shownFile } from "../src/update-helper";

const root = mkdtempSync(path.join(tmpdir(), "chief-helper-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(root, "updater-"));
});

function deps(over: Partial<HandOffDeps> = {}) {
  const events: string[] = [];
  const base: HandOffDeps = {
    dir,
    helper: () => "C:\\data\\updater\\ChiefUpdater-1.0.0.exe",
    job: {
      version: 1,
      mode: "update",
      from: "1.0.0",
      to: "1.1.0",
      packageFile: "C:\\data\\updates\\ChiefCommandCenter-1.1.0.msix",
      packageName: "ChiefCommandCenter",
      appId: "ChiefCommandCenter",
      appPid: 4242,
      window: null,
      accent: "#E5484D",
      assistantName: "Chief",
      logFile: "C:\\data\\logs\\update-install.log",
      reducedMotion: false,
    },
    writeFace: async (target) => (writeFileSync(target, "png"), true),
    launch: async (commandLine, show) => {
      events.push(`launch ${show ? "shown" : "hidden"}: ${commandLine.split(" ")[0]}`);
      // The helper shows its window a moment after it starts.
      if (show) setTimeout(() => writeFileSync(shownFile(dir, "1.1.0"), ""), 30);
      return { ok: true, pid: 77 };
    },
    fallback: () => "conhost.exe --headless powershell.exe",
    kill: (pid) => void events.push(`kill ${pid}`),
    quit: () => void events.push("quit"),
    log: (line) => void events.push(`log ${line}`),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    ...over,
  };
  return { deps: base, events };
}

describe("handing a restart to the update helper", () => {
  it("writes the job, starts the helper's window, and quits once the window shows", async () => {
    writeFileSync(readyFile(dir, "1.1.0"), "stale"); // left by an earlier attempt
    const { deps: d, events } = deps();
    expect(await handOff(d)).toEqual({ ok: true, via: "helper" });
    expect(events.filter((e) => !e.startsWith("log"))).toEqual(['launch shown: "C:\\data\\updater\\ChiefUpdater-1.0.0.exe"', "quit"]);
    const job = JSON.parse(readFileSync(path.join(dir, "job-1.1.0.json"), "utf8"));
    expect(job).toMatchObject({ from: "1.0.0", to: "1.1.0", appPid: 4242, facePng: path.join(dir, "face.png"), shownFile: shownFile(dir, "1.1.0"), resultFile: resultFile(dir), readyDir: dir });
    expect(existsSync(readyFile(dir, "1.1.0"))).toBe(false); // a stale marker would close the window too early
  });

  it("goes without a face when the page couldn't give one", async () => {
    const { deps: d } = deps({ writeFace: async () => false });
    await handOff(d);
    expect(JSON.parse(readFileSync(path.join(dir, "job-1.1.0.json"), "utf8")).facePng).toBeNull();
  });

  it("a helper that never shows its window is stopped, and the hidden installer runs instead (never both)", async () => {
    const { deps: d, events } = deps({
      launch: async (commandLine, show) => (events.push(`launch ${show ? "shown" : "hidden"}: ${commandLine.split(" ")[0]}`), { ok: true, pid: show ? 77 : 88 }),
      shownWithinMs: 60,
    });
    expect(await handOff(d)).toEqual({ ok: true, via: "fallback" });
    expect(events.filter((e) => !e.startsWith("log"))).toEqual(['launch shown: "C:\\data\\updater\\ChiefUpdater-1.0.0.exe"', "kill 77", "launch hidden: conhost.exe", "quit"]);
    expect(events.some((e) => e.includes("didn't show its window"))).toBe(true);
  });

  it("a build without a helper, or a helper that won't start, uses the hidden installer", async () => {
    const none = deps({ helper: () => null });
    expect(await handOff(none.deps)).toEqual({ ok: true, via: "fallback" });
    const blocked = deps({ launch: async (_c, show) => (show ? { ok: false, error: "exit 3" } : { ok: true, pid: 9 }) });
    expect(await handOff(blocked.deps)).toEqual({ ok: true, via: "fallback" });
    expect(blocked.events.some((e) => e.includes("didn't start (exit 3)"))).toBe(true);
  });

  it("when nothing starts, the app doesn't quit and says so", async () => {
    const { deps: d, events } = deps({ helper: () => null, launch: async () => ({ ok: false, error: "exit 3" }) });
    expect(await handOff(d)).toEqual({ ok: false, error: expect.stringMatching(/didn't start the installer/) });
    expect(events).not.toContain("quit");
  });
});

describe("the helper's other files", () => {
  it("parses the stage protocol and ignores anything else", () => {
    expect(parseStageLine('{"phase":"staging","pct":41.6}')).toEqual({ phase: "staging", pct: 42 });
    expect(parseStageLine('{"phase":"staged","fullName":"ChiefCommandCenter_1.1.0.0_x64__abc"}')).toEqual({ phase: "staged", fullName: "ChiefCommandCenter_1.1.0.0_x64__abc" });
    expect(parseStageLine('{"phase":"error","message":"no space","hresult":"0x80070070"}')).toEqual({ phase: "error", message: "no space", hresult: "0x80070070" });
    expect(parseStageLine("Unhandled exception")).toBeNull();
    expect(parseStageLine('{"phase":"staging"}')).toBeNull();
  });

  it("reads the result once (BOM tolerated) and words a failure plainly", () => {
    writeFileSync(resultFile(dir), `\uFEFF${JSON.stringify({ version: 1, ok: false, from: "1.0.0", to: "1.1.0", step: "register", message: "Deployment failed with HRESULT 0x80073CF6.", hresult: "0x80073CF6", finishedAt: "" })}`);
    const result = readResult(dir);
    expect(result).toMatchObject({ ok: false, step: "register" });
    expect(existsSync(resultFile(dir))).toBe(false);
    expect(readResult(dir)).toBeNull();
    expect(resultMessage(result, "1.0.0")).toBe("The update to 1.1.0 didn't finish: Deployment failed with HRESULT 0x80073CF6. You're still on 1.0.0; nothing was changed.");
    expect(resultMessage({ ...result!, ok: true }, "1.1.0")).toBeNull();
  });

  it("marks this start ready for a waiting helper", () => {
    markReady(dir, "1.1.0");
    expect(existsSync(readyFile(dir, "1.1.0"))).toBe(true);
  });

  it("copies the helper out of the package once per version and removes older copies", () => {
    const resources = path.join(dir, "resources");
    mkdirSync(path.join(resources, "updater"), { recursive: true });
    writeFileSync(path.join(resources, "updater", "ChiefUpdater.exe"), "MZ-new");
    const out = path.join(dir, "copies");
    mkdirSync(out);
    writeFileSync(path.join(out, "ChiefUpdater-0.9.0.exe"), "MZ-old");
    writeFileSync(path.join(out, "notes.txt"), "keep");
    const copy = helperCopy(resources, out, "1.0.0");
    expect(copy).toBe(path.join(out, "ChiefUpdater-1.0.0.exe"));
    expect(readFileSync(copy!, "utf8")).toBe("MZ-new");
    expect(readdirSync(out).sort()).toEqual(["ChiefUpdater-1.0.0.exe", "notes.txt"]);
    expect(helperCopy(path.join(dir, "no-resources"), out, "1.0.0")).toBeNull();
  });
});
