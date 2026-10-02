"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { MessageCircleIcon, SearchIcon } from "@/components/icons";
import { LAYER } from "@/lib/layers";
import { EASE } from "@/lib/motion";
import { useLayer } from "@/lib/overlay-stack";
import { matches } from "@/lib/palette-match";
import { shortcutText, type ShortcutId } from "@/lib/shortcuts";
import { useModal } from "@/lib/use-modal";

export type PaletteCommand = {
  id: string;
  label: string;
  group: "Recent" | "Go to" | "Chat" | "Threads" | "Fleet" | "Vault" | "Settings" | "App";
  icon?: ReactNode;
  /** Other words that find it ("preferences" finds Settings). */
  keywords?: string;
  shortcut?: ShortcutId;
  run: () => void;
};

const RECENT_KEY = "chief-palette-recent";
const RECENT_MAX = 5;

/** Ids of the commands run most recently, newest first (per device). */
export function loadRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function rememberRecent(id: string) {
  if (id === "ask" || id.startsWith("vault:")) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)));
  } catch {
    // Private mode or storage full: the palette just has no recents.
  }
}

/** With no query: the recent commands first (as "Recent"), then the rest. */
export function withRecent(commands: PaletteCommand[], recent: string[]): PaletteCommand[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const top = recent.map((id) => byId.get(id)).filter((c): c is PaletteCommand => !!c);
  const ids = new Set(top.map((c) => c.id));
  return [...top.map((c) => ({ ...c, group: "Recent" as const })), ...commands.filter((c) => !ids.has(c.id))];
}

export { matches };

/**
 * The command palette (Ctrl+K): go anywhere, open any setting, start a thread, and, for anything else typed,
 * ask the chief (the text goes to the message box, never sent on its own). Arrow keys move, Enter runs,
 * Escape closes.
 */
type PaletteProps = {
  onClose: () => void;
  commands: PaletteCommand[];
  assistant: string;
  onAsk: (text: string) => void;
  /** More results for a query (the Vault's notes), fetched as the owner types. */
  search?: (query: string, signal: AbortSignal) => Promise<PaletteCommand[]>;
};

export function CommandPalette({ open, ...props }: PaletteProps & { open: boolean }) {
  return <AnimatePresence>{open ? <Palette key="palette" {...props} /> : null}</AnimatePresence>;
}

function Palette({ onClose, commands, assistant, onAsk, search }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [recent] = useState(loadRecent);
  const [found, setFound] = useState<{ query: string; items: PaletteCommand[] }>({ query: "", items: [] });
  // Search results arrive a moment after typing stops; stale ones (an older query) are never shown.
  useEffect(() => {
    const q = query.trim();
    if (!search || q.length < 2) return;
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      search(q, ac.signal).then(
        (items) => setFound({ query: q, items }),
        () => undefined,
      );
    }, 180);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [query, search]);
  const [active, setActive] = useState(0);
  const listId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const trapTab = useModal(panel, { inert: true });
  useLayer(true, onClose);

  const shown = useMemo(() => {
    const q = query.trim();
    if (!q) return withRecent(commands, recent);
    const hits = commands.filter((c) => matches(c, query));
    const extra = found.query === q ? found.items : [];
    const ask: PaletteCommand[] = [{ id: "ask", label: `Ask ${assistant}: “${q}”`, group: "Chat", icon: <MessageCircleIcon size={17} />, run: () => onAsk(q) }];
    return [...hits, ...extra, ...ask];
  }, [commands, query, assistant, onAsk, recent, found]);

  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (command: PaletteCommand | undefined) => {
    if (!command) return;
    rememberRecent(command.id);
    onClose();
    // After the palette is gone, so focus lands where the command sends it.
    window.setTimeout(command.run, 0);
  };

  return (
    <div className="fixed inset-0" style={{ zIndex: LAYER.drawer }}>
      <motion.div
        className="absolute inset-0 bg-(--scrim)"
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 0.16 } }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
        onClick={onClose}
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onKeyDown={trapTab}
        className="absolute left-1/2 top-[12vh] flex max-h-[min(560px,76vh)] w-[min(640px,calc(100%-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-sheet border border-line-2 bg-raised shadow-e4 outline-hidden"
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.2, ease: EASE.enter } }}
        exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.12, ease: EASE.exit } }}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <SearchIcon size={18} className="shrink-0 text-fg-3" />
          <input
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(shown[active]);
              }
            }}
            placeholder={`Go to, open, or ask ${assistant}…`}
            className="min-h-14 min-w-0 flex-1 bg-transparent text-headline font-normal text-fg outline-hidden placeholder:text-fg-3"
            spellCheck={false}
          />
          <kbd className="hidden shrink-0 rounded-chip border border-line-2 px-1.5 font-mono text-micro text-fg-3 sm:block">Esc</kbd>
        </div>
        <ul ref={list} id={listId} role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {shown.length === 0 ? <li className="px-3 py-6 text-center text-body text-fg-3">Nothing matches.</li> : null}
          {shown.map((command, i) => {
            const header = i === 0 || shown[i - 1].group !== command.group ? command.group : "";
            return (
              <li key={command.id} role="presentation">
                {header ? <p className="px-3 pb-1 pt-2.5 text-caption font-medium text-fg-3">{header}</p> : null}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  tabIndex={-1}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(command)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") run(command);
                  }}
                  className={`flex min-h-11 cursor-default items-center gap-3 rounded-ctl px-3 text-body ${i === active ? "bg-fill-2 text-fg" : "text-fg-2"}`}
                >
                  <span className="grid size-5 shrink-0 place-items-center text-fg-3">{command.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                  {command.shortcut ? <kbd className="shrink-0 font-mono text-micro text-fg-3">{shortcutText(command.shortcut)}</kbd> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </motion.div>
    </div>
  );
}

