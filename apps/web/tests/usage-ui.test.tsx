import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { UsagePage } from "@/components/usage/usage-page";
import { UsageStrip } from "@/components/usage/usage-strip";
import { permittedOperation } from "@/lib/proxy-policy";
import { money, tokens, type UsageSummary, type UsageTotals } from "@/lib/usage-client";

const totals = (cost: number, tok: number, extra: Partial<UsageTotals> = {}): UsageTotals => ({
  cost,
  input: tok * 0.8,
  output: tok * 0.2,
  cacheRead: 0,
  reasoning: 0,
  tokens: tok,
  calls: 3,
  sessions: 2,
  unpriced: 0,
  ...extra,
});

function summary(budget: UsageSummary["budget"], period: UsageSummary["period"] = "month"): UsageSummary {
  return {
    ok: true,
    period,
    totals: totals(4.2, 120_000, { unpriced: 1 }),
    today: totals(0.35, 9_000),
    month: totals(4.2, 120_000),
    bots: [{ ...totals(3.1, 90_000), id: "chief", name: "Chief" }, { ...totals(1.1, 30_000), id: "research-desk", name: "Sam" }],
    models: [{ ...totals(4.2, 120_000), model: "tiny-local" }],
    daily: [
      { day: "2026-09-30", cost: 1.5, tokens: 50_000, byBot: {} },
      { day: "2026-10-01", cost: 2.7, tokens: 70_000, byBot: {} },
    ],
    budget,
  };
}

function route(budget: UsageSummary["budget"]) {
  const calls: { path: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1:3100");
      const path = url.pathname.replace("/api/bridge/", "");
      calls.push({ path: path + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "usage") return Response.json(summary(budget, (url.searchParams.get("period") || "month") as UsageSummary["period"]));
      if (path === "usage/budget") return Response.json({ ok: true });
      return Response.json({ ok: false }, { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows spend, tokens, a chart with a table, and who spent it", async () => {
  route({ monthly: null, spent: 4.2, ratio: null, state: "none" });
  render(<UsagePage />);
  expect(await screen.findByText("+ 1 unpriced session")).toBeInTheDocument();
  expect(screen.getAllByText("$4.20").length).toBeGreaterThan(0);
  expect(screen.getByText("+ 1 unpriced session")).toBeInTheDocument();
  expect(screen.getByText("120k")).toBeInTheDocument();
  expect(screen.getByRole("table")).toBeInTheDocument();
  const bots = screen.getByRole("heading", { name: "By bot" }).closest("section")!;
  expect(within(bots).getByText("Sam")).toBeInTheDocument();
  expect(screen.getByText(/No budget set/)).toBeInTheDocument();
});

it("changes the period and saves a budget", async () => {
  const calls = route({ monthly: null, spent: 4.2, ratio: null, state: "none" });
  render(<UsagePage />);
  await screen.findByText("+ 1 unpriced session");
  fireEvent.click(screen.getByRole("radio", { name: "Today" }));
  await waitFor(() => expect(calls.some((c) => c.path === "usage?period=today")).toBe(true));
  await waitFor(() => expect(screen.queryByRole("table")).toBeNull()); // no daily chart for one day
  fireEvent.change(screen.getByLabelText("Monthly budget in dollars"), { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls.find((c) => c.path === "usage/budget")?.body).toEqual({ monthly: 25 }));
});

it("warns near the budget, in words as well as colour", async () => {
  route({ monthly: 5, spent: 4.2, ratio: 0.84, state: "warn" });
  render(<UsagePage />);
  expect(await screen.findByText("Near the budget")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Budget used" })).toHaveAttribute("aria-valuenow", "84");
});

it("the strip shows today and the month against the budget, and opens the details", async () => {
  route({ monthly: 4, spent: 4.2, ratio: 1.05, state: "over" });
  const onOpen = vi.fn();
  render(<UsageStrip people={[]} onOpen={onOpen} />);
  const strip = await screen.findByRole("button", { name: "Usage: open the details" });
  await waitFor(() => expect(within(strip).getByText("$4.20 of $4.00")).toBeInTheDocument());
  expect(within(strip).getByText(/\$0\.35/)).toBeInTheDocument();
  fireEvent.click(strip);
  expect(onOpen).toHaveBeenCalled();
});

it("formats money and tokens compactly", () => {
  expect(money(0)).toBe("$0");
  expect(money(0.0042)).toBe("$0.0042");
  expect(money(12.5)).toBe("$12.50");
  expect(tokens(950)).toBe("950");
  expect(tokens(12_345)).toBe("12k");
  expect(tokens(1_250_000)).toBe("1.3M");
});

it("the proxy forwards usage and the budget", () => {
  expect(permittedOperation("bridge", "GET", ["usage"])).toBe(true);
  expect(permittedOperation("bridge", "POST", ["usage", "budget"])).toBe(true);
  expect(permittedOperation("bridge", "POST", ["usage"])).toBe(false);
});
