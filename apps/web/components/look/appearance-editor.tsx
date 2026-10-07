"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { BotFace, bubbleParts, faceProps, usableLook, type FaceMood } from "@/components/bot-face";
import { PetSprite } from "@/components/look/pet-sprite";
import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/settings/shared";
import { Segmented } from "@/components/ui/controls";
import { field } from "@/components/ui/field";
import { BOT_PALETTE, botIdentity } from "@/lib/bot-identity";
import { BUBBLE_BODIES, BUBBLE_EYES } from "@/lib/bubble";
import { glowColor } from "@/lib/color";
import { hexColor } from "@/lib/face-snapshot";
import { BLOB_KINDS } from "@/lib/faces";
import { LookConflict, looks, MAX_PHOTO_BYTES, type LookState, type PetChoice } from "@/lib/look-client";
import { showToast } from "@/lib/toast-store";
import type { FaceLook, Person } from "@/lib/types";

const SHAPES = ["circle", "squircle", "pill", "triangle", "hexagon", "cloud", "drop"] as const;
const STYLES: [FaceLook["style"], string][] = [
  ["bubble", "Bubble"],
  ["blob", "Blob"],
  ["shape", "Shape"],
  ["photo", "Photo"],
];
const MOODS: [FaceMood, string][] = [
  ["idle", "Idle"],
  ["thinking", "Thinking"],
  ["working", "Working"],
  ["speaking", "Speaking"],
  ["celebrating", "Celebrating"],
  ["asleep", "Asleep"],
];
const NAMES: Record<string, string> = {
  bean: "Bean",
  round: "Round",
  drop: "Drop",
  pebble: "Pebble",
  cloud: "Cloud",
  tall: "Tall",
  dot: "Dots",
  oval: "Ovals",
  diamond: "Diamonds",
  happy: "Happy",
  sleepy: "Sleepy",
};
const title = (s: string) => NAMES[s] || s.charAt(0).toUpperCase() + s.slice(1);

/** The look a bot starts the editor with: its saved one, or a bubble in its current colour. */
export function startingLook(person: Person, saved: FaceLook | null): FaceLook {
  const usable = usableLook(saved);
  if (usable) return { ...usable };
  const identity = botIdentity({ id: person.id, name: person.name, color: person.color, shape: person.shape, custom: person.custom, isChief: person.isChief });
  const color = hexColor(identity.color) || BOT_PALETTE[0];
  return { style: "bubble", color, ...bubbleParts({ style: "bubble" }, identity.seed), cheeks: false };
}

/**
 * Settings for one bot's face (docs/PLAN-2026-10-07 §2.4): a live preview that can show each mood, the style (Bubble,
 * Hermes's blob faces, the classic shapes, a photo), its options and colour, and a companion pet. Saving writes the
 * bot's Hermes profile (looks.py), so the face is the same on every device and in Hermes's own apps.
 */
export function AppearanceEditor({ person, onDone }: { person: Person; onDone: (look: FaceLook | null) => void }) {
  const profile = person.isChief ? "chief" : person.id;
  const [state, setState] = useState<LookState | null>(null);
  const [draft, setDraft] = useState<FaceLook | null>(null);
  const [mood, setMood] = useState<FaceMood>("idle");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [loadError, setLoadError] = useState("");

  const load = async () => {
    try {
      const s = await looks.load(profile);
      setState(s);
      setDraft(startingLook(person, s.look));
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't read this bot's look.");
    }
  };
  useEffect(() => {
    void load();
    // Read once per bot; saving and conflicts reload explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  if (loadError) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-callout text-danger">
          {loadError}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!state || !draft) return <p className="text-callout text-fg-3">Reading…</p>;

  const set = (patch: Partial<FaceLook>) => {
    setNote("");
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const save = async (face: FaceLook | null) => {
    setSaving(true);
    setNote("");
    try {
      const saved = await looks.save(profile, face, state.revisions);
      setState(saved);
      showToast({ title: face ? "Look saved" : "Back to the default face", tone: "ok", icon: "check" });
      onDone(saved.look);
    } catch (e) {
      if (e instanceof LookConflict) {
        setNote("This look was changed somewhere else in the meantime (maybe by the chief). Showing the latest; make your change again.");
        await load();
      } else setNote(e instanceof Error ? e.message : "Couldn't save the look.");
    } finally {
      setSaving(false);
    }
  };

  const previewPerson: Person = { ...person, look: draft, avatarUrl: draft.style === "photo" ? person.avatarUrl : null };
  const lifted = draft.color ? glowColor(draft.color) : "";
  // A colour picked outside the palette shows in the "any colour" well, which then carries the selection ring.
  const customColour = !!draft.color && !(BOT_PALETTE as readonly string[]).includes(draft.color.toLowerCase());
  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-3 rounded-card border border-line bg-card px-4 pb-4 pt-6">
        <div className="flex items-end gap-5">
          <BotFace {...faceProps(previewPerson)} size={120} mood={mood} />
          <div className="mb-2 flex flex-col items-center gap-2">
            <BotFace {...faceProps(previewPerson)} size={40} mood={mood} />
            {state.pet ? <PetSprite pet={state.pet} size={36} /> : null}
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-1" role="group" aria-label="Preview a mood">
          {MOODS.map(([key, label]) => (
            <Chip key={key} pressed={mood === key} onClick={() => setMood(key)}>
              {label}
            </Chip>
          ))}
        </div>
      </div>

      <Segmented label="Face style" value={draft.style} options={STYLES} onChange={(style) => set({ style })} />

      {draft.style === "bubble" ? (
        <>
          <Section label="Body">
            <Grid>
              {BUBBLE_BODIES.map((body) => (
                <Option key={body} label={title(body)} pressed={(draft.body || "") === body} onClick={() => set({ body })}>
                  <BotFace {...faceProps({ ...previewPerson, look: { ...draft, body } })} size={44} still />
                </Option>
              ))}
            </Grid>
          </Section>
          <Section label="Eyes">
            <Grid>
              {BUBBLE_EYES.map((eyes) => (
                <Option key={eyes} label={title(eyes)} pressed={(draft.eyes || "dot") === eyes} onClick={() => set({ eyes })}>
                  <BotFace {...faceProps({ ...previewPerson, look: { ...draft, eyes } })} size={44} still />
                </Option>
              ))}
            </Grid>
          </Section>
          <div className="-mx-3.5">
            <SwitchRow label="Rosy cheeks" checked={!!draft.cheeks} onChange={(cheeks) => set({ cheeks })} />
          </div>
        </>
      ) : null}

      {draft.style === "blob" ? (
        <Section
          label="Silhouette"
          action={
            <Button variant="ghost" size="sm" onClick={() => set({ seed: Math.random().toString(36).slice(2, 10) })}>
              New face
            </Button>
          }
        >
          <Grid>
            {BLOB_KINDS.map((blobKind) => (
              <Option key={blobKind} label={title(blobKind)} pressed={draft.blobKind === blobKind} onClick={() => set({ blobKind })}>
                <BotFace {...faceProps({ ...previewPerson, look: { ...draft, blobKind } })} size={44} still />
              </Option>
            ))}
          </Grid>
        </Section>
      ) : null}

      {draft.style === "shape" ? (
        <Section label="Shape">
          <Grid>
            {SHAPES.map((shape) => (
              <Option key={shape} label={title(shape)} pressed={(draft.shape || "") === shape} onClick={() => set({ shape })}>
                <BotFace {...faceProps({ ...previewPerson, look: { ...draft, shape } })} size={44} still />
              </Option>
            ))}
          </Grid>
        </Section>
      ) : null}

      {draft.style !== "photo" ? (
        <Section label="Colour">
          <div className="flex flex-wrap items-center gap-2">
            {BOT_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                aria-pressed={draft.color?.toLowerCase() === c}
                onClick={() => set({ color: c })}
                className={`press size-9 rounded-full ring-offset-2 ring-offset-card transition-shadow duration-fast ${draft.color?.toLowerCase() === c ? "ring-2 ring-fg" : ""}`}
                style={{ background: c }}
              />
            ))}
            <label
              className={`press relative grid size-9 cursor-pointer place-items-center overflow-hidden rounded-full text-caption text-fg-3 ring-offset-2 ring-offset-card ${
                customColour ? "ring-2 ring-fg" : "border border-line-2"
              }`}
              style={customColour ? { background: draft.color } : undefined}
              title="Any colour"
            >
              {customColour ? null : <span aria-hidden>+</span>}
              <input
                type="color"
                aria-label="Any colour"
                value={/^#[0-9a-f]{6}$/i.test(draft.color || "") ? draft.color : "#00c9bf"}
                onChange={(e) => set({ color: e.target.value })}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
          </div>
          {draft.color && lifted !== draft.color.toLowerCase() ? (
            <p className="mt-1.5 text-caption text-fg-3">That colour is too dark to see on the dark background, so it&apos;s shown a little lighter.</p>
          ) : null}
        </Section>
      ) : (
        <PhotoSection profile={profile} state={state} onChanged={(s) => (setState(s), set({ style: "photo" }))} />
      )}

      {state.pets ? <PetSection profile={profile} state={state} onChanged={setState} /> : null}

      {note ? (
        <p role="alert" className="text-callout text-warn">
          {note}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button disabled={saving || (draft.style === "photo" && !state.hasAvatar)} onClick={() => void save(draft)}>
          {saving ? "Saving…" : "Save look"}
        </Button>
        <Button variant="secondary" disabled={saving} onClick={() => onDone(state.look)}>
          Cancel
        </Button>
        {state.look ? (
          <Button variant="ghost" disabled={saving} onClick={() => void save(null)}>
            Reset to default
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function PhotoSection({ profile, state, onChanged }: { profile: string; state: LookState; onChanged: (s: LookState) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"" | "upload" | "portrait">("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const run = async (kind: "upload" | "portrait", fn: () => Promise<LookState>) => {
    setBusy(kind);
    setError("");
    try {
      onChanged(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy("");
    }
  };
  return (
    <Section label="Photo">
      <p className="text-caption text-fg-3">{state.hasAvatar ? "A photo is saved for this bot." : "Upload a picture (PNG, JPEG or WebP, up to 2 MB)."}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => file.current?.click()}>
          {busy === "upload" ? "Uploading…" : state.hasAvatar ? "Replace photo" : "Upload photo"}
        </Button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (!picked) return;
            if (picked.size > MAX_PHOTO_BYTES) return setError("That picture is over 2 MB; pick a smaller one.");
            void run("upload", () => looks.uploadPhoto(profile, picked));
          }}
        />
      </div>
      {state.portrait ? (
        <div className="mt-3 space-y-2">
          <label htmlFor="portrait-prompt" className="text-caption text-fg-3">
            Or have one drawn (uses your image generator)
          </label>
          <div className="flex gap-2">
            <input
              id="portrait-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A cheerful teal robot with round glasses"
              className={field({ extra: "min-w-0 flex-1 py-2" })}
            />
            <Button size="sm" disabled={!!busy} onClick={() => void run("portrait", () => looks.portrait(profile, prompt.trim()))}>
              {busy === "portrait" ? "Drawing…" : "Draw"}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-caption text-danger">
          {error}
        </p>
      ) : null}
    </Section>
  );
}

/** How many pets the picker shows at once; the gallery has thousands, so search narrows it. */
const PETS_SHOWN = 48;

function PetSection({ profile, state, onChanged }: { profile: string; state: LookState; onChanged: (s: LookState) => void }) {
  const [catalog, setCatalog] = useState<PetChoice[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    looks
      .pets()
      .then((r) => {
        if (!live) return;
        setCatalog(r.pets);
        if (r.error) setError(r.error);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "The pet gallery isn't reachable."));
    return () => {
      live = false;
    };
  }, []);
  const choose = async (slug: string | null) => {
    setBusy(slug ?? "none");
    setError("");
    try {
      onChanged(await looks.setPet(profile, slug));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change the companion.");
    } finally {
      setBusy("");
    }
  };
  const current = state.pet?.slug ?? null;
  const q = query.trim().toLowerCase();
  // The gallery's own picks first, then by name; a search looks through all of them.
  const shown = (catalog || [])
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q))
    .sort((a, b) => Number(!!b.curated) - Number(!!a.curated) || a.name.localeCompare(b.name))
    .slice(0, PETS_SHOWN);
  return (
    <Section label="Companion">
      {!catalog && !error ? <p className="text-caption text-fg-3">Opening the pet gallery…</p> : null}
      {catalog && catalog.length > PETS_SHOWN ? (
        <input
          type="search"
          aria-label="Search pets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${catalog.length.toLocaleString()} pets`}
          className={field({ extra: "mb-2 w-full py-2" })}
        />
      ) : null}
      {catalog ? (
        <div className="grid max-h-64 grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2 overflow-y-auto pr-1">
          <Option label="None" pressed={!current} onClick={() => void choose(null)} disabled={!!busy}>
            <span aria-hidden className="block size-9 rounded-full border-2 border-dashed border-line-3" />
          </Option>
          {shown.map((p) => (
            <Option key={p.slug} label={p.name} pressed={current === p.slug} onClick={() => void choose(p.slug)} disabled={!!busy}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/bridge${p.thumbUrl}`} alt="" width={44} height={44} className="size-11 object-contain [image-rendering:pixelated]" loading="lazy" />
            </Option>
          ))}
        </div>
      ) : null}
      {error ? <p className="mt-1 text-caption text-fg-3">{error}</p> : null}
    </Section>
  );
}

function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-callout font-medium text-fg-2">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">{children}</div>;
}

function Option({ label, pressed, onClick, disabled, children }: { label: string; pressed: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`press flex flex-col items-center gap-1 rounded-card border px-1.5 pb-1.5 pt-2 text-caption transition-colors duration-fast disabled:opacity-50 ${
        pressed ? "border-fg/70 bg-fill-2 text-fg" : "border-line text-fg-3 hover:border-line-3 hover:text-fg-2"
      }`}
    >
      <span className="grid h-12 place-items-center">{children}</span>
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`press min-h-8 rounded-full px-3 text-caption font-medium transition-colors duration-fast ${pressed ? "bg-fill-3 text-fg" : "text-fg-3 hover:text-fg-2"}`}
    >
      {children}
    </button>
  );
}
