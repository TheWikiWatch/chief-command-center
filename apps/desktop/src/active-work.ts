/**
 * Before Quit or a restore stops Chief (PLAN §4 "Shutdown"): is anything in progress? A reply being written,
 * an approval waiting, a message still queued, or a kanban worker running. Pure: callers pass what the bridge
 * reported.
 */
export type WorkSnapshot = {
  generating?: boolean;
  approval?: unknown;
  outboxQueued?: number;
  workers?: { name: string; working: boolean }[];
};

export type ActiveWork = { busy: boolean; reasons: string[] };

export function activeWork(snapshot: WorkSnapshot | null, assistant = "Chief"): ActiveWork {
  if (!snapshot) return { busy: false, reasons: [] };
  const reasons: string[] = [];
  if (snapshot.generating) reasons.push(`${assistant} is writing a reply.`);
  if (snapshot.approval) reasons.push(`${assistant} is waiting for your approval.`);
  if ((snapshot.outboxQueued || 0) > 0) reasons.push(`${snapshot.outboxQueued} message${snapshot.outboxQueued === 1 ? " is" : "s are"} still being delivered.`);
  const working = (snapshot.workers || []).filter((w) => w.working).map((w) => w.name);
  if (working.length) reasons.push(`${working.join(", ")} ${working.length === 1 ? "is" : "are"} working on a task.`);
  return { busy: reasons.length > 0, reasons };
}

/** Parse the bridge's /snapshot answer (roster rings come from Hermes's kanban work status). */
export function fromBridgeSnapshot(raw: unknown): WorkSnapshot {
  const s = (raw || {}) as {
    generating?: boolean;
    approval?: unknown;
    roster?: { name?: string; id?: string; ring?: string }[];
  };
  return {
    generating: !!s.generating,
    approval: s.approval || null,
    workers: (s.roster || []).map((p) => ({ name: String(p.name || p.id || "A specialist"), working: p.ring === "working" })),
  };
}
