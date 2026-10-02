"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, RotateCcwIcon, SparklesIcon } from "@/components/icons";
import { HoldButton } from "@/components/ui/hold-button";
import { fetchSkillDiff, kb, revertSkillChange, type Episode, type SkillChange, type SkillSummary, type Verdict } from "@/lib/fleet-health";
import { SPRING } from "@/lib/motion";
import { showToast } from "@/lib/toast-store";
import { useAssistantName } from "@/lib/identity";
import { SKILLS_FOLDED, VERDICT, agoAt, day, skillAnchor } from "@/components/fleet-health";
import { EmptyCard, Section } from "@/components/fleet-health/parts";

/* Fleet Health → skills: churn, episodes and verdicts, each change with its diff and revert. */

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-caption font-medium ${VERDICT[verdict.label] || "border border-line-2 text-fg-3"}`}>{verdict.label}</span>;
}

export function verdictWhen(v: Verdict) {
  if (!v.judgeAt) return v.why || "";
  if (v.label === "too early") return `Judged ${day(v.judgeAt)} (14 days after the last edit)`;
  return v.why || "";
}

export function Skills({ skills, open, onOpen, onReverted }: { skills: SkillSummary[]; open: string | null; onOpen: (key: string | null) => void; onReverted: () => void }) {
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

export function SkillRow({ skill: s, open, onToggle, onReverted }: { skill: SkillSummary; open: boolean; onToggle: () => void; onReverted: () => void }) {
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

export function EpisodeRow({ episode: ep, changes, onReverted }: { episode: Episode; changes: SkillChange[]; onReverted: () => void }) {
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

export function ChangeRow({ change: c, title, compact = false, onReverted }: { change: SkillChange; title: string; compact?: boolean; onReverted: () => void }) {
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
export function LazyDiff({ id, from }: { id: number; from?: number }) {
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

export function DiffView({ text }: { text: string }) {
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
