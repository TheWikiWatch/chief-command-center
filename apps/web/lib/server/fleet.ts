import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ledgerConfig } from "@/lib/server/app-config";

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
    const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
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
 * already knows the decision (it can say "applied"), otherwise it becomes "sent to Chief" / "dismissed".
 */
export function withDecisions<T extends { proposals?: unknown; flags?: unknown }>(report: T, decisions: Record<string, Decision>): T {
  const proposals = Array.isArray(report.proposals) ? (report.proposals as ReportProposal[]) : [];
  const merged = proposals.map((p) => {
    const d = decisions[String(p.id)];
    if (!d || p.decision === d.decision) return p;
    return { ...p, decision: d.decision, decidedAt: d.at, status: d.decision === "approve" ? "sent to Chief" : "dismissed" };
  });
  const decided = new Set(Object.keys(decisions));
  const flags = Array.isArray(report.flags)
    ? (report.flags as { kind?: unknown; proposal?: unknown }[]).filter((f) => !(f.kind === "proposal" && decided.has(String(f.proposal))))
    : report.flags;
  return { ...report, proposals: merged, flags };
}
