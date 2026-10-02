"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SurfaceTabs, type Surface } from "@/components/surface-tabs";
import { useDashboardPrefs } from "@/lib/dashboard-prefs";
import { useLayer } from "@/lib/overlay-stack";
import { EASE } from "@/lib/motion";
import { showToast } from "@/lib/toast-store";
import { displayName, kindOfName, loadRecents, rememberRecent, takeVaultOpen, useVaultOpenSignal, vaultResolve, vaultSearch, vaultTree, type Recent, type VaultEntry, type VaultHit, type VaultKind } from "@/lib/vault-client";
import { useAppConfig } from "@/lib/app-config";
import { SecondBrainNotSetUp } from "@/components/second-brain/not-set-up";
import { Browser, EmptyReader } from "@/components/vault/browser";
import { Reader } from "@/components/vault/reader";

export type Open = { path: string; kind: VaultKind; heading?: string };

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
