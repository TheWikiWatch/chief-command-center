import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ledgerConfig } from "@/lib/server/app-config";
import { childEnv } from "@/lib/server/child-env";

/**
 * Fleet Health's optional connector: a learning ledger's report folder and the program that maintains it
 * (see lib/server/app-config.ts). Every function here fails closed when the connector isn't configured.
 */
export class LedgerNotConfigured extends Error {
  constructor() {
    super("Fleet Health is not set up on this install.");
  }
}

function ledger() {
  const config = ledgerConfig();
  if (!config) throw new LedgerNotConfigured();
  return config;
}

export async function readReport(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(ledger().dir, "report.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Run the ledger with fixed arguments (never user text); resolves with its stdout. */
export function runLedger(args: string[], timeoutMs = 60_000): Promise<string> {
  const { tool, python } = ledger();
  return new Promise((resolve, reject) => {
    // Diffs carry arrows and dashes: without this, Python on Windows writes cp1252 and fails on them.
    const env = childEnv({ PYTHONIOENCODING: "utf-8" });
    execFile(python, [tool, ...args], { timeout: timeoutMs, windowsHide: true, encoding: "utf8", env }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim().split(/\r?\n/).pop() || "The ledger failed"));
      else resolve(stdout.trim());
    });
  });
}

export type Decision = { decision: "approve" | "dismiss"; at: number };
const DECISIONS = () => path.join(ledger().dir, "decisions.json");

/** The owner's proposal decisions ({id: {decision, at}}), shared by every device; the ledger reads them too. */
export async function readDecisions(): Promise<Record<string, Decision>> {
  try {
    const data = JSON.parse(await fs.readFile(DECISIONS(), "utf8")) as { items?: Record<string, Decision> };
    return data.items && typeof data.items === "object" ? data.items : {};
  } catch {
    return {};
  }
}

let writing: Promise<unknown> = Promise.resolve();

/** Record one decision (atomic replace; writes are serialized so two taps can't lose each other). */
export function recordDecision(id: string, decision: Decision["decision"]): Promise<Record<string, Decision>> {
  const run = writing.then(async () => {
    const items = await readDecisions();
    items[id] = { decision, at: Date.now() / 1000 };
    const tmp = `${DECISIONS()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ items }, null, 1), "utf8");
    await fs.rename(tmp, DECISIONS());
    return items;
  });
  writing = run.catch(() => undefined);
  return run;
}

type ReportProposal = { id?: unknown; status?: unknown; decision?: unknown };

/**
 * Decisions made since the ledger last ran show at once: the report's status is kept when the ledger
 * already knows the decision (it can say "applied"), otherwise it becomes "sent to the chief" / "dismissed".
 */
export function withDecisions<T extends { proposals?: unknown; flags?: unknown }>(report: T, decisions: Record<string, Decision>): T {
  const proposals = Array.isArray(report.proposals) ? (report.proposals as ReportProposal[]) : [];
  const merged = proposals.map((p) => {
    const d = decisions[String(p.id)];
    if (!d || p.decision === d.decision) return p;
    return { ...p, decision: d.decision, decidedAt: d.at, status: d.decision === "approve" ? "sent to the chief" : "dismissed" };
  });
  const decided = new Set(Object.keys(decisions));
  const flags = Array.isArray(report.flags)
    ? (report.flags as { kind?: unknown; proposal?: unknown }[]).filter((f) => !(f.kind === "proposal" && decided.has(String(f.proposal))))
    : report.flags;
  return { ...report, proposals: merged, flags };
}

// ------------------------------------------------------------------ what the owner did about flags

export type FlagAction = "fine" | "asked";
export type FlagAck = { action: FlagAction; at: number };
export type FlagAcks = { items: Record<string, FlagAck>; asked: Record<string, number[]> };

/** "Looks fine" on a flag with no per-event evidence (a full memory) lasts this long; mirrors the ledger. */
const ACK_EXPIRY_SECONDS = 7 * 86400;
const ASKED_KEPT = 5;
const ACKS = () => path.join(ledger().dir, "flag-acks.json");

/** flag-acks.json: per flag subject, the owner's "Looks fine" or "Ask"; per skill, when they asked the chief. */
export async function readFlagAcks(): Promise<FlagAcks> {
  try {
    const data = JSON.parse(await fs.readFile(ACKS(), "utf8")) as Partial<FlagAcks>;
    const items = data.items && typeof data.items === "object" ? data.items : {};
    const asked = data.asked && typeof data.asked === "object" ? data.asked : {};
    return { items, asked };
  } catch {
    return { items: {}, asked: {} };
  }
}

/**
 * Record what the owner did about one flag (`null` = "Show again"): every device sees it, and the ledger reads it
 * on its next run. Asking about a skill also notes the time, so the chief's tidy-up isn't counted as rework.
 */
export function recordFlagAck(subject: string, action: FlagAction | null, skill?: string): Promise<FlagAcks> {
  const run = writing.then(async () => {
    const acks = await readFlagAcks();
    const now = Date.now() / 1000;
    if (action) acks.items[subject] = { action, at: now };
    else delete acks.items[subject];
    if (action === "asked" && skill) acks.asked[skill] = [...(acks.asked[skill] || []), now].slice(-ASKED_KEPT);
    const tmp = `${ACKS()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(acks, null, 1), "utf8");
    await fs.rename(tmp, ACKS());
    return acks;
  });
  writing = run.catch(() => undefined);
  return run;
}

type ReportFlag = { id?: unknown; subject?: unknown; evidenceAt?: unknown; ack?: unknown };

/** The ledger's rule (learning_ledger.acknowledged): hidden until evidence newer than the acknowledgement. */
export function acknowledged(flag: ReportFlag, ack: FlagAck | undefined, now = Date.now() / 1000): boolean {
  if (!ack) return false;
  const evidence = typeof flag.evidenceAt === "number" ? flag.evidenceAt : null;
  return evidence == null ? now - ack.at < ACK_EXPIRY_SECONDS : evidence <= ack.at;
}

/**
 * Acknowledgements made since the ledger last ran apply at once: a flag the owner just marked moves to
 * `hiddenFlags`, and one they asked to see again comes back. Flags from an older ledger (no subject) use their id.
 */
export function withFlagAcks<T extends { flags?: unknown; hiddenFlags?: unknown }>(report: T, acks: FlagAcks, now = Date.now() / 1000): T {
  const all = [...(Array.isArray(report.flags) ? report.flags : []), ...(Array.isArray(report.hiddenFlags) ? report.hiddenFlags : [])] as ReportFlag[];
  const flags: ReportFlag[] = [];
  const hiddenFlags: ReportFlag[] = [];
  for (const raw of all) {
    const { ack: _old, ...flag } = raw;
    const ack = acks.items[String(flag.subject ?? flag.id)];
    if (acknowledged(flag, ack, now)) hiddenFlags.push({ ...flag, ack });
    else flags.push(flag);
  }
  return { ...report, flags, hiddenFlags };
}
