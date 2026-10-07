"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { LinkIcon, ChevronLeftIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, FileIcon } from "@/components/icons";
import { SPRING } from "@/lib/motion";
import { absoluteVaultPath, displayName, obsidianToMarkdown, parseVaultHref, repairMojibake, splitFrontmatter, vaultBacklinks, vaultFileUrl, vaultText } from "@/lib/vault-client";
import { btn } from "@/components/ui/button";
import { Open } from "@/components/vault-pane";
import { Skeleton } from "@/components/ui/surface";

/* The Vault's reader: notes with properties and backlinks, plain text, PDFs and other files. */

export function Reader({
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
          <button type="button" aria-label="Back" className="press grid size-11 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-fill-2 hover:text-fg" onClick={onBack}>
            <ChevronLeftIcon size={20} />
          </button>
        ) : (
          <span className="w-2" />
        )}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate text-headline text-fg">{displayName(name)}</h2>
          <button type="button" className="press block max-w-full truncate text-left text-caption text-fg-3 hover:text-fg-2" onClick={() => onFolder(folder.join("/"))}>
            {folder.length ? folder.join(" / ") : "Vault"}
          </button>
        </div>
        <button
          type="button"
          aria-label={copied ? "Path copied" : "Copy path"}
          title="Copy the full path"
          className="press grid size-10 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg"
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
          className="press grid size-10 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg"
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

export function useFileText(path: string) {
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

export function NoteView({ path, heading, fontPx, onFollow }: { path: string; heading?: string; fontPx: number; onFollow: (ref: string) => void }) {
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
        <div className="h-7 w-2/3 rounded-ctl bg-fill-2" />
        {[92, 100, 84, 96, 70].map((w, i) => (
          <div key={i} className="h-4 rounded-sm bg-fill-1" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  return (
    <motion.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: SPRING.gentle }}
      className="mx-auto max-w-184 px-5 pb-28 pt-4 md:pb-12"
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
export function LinkedFrom({ path, onFollow }: { path: string; onFollow: (ref: string) => void }) {
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

export const LINKS_FOLDED = 8;

export const PROPS_FOLDED = 4;

/** Front matter as a compact card: long lists fold, and [[links]] in values open like any other link. */
export function Properties({ props, onFollow }: { props: [string, string | string[]][]; onFollow: (ref: string) => void }) {
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
                    <span key={v} className="rounded-chip bg-fill-2 px-1.5 py-0.5 text-caption text-fg-2">
                      <PropText text={v} onFollow={onFollow} />
                    </span>
                  ))}
                </span>
              ) : (
                <span className="wrap-break-word">
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

export function PropText({ text, onFollow }: { text: string; onFollow: (ref: string) => void }) {
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

export function TextView({ path }: { path: string }) {
  const { text, error } = useFileText(path);
  if (error) return <p className="m-4 text-callout text-danger">{error}</p>;
  if (text === null) return <Skeleton lines={8} className="m-5" label="Opening the file" />;
  return <pre className="m-4 overflow-x-auto rounded-card border border-line bg-canvas p-4 font-mono text-code text-fg-2">{repairMojibake(text)}</pre>;
}

export function PdfView({ url, name }: { url: string; name: string }) {
  // Chrome on Android can't show a PDF inside a page: offer the phone's viewer instead.
  const [inline, setInline] = useState(false);
  useEffect(() => {
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    setInline(!coarse && !/Android/i.test(navigator.userAgent));
  }, []);
  if (inline) return <iframe src={url} title={name} className="h-full min-h-[70vh] w-full bg-white" />;
  return <FileCard name={name} url={url} note="PDFs open in your phone's viewer." primary="Open PDF" />;
}

export function FileCard({ name, url, note, primary }: { name: string; url: string; note: string; primary?: string }) {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm rounded-card border border-line bg-card p-5 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-fill-2 text-fg-2">
          <FileIcon size={22} />
        </span>
        <p className="mt-3 wrap-break-word text-body font-medium text-fg">{name}</p>
        <p className="mt-1 text-callout text-fg-3">{note}</p>
        <div className="mt-4 flex justify-center gap-2">
          {primary ? (
            <a href={url} target="_blank" rel="noreferrer" className={btn("primary", "md", "flex items-center gap-2")}>
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
