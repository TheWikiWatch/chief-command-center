"use client";

import { AnimatePresence, animate as animateValue, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { poll } from "@/lib/poll";
import { useResourceHealth } from "@/components/resource-status";
import { share } from "@/lib/share";
import { SurfaceTabs, type Surface } from "@/components/surface-tabs";
import { ChevronLeftIcon, CircleCheckIcon, ClockIcon, RefreshCwIcon, SearchIcon, SlidersHorizontalIcon, TriangleAlertIcon, WifiOffIcon, XIcon } from "@/components/icons";
import { Sheet } from "@/components/ui/sheet";
import { EASE, SPRING } from "@/lib/motion";
import {
  ops,
  fetchOpsHealth,
  pulseLine,
  type Board,
  type FocusCard,
  type Intent,
  type LaunchTarget,
  type Meta,
  type Pulse,
  type TaskCard,
  type TodayItem,
} from "@/lib/ops";
import { useAssistantName } from "@/lib/identity";
import { useAppConfig } from "@/lib/app-config";
import { SecondBrainNotSetUp } from "@/components/second-brain/not-set-up";

const OPEN_COLS = ["In Progress", "This Week", "Waiting On", "Next Week", "Backlog"];

const TASK_INTENTS: { id: Intent; label: string }[] = [
  { id: "task.discuss", label: "Discuss" },
  { id: "task.update", label: "Update" },
  { id: "task.block", label: "Block" },
  { id: "task.reschedule", label: "Reschedule" },
];

const FOCUS_INTENTS: { id: Intent; label: string }[] = [
  { id: "focus.discuss", label: "Discuss focus" },
  { id: "area.brief", label: "What's outstanding?" },
];

type TodayPaneProps = {
  surface: Surface;
  onSurface: (next: Surface) => void;
  onSendToChief: (text: string) => Promise<void>;
  hideTabs?: boolean;
  trailing?: React.ReactNode;
  onSetUpSecondBrain?: () => void;
};

/**
 * Today reads the Second Brain's tasks (the built-in indexer, lib/server/today-index.ts) or, on an install
 * that has one, a task service. Neither: the Second Brain isn't set up yet.
 */
export function TodayPane(props: TodayPaneProps) {
  const config = useAppConfig();
  if (!config.features.today) {
    return <SecondBrainNotSetUp title="Today" surface={props.surface} onSurface={props.onSurface} hideTabs={props.hideTabs} trailing={props.trailing} onSetUp={props.onSetUpSecondBrain} />;
  }
  return <OpsTodayPane {...props} builtin={config.secondBrain.today === "vault"} />;
}

function OpsTodayPane({ surface, onSurface, onSendToChief, hideTabs = false, trailing, onSetUpSecondBrain, builtin }: TodayPaneProps & { builtin: boolean }) {
  const assistant = useAssistantName();
  // With the built-in indexer the folder is the Second Brain's, chosen in Settings; with a task service, its own setting.
  const openFolderSettings = () => {
    setLaunch(null);
    if (builtin && onSetUpSecondBrain) onSetUpSecondBrain();
    else setSettingsOpen(true);
  };
  const [meta, setMeta] = useState<Meta | null>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [focusCards, setFocusCards] = useState<FocusCard[]>([]);
  const [today, setToday] = useState<TodayItem[]>([]);
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [query, setQuery] = useState("");
  const [area, setArea] = useState<string | null>(null);
  const [attention, setAttention] = useState(false);
  const [launch, setLaunch] = useState<LaunchTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const resourceHealth = useResourceHealth("Today", Math.max(2, meta?.poll_seconds || 8) * 2000);
  const pollSeconds = useRef(8);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
    const health = await fetchOpsHealth(signal);
    if (!health.ok) {
      setOnline(false);
      setError(builtin ? "Couldn't read your Second Brain." : "The task service isn't answering.");
      return;
    }
    setOnline(true);
      const results = await Promise.allSettled([ops.meta(signal), ops.boards(false, signal), ops.focus(signal), ops.today(signal), ops.pulse(signal)]);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const [m, b, f, t, p] = results.map(result => (result as PromiseFulfilledResult<unknown>).value) as [Meta, { boards: Board[] }, { cards: FocusCard[]; stale: boolean }, { items: TodayItem[] }, Pulse];
      if (signal.aborted) return;
      pollSeconds.current = Math.max(1, m.poll_seconds || 8);
      resourceHealth.success();
      setMeta((prev) => share(prev, m));
      setBoards((prev) => share(prev, b.boards));
      setFocusCards((prev) => share(prev, f.cards));
      setStale(f.stale);
      setToday((prev) => share(prev, t.items));
      setPulse((prev) => share(prev, p));
      setError(null);
    } catch (e) {
      if (signal.aborted) return;
      resourceHealth.failure(e);
      setOnline(false);
      setError(e instanceof Error ? e.message : "Could not read the vault.");
    }
  }, []);

  useEffect(() => poll(refresh, () => pollSeconds.current * 1000), [refresh, tick]);

  useEffect(() => {
    // Escape is handled by whichever sheet is on top (lib/overlay-stack.ts).
    const onKey = (e: KeyboardEvent) => {
      if (window.matchMedia("(max-width: 767px)").matches) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)) return;
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("ops-search")?.focus();
      }
      if (e.key === "r") setTick((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = query.trim().toLowerCase();
  const ranked = useMemo(() => {
    if (attention) {
      const hot: TodayItem[] = [];
      for (const board of boards) {
        for (const name of ["Waiting On", "This Week", "In Progress", "Next Week"]) {
          for (const card of board.columns[name]?.cards || []) {
            if (card.checked) continue;
            const overdue = (card.overdue_days ?? 0) > 0;
            const dueToday = card.overdue_days === 0;
            const waiting = name === "Waiting On";
            if (!overdue && !waiting && !dueToday) continue;
            hot.push({
              kind: "task",
              id: card.id,
              text: card.text,
              why: name,
              when_label: overdue ? `${card.overdue_days}d overdue` : waiting ? "waiting" : "due today",
              urgency: overdue || card.priority === "red" ? "hot" : "normal",
              board_name: board.board_name,
              ui_label: board.ui_label,
              color: board.color,
              card: { ...card, board_name: board.board_name, ui_label: board.ui_label, color: board.color, board_file: board.board_file },
            });
          }
        }
      }
      return hot;
    }
    return today;
  }, [attention, boards, today]);

  const matches = useMemo(() => {
    if (!q) return ranked;
    const hits: TodayItem[] = [];
    for (const board of boards) {
      for (const col of Object.values(board.columns)) {
        for (const card of col.cards || []) {
          if (card.checked) continue;
          const blob = `${card.text} ${card.column} ${board.ui_label}`.toLowerCase();
          if (!blob.includes(q)) continue;
          hits.push({
            kind: "task",
            id: card.id,
            text: card.text,
            why: card.column,
            when_label: card.due || card.column,
            urgency: (card.overdue_days ?? 0) > 0 ? "hot" : "normal",
            board_name: board.board_name,
            ui_label: board.ui_label,
            color: board.color,
            card: { ...card, board_name: board.board_name, ui_label: board.ui_label, color: board.color, board_file: board.board_file },
          });
        }
      }
    }
    return hits;
  }, [q, ranked, boards]);

  function openTask(board: Board, card: TaskCard) {
    setLaunch({
      kind: "task",
      board_name: board.board_name,
      ui_label: board.ui_label,
      color: board.color,
      title: card.text,
      kicker: `${board.ui_label} · ${card.column}${card.due ? ` · ${card.due}` : ""}`,
      card,
    });
  }

  function openToday(item: TodayItem) {
    if (item.kind === "pulse") {
      setLaunch({
        kind: "pulse",
        board_name: item.board_name,
        ui_label: item.ui_label,
        color: item.color,
        title: item.text,
        kicker: `${item.ui_label} · pulse`,
      });
      return;
    }
    const board = boards.find((b) => b.board_name === item.board_name);
    if (board && item.card) openTask(board, item.card);
    else {
      setLaunch({
        kind: "focus",
        board_name: item.board_name,
        ui_label: item.ui_label,
        color: item.color,
        title: item.text,
        kicker: item.ui_label,
      });
    }
  }

  const activeBoard = area ? boards.find((b) => b.board_name === area) : null;
  const activeFocus = area ? focusCards.find((c) => c.board_name === area) : null;
  // The board an Ops service's live count belongs to, when it names one.
  const pulseBoard = pulse?.board_name ? boards.find((b) => b.board_name === pulse.board_name) : undefined;

  const waitingTotal = boards.reduce((n, b) => n + (b.waiting_count || 0), 0);
  const morning = useMorning(!!meta);
  const lastLaunch = useRef<LaunchTarget | null>(null);
  if (launch) lastLaunch.current = launch;
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const vaultButton = (
    <button
      type="button"
      className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-white/6 hover:text-fg"
      aria-label={builtin ? "Second Brain folder" : "Vault settings"}
      onClick={openFolderSettings}
    >
      <SlidersHorizontalIcon size={19} />
    </button>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-pane">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        {hideTabs ? (
          <>
            <div className="min-w-0 flex-1">
              <h1 className="text-headline text-fg">Today</h1>
              <p className="truncate text-caption text-fg-3">{dateLabel}</p>
            </div>
            {vaultButton}
            {trailing}
          </>
        ) : (
          <SurfaceTabs
            surface={surface}
            onChange={onSurface}
            trailing={
              <div className="ml-auto flex items-center gap-1">
                <span className="text-callout text-fg-3">{dateLabel}</span>
                {vaultButton}
              </div>
            }
          />
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-10 pt-4">
        {!meta && !online ? (
          <OpsDown builtin={builtin} error={error} onRetry={() => setTick((n) => n + 1)} />
        ) : (
          <>
            <StatTiles open={meta?.open_total} overdue={meta?.overdue_total} waiting={meta ? waitingTotal : undefined} animate={morning} />

            <label className="mb-4 mt-4 flex min-h-11 items-center gap-2.5 rounded-full border border-line-2 bg-card px-4 text-body text-fg-3 focus-within:border-[rgb(255_255_255/0.26)]">
              <SearchIcon size={17} />
              <input
                id="ops-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a task"
                className="min-w-0 flex-1 bg-transparent text-fg outline-hidden placeholder:text-fg-3"
              />
              {query ? (
                <button type="button" aria-label="Clear search" className="press -mr-2 flex h-9 w-9 items-center justify-center rounded-full text-fg-3 hover:text-fg" onClick={() => setQuery("")}>
                  <XIcon size={16} />
                </button>
              ) : null}
            </label>

            {error ? <Banner tone="danger">{error}</Banner> : null}
            {meta && !meta.vault_exists ? (
              <button type="button" className="press mb-3 block w-full text-left" onClick={openFolderSettings}>
                <Banner tone="danger">
                  {builtin ? "Your Second Brain folder is missing. Choose it again." : "Vault path not found. Open settings and point it at the second brain folder."}
                </Banner>
              </button>
            ) : null}
            {meta?.lock_present ? <Banner tone="warn">Vault write lock is on. Wait before asking {assistant} to update boards.</Banner> : null}
            {stale ? <Banner tone="neutral">The focus summary looks stale. Trust the board dates.</Banner> : null}

            {area && activeBoard ? (
              <AreaDrill
                board={activeBoard}
                focus={activeFocus ?? undefined}
                pulse={pulseBoard && activeBoard.board_name === pulseBoard.board_name ? pulse : null}
                query={q}
                selectedId={launch?.card?.id}
                onBack={() => setArea(null)}
                onTask={(card) => openTask(activeBoard, card)}
              />
            ) : (
              <>
                <div className="mb-2 mt-1 flex items-center justify-between gap-3">
                  <h2 className="text-headline text-fg">{q ? "Matches" : attention ? "Needs attention" : "Do first"}</h2>
                  {q ? null : (
                    <div className="flex rounded-full border border-line bg-card p-0.5" role="tablist" aria-label="Order">
                      {[
                        { on: !attention, label: "Ranked", set: false },
                        { on: attention, label: "Attention", set: true },
                      ].map((opt) => (
                        <button
                          key={opt.label}
                          type="button"
                          role="tab"
                          aria-selected={opt.on}
                          className={`relative min-h-9 rounded-full px-3 text-callout font-medium transition-colors duration-fast ${opt.on ? "text-fg" : "text-fg-3 hover:text-fg-2"}`}
                          onClick={() => setAttention(opt.set)}
                        >
                          {opt.on ? <motion.span layoutId="today-order" className="absolute inset-0 rounded-full bg-white/10" transition={SPRING.snappy} /> : null}
                          <span className="relative">{opt.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {matches.length === 0 ? (
                  <p className="rounded-card border border-line bg-card px-4 py-6 text-center text-body text-fg-3">
                    {q ? "No tasks match that search." : meta ? "Nothing ranked for today. Enjoy it." : "Reading vault…"}
                  </p>
                ) : (
                  <ol className="overflow-hidden rounded-card border border-line bg-card">
                    {matches.map((item, i) => (
                      <motion.li
                        key={item.id}
                        className="border-b border-line last:border-b-0"
                        initial={morning ? { opacity: 0, y: 10 } : false}
                        animate={{ opacity: 1, y: 0, transition: { delay: morning ? 0.25 + Math.min(i, 8) * 0.04 : 0, duration: 0.32, ease: EASE.enter } }}
                      >
                        <TaskRow item={item} rank={i + 1} selected={launch?.title === item.text} onClick={() => openToday(item)} />
                      </motion.li>
                    ))}
                  </ol>
                )}

                {boards.length ? (
                  <>
                    <h2 className="mb-2 mt-7 text-headline text-fg">Areas</h2>
                    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
                      {boards.map((board, i) => (
                        <motion.button
                          key={board.board_name}
                          type="button"
                          data-area={board.board_name}
                          className="press flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-line-2 bg-card px-3.5 text-callout text-fg hover:border-line-3"
                          onClick={() => setArea(board.board_name)}
                          initial={morning ? { opacity: 0, x: 12 } : false}
                          animate={{ opacity: 1, x: 0, transition: { delay: morning ? 0.4 + i * 0.04 : 0, duration: 0.3, ease: EASE.enter } }}
                        >
                          <span className="h-2 w-2 rounded-full" style={{ background: board.color }} />
                          {board.ui_label}
                          <span className="font-mono text-code tabular text-fg-3">{board.open_count}</span>
                        </motion.button>
                      ))}
                    </div>
                  </>
                ) : null}

                {pulse?.grand != null ? (
                  <div className="mt-5 flex items-center gap-3 rounded-card border border-line bg-card px-4 py-3">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" style={pulseBoard?.color ? { background: pulseBoard.color } : undefined} />
                    <span className="min-w-0 flex-1 text-callout text-fg-2">
                      <span className="font-medium text-fg">{pulseLine(pulse).label}</span> · <span className="tabular">{pulseLine(pulse).detail}</span>
                    </span>
                  </div>
                ) : null}
              </>
            )}
          </>
        )}
      </div>

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          setSettingsOpen(false);
          setTick((n) => n + 1);
        }}
      />
      {lastLaunch.current ? (
        <IntentSheet
          open={!settingsOpen && !!launch}
          target={launch ?? lastLaunch.current}
          onClose={() => setLaunch(null)}
          onSent={async (text) => {
            await onSendToChief(text);
            setLaunch(null);
          }}
        />
      ) : null}
    </div>
  );
}

const MORNING_KEY = "chief-today-morning";

/** First open of the day plays the morning moment once: counts roll up, rows cascade (§3.2). */
function useMorning(ready: boolean) {
  const [morning, setMorning] = useState(false);
  const decided = useRef(false);
  useEffect(() => {
    if (!ready || decided.current) return;
    decided.current = true;
    const today = new Date().toDateString();
    try {
      if (localStorage.getItem(MORNING_KEY) !== today) {
        localStorage.setItem(MORNING_KEY, today);
        setMorning(true);
      }
    } catch {
      /* no storage: skip the moment */
    }
  }, [ready]);
  return morning;
}

function CountUp({ value, animate: run }: { value: number | undefined; animate: boolean }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = el.current;
    if (!node || value == null) return;
    if (!run) {
      node.textContent = String(value);
      return;
    }
    const controls = animateValue(0, value, {
      duration: 0.8,
      ease: EASE.enter,
      onUpdate: (v) => {
        node.textContent = String(Math.round(v));
      },
    });
    return () => controls.stop();
  }, [value, run]);
  return <span ref={el}>{value == null ? "–" : run ? "0" : value}</span>;
}

function StatTiles({ open, overdue, waiting, animate: run }: { open?: number; overdue?: number; waiting?: number; animate: boolean }) {
  const tiles = [
    { label: "Open", value: open, tone: "text-fg" },
    { label: "Overdue", value: overdue, tone: overdue ? "text-danger" : "text-fg" },
    { label: "Waiting", value: waiting, tone: waiting ? "text-warn" : "text-fg" },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {tiles.map((t, i) => (
        <motion.div
          key={t.label}
          className="rounded-card border border-line bg-card px-3.5 py-3"
          initial={run ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0, transition: { delay: run ? i * 0.06 : 0, duration: 0.35, ease: EASE.enter } }}
        >
          <div className="text-caption font-medium text-fg-3">{t.label}</div>
          <div className={`mt-0.5 font-mono text-[1.625rem] font-medium leading-8 tabular ${t.tone}`}>
            <CountUp value={t.value} animate={run} />
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function Banner({ tone, children }: { tone: "danger" | "warn" | "neutral"; children: React.ReactNode }) {
  const cls = tone === "danger" ? "border-danger/30 bg-danger/8 text-fg" : tone === "warn" ? "border-warn/30 bg-warn/8 text-fg" : "border-line bg-card text-fg-2";
  const Icon = tone === "neutral" ? ClockIcon : TriangleAlertIcon;
  return (
    <p className={`mb-3 flex items-start gap-2.5 rounded-card border px-3.5 py-2.5 text-callout ${cls}`}>
      <Icon size={16} className={`mt-0.5 shrink-0 ${tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-fg-3"}`} />
      <span>{children}</span>
    </p>
  );
}

function OpsDown({ builtin, error, onRetry }: { builtin: boolean; error: string | null; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full border border-line-2 bg-card text-fg-3">
        <WifiOffIcon size={28} />
      </span>
      <h2 className="mt-5 text-title text-fg">Your vault is out of reach</h2>
      <p className="mt-2 max-w-xs text-body text-fg-3">
        {builtin ? "Today reads tasks from your Second Brain folder, and it couldn't be read." : "Today reads tasks through your task service, and it isn't answering."}
      </p>
      {error ? <p className="mt-2 max-w-xs text-caption text-fg-3">{error}</p> : null}
      <button type="button" className="press mt-6 flex min-h-11 items-center gap-2 rounded-full border border-line-2 bg-card px-5 text-callout font-medium text-fg hover:border-line-3" onClick={onRetry}>
        <RefreshCwIcon size={16} />
        Try again
      </button>
    </div>
  );
}

function UrgencyPill({ item }: { item: TodayItem }) {
  const label = item.when_label;
  if (!label) return null;
  const lower = label.toLowerCase();
  const waiting = lower.includes("waiting");
  const cls =
    item.urgency === "hot"
      ? waiting
        ? "bg-warn/15 text-warn"
        : "bg-danger/15 text-danger"
      : item.urgency === "soon" || waiting
        ? "bg-warn/15 text-warn"
        : lower.includes("today")
          ? "bg-accent/15 text-accent-text"
          : "text-fg-3";
  const pill = cls !== "text-fg-3";
  return <span className={`shrink-0 whitespace-nowrap text-caption font-medium ${pill ? `rounded-full px-2 py-0.5 ${cls}` : cls}`}>{label}</span>;
}

function TaskRow({ item, rank, selected, onClick }: { item: TodayItem; rank: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`press grid w-full grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2 px-3.5 py-3 text-left hover:bg-white/3 ${selected ? "bg-white/5" : ""}`}
      onClick={onClick}
    >
      <span className="pt-px font-mono text-callout tabular text-fg-3">{String(rank).padStart(2, "0")}</span>
      <span className="min-w-0">
        <span className="line-clamp-2 text-body font-medium text-fg">{item.text}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex items-center gap-1.5 text-caption text-fg-3">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
            {item.ui_label}
          </span>
          <UrgencyPill item={item} />
        </span>
      </span>
    </button>
  );
}

function AreaDrill({
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
                        className={`press block w-full px-3.5 py-3 text-left hover:bg-white/3 ${selectedId === card.id ? "bg-white/5" : ""}`}
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

export function IntentSheet({
  target,
  onClose,
  onSent,
  open = true,
}: {
  target: LaunchTarget;
  onClose: () => void;
  onSent: (text: string) => Promise<void>;
  open?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} bare scope="container" zIndex={40} closeDisabled={busy}>
      <IntentBody target={target} onClose={onClose} onSent={onSent} onBusy={setBusy} />
    </Sheet>
  );
}

function IntentBody({
  target,
  onClose,
  onSent,
  onBusy,
}: {
  target: LaunchTarget;
  onClose: () => void;
  onSent: (text: string) => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const assistant = useAssistantName();
  const isTask = target.kind === "task";
  const intents = isTask ? TASK_INTENTS : FOCUS_INTENTS;
  const [intent, setIntent] = useState<Intent>(intents[0].id);
  const [message, setMessage] = useState("");
  const [due, setDue] = useState("");
  const [blocker, setBlocker] = useState("");
  const [prepared, setPrepared] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusyState] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setBusy = (v: boolean) => {
    setBusyState(v);
    onBusy(v);
  };

  useEffect(() => {
    setIntent(intents[0].id);
    setMessage("");
    setDue("");
    setBlocker("");
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.title, target.card?.id]);

  async function send(next: Intent) {
    setBusy(true);
    setErr(null);
    try {
      const key = JSON.stringify([next, target.board_name, target.card?.id, message, due, blocker]);
      const res = prepared?.key === key ? { kickoff: prepared.text } : await ops.launch({
        intent: next,
        board_name: target.board_name,
        card_id: target.card?.id ?? null,
        user_message: message,
        due: due || null,
        blocker: blocker || null,
        mode: "chat_inject",
      });
      const kickoff = res.kickoff?.trim();
      if (!kickoff) throw new Error("Launch did not return a kickoff.");
      setPrepared({ key, text: kickoff });
      await onSent(kickoff);
    } catch (e) {
      setErr(e instanceof Error ? e.message : `Could not send to ${assistant}.`);
    } finally {
      setBusy(false);
    }
  }

  const field = "mt-1.5 min-h-11 w-full rounded-ctl border border-line-2 bg-canvas px-3 py-2 text-body text-fg outline-hidden placeholder:text-fg-3 focus:border-line-3";
  return (
    <div className="px-4 pb-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="mb-1 flex items-center gap-1.5 text-caption text-fg-3">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: target.color }} />
            {target.kicker}
          </p>
          <h3 className="text-title text-fg">{target.title}</h3>
        </div>
        <button
          type="button"
          className="press -mr-1 min-h-11 rounded-full px-3 text-callout text-fg-2 hover:bg-white/6 hover:text-fg disabled:opacity-40"
          disabled={busy}
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Intent">
        {intents.map((row) => (
          <button
            key={row.id}
            type="button"
            role="radio"
            aria-checked={intent === row.id}
            className={`press relative min-h-11 rounded-full border px-4 text-callout font-medium transition-colors duration-fast ${
              intent === row.id ? "border-transparent text-fg" : "border-line-2 text-fg-3 hover:text-fg-2"
            }`}
            onClick={() => setIntent(row.id)}
          >
            {intent === row.id ? <motion.span layoutId="intent-pill" className="absolute inset-0 rounded-full bg-white/10" transition={SPRING.snappy} /> : null}
            <span className="relative">{row.label}</span>
          </button>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {intent === "task.reschedule" ? (
          <motion.label key="due" className="mb-3 block text-callout text-fg-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            New due date
            <input
              type="date"
              value={due}
              min={new Date().toLocaleDateString("en-CA")}
              onChange={(e) => setDue(e.target.value)}
              className={`${field} scheme-dark`}
            />
          </motion.label>
        ) : null}
        {intent === "task.block" ? (
          <motion.label key="blocker" className="mb-3 block text-callout text-fg-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            Blocker
            <input value={blocker} onChange={(e) => setBlocker(e.target.value)} placeholder="Waiting on…" className={field} />
          </motion.label>
        ) : null}
      </AnimatePresence>
      <label className="mb-4 block text-callout text-fg-2">
        Note for {assistant}
        <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional context" className={`${field} resize-none`} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className="press flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-accent-solid px-5 text-callout font-semibold text-white shadow-[0_4px_18px_rgb(var(--c-accent)/0.3)] disabled:opacity-50"
          onClick={() => void send(intent)}
        >
          {busy ? "Sending…" : `Send to ${assistant}`}
        </button>
        {isTask ? (
          <button
            type="button"
            disabled={busy}
            className="press flex min-h-11 items-center justify-center gap-2 rounded-full border border-line-2 px-5 text-callout font-medium text-fg hover:border-line-3 disabled:opacity-50"
            onClick={() => void send("task.complete")}
          >
            <CircleCheckIcon size={16} />
            Mark complete
          </button>
        ) : null}
      </div>
      {err ? (
        <p role="alert" className="mt-3 text-callout text-danger">
          {err}
        </p>
      ) : null}
    </div>
  );
}

function SettingsSheet({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const assistant = useAssistantName();
  return (
    <Sheet open={open} onClose={onClose} title="Vault" subtitle={`Boards are read from this folder. ${assistant} writes the vault.`} scope="container" zIndex={40}>
      <VaultBody onSaved={onSaved} />
    </Sheet>
  );
}

function VaultBody({ onSaved }: { onSaved: () => void }) {
  const [vaultPath, setVaultPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    ops
      .settings()
      .then((s) => setVaultPath(s.vault_path))
      .catch((e: Error) => setErr(e.message));
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await ops.saveSettings({ vault_path: vaultPath.trim() });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 pb-6">
      <label className="block text-callout text-fg-2">
        Vault path
        <input
          value={vaultPath}
          onChange={(e) => setVaultPath(e.target.value)}
          placeholder="D:\Notes\Second Brain"
          className="mt-1.5 min-h-11 w-full rounded-ctl border border-line-2 bg-canvas px-3 py-2 font-mono text-code text-fg outline-hidden placeholder:text-fg-3 focus:border-line-3"
        />
      </label>
      <button
        type="button"
        disabled={busy || !vaultPath.trim()}
        className="press mt-4 min-h-11 w-full rounded-full bg-fg px-5 text-callout font-semibold text-canvas disabled:opacity-50"
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Save settings"}
      </button>
      {err ? (
        <p role="alert" className="mt-3 text-callout text-danger">
          {err}
        </p>
      ) : null}
    </div>
  );
}
