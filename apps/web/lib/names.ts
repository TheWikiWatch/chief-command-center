/**
 * Hermes titles are usually "Name - Role" ("The chief - Chief of Staff"). New bots can have any
 * title (VISUAL-OVERHAUL §12), so fall back to the whole title as the name.
 */
export function splitTitle(title: string | undefined | null): { name: string; role: string } {
  const raw = String(title || "").trim();
  if (!raw) return { name: "", role: "" };
  const match = /^(.{1,60}?)\s+[-–—|:]\s+(.+)$/.exec(raw);
  if (!match) return { name: raw, role: "" };
  return { name: match[1].trim(), role: match[2].trim() };
}
