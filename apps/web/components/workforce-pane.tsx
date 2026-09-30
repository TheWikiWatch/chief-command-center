"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import "blobatar/gaze.css";

import { AnimatedBeam } from "@/components/beams";
import { BotFace, faceProps, type FaceMood } from "@/components/bot-face";
import { BotTip, useBotTip } from "@/components/bot-tip";
import { Starfield } from "@/components/fleet/starfield";
import { OrbitSpace } from "@/components/orbit-space";
import { ChiefPresence, type PresenceMood } from "@/components/presence";
import { workingPeople } from "@/lib/bridge";
import { useFaceClock } from "@/lib/face-clock";
import { useFxPrefs } from "@/lib/fx-prefs";
import { useReducedMotion, SPRING } from "@/lib/motion";
import { splitTitle } from "@/lib/names";
import { groupFleet, orbitLayout, pickOrbitSeats, RING_RADII, seatScale, turn, WORKING_GROUP } from "@/lib/orbit-layout";
import type { FleetMoments } from "@/lib/roster-moments";
import type { Person } from "@/lib/types";
import { useAttentiveGaze } from "@/lib/use-attentive-gaze";
import { useAssistantName } from "@/lib/identity";

type Mode = "orbit" | "rail";

const NO_MOMENTS: FleetMoments = { minted: new Set(), celebrating: new Set(), retired: new Set(), markFresh: () => {} };

function moodOf(p: Person, moments: FleetMoments): FaceMood | undefined {
  if (moments.celebrating.has(p.id)) return "celebrating";
  return undefined;
}

export function WorkforcePane({
  people,
  mode,
  onOpen,
  onLookTarget,
  chiefThinking,
  moments = NO_MOMENTS,
  connected = true,
  phone = false,
}: {
  people: Person[];
  mode: Mode;
  onOpen: (person: Person) => void;
  onLookTarget: (el: HTMLElement | null) => void;
  chiefThinking?: boolean;
  moments?: FleetMoments;
  connected?: boolean;
  phone?: boolean;
}) {
  const chief = people.find((p) => p.isChief);
  const specialists = useMemo(() => people.filter((p) => !p.isChief), [people]);
  const working = workingPeople(people);
  const chiefMood: PresenceMood = !connected ? "offline" : chiefThinking ? "thinking" : working.length ? "working" : "online";

  if (mode === "orbit") {
    return (
      <DesktopOrbit
        chief={chief}
        specialists={specialists}
        working={working}
        chiefMood={chiefMood}
        onOpen={onOpen}
        onLookTarget={onLookTarget}
        moments={moments}
      />
    );
  }
  return (
    <div className="relative h-full overflow-y-auto overscroll-contain bg-pane">
      {phone ? (
        <MiniOrbit chief={chief} specialists={specialists} working={working} chiefMood={chiefMood} onOpen={onOpen} moments={moments} />
      ) : null}
      <FleetList chief={phone ? undefined : chief} chiefMood={chiefMood} specialists={specialists} onOpen={onOpen} moments={moments} topInset={!phone} />
    </div>
  );
}

/* ---------------- Desktop orbit ---------------- */

function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Seconds per radian: about 100s per lap on the single ring; with two rings the inner turns a little faster. */
const DESK_SPIN = 0.063;
const INNER_SPIN = 1.35;
const CENTER_Y = 49;

type SeatOffsets = { current: Record<string, { x: number; y: number }> };

function DesktopOrbit({
  chief,
  specialists,
  working,
  chiefMood,
  onOpen,
  onLookTarget,
  moments,
}: {
  chief: Person | undefined;
  specialists: Person[];
  working: Person[];
  chiefMood: PresenceMood;
  onOpen: (p: Person) => void;
  onLookTarget: (el: HTMLElement | null) => void;
  moments: FleetMoments;
}) {
  const assistant = useAssistantName();
  const container = useRef<HTMLDivElement>(null);
  const chiefNode = useRef<HTMLButtonElement>(null);
  const seatRefs = useRef<Record<string, { current: HTMLButtonElement | null }>>({});
  const outer = useRef<Record<string, HTMLDivElement | null>>({});
  const inner = useRef<Record<string, HTMLDivElement | null>>({});
  const size = useSize(container);
  const reduced = useReducedMotion();
  const { ambient } = useFxPrefs();
  const seats = useMemo(() => orbitLayout(specialists.length), [specialists.length]);
  const lookId = working[0]?.id || null;

  // Rotation state lives in refs and is written straight to the DOM on the shared clock.
  const spin = useRef({ angle: 0, speed: DESK_SPIN, last: 0, hover: false });
  const angles = useRef<Record<string, number>>({});
  const grow = useRef<Record<string, number>>({});
  const offsets = useRef<Record<string, { x: number; y: number }>>({});
  const still = reduced || ambient === "off";

  const seatRef = (id: string) => (seatRefs.current[id] ??= { current: null });
  // Chief watches the bot he works with as it orbits, otherwise your cursor or his own idle glances.
  const lookIdRef = useRef(lookId);
  lookIdRef.current = lookId;
  const { ref: gazeRef } = useAttentiveGaze(() => (lookIdRef.current ? seatRef(lookIdRef.current).current : null));

  useLayoutEffect(() => {
    const el = lookId ? seatRef(lookId).current : null;
    onLookTarget(el);
  }, [lookId, onLookTarget, specialists]);

  const place = (t: number) => {
    const box = container.current;
    if (!box) return;
    const w = box.clientWidth;
    const h = box.clientHeight;
    const s = spin.current;
    const dt = s.last ? Math.min(0.1, t - s.last) : 0;
    s.last = t;
    // Hovering a seat eases the orbit to a stop so it never runs away from the pointer.
    const target = still || s.hover ? 0 : DESK_SPIN;
    s.speed += (target - s.speed) * Math.min(1, dt * 3);
    s.angle += s.speed * dt;

    specialists.forEach((p, i) => {
      const seat = seats[i];
      const o = outer.current[p.id];
      const el = inner.current[p.id];
      if (!seat || !o || !el) return;
      // New layouts (a bot minted or retired) glide into place instead of jumping.
      const prev = angles.current[p.id];
      const base = prev === undefined || still ? seat.angle : prev + turn(prev, seat.angle) * Math.min(1, dt * 2.4);
      angles.current[p.id] = base;
      // A freshly minted bot flies out of Chief to its seat.
      const g0 = grow.current[p.id] ?? (moments.minted.has(p.id) && !still ? 0 : 1);
      const g = g0 + (1 - g0) * Math.min(1, dt * 2.2);
      grow.current[p.id] = g > 0.999 ? 1 : g;
      const ring = RING_RADII[seats.length > 12 ? (seat.ring ? "outer" : "inner") : "single"];
      const a = base + s.angle * (seats.length > 12 && seat.ring === 0 ? INNER_SPIN : 1);
      const x = Math.cos(a) * (ring.rx / 100) * w * grow.current[p.id];
      const y = Math.sin(a) * (ring.ry / 100) * h * grow.current[p.id];
      offsets.current[p.id] = { x, y };
      const depth = (Math.sin(a) + 1) / 2;
      const phase = i * 1.7;
      const dx = still ? 0 : Math.sin(t * 0.35 + phase) * 4;
      const dy = still ? 0 : Math.cos(t * 0.28 + phase) * 3;
      el.style.transform = `translate(-50%, -50%) translate(${(x + dx).toFixed(1)}px, ${(y + dy).toFixed(1)}px) scale(${seatScale(depth).toFixed(3)})`;
      el.style.opacity = (0.72 + depth * 0.28).toFixed(3);
      o.style.zIndex = String(10 + Math.round(depth * 60));
    });
  };
  useFaceClock(container, place);
  // With reduced motion the clock draws once; redraw when the roster or pane size changes.
  useLayoutEffect(() => {
    if (still) place(spin.current.last || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specialists, size.w, size.h, still]);

  const exitVariants = (id: string) => ({
    gone: (o: SeatOffsets) => ({
      opacity: 0,
      scale: 0.25,
      x: -(o?.current[id]?.x ?? 0),
      y: -(o?.current[id]?.y ?? 0),
      transition: { duration: 0.5, ease: [0.3, 0, 0.8, 0.15] as const },
    }),
  });

  return (
    <div
      ref={container}
      className="relative h-full overflow-hidden bg-canvas"
      onPointerOver={(e) => {
        spin.current.hover = !!(e.target as Element | null)?.closest?.("[data-orbit-seat]");
      }}
      onPointerLeave={() => {
        spin.current.hover = false;
      }}
    >
      {ambient === "full" && !reduced ? <OrbitSpace reduced={false} /> : <div className="orbit-stars-static absolute inset-0 opacity-60" />}
      <Starfield count={ambient === "off" ? 60 : 150} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_48%,transparent_30%,rgb(var(--c-canvas))_92%)]" />

      {specialists.length === 0 && !chief ? (
        <p className="absolute inset-0 flex items-center justify-center text-body text-fg-3">Waiting for {assistant}&apos;s people…</p>
      ) : null}

      {chief ? (
        <div className="absolute left-1/2 top-[49%] z-[45] -translate-x-1/2 -translate-y-1/2">
          <button
            ref={chiefNode}
            type="button"
            onClick={() => onOpen(chief)}
            className="press flex flex-col items-center gap-2"
            aria-label={`${splitTitle(chief.name).name || chief.name}, chief of staff`}
          >
            <ChiefPresence chief={chief} size={100} mood={chiefMood} gazeRef={gazeRef} />
            <span className="orbit-bot-name text-[13px] font-semibold">{splitTitle(chief.name).name || chief.name}</span>
          </button>
        </div>
      ) : null}

      <AnimatePresence custom={offsets as SeatOffsets}>
        {specialists.map((person, i) => {
          const seat = seats[i];
          if (!seat) return null;
          const minted = moments.minted.has(person.id);
          const ring = RING_RADII[seats.length > 12 ? (seat.ring ? "outer" : "inner") : "single"];
          const x0 = Math.cos(seat.angle) * (ring.rx / 100) * size.w;
          const y0 = Math.sin(seat.angle) * (ring.ry / 100) * size.h;
          return (
            <motion.div
              key={person.id}
              ref={(el) => void (outer.current[person.id] = el)}
              data-orbit-seat=""
              className="absolute h-0 w-0"
              style={{ left: "50%", top: `${CENTER_Y}%` }}
              variants={exitVariants(person.id)}
              initial={{ opacity: 0, scale: minted ? 0.15 : 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: minted ? { ...SPRING.bouncy, delay: 0.2 } : { ...SPRING.gentle, delay: i * 0.03 } }}
              exit="gone"
            >
              <div
                ref={(el) => void (inner.current[person.id] = el)}
                className="w-max"
                style={{ transform: `translate(-50%, -50%) translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px) scale(${seatScale(seat.depth)})` }}
              >
                {minted ? <span aria-hidden="true" className="mint-burst" /> : null}
                <OrbitSeat person={person} nodeRef={seatRef(person.id)} onOpen={onOpen} paneRef={container} mood={moodOf(person, moments)} />
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>

      {working.map((w) => (
        <AnimatedBeam key={`beam-${w.id}`} containerRef={container} fromRef={chiefNode} toRef={seatRef(w.id)} curvature={w.id.charCodeAt(0) % 2 ? 48 : -36} />
      ))}
      {[...moments.minted].map((id) =>
        specialists.some((p) => p.id === id) ? (
          <AnimatedBeam key={`mint-${id}`} containerRef={container} fromRef={chiefNode} toRef={seatRef(id)} curvature={30} once tone="mint" />
        ) : null,
      )}
    </div>
  );
}

function OrbitSeat({
  person,
  nodeRef,
  onOpen,
  paneRef,
  mood,
}: {
  person: Person;
  nodeRef: { current: HTMLButtonElement | null };
  onOpen: (p: Person) => void;
  paneRef: RefObject<HTMLDivElement | null>;
  mood?: FaceMood;
}) {
  const tip = useBotTip();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const { name, role } = splitTitle(person.name);
  const working = person.ring === "working";
  return (
    <button
      ref={(el) => {
        setAnchor((cur) => (cur === el ? cur : el));
        nodeRef.current = el;
      }}
      type="button"
      onClick={() => onOpen(person)}
      onPointerEnter={tip.show}
      onPointerLeave={tip.hide}
      onFocus={tip.show}
      onBlur={tip.hide}
      aria-label={person.jobTitle ? `${person.name}, ${person.jobTitle}` : person.name}
      aria-describedby={tip.open ? tip.tipId : undefined}
      className="press group relative flex w-40 flex-col items-center gap-1.5 text-center"
    >
      <span className={`relative rounded-full p-1 transition-shadow duration-medium ${working ? "shadow-[0_0_0_2px_rgb(var(--c-accent)/0.55),0_0_24px_rgb(var(--c-accent)/0.35)]" : ""}`}>
        <BotFace {...faceProps(person)} mood={mood} size={58} />
      </span>
      <span className="orbit-bot-name">{name || person.name}</span>
      {working && person.jobTitle ? (
        <span className="max-w-[10rem] truncate rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent-text">{person.jobTitle}</span>
      ) : role ? (
        <span className="max-w-[10rem] truncate text-[11px] text-fg-3 opacity-0 transition-opacity duration-fast group-hover:opacity-100">{role}</span>
      ) : null}
      <BotTip person={person} open={tip.open} id={tip.tipId} anchor={anchor} paneRef={paneRef} placement="orbit" />
    </button>
  );
}

/* ---------------- Phone mini-orbit ---------------- */

const MINI_MAX = 10;
const MINI_HARD_MAX = 12;

function MiniOrbit({
  chief,
  specialists,
  working,
  chiefMood,
  onOpen,
  moments,
}: {
  chief: Person | undefined;
  specialists: Person[];
  working: Person[];
  chiefMood: PresenceMood;
  onOpen: (p: Person) => void;
  moments: FleetMoments;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chiefNode = useRef<HTMLDivElement>(null);
  const seatEls = useRef<Record<string, HTMLDivElement | null>>({});
  const seatRefs = useRef<Record<string, { current: HTMLButtonElement | null }>>({});
  // Whoever is working always has a seat; the rest fill in roster order (PLAN: orbit keeps active workers).
  const shown = useMemo(() => pickOrbitSeats(specialists, MINI_MAX, MINI_HARD_MAX), [specialists]);
  const extra = specialists.length - shown.length;
  const reduced = useReducedMotion();
  const angles = useRef<Record<string, number>>({});

  // Slowly rotating tilted ellipse with depth: front faces grow, overlap Chief and brighten.
  // When the seated set changes, each face glides to its new angle instead of jumping.
  const draw = (t: number) => {
    const el = box.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const n = shown.length || 1;
    const spin = reduced ? 0 : t * 0.1;
    shown.forEach((p, i) => {
      const seat = seatEls.current[p.id];
      if (!seat) return;
      const target = (i / n) * Math.PI * 2;
      const current = angles.current[p.id];
      const base = current === undefined || reduced ? target : current + turn(current, target) * 0.06;
      angles.current[p.id] = base;
      const a = -Math.PI / 2 + base + spin;
      const x = w / 2 + Math.cos(a) * w * 0.38;
      const y = h / 2 + Math.sin(a) * h * 0.3;
      const depth = (Math.sin(a) + 1) / 2;
      seat.style.transform = `translate(${(x - 20).toFixed(1)}px, ${(y - 20).toFixed(1)}px) scale(${(0.78 + depth * 0.36).toFixed(3)})`;
      seat.style.zIndex = String(depth > 0.5 ? 60 : 30);
      seat.style.opacity = (0.55 + depth * 0.45).toFixed(2);
    });
  };
  useFaceClock(box, draw);
  // With reduced motion the clock only draws once: place newly seated faces directly.
  useLayoutEffect(() => {
    if (reduced) draw(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, reduced]);

  return (
    <section ref={box} className="relative h-64 overflow-hidden border-b border-line bg-canvas" aria-label="Fleet orbit">
      <Starfield count={70} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(var(--c-accent)/0.12),transparent_60%)]" />
      {chief ? (
        <div ref={chiefNode} className="absolute left-1/2 top-1/2 z-[45] -translate-x-1/2 -translate-y-1/2">
          <button type="button" className="press" onClick={() => onOpen(chief)} aria-label={`${splitTitle(chief.name).name || chief.name}, chief of staff`}>
            <ChiefPresence chief={chief} size={72} mood={chiefMood} />
          </button>
        </div>
      ) : null}
      <AnimatePresence initial={false}>
        {shown.map((p) => (
          <div
            key={p.id}
            ref={(el) => {
              seatEls.current[p.id] = el;
            }}
            className="absolute left-0 top-0 h-10 w-10"
            style={{ opacity: 0 }}
          >
            <motion.button
              ref={(el) => {
                (seatRefs.current[p.id] ??= { current: null }).current = el;
              }}
              type="button"
              onClick={() => onOpen(p)}
              aria-label={p.ring === "working" && p.jobTitle ? `${p.name}, working on ${p.jobTitle}` : p.name}
              className="relative block h-10 w-10"
              initial={{ opacity: 0, scale: 0.4, filter: moments.minted.has(p.id) ? "brightness(3)" : "brightness(1)" }}
              animate={{ opacity: 1, scale: 1, filter: "brightness(1)", transition: { ...SPRING.gentle, filter: { duration: 0.9 } } }}
              exit={{ opacity: 0, scale: 0.4, transition: { duration: 0.35 } }}
            >
              <BotFace {...faceProps(p)} mood={moodOf(p, moments)} size={40} />
              {p.ring === "working" ? <span aria-hidden="true" className="absolute -inset-1 animate-ping rounded-full border border-accent/60" /> : null}
            </motion.button>
          </div>
        ))}
      </AnimatePresence>
      {extra > 0 ? (
        <button
          type="button"
          className="press glass absolute bottom-3 right-3 z-[70] flex min-h-9 items-center rounded-full px-3 text-caption font-medium text-fg-2"
          aria-label={`${extra} more ${extra === 1 ? "specialist" : "specialists"}. Show the list`}
          onClick={() => document.getElementById("fleet-list")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        >
          +{extra}
        </button>
      ) : null}
      {working
        .filter((w) => shown.some((p) => p.id === w.id))
        .map((w) => (
          <AnimatedBeam key={w.id} containerRef={box} fromRef={chiefNode} toRef={(seatRefs.current[w.id] ??= { current: null })} curvature={20} />
        ))}
    </section>
  );
}

/* ---------------- List (phone and desktop rail) ---------------- */

function FleetList({
  chief,
  chiefMood,
  specialists,
  onOpen,
  moments,
  topInset = false,
}: {
  chief: Person | undefined;
  chiefMood: PresenceMood;
  specialists: Person[];
  onOpen: (p: Person) => void;
  moments: FleetMoments;
  /** Desktop rail: clear the floating Fleet/Today switch. */
  topInset?: boolean;
}) {
  const assistant = useAssistantName();
  const grouped = useMemo(() => groupFleet(specialists), [specialists]);

  return (
    <div id="fleet-list" className={`relative z-10 scroll-mt-2 px-3 pb-6 ${topInset ? "pt-16" : "pt-3"}`}>
      {chief ? (
        <button type="button" onClick={() => onOpen(chief)} className="press mb-3 flex w-full items-center gap-3 rounded-card border border-line bg-card px-3 py-3 text-left">
          <ChiefPresence chief={chief} size={44} mood={chiefMood} />
          <span className="min-w-0 flex-1 pl-2">
            <span className="block truncate text-headline text-fg">{splitTitle(chief.name).name || chief.name}</span>
            <span className="block truncate text-callout text-fg-3">{splitTitle(chief.name).role || "Chief of staff"}</span>
          </span>
        </button>
      ) : null}
      {grouped.length === 0 ? <p className="px-2 py-6 text-callout text-fg-3">No specialists yet. When {assistant} creates one it appears here.</p> : null}
      {grouped.map(([section, list]) => (
        <section key={section} className="mb-4">
          <h2 className={`mb-1.5 flex items-center gap-2 px-2 text-callout font-medium ${section === WORKING_GROUP ? "text-accent-text" : "text-fg-2"}`}>
            {section === WORKING_GROUP ? (
              <span className="relative flex size-2" aria-hidden="true">
                <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative size-2 rounded-full bg-accent" />
              </span>
            ) : null}
            {section}
            <span className={section === WORKING_GROUP ? "text-accent-text/70" : "text-fg-3"}>{list.length}</span>
          </h2>
          <ul className={`overflow-hidden rounded-card border bg-card ${section === WORKING_GROUP ? "border-accent/25 shadow-[0_0_0_1px_rgb(var(--c-accent)/0.06),0_8px_28px_-12px_rgb(var(--c-accent)/0.35)]" : "border-line"}`}>
            <AnimatePresence initial={false}>
              {list.map((person) => (
                <motion.li
                  key={person.id}
                  layout="position"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto", transition: SPRING.gentle }}
                  exit={{ opacity: 0, height: 0, transition: { duration: 0.35 } }}
                  className="border-b border-line last:border-b-0"
                >
                  <FleetRow person={person} onOpen={onOpen} mood={moodOf(person, moments)} minted={moments.minted.has(person.id)} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </section>
      ))}
    </div>
  );
}

export function StatusPill({ person }: { person: Person }) {
  if (person.ring === "working") {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full bg-accent/15 px-2 py-0.5 text-caption font-medium text-accent-text">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
        <span className="truncate">{person.jobTitle ? `Working · ${person.jobTitle}` : "Working"}</span>
      </span>
    );
  }
  if (person.ring === "failed") {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full bg-danger/15 px-2 py-0.5 text-caption font-medium text-danger">
        <span className="truncate">{person.jobTitle ? `Blocked · ${person.jobTitle}` : "Blocked"}</span>
      </span>
    );
  }
  return <span className="text-caption text-fg-3">Idle</span>;
}

function FleetRow({ person, onOpen, mood, minted }: { person: Person; onOpen: (p: Person) => void; mood?: FaceMood; minted: boolean }) {
  const { name, role } = splitTitle(person.name);
  return (
    <button type="button" onClick={() => onOpen(person)} className={`press flex min-h-16 w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-white/[0.03] ${minted ? "mint-row" : ""}`}>
      <BotFace {...faceProps(person)} mood={mood} size={42} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-semibold text-fg">{name || person.name}</span>
        {role ? <span className="block truncate text-callout text-fg-3">{role}</span> : null}
      </span>
      <span className="max-w-[45%] shrink-0 text-right">
        <StatusPill person={person} />
      </span>
    </button>
  );
}
