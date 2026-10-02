"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { CircleAlertIcon } from "@/components/icons";
import { useAssistantName } from "@/lib/identity";
import { money, tokens, usageApi, type UsageDay, type UsagePeriod, type UsageSummary } from "@/lib/usage-client";
import { btn } from "@/components/ui/button";

const PERIODS: { id: UsagePeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "This month" },
];

/**
 * Settings → Usage: what the chief and every bot spent (tokens and cost, from Hermes's own records), by day,
 * bot and model, and the monthly budget. Costs are Hermes's estimates from its pricing snapshot unless the
 * provider reported the actual cost; a provider with no price is counted, never shown as free.
 */
export function UsagePage() {
  const assistant = useAssistantName();
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    usageApi
      .summary(period)
      .then((r) => (r.ok ? setData(r) : setError(r.error || "Couldn't read usage.")))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't read usage."));
  }, [period]);
  useEffect(load, [load]);

  const t = data?.totals;
  const cacheShare = t && t.input + t.cacheRead ? t.cacheRead / (t.input + t.cacheRead) : 0;
  return (
    <div className="space-y-6">
      <div role="radiogroup" aria-label="Period" className="flex w-fit gap-1 rounded-full border border-line bg-card p-1">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={period === p.id}
            onClick={() => setPeriod(p.id)}
            className={`min-h-9 rounded-full px-3.5 text-callout font-medium transition-colors ${period === p.id ? "bg-fill-3 text-fg" : "text-fg-3 hover:text-fg-2"}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="flex items-start gap-2 text-callout text-danger">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
      {!data && !error ? <p className="text-callout text-fg-3">Reading usage…</p> : null}

      {data && t ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tile label="Spend" value={money(t.cost)} note={t.unpriced ? `+ ${t.unpriced} unpriced ${t.unpriced === 1 ? "session" : "sessions"}` : "estimated by Hermes"} />
            <Tile label="Tokens" value={tokens(t.tokens)} note={`${tokens(t.input)} in · ${tokens(t.output)} out`} />
            <Tile label="From cache" value={`${Math.round(cacheShare * 100)}%`} note="of input, billed at the cache rate" />
          </div>

          {period !== "today" ? <DailyChart days={data.daily} /> : null}
          {period !== "today" && data.exactSince && data.since !== undefined && data.since < data.exactSince ? (
            <p className="-mt-3 px-1 text-caption text-fg-3">
              Days before {new Date(data.exactSince * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })} are estimated from when{" "}
              {assistant} replied; from then on each call counts on the day it was made.
            </p>
          ) : null}

          <section aria-labelledby="usage-bots" className="space-y-2">
            <h3 id="usage-bots" className="text-headline text-fg">
              By bot
            </h3>
            <Breakdown
              rows={data.bots.map((b) => ({ key: b.id, label: b.name, cost: b.cost, tokens: b.tokens, extra: `${b.sessions} ${b.sessions === 1 ? "session" : "sessions"}` }))}
              total={t.cost}
              empty="No bot used anything in this period."
            />
          </section>

          <section aria-labelledby="usage-models" className="space-y-2">
            <h3 id="usage-models" className="text-headline text-fg">
              By model
            </h3>
            <Breakdown
              rows={data.models.map((m) => ({
                key: `${m.provider || ""}:${m.model}`,
                label: m.model,
                sub: m.providerName || m.provider,
                cost: m.cost,
                tokens: m.tokens,
                extra: m.unpriced ? "no price known" : `${m.calls} calls`,
              }))}
              total={t.cost}
              empty="No model calls in this period."
              mono
            />
          </section>

          <Budget summary={data} onSaved={load} />
        </>
      ) : null}
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-card border border-line bg-card px-4 py-3">
      <p className="text-caption font-medium text-fg-3">{label}</p>
      <p className="mt-1 text-title tabular text-fg">{value}</p>
      <p className="mt-0.5 text-caption text-fg-3">{note}</p>
    </div>
  );
}

function dayLabel(day: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

/** Spend per day: one series, thin bars on a recessive grid, a tooltip per bar, and a table for screen readers. */
function DailyChart({ days }: { days: UsageDay[] }) {
  const titleId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.cost), 0);
  const top = max > 0 ? niceCeil(max) : 0.01;
  const H = 140;
  const ticks = [top, top / 2, 0];
  const shown = hover !== null ? days[hover] : null;
  return (
    <section aria-labelledby={titleId} className="rounded-card border border-line bg-card px-4 pb-3 pt-3">
      <div className="flex items-baseline justify-between">
        <h3 id={titleId} className="text-headline text-fg">
          Spend per day
        </h3>
        <p className="text-caption tabular text-fg-3" aria-live="polite">
          {shown ? `${dayLabel(shown.day, { weekday: "short", month: "short", day: "numeric" })} · ${money(shown.cost)} · ${tokens(shown.tokens)} tokens` : " "}
        </p>
      </div>
      <div className="relative mt-3 flex gap-2" aria-hidden="true">
        <div className="flex w-12 shrink-0 flex-col justify-between text-right text-caption tabular text-fg-3" style={{ height: H }}>
          {ticks.map((v) => (
            <span key={v} className="-translate-y-1/2 leading-none first:translate-y-0 last:translate-y-0">
              {money(v)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" style={{ height: H }} onMouseLeave={() => setHover(null)}>
          {ticks.map((v, i) => (
            <span key={v} className="absolute inset-x-0 border-t border-(--line-1)" style={{ top: (i * H) / 2 }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {days.map((d, i) => (
              <div
                key={d.day}
                className="relative flex h-full min-w-0 flex-1 items-end"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
              >
                <div
                  className={`w-full rounded-t-[4px] transition-opacity ${hover === null || hover === i ? "opacity-100" : "opacity-45"} bg-data`}
                  style={{ height: d.cost > 0 ? Math.max(2, (d.cost / top) * H) : 0 }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex justify-between pl-14 text-caption text-fg-3" aria-hidden="true">
        <span>{dayLabel(days[0]?.day || "")}</span>
        {days.length > 2 ? <span>{dayLabel(days[Math.floor(days.length / 2)].day)}</span> : null}
        {days.length > 1 ? <span>{dayLabel(days[days.length - 1].day)}</span> : null}
      </div>
      <table className="sr-only">
        <caption>Spend per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Spend</th>
            <th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{dayLabel(d.day)}</td>
              <td>{money(d.cost)}</td>
              <td>{tokens(d.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** A round number at or above `v` for the chart's top line (1, 2 or 5 times a power of ten). */
function niceCeil(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function Breakdown({
  rows,
  total,
  empty,
  mono,
}: {
  rows: { key: string; label: string; sub?: string; cost: number; tokens: number; extra: string }[];
  total: number;
  empty: string;
  mono?: boolean;
}) {
  const used = rows.filter((r) => r.tokens > 0 || r.cost > 0);
  if (!used.length) return <p className="text-callout text-fg-3">{empty}</p>;
  return (
    <ul className="divide-y divide-(--line-1) overflow-hidden rounded-card border border-line bg-card">
      {used.map((r) => {
        const share = total > 0 ? r.cost / total : 0;
        return (
          <li key={r.key} className="px-4 py-2.5">
            <div className="flex items-baseline gap-3">
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className={`min-w-0 truncate text-callout text-fg ${mono ? "font-mono text-code" : ""}`}>{r.label}</span>
                {r.sub ? <span className="shrink-0 text-caption text-fg-3">{r.sub}</span> : null}
              </span>
              <span className="text-callout tabular text-fg">{money(r.cost)}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill-2" aria-hidden="true">
                <div className="h-full rounded-full bg-data" style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
              </div>
              <span className="w-40 shrink-0 text-right text-caption tabular text-fg-3">
                {tokens(r.tokens)} tokens · {r.extra}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Budget({ summary, onSaved }: { summary: UsageSummary; onSaved: () => void }) {
  const inputId = useId();
  const b = summary.budget;
  const [draft, setDraft] = useState(b.monthly ? String(b.monthly) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setDraft(b.monthly ? String(b.monthly) : ""), [b.monthly]);
  async function save(value: number | null) {
    setBusy(true);
    setError("");
    try {
      const res = await usageApi.setBudget(value);
      if (!res.ok) throw new Error(res.error || "The budget wasn't saved.");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The budget wasn't saved.");
    } finally {
      setBusy(false);
    }
  }
  const ratio = b.ratio ?? 0;
  const tone = b.state === "over" ? "bg-danger" : b.state === "warn" ? "bg-warn" : "bg-ok";
  return (
    <section aria-labelledby={`${inputId}-h`} className="space-y-2">
      <h3 id={`${inputId}-h`} className="text-headline text-fg">
        Monthly budget
      </h3>
      <div className="space-y-3 rounded-card border border-line bg-card px-4 py-3">
        {b.monthly ? (
          <div>
            <div className="flex items-baseline justify-between text-callout">
              <span className="text-fg">
                {money(b.spent)} of {money(b.monthly)} this month
              </span>
              <span className={`tabular ${b.state === "over" ? "text-danger" : b.state === "warn" ? "text-warn" : "text-fg-3"}`}>
                {b.state === "over" ? "Over budget" : b.state === "warn" ? "Near the budget" : `${Math.round(ratio * 100)}%`}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-fill-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(ratio, 1) * 100)} aria-label="Budget used">
              <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
            </div>
          </div>
        ) : (
          <p className="text-callout text-fg-3">No budget set. This month so far: {money(summary.month.cost)}.</p>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(draft);
            void save(draft.trim() && Number.isFinite(n) && n > 0 ? n : null);
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Monthly budget in dollars
          </label>
          <div className="flex min-h-10 items-center rounded-ctl border border-line-2 bg-canvas pl-3 focus-within:border-line-3">
            <span className="text-callout text-fg-3">$</span>
            <input
              id={inputId}
              inputMode="decimal"
              value={draft}
              onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="20"
              className="w-24 bg-transparent px-1.5 text-callout tabular text-fg outline-hidden"
            />
            <span className="pr-3 text-caption text-fg-3">a month</span>
          </div>
          <button type="submit" disabled={busy} className={btn("primary", "md")}>
            {busy ? "Saving…" : "Save"}
          </button>
          {b.monthly ? (
            <button type="button" disabled={busy} onClick={() => void save(null)} className="press min-h-10 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg">
              Remove
            </button>
          ) : null}
        </form>
        <p className="text-caption text-fg-3">The usage strip turns amber at 80 %, and you get one notification when a month passes the budget. Nothing is ever stopped.</p>
        {error ? (
          <p role="alert" className="text-callout text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
