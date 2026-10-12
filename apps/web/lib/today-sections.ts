import type { Board, TaskCard, TodayItem } from "@/lib/ops";

/**
 * Today's "Do first" list, in sections, built from the boards (the same data the Areas use), so nothing due today
 * is ever cut off by old overdue cards (docs/PLAN-2026-10-12-today-and-peak.md).
 *
 * - Today: due today, and in progress. Never cut off.
 * - Overdue: 1 to STALE_DAYS days late, the most recent first.
 * - Stale: more than STALE_DAYS late. Folded away, one tap from asking the chief to re-date or park them.
 * - Coming up: due in the next SOON_DAYS days, and top-priority cards with no date in This Week or Next Week
 *   (not Backlog, which is parked on purpose, nor Waiting On).
 *
 * Read-only: sections only arrange cards; nothing here changes a board. Items a task service ranks itself
 * (pulse and focus items) lead the Today section as they come.
 */

export const STALE_DAYS = 14;
export const SOON_DAYS = 3;
export const OVERDUE_SHOWN = 5;
export const SOON_SHOWN = 6;

export type TodaySections = { today: TodayItem[]; overdue: TodayItem[]; stale: TodayItem[]; soon: TodayItem[] };

const OPEN = ["In Progress", "This Week", "Waiting On", "Next Week", "Backlog"];

function weekday(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
}

function item(board: Board, card: TaskCard, when: string, urgency: string, why: string): TodayItem {
  return {
    kind: "task",
    id: card.id,
    text: card.text,
    why,
    when_label: when,
    urgency,
    board_name: board.board_name,
    ui_label: board.ui_label,
    color: board.color,
    card: { ...card, board_name: board.board_name, ui_label: board.ui_label, color: board.color, board_file: board.board_file },
  };
}

const red = (i: TodayItem) => (i.card?.priority === "red" ? 0 : 1);
const late = (i: TodayItem) => i.card?.overdue_days ?? 0;

export function sectionToday(boards: Board[], serviceItems: TodayItem[] = []): TodaySections {
  const today: TodayItem[] = serviceItems.filter((i) => i.kind !== "task");
  const overdue: TodayItem[] = [];
  const stale: TodayItem[] = [];
  const soon: TodayItem[] = [];
  const seen = new Set<string>();
  for (const board of boards) {
    for (const column of OPEN) {
      for (const card of board.columns[column]?.cards ?? []) {
        if (card.checked || seen.has(card.id)) continue;
        seen.add(card.id);
        const waiting = column === "Waiting On";
        const days = card.due != null ? card.overdue_days : null;
        const tag = (label: string) => (waiting ? `waiting · ${label}` : label);
        if (days != null && days > STALE_DAYS) stale.push(item(board, card, tag(`${days}d overdue`), waiting ? "soon" : "hot", column));
        else if (days != null && days > 0) overdue.push(item(board, card, tag(`${days}d overdue`), waiting ? "soon" : "hot", column));
        else if (days === 0) today.push(item(board, card, tag("due today"), "soon", column));
        else if (column === "In Progress") today.push(item(board, card, "in progress", "normal", column));
        else if (days != null && -days <= SOON_DAYS) soon.push(item(board, card, tag(-days === 1 ? "tomorrow" : weekday(card.due!)), -days === 1 ? "soon" : "normal", column));
        else if (days == null && card.priority === "red" && (column === "This Week" || column === "Next Week")) soon.push(item(board, card, "top priority", "normal", column));
      }
    }
  }
  const byText = (a: TodayItem, b: TodayItem) => a.text.localeCompare(b.text);
  // Today: due today before in progress, top priority first. Overdue: most recent first. Stale: oldest last.
  const dueFirst = (i: TodayItem) => (i.kind !== "task" ? -1 : i.when_label.endsWith("due today") ? 0 : 1);
  today.sort((a, b) => dueFirst(a) - dueFirst(b) || red(a) - red(b) || byText(a, b));
  overdue.sort((a, b) => late(a) - late(b) || red(a) - red(b) || byText(a, b));
  stale.sort((a, b) => late(a) - late(b) || byText(a, b));
  const ahead = (i: TodayItem) => (i.card?.overdue_days != null && i.card.due ? -i.card.overdue_days : SOON_DAYS + 1);
  soon.sort((a, b) => ahead(a) - ahead(b) || red(a) - red(b) || byText(a, b));
  return { today, overdue, stale, soon };
}

/** What "Ask the chief" sends for the stale pile: suggestions first, nothing changed without the owner's OK. */
export function staleMessage(stale: TodayItem[]): string {
  const lines = stale.map((i) => `- ${i.text} (${i.ui_label}, ${i.when_label})`);
  return [
    `These ${stale.length} tasks are more than ${STALE_DAYS} days overdue on my boards:`,
    ...lines,
    "For each one, suggest either a realistic new date or parking it in Backlog with no date (or closing it if it's no longer relevant). Wait for my OK before you change any board.",
  ].join("\n");
}
