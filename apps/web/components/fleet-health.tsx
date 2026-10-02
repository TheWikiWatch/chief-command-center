"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { BotFace, faceProps } from "@/components/bot-face";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ClockIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SparklesIcon,
  WrenchIcon,
  XIcon,
} from "@/components/icons";
import { HoldButton } from "@/components/ui/hold-button";
import {
  approvalMessage,
  decideProposal,
  fetchFleetHealth,
  fetchSkillDiff,
  fill,
  flagMessage,
  kb,
  markFlagsSeen,
  percent,
  refreshFleetHealth,
  revertSkillChange,
  type DeskCard,
  type Episode,
  type Flag,
  type FleetHealth as Health,
  type Proposal,
  type SkillChange,
  type SkillSummary,
  type Verdict,
} from "@/lib/fleet-health";
import { EASE, SPRING } from "@/lib/motion";
import { splitTitle } from "@/lib/names";
import { poll } from "@/lib/poll";
import { share } from "@/lib/share";
import { showToast } from "@/lib/toast-store";
import type { Person } from "@/lib/types";
import { useAssistantName } from "@/lib/identity";
import { btn } from "@/components/ui/button";

/** Dismissals from before decisions were shared (2026-09-29); sent to the server once, then cleared. */
const LEGACY_DISMISSED_KEY = "chief-fleet-dismissed";
const SKILLS_FOLDED = 8;

function ago(seconds: number) {
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400 * 2) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
const agoAt = (epochSeconds: number | null | undefined) => (epochSeconds ? ago(Date.now() / 1000 - epochSeconds) : "never");
const agoIso = (iso: string | null | undefined) => (iso ? agoAt(Date.parse(iso) / 1000) : "never");
const day = (epochSeconds: number) => new Date(epochSeconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Fleet Health (an optional connector): what needs the owner's eyes (flags), desk
 * scorecards, the skills the fleet rewrote grouped with before/after verdicts per episode, runtime
 * health, and the weekly distill's proposals. Reads the learning ledger's report; Revert and Refresh
 * run the ledger; Approve sends the proposal to the chief and records the decision for every device.
 */
export function FleetHealth({
  people,
  phone = false,
  onSendToChief,
}: {
  people: Person[];
  phone?: boolean;
  onSendToChief?: (text: string) => Promise<void>;
}) {
  const assistant = useAssistantName();
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(
    () =>
      poll(async (signal) => {
        try {
          const next = await fetchFleetHealth(signal);
          if (signal.aborted) return;
          setData((prev) => share(prev, next));
          setError("");
        } catch (e) {
          if (!signal.aborted) setError(e instanceof Error ? e.message : "Fleet health is unavailable");
        }
      }, 60_000),
    [tick],
  );

  // Looking at Health clears the badge for the flags on screen.
  const flagIds = (data?.flags || []).map((f) => f.id).join("|");
  useEffect(() => {
    if (flagIds) markFlagsSeen(flagIds.split("|"));
  }, [flagIds]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await refreshFleetHealth();
      if (!res.ok) throw new Error(res.error || "Refresh failed");
      setTick((n) => n + 1);
    } catch (e) {
      showToast({ title: "Couldn't refresh", body: e instanceof Error ? e.message : "The ledger failed", tone: "warn", icon: "alert" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  if (!data) {
    return (
      <div className="px-4 py-6">
        {error ? (
          <EmptyCard icon={<CircleAlertIcon size={22} />} title="Fleet health isn't available" body={error} action={<RefreshButton busy={refreshing} onClick={refresh} label="Run the ledger now" />} />
        ) : (
          <div className="space-y-3" role="status" aria-label="Loading fleet health">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[74px] rounded-card bg-fill-1" />
              ))}
            </div>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-14 rounded-card bg-fill-1" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const active = data.desks.filter((d) => d.cards30 > 0 || d.last7.done + d.last7.crashed + d.last7.gaveUp > 0 || d.blocked > 0);
  const idle = data.desks.filter((d) => !active.includes(d));
  const done7 = data.desks.reduce((n, d) => n + d.last7.done, 0);
  const flags = data.flags || [];
  const skills = data.skills;

  function showSkill(key: string) {
    setOpenSkill(key);
    window.requestAnimationFrame(() => document.getElementById(skillAnchor(key))?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <div className={`mx-auto max-w-3xl px-4 pb-10 ${phone ? "pt-3" : "pt-2"}`}>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="Cards done · 7d" value={done7} />
        <Tile label="Crashes · 24h" value={data.runtime.crashes24h} tone={data.runtime.crashes24h ? "danger" : undefined} note={`${data.runtime.crashes7d} in 7 days`} />
        <Tile label="Compactions today" value={data.runtime.compactionsToday} note={`${assistant}'s context`} />
        <Tile label="Skill changes · 7d" value={data.changes7d} note="made by the fleet" />
      </div>

      <div className="mt-3 flex items-center gap-2 text-caption text-fg-3">
        <ClockIcon size={13} />
        <span className={data.ageSeconds > 3 * 3600 ? "text-warn" : undefined}>Updated {ago(data.ageSeconds)}</span>
        <span className="ml-auto">
          <RefreshButton busy={refreshing} onClick={refresh} label="Refresh" small />
        </span>
      </div>

      {flags.length ? (
        <Section title="Needs a look" count={flags.length} hint="Nothing changes until you act">
          <ul className="space-y-2">
            {flags.map((f) => (
              <FlagRow key={f.id} flag={f} onShowSkill={showSkill} onSendToChief={onSendToChief} />
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Desks" count={active.length} hint="Last 7 days · cards done per week">
        <ul className="overflow-hidden rounded-card border border-line bg-card">
          {active.map((d) => (
            <DeskRow key={d.desk} card={d} person={byId.get(d.desk)} />
          ))}
        </ul>
        {idle.length ? (
          <p className="mt-2 px-1 text-caption text-fg-3">
            No work in 30 days: {idle.map((d) => displayDesk(d.desk, byId.get(d.desk))).join(", ")}
          </p>
        ) : null}
      </Section>

      {skills ? (
        <Skills skills={skills} open={openSkill} onOpen={setOpenSkill} onReverted={reload} />
      ) : (
        <Section title="Learning" count={data.changes.length} hint="Skills the fleet changed">
          {data.changes.length ? (
            <ul className="space-y-2">
              {data.changes.map((c) => (
                <ChangeRow key={c.id} change={c} title={c.skill?.split("/").pop() || c.file} onReverted={reload} />
              ))}
            </ul>
          ) : (
            <EmptyCard icon={<SparklesIcon size={20} />} title="No skill changes recorded yet" body={`Changes appear here as background review and ${assistant} edit skills.`} />
          )}
        </Section>
      )}

      <Section title="Runtime" hint="Crashes of Hermes and the app, from the Windows event log">
        <RuntimeCard health={data} />
      </Section>

      <Section title="Proposals" count={data.proposals.filter((p) => !p.status || p.status === "open").length} hint="From the weekly distill · Sundays 5pm">
        <Proposals items={data.proposals} onSendToChief={onSendToChief} onDecided={reload} />
      </Section>
    </div>
  );
}

function displayDesk(desk: string, person?: Person) {
  return person ? splitTitle(person.name).name || person.name : desk;
}

const skillAnchor = (key: string) => `skill-${key.replace(/[^\w-]/g, "-")}`;

function Section({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h2 className="text-headline text-fg">{title}</h2>
        {count != null ? <span className="font-mono text-code tabular text-fg-3">{count}</span> : null}
        {hint ? <span className="ml-auto truncate text-caption text-fg-3">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, value, note, tone }: { label: string; value: number; note?: string; tone?: "danger" | "warn" }) {
  const color = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-fg";
  return (
    <div className="rounded-card border border-line bg-card px-3.5 py-3">
      <div className="truncate text-caption font-medium text-fg-3">{label}</div>
      <div className={`mt-0.5 font-mono text-[1.5rem] font-medium leading-8 tabular ${color}`}>{value}</div>
      {note ? <div className="truncate text-caption text-fg-3">{note}</div> : null}
    </div>
  );
}

function RefreshButton({ busy, onClick, label, small = false }: { busy: boolean; onClick: () => void; label: string; small?: boolean }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`press inline-flex items-center gap-1.5 rounded-full border border-line-2 text-fg-2 hover:border-line-3 hover:text-fg disabled:opacity-60 ${small ? "min-h-8 px-2.5 text-caption" : "min-h-11 px-4 text-callout font-medium"}`}
    >
      <RefreshCwIcon size={small ? 13 : 15} className={busy ? "animate-spin" : undefined} />
      {busy ? "Running…" : label}
    </button>
  );
}

function EmptyCard({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-card border border-dashed border-line-2 px-5 py-6 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-fill-2 text-fg-3">{icon}</span>
      <p className="mt-2.5 text-body font-medium text-fg">{title}</p>
      <p className="mt-1 max-w-sm text-callout text-fg-3">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

const SEVERITY: Record<string, string> = {
  danger: "border-danger/40 bg-danger/6",
  warn: "border-warn/30 bg-warn/5",
  info: "border-line bg-card",
};
const SEVERITY_DOT: Record<string, string> = { danger: "bg-danger", warn: "bg-warn", info: "bg-fg-3" };

function FlagRow({ flag: f, onShowSkill, onSendToChief }: { flag: Flag; onShowSkill: (key: string) => void; onSendToChief?: (text: string) => Promise<void> }) {
  const assistant = useAssistantName();
  const [sending, setSending] = useState(false);
  const [asked, setAsked] = useState(false);
  const message = flagMessage(f);

  async function ask() {
    if (!onSendToChief || !message) return;
    setSending(true);
    try {
      await onSendToChief(message);
      setAsked(true);
    } catch (e) {
      showToast({ title: `Couldn't send to ${assistant}`, body: e instanceof Error ? e.message : "Try again", tone: "warn", icon: "alert" });
    } finally {
      setSending(false);
    }
  }

  return (
    <li className={`rounded-card border px-3.5 py-3 ${SEVERITY[f.severity] || SEVERITY.info}`}>
      <div className="flex items-start gap-2.5">
        <span className={`mt-[7px] size-2 shrink-0 rounded-full ${SEVERITY_DOT[f.severity] || SEVERITY_DOT.info}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-fg">{f.title}</p>
          {f.detail ? <p className="mt-0.5 text-caption text-fg-3">{f.detail}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {f.skill ? (
              <button type="button" onClick={() => onShowSkill(f.skill!)} className="press inline-flex min-h-9 items-center rounded-full border border-line-2 px-3 text-caption font-medium text-fg-2 hover:text-fg">
                Show changes
              </button>
            ) : null}
            {message ? (
              <button
                type="button"
                disabled={!onSendToChief || sending || asked}
                onClick={() => void ask()}
                className="press inline-flex min-h-9 items-center gap-1.5 rounded-full bg-fg px-3 text-caption font-semibold text-canvas disabled:bg-fill-3 disabled:text-fg-3"
              >
                {asked ? <CheckIcon size={13} /> : null}
                {asked ? `Sent to ${assistant}` : sending ? "Sending…" : `Ask ${assistant}`}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

function Sparkline({ weeks }: { weeks: number[] }) {
  const max = Math.max(1, ...weeks);
  const w = 6;
  const gap = 3;
  return (
    <svg width={weeks.length * (w + gap) - gap} height={20} aria-hidden="true" className="shrink-0">
      {weeks.map((n, i) => {
        const h = n ? Math.max(3, Math.round((n / max) * 20)) : 2;
        return <rect key={i} x={i * (w + gap)} y={20 - h} width={w} height={h} rx={1.5} className={i === weeks.length - 1 ? "fill-accent" : n ? "fill-fg-3" : "fill-white/10"} />;
      })}
    </svg>
  );
}

function MemoryBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const f = fill(used, limit);
  const tone = f >= 1 ? "bg-danger" : f >= 0.9 ? "bg-warn" : "bg-fg-3";
  return (
    <div className="flex items-center gap-2" title={`${label}: ${used} of ${limit} characters`}>
      <span className="w-12 text-caption text-fg-3">{label}</span>
      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-fill-2">
        <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${Math.round(f * 100)}%` }} />
      </span>
      <span className={`w-9 text-right font-mono text-caption tabular ${f >= 0.9 ? "text-warn" : "text-fg-3"}`}>{Math.round(f * 100)}%</span>
    </div>
  );
}

function DeskRow({ card, person }: { card: DeskCard; person?: Person }) {
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

const VERDICT: Record<string, string> = {
  helped: "bg-ok/15 text-ok",
  worse: "bg-danger/15 text-danger",
  "no clear change": "bg-fill-2 text-fg-2",
  confounded: "bg-warn/15 text-warn",
};

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-caption font-medium ${VERDICT[verdict.label] || "border border-line-2 text-fg-3"}`}>{verdict.label}</span>;
}

function verdictWhen(v: Verdict) {
  if (!v.judgeAt) return v.why || "";
  if (v.label === "too early") return `Judged ${day(v.judgeAt)} (14 days after the last edit)`;
  return v.why || "";
}

function Skills({ skills, open, onOpen, onReverted }: { skills: SkillSummary[]; open: string | null; onOpen: (key: string | null) => void; onReverted: () => void }) {
  const assistant = useAssistantName();
  const [all, setAll] = useState(false);
  const openIndex = open ? skills.findIndex((s) => s.key === open) : -1;
  const shown = all || openIndex >= SKILLS_FOLDED ? skills : skills.slice(0, SKILLS_FOLDED);
  return (
    <Section title="Learning" count={skills.length} hint="Skills changed in 30 days · most active first">
      {skills.length ? (
        <>
          <ul className="space-y-2">
            {shown.map((s) => (
              <SkillRow key={s.key} skill={s} open={open === s.key} onToggle={() => onOpen(open === s.key ? null : s.key)} onReverted={onReverted} />
            ))}
          </ul>
          {skills.length > shown.length ? (
            <button type="button" onClick={() => setAll(true)} className="press mt-2 min-h-10 w-full rounded-card border border-line text-callout text-fg-2 hover:text-fg">
              Show {skills.length - shown.length} more
            </button>
          ) : null}
        </>
      ) : (
        <EmptyCard icon={<SparklesIcon size={20} />} title="No skill changes in 30 days" body={`Changes appear here as background review and ${assistant} edit skills.`} />
      )}
    </Section>
  );
}

function SkillRow({ skill: s, open, onToggle, onReverted }: { skill: SkillSummary; open: boolean; onToggle: () => void; onReverted: () => void }) {
  const latest = s.episodes[0];
  const churn = s.edits48h >= 5 || s.edits7d >= 10;
  const growth = s.size14d ? Math.round((s.size / s.size14d - 1) * 100) : null;
  return (
    <li id={skillAnchor(s.key)} className="scroll-mt-16 overflow-hidden rounded-card border border-line bg-card">
      <button type="button" className="press flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-fill-1" onClick={onToggle} aria-expanded={open}>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-body font-medium text-fg">{s.name}</span>
            {latest ? <VerdictBadge verdict={latest.verdict} /> : null}
          </span>
          <span className="block truncate text-caption text-fg-3">
            {s.scope === "shared" ? "shared" : s.scope} · <span className={churn ? "font-medium text-warn" : undefined}>{s.edits7d} {s.edits7d === 1 ? "edit" : "edits"} in 7d</span>
            {s.edits48h ? ` (${s.edits48h} in 48h)` : ""} · {kb(s.size)}
            {growth != null && growth !== 0 ? <span className={growth >= 50 ? "text-warn" : undefined}> ({growth > 0 ? "+" : ""}{growth}% in 14d)</span> : null} · {agoAt(s.lastAt)}
          </span>
        </span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRING.snappy} className="shrink-0 text-fg-4">
          <ChevronRightIcon size={16} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: SPRING.gentle }} exit={{ height: 0, opacity: 0, transition: { duration: 0.16 } }} className="overflow-hidden">
            <div className="border-t border-line px-3 pb-3 pt-2">
              <p className="text-caption text-fg-3">
                {s.sources.review} by background review · {s.sources.outside} edited outside it · {s.edits30d} in 30 days
              </p>
              <ul className="mt-2 space-y-2">
                {s.episodes.map((ep) => (
                  <EpisodeRow key={ep.id} episode={ep} changes={s.changes.filter((c) => c.episode === ep.id)} onReverted={onReverted} />
                ))}
              </ul>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

function EpisodeRow({ episode: ep, changes, onReverted }: { episode: Episode; changes: SkillChange[]; onReverted: () => void }) {
  const [net, setNet] = useState(false);
  const span = day(ep.start) === day(ep.end) ? day(ep.end) : `${day(ep.start)} – ${day(ep.end)}`;
  // The net change of an episode, per file (usually just SKILL.md): the version before its first edit to now.
  const files = useMemo(() => {
    const byFile = new Map<string, { first: number; last: number }>();
    for (const c of changes) {
      const cur = byFile.get(c.file);
      byFile.set(c.file, { first: Math.min(cur?.first ?? c.id, c.id), last: Math.max(cur?.last ?? c.id, c.id) });
    }
    return [...byFile.entries()];
  }, [changes]);
  return (
    <li className="rounded-ctl border border-line bg-canvas/40 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-callout text-fg">
          {ep.edits} {ep.edits === 1 ? "edit" : "edits"} · {span}
        </span>
        <VerdictBadge verdict={ep.verdict} />
      </div>
      {verdictWhen(ep.verdict) ? <p className="mt-0.5 text-caption text-fg-3">{verdictWhen(ep.verdict)}</p> : null}
      {ep.edits > 1 && files.length ? (
        <button type="button" onClick={() => setNet((v) => !v)} aria-expanded={net} className="press mt-1.5 inline-flex min-h-8 items-center rounded-full border border-line-2 px-2.5 text-caption text-fg-2 hover:text-fg">
          {net ? "Hide net change" : "Net change"}
        </button>
      ) : null}
      {net
        ? files.map(([file, r]) => (
            <div key={file}>
              {files.length > 1 ? <p className="mt-2 font-mono text-caption text-fg-3">{file}</p> : null}
              <LazyDiff id={r.last} from={r.first} />
            </div>
          ))
        : null}
      {changes.length ? (
        <ul className="mt-2 space-y-1.5">
          {changes.map((c) => (
            <ChangeRow key={c.id} change={c} title={`${c.change} ${c.file}`} compact onReverted={onReverted} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ChangeRow({ change: c, title, compact = false, onReverted }: { change: SkillChange; title: string; compact?: boolean; onReverted: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Reverting an older change also undoes the later edits to that file: a first hold only arms it.
  const [armed, setArmed] = useState(false);
  const newer = c.newer || 0;
  useEffect(() => setArmed(false), [newer, open]);

  async function revert() {
    if (newer && !armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      const res = await revertSkillChange(c.id, newer);
      if (!res.ok) throw new Error(res.error || "Revert failed");
      showToast({ title: "Change reverted", body: res.message || `${title} is back to its earlier version`, tone: "ok", icon: "check" });
      onReverted();
    } catch (e) {
      showToast({ title: "Couldn't revert", body: e instanceof Error ? e.message : "The ledger failed", tone: "warn", icon: "alert" });
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }
  const later = `${newer} later ${newer === 1 ? "edit" : "edits"}`;

  return (
    <li className={`overflow-hidden border border-line ${compact ? "rounded-ctl bg-card" : "rounded-card bg-card"}`}>
      <button type="button" className={`press flex w-full items-center gap-3 text-left hover:bg-fill-1 ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${compact ? "text-callout text-fg-2" : "text-body font-medium text-fg"}`}>{title}</span>
          <span className="block truncate text-caption text-fg-3">
            #{c.id} · {agoAt(c.at)} · <span className="text-ok">+{c.added}</span> <span className="text-danger">−{c.removed}</span>
          </span>
        </span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRING.snappy} className="shrink-0 text-fg-4">
          <ChevronRightIcon size={15} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: SPRING.gentle }} exit={{ height: 0, opacity: 0, transition: { duration: 0.16 } }} className="overflow-hidden">
            <div className="border-t border-line px-3 pb-3 pt-2">
              <p className="text-caption text-fg-3">{c.source}</p>
              <LazyDiff id={c.id} />
              {c.canRevert ? (
                <div className="mt-3 flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
                  {newer ? (
                    <p className={`min-w-0 flex-1 text-caption ${armed ? "text-warn" : "text-fg-3"}`} role={armed ? "alert" : undefined}>
                      {armed
                        ? `This also undoes the ${later} to this file. Hold again to go back anyway.`
                        : `This file changed ${newer === 1 ? "once" : `${newer} times`} after this. Reverting goes back to before this change.`}
                    </p>
                  ) : null}
                  <HoldButton
                    className={`press inline-flex min-h-10 items-center gap-2 rounded-full border px-4 text-callout font-medium hover:text-fg ${armed ? "border-warn/60 text-warn" : "border-line-2 text-fg-2"}`}
                    disabled={busy}
                    ariaLabel={armed ? `Hold again to revert and undo ${later}` : "Hold to revert this change"}
                    holdingLabel="Keep holding…"
                    onConfirm={() => void revert()}
                  >
                    <RotateCcwIcon size={15} />
                    {busy ? "Reverting…" : armed ? `Undo ${later} too` : "Hold to revert"}
                  </HoldButton>
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

/** Diffs are fetched when opened (the report no longer carries 40 of them on every poll). */
function LazyDiff({ id, from }: { id: number; from?: number }) {
  const [state, setState] = useState<{ text?: string; error?: string }>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    fetchSkillDiff(id, from)
      .then((res) => alive.current && setState(res.ok ? { text: res.diff } : { error: res.error || "Couldn't load the diff" }))
      .catch((e) => alive.current && setState({ error: e instanceof Error ? e.message : "Couldn't load the diff" }));
    return () => {
      alive.current = false;
    };
  }, [id, from]);
  if (state.error) return <p className="mt-2 text-caption text-warn">{state.error}</p>;
  if (state.text == null) return <p className="mt-2 text-caption text-fg-3" role="status">Loading diff…</p>;
  return <DiffView text={state.text} />;
}

function DiffView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
  if (!lines.length || !text.trim()) return <p className="mt-2 text-caption text-fg-3">No text differences.</p>;
  return (
    <pre className="mt-2 max-h-72 overflow-auto rounded-ctl border border-line bg-canvas py-2 font-mono text-caption leading-5">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`whitespace-pre-wrap wrap-break-word px-3 ${l.startsWith("+") ? "bg-ok/[0.07] text-ok" : l.startsWith("-") ? "bg-danger/[0.07] text-danger" : l.startsWith("@@") ? "text-fg-4" : "text-fg-3"}`}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function RuntimeCard({ health }: { health: Health }) {
  const rt = health.runtime;
  return (
    <div className="rounded-card border border-line bg-card">
      <div className="px-3.5 py-3">
        <p className="text-callout text-fg">
          {rt.crashes7d ? (
            <>
              <span className={rt.crashes24h ? "font-semibold text-danger" : "font-semibold"}>{rt.crashes24h}</span> crashes in 24h ·{" "}
              <span className="font-semibold">{rt.crashes7d}</span> in 7 days · last {agoAt(rt.lastCrashAt)}
            </>
          ) : (
            "No native crashes in 7 days."
          )}
        </p>
        {rt.crashGroups.length ? (
          <ul className="mt-2 space-y-1">
            {rt.crashGroups.map((g) => (
              <li key={g.key} className="flex items-baseline gap-2 text-caption">
                <span className="w-9 shrink-0 text-right font-mono tabular text-fg-2">{g.count}×</span>
                <span className="truncate font-mono text-fg-3">{g.key}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <dl className="grid grid-cols-1 border-t border-line text-caption sm:grid-cols-3">
        <RunCell label="Weekly distill" value={agoIso(rt.distill?.lastRunAt)} bad={rt.distill?.lastStatus !== "ok" && !!rt.distill?.lastRunAt} />
        <RunCell label="Roster review" value={agoIso(rt.rosterReview?.lastRunAt)} />
        <RunCell label="Skill curator" value={rt.curator ? rt.curator.at.replace(/^(\d{4})(\d{2})(\d{2})-.*/, "$1-$2-$3") : "never"} />
      </dl>
    </div>
  );
}

function RunCell({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="border-b border-line px-3.5 py-2 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <dt className="text-fg-3">{label}</dt>
      <dd className={bad ? "text-warn" : "text-fg-2"}>{value}</dd>
    </div>
  );
}

function takeLegacyDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LEGACY_DISMISSED_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const STATUS: Record<string, { label: string; tone: string }> = {
  applied: { label: "Applied", tone: "bg-ok/15 text-ok" },
  // Keys are the ledger's status strings; {name} is the chief's display name.
  "waiting on the chief": { label: "Waiting on {name}", tone: "bg-warn/15 text-warn" },
  "sent to the chief": { label: "Sent to {name}", tone: "bg-fill-2 text-fg-2" },
  dismissed: { label: "Dismissed", tone: "border border-line-2 text-fg-3" },
};

/** An older external ledger wrote the chief's own name ("sent to Nova"); any name reads as the chief. */
const statusKey = (s: string) => (/^waiting on /i.test(s) ? "waiting on the chief" : /^sent to /i.test(s) ? "sent to the chief" : s);

function Proposals({ items, onSendToChief, onDecided }: { items: Proposal[]; onSendToChief?: (text: string) => Promise<void>; onDecided: () => void }) {
  const assistant = useAssistantName();
  const [sending, setSending] = useState<string | null>(null);
  // Decided here, before the next poll brings the server's status.
  const [local, setLocal] = useState<Record<string, "approve" | "dismiss">>({});
  const [showDecided, setShowDecided] = useState(false);

  // Proposals dismissed on this device before decisions were shared: record them for every device, once.
  useEffect(() => {
    const legacy = takeLegacyDismissed().filter((id) => items.some((p) => p.id === id && (!p.status || p.status === "open")));
    if (!legacy.length) {
      if (items.length) {
        try {
          localStorage.removeItem(LEGACY_DISMISSED_KEY);
        } catch {
          /* private mode */
        }
      }
      return;
    }
    void Promise.all(legacy.map((id) => decideProposal(id, "dismiss"))).then(() => {
      try {
        localStorage.removeItem(LEGACY_DISMISSED_KEY);
      } catch {
        /* private mode */
      }
      onDecided();
    }, () => undefined);
  }, [items, onDecided]);

  const statusOf = (p: Proposal) => (local[p.id] ? (local[p.id] === "approve" ? "sent to the chief" : "dismissed") : p.status || "open");
  const open = items.filter((p) => statusOf(p) === "open");
  const decided = items.filter((p) => statusOf(p) !== "open");

  async function decide(p: Proposal, decision: "approve" | "dismiss") {
    setSending(p.id);
    try {
      if (decision === "approve") {
        if (!onSendToChief) return;
        await onSendToChief(approvalMessage(p));
      }
      setLocal((m) => ({ ...m, [p.id]: decision }));
      const res = await decideProposal(p.id, decision);
      if (!res.ok) throw new Error(res.error || "Couldn't save the decision");
      onDecided();
    } catch (e) {
      showToast({ title: decision === "approve" ? `Couldn't send to ${assistant}` : "Couldn't dismiss", body: e instanceof Error ? e.message : "Try again", tone: "warn", icon: "alert" });
    } finally {
      setSending(null);
    }
  }

  return (
    <>
      {open.length ? (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {open.map((p) => (
              <motion.li
                key={p.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE.enter } }}
                exit={{ opacity: 0, height: 0, transition: { duration: 0.18 } }}
                className="rounded-card border border-line bg-card px-3.5 py-3"
              >
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 rounded-full bg-fill-2 px-1.5 py-0.5 text-caption font-medium text-fg-2">{p.kind}</span>
                  <span className="truncate text-body font-medium text-fg">{p.target}</span>
                </div>
                <p className="mt-1.5 text-callout text-fg">{p.change}</p>
                {p.why ? <p className="mt-1 text-caption text-fg-3">Why: {p.why}</p> : null}
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!onSendToChief || sending === p.id}
                    onClick={() => void decide(p, "approve")}
                    className={btn("primary", "md", "inline-flex items-center gap-1.5 disabled:text-fg-3")}
                  >
                    <CheckIcon size={15} />
                    {sending === p.id ? "Sending…" : "Approve"}
                  </button>
                  <button type="button" disabled={sending === p.id} onClick={() => void decide(p, "dismiss")} className="press inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-callout text-fg-3 hover:text-fg">
                    <XIcon size={15} />
                    Dismiss
                  </button>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      ) : (
        <EmptyCard
          icon={<CheckIcon size={20} />}
          title={items.length ? "All proposals handled" : "No proposals yet"}
          body={items.length ? "Decisions are shared by every device, and the distill won't propose a dismissed one again." : "The weekly distill writes its skill and memory proposals here with the evidence behind each."}
        />
      )}
      {decided.length ? (
        <div className="mt-2">
          <button type="button" onClick={() => setShowDecided((v) => !v)} aria-expanded={showDecided} className="press min-h-9 px-1 text-caption text-fg-3 hover:text-fg">
            {showDecided ? "Hide" : "Show"} {decided.length} decided
          </button>
          {showDecided ? (
            <ul className="mt-1 overflow-hidden rounded-card border border-line bg-card">
              {decided.map((p) => {
                const s = STATUS[statusKey(statusOf(p))] || STATUS["sent to the chief"];
                return (
                  <li key={p.id} className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-callout text-fg-2">{p.target}</span>
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-caption font-medium ${s.tone}`}>{s.label.replace("{name}", assistant)}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
