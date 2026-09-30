"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { ArrowLeftIcon, ChevronDownIcon, CircleAlertIcon, CircleCheckIcon, FolderIcon } from "@/components/icons";
import { desktop } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";
import { loadAppConfig } from "@/lib/app-config";
import { secondBrain, type FolderInspection, type FolderPlan, type SecondBrainMode, type SecondBrainResult, type SecondBrainStatus } from "@/lib/setup-client";

type Stage =
  | { name: "choose" }
  | { name: "review"; found: FolderInspection }
  | { name: "done"; result: SecondBrainResult };

const CHOICES: Record<"keep" | "reorganize", { title: string; body: (assistant: string) => string; badge?: string }> = {
  keep: {
    title: "Keep my folders as they are",
    badge: "Recommended",
    body: (a) =>
      `Nothing is moved or renamed. ${a} adds only the files listed below, then drafts a short description of your folders for AGENTS.md and shows it to you before saving.`,
  },
  reorganize: {
    title: "Reorganize into Projects, Areas, Resources and Archive",
    body: (a) =>
      `Nothing is moved now. ${a} adds the same few files, then proposes a move plan in chat: every move from → to and which links change. Nothing moves until you approve it.`,
  },
};

/**
 * Choose or create the Second Brain folder. Shows what a folder holds and exactly what will be created
 * before anything is written; files that already exist are never touched. Used in onboarding, Settings,
 * and from Today / Vault before a folder is set up.
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
  const [folder, setFolder] = useState("");
  const [stage, setStage] = useState<Stage>({ name: "choose" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    secondBrain
      .status()
      .then((s) => {
        setStatus(s);
        setFolder((f) => f || (s.configured ? s.path : s.default_path) || "");
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
  const check = () => run(() => secondBrain.inspect(folder.trim()), (found) => setStage({ name: "review", found }));
  const create = (found: FolderInspection, mode: SecondBrainMode) =>
    run(
      () => secondBrain.setUp(found.path, mode),
      (result) => {
        setStage({ name: "done", result });
        void loadAppConfig().catch(() => undefined);
        onDone?.(result);
      },
    );
  const back = () => {
    setError("");
    setStage({ name: "choose" });
  };

  if (stage.name === "done") return <Done heading={heading} result={stage.result} assistant={assistant} onAskChief={onAskChief} />;
  if (stage.name === "review") {
    return <Review heading={heading} found={stage.found} busy={busy} error={error} assistant={assistant} onBack={back} onCreate={(mode) => create(stage.found, mode)} />;
  }

  const pick = desktop()?.pickFolder;
  return (
    <Panel heading={heading} title="Your Second Brain" subtitle={`A folder of plain notes that you and ${assistant} keep together. Tasks show up in Today; every note is browsable in Vault.`}>
      {status?.configured ? (
        <p className="flex items-start gap-2 text-callout text-fg-2">
          <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
          <span>
            Connected to <span className="break-all font-mono text-code text-fg">{status.path}</span>
            {status.exists ? "" : " (the folder is missing)"}
          </span>
        </p>
      ) : null}
      <label className="block text-callout text-fg-2">
        Folder
        <div className="mt-1.5 flex gap-2">
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && folder.trim() && !busy) void check();
            }}
            spellCheck={false}
            placeholder="C:\Users\you\Documents\Second Brain"
            className="min-h-11 min-w-0 flex-1 rounded-ctl border border-line-2 bg-canvas px-3 py-2 font-mono text-code text-fg outline-none placeholder:text-fg-3 focus:border-line-3"
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
      </label>
      <p className="text-caption text-fg-3">
        A new folder gets a ready-made layout. An existing notes folder (an Obsidian vault, for example) keeps your notes; you&apos;ll see your options next.
      </p>
      {error ? <ErrorLine text={error} /> : null}
      <button
        type="button"
        disabled={busy || !folder.trim()}
        onClick={() => void check()}
        className="press min-h-11 w-full rounded-full bg-fg px-5 text-callout font-semibold text-canvas disabled:bg-white/10 disabled:text-fg-4"
      >
        {busy ? "Looking…" : "Check this folder"}
      </button>
      <Privacy assistant={assistant} />
    </Panel>
  );
}

function Review({
  heading,
  found,
  busy,
  error,
  assistant,
  onBack,
  onCreate,
}: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  found: FolderInspection;
  busy: boolean;
  error: string;
  assistant: string;
  onBack: () => void;
  onCreate: (mode: SecondBrainMode) => void;
}) {
  const hasNotes = found.choices.includes("keep");
  const [mode, setMode] = useState<SecondBrainMode>(hasNotes ? "keep" : "new");
  const plan = found.plans[mode === "reorganize" ? "reorganize" : mode] as FolderPlan | undefined;
  const nothingToAdd = !!plan && plan.folders.length === 0 && plan.files.length === 0;

  const title = !found.exists
    ? "Create a new Second Brain"
    : found.ours
      ? "This is already a Second Brain"
      : hasNotes
        ? "This folder already has notes"
        : "This folder is empty";
  const summary = !found.exists
    ? "The folder will be created with the layout below."
    : found.ours
      ? nothingToAdd
        ? "Everything is in place. Using it changes nothing in the folder."
        : "Anything missing from the layout is added; your notes stay as they are."
      : hasNotes
        ? describe(found)
        : "It gets the ready-made layout below.";

  return (
    <Panel heading={heading} title={title} subtitle={summary} onBack={onBack}>
      <p className="break-all rounded-ctl border border-line bg-canvas px-3 py-2 font-mono text-code text-fg-2">{found.path}</p>
      {!found.writable ? <ErrorLine text={`${assistant} can't write to this folder. Choose another one.`} /> : null}
      {hasNotes ? (
        <>
          <div role="radiogroup" aria-label="How to set it up" className="space-y-2">
            {(["keep", "reorganize"] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={mode === choice}
                onClick={() => setMode(choice)}
                className={`press block w-full rounded-card border px-4 py-3 text-left ${mode === choice ? "border-line-3 bg-white/[0.05]" : "border-line hover:border-line-2"}`}
              >
                <span className="flex items-center gap-2">
                  <span className={`grid size-4 shrink-0 place-items-center rounded-full border ${mode === choice ? "border-fg" : "border-line-3"}`}>
                    {mode === choice ? <span className="size-2 rounded-full bg-fg" /> : null}
                  </span>
                  <span className="text-body font-medium text-fg">{CHOICES[choice].title}</span>
                  {CHOICES[choice].badge ? <span className="rounded-full bg-accent/15 px-2 py-0.5 text-caption text-accent-text">{CHOICES[choice].badge}</span> : null}
                </span>
                <span className="mt-1 block pl-6 text-callout text-fg-3">{CHOICES[choice].body(assistant)}</span>
              </button>
            ))}
            <button type="button" onClick={onBack} className="press block w-full rounded-card border border-line px-4 py-3 text-left hover:border-line-2">
              <span className="text-body font-medium text-fg">Use a different folder</span>
              <span className="mt-1 block text-callout text-fg-3">Go back and choose an empty or new folder, to keep {assistant}&apos;s notes separate.</span>
            </button>
          </div>
          <Difference />
        </>
      ) : null}
      {plan && !nothingToAdd ? <PlanList plan={plan} /> : null}
      {error ? <ErrorLine text={error} /> : null}
      <button
        type="button"
        disabled={busy || !found.writable}
        onClick={() => onCreate(mode)}
        className="press min-h-11 w-full rounded-full bg-fg px-5 text-callout font-semibold text-canvas disabled:bg-white/10 disabled:text-fg-4"
      >
        {busy ? "Setting up…" : !found.exists ? "Create my Second Brain" : nothingToAdd ? "Use this folder" : hasNotes ? "Set up this folder" : "Add the layout"}
      </button>
      <p className="text-caption text-fg-3">Files that already exist are never changed or replaced.</p>
    </Panel>
  );
}

function describe(found: FolderInspection): string {
  const notes = `${found.notes.toLocaleString()}${found.truncated ? "+" : ""} ${found.notes === 1 ? "note" : "notes"}`;
  const folders = found.top_folders.length ? ` in ${found.top_folders.length} ${found.top_folders.length === 1 ? "folder" : "folders"}` : "";
  return `It has ${notes}${folders}.${found.obsidian ? " It looks like an Obsidian vault." : ""} Choose how to set it up.`;
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

function Difference() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="press flex min-h-9 items-center gap-1.5 text-callout text-fg-3 hover:text-fg-2">
        <ChevronDownIcon className={`size-4 transition-transform duration-fast ${open ? "" : "-rotate-90"}`} />
        What&apos;s the difference?
      </button>
      {open ? (
        <p className="mt-1 text-callout text-fg-3">
          Projects, Areas, Resources and Archive (PARA) sorts notes by how actionable they are: projects have an end, areas are ongoing, resources are reference, and the archive keeps what&apos;s done. If your own folders already work for you, keep them; the Second Brain works either way. You can change this later in Settings.
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
  return (
    <Panel heading={heading} title="Your Second Brain is ready" subtitle={result.path}>
      <p className="flex items-start gap-2 text-callout text-fg-2" role="status">
        <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
        <span>
          {result.created.length ? `Added ${result.created.length} ${result.created.length === 1 ? "item" : "items"}.` : "Nothing needed adding."} {assistant} now knows where your notes live.
        </span>
      </p>
      <p className="text-callout text-fg-3">
        To capture something, tell {assistant} “save this…” or “remind me to…”, or drop files into <span className="font-mono text-code">00 Inbox</span>. The folder works in Obsidian or any text editor.
      </p>
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
          <button type="button" onClick={onBack} aria-label="Back" className="press -ml-1 grid size-9 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-white/[0.06] hover:text-fg">
            <ArrowLeftIcon className="size-4" />
          </button>
        ) : null}
        <div className="min-w-0">
          <h2 ref={heading} tabIndex={-1} className="text-title text-fg outline-none">
            {title}
          </h2>
          {subtitle ? <p className="mt-1 break-words text-callout text-fg-3">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}
