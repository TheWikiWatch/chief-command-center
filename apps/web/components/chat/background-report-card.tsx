"use client";

import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";

import { ChevronRightIcon, CircleCheckIcon, TerminalIcon, TriangleAlertIcon } from "@/components/icons";
import { durationLabel, parseBackgroundReport, reportIssues, reportTitle, type CommandResult, type ReportTask } from "@/lib/background-report";
import { SPRING } from "@/lib/motion";

/**
 * The results of the chief's background work, as Hermes handed them to the chief: one collapsed line ("Results
 * from 4 background tasks · 5m 40s"), opening to one row per task with its findings. The chief reads the full text
 * and replies with what matters; this keeps the record without the wall of text (lib/background-report.ts).
 */
export function BackgroundReportCard({ text }: { text: string }) {
  const report = useMemo(() => parseBackgroundReport(text), [text]);
  const [open, setOpen] = useState(false);
  if (!report) return null;
  const ok = report.kind === "tasks" || report.kind === "commands" ? report.ok : report.kind === "note";
  const title = reportTitle(report);
  const issues = report.kind === "taskFailed" ? 0 : reportIssues(report);
  const time = report.kind === "tasks" ? durationLabel(report.seconds) : "";
  const expandable = report.kind !== "note";
  const Icon = report.kind === "commands" || report.kind === "note" ? TerminalIcon : ok ? CircleCheckIcon : TriangleAlertIcon;

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col overflow-hidden rounded-card border border-line bg-card">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((v) => !v)}
        className="press flex min-h-10 w-full min-w-0 items-center gap-2 px-3 text-left text-callout disabled:cursor-default"
      >
        <Icon size={15} className={`shrink-0 ${ok ? "text-ok" : "text-warn"}`} />
        <span className="min-w-0 flex-1 truncate text-fg-2">{title}</span>
        {issues ? <span className="shrink-0 rounded-chip bg-warn/15 px-1.5 py-0.5 text-caption text-warn">{issues} issue{issues === 1 ? "" : "s"}</span> : null}
        {time && !issues ? <span className="shrink-0 font-mono text-caption tabular-nums text-fg-3">{time}</span> : null}
        {expandable ? (
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRING.snappy} className="shrink-0 text-fg-4">
            <ChevronRightIcon size={14} />
          </motion.span>
        ) : null}
      </button>
      <AnimatePresence initial={false}>
        {open && expandable ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: SPRING.gentle }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.16 } }}
            className="overflow-hidden border-t border-line"
          >
            {report.kind === "tasks" ? (
              <>
                {report.error ? <p className="px-3 py-2.5 text-callout text-warn [overflow-wrap:anywhere]">{report.error}</p> : null}
                {report.tasks.map((t, i) => (
                  <TaskRow key={i} task={t} first={i === 0 && !report.error} />
                ))}
              </>
            ) : report.kind === "taskFailed" ? (
              <TaskRow task={report.task} first />
            ) : report.kind === "commands" ? (
              report.commands.map((c, i) => <CommandRow key={c.id} command={c} first={i === 0} />)
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Row({ first, ok, label, meta, children }: { first: boolean; ok: boolean; label: ReactNode; meta: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={first ? "" : "border-t border-line/60"}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="press flex w-full min-w-0 items-start gap-2.5 px-3 py-2.5 text-left">
        <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${ok ? "bg-ok" : "bg-warn"}`} />
        <span className="min-w-0 flex-1 text-callout text-fg-2 [overflow-wrap:anywhere]">{label}</span>
        {meta ? <span className="mt-0.5 shrink-0 font-mono text-caption tabular-nums text-fg-3">{meta}</span> : null}
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRING.snappy} className="mt-0.5 shrink-0 text-fg-4">
          <ChevronRightIcon size={13} />
        </motion.span>
      </button>
      {open ? <div className="max-h-80 overflow-y-auto overscroll-contain px-3 pb-3 pl-7">{children}</div> : null}
    </div>
  );
}

function TaskRow({ task, first }: { task: ReportTask; first: boolean }) {
  const label = (
    <>
      <span className="line-clamp-2">{task.goal || "A task"}</span>
      {!task.ok ? (
        <span className="mt-0.5 block text-caption text-warn">{task.truncated ? "Stopped early: the findings may be incomplete" : `Didn't finish (${task.status})`}</span>
      ) : null}
    </>
  );
  return (
    <Row first={first} ok={task.ok} label={label} meta={durationLabel(task.seconds)}>
      {task.body ? <Streamdown className="chat-md max-w-none text-callout">{task.body}</Streamdown> : <p className="text-callout text-fg-3">No findings came back.</p>}
    </Row>
  );
}

function CommandRow({ command, first }: { command: CommandResult; first: boolean }) {
  return (
    <Row first={first} ok={command.ok} label={<span className="font-mono text-caption">{command.command || command.id}</span>} meta={command.ok ? "" : `exit ${command.exitCode}`}>
      <pre className="whitespace-pre-wrap break-words font-mono text-caption text-fg-2 [overflow-wrap:anywhere]">{command.output || "(no output)"}</pre>
    </Row>
  );
}
