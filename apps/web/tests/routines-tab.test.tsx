import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { RoutinesTab, scheduleText } from "@/components/fleet/routines-tab";
import { permittedOperation } from "@/lib/proxy-policy";
import { lastResult } from "@/lib/routines-client";
import type { TeamRoutine } from "@/lib/routines-client";

const base: Omit<TeamRoutine, "id" | "profile" | "bot" | "name" | "prompt" | "schedule"> = {
  enabled: true,
  state: "scheduled",
  nextRun: null,
  lastRun: null,
  lastStatus: null,
  lastError: null,
  lastOutput: "",
  thread: "main",
  silent: false,
  kind: "agent",
  builtIn: false,
  skills: [],
};
const ROUTINES: TeamRoutine[] = [
  { ...base, id: "a1", profile: "chief", bot: "Chief", name: "Morning brief", prompt: "Summarize today.", schedule: { kind: "weekdays", time: "07:30", text: "Weekdays at 07:30" } },
  {
    ...base,
    id: "b2",
    profile: "research-desk",
    bot: "Sam",
    name: "Source sweep",
    prompt: "Find papers.",
    schedule: { kind: "daily", time: "06:00", text: "Every day at 06:00" },
    lastRun: "2026-10-01T06:00:00",
    lastStatus: "error",
    lastError: "Provider timed out",
    thread: "t-1234abcd",
  },
  { ...base, id: "c3", profile: "chief", bot: "Chief", name: "Second Brain: nightly", prompt: "Tidy.", builtIn: true, schedule: { kind: "daily", time: "22:00", text: "Every day at 22:00" } },
];

function route() {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1:3100").pathname.replace("/api/bridge/", "");
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path, body });
        const found = ROUTINES.find((r) => r.id === body.id);
        return Response.json({ ok: true, routine: found ? { ...found, ...("enabled" in body ? { enabled: body.enabled } : {}) } : undefined });
      }
      if (path === "routines")
        return Response.json({ ok: true, routines: ROUTINES, bots: [{ id: "chief", name: "Chief" }, { id: "research-desk", name: "Sam" }] });
      if (path === "threads")
        return Response.json({ ok: true, threads: [{ id: "main", title: "Main", archived: false }, { id: "t-1234abcd", title: "Research", archived: false }] });
      return Response.json({ ok: false }, { status: 404 });
    }),
  );
  return posts;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lists the owner's routines and the built-in ones apart, with a failed run called out", async () => {
  route();
  render(<RoutinesTab people={[]} />);
  const mine = (await screen.findByRole("heading", { name: "Your routines" })).closest("section")!;
  expect(within(mine).getByText("Morning brief")).toBeInTheDocument();
  expect(within(mine).getByText(/Every day at 06:00.*Research/)).toBeInTheDocument();
  expect(within(mine).getByText(/Failed/)).toBeInTheDocument();
  const built = screen.getByRole("heading", { name: "Built in" }).closest("section")!;
  expect(within(built).getByText("Nightly")).toBeInTheDocument();
  expect(within(built).getByText(/^Second Brain · Every day at 22:00/)).toBeInTheDocument();
});

it("switches a routine off from the list", async () => {
  const posts = route();
  render(<RoutinesTab people={[]} />);
  fireEvent.click(await screen.findByRole("switch", { name: "Morning brief on" }));
  await waitFor(() => expect(posts).toEqual([{ path: "routines/update", body: { profile: "chief", id: "a1", enabled: false } }]));
  expect(screen.getByRole("switch", { name: "Morning brief off" })).toHaveAttribute("aria-checked", "false");
});

it("creates a weekly routine for a bot that reports into a thread", async () => {
  const posts = route();
  render(<RoutinesTab people={[]} />);
  fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
  const create = await screen.findByRole("button", { name: "Create routine" });
  expect(create).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Friday review" } });
  fireEvent.change(screen.getByLabelText("What it should do"), { target: { value: "Review the week." } });
  fireEvent.click(screen.getByRole("radio", { name: "Weekly" }));
  const days = screen.getByRole("group", { name: "Days" });
  fireEvent.click(within(days).getByRole("button", { name: "Mo" })); // Monday was the default: now off
  fireEvent.click(within(days).getByRole("button", { name: "Fr" }));
  fireEvent.change(screen.getByLabelText("At"), { target: { value: "16:00" } });
  expect(screen.getByText(/Fri at 16:00/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Sam" }));
  await waitFor(() => expect(screen.getByRole("option", { name: "Research" })).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("Reports to"), { target: { value: "t-1234abcd" } });
  fireEvent.click(create);
  await waitFor(() =>
    expect(posts[0]).toEqual({
      path: "routines",
      body: { profile: "research-desk", name: "Friday review", prompt: "Review the week.", schedule: { kind: "weekly", time: "16:00", days: [5] }, thread: "t-1234abcd" },
    }),
  );
  expect(await screen.findByText("Friday review is scheduled.")).toBeInTheDocument();
});

it("a built-in routine keeps its words; only what changed is sent", async () => {
  const posts = route();
  render(<RoutinesTab people={[]} />);
  fireEvent.click(await screen.findByRole("button", { name: /Nightly/ }));
  expect(await screen.findByLabelText("Name")).toBeDisabled();
  expect(screen.getByLabelText("What it should do")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("At"), { target: { value: "21:15" } });
  fireEvent.click(save);
  await waitFor(() => expect(posts[0]).toEqual({ path: "routines/update", body: { profile: "chief", id: "c3", schedule: { kind: "daily", time: "21:15" } } }));
});

it("shows why the last run failed, runs now, and deletes only after confirming", async () => {
  const posts = route();
  render(<RoutinesTab people={[]} />);
  fireEvent.click(await screen.findByRole("button", { name: /Source sweep/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Provider timed out");
  fireEvent.click(screen.getByRole("button", { name: "Run now" }));
  await waitFor(() => expect(posts[0]).toEqual({ path: "routines/run", body: { profile: "research-desk", id: "b2" } }));
  fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
  expect(posts).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Delete routine" }));
  await waitFor(() => expect(posts[1]).toEqual({ path: "routines/delete", body: { profile: "research-desk", id: "b2" } }));
});

it("describes schedules and results in plain words", () => {
  expect(scheduleText({ kind: "weekly", time: "09:00", days: [5, 1] })).toBe("Mon, Fri at 09:00");
  expect(scheduleText({ kind: "hourly", every: 1 })).toBe("Every hour");
  expect(scheduleText({ kind: "weekly", time: "09:00", days: [] })).toBe("Pick at least one day");
  expect(lastResult({ lastRun: null, lastStatus: null })).toBeNull();
  expect(lastResult({ lastRun: "x", lastStatus: "ok" })).toEqual({ text: "Ran fine", bad: false });
  expect(lastResult({ lastRun: "x", lastStatus: "blocked_config" })).toEqual({ text: "Blocked", bad: true });
  expect(lastResult({ lastRun: "x", lastStatus: "delivery_failed" })?.bad).toBe(true);
});

it("the proxy forwards the routine routes and nothing else under routines", () => {
  expect(permittedOperation("bridge", "GET", ["routines"])).toBe(true);
  for (const op of ["routines", "routines/update", "routines/run", "routines/delete"]) expect(permittedOperation("bridge", "POST", op.split("/"))).toBe(true);
  expect(permittedOperation("bridge", "POST", ["routines", "purge"])).toBe(false);
  expect(permittedOperation("bridge", "GET", ["routines", "run"])).toBe(false);
});
