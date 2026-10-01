"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { CheckIcon, ChevronDownIcon, EllipsisIcon, PlusIcon } from "@/components/icons";
import { Sheet } from "@/components/ui/sheet";
import { useAssistantName } from "@/lib/identity";
import { EASE } from "@/lib/motion";
import { markSeen, readSeen, threadsApi, type ChatThread } from "@/lib/threads-client";

function ago(epoch: number): string {
  if (!epoch) return "";
  const s = Date.now() / 1000 - epoch;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return new Date(epoch * 1000).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(epoch * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type Attention = "question" | "working" | "unread" | null;
function attentionOf(t: ChatThread, current: string, seen: Record<string, number>): Attention {
  if (t.question || t.approval) return "question";
  if (t.working) return "working";
  if (t.id !== current && t.lastActivity > (seen[t.id] || 0) + 1) return "unread";
  return null;
}

function Dot({ kind }: { kind: Attention }) {
  if (kind === "working")
    return <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-fg-3 border-t-transparent" aria-label="Working" role="img" />;
  if (kind === "question") return <span className="size-2 shrink-0 rounded-full bg-warn" aria-label="Needs you" role="img" />;
  if (kind === "unread") return <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="New messages" role="img" />;
  return <span className="size-2 shrink-0" aria-hidden="true" />;
}

/**
 * The chat's thread switcher: separate conversations with the chief, side by side. The pill shows the open
 * thread; its menu lists the others with what each is doing (working, waiting on you, unread), and makes,
 * renames, fresh-starts and archives threads. `onFresh` reloads the open thread after a fresh start.
 */
export function ThreadSwitcher({
  current,
  onChange,
  onFresh,
  phone,
}: {
  current: string;
  onChange: (id: string) => void;
  onFresh: () => void;
  phone: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ChatThread[]>([]);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    threadsApi
      .list()
      .then((r) => r.ok && setItems(r.threads))
      .catch(() => undefined);
    setSeen(readSeen());
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, open ? 3000 : 6000);
    return () => window.clearInterval(timer);
  }, [load, open]);
  // What is on screen counts as seen.
  const active = items.find((t) => t.id === current);
  useEffect(() => {
    if (active?.lastActivity) markSeen(current, active.lastActivity);
  }, [current, active?.lastActivity]);

  // Desktop popover: close on a click outside.
  useEffect(() => {
    if (!open || phone) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, phone]);

  const others = items.filter((t) => t.id !== current && !t.archived);
  const elsewhere: Attention = others.some((t) => t.question || t.approval)
    ? "question"
    : others.some((t) => attentionOf(t, current, seen) === "unread")
      ? "unread"
      : null;
  const title = active?.title || (current === "main" ? "Main" : "Thread");

  const pick = (id: string) => {
    setOpen(false);
    if (id !== current) onChange(id);
  };
  const menu = (
    <ThreadMenu
      items={items}
      current={current}
      seen={seen}
      onPick={pick}
      onChanged={load}
      onFresh={() => {
        setOpen(false);
        onFresh();
      }}
    />
  );

  return (
    <div ref={root} className="relative flex min-w-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Thread: ${title}. Switch threads`}
        onClick={() => {
          setOpen((v) => !v);
          load();
        }}
        className="press flex min-h-8 min-w-0 max-w-[11rem] items-center gap-1.5 rounded-full border border-line-2 bg-white/[0.04] py-0.5 pl-2.5 pr-1.5 text-caption font-medium text-fg-2 hover:border-line-3 hover:text-fg sm:max-w-[14rem]"
      >
        <span className="truncate">{title}</span>
        {elsewhere ? <Dot kind={elsewhere} /> : null}
        <ChevronDownIcon size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {phone ? (
        <Sheet open={open} onClose={() => setOpen(false)} title="Threads" subtitle="Separate conversations, side by side." side="bottom">
          <div className="px-3 pb-6">{menu}</div>
        </Sheet>
      ) : (
        <AnimatePresence>
          {open ? (
            <motion.div
              role="menu"
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.16, ease: EASE.enter } }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
              style={{ transformOrigin: "top right" }}
              className="absolute right-0 top-full z-50 mt-2 w-[min(340px,calc(100vw-24px))] rounded-card border border-line-2 bg-raised p-2 shadow-e4"
            >
              {menu}
            </motion.div>
          ) : null}
        </AnimatePresence>
      )}
    </div>
  );
}

function ThreadMenu({
  items,
  current,
  seen,
  onPick,
  onChanged,
  onFresh,
}: {
  items: ChatThread[];
  current: string;
  seen: Record<string, number>;
  onPick: (id: string) => void;
  onChanged: () => void;
  onFresh: () => void;
}) {
  const assistant = useAssistantName();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const live = items.filter((t) => !t.archived);
  const archived = items.filter((t) => t.archived);

  async function run(work: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setBusy(true);
    setError("");
    try {
      const res = await work();
      if (!res.ok) throw new Error(res.error || "That didn't work.");
      onChanged();
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1.5 pb-1 pt-0.5">
        <p className="text-caption font-medium text-fg-3">Threads with {assistant}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const res = await threadsApi.create();
              if (res.ok && res.thread) onPick(res.thread.id);
              return res;
            })
          }
          className="press flex min-h-8 items-center gap-1 rounded-full bg-fg px-3 text-caption font-semibold text-canvas disabled:opacity-50"
        >
          <PlusIcon size={13} />
          New thread
        </button>
      </div>
      <ul className="space-y-0.5">
        {live.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            current={t.id === current}
            attention={attentionOf(t, current, seen)}
            onPick={() => onPick(t.id)}
            onRename={(title) => run(() => threadsApi.rename(t.id, title))}
            onArchive={t.id === "main" ? undefined : () => run(() => threadsApi.archive(t.id), () => t.id === current && onPick("main"))}
            onFresh={() => run(() => threadsApi.fresh(t.id), () => (t.id === current ? onFresh() : undefined))}
            busy={busy}
          />
        ))}
      </ul>
      {archived.length ? (
        <div className="border-t border-line pt-1">
          <button type="button" onClick={() => setShowArchived((v) => !v)} className="press flex min-h-9 w-full items-center gap-2 rounded-[10px] px-2 text-caption text-fg-3 hover:text-fg-2">
            <ChevronDownIcon size={13} className={showArchived ? "rotate-180" : ""} />
            Archived ({archived.length})
          </button>
          {showArchived ? (
            <ul className="space-y-0.5">
              {archived.map((t) => (
                <li key={t.id} className="flex items-center gap-2 rounded-[10px] px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-callout text-fg-3">{t.title}</span>
                  <button type="button" disabled={busy} onClick={() => void run(() => threadsApi.archive(t.id, false))} className="press min-h-8 rounded-full border border-line-2 px-3 text-caption text-fg-2 hover:text-fg">
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="px-2 pt-1 text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ThreadRow({
  thread: t,
  current,
  attention,
  onPick,
  onRename,
  onArchive,
  onFresh,
  busy,
}: {
  thread: ChatThread;
  current: boolean;
  attention: Attention;
  onPick: () => void;
  onRename: (title: string) => Promise<void>;
  onArchive?: () => Promise<void>;
  onFresh: () => Promise<void>;
  busy: boolean;
}) {
  const assistant = useAssistantName();
  const [mode, setMode] = useState<"" | "actions" | "rename" | "fresh">("");
  const [title, setTitle] = useState(t.title);
  useEffect(() => setTitle(t.title), [t.title]);

  let panel: ReactNode = null;
  if (mode === "rename") {
    panel = (
      <form
        className="flex gap-1.5 px-2 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          void onRename(title.trim()).then(() => setMode(""));
        }}
      >
        <label className="sr-only" htmlFor={`rename-${t.id}`}>
          Thread title
        </label>
        <input
          id={`rename-${t.id}`}
          autoFocus
          value={title}
          maxLength={60}
          onChange={(e) => setTitle(e.target.value)}
          className="min-h-9 min-w-0 flex-1 rounded-ctl border border-line-2 bg-canvas px-2.5 text-callout text-fg outline-none focus:border-line-3"
        />
        <button type="submit" disabled={busy} className="press min-h-9 rounded-full bg-fg px-3 text-caption font-semibold text-canvas disabled:opacity-50">
          Save
        </button>
      </form>
    );
  } else if (mode === "fresh") {
    panel = (
      <div className="mx-2 mb-2 space-y-2 rounded-[10px] border border-line-2 bg-card px-2.5 py-2">
        <p className="text-caption text-fg-2">
          Start fresh? {assistant} begins a new conversation in this thread. This one stays below as history, and memory and the Second Brain carry over.
        </p>
        <div className="flex gap-1.5">
          <button type="button" disabled={busy || t.working} onClick={() => void onFresh().then(() => setMode(""))} className="press min-h-8 rounded-full bg-fg px-3 text-caption font-semibold text-canvas disabled:opacity-50">
            {t.working ? "Working…" : "Start fresh"}
          </button>
          <button type="button" onClick={() => setMode("")} className="press min-h-8 rounded-full border border-line-2 px-3 text-caption text-fg-2 hover:text-fg">
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (mode === "actions") {
    panel = (
      <div className="flex flex-wrap gap-1.5 px-2 pb-2">
        <button type="button" onClick={() => setMode("rename")} className="press min-h-8 rounded-full border border-line-2 px-3 text-caption text-fg-2 hover:text-fg">
          Rename
        </button>
        <button type="button" onClick={() => setMode("fresh")} className="press min-h-8 rounded-full border border-line-2 px-3 text-caption text-fg-2 hover:text-fg">
          Fresh start
        </button>
        {onArchive ? (
          <button type="button" disabled={busy} onClick={() => void onArchive()} className="press min-h-8 rounded-full border border-line-2 px-3 text-caption text-fg-2 hover:text-fg">
            Archive
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <li className={`rounded-[10px] ${current ? "bg-white/[0.06]" : ""}`}>
      <div className="flex items-center gap-1">
        <button type="button" role="menuitemradio" aria-checked={current} onClick={onPick} className="press flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-2 text-left hover:bg-white/[0.04]">
          <Dot kind={attention} />
          <span className={`min-w-0 flex-1 truncate text-callout ${current ? "font-medium text-fg" : "text-fg-2"}`}>{t.title}</span>
          <span className="shrink-0 text-caption tabular text-fg-3">{attention === "question" ? "needs you" : ago(t.lastActivity)}</span>
          {current ? <CheckIcon size={14} className="shrink-0 text-fg-2" /> : null}
        </button>
        <button
          type="button"
          aria-label={`More for ${t.title}`}
          aria-expanded={mode !== ""}
          onClick={() => setMode((m) => (m ? "" : "actions"))}
          className="press grid size-9 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-white/[0.06] hover:text-fg"
        >
          <EllipsisIcon size={16} />
        </button>
      </div>
      {panel}
    </li>
  );
}
