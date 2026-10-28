"use client";

import { friendlyError } from "@/lib/request";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { CheckIcon, ChevronDownIcon, CircleAlertIcon, CircleCheckIcon, SearchIcon, StarIcon, ZapIcon } from "@/components/icons";
import {
  fleetApi,
  type Effort,
  type FavoriteModel,
  type HelpersModel as HelpersModelState,
  type ModelCaps,
  type ModelGroup,
  type ModelsResult,
  type NousPlan,
  type PlanUsage,
  type RateLimit,
} from "@/lib/fleet-client";
import { blocks, featuredFirst, fullest, gaugeName, isLarge, limitLine, resetsIn, sizeWord, spentFor } from "@/lib/plan-usage";
import { whenLabel } from "@/lib/routines-client";
import { field } from "@/components/ui/field";
import { btn } from "@/components/ui/button";

/**
 * A bot's model (the chief's too): every model of a connected provider, favourites first. Changing it pins the bot
 * through Hermes; the provider's key goes with it. Expensive models ask first, as Hermes does. Each provider says how
 * much of its plan is left and when a rate limit lifts (Hermes's usage cache and credential pool); a model that
 * reasons gets a thinking level, kept per model in the bot's own config.
 */
export function ModelPicker({ profile, provider, model, onChanged }: { profile: string; provider: string; model: string; onChanged?: () => void }) {
  const id = useId();
  const [options, setOptions] = useState<ModelsResult | null>(null);
  const [favorites, setFavorites] = useState<FavoriteModel[]>([]);
  const [loadError, setLoadError] = useState("");
  const [current, setCurrent] = useState({ provider, model });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error" | "confirm"; text: string; pending?: { provider: string; model: string } } | null>(null);

  useEffect(() => setCurrent({ provider, model }), [provider, model]);
  useEffect(() => {
    fleetApi
      .models()
      .then((r) => {
        if (!r.ok) return setLoadError(r.error || "Couldn't list models.");
        setOptions(r);
        setFavorites(r.favorites || []);
      })
      .catch((e: unknown) => setLoadError(friendlyError(e, "Couldn't list models.")));
  }, []);

  async function choose(next: { provider: string; model: string }, confirm = false) {
    setSaving(true);
    setNote(null);
    try {
      const res = await fleetApi.setModel(profile, next.provider, next.model, confirm);
      if (res.confirm) {
        setNote({ tone: "confirm", text: res.confirm, pending: next });
        return;
      }
      if (!res.ok) {
        setNote({ tone: "error", text: res.error || "That model couldn't be set." });
        return;
      }
      setCurrent(next);
      setOpen(false);
      // As Hermes does on a plan with usage windows: a note, never a question.
      const plan = options?.groups.find((g) => g.provider === next.provider)?.plan;
      const large = plan && isLarge(plan, next.model) ? " A Large model uses more of your plan with each message." : "";
      setNote({ tone: "ok", text: `Saved. It answers with this model from the next message.${large}` });
      onChanged?.();
    } catch (e) {
      setNote({ tone: "error", text: friendlyError(e, "That model couldn't be set.") });
    } finally {
      setSaving(false);
    }
  }

  async function star(fav: FavoriteModel, on: boolean) {
    const before = favorites;
    setFavorites(on ? [fav, ...before.filter((f) => !same(f, fav))] : before.filter((f) => !same(f, fav)));
    try {
      const res = await fleetApi.favorite(fav.provider, fav.model, on);
      if (!res.ok) throw new Error(res.error || "Couldn't save that favourite.");
      if (res.favorites) setFavorites(res.favorites);
    } catch (e) {
      setFavorites(before);
      setNote({ tone: "error", text: friendlyError(e, "Couldn't save that favourite.") });
    }
  }

  const groups = useMemo(() => options?.groups || [], [options]);
  const group = groups.find((g) => g.provider === current.provider);
  const caps = group?.caps?.[current.model];
  const known = !!group?.models.includes(current.model);
  const q = query.trim().toLowerCase();
  const matches = (g: ModelGroup, m: string) => !q || m.toLowerCase().includes(q) || g.name.toLowerCase().includes(q);
  const starred = favorites
    .map((f) => ({ fav: f, group: groups.find((g) => g.provider === f.provider) }))
    .filter((x): x is { fav: FavoriteModel; group: ModelGroup } => !!x.group && x.group.models.includes(x.fav.model) && matches(x.group, x.fav.model));
  const isStarred = (p: string, m: string) => favorites.some((f) => f.provider === p && f.model === m);

  return (
    <div className="space-y-2">
      <p id={`${id}-label`} className="text-callout text-fg-2">
        Model
      </p>
      <button
        type="button"
        aria-labelledby={`${id}-label`}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        disabled={!options || saving}
        onClick={() => setOpen((v) => !v)}
        className={field({ extra: "press flex w-full items-center gap-2 text-left disabled:opacity-60" })}
      >
        <span className="min-w-0 flex-1 truncate">
          {current.model || "Not set"}
          <span className="text-fg-3">{group ? ` · ${group.name}` : current.provider && !known ? ` · ${current.provider}` : ""}</span>
        </span>
        {group?.plan ? <PlanChip plan={group.plan} model={current.model} quiet /> : group ? <UsageChip usage={group.usage} limit={group.limit} model={current.model} quiet /> : null}
        <ChevronDownIcon className={`size-4 shrink-0 text-fg-3 transition-transform duration-fast ${open ? "rotate-180" : ""}`} />
      </button>
      {/* On a Nous plan with usage windows: how much of each allowance is used, here as in Hermes's own pickers. */}
      {group?.plan && !open ? (
        <div className="-mx-3">
          <PlanGauges plan={group.plan} />
        </div>
      ) : null}

      {open ? (
        <div id={`${id}-list`} className="overflow-hidden rounded-card border border-line bg-card">
          <label className="relative block border-b border-line p-2">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-4.5 size-4 -translate-y-1/2 text-fg-3" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a model" aria-label="Find a model" className={field({ extra: "w-full pl-9" })} />
          </label>
          <div className="max-h-80 overflow-y-auto">
            {starred.length ? (
              <Section title="Favourites">
                {starred.map(({ fav, group: g }) => (
                  <ModelRow
                    key={`fav:${fav.provider}:${fav.model}`}
                    model={fav.model}
                    providerName={g.name}
                    caps={g.caps?.[fav.model]}
                    limit={g.limit}
                    plan={g.plan}
                    selected={same(fav, current)}
                    starred
                    onPick={() => void choose(fav)}
                    onStar={(on) => void star(fav, on)}
                  />
                ))}
              </Section>
            ) : null}
            {groups.map((g) => {
              // A plan's own picks come first, as Hermes lists them.
              const shown = featuredFirst(g.plan, g.models).filter((m) => matches(g, m));
              if (!shown.length) return null;
              return (
                <Section key={g.provider} title={g.name} aside={g.plan ? <PlanChip plan={g.plan} /> : <UsageChip usage={g.usage} limit={g.limit} />}>
                  {g.plan && !q ? <PlanGauges plan={g.plan} /> : null}
                  {shown.map((m) => (
                    <ModelRow
                      key={`${g.provider}:${m}`}
                      model={m}
                      caps={g.caps?.[m]}
                      limit={g.limit}
                      plan={g.plan}
                      selected={g.provider === current.provider && m === current.model}
                      starred={isStarred(g.provider, m)}
                      onPick={() => void choose({ provider: g.provider, model: m })}
                      onStar={(on) => void star({ provider: g.provider, model: m }, on)}
                    />
                  ))}
                </Section>
              );
            })}
            {q && !starred.length && !groups.some((g) => g.models.some((m) => matches(g, m))) ? <p className="px-3 py-4 text-callout text-fg-3">No model matches “{query}”.</p> : null}
          </div>
        </div>
      ) : null}

      {loadError ? <Line tone="error">{loadError}</Line> : null}
      {options && !groups.length ? <Line tone="error">No provider is connected. Add one in Settings, then Models &amp; keys.</Line> : null}
      {note?.tone === "confirm" && note.pending ? (
        <div className="space-y-2 rounded-card border border-warn/30 bg-warn/6 px-3 py-2">
          <Line tone="warn">{note.text}</Line>
          <div className="flex gap-2">
            <button type="button" disabled={saving} onClick={() => void choose(note.pending!, true)} className={btn("primary", "md")}>
              Use it anyway
            </button>
            <button type="button" onClick={() => setNote(null)} className="press min-h-10 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg">
              Cancel
            </button>
          </div>
        </div>
      ) : note ? (
        <Line tone={note.tone === "ok" ? "ok" : "error"}>{note.text}</Line>
      ) : null}

      {current.model && (caps ? caps.reasoning : true) ? <ThinkingLevel profile={profile} model={current.model} canDisable={!!caps?.canDisable} /> : null}
      {groups.length ? <HelpersModel profile={profile} groups={groups} /> : null}
    </div>
  );
}

/** "today 15:00", "tomorrow 09:00", "Wed 11:59": a time inside a sentence. */
const when = (iso: string) => whenLabel(iso).replace(/^(Today|Tomorrow|Yesterday)\b/, (w) => w.toLowerCase());

const same = (a: FavoriteModel, b: FavoriteModel) => a.provider === b.provider && a.model === b.model;

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={title} className="border-b border-line last:border-b-0">
      <div className="sticky top-0 z-[1] flex items-center gap-2 bg-card px-3 pt-2.5 pb-1">
        <p className="min-w-0 flex-1 truncate text-caption font-medium text-fg-3">{title}</p>
        {aside}
      </div>
      {children}
    </div>
  );
}

function ModelRow({
  model,
  providerName,
  caps,
  limit,
  plan,
  selected,
  starred,
  onPick,
  onStar,
}: {
  model: string;
  providerName?: string;
  caps?: ModelCaps;
  limit?: RateLimit | null;
  plan?: NousPlan | null;
  selected: boolean;
  starred: boolean;
  onPick: () => void;
  onStar: (on: boolean) => void;
}) {
  // An account-wide limit is said once, on the provider's heading.
  const limited = limit?.scope === "models" ? limit.models[model] : "";
  // On a plan with usage windows: "Free" or "Large", and dimmed while a full allowance stops it (the line above says why).
  const size = plan ? sizeWord(plan, model) : "";
  const stopped = !!plan && blocks(plan, model);
  const spent = stopped && plan ? spentFor(plan, model) : null;
  return (
    <div className={`flex items-center gap-1 pr-1.5 ${stopped ? "opacity-60" : ""}`}>
      <button type="button" onClick={onPick} aria-current={selected ? "true" : undefined} className="press flex min-h-11 min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left hover:bg-fill-1">
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-callout ${selected ? "font-medium text-fg" : "text-fg-2"}`}>{model}</span>
          {providerName || limited || spent ? (
            <span className="block truncate text-caption text-fg-3">
              {[providerName, limited ? `rate limited until ${when(limited)}` : "", spent ? `stopped until the limit resets${spent.resetsAt ? ` (${resetsIn(spent.resetsAt)})` : ""}` : ""]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : null}
        </span>
        {size ? <span className="shrink-0 rounded-chip bg-fill-2 px-1.5 py-px text-micro text-fg-3">{size}</span> : null}
        {caps?.fast ? (
          <span title="Has a fast mode" className="shrink-0 text-fg-3">
            <ZapIcon className="size-3.5" />
            <span className="sr-only">fast mode</span>
          </span>
        ) : null}
        {caps?.reasoning ? <span className="shrink-0 rounded-chip bg-fill-2 px-1.5 py-px text-micro text-fg-3">thinks</span> : null}
        {selected ? <CheckIcon className="size-4 shrink-0 text-ok" strokeWidth={2.5} /> : null}
      </button>
      <button
        type="button"
        aria-pressed={starred}
        aria-label={starred ? `Unstar ${model}` : `Star ${model}`}
        title={starred ? "Remove from favourites" : "Add to favourites"}
        onClick={() => onStar(!starred)}
        className={`press grid size-9 shrink-0 place-items-center rounded-full hover:bg-fill-2 ${starred ? "text-warn" : "text-fg-4 hover:text-fg-2"}`}
      >
        <StarIcon className={`size-4 ${starred ? "fill-current" : ""}`} />
      </button>
    </div>
  );
}

/**
 * A Nous plan with usage windows, in one chip: "Plan paused", a full allowance that stops this model, or how much of
 * the fullest allowance is used. Quiet: only when it matters (80% used or more, or a model it stops).
 */
export function PlanChip({ plan, model, quiet }: { plan: NousPlan; model?: string; quiet?: boolean }) {
  const warn = "shrink-0 rounded-chip bg-warn/15 px-1.5 py-px text-micro text-warn";
  if (plan.paused) return <span className={warn}>plan paused</span>;
  const spent = model ? spentFor(plan, model) : null;
  if (spent && model && blocks(plan, model)) {
    return <span className={warn}>limit reached{spent.resetsAt ? ` · resets ${resetsIn(spent.resetsAt)}` : ""}</span>;
  }
  const g = fullest(plan);
  if (!g || (quiet && g.used < 80)) return null;
  return <span className={`shrink-0 rounded-chip px-1.5 py-px text-micro ${g.used >= 90 ? "bg-warn/15 text-warn" : "bg-fill-2 text-fg-3"}`}>{`${gaugeName(g)} ${g.used}% used`}</span>;
}

/** Every allowance of a Nous plan as a bar (used, like the Portal's "N% used"), what a full one means, and a pause. */
export function PlanGauges({ plan }: { plan: NousPlan }) {
  const line = limitLine(plan);
  return (
    <div className="space-y-1.5 px-3 pt-1 pb-2">
      {plan.gauges.map((g) => (
        <div key={`${g.label}:${g.scope}`} className="flex items-center gap-2 text-caption">
          <span className="w-24 shrink-0 truncate text-fg-3">{gaugeName(g)}</span>
          <span
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-fill-2"
            role="meter"
            aria-label={`${gaugeName(g)}: ${g.used}% used`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={g.used}
          >
            <span className={`block h-full rounded-full ${g.full ? "bg-danger" : g.used >= 80 ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.max(2, g.used)}%` }} />
          </span>
          <span className={`w-24 shrink-0 text-right tabular-nums ${g.full ? "text-danger" : "text-fg-3"}`}>
            {g.used}%{g.resetsAt ? ` · ${resetsIn(g.resetsAt)}` : ""}
          </span>
        </div>
      ))}
      {plan.paused ? <p className="text-caption text-warn">Plan paused: {plan.paused}</p> : null}
      {line ? <p className="text-caption text-warn">{line}</p> : null}
    </div>
  );
}

/** "17% left · resets today 15:00" (amber under 10%), or "Rate limited until …". Quiet: only when it matters (under 20%, or limited). */
export function UsageChip({ usage, limit, model, quiet }: { usage?: PlanUsage | null; limit?: RateLimit | null; model?: string; quiet?: boolean }) {
  const until = limit?.scope === "account" ? limit.until : limit?.scope === "models" && model ? limit.models[model] : "";
  if (until) return <span className="shrink-0 rounded-chip bg-warn/15 px-1.5 py-px text-micro text-warn">rate limited until {when(until)}</span>;
  if (!usage || (quiet && usage.left >= 20)) return null;
  const low = usage.left < 10;
  const resets = usage.resetsAt ? ` · resets ${when(usage.resetsAt)}` : "";
  return (
    <span title={usage.window ? `The ${usage.window} window` : undefined} className={`shrink-0 rounded-chip px-1.5 py-px text-micro ${low ? "bg-warn/15 text-warn" : "bg-fill-2 text-fg-3"}`}>
      {usage.left}% left{resets}
    </span>
  );
}

const LEVEL_NAME: Record<string, string> = { none: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** How hard the current model thinks, kept for that model in the bot's config (Hermes reads it on every turn). */
function ThinkingLevel({ profile, model, canDisable }: { profile: string; model: string; canDisable: boolean }) {
  const id = useId();
  const [state, setState] = useState<Effort | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fleetApi
      .effort(profile)
      .then((r) => (r.ok ? setState(r) : setError(r.error || "")))
      .catch(() => undefined);
  }, [profile]);
  useEffect(load, [load, model]);

  if (!state || state.model !== model) return null;
  const levels = state.levels.filter((l) => l !== "none" || canDisable);
  const fallback = state.general ? `${LEVEL_NAME[state.general] || state.general}, the bot's general level` : "the provider's default";

  async function save(next: string) {
    setSaving(true);
    setError("");
    try {
      const res = await fleetApi.setEffort(profile, next);
      if (!res.ok) throw new Error(res.error || "That didn't save.");
      setState(res);
    } catch (e) {
      setError(friendlyError(e, "That didn't save."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1 pt-1">
      <label htmlFor={id} className="block text-callout text-fg-2">
        Thinking
      </label>
      <select id={id} value={state.effort} disabled={saving} onChange={(e) => void save(e.target.value)} className={field({ extra: "w-full disabled:opacity-60" })}>
        <option value="">Default ({fallback})</option>
        {levels.map((l) => (
          <option key={l} value={l}>
            {LEVEL_NAME[l] || l}
          </option>
        ))}
      </select>
      <p className="text-caption text-fg-3">More thinking answers hard questions better, more slowly and at a higher cost. Kept for {model}.</p>
      {error ? <Line tone="error">{error}</Line> : null}
    </div>
  );
}

/**
 * The model the bot's background helpers run on (the tasks it hands off: Hermes's `delegation.provider` and
 * `delegation.model`). By default they use the bot's own model; a cheaper or faster one keeps big jobs affordable.
 */
function HelpersModel({ profile, groups }: { profile: string; groups: ModelGroup[] }) {
  const id = useId();
  const [state, setState] = useState<HelpersModelState | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fleetApi
      .helpers(profile)
      .then((r) => live && (r.ok ? setState(r) : setError(r.error || "")))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [profile]);

  if (!state) return null;
  const value = state.model ? `${state.provider}\u0000${state.model}` : "";
  // A pin to a model that's no longer offered stays listed, so the select says what it is.
  const offered = groups.some((g) => g.provider === state.provider && g.models.includes(state.model));

  async function save(next: string) {
    const [provider = "", model = ""] = next ? next.split("\u0000") : [];
    setSaving(true);
    setError("");
    try {
      const res = await fleetApi.setHelpers(profile, provider, model);
      if (!res.ok) throw new Error(res.error || "That didn't save.");
      setState(res);
    } catch (e) {
      setError(friendlyError(e, "That didn't save."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1 pt-1">
      <label htmlFor={id} className="block text-callout text-fg-2">
        Helpers use
      </label>
      <select id={id} value={value} disabled={saving} onChange={(e) => void save(e.target.value)} className={field({ extra: "w-full disabled:opacity-60" })}>
        <option value="">The same model</option>
        {value && !offered ? <option value={value}>{state.model} (no longer offered)</option> : null}
        {groups.map((g) => (
          <optgroup key={g.provider} label={g.name}>
            {g.models.map((m) => (
              <option key={m} value={`${g.provider}\u0000${m}`}>
                {m}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <p className="text-caption text-fg-3">For the tasks it hands off to helpers. A faster or cheaper model keeps big jobs quick and affordable.</p>
      {error ? <Line tone="error">{error}</Line> : null}
    </div>
  );
}

function Line({ tone, children }: { tone: "ok" | "error" | "warn"; children: React.ReactNode }) {
  const Icon = tone === "ok" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 text-callout ${tone === "error" ? "text-danger" : "text-fg-2"}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : ""}`} />
      <span>{children}</span>
    </p>
  );
}
