"use client";

import { BotFace, faceProps } from "@/components/bot-face";
import { WrenchIcon } from "@/components/icons";
import { percent, type DeskCard } from "@/lib/fleet-health";
import { splitTitle } from "@/lib/names";
import type { Person } from "@/lib/types";
import { displayDesk } from "@/components/fleet-health";
import { MemoryBar, Sparkline } from "@/components/fleet-health/parts";

/* Fleet Health → each bot's desk card. */

export function DeskRow({ card, person }: { card: DeskCard; person?: Person }) {
  const s = card.last7;
  const success = s.success;
  const successTone = success == null ? "text-fg-3" : success >= 0.85 ? "text-ok" : success >= 0.6 ? "text-warn" : "text-danger";
  const name = displayDesk(card.desk, person);
  const role = person ? splitTitle(person.name).role : "";
  return (
    <li className="border-b border-line px-3 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        {person ? <BotFace {...faceProps(person)} size={34} still /> : <span className="grid size-[34px] place-items-center rounded-full bg-fill-2 text-fg-3"><WrenchIcon size={16} /></span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-body font-semibold text-fg">{name}</span>
            {card.blocked ? <span className="shrink-0 rounded-full bg-danger/15 px-1.5 py-0.5 text-caption font-medium text-danger">{card.blocked} blocked</span> : null}
          </div>
          <p className="truncate text-caption text-fg-3">
            {role ? <span className="hidden sm:inline">{role} · </span> : null}
            {s.done} done
            {s.crashed ? <span className="text-danger"> · {s.crashed} crashed</span> : null}
            {s.gaveUp ? <span className="text-danger"> · {s.gaveUp} gave up</span> : null}
            {s.medianMinutes != null ? ` · ${s.medianMinutes}m median` : ""}
          </p>
        </div>
        <Sparkline weeks={card.weeks} />
        <span className={`w-11 shrink-0 text-right font-mono text-callout tabular ${successTone}`} title="Success: done / (done + crashed + gave up), last 7 days">
          {percent(success)}
        </span>
      </div>
      <div className="mt-2 grid gap-1 pl-[46px] sm:grid-cols-2 sm:gap-x-4">
        <MemoryBar used={card.memory.memory} limit={card.memory.memoryLimit} label="Memory" />
        <MemoryBar used={card.memory.user} limit={card.memory.userLimit} label="User" />
      </div>
    </li>
  );
}
