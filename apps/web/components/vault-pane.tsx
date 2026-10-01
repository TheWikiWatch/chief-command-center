"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";

import {
  BookOpenIcon,
  LinkIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoCameraIcon,
  FolderIcon,
  HistoryIcon,
  HouseIcon,
  MusicIcon,
  SearchIcon,
  XIcon,
} from "@/components/icons";
import { SurfaceTabs, type Surface } from "@/components/surface-tabs";
import { useDashboardPrefs } from "@/lib/dashboard-prefs";
import { useLayer } from "@/lib/overlay-stack";
import { EASE, SPRING } from "@/lib/motion";
import { showToast } from "@/lib/toast-store";
import {
  absoluteVaultPath,
  displayName,
  kindOfName,
  loadRecents,
  obsidianToMarkdown,
  parseVaultHref,
  rememberRecent,
  repairMojibake,
  splitFrontmatter,
  takeVaultOpen,
  useVaultOpenSignal,
  vaultBacklinks,
  vaultFileUrl,
  vaultResolve,
  vaultSearch,
  vaultText,
  vaultTree,
  type Recent,
  type VaultEntry,
  type VaultHit,
  type VaultKind,
} from "@/lib/vault-client";
import { useAssistantName } from "@/lib/identity";
import { useAppConfig } from "@/lib/app-config";
import { SecondBrainNotSetUp } from "@/components/second-brain/not-set-up";

type Open = { path: string; kind: VaultKind; heading?: string };

/**
 * The Vault tab (PLAN-2026-09-23 §4): browse, search and read the Second Brain, read-only.
 * Wide panes show the folder list and the reader side by side; narrow ones (the phone, the rail)
 * show one at a time with a back step.
 */
type VaultPaneProps = { phone: boolean; surface: Surface; onSurface: (next: Surface) => void; trailing?: ReactNode; onSetUpSecondBrain?: () => void };

/** The Vault browses the Second Brain folder when one is configured. */
export function VaultPane(props: VaultPaneProps) {
  const config = useAppConfig();
  if (!config.features.vault) {
    return <SecondBrainNotSetUp title="Vault" surface={props.surface} onSurface={props.onSurface} hideTabs={props.phone} trailing={props.trailing} onSetUp={props.onSetUpSecondBrain} />;
  }
  return <VaultBrowser {...props} />;
}

function VaultBrowser({ phone, surface, onSurface, trailing }: VaultPaneProps) {
  const root = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(!phone);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  // The start page: a Second Brain made by the app has Home.md; other vaults often keep an index.md.
  const [startNote, setStartNote] = useState("index.md");
  useEffect(() => {
    if (dir === "" && entries) setStartNote(entries.some((e) => !e.dir && e.path === "Home.md") ? "Home.md" : "index.md");
  }, [dir, entries]);
  const [treeError, setTreeError] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<VaultHit[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const [trail, setTrail] = useState<Open[]>([]);
  const [recents, setRecents] = useState<Recent[]>([]);
  const prefs = useDashboardPrefs(phone);

  useEffect(() => setRecents(loadRecents()), [open]);

  // Side by side only when there is room for both.
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWide(!phone && el.clientWidth >= 760));
    ro.observe(el);
    return () => ro.disconnect();
  }, [phone]);

  useEffect(() => {
    const ctrl = new AbortController();
    setTreeError("");
    vaultTree(dir, ctrl.signal)
      .then((data) => setEntries(data.entries))
      .catch((error: unknown) => {
        if (ctrl.signal.aborted) return;
        setEntries([]);
        setTreeError(error instanceof Error ? error.message : "The vault could not be read");
      });
    return () => ctrl.abort();
  }, [dir]);

  useEffect(() => {
    const q = query.trim();
    setSearchError("");
    if (!q) {
      setHits(null);
      return;
    }
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      vaultSearch(q, ctrl.signal)
        .then((data) => setHits(data.hits))
        .catch((error: unknown) => {
          if (ctrl.signal.aborted) return;
          setHits([]);
          setSearchError(error instanceof Error ? error.message : "Search failed");
        });
    }, 180);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  // The open file is mirrored in a ref so the Back trail is updated outside a state updater
  // (updaters run twice in development, which pushed every step twice).
  const openRef = useRef<Open | null>(null);
  openRef.current = open;
  const show = useCallback((next: Open, push = true) => {
    const current = openRef.current;
    if (push && current && current.path !== next.path) setTrail((t) => [...t.slice(-20), current]);
    openRef.current = next;
    setOpen(next);
    rememberRecent(next.path);
    const folder = next.path.split("/").slice(0, -1).join("/");
    setDir((d) => (d === folder ? d : folder));
  }, []);

  const follow = useCallback(
    async (ref: string, from?: string) => {
      try {
        const hit = await vaultResolve(ref, from);
        show({ path: hit.path, kind: hit.kind, heading: hit.heading || undefined });
      } catch {
        showToast({ title: "Not in the vault", body: displayName(ref.split(/[\\/]/).pop() || ref), tone: "warn", icon: "alert" });
      }
    },
    [show],
  );

  // Links from the chief (or anywhere) land here: take the request when it arrives or when this pane mounts.
  const signal = useVaultOpenSignal();
  useEffect(() => {
    const req = takeVaultOpen();
    if (req) void follow(req.ref, req.from);
  }, [signal, follow]);

  const back = () => {
    const prev = trail[trail.length - 1];
    if (prev) {
      setTrail((t) => t.slice(0, -1));
      show(prev, false);
    } else setOpen(null);
  };
  // One pane at a time (phone, rail): Back steps out of the reader instead of leaving the tab.
  const backRef = useRef(back);
  backRef.current = back;
  useLayer(!wide && !!open, () => backRef.current());

  const browser = (
    <Browser
      dir={dir}
      entries={entries}
      error={treeError}
      query={query}
      hits={hits}
      searchError={searchError}
      recents={recents}
      openPath={open?.path}
      onQuery={setQuery}
      onDir={(d) => setDir(d)}
      onOpen={(entry) => show({ path: entry.path, kind: entry.kind || kindOfName(entry.name) })}
    />
  );
  const reader = open ? (
    <Reader
      key={open.path}
      open={open}
      fontPx={prefs.fontPx}
      canBack={!wide || trail.length > 0}
      onBack={back}
      onFollow={(ref) => void follow(ref, open.path)}
      onFolder={(folder) => {
        setDir(folder);
        if (!wide) setOpen(null);
      }}
    />
  ) : wide ? (
    <EmptyReader home={startNote} recents={recents} onOpen={(path) => show({ path, kind: kindOfName(path) })} />
  ) : null;

  return (
    <div ref={root} className="relative flex h-full min-h-0 flex-col bg-pane">
      <header className="relative z-20 flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        {phone ? (
          <>
            <div className="min-w-0 flex-1">
              <h1 className="text-headline text-fg">Vault</h1>
              <p className="truncate text-caption text-fg-3">Second Brain · read-only</p>
            </div>
            {trailing}
          </>
        ) : (
          <SurfaceTabs surface={surface} onChange={onSurface} trailing={<span className="ml-auto text-callout text-fg-3">Second Brain · read-only</span>} />
        )}
      </header>
      {wide ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[300px] shrink-0 flex-col border-r border-line">{browser}</div>
          <div className="min-w-0 flex-1">{reader}</div>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence initial={false} mode="popLayout">
            {open ? (
              <motion.div
                key="reader"
                className="absolute inset-0 bg-pane"
                initial={{ x: "30%", opacity: 0 }}
                animate={{ x: 0, opacity: 1, transition: { duration: 0.28, ease: EASE.enter } }}
                exit={{ x: "30%", opacity: 0, transition: { duration: 0.18, ease: EASE.exit } }}
              >
                {reader}
              </motion.div>
            ) : (
              <motion.div
                key="browser"
                className="absolute inset-0 flex flex-col"
                initial={{ x: "-12%", opacity: 0 }}
                animate={{ x: 0, opacity: 1, transition: { duration: 0.24, ease: EASE.enter } }}
                exit={{ x: "-12%", opacity: 0, transition: { duration: 0.16 } }}
              >
                {browser}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ browser */

function Browser({
  dir,
  entries,
  error,
  query,
  hits,
  searchError,
  recents,
  openPath,
  onQuery,
  onDir,
  onOpen,
}: {
  dir: string;
  entries: VaultEntry[] | null;
  error: string;
  query: string;
  hits: VaultHit[] | null;
  searchError: string;
  recents: Recent[];
  openPath?: string;
  onQuery: (q: string) => void;
  onDir: (dir: string) => void;
  onOpen: (entry: VaultEntry) => void;
}) {
  const crumbs = dir ? dir.split("/") : [];
  const searching = query.trim().length > 0;
  return (
    <>
      <div className="shrink-0 px-3 pb-2 pt-3">
        <label className="flex min-h-11 items-center gap-2.5 rounded-full border border-line-2 bg-card px-4 text-body text-fg-3 focus-within:border-[rgb(255_255_255/0.26)]">
          <SearchIcon size={17} />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search the vault"
            aria-label="Search the vault"
            className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-3"
          />
          {query ? (
            <button type="button" aria-label="Clear search" className="press -mr-2 grid size-9 place-items-center rounded-full text-fg-3 hover:text-fg" onClick={() => onQuery("")}>
              <XIcon size={16} />
            </button>
          ) : null}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-24 md:pb-6">
        {searching ? (
          <SearchResults hits={hits} error={searchError} query={query} openPath={openPath} onOpen={onOpen} />
        ) : (
          <>
            <nav aria-label="Folder" className="flex min-h-10 items-center gap-0.5 overflow-x-auto px-1.5 pb-1 text-callout">
              <Crumb label="Vault" icon={<HouseIcon size={15} />} active={!dir} onClick={() => onDir("")} />
              {crumbs.map((name, i) => (
                <span key={i} className="flex shrink-0 items-center gap-0.5">
                  <ChevronRightIcon size={14} className="text-fg-4" />
                  <Crumb label={name} active={i === crumbs.length - 1} onClick={() => onDir(crumbs.slice(0, i + 1).join("/"))} />
                </span>
              ))}
            </nav>
            {!dir && recents.length ? (
              <section className="mb-2">
                <h3 className="px-2.5 pb-1 pt-2 text-caption font-medium uppercase tracking-wider text-fg-3">Recent</h3>
                {recents.slice(0, 4).map((r) => {
                  const name = r.path.split("/").pop() || r.path;
                  return (
                    <Row
                      key={r.path}
                      icon={<KindIcon kind={kindOfName(name)} />}
                      title={displayName(name)}
                      meta={r.path.split("/").slice(0, -1).join(" / ") || "Vault"}
                      active={r.path === openPath}
                      onClick={() => onOpen({ name, path: r.path, dir: false, kind: kindOfName(name), mtime: r.at })}
                    />
                  );
                })}
                <h3 className="px-2.5 pb-1 pt-3 text-caption font-medium uppercase tracking-wider text-fg-3">Folders</h3>
              </section>
            ) : null}
            {error ? <p className="mx-2 mt-2 rounded-card border border-danger/30 bg-danger/10 px-3 py-2.5 text-callout text-danger">{error}</p> : null}
            {entries === null ? (
              <div className="space-y-1.5 px-1 pt-1" role="status" aria-label="Loading the vault">
                {Array.from({ length: 7 }, (_, i) => (
                  <div key={i} className="h-12 rounded-ctl bg-white/[0.035]" style={{ opacity: 1 - i * 0.11 }} />
                ))}
              </div>
            ) : entries.length === 0 && !error ? (
              <p className="px-3 py-6 text-center text-callout text-fg-3">This folder is empty.</p>
            ) : (
              <ul>
                {entries.map((e) => (
                  <li key={e.path}>
                    <Row
                      icon={e.dir ? <FolderIcon size={19} className="text-accent-text/80" /> : <KindIcon kind={e.kind || "other"} />}
                      title={e.dir ? e.name : displayName(e.name)}
                      meta={e.dir ? `${e.count ?? 0} ${e.count === 1 ? "item" : "items"}` : `${ago(e.mtime)}${e.size ? ` · ${bytes(e.size)}` : ""}`}
                      chevron={e.dir}
                      active={e.path === openPath}
                      onClick={() => (e.dir ? onDir(e.path) : onOpen(e))}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Crumb({ label, icon, active, onClick }: { label: string; icon?: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "location" : undefined}
      className={`press flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-2 ${active ? "font-medium text-fg" : "text-fg-3 hover:text-fg-2"}`}
    >
      {icon}
      <span className="max-w-[12rem] truncate">{label}</span>
    </button>
  );
}

function Row({
  icon,
  title,
  meta,
  chevron,
  active,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  meta?: string;
  chevron?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`press group flex min-h-12 w-full items-center gap-3 rounded-ctl px-2.5 py-1.5 text-left transition-colors duration-fast ${
        active ? "bg-white/[0.07]" : "hover:bg-white/[0.035]"
      }`}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-white/[0.045]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-body ${active ? "font-medium text-fg" : "text-fg"}`}>{title}</span>
        {meta ? <span className="block truncate text-caption text-fg-3">{meta}</span> : null}
      </span>
      {chevron ? <ChevronRightIcon size={16} className="shrink-0 text-fg-4 transition-transform duration-fast group-hover:translate-x-0.5" /> : null}
    </button>
  );
}

function SearchResults({
  hits,
  error,
  query,
  openPath,
  onOpen,
}: {
  hits: VaultHit[] | null;
  error: string;
  query: string;
  openPath?: string;
  onOpen: (e: VaultEntry) => void;
}) {
  if (error) return <p role="alert" className="mx-2 mt-2 rounded-card border border-danger/30 bg-danger/10 px-3 py-2.5 text-callout text-danger">{error}</p>;
  if (hits === null) return <p className="px-3 py-4 text-callout text-fg-3">Searching…</p>;
  if (!hits.length) return <p className="px-3 py-6 text-center text-callout text-fg-3">Nothing matches “{query.trim()}”.</p>;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (
    <ul aria-label="Search results">
      <li className="px-2.5 pb-1 pt-1 text-caption text-fg-3">
        {hits.length} {hits.length === 1 ? "result" : "results"}
      </li>
      {hits.map((h) => (
        <li key={h.path}>
          <button
            type="button"
            onClick={() => onOpen({ name: h.name, path: h.path, dir: false, kind: h.kind, mtime: 0 })}
            className={`press flex w-full items-start gap-3 rounded-ctl px-2.5 py-2 text-left ${h.path === openPath ? "bg-white/[0.07]" : "hover:bg-white/[0.035]"}`}
          >
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[9px] bg-white/[0.045]">
              <KindIcon kind={h.kind} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body text-fg">
                <Highlight text={displayName(h.name)} terms={terms} />
              </span>
              <span className="block truncate text-caption text-fg-3">{h.path.split("/").slice(0, -1).join(" / ") || "Vault"}</span>
              {h.snippet ? (
                <span className="mt-0.5 line-clamp-2 block text-caption text-fg-2">
                  <Highlight text={h.snippet} terms={terms} />
                </span>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-[3px] bg-accent/25 text-fg [box-decoration-break:clone]">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function KindIcon({ kind }: { kind: VaultKind }) {
  const cls = "text-fg-2";
  switch (kind) {
    case "note":
      return <FileTextIcon size={17} className={cls} />;
    case "image":
      return <FileImageIcon size={17} className={cls} />;
    case "video":
      return <FileVideoCameraIcon size={17} className={cls} />;
    case "audio":
      return <MusicIcon size={17} className={cls} />;
    case "text":
      return <FileCodeIcon size={17} className={cls} />;
    case "pdf":
      return <FileIcon size={17} className="text-danger/80" />;
    default:
      return <FileIcon size={17} className={cls} />;
  }
}

/* ------------------------------------------------------------------ reader */

function EmptyReader({ home, recents, onOpen }: { home: string; recents: Recent[]; onOpen: (path: string) => void }) {
  const assistant = useAssistantName();
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-sm text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-white/[0.05] text-fg-2">
          <BookOpenIcon size={26} />
        </span>
        <h2 className="mt-4 text-title text-fg">Your Second Brain</h2>
        <p className="mt-1.5 text-callout text-fg-3">Pick a note on the left, search for anything, or tap a file {assistant} links in chat.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" className="press min-h-10 rounded-full bg-fg px-4 text-callout font-semibold text-canvas" onClick={() => onOpen(home)}>
            {home === "Home.md" ? "Open Home" : "Open index"}
          </button>
          {recents[0] ? (
            <button type="button" className="press flex min-h-10 items-center gap-1.5 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg" onClick={() => onOpen(recents[0].path)}>
              <HistoryIcon size={15} /> {displayName(recents[0].path.split("/").pop() || "")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Reader({
  open,
  fontPx,
  canBack,
  onBack,
  onFollow,
  onFolder,
}: {
  open: Open;
  fontPx: number;
  canBack: boolean;
  onBack: () => void;
  onFollow: (ref: string) => void;
  onFolder: (dir: string) => void;
}) {
  const name = open.path.split("/").pop() || open.path;
  const folder = open.path.split("/").slice(0, -1);
  const url = vaultFileUrl(open.path);
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        {canBack ? (
          <button type="button" aria-label="Back" className="press grid size-11 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-white/[0.06] hover:text-fg" onClick={onBack}>
            <ChevronLeftIcon size={20} />
          </button>
        ) : (
          <span className="w-2" />
        )}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate text-headline text-fg">{displayName(name)}</h2>
          <button type="button" className="block max-w-full truncate text-left text-caption text-fg-3 hover:text-fg-2" onClick={() => onFolder(folder.join("/"))}>
            {folder.length ? folder.join(" / ") : "Vault"}
          </button>
        </div>
        <button
          type="button"
          aria-label={copied ? "Path copied" : "Copy path"}
          title="Copy the full path"
          className="press grid size-10 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-white/[0.06] hover:text-fg"
          onClick={() => {
            void navigator.clipboard?.writeText(absoluteVaultPath(open.path)).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? <span className="text-caption font-medium text-ok">✓</span> : <CopyIcon size={17} />}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in a new tab"
          title="Open in a new tab"
          className="press grid size-10 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-white/[0.06] hover:text-fg"
        >
          <ExternalLinkIcon size={17} />
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {open.kind === "note" ? (
          <NoteView path={open.path} heading={open.heading} fontPx={fontPx} onFollow={onFollow} />
        ) : open.kind === "image" ? (
          <div className="grid min-h-full place-items-center p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={displayName(name)} className="max-h-[80vh] max-w-full rounded-card object-contain shadow-e3" />
          </div>
        ) : open.kind === "video" ? (
          <div className="p-4">
            <video src={url} controls playsInline preload="metadata" className="w-full rounded-card bg-black shadow-e3" />
          </div>
        ) : open.kind === "audio" ? (
          <div className="p-6">
            <audio src={url} controls className="w-full" />
          </div>
        ) : open.kind === "pdf" ? (
          <PdfView url={url} name={name} />
        ) : open.kind === "text" ? (
          <TextView path={open.path} />
        ) : (
          <FileCard
            name={name}
            url={url}
            note={open.kind === "canvas" ? "Canvas boards are drawn by Obsidian. Open this one there, or download the raw file." : "This file type can't be shown here."}
          />
        )}
      </div>
    </div>
  );
}

function useFileText(path: string) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const ctrl = new AbortController();
    setText(null);
    setError("");
    vaultText(path, ctrl.signal)
      .then(setText)
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : "The vault could not be read");
      });
    return () => ctrl.abort();
  }, [path]);
  return { text, error };
}

function NoteView({ path, heading, fontPx, onFollow }: { path: string; heading?: string; fontPx: number; onFollow: (ref: string) => void }) {
  const { text, error } = useFileText(path);
  const body = useRef<HTMLDivElement>(null);
  // Some vault files were saved with broken encoding; repair that for display only (the file is untouched).
  const parsed = useMemo(() => (text === null ? null : splitFrontmatter(repairMojibake(text))), [text]);
  const markdown = useMemo(() => (parsed ? obsidianToMarkdown(parsed.body, path) : ""), [parsed, path]);

  // Jump to [[note#heading]] once the note has rendered.
  useEffect(() => {
    if (!heading || !markdown) return;
    const t = window.setTimeout(() => {
      const want = heading.trim().toLowerCase();
      const el = [...(body.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") || [])].find((h) => h.textContent?.trim().toLowerCase() === want);
      el?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 120);
    return () => window.clearTimeout(t);
  }, [heading, markdown]);

  if (error) return <p className="m-4 rounded-card border border-danger/30 bg-danger/10 px-4 py-3 text-callout text-danger">{error}</p>;
  if (!parsed) {
    return (
      <div className="space-y-3 p-5" role="status" aria-label="Loading note">
        <div className="h-7 w-2/3 rounded-ctl bg-white/[0.05]" />
        {[92, 100, 84, 96, 70].map((w, i) => (
          <div key={i} className="h-4 rounded bg-white/[0.035]" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  return (
    <motion.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: SPRING.gentle }}
      className="mx-auto max-w-[46rem] px-5 pb-28 pt-4 md:pb-12"
      style={{ ["--chat-fs" as string]: `${fontPx}px`, fontSize: fontPx }}
      onClickCapture={(e) => {
        const a = (e.target as Element | null)?.closest?.("a");
        const link = parseVaultHref(a?.getAttribute("href") ?? null);
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        onFollow(link.ref);
      }}
    >
      {parsed.props.length ? <Properties props={parsed.props} onFollow={onFollow} /> : null}
      <div ref={body}>
        <Streamdown className="chat-md vault-md max-w-none">{markdown}</Streamdown>
      </div>
      <LinkedFrom path={path} onFollow={onFollow} />
    </motion.article>
  );
}

/** Notes that link here ([[…]] and ![[…]]), like Obsidian's backlinks pane. */
function LinkedFrom({ path, onFollow }: { path: string; onFollow: (ref: string) => void }) {
  const [links, setLinks] = useState<{ path: string; name: string }[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    setLinks(null);
    setAll(false);
    vaultBacklinks(path, ctrl.signal)
      .then((data) => setLinks(data.links))
      .catch(() => {
        if (!ctrl.signal.aborted) setLinks([]);
      });
    return () => ctrl.abort();
  }, [path]);
  if (!links?.length) return null;
  return (
    <section aria-label="Linked from" className="mt-10 border-t border-line pt-4">
      <h3 className="mb-2 flex items-center gap-2 text-callout font-medium text-fg-2">
        <LinkIcon size={15} className="text-fg-3" />
        Linked from <span className="font-mono text-code tabular text-fg-3">{links.length}</span>
      </h3>
      <ul className="grid gap-1 sm:grid-cols-2">
        {(all ? links : links.slice(0, LINKS_FOLDED)).map((l) => (
          <li key={l.path}>
            <button
              type="button"
              onClick={() => onFollow(l.path)}
              className="press flex min-h-11 w-full min-w-0 flex-col justify-center rounded-ctl border border-line bg-card px-3 py-1.5 text-left hover:border-line-3"
            >
              <span className="truncate text-callout text-fg">{displayName(l.name)}</span>
              <span className="truncate text-caption text-fg-3">{l.path.split("/").slice(0, -1).join(" / ") || "Vault"}</span>
            </button>
          </li>
        ))}
      </ul>
      {links.length > LINKS_FOLDED ? (
        <button type="button" className="press mt-2 min-h-9 text-caption font-medium text-fg-3 hover:text-fg-2" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${links.length}`}
        </button>
      ) : null}
    </section>
  );
}

const LINKS_FOLDED = 8;
const PROPS_FOLDED = 4;

/** Front matter as a compact card: long lists fold, and [[links]] in values open like any other link. */
function Properties({ props, onFollow }: { props: [string, string | string[]][]; onFollow: (ref: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? props : props.slice(0, PROPS_FOLDED);
  return (
    <div className="mb-5 rounded-card border border-line bg-card px-4 py-3">
      <dl className="grid grid-cols-[minmax(4.5rem,30%)_1fr] gap-x-4 gap-y-2 text-callout">
        {shown.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="truncate pt-px text-fg-3" title={key}>
              {key}
            </dt>
            <dd className="min-w-0 text-fg-2">
              {Array.isArray(value) ? (
                <span className="flex flex-wrap gap-1">
                  {value.map((v) => (
                    <span key={v} className="rounded-chip bg-white/[0.06] px-1.5 py-0.5 text-caption text-fg-2">
                      <PropText text={v} onFollow={onFollow} />
                    </span>
                  ))}
                </span>
              ) : (
                <span className="break-words">
                  <PropText text={value} onFollow={onFollow} />
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {props.length > PROPS_FOLDED ? (
        <button type="button" className="press mt-2 min-h-9 text-caption font-medium text-fg-3 hover:text-fg-2" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${props.length} properties`}
        </button>
      ) : null}
    </div>
  );
}

function PropText({ text, onFollow }: { text: string; onFollow: (ref: string) => void }) {
  const parts = text.split(/(\[\[[^\]]+\]\])/g);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(part);
        if (!m) return <span key={i}>{part}</span>;
        return (
          <button key={i} type="button" className="font-medium text-accent-text underline decoration-accent-text/35 underline-offset-2 hover:decoration-accent-text" onClick={() => onFollow(m[1].trim())}>
            {(m[2] || displayName(m[1].split("/").pop() || m[1])).trim()}
          </button>
        );
      })}
    </>
  );
}

function TextView({ path }: { path: string }) {
  const { text, error } = useFileText(path);
  if (error) return <p className="m-4 text-callout text-danger">{error}</p>;
  if (text === null) return <p className="p-5 text-callout text-fg-3">Loading…</p>;
  return <pre className="m-4 overflow-x-auto rounded-card border border-line bg-canvas p-4 font-mono text-code text-fg-2">{repairMojibake(text)}</pre>;
}

function PdfView({ url, name }: { url: string; name: string }) {
  // Chrome on Android can't show a PDF inside a page: offer the phone's viewer instead.
  const [inline, setInline] = useState(false);
  useEffect(() => {
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    setInline(!coarse && !/Android/i.test(navigator.userAgent));
  }, []);
  if (inline) return <iframe src={url} title={name} className="h-full min-h-[70vh] w-full bg-white" />;
  return <FileCard name={name} url={url} note="PDFs open in your phone's viewer." primary="Open PDF" />;
}

function FileCard({ name, url, note, primary }: { name: string; url: string; note: string; primary?: string }) {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm rounded-card border border-line bg-card p-5 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-white/[0.05] text-fg-2">
          <FileIcon size={22} />
        </span>
        <p className="mt-3 break-words text-body font-medium text-fg">{name}</p>
        <p className="mt-1 text-callout text-fg-3">{note}</p>
        <div className="mt-4 flex justify-center gap-2">
          {primary ? (
            <a href={url} target="_blank" rel="noreferrer" className="press flex min-h-11 items-center gap-2 rounded-full bg-fg px-5 text-callout font-semibold text-canvas">
              <ExternalLinkIcon size={16} /> {primary}
            </a>
          ) : null}
          <a href={`${url}&download=1`} className="press flex min-h-11 items-center gap-2 rounded-full border border-line-2 px-5 text-callout text-fg-2 hover:text-fg">
            <DownloadIcon size={16} /> Download
          </a>
        </div>
      </div>
    </div>
  );
}

function ago(ms: number) {
  if (!ms) return "";
  const d = (Date.now() - ms) / 86_400_000;
  if (d < 1 / 24) return "just now";
  if (d < 1) return `${Math.round(d * 24)}h ago`;
  if (d < 30) return `${Math.round(d)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
