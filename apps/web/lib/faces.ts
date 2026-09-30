export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function profileColor(name: string): string {
  const key = name.trim();
  if (!key || key === "default") return "hsl(258 68% 58%)";
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 68% 58%)`;
}

/** Hermes Bot Mode hashes `bot.name` (profile folder id), not the display title. */
export function appearanceSeed(profileId?: string, name?: string) {
  return (profileId || name || "").trim();
}

const AVATAR_SHAPES = ["circle", "squircle", "pill", "triangle", "hexagon", "cloud", "drop"] as const;

export function defaultShapeFor(name: string): string {
  let hash = 0;
  for (const ch of name) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return AVATAR_SHAPES[hash % AVATAR_SHAPES.length];
}

export function hueFromColor(color: string): number | undefined {
  const m = color.match(/hsl\(\s*([\d.]+)/i);
  if (!m) return undefined;
  return Number(m[1]);
}

export const BLOB_KINDS = [
  "round",
  "organic",
  "boxy",
  "capsule",
  "nub",
  "cloud",
  "droplet",
  "hexagon",
  "sun",
  "triangle",
] as const;

export const BLOB_KIND_TRAIT: Record<string, number> = {
  round: 0.11,
  organic: 0.35,
  boxy: 0.54,
  capsule: 0.65,
  nub: 0.745,
  cloud: 0.825,
  droplet: 0.8875,
  hexagon: 0.9325,
  sun: 0.965,
  triangle: 0.99,
};

export function isBlobShape(shape?: string | null) {
  return shape === "blobatar" || (typeof shape === "string" && shape.startsWith("blobatar:"));
}

export function parseBlobShape(shape: string | null | undefined, name: string) {
  const parts = typeof shape === "string" ? shape.split(":") : [];
  const seedPart = parts[1] || "";
  const kind = BLOB_KINDS.includes(parts[2] as (typeof BLOB_KINDS)[number]) ? parts[2] : "";
  return {
    seed: seedPart || name || "agent",
    seedPart,
    kind,
  };
}
