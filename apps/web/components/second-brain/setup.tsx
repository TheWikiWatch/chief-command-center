"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { ArrowLeftIcon, BotIcon, ChevronDownIcon, CircleAlertIcon, CircleCheckIcon, FolderIcon, FolderOpenIcon, LibraryIcon, PlusIcon } from "@/components/icons";
import { Switch } from "@/components/ui/controls";
import { desktop } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";
import { loadAppConfig } from "@/lib/app-config";
import {
  secondBrain,
  type FolderInspection,
  type FolderPlan,
  type SecondBrainFormat,
  type SecondBrainMode,
  type SecondBrainResult,
  type SecondBrainStatus,
} from "@/lib/setup-client";
import { field } from "@/components/ui/field";
import { btn } from "@/components/ui/button";

type Source = "new" | "existing";
type Stage =
  | { name: "format" }
  | { name: "source" }
  | { name: "folder" }
  | { name: "review"; found: FolderInspection }
  | { name: "done"; result: SecondBrainResult };

/** The two formats, in a sentence and three lines each (setup, Settings). */
export const FORMAT_INFO: Record<SecondBrainFormat, { label: string; pitch: string; points: (assistant: string) => string[]; Icon: (p: { className?: string }) => ReactNode }> = {
  para: {
    label: "Organized",
    pitch: "For browsing your notes yourself, in Obsidian or any editor.",
    points: () => [
      "Folders by what's active: Inbox, Projects, Areas, Resources, Archive",
      "Tasks are checkboxes with dates inside your notes",
      "Saved views of projects and the Inbox",
    ],
    Icon: ({ className }) => <LibraryIcon className={className} />,
  },
  wiki: {
    label: "Agent-first wiki",
    pitch: "For asking more than browsing: your chief keeps it, you ask it.",
    points: (a) => [
      `Sources are kept untouched in raw/; ${a} maintains the wiki/ around them`,
      "Tasks live on Kanban boards, with a note per task",
      `Drop files into drop/ and ${a} files them; a morning brief asks you what only you know`,
    ],
    Icon: ({ className }) => <BotIcon className={className} />,
  },
};

const KEEP_REORGANIZE: Record<"keep" | "reorganize", { title: (f: SecondBrainFormat) => string; body: (a: string, f: SecondBrainFormat) => string; badge?: string }> = {
  keep: {
    title: () => "Keep my folders as they are",
    badge: "Recommended",
    body: (a, f) =>
      `Nothing is moved or renamed. ${a} adds only the files listed below, then drafts a short description of your folders for ${f === "wiki" ? "_CLAUDE.md" : "AGENTS.md"} and shows it to you before saving.`,
  },
  reorganize: {
    title: (f) => (f === "wiki" ? "Reorganize into the agent-first wiki layout" : "Reorganize into Projects, Areas, Resources and Archive"),
    body: (a, f) =>
      f === "wiki"
        ? `Nothing is moved now. ${a} adds the same few files, then proposes a move plan in chat: which notes become sources in raw/ and which become wiki pages, and which links change. Nothing moves until you approve it.`
        : `Nothing is moved now. ${a} adds the same few files, then proposes a move plan in chat: every move from → to and which links change. Nothing moves until you approve it.`,
  },
};

/**
 * Choose or create the Second Brain: its format first (Organized or Agent-first wiki), then a new folder or an
 * existing one. Shows what a folder holds and exactly what will be created before anything is written; files that
 * already exist are never touched, and a folder with its own rules file gets nothing added. Used in onboarding,
 * Settings, and from Today / Vault before a folder is set up.
 */
export function SecondBrainSetup({
  onDone,
  onBusy,
  onAskChief,
}: {
  onDone?: (result: SecondBrainResult) => void;
  onBusy?: (busy: boolean) => void;
  onAskChief?: (text: string) => Promise<void>;
}) {
  const assistant = useAssistantName();
  const [status, setStatus] = useState<SecondBrainStatus | null>(null);
  const [format, setFormat] = useState<SecondBrainFormat | null>(null);
  const [source, setSource] = useState<Source>("new");
  const [folder, setFolder] = useState("");
  const [stage, setStage] = useState<Stage>({ name: "format" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const folderId = useId();

  useEffect(() => {
    secondBrain
      .status()
      .then((s) => {
        setStatus(s);
        if (s.configured && s.format) setFormat((f) => f ?? s.format ?? null);
      })
      .catch(() => undefined); // the folder can still be typed and checked
  }, []);
  useEffect(() => heading.current?.focus(), [stage.name]);
  useEffect(() => onBusy?.(busy), [busy, onBusy]);

  const run = async <T,>(fn: () => Promise<T & { ok: boolean; error?: string }>, next: (value: T) => void) => {
    setBusy(true);
    setError("");
    try {
      const value = await fn();
      if (!value.ok) setError(value.error || "That didn't work.");
      else next(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  const check = (as: SecondBrainFormat | null = format) =>
    run(() => secondBrain.inspect(folder.trim(), as ?? undefined), (found) => setStage({ name: "review", found }));
  const create = (found: FolderInspection, mode: SecondBrainMode, routines?: boolean) =>
    run(
      () => secondBrain.setUp(found.path, mode, found.format ?? format ?? undefined, routines),
      (result) => {
        setStage({ name: "done", result });
        void loadAppConfig().catch(() => undefined);
        onDone?.(result);
      },
    );
  const go = (next: Stage) => {
    setError("");
    setStage(next);
  };
  const pickSource = (next: Source) => {
    setSource(next);
    setFolder(next === "new" ? (status?.default_path ?? "") : status?.configured ? status.path : "");
    go({ name: "folder" });
  };

  if (stage.name === "done") return <Done heading={heading} result={stage.result} assistant={assistant} onAskChief={onAskChief} />;
  if (stage.name === "review") {
    return (
      <Review
        heading={heading}
        found={stage.found}
        busy={busy}
        error={error}
        assistant={assistant}
        onBack={() => go({ name: "folder" })}
        onSwitchFormat={(f) => {
          setFormat(f);
          void check(f);
        }}
        onCreate={(mode, routines) => create(stage.found, mode, routines)}
      />
    );
  }

  if (stage.name === "format") {
    return (
      <Panel heading={heading} title="Your Second Brain" subtitle={`A folder of plain notes that you and ${assistant} keep together. First, how should it be organized?`}>
        {status?.configured ? (
          <p className="flex items-start gap-2 text-callout text-fg-2">
            <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
            <span>
              Connected to <span className="break-all font-mono text-code text-fg">{status.path}</span>
              {status.format ? ` · ${FORMAT_INFO[status.format].label}` : ""}
              {status.exists ? "" : " (the folder is missing)"}
            </span>
          </p>
        ) : null}
        <div role="radiogroup" aria-label="Format" className="grid gap-2.5 sm:grid-cols-2">
          {(["para", "wiki"] as const).map((f) => {
            const info = FORMAT_INFO[f];
            const on = format === f;
            return (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setFormat(f)}
                className={`press flex flex-col rounded-card border px-4 py-3.5 text-left transition-colors ${on ? "border-fg/60 bg-fill-2" : "border-line hover:border-line-2"}`}
              >
                <span className="flex items-center gap-2.5">
                  <span className={`grid size-8 shrink-0 place-items-center rounded-full ${on ? "bg-fg text-canvas" : "bg-well text-fg-2"}`}>
                    <info.Icon className="size-4" />
                  </span>
                  <span className="text-body font-semibold text-fg">{info.label}</span>
                </span>
                <span className="mt-2 block text-callout text-fg-2">{info.pitch}</span>
                <ul className="mt-2 space-y-1">
                  {info.points(assistant).map((point) => (
                    <li key={point} className="flex gap-2 text-caption text-fg-3">
                      <span aria-hidden className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-fg-4" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>
        <p className="text-caption text-fg-3">
          Not sure? Choose Organized if you&apos;ll browse your notes yourself, Agent-first wiki if you&apos;ll mostly ask {assistant}. If you already have a Second Brain, choose the one it uses; the next steps check.
        </p>
        <button
          type="button"
          disabled={!format}
          onClick={() => go({ name: "source" })}
          className={btn("primary", "md", "w-full")}
        >
          Continue
        </button>
        <Privacy assistant={assistant} />
      </Panel>
    );
  }

  const info = FORMAT_INFO[format ?? "para"];
  if (stage.name === "source") {
    return (
      <Panel heading={heading} title="A new one, or one you have?" subtitle={info.label} onBack={() => go({ name: "format" })}>
        <div className="space-y-2">
          <Choice
            icon={<PlusIcon className="size-4" />}
            title="Start a new Second Brain"
            body={`${assistant} creates the ${info.label} layout in a new or empty folder.`}
            onClick={() => pickSource("new")}
          />
          <Choice
            icon={<FolderOpenIcon className="size-4" />}
            title="Use my existing folder"
            body={`An Obsidian vault or any notes folder. Your notes stay where they are; if it has its own rules file, ${assistant} follows it and adds nothing.`}
            onClick={() => pickSource("existing")}
          />
        </div>
      </Panel>
    );
  }

  const pick = desktop()?.pickFolder;
  return (
    <Panel
      heading={heading}
      title={source === "new" ? "Where should it go?" : "Which folder is it?"}
      subtitle={source === "new" ? `A new or empty folder for your ${info.label} Second Brain.` : "Choose the folder that holds your notes."}
      onBack={() => go({ name: "source" })}
    >
      <div className="text-callout text-fg-2">
        <label htmlFor={folderId}>Folder</label>
        <div className="mt-1.5 flex gap-2">
          <input
            id={folderId}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && folder.trim() && !busy) void check();
            }}
            spellCheck={false}
            placeholder={source === "new" ? "C:\\Users\\you\\Documents\\Second Brain" : "D:\\Notes"}
            className={field({ mono: true, extra: "min-w-0 flex-1 py-2" })}
          />
          {pick ? (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const chosen = await pick({ title: "Choose your Second Brain folder", defaultPath: folder || undefined }).catch(() => null);
                if (chosen) setFolder(chosen);
              }}
              className="press min-h-11 shrink-0 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg disabled:opacity-50"
            >
              Browse…
            </button>
          ) : null}
        </div>
      </div>
      {error ? <ErrorLine text={error} /> : null}
      <button
        type="button"
        disabled={busy || !folder.trim()}
        onClick={() => void check()}
        className={btn("primary", "md", "w-full")}
      >
        {busy ? "Looking…" : "Check this folder"}
      </button>
      <p className="text-caption text-fg-3">Nothing is written until you confirm on the next screen.</p>
    </Panel>
  );
}

function Choice({ icon, title, body, onClick }: { icon: ReactNode; title: string; body: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="press flex w-full items-start gap-3 rounded-card border border-line px-4 py-3.5 text-left hover:border-line-2 hover:bg-fill-1">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-well text-fg-2">{icon}</span>
      <span className="min-w-0">
        <span className="block text-body font-medium text-fg">{title}</span>
        <span className="mt-0.5 block text-callout text-fg-3">{body}</span>
      </span>
    </button>
  );
}

function Review({
  heading,
  found,
  busy,
  error,
  assistant,
  onBack,
  onSwitchFormat,
  onCreate,
}: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  found: FolderInspection;
  busy: boolean;
  error: string;
  assistant: string;
  onBack: () => void;
  onSwitchFormat: (format: SecondBrainFormat) => void;
  onCreate: (mode: SecondBrainMode, routines?: boolean) => void;
}) {
  const format: SecondBrainFormat = found.format ?? "para";
  const info = FORMAT_INFO[format];
  const hasNotes = found.choices.includes("keep");
  const ownRules = hasNotes && !!found.manual;
  const [mode, setMode] = useState<SecondBrainMode>(hasNotes ? "keep" : "new");
  const [routines, setRoutines] = useState(false);
  const plan = found.plans[mode === "reorganize" ? "reorganize" : mode] as FolderPlan | undefined;
  const nothingToAdd = !!plan && plan.folders.length === 0 && plan.files.length === 0;
  const detected = found.format_detected;
  const mismatch = !!detected && detected !== format && found.exists && !found.empty;

  const title = !found.exists
    ? `Create a new ${info.label} Second Brain`
    : found.ours
      ? "This is already a Second Brain"
      : ownRules
        ? "This folder has its own rules"
        : hasNotes
          ? "This folder already has notes"
          : "This folder is empty";
  const summary = !found.exists
    ? "The folder will be created with the layout below."
    : found.ours
      ? nothingToAdd
        ? "Everything is in place. Using it changes nothing in the folder."
        : "Anything missing from the layout is added; your notes stay as they are."
      : ownRules
        ? `${assistant} will follow its ${found.manual} and add nothing to the folder. ${describe(found, false)}`
        : hasNotes
          ? describe(found, true)
          : "It gets the ready-made layout below.";

  return (
    <Panel heading={heading} title={title} subtitle={summary} onBack={onBack}>
      <p className="break-all rounded-ctl border border-line bg-canvas px-3 py-2 font-mono text-code text-fg-2">{found.path}</p>
      {mismatch ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-line-2 bg-fill-1 px-4 py-3">
          <p className="min-w-0 flex-1 text-callout text-fg-2">
            This folder already looks like an <span className="font-medium text-fg">{FORMAT_INFO[detected].label}</span> Second Brain.
          </p>
          <button type="button" disabled={busy} onClick={() => onSwitchFormat(detected)} className="press min-h-9 shrink-0 rounded-full bg-fg px-3.5 text-callout font-semibold text-canvas disabled:opacity-50">
            Use it as {FORMAT_INFO[detected].label}
          </button>
        </div>
      ) : null}
      {!found.writable ? <ErrorLine text={`${assistant} can't write to this folder. Choose another one.`} /> : null}
      {ownRules ? (
        <div className="rounded-card border border-line bg-card px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-body text-fg">Scheduled routines</p>
              <p className="mt-0.5 text-caption text-fg-3">
                {format === "wiki" ? "Morning note, nightly analysis, weekly review, health check, drop folder and morning brief." : "Morning note, nightly tidy, weekly review and health check."} Off by default, since your folder may
                have routines of its own; turn each on later in Settings.
              </p>
            </div>
            <Switch label={`Scheduled routines ${routines ? "on" : "off"}`} checked={routines} onChange={setRoutines} />
          </div>
        </div>
      ) : hasNotes ? (
        <>
          <div role="radiogroup" aria-label="How to set it up" className="space-y-2">
            {(["keep", "reorganize"] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={mode === choice}
                onClick={() => setMode(choice)}
                className={`press block w-full rounded-card border px-4 py-3 text-left ${mode === choice ? "border-line-3 bg-fill-2" : "border-line hover:border-line-2"}`}
              >
                <span className="flex items-center gap-2">
                  <span className={`grid size-4 shrink-0 place-items-center rounded-full border ${mode === choice ? "border-fg" : "border-line-3"}`}>
                    {mode === choice ? <span className="size-2 rounded-full bg-fg" /> : null}
                  </span>
                  <span className="text-body font-medium text-fg">{KEEP_REORGANIZE[choice].title(format)}</span>
                  {KEEP_REORGANIZE[choice].badge ? <span className="rounded-full bg-accent/15 px-2 py-0.5 text-caption text-accent-text">{KEEP_REORGANIZE[choice].badge}</span> : null}
                </span>
                <span className="mt-1 block pl-6 text-callout text-fg-3">{KEEP_REORGANIZE[choice].body(assistant, format)}</span>
              </button>
            ))}
            <button type="button" onClick={onBack} className="press block w-full rounded-card border border-line px-4 py-3 text-left hover:border-line-2">
              <span className="text-body font-medium text-fg">Use a different folder</span>
              <span className="mt-1 block text-callout text-fg-3">Go back and choose an empty or new folder, to keep {assistant}&apos;s notes separate.</span>
            </button>
          </div>
          <Difference format={format} />
        </>
      ) : null}
      {plan && !nothingToAdd ? <PlanList plan={plan} /> : null}
      {error ? <ErrorLine text={error} /> : null}
      <button
        type="button"
        disabled={busy || !found.writable}
        onClick={() => onCreate(ownRules ? "keep" : mode, ownRules ? routines : undefined)}
        className={btn("primary", "md", "w-full")}
      >
        {busy ? "Setting up…" : !found.exists ? "Create my Second Brain" : nothingToAdd ? "Use this folder" : hasNotes ? "Set up this folder" : "Add the layout"}
      </button>
      <p className="text-caption text-fg-3">Files that already exist are never changed or replaced.</p>
    </Panel>
  );
}

function describe(found: FolderInspection, ask: boolean): string {
  const notes = `${found.notes.toLocaleString()}${found.truncated ? "+" : ""} ${found.notes === 1 ? "note" : "notes"}`;
  const folders = found.top_folders.length ? ` in ${found.top_folders.length} ${found.top_folders.length === 1 ? "folder" : "folders"}` : "";
  return `It has ${notes}${folders}.${found.obsidian ? " It looks like an Obsidian vault." : ""}${ask ? " Choose how to set it up." : ""}`;
}

function PlanList({ plan }: { plan: FolderPlan }) {
  const [open, setOpen] = useState(false);
  const top = Array.from(new Set([...plan.folders, ...plan.files].map((p) => p.split("/")[0]))).sort();
  return (
    <div className="rounded-card border border-line bg-card px-4 py-3">
      <p className="text-callout text-fg-2">
        Will add {plan.files.length} {plan.files.length === 1 ? "file" : "files"}
        {plan.folders.length ? ` and ${plan.folders.length} ${plan.folders.length === 1 ? "folder" : "folders"}` : ""}:
      </p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {top.map((name) => (
          <li key={name} className="flex items-center gap-1.5 rounded-full border border-line-2 px-2.5 py-1 text-caption text-fg-2">
            {name.endsWith(".md") ? null : <FolderIcon className="size-3.5 text-fg-3" />}
            {name}
          </li>
        ))}
      </ul>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="press mt-2 flex min-h-9 items-center gap-1.5 text-callout text-fg-3 hover:text-fg-2">
        <ChevronDownIcon className={`size-4 transition-transform duration-fast ${open ? "" : "-rotate-90"}`} />
        {open ? "Hide the full list" : "Show the full list"}
      </button>
      {open ? (
        <ul className="mt-1 max-h-56 overflow-y-auto font-mono text-code text-fg-3" aria-label="Everything that will be created">
          {[...plan.folders.map((f) => `${f}/`), ...plan.files].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Difference({ format }: { format: SecondBrainFormat }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="press flex min-h-9 items-center gap-1.5 text-callout text-fg-3 hover:text-fg-2">
        <ChevronDownIcon className={`size-4 transition-transform duration-fast ${open ? "" : "-rotate-90"}`} />
        What&apos;s the difference?
      </button>
      {open ? (
        <p className="mt-1 text-callout text-fg-3">
          {format === "wiki"
            ? "The agent-first wiki keeps every source untouched in raw/, and your chief maintains wiki/ pages (people, projects, ideas, decisions) built from them, with tasks on Kanban boards. If your own folders already work for you, keep them; the Second Brain works either way. You can change this later in Settings."
            : "Projects, Areas, Resources and Archive (PARA) sorts notes by how actionable they are: projects have an end, areas are ongoing, resources are reference, and the archive keeps what's done. If your own folders already work for you, keep them; the Second Brain works either way. You can change this later in Settings."}
        </p>
      ) : null}
    </div>
  );
}

function Done({
  heading,
  result,
  assistant,
  onAskChief,
}: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  result: SecondBrainResult;
  assistant: string;
  onAskChief?: (text: string) => Promise<void>;
}) {
  const [asked, setAsked] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const ask = result.next_prompt;
  const wiki = result.format === "wiki";
  return (
    <Panel heading={heading} title="Your Second Brain is ready" subtitle={result.path}>
      <p className="flex items-start gap-2 text-callout text-fg-2" role="status">
        <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
        <span>
          {result.own_rules
            ? `Nothing was added: ${assistant} follows its ${result.rules}.`
            : result.created.length
              ? `Added ${result.created.length} ${result.created.length === 1 ? "item" : "items"}.`
              : "Nothing needed adding."}{" "}
          {assistant} now knows where your notes live.
        </span>
      </p>
      <p className="text-callout text-fg-3">
        {wiki ? (
          <>
            To capture something, tell {assistant} “save this…” or “remind me to…”, or drop a file into <span className="font-mono text-code">drop</span>. Tasks show in Today from your boards.
          </>
        ) : (
          <>
            To capture something, tell {assistant} “save this…” or “remind me to…”, or drop files into <span className="font-mono text-code">00 Inbox</span>. The folder works in Obsidian or any text editor.
          </>
        )}
      </p>
      {result.own_rules && result.routines_on === false ? (
        <p className="text-callout text-fg-3">The scheduled routines are off; turn on the ones you want in Settings, then Second Brain.</p>
      ) : null}
      {ask && onAskChief ? (
        <button
          type="button"
          disabled={asked === "sending" || asked === "sent"}
          onClick={async () => {
            setAsked("sending");
            try {
              await onAskChief(ask);
              setAsked("sent");
            } catch {
              setAsked("failed");
            }
          }}
          className="press min-h-11 w-full rounded-full border border-line-2 px-5 text-callout font-medium text-fg hover:border-line-3 disabled:opacity-60"
        >
          {asked === "sent"
            ? `Sent — ${assistant} will reply in chat`
            : asked === "sending"
              ? "Sending…"
              : result.own_rules
                ? `Ask ${assistant} to read its rules`
                : result.mode === "reorganize"
                  ? `Ask ${assistant} for a move plan`
                  : `Ask ${assistant} to describe my folders`}
        </button>
      ) : null}
      {asked === "failed" ? <ErrorLine text={`Couldn't reach ${assistant}. You can ask in chat any time.`} /> : null}
    </Panel>
  );
}

function Privacy({ assistant }: { assistant: string }) {
  return <p className="text-caption text-fg-3">Your notes stay on this PC. Only what {assistant} reads for a task is sent to your model provider.</p>;
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-callout text-danger">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

function Panel({
  heading,
  title,
  subtitle,
  onBack,
  children,
}: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  title: string;
  subtitle?: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-start gap-2">
        {onBack ? (
          <button type="button" onClick={onBack} aria-label="Back" className="press -ml-1 grid size-9 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg">
            <ArrowLeftIcon className="size-4" />
          </button>
        ) : null}
        <div className="min-w-0">
          <h2 ref={heading} tabIndex={-1} className="text-title text-fg outline-hidden">
            {title}
          </h2>
          {subtitle ? <p className="mt-1 wrap-break-word text-callout text-fg-3">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}
