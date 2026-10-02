"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CircleAlertIcon, HistoryIcon, PlusIcon, TriangleAlertIcon, XIcon } from "@/components/icons";
import { memoryOps, memoryUsed, persona, type MemoryRow, type MemoryTarget, type Persona, type Soul, type SoulVersion } from "@/lib/persona-client";
import { field } from "@/components/ui/field";
import { btn } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/surface";

type Tab = "soul" | "memory" | "user";

/**
 * Edit one profile's SOUL (who it is) and its two memories (its own notes, and what it knows about the
 * owner). Saves go through Hermes's own locking and safety scans; a change the agent made meanwhile is
 * shown as a conflict, never overwritten. Hermes reads these at the start of a session.
 */
export function PersonaEditor({ profile, name }: { profile: string; name: string }) {
  const [data, setData] = useState<Persona | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("soul");
  const load = () => {
    setError("");
    persona
      .load(profile)
      .then((d) => (d.ok ? setData(d) : setError(d.error || "Couldn't read this profile.")))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't read this profile."));
  };
  useEffect(load, [profile]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "soul", label: "Identity" },
    { id: "memory", label: `${name}'s notes` },
    { id: "user", label: "About you" },
  ];
  return (
    <div className="space-y-4">
      <div className="flex rounded-full bg-well p-0.5" role="tablist" aria-label="What to edit">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`press min-h-9 flex-1 truncate rounded-full px-3 text-callout font-medium ${tab === t.id ? "bg-fill-3 text-fg" : "text-fg-3 hover:text-fg-2"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="text-caption text-fg-3">{name} reads these at the start of each session, so changes apply from the next one.</p>
      {error ? (
        <Problem text={error} action={<Ghost onClick={load}>Try again</Ghost>} />
      ) : !data ? (
        <Skeleton lines={5} label="Loading the persona" />
      ) : tab === "soul" ? (
        <SoulEditor profile={profile} soul={data.soul} onSaved={(soul) => setData({ ...data, soul })} />
      ) : (
        <MemoryEditor
          key={tab}
          profile={profile}
          target={tab}
          value={tab === "memory" ? data.memory : data.user}
          hint={tab === "memory" ? `What ${name} has learned: facts, conventions, things to remember.` : `What ${name} knows about you: preferences and how you like to work.`}
          onSaved={(next) => setData({ ...data, ...next })}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- SOUL */

function SoulEditor({ profile, soul, onSaved }: { profile: string; soul: Soul; onSaved: (soul: Soul) => void }) {
  const [text, setText] = useState(soul.text);
  const [base, setBase] = useState(soul.hash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<{ text: string; hash: string } | null>(null);
  const [warnings, setWarnings] = useState(soul.warnings);
  const [history, setHistory] = useState<SoulVersion[]>(soul.history);
  const [showHistory, setShowHistory] = useState(false);
  const dirty = text !== soul.text || base !== soul.hash;
  const over = soul.limit && text.length > soul.limit;

  const save = async (againstHash = base) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await persona.saveSoul(profile, text, againstHash);
      if (result.conflict && result.current) {
        setConflict(result.current);
        return;
      }
      if (!result.ok || !result.hash) throw new Error(result.error || "SOUL.md wasn't saved.");
      setConflict(null);
      setBase(result.hash);
      setWarnings(result.warnings || []);
      if (result.history) setHistory(result.history);
      onSaved({ ...soul, text, hash: result.hash, warnings: result.warnings || [], history: result.history || history });
      setNotice(result.unchanged ? "No changes to save." : "Saved. The previous version is in History.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <label className="block text-callout text-fg-2">
        SOUL.md <span className="text-fg-3">— who this bot is: personality, standards, how it works</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          spellCheck
          className={field({ mono: true, extra: "mt-1.5 w-full resize-y py-2 leading-5" })}
        />
      </label>
      <p className={`text-caption tabular ${over ? "text-warn" : "text-fg-3"}`}>
        {text.length.toLocaleString()} characters
        {soul.limit ? ` · Hermes keeps up to ${soul.limit.toLocaleString()} in the prompt${over ? "; the middle of a longer file is trimmed" : ""}` : ""}
      </p>
      {warnings.length ? (
        <div className="flex items-start gap-2 rounded-card border border-warn/40 bg-warn/10 p-3" role="note">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warn" />
          <p className="text-callout text-fg">
            Hermes's safety scan flagged this text ({warnings.join(", ")}). It still loads because it is your own file; check that you meant it.
          </p>
        </div>
      ) : null}
      {conflict ? (
        <div className="space-y-2 rounded-card border border-warn/40 bg-warn/10 p-3" role="alert">
          <p className="text-callout text-fg">SOUL.md changed since you opened it (perhaps the bot edited it). Keep your version, or load theirs?</p>
          <div className="flex flex-wrap gap-2">
            <Primary onClick={() => void save(conflict.hash)} disabled={busy}>
              Keep mine
            </Primary>
            <Ghost
              onClick={() => {
                setText(conflict.text);
                setBase(conflict.hash);
                setConflict(null);
              }}
            >
              Load theirs
            </Ghost>
          </div>
        </div>
      ) : null}
      {error ? <Problem text={error} /> : null}
      {notice ? (
        <p className="text-callout text-fg-2" role="status">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Primary onClick={() => void save()} disabled={busy || !dirty || !text.trim()}>
          {busy ? "Saving…" : "Save"}
        </Primary>
        <Ghost onClick={() => setText(soul.text)} disabled={busy || text === soul.text}>
          Undo changes
        </Ghost>
        <Ghost onClick={() => setShowHistory((v) => !v)}>
          <HistoryIcon className="size-4" /> History ({history.length})
        </Ghost>
      </div>
      {showHistory ? (
        <History
          profile={profile}
          items={history}
          onLoad={(versionText) => {
            setText(versionText);
            setNotice("Loaded into the editor. Save to use it.");
          }}
        />
      ) : null}
    </div>
  );
}

function History({ profile, items, onLoad }: { profile: string; items: SoulVersion[]; onLoad: (text: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  if (!items.length) return <p className="text-callout text-fg-3">No earlier versions yet.</p>;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-card">
      {items.map((v) => (
        <li key={v.id} className="px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-callout text-fg-2">
              {new Date(v.at * 1000).toLocaleString()} <span className="text-fg-3">· {v.kind === "backup" ? "backup file" : "saved"} · {v.size.toLocaleString()} bytes</span>
            </span>
            <button
              type="button"
              className="press min-h-9 rounded-full px-3 text-callout text-fg-2 hover:text-fg"
              onClick={async () => {
                if (open === v.id) {
                  setOpen(null);
                  return;
                }
                setError("");
                try {
                  const r = await persona.version(profile, v.id);
                  setPreview(r.text);
                  setOpen(v.id);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Couldn't read that version.");
                }
              }}
            >
              {open === v.id ? "Hide" : "View"}
            </button>
          </div>
          {open === v.id ? (
            <div className="mt-2 space-y-2">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-ctl bg-canvas p-2 font-mono text-code text-fg-2">{preview}</pre>
              <Ghost onClick={() => onLoad(preview)}>Use this version</Ghost>
            </div>
          ) : null}
        </li>
      ))}
      {error ? <li className="px-3 py-2 text-callout text-danger">{error}</li> : null}
    </ul>
  );
}

/* ---------------------------------------------------------------- memory */

let rowSeq = 0;
const rowsFrom = (entries: string[]): MemoryRow[] => entries.map((e) => ({ key: `r${rowSeq++}`, from: e, text: e }));

function MemoryEditor({
  profile,
  target,
  value,
  hint,
  onSaved,
}: {
  profile: string;
  target: "memory" | "user";
  value: MemoryTarget;
  hint: string;
  onSaved: (next: { memory?: MemoryTarget; user?: MemoryTarget }) => void;
}) {
  const [rows, setRows] = useState<MemoryRow[]>(() => rowsFrom(value.entries));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const newRow = useRef<HTMLTextAreaElement | null>(null);
  const live = rows.filter((r) => !r.deleted).map((r) => r.text);
  const used = memoryUsed(live);
  const ops = useMemo(() => memoryOps(rows), [rows]);
  const over = used > value.limit;

  const update = (key: string, patch: Partial<MemoryRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await persona.editMemory(profile, target, ops);
      const fresh = result[target];
      if (fresh) {
        setRows(rowsFrom(fresh.entries));
        onSaved({ memory: result.memory, user: result.user });
      }
      if (!result.ok) throw new Error(result.error || "Memory wasn't saved.");
      setNotice("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-callout text-fg-3">{hint}</p>
      {!value.enabled ? <p className="text-callout text-warn">This memory is turned off in the profile's settings, so Hermes doesn't read it.</p> : null}
      <Meter used={used} limit={value.limit} />
      <ul className="space-y-2" aria-label="Entries">
        {rows.map((row, i) => (
          <li key={row.key} className={`flex items-start gap-2 ${row.deleted ? "opacity-50" : ""}`}>
            <textarea
              ref={i === rows.length - 1 && row.from === undefined ? newRow : undefined}
              value={row.text}
              disabled={row.deleted}
              aria-label={`Entry ${i + 1}`}
              onChange={(e) => update(row.key, { text: e.target.value })}
              rows={Math.min(6, Math.max(1, Math.ceil(row.text.length / 60)))}
              className={`min-h-11 min-w-0 flex-1 resize-y rounded-ctl border bg-canvas px-3 py-2 text-callout text-fg outline-hidden focus:border-line-3 ${row.deleted ? "border-line line-through" : "border-line-2"}`}
            />
            <button
              type="button"
              aria-label={row.deleted ? `Keep entry ${i + 1}` : `Delete entry ${i + 1}`}
              onClick={() => (row.from === undefined ? setRows((rs) => rs.filter((r) => r.key !== row.key)) : update(row.key, { deleted: !row.deleted }))}
              className="press grid size-11 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg"
            >
              {row.deleted ? <span className="text-caption">Undo</span> : <XIcon className="size-4" />}
            </button>
          </li>
        ))}
      </ul>
      <Ghost
        onClick={() => {
          setRows((rs) => [...rs, { key: `r${rowSeq++}`, text: "" }]);
          window.setTimeout(() => newRow.current?.focus(), 0);
        }}
      >
        <PlusIcon className="size-4" /> Add an entry
      </Ghost>
      {error ? <Problem text={error} /> : null}
      {notice ? (
        <p className="text-callout text-fg-2" role="status">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Primary onClick={() => void save()} disabled={busy || !ops.length || over}>
          {busy ? "Saving…" : ops.length ? `Save ${ops.length} ${ops.length === 1 ? "change" : "changes"}` : "Save"}
        </Primary>
        <Ghost onClick={() => setRows(rowsFrom(value.entries))} disabled={busy || !ops.length}>
          Undo changes
        </Ghost>
      </div>
    </div>
  );
}

function Meter({ used, limit }: { used: number; limit: number }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = used > limit ? "bg-danger" : pct >= 90 ? "bg-warn" : "bg-ok";
  return (
    <div>
      <div className="h-1.5 overflow-hidden rounded-full bg-fill-2" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label="Memory used">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={`mt-1 text-caption tabular ${used > limit ? "text-danger" : "text-fg-3"}`}>
        {used.toLocaleString()} / {limit.toLocaleString()} characters{used > limit ? " — over the limit; shorten or remove something" : ""}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- pieces */

function Problem({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-card border border-danger/30 bg-danger/10 p-3" role="alert">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
      <p className="min-w-0 flex-1 text-callout text-fg">{text}</p>
      {action}
    </div>
  );
}

function Primary({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={btn("primary", "md")}>
      {children}
    </button>
  );
}

function Ghost({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={btn("secondary", "md")}>
      {children}
    </button>
  );
}
