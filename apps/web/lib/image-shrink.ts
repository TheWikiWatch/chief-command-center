"use client";

/**
 * Photos are shrunk on the device before they go to the chief (PLAN-2026-09-29 phase 3): a 12 MP camera
 * photo is 4-10 MB, a third more as base64 JSON, over mobile data through Tailscale. The chief reads a
 * 2048 px image just as well. Settings → "Send photos full size" turns this off.
 *
 * - JPEG / WebP / HEIC (where the browser can decode it): 2048 px long edge, JPEG quality 0.85.
 * - PNG (screenshots, transparency): only scaled down if larger than 2048 px, and kept PNG so text
 *   stays sharp and transparency survives.
 * - GIF and anything else: untouched. Any failure: the original is sent.
 */
export const MAX_EDGE = 2048;
export const JPEG_QUALITY = 0.85;
/** A JPEG this small is sent as it is, even if it is large in pixels. */
const SMALL_ENOUGH = 700 * 1024;

export type ShrinkPlan = { width: number; height: number; type: "image/jpeg" | "image/png" } | null;

/** What to do with one image of this type, size and pixel dimensions (null: send it as it is). */
export function shrinkPlan(mime: string, bytes: number, width: number, height: number): ShrinkPlan {
  const type = mime.toLowerCase();
  if (!width || !height) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const size = { width: Math.round(width * scale), height: Math.round(height * scale) };
  if (type === "image/png") return scale < 1 ? { ...size, type: "image/png" } : null;
  if (!["image/jpeg", "image/jpg", "image/webp", "image/heic", "image/heif"].includes(type)) return null;
  if (scale === 1 && bytes <= SMALL_ENOUGH && type !== "image/heic" && type !== "image/heif") return null;
  return { ...size, type: "image/jpeg" };
}

function renamed(name: string, type: string) {
  if (type !== "image/jpeg") return name;
  const base = name.replace(/\.[^./\\]+$/, "");
  return `${base || "photo"}.jpg`;
}

/** The file to send: a smaller copy when that helps, otherwise the original. */
export async function shrinkImage(file: File): Promise<File> {
  try {
    if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return file;
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    try {
      const plan = shrinkPlan(file.type, file.size, bitmap.width, bitmap.height);
      if (!plan) return file;
      const canvas = document.createElement("canvas");
      canvas.width = plan.width;
      canvas.height = plan.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, plan.type, plan.type === "image/jpeg" ? JPEG_QUALITY : undefined));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], renamed(file.name, plan.type), { type: plan.type, lastModified: file.lastModified });
    } finally {
      bitmap.close?.();
    }
  } catch {
    return file;
  }
}
