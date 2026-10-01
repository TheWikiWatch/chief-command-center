import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { historyEntries, UpdateHistorySheet } from "@/components/updates/update-history";
import { readUpdateHistory } from "@/lib/server/update-history";
import { whatsNewFor, type UpdateHistory } from "@/lib/update-history-client";

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function appDir(releases: Record<string, { notes: string; hermes: string; published: string }>, installs: unknown[] = [], extra: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "chief-web-history-"));
  roots.push(dir);
  const kept = path.join(dir, "release-history");
  mkdirSync(kept);
  for (const [version, r] of Object.entries(releases)) {
    writeFileSync(path.join(kept, `${version}.json`), JSON.stringify({ format: "chief-release", version, published: r.published, notes: r.notes, hermes: { base_version: r.hermes } }));
    writeFileSync(path.join(kept, `${version}.json.sig`), "sig");
  }
  for (const [name, text] of Object.entries(extra)) writeFileSync(path.join(kept, name), text);
  writeFileSync(path.join(dir, "update-history.json"), JSON.stringify({ installs }));
  return dir;
}

describe("reading the kept history", () => {
  it("lists kept releases newest first and leaves out unsigned or damaged files", async () => {
    const dir = appDir(
      {
        "0.1.9": { notes: "First", hermes: "2026.9.10", published: "2026-10-01T19:07:15Z" },
        "0.1.12": { notes: "Newest", hermes: "2026.9.24", published: "2026-10-01T21:32:50Z" },
      },
      [{ version: "0.1.12", at: "2026-10-01T22:00:00Z", from: "0.1.11" }, { version: "bogus", at: "x" }],
      { "0.1.10.json": "{}", "0.1.11.json": "not json", "0.1.11.json.sig": "sig" },
    );
    const h = await readUpdateHistory(dir, "0.1.12");
    expect(h.available).toBe(true);
    expect(h.releases.map((r) => [r.version, r.notes, r.hermes])).toEqual([
      ["0.1.12", "Newest", "2026.9.24"],
      ["0.1.9", "First", "2026.9.10"],
    ]);
    expect(h.installs).toEqual([{ version: "0.1.12", at: "2026-10-01T22:00:00Z", from: "0.1.11" }]);
    expect((await readUpdateHistory("", "0.1.12")).available).toBe(false);
  });
});

const history: UpdateHistory = {
  available: true,
  current: "0.1.12",
  releases: [
    { version: "0.1.12", published: "2026-10-01T21:32:50Z", notes: "Settings scrolls.", hermes: "2026.9.24" },
    { version: "0.1.11", published: "2026-10-01T20:03:28Z", notes: "Installs reopen the app.", hermes: "2026.9.24" },
    { version: "0.1.9", published: "2026-10-01T19:07:15Z", notes: "Private releases.", hermes: "2026.9.10" },
  ],
  installs: [
    { version: "0.1.10", at: "2026-10-01T19:30:00Z", from: "" },
    { version: "0.1.12", at: "2026-10-02T09:00:00Z", from: "0.1.10" },
  ],
};

describe("the history list", () => {
  it("joins releases with install dates, includes versions only seen here, and flags a Hermes change", () => {
    const e = historyEntries(history);
    expect(e.map((x) => x.version)).toEqual(["0.1.12", "0.1.11", "0.1.10", "0.1.9"]);
    expect(e[0]).toMatchObject({ installedAt: "2026-10-02T09:00:00Z", hermesChanged: false, known: true });
    expect(e[1]).toMatchObject({ hermesChanged: true }); // 0.1.11 brought 2026.9.24 over 0.1.9's 2026.9.10
    expect(e[2]).toMatchObject({ known: false, notes: "" });
  });

  it("renders the timeline with Current and installed dates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, ...history })));
    render(<UpdateHistorySheet open onClose={() => {}} />);
    expect(await screen.findByText("Settings scrolls.")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("Hermes 2026.9.24")).toBeInTheDocument();
    expect(screen.getByText("This version's notes aren't kept on this PC.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Update history" })).toBeInTheDocument();
  });
});

describe("What's new", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  it("shows the running version's notes once after an update, for two weeks", () => {
    expect(whatsNewFor(history, now, "")).toBe("0.1.12");
    expect(whatsNewFor(history, now, "0.1.12")).toBe(""); // already closed on this device
    expect(whatsNewFor(history, Date.parse("2026-10-20T12:00:00Z"), "")).toBe(""); // too long ago
    expect(whatsNewFor({ ...history, installs: [{ version: "0.1.12", at: "2026-10-02T09:00:00Z", from: "" }] }, now, "")).toBe(""); // a first install
    expect(whatsNewFor({ ...history, releases: history.releases.slice(1) }, now, "")).toBe(""); // no notes kept
  });

  it("closes for good on this device", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, ...history, installs: [{ version: "0.1.12", at: new Date().toISOString(), from: "0.1.11" }] })));
    localStorage.clear();
    const { WhatsNewCard } = await import("@/components/updates/update-history");
    render(<WhatsNewCard />);
    expect(await screen.findByText("Updated to 0.1.12")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close what's new" }));
    expect(screen.queryByText("Updated to 0.1.12")).toBeNull();
    expect(localStorage.getItem("chief-whats-new-seen")).toBe("0.1.12");
  });

  it("gives way to an offered update, and drops notes a newer version replaces", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, ...history, installs: [{ version: "0.1.12", at: new Date().toISOString(), from: "0.1.11" }] })));
    localStorage.clear();
    const { WhatsNewCard } = await import("@/components/updates/update-history");
    render(<WhatsNewCard newer="0.1.13" />);
    await waitFor(() => expect(localStorage.getItem("chief-whats-new-seen")).toBe("0.1.12"));
    expect(screen.queryByText("Updated to 0.1.12")).toBeNull();
  });
});
