import { desktop } from "@/lib/desktop";
import { requestJson } from "@/lib/request";
import type { UpdateHistory } from "@/lib/server/update-history";

export type { HistoryInstall, HistoryRelease, UpdateHistory } from "@/lib/server/update-history";

/** The kept history; on the PC, first fetch any release not kept yet (quietly, if the key or network is missing). */
export async function loadUpdateHistory(refresh = false): Promise<UpdateHistory> {
  if (refresh) await desktop()?.updates?.history?.().catch(() => undefined);
  const data = await requestJson<UpdateHistory & { ok: boolean }>("/api/app/updates", { cache: "no-store" }, 10_000);
  return { available: !!data.available, current: data.current || "", releases: data.releases || [], installs: data.installs || [] };
}

/** "Oct 1, 2026" in the viewer's locale. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const SEEN_KEY = "chief-whats-new-seen";
/** "What's new" shows for this long after an update, and once per device. */
export const WHATS_NEW_DAYS = 14;

/**
 * The version whose notes "What's new" should show on this device: the running version, when it replaced an
 * older one in the last two weeks, its notes are kept, and this device hasn't closed it yet.
 */
export function whatsNewFor(history: UpdateHistory, now = Date.now(), seen = readSeen()): string {
  const current = history.current;
  if (!current || seen === current) return "";
  const install = [...history.installs].reverse().find((i) => i.version === current);
  if (!install?.from || install.from === current) return "";
  if (now - Date.parse(install.at) > WHATS_NEW_DAYS * 86_400_000) return "";
  return history.releases.some((r) => r.version === current && r.notes) ? current : "";
}

function readSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) || "";
  } catch {
    return "";
  }
}

export function markWhatsNewSeen(version: string) {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    /* private mode: it shows again next time, nothing worse */
  }
}
