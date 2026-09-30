import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/components/bot-face", () => ({ BotFace: () => null, faceProps: () => ({}) }));

import { FleetHealth } from "@/components/fleet-health";
import { approvalMessage, flagMessage, loadSeenFlags, unseenFlags, type FleetHealth as Health } from "@/lib/fleet-health";
import type { Person } from "@/lib/types";

const now = Date.now() / 1000;
const stats = (done: number, crashed = 0) => ({ done, crashed, gaveUp: 0, spawned: done + crashed, medianMinutes: 12, success: done / (done + crashed || 1) });
const change = (id: number, extra = {}) => ({
  id, file: "SKILL.md", change: "changed", at: now - 20 * 86400 + id, source: "background review (ada, s1)", added: 2, removed: 1, canRevert: true, newer: 0, episode: "ep7", ...extra,
});
const report: Health = {
  ok: true,
  generatedAt: now - 120,
  ageSeconds: 120,
  desks: [
    { desk: "ada", weeks: [1, 2, 3, 4, 5, 6], last7: stats(9, 1), cards30: 20, blocked: 0, memory: { memory: 2150, memoryLimit: 2200, user: 100, userLimit: 1375 } },
    { desk: "morgan", weeks: [0, 0, 0, 0, 0, 0], last7: stats(0), cards30: 0, blocked: 0, memory: { memory: 0, memoryLimit: 2200, user: 0, userLimit: 1375 } },
  ],
  skills: [
    {
      key: "ada/devops/sdlc-review", scope: "ada", skill: "devops/sdlc-review", name: "sdlc-review", files: 1,
      edits48h: 0, edits7d: 2, edits30d: 2, size: 12_000, size14d: 6_000, skillMdSize: 12_000, lastAt: now - 20 * 86400,
      sources: { review: 2, outside: 0 },
      episodes: [{ id: "ep7", start: now - 20 * 86400, end: now - 20 * 86400 + 8, edits: 2, firstId: 7, lastId: 8, verdict: { label: "worse", why: "quality 90% → 60%", judgeAt: now - 6 * 86400 } }],
      changes: [change(8), change(7, { newer: 1 })],
    },
  ],
  changes: [],
  changes7d: 2,
  runtime: { crashes24h: 0, crashes7d: 3, crashGroups: [{ key: "python.exe · python311.dll · c0000005", count: 3 }], lastCrashAt: null, compactionsToday: 2, curator: null, distill: null, rosterReview: null },
  proposals: [
    { id: "20260927-1", kind: "revert", target: "#7", change: "Revert the sdlc-review change", why: "success fell 30 points", status: "open" },
    { id: "20260920-4", kind: "skill", target: "kanban-worker-ops", change: "split it", status: "applied", decision: "approve" },
  ],
  flags: [
    { id: "worse:ada/devops/sdlc-review:ep7", kind: "worse", severity: "danger", title: "sdlc-review (ada) got worse after 2 edits", detail: "quality 90% → 60%", skill: "ada/devops/sdlc-review" },
    { id: "memory:ada:memory:2026-W40", kind: "memory", severity: "warn", title: "ada's memory is 98% full", detail: "2150 of 2200 characters.", desk: "ada" },
  ],
};
const people = [{ id: "ada", name: "Ada - Coding Projects Lead" } as Person];

type Call = { url: string; body?: unknown };
let calls: Call[] = [];
function serve(data: Health = report) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).startsWith("/api/fleet/diff")) return Response.json({ ok: true, diff: "@@ -1 +1 @@\n-old rule\n+new rule" });
    if (String(url).startsWith("/api/fleet/revert")) return Response.json({ ok: true, message: "reverted #7" });
    if (String(url).startsWith("/api/fleet/decide")) return Response.json({ ok: true });
    return Response.json(data);
  }));
}

beforeEach(() => {
  localStorage.clear();
  serve();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows flags first, scorecards, runtime, and marks the flags seen", async () => {
  render(<FleetHealth people={people} />);
  expect(await screen.findByText("sdlc-review (ada) got worse after 2 edits")).toBeInTheDocument();
  expect(screen.getByText("Ada")).toBeInTheDocument();
  expect(screen.getByText("No work in 30 days: morgan")).toBeInTheDocument();
  expect(screen.getByText("98%")).toBeInTheDocument(); // Ada's memory fill
  expect(screen.getByText("python.exe · python311.dll · c0000005")).toBeInTheDocument();
  await waitFor(() => expect(unseenFlags(report.flags!, loadSeenFlags())).toEqual([]));
});

it("Ask Chief sends the flag's request; Show changes opens that skill", async () => {
  const send = vi.fn(async () => undefined);
  render(<FleetHealth people={people} onSendToChief={send} />);
  const memory = (await screen.findByText("ada's memory is 98% full")).closest("li")!;
  fireEvent.click(within(memory).getByRole("button", { name: "Ask Chief" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(flagMessage(report.flags![1])));
  expect(await within(memory).findByRole("button", { name: /Sent to Chief/ })).toBeDisabled();
  const worse = screen.getByText("sdlc-review (ada) got worse after 2 edits").closest("li")!;
  fireEvent.click(within(worse).getByRole("button", { name: "Show changes" }));
  expect(await screen.findByText(/by background review/)).toBeInTheDocument();
});

it("a skill lists its episode and changes; diffs load when opened", async () => {
  render(<FleetHealth people={people} />);
  fireEvent.click(await screen.findByRole("button", { name: /sdlc-review/ }));
  expect(await screen.findByText(/by background review/)).toBeInTheDocument();
  expect(screen.getByText("(+100% in 14d)")).toBeInTheDocument();
  expect(calls.some((c) => c.url.startsWith("/api/fleet/diff"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Net change" }));
  expect(await screen.findByText("+new rule")).toBeInTheDocument();
  expect(calls.some((c) => c.url === "/api/fleet/diff?id=8&from=7")).toBe(true);
});

it("reverting an older change arms first and says how many later edits it undoes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    render(<FleetHealth people={people} />);
    fireEvent.click(await screen.findByRole("button", { name: /sdlc-review/ }));
    fireEvent.click(await screen.findByRole("button", { name: /#7 ·/ }));
    expect(await screen.findByText(/changed once after this/)).toBeInTheDocument();
    const hold = (name: string | RegExp) => {
      fireEvent.pointerDown(screen.getByRole("button", { name }));
      vi.advanceTimersByTime(950);
    };
    hold("Hold to revert this change");
    expect(await screen.findByText(/also undoes the 1 later edit/)).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/fleet/revert")).toEqual([]);
    hold(/Hold again to revert and undo 1 later edit/);
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/fleet/revert").map((c) => c.body)).toEqual([{ id: 7, discardNewer: 1 }]));
  } finally {
    vi.useRealTimers();
  }
});

it("Approve sends the proposal to Chief and records it for every device; decided ones are listed", async () => {
  const send = vi.fn(async () => undefined);
  render(<FleetHealth people={people} onSendToChief={send} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(approvalMessage(report.proposals[0])));
  await waitFor(() => expect(calls.find((c) => c.url === "/api/fleet/decide")?.body).toEqual({ id: "20260927-1", decision: "approve" }));
  expect(await screen.findByText("All proposals handled")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show 2 decided" }));
  expect(screen.getByText("Applied")).toBeInTheDocument();
  expect(screen.getByText("Sent to Chief")).toBeInTheDocument();
});

it("dismissals from this device's old local list are recorded once for every device", async () => {
  localStorage.setItem("chief-fleet-dismissed", JSON.stringify(["20260927-1"]));
  render(<FleetHealth people={people} />);
  await waitFor(() => expect(calls.find((c) => c.url === "/api/fleet/decide")?.body).toEqual({ id: "20260927-1", decision: "dismiss" }));
  await waitFor(() => expect(localStorage.getItem("chief-fleet-dismissed")).toBeNull());
});

it("an older report without skills still lists its changes", async () => {
  serve({ ...report, skills: undefined, flags: undefined, changes: [{ ...change(7), scope: "ada", skill: "devops/sdlc-review" }] });
  render(<FleetHealth people={people} />);
  expect(await screen.findByRole("button", { name: /sdlc-review/ })).toBeInTheDocument();
});
