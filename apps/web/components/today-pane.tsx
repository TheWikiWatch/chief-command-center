"use client";

import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { poll } from "@/lib/poll";
import { useResourceHealth } from "@/components/resource-status";
import { share } from "@/lib/share";
import { SurfaceTabs, type Surface } from "@/components/surface-tabs";
import { SearchIcon, SlidersHorizontalIcon, XIcon } from "@/components/icons";
import { EASE, SPRING } from "@/lib/motion";
import { useScopeVisible } from "@/lib/overlay-stack";
import { ops, fetchOpsHealth, pulseLine, type Board, type FocusCard, type Intent, type LaunchTarget, type Meta, type Pulse, type TaskCard, type TodayItem } from "@/lib/ops";
import { useAssistantName } from "@/lib/identity";
import { useAppConfig } from "@/lib/app-config";
import { SecondBrainNotSetUp } from "@/components/second-brain/not-set-up";
import { AreaDrill } from "@/components/today/area-drill";
import { IntentSheet } from "@/components/today/intent-sheet";
import { Banner, OpsDown, StatTiles, TaskRow, useMorning } from "@/components/today/parts";
import { SettingsSheet } from "@/components/today/vault-settings";

export const TASK_INTENTS: { id: Intent; label: string }[] = [
  { id: "task.discuss", label: "Discuss" },
  { id: "task.update", label: "Update" },
  { id: "task.block", label: "Block" },
  { id: "task.reschedule", label: "Reschedule" },
];

export const FOCUS_INTENTS: { id: Intent; label: string }[] = [
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
  }, [builtin, resourceHealth]);

  // A phone tab that isn't showing checks once a minute, and refreshes the moment it is shown again.
  const visible = useScopeVisible();
  useEffect(() => poll(refresh, () => (visible ? pollSeconds.current * 1000 : 60_000)), [refresh, tick, visible]);

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
      className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-fill-2 hover:text-fg"
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
                          {opt.on ? <motion.span layoutId="today-order" className="absolute inset-0 rounded-full bg-fill-3" transition={SPRING.snappy} /> : null}
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
