"use client";

import { type ReactNode } from "react";
import { BookOpenIcon, ChevronRightIcon, FileCodeIcon, FileIcon, FileImageIcon, FileTextIcon, FileVideoCameraIcon, FolderIcon, HistoryIcon, HouseIcon, MusicIcon, SearchIcon, XIcon } from "@/components/icons";
import { displayName, kindOfName, type Recent, type VaultEntry, type VaultHit, type VaultKind } from "@/lib/vault-client";
import { useAssistantName } from "@/lib/identity";
import { btn } from "@/components/ui/button";
import { ago, bytes } from "@/components/vault/format";

/* The Vault's folder browser, breadcrumbs, search results and the reader's empty state. */

export function Browser({
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
            className="min-w-0 flex-1 bg-transparent text-fg outline-hidden placeholder:text-fg-3"
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
                <h3 className="px-2.5 pb-1 pt-2 text-caption font-medium text-fg-3">Recent</h3>
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
                <h3 className="px-2.5 pb-1 pt-3 text-caption font-medium text-fg-3">Folders</h3>
              </section>
            ) : null}
            {error ? <p className="mx-2 mt-2 rounded-card border border-danger/30 bg-danger/10 px-3 py-2.5 text-callout text-danger">{error}</p> : null}
            {entries === null ? (
              <div className="space-y-1.5 px-1 pt-1" role="status" aria-label="Loading the vault">
                {Array.from({ length: 7 }, (_, i) => (
                  <div key={i} className="h-12 rounded-ctl bg-fill-1" style={{ opacity: 1 - i * 0.11 }} />
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

export function Crumb({ label, icon, active, onClick }: { label: string; icon?: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "location" : undefined}
      className={`press flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-2 ${active ? "font-medium text-fg" : "text-fg-3 hover:text-fg-2"}`}
    >
      {icon}
      <span className="max-w-48 truncate">{label}</span>
    </button>
  );
}

export function Row({
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
        active ? "bg-fill-2" : "hover:bg-fill-1"
      }`}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-ctl bg-fill-1">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-body ${active ? "font-medium text-fg" : "text-fg"}`}>{title}</span>
        {meta ? <span className="block truncate text-caption text-fg-3">{meta}</span> : null}
      </span>
      {chevron ? <ChevronRightIcon size={16} className="shrink-0 text-fg-4 transition-transform duration-fast group-hover:translate-x-0.5" /> : null}
    </button>
  );
}

export function SearchResults({
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
            className={`press flex w-full items-start gap-3 rounded-ctl px-2.5 py-2 text-left ${h.path === openPath ? "bg-fill-2" : "hover:bg-fill-1"}`}
          >
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-ctl bg-fill-1">
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

export function Highlight({ text, terms }: { text: string; terms: string[] }) {
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

export function KindIcon({ kind }: { kind: VaultKind }) {
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

export function EmptyReader({ home, recents, onOpen }: { home: string; recents: Recent[]; onOpen: (path: string) => void }) {
  const assistant = useAssistantName();
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-sm text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-fill-2 text-fg-2">
          <BookOpenIcon size={26} />
        </span>
        <h2 className="mt-4 text-title text-fg">Your Second Brain</h2>
        <p className="mt-1.5 text-callout text-fg-3">Pick a note on the left, search for anything, or tap a file {assistant} links in chat.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" className={btn("primary", "md")} onClick={() => onOpen(home)}>
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
