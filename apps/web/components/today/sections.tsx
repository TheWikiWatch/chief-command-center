"use client";

import { friendlyError } from "@/lib/request";
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRightIcon } from "@/components/icons";
import { TaskRow } from "@/components/today/parts";
import { useAssistantName } from "@/lib/identity";
import { EASE, SPRING } from "@/lib/motion";
import { showToast } from "@/lib/toast-store";
import type { TodayItem } from "@/lib/ops";
import { OVERDUE_SHOWN, SOON_SHOWN, STALE_DAYS, staleMessage, type TodaySections } from "@/lib/today-sections";

/* Today → "Do first", in sections: Today (never cut off), Overdue, Coming up, and the Stale pile folded away. */

type RowProps = { selectedTitle?: string; onOpen: (item: TodayItem) => void; animate: boolean };

function Heading({ title, count, hint }: { title: string; count?: number; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 mt-5 flex items-baseline gap-2 px-0.5 first:mt-1">
      <h3 className="text-callout font-semibold text-fg-2">{title}</h3>
      {count ? <span className="font-mono text-code tabular text-fg-3">{count}</span> : null}
      {hint ? <span className="ml-auto truncate text-caption text-fg-3">{hint}</span> : null}
    </div>
  );
}

function Rows({ items, start, selectedTitle, onOpen, animate }: RowProps & { items: TodayItem[]; start: number }) {
  return (
    <ol className="-mx-3.5 border-y border-line">
      {items.map((item, i) => (
        <motion.li
          key={item.id}
          className="border-b border-line last:border-b-0"
          initial={animate ? { opacity: 0, y: 10 } : false}
          animate={{ opacity: 1, y: 0, transition: { delay: animate ? 0.25 + Math.min(start + i, 8) * 0.04 : 0, duration: 0.32, ease: EASE.enter } }}
        >
          <TaskRow item={item} rank={start + i + 1} selected={selectedTitle === item.text} onClick={() => onOpen(item)} />
        </motion.li>
      ))}
    </ol>
  );
}

function More({ total, shown, open, onToggle, noun }: { total: number; shown: number; open: boolean; onToggle: () => void; noun: string }) {
  if (total <= shown) return null;
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="press mt-1.5 min-h-9 w-full rounded-ctl text-caption font-medium text-fg-3 hover:text-fg-2">
      {open ? "Show fewer" : `Show all ${total} ${noun}`}
    </button>
  );
}

export function TodaySectionsList({ sections, onSendToChief, ...row }: RowProps & { sections: TodaySections; onSendToChief?: (text: string) => Promise<void> }) {
  const assistant = useAssistantName();
  const [allOverdue, setAllOverdue] = useState(false);
  const [allSoon, setAllSoon] = useState(false);
  const [staleOpen, setStaleOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState(false);
  const { today, overdue, stale, soon } = sections;
  const overdueShown = allOverdue ? overdue : overdue.slice(0, OVERDUE_SHOWN);
  const soonShown = allSoon ? soon : soon.slice(0, SOON_SHOWN);

  async function askAboutStale() {
    if (!onSendToChief) return;
    setAsking(true);
    try {
      await onSendToChief(staleMessage(stale));
      setAsked(true);
      showToast({ title: `Sent to ${assistant}`, body: "Suggestions first; nothing changes until you say so.", tone: "ok", icon: "check" });
    } catch (e) {
      showToast({ title: `Couldn't send to ${assistant}`, body: friendlyError(e, "Try again."), tone: "warn", icon: "alert" });
    } finally {
      setAsking(false);
    }
  }

  return (
    <div>
      <Heading title="Today" count={today.length} />
      {today.length ? (
        <Rows items={today} start={0} {...row} />
      ) : (
        <p className="-mx-3.5 border-y border-line px-3.5 py-3 text-callout text-fg-3">Nothing due today.</p>
      )}

      {overdue.length ? (
        <>
          <Heading title="Overdue" count={overdue.length} hint="Most recent first" />
          <Rows items={overdueShown} start={today.length} {...row} />
          <More total={overdue.length} shown={OVERDUE_SHOWN} open={allOverdue} onToggle={() => setAllOverdue((v) => !v)} noun="overdue" />
        </>
      ) : null}

      {soon.length ? (
        <>
          <Heading title="Coming up" count={soon.length} hint="Next 3 days and top priority" />
          <Rows items={soonShown} start={today.length + overdueShown.length} {...row} />
          <More total={soon.length} shown={SOON_SHOWN} open={allSoon} onToggle={() => setAllSoon((v) => !v)} noun="coming up" />
        </>
      ) : null}

      {stale.length ? (
        <div className="mt-5 overflow-hidden rounded-card border border-line bg-card">
          <button
            type="button"
            onClick={() => setStaleOpen((v) => !v)}
            aria-expanded={staleOpen}
            className="press flex min-h-12 w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-fill-1"
          >
            <motion.span animate={{ rotate: staleOpen ? 90 : 0 }} transition={SPRING.snappy} className="shrink-0 text-fg-4">
              <ChevronRightIcon size={15} />
            </motion.span>
            <span className="min-w-0 flex-1">
              <span className="block text-callout font-medium text-fg-2">
                Stale <span className="font-mono text-code tabular text-fg-3">{stale.length}</span>
              </span>
              <span className="block truncate text-caption text-fg-3">More than {STALE_DAYS} days overdue: re-date them, park them, or close them</span>
            </span>
          </button>
          <AnimatePresence initial={false}>
            {staleOpen ? (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1, transition: SPRING.gentle }}
                exit={{ height: 0, opacity: 0, transition: { duration: 0.16 } }}
                className="overflow-hidden"
              >
                <div className="border-t border-line px-3.5 pb-3 pt-1">
                  <Rows items={stale} start={today.length + overdueShown.length + soonShown.length} {...row} animate={false} />
                  {onSendToChief ? (
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <button
                        type="button"
                        onClick={() => void askAboutStale()}
                        disabled={asking || asked}
                        className="press inline-flex min-h-10 items-center rounded-full bg-fg px-4 text-callout font-semibold text-canvas disabled:bg-fill-3 disabled:text-fg-3"
                      >
                        {asked ? `Sent to ${assistant}` : asking ? "Sending…" : `Ask ${assistant} to sort these`}
                      </button>
                      <span className="min-w-0 flex-1 text-caption text-fg-3">{assistant} suggests a new date or parking for each; nothing changes until you OK it.</span>
                    </div>
                  ) : null}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}
    </div>
  );
}
