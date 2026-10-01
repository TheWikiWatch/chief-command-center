import { requestJson } from "@/lib/request";

/**
 * Fleet Health: an optional connector to a learning ledger's report (report.json in CHIEF_LEARNING_DIR,
 * refreshed by the chief's ledger cron), served read-only by /api/fleet/health with the owner's proposal
 * decisions merged in.
 */
export type WindowStats = {
  done: number;
  crashed: number;
  gaveUp: number;
  spawned: number;
  medianMinutes: number | null;
  /** done / (done + crashed + gave up); null when there were no attempts. */
  success: number | null;
  /** done / (done + gave up): crashes are mostly the machine, not the skill (episode verdicts). */
  quality?: number | null;
  crashRate?: number | null;
};

export type DeskCard = {
  desk: string;
  /** Cards done per week, oldest first (6 weeks). */
  weeks: number[];
  last7: WindowStats;
  cards30: number;
  blocked: number;
  memory: { memory: number; memoryLimit: number; user: number; userLimit: number };
};

export type Verdict = {
  label: "helped" | "worse" | "no clear change" | "confounded" | "too early" | "too little work" | string;
  why?: string;
  /** When the verdict is (or was) made: 14 days after the episode's last edit. */
  judgeAt?: number;
  before?: WindowStats;
  after?: WindowStats;
};

export type SkillChange = {
  id: number;
  scope?: string;
  skill?: string;
  file: string;
  change: "added" | "changed" | "removed" | "reverted" | string;
  at: number;
  source: string;
  added: number;
  removed: number;
  canRevert: boolean;
  /** Edits to the same file after this one; reverting this change undoes them too. */
  newer?: number;
  /** The episode this edit belongs to. */
  episode?: string | null;
};

/** Edits to one skill closer together than 48 hours, judged as one before/after. */
export type Episode = { id: string; start: number; end: number; edits: number; firstId: number; lastId: number; verdict: Verdict };

export type SkillSummary = {
  key: string;
  scope: string;
  skill: string;
  name: string;
  files: number;
  edits48h: number;
  edits7d: number;
  edits30d: number;
  size: number;
  size14d: number | null;
  skillMdSize: number;
  lastAt: number;
  sources: { review: number; outside: number };
  episodes: Episode[];
  changes: SkillChange[];
};

export type Flag = {
  id: string;
  kind: "churn" | "bloat" | "memory" | "worse" | "proposal" | string;
  severity: "danger" | "warn" | "info" | string;
  title: string;
  detail: string;
  skill?: string;
  desk?: string;
  proposal?: string;
};

export type RunInfo = { name?: string; lastRunAt?: string | null; lastStatus?: string | null; enabled?: boolean } | null;

export type Runtime = {
  crashes24h: number;
  crashes7d: number;
  crashGroups: { key: string; count: number }[];
  lastCrashAt: number | null;
  compactionsToday: number;
  curator: { at: string; checked?: number | null; archived?: number | null } | null;
  distill: RunInfo;
  rosterReview: RunInfo;
};

/** The bundled ledger says "the chief"; an older external ledger used the chief's name ("… Chief"). */
export type ProposalStatus = "open" | "sent to the chief" | "waiting on the chief" | "sent to Chief" | "waiting on Chief" | "applied" | "dismissed" | string;

export type Proposal = {
  id: string;
  kind: string;
  target: string;
  change: string;
  why?: string;
  status?: ProposalStatus;
  decision?: "approve" | "dismiss";
  decidedAt?: number;
  appliedAt?: number;
};

export type FleetHealth = {
  ok: true;
  generatedAt: number;
  ageSeconds: number;
  desks: DeskCard[];
  skills?: SkillSummary[];
  changes: SkillChange[];
  changes7d: number;
  runtime: Runtime;
  proposals: Proposal[];
  flags?: Flag[];
};

export const fetchFleetHealth = (signal?: AbortSignal) => requestJson<FleetHealth>("/api/fleet/health", { cache: "no-store", signal }, 10_000);

/** Just the flags, for the Health badge. */
export const fetchFleetFlags = (signal?: AbortSignal) =>
  requestJson<{ ok: true; generatedAt: number; flags: Flag[] }>("/api/fleet/health?only=flags", { cache: "no-store", signal }, 10_000);

/** One change as a unified diff, or the net change from the version before `from` to `id` (same file). */
export const fetchSkillDiff = (id: number, from?: number) =>
  requestJson<{ ok: boolean; diff: string; error?: string }>(`/api/fleet/diff?id=${id}${from && from !== id ? `&from=${from}` : ""}`, {}, 25_000);

const post = <T>(path: string, body: unknown) =>
  requestJson<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 90_000);

/**
 * Put back the version before change `id` (the ledger backs up the current file first). `discardNewer`
 * must equal the later edits the viewer was warned about, or the ledger refuses.
 */
export const revertSkillChange = (id: number, discardNewer = 0) =>
  post<{ ok: boolean; message?: string; error?: string }>("/api/fleet/revert", { id, discardNewer });

/** Run the ledger now (snapshot + report) instead of waiting for the 30-minute cron. */
export const refreshFleetHealth = () => post<{ ok: boolean; error?: string }>("/api/fleet/refresh", {});

/** Approve or dismiss a proposal for every device (and for the distill, which reads the decisions). */
export const decideProposal = (id: string, decision: "approve" | "dismiss") =>
  post<{ ok: boolean; error?: string }>("/api/fleet/decide", { id, decision });

/** The message Approve sends to Chief for one distill proposal. */
export function approvalMessage(p: Proposal) {
  const why = p.why ? ` Why: ${p.why}` : "";
  return `Approved from Fleet Health (distill ${p.id}, ${p.kind}): ${p.target} — ${p.change}.${why} Please apply it, following your usual backup and verify rules, and tell me what changed.`;
}

/** What "Ask Chief" sends for a flag. Proposals have their own Approve; nothing is changed without asking. */
export function flagMessage(f: Flag): string | null {
  const head = `Fleet Health flag: ${f.title}. ${f.detail}`.trim();
  const skill = f.skill ? ` (${f.skill})` : "";
  switch (f.kind) {
    case "churn":
      return `${head} Please read the recent edits to that skill${skill}, settle the rule into one clear version, and tell me what you changed. Back up first.`;
    case "bloat":
      return `${head} Please slim that skill${skill}: keep SKILL.md to the operating rules and move history, case notes and long examples into references/. Back up first and tell me the size before and after.`;
    case "memory":
      return `${head} Please consolidate ${f.desk ? `${f.desk}'s` : "that"} memory: merge duplicates and drop stale facts, then tell me what you removed.`;
    case "worse":
      return `${head} Please look at the net change to that skill${skill} and tell me whether you'd revert it. I can revert it from Fleet Health.`;
    default:
      return null;
  }
}

export const percent = (n: number | null | undefined) => (n == null ? "–" : `${Math.round(n * 100)}%`);

export function fill(used: number, limit: number) {
  return limit > 0 ? Math.min(1, used / limit) : 0;
}

export const kb = (bytes: number) => (bytes >= 10_000 ? `${Math.round(bytes / 1000)} KB` : `${(bytes / 1000).toFixed(1)} KB`);

/** Flags seen in the Health view on this device (the badge counts the rest). */
const SEEN_KEY = "chief-fleet-flags-seen";

export function loadSeenFlags(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function markFlagsSeen(ids: string[]) {
  try {
    const next = [...new Set([...loadSeenFlags(), ...ids])].slice(-400);
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(FLAGS_SEEN_EVENT));
  } catch {
    /* private mode */
  }
}

export const FLAGS_SEEN_EVENT = "chief-fleet-flags-seen";

/** Flags worth a badge: anything not informational that this device hasn't looked at. */
export const unseenFlags = (flags: Flag[], seen: Set<string>) => flags.filter((f) => f.severity !== "info" && !seen.has(f.id));
