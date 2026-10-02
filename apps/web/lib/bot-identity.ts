import { glowColor } from "@/lib/color";
import { appearanceSeed, defaultShapeFor } from "@/lib/faces";

/**
 * Zero-setup identity for any bot, including ones the chief mints on the fly (VISUAL-OVERHAUL §12).
 * Everything derives from the profile id, so a bot looks the same on every device and reload.
 */

/** Ten hues at equal perceived lightness (LCH L72 C52), so the fleet reads as one family. */
export const BOT_PALETTE = ["#ff8a93", "#f69769", "#d4a950", "#a6b952", "#58c57e", "#00c9bf", "#00c5f3", "#58b8ff", "#b4a5ff", "#ee90e1"] as const;

const KNOWN_SHAPES = new Set(["circle", "squircle", "pill", "triangle", "hexagon", "cloud", "drop"]);

export function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

export type BotIdentity = {
  seed: string;
  color: string;
  shape: string;
  /** Personality: breathing period (s), blink period (s), glance rate and phase. */
  breathe: number;
  blink: number;
  glance: number;
  phase: number;
};

export function botIdentity(p: { id?: string; name?: string; color?: string; shape?: string; custom?: boolean; isChief?: boolean }): BotIdentity {
  const seed = appearanceSeed(p.id, p.name) || "bot";
  const h = hashId(seed);
  const keepColor = (p.custom || p.isChief) && !!p.color;
  // A chosen color too dark to see on the canvas is lifted just enough (lib/color.ts).
  const color = keepColor ? glowColor(String(p.color)) : BOT_PALETTE[h % BOT_PALETTE.length];
  const raw = String(p.shape || "");
  const shape = raw.startsWith("blobatar") || KNOWN_SHAPES.has(raw) ? raw : defaultShapeFor(seed);
  return {
    seed,
    color,
    shape,
    breathe: 3.6 + ((h >>> 3) % 1000) / 1000 * 2.4,
    blink: 2.8 + ((h >>> 7) % 1000) / 1000 * 2.2,
    glance: 0.14 + ((h >>> 11) % 1000) / 1000 * 0.16,
    phase: ((h >>> 13) % 6283) / 1000,
  };
}

/** The chief's color: its face, the ring around it, the chat aurora and the Fleet orbit's rays (lib/color.ts). */
export function chiefColor(chief: { id?: string; name?: string; color?: string; shape?: string; custom?: boolean }): string {
  return botIdentity({ ...chief, isChief: true }).color;
}
