"use client";

import { motion } from "motion/react";
import { ChevronLeftIcon } from "@/components/icons";
import { EASE } from "@/lib/motion";
import { pulseLine, type Board, type FocusCard, type Pulse, type TaskCard } from "@/lib/ops";

/* Today → one area: its focus line, counts and open columns. */

export function AreaDrill({
  board,
  focus,
  pulse,
  query,
  selectedId,
  onBack,
  onTask,
}: {
  board: Board;
  focus?: FocusCard;
  pulse: Pulse | null;
  query: string;
  selectedId?: string;
  onBack: () => void;
  onTask: (card: TaskCard) => void;
}) {
  const q = query.trim().toLowerCase();
  return (
    <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0, transition: { duration: 0.26, ease: EASE.enter } }}>
      <button type="button" className="press -ml-2 mb-1 flex min-h-11 items-center gap-1 rounded-full pl-1 pr-3 text-callout text-fg-2 hover:text-fg" onClick={onBack}>
        <ChevronLeftIcon size={18} />
        Today
      </button>
      <div className="flex items-center gap-2.5">
        <span className="h-3 w-3 rounded-full" style={{ background: board.color }} />
        <h2 className="text-display text-fg">{board.ui_label}</h2>
      </div>
      <p className="mb-3 mt-1.5 text-body text-fg-3">{focus?.next_human || focus?.pressure || `${board.open_count} open`}</p>
      <div className="mb-4 flex flex-wrap gap-2 text-caption">
        <span className="rounded-full border border-line-2 px-2.5 py-1 text-fg-2">
          <span className="font-mono tabular">{board.open_count}</span> open
        </span>
        {board.overdue_count ? (
          <span className="rounded-full bg-danger/15 px-2.5 py-1 text-danger">
            <span className="font-mono tabular">{board.overdue_count}</span> overdue
          </span>
        ) : null}
        {board.waiting_count ? (
          <span className="rounded-full bg-warn/15 px-2.5 py-1 text-warn">
            <span className="font-mono tabular">{board.waiting_count}</span> waiting
          </span>
        ) : null}
        {pulse?.grand != null ? (
          <span className="rounded-full border border-line-2 px-2.5 py-1 text-fg-2">
            <span className="tabular">{pulseLine(pulse, { short: true }).detail}</span>
          </span>
        ) : null}
      </div>
      {OPEN_COLS.map((name) => {
        const col = board.columns[name];
        if (!col) return null;
        const cards = (col.cards || []).filter((c) => {
          if (c.checked) return false;
          if (!q) return true;
          return `${c.text} ${c.column} ${board.ui_label}`.toLowerCase().includes(q);
        });
        if ((name === "Backlog" || name === "In Progress") && cards.length === 0) return null;
        return (
          <section key={name} className="mb-4">
            <h3 className="mb-1.5 flex items-center gap-2 px-1 text-callout font-medium text-fg-2">
              {name === "Waiting On" ? "Waiting" : name}
              <span className="font-mono text-code tabular text-fg-3">{cards.length}</span>
            </h3>
            {cards.length === 0 ? (
              <div className="rounded-card border border-dashed border-line-2 px-4 py-3 text-callout text-fg-3">Nothing here</div>
            ) : (
              <ul className="overflow-hidden rounded-card border border-line bg-card">
                {cards.map((card) => {
                  const overdue = (card.overdue_days ?? 0) > 0;
                  return (
                    <li key={card.id} className="border-b border-line last:border-b-0">
                      <button
                        type="button"
                        className={`press block w-full px-3.5 py-3 text-left hover:bg-fill-1 ${selectedId === card.id ? "bg-fill-2" : ""}`}
                        onClick={() => onTask(card)}
                      >
                        <span className="block text-body font-medium text-fg">{card.text}</span>
                        <span className={`mt-0.5 block text-caption ${overdue ? "font-medium text-danger" : "text-fg-3"}`}>
                          {card.due ? (overdue ? `${card.overdue_days}d overdue` : card.due) : card.column}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </motion.div>
  );
}

export const OPEN_COLS = ["In Progress", "This Week", "Waiting On", "Next Week", "Backlog"];
