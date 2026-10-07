import { requestJson, RequestError } from "@/lib/request";
import type { FaceLook, PetInfo } from "@/lib/types";

/**
 * A bot's look (the bridge's looks.py, docs/PLAN-2026-10-07 §2.2): read, save (with Hermes's per-key revisions, so
 * an edit made elsewhere in the meantime is never overwritten), a photo, a generated portrait, and a companion pet.
 */
export type LookState = {
  look: FaceLook | null;
  pet: PetInfo | null;
  revisions: Record<string, number>;
  hasAvatar: boolean;
  /** An image generator is set up, so "Generate portrait" can work. */
  portrait?: boolean;
  /** The pet gallery is usable. */
  pets?: boolean;
};

/** A pet in Hermes's gallery (petdex); `curated` ones are the gallery's own picks. */
export type PetChoice = { slug: string; name: string; description?: string; thumbUrl: string; curated?: boolean };

const PREFIX = "/api/bridge";
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const id = (profile: string) => encodeURIComponent(profile);

/** Saving a look someone (or the chief) changed since it was read. */
export class LookConflict extends Error {}

export const looks = {
  load: (profile: string) => requestJson<LookState>(`${PREFIX}/look/${id(profile)}`, { cache: "no-store" }),
  /** `face` null resets to the bot's default face. */
  save: async (profile: string, face: FaceLook | null, expected: Record<string, number>) => {
    try {
      return await requestJson<LookState>(`${PREFIX}/look/${id(profile)}`, json({ face, expected }), 20_000);
    } catch (e) {
      if (e instanceof RequestError && e.status === 409) throw new LookConflict("Changed somewhere else in the meantime.");
      throw e;
    }
  },
  uploadPhoto: (profile: string, file: Blob) =>
    requestJson<LookState>(`${PREFIX}/look/${id(profile)}/avatar`, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file }, 30_000),
  portrait: (profile: string, prompt: string) => requestJson<LookState>(`${PREFIX}/look/${id(profile)}/portrait`, json({ prompt }), 175_000),
  pets: () => requestJson<{ pets: PetChoice[]; error?: string }>(`${PREFIX}/pets/catalog`, { cache: "no-store" }, 35_000),
  setPet: (profile: string, slug: string | null) => requestJson<LookState>(`${PREFIX}/look/${id(profile)}/pet`, json({ slug }), 75_000),
};

/** The largest photo the bridge takes (it re-encodes to 512 px). */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
