import { requestJson } from "@/lib/request";

/** Token use and cost for the chief and every bot (bridge contract chief.usage.v1). */
export type UsagePeriod = "today" | "7d" | "30d" | "month";
export type UsageTotals = {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  tokens: number;
  calls: number;
  sessions: number;
  /** Sessions whose provider has no price: their cost is unknown, not zero. */
  unpriced: number;
};
export type UsageBot = UsageTotals & { id: string; name: string };
/** One model through one provider: spend follows the model each call used, even after a mid-conversation switch. */
export type UsageModel = UsageTotals & { model: string; provider?: string; providerName?: string };
export type UsageDay = { day: string; cost: number; tokens: number; byBot: Record<string, number> };
export type UsageBudget = { monthly: number | null; spent: number; ratio: number | null; state: "none" | "ok" | "warn" | "over" };
export type UsageSummary = {
  ok: boolean;
  error?: string;
  period: UsagePeriod;
  /** Unix seconds: the start of the period. */
  since?: number;
  /** Unix seconds from which each call counts on the day it was made; earlier days are spread from the chief's replies. */
  exactSince?: number | null;
  totals: UsageTotals;
  today: UsageTotals;
  month: UsageTotals;
  bots: UsageBot[];
  models: UsageModel[];
  daily: UsageDay[];
  budget: UsageBudget;
};

export const usageApi = {
  summary: (period: UsagePeriod = "month") => requestJson<UsageSummary>(`/api/bridge/usage?period=${period}`, { cache: "no-store" }, 20_000),
  setBudget: (monthly: number | null) =>
    requestJson<{ ok: boolean; error?: string }>(
      "/api/bridge/usage/budget",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthly }) },
      15_000,
    ),
};

/** "$0.0042" for small amounts, "$1.32" otherwise. */
export function money(value: number): string {
  if (!value) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

/** 1.2M, 34k, 512. */
export function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/** Per-device: whether the usage strip shows under the galaxy. */
const STRIP_KEY = "chief-usage-strip";
export function readStripPref(): boolean {
  try {
    return localStorage.getItem(STRIP_KEY) === "1";
  } catch {
    return false;
  }
}
export function writeStripPref(on: boolean) {
  try {
    localStorage.setItem(STRIP_KEY, on ? "1" : "0");
  } catch {
    /* private mode: the toggle still works for this visit */
  }
}
