"use client";

import { useEffect, useState } from "react";

import { scheduleCopy, type ScheduleCheck } from "@/lib/deepseek-schedule";

/** Peak / off-peak pricing chip. `peakOnly` hides it while off-peak; `detail` adds the explanation. */
export function DeepseekChip({ peakOnly = false, detail = false }: { peakOnly?: boolean; detail?: boolean }) {
  const [now, setNow] = useState(() => new Date());
  const [check, setCheck] = useState<ScheduleCheck>("unverified");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let stop = false;
    const load = () => {
      fetch("/api/deepseek-schedule", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { status?: ScheduleCheck } | null) => {
          if (stop || !data?.status) return;
          if (data.status === "match" || data.status === "changed" || data.status === "unverified") setCheck(data.status);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 60 * 60 * 1000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  const copy = scheduleCopy(now, check);
  const changed = check === "changed";
  const peak = !changed && copy.phase === "peak";
  if (peakOnly && !peak && !changed) return null;

  const chip = (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        changed ? "border-line-2 text-fg-3" : peak ? "border-warn/40 bg-warn/10 text-warn" : "border-line-2 text-fg-3"
      }`}
      title={copy.detail}
      aria-label={copy.detail}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${peak ? "bg-warn" : "bg-fg-4"}`} aria-hidden />
      {copy.text}
    </span>
  );
  if (!detail) return chip;
  return (
    <span className="flex flex-col items-start gap-1.5">
      {chip}
      <span className="text-callout text-fg-3">{copy.detail}</span>
    </span>
  );
}
