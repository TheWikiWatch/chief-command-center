"use client";

import type { CSSProperties } from "react";

import type { PetInfo } from "@/lib/types";

/**
 * A companion from Hermes's pet gallery (petdex sprite sheets): the first row of frames, stepped like petdex does.
 * Hermes's sheets are 8 columns × 9 rows of 192 × 208 frames, six steps per loop of 1.1 s, unless the bridge says
 * otherwise. Still when motion is reduced (globals.css `.pet-sprite`).
 */
export function PetSprite({ pet, size = 48, className = "" }: { pet: PetInfo; size?: number; className?: string }) {
  const f = { cols: 8, rows: 9, width: 192, height: 208, loopMs: 1100, steps: 6, ...pet.frames };
  const w = size;
  const h = Math.round((size * f.height) / f.width);
  const style = {
    width: w,
    height: h,
    // The sheet's address stays the same when the pet changes: the slug keeps the browser from showing the old one.
    backgroundImage: `url(/api/bridge${pet.sheetUrl}?v=${encodeURIComponent(pet.slug)})`,
    backgroundSize: `${f.cols * w}px ${f.rows * h}px`,
    "--pet-end": `${-f.steps * w}px`,
    "--pet-loop": `${f.loopMs}ms`,
    "--pet-steps": f.steps,
  } as CSSProperties;
  return <span role="img" aria-label={pet.name || "Companion"} title={pet.name} className={`pet-sprite inline-block shrink-0 ${className}`} style={style} />;
}
