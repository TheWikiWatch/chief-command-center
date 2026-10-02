"use client";

import { motion } from "motion/react";
import { useMemo, type ReactNode } from "react";

import { EASE } from "@/lib/motion";
import type { Board, TaskCard } from "@/lib/ops";

/* Today on a wide pane: what's waiting on someone else, what's due this week, and the areas, beside "Do first". */

const LIMIT = 6;

type Row = { board: Board; card: TaskCard };

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The open cards in a board's "Waiting On" column, and the open cards due from today to a week out. */
export function sideLists(boards: Board[], skip: Set<string>, now = new Date()): { waiting: Row[]; week: Row[] } {
  const today = isoDay(now);
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  const weekEnd = isoDay(end);
  const waiting: Row[] = [];
  const week: Row[] = [];
  for (const board of boards) {
    for (const [name, col] of Object.entries(board.columns)) {
      for (const card of col.cards || []) {
        if (card.checked || card.cancelled) continue;
        if (name === "Waiting On") waiting.push({ board, card });
        else if (card.due && card.due >= today && card.due <= weekEnd && !skip.has(card.id)) week.push({ board, card });
      }
    }
  }
  week.sort((a, b) => a.card.due!.localeCompare(b.card.due!));
  return { waiting, week };
}

function dayLabel(due: string, now = new Date()): string {
  if (due === isoDay(now)) return "today";
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (due === isoDay(tomorrow)) return "tomorrow";
  const [y, m, d] = due.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}

function Section({ title, count, children, delay, animate }: { title: string; count?: number; children: ReactNode; delay: number; animate: boolean }) {
  return (
    <motion.section
      className="mb-6"
      initial={animate ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0, transition: { delay: animate ? delay : 0, duration: 0.3, ease: EASE.enter } }}
    >
      <h2 className="mb-2 flex items-baseline gap-2 text-headline text-fg">
        {title}
        {count ? <span className="font-mono text-code tabular text-fg-3">{count}</span> : null}
      </h2>
      {children}
    </motion.section>
  );
}

function CardList({ rows, trail, onTask, empty }: { rows: Row[]; trail: (row: Row) => string; onTask: (board: Board, card: TaskCard) => void; empty: string }) {
  if (!rows.length) return <p className="px-1 text-callout text-fg-3">{empty}</p>;
  return (
    <ul className="-mx-2">
      {rows.slice(0, LIMIT).map((row) => (
        <li key={`${row.board.board_name}:${row.card.id}`}>
          <button type="button" className="press flex min-h-10 w-full items-center gap-2.5 rounded-ctl px-2 text-left text-callout hover:bg-fill-1" onClick={() => onTask(row.board, row.card)}>
            <span className="size-2 shrink-0 rounded-full" style={{ background: row.board.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-fg-2">{row.card.text}</span>
            <span className="shrink-0 text-caption text-fg-3">{trail(row)}</span>
          </button>
        </li>
      ))}
      {rows.length > LIMIT ? <li className="px-2 pt-1 text-caption text-fg-3">and {rows.length - LIMIT} more</li> : null}
    </ul>
  );
}

export function TodaySide({
  boards,
  skip,
  animate,
  onTask,
  onArea,
}: {
  boards: Board[];
  /** Cards already in "Do first", left out of "Due this week". */
  skip: Set<string>;
  animate: boolean;
  onTask: (board: Board, card: TaskCard) => void;
  onArea: (boardName: string) => void;
}) {
  const { waiting, week } = useMemo(() => sideLists(boards, skip), [boards, skip]);
  return (
    <aside aria-label="This week">
      <Section title="Waiting on" count={waiting.length} delay={0.3} animate={animate}>
        <CardList rows={waiting} trail={(r) => r.board.ui_label} onTask={onTask} empty="Nothing waiting on anyone." />
      </Section>
      <Section title="Due this week" count={week.length} delay={0.36} animate={animate}>
        <CardList rows={week} trail={(r) => dayLabel(r.card.due!)} onTask={onTask} empty="Nothing else due this week." />
      </Section>
      {boards.length ? (
        <Section title="Areas" delay={0.42} animate={animate}>
          <ul className="-mx-2">
            {boards.map((board) => (
              <li key={board.board_name}>
                <button type="button" data-area={board.board_name} className="press flex min-h-10 w-full items-center gap-2.5 rounded-ctl px-2 text-left text-callout hover:bg-fill-1" onClick={() => onArea(board.board_name)}>
                  <span className="size-2 shrink-0 rounded-full" style={{ background: board.color }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-fg">{board.ui_label}</span>
                  {board.overdue_count ? <span className="shrink-0 font-mono text-code tabular text-danger">{board.overdue_count} late</span> : null}
                  <span className="w-6 shrink-0 text-right font-mono text-code tabular text-fg-3">{board.open_count}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </aside>
  );
}
