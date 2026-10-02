"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { BotFace, faceProps } from "@/components/bot-face";
import { EASE } from "@/lib/motion";
import { poll } from "@/lib/poll";
import { share } from "@/lib/share";
import type { Person } from "@/lib/types";
import { money, tokens, usageApi, type UsageSummary } from "@/lib/usage-client";

/**
 * The usage strip under the galaxy (switched on from the Fleet header): today's spend and tokens, this month
 * against the budget, and who spent most. Tapping it opens Settings → Usage. Refreshes every minute while shown.
 */
export function UsageStrip({ people, onOpen }: { people: Person[]; onOpen: () => void }) {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  // Once a minute, and not while the app is hidden (poll() slows hidden pages down).
  useEffect(
    () =>
      poll(async (signal) => {
        try {
          const r = await usageApi.summary("month");
          if (signal.aborted) return;
          setFailed(!r.ok);
          if (r.ok) setData((prev) => share(prev, r));
        } catch {
          if (!signal.aborted) setFailed(true);
        }
      }, 60_000),
    [],
  );

  const budget = data?.budget;
  const ratio = budget?.ratio ?? null;
  const tone = budget?.state === "over" ? "bg-danger" : budget?.state === "warn" ? "bg-warn" : "bg-data";
  const spenders = (data?.bots || []).filter((b) => b.cost > 0 || b.tokens > 0).slice(0, 3);
  const personFor = (id: string) => (id === "chief" ? people.find((p) => p.isChief) : people.find((p) => p.id === id));

  return (
    <motion.button
      type="button"
      onClick={onOpen}
      aria-label="Usage: open the details"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE.enter } }}
      exit={{ opacity: 0, y: 8, transition: { duration: 0.14 } }}
      className={`press glass flex w-full items-center gap-4 rounded-card px-4 py-2.5 text-left ${budget?.state === "warn" ? "ring-1 ring-warn/50" : budget?.state === "over" ? "ring-1 ring-danger/60" : ""}`}
    >
      {!data ? (
        <span className="text-callout text-fg-3">{failed ? "Usage isn't available right now." : "Reading usage…"}</span>
      ) : (
        <>
          <div className="shrink-0">
            <p className="text-caption text-fg-3">Today</p>
            <p className="text-callout tabular text-fg">
              {money(data.today.cost)} <span className="text-fg-3">· {tokens(data.today.tokens)}</span>
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-caption text-fg-3">This month</p>
              <p className="truncate text-caption tabular text-fg-3">
                {budget?.monthly ? `${money(data.month.cost)} of ${money(budget.monthly)}` : money(data.month.cost)}
              </p>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fill-3">
              <div className={`h-full rounded-full ${tone}`} style={{ width: `${ratio === null ? (data.month.cost > 0 ? 100 : 0) : Math.min(ratio, 1) * 100}%`, opacity: ratio === null ? 0.35 : 1 }} />
            </div>
          </div>
          <div className="hidden shrink-0 items-center gap-3 sm:flex">
            {spenders.map((b) => {
              const p = personFor(b.id);
              return (
                <span key={b.id} className="flex items-center gap-1.5" title={`${b.name}: ${money(b.cost)}, ${tokens(b.tokens)} tokens`}>
                  {p ? <BotFace {...faceProps(p)} size={20} still /> : null}
                  <span className="text-caption tabular text-fg-2">{money(b.cost)}</span>
                </span>
              );
            })}
          </div>
        </>
      )}
    </motion.button>
  );
}
