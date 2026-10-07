/**
 * Starting Chief (PLAN §4 "Boot"), as a sequence over injected dependencies so the order, the shortcuts and the
 * failure exits are tested without Electron or processes (tests/boot.test.ts).
 *
 * - One boot at a time: Retry while a boot is running joins it.
 * - An interrupted restore is recovered only when its journal exists.
 * - Provisioning is skipped when nothing it depends on changed since it last succeeded.
 * - The dashboard server starts beside Chief's gateway rather than after it.
 */
export type StepState = "waiting" | "working" | "done" | "error";

export type BootDeps = {
  setStep: (id: "runtime" | "prepare" | "gateway" | "web", state: StepState, detail?: string) => void;
  showBootPage: () => Promise<void>;
  /** Files the install needs that aren't there. */
  missing: () => string[];
  /** Loads (or creates) the bridge token; throws when it can't. */
  loadToken: () => void;
  /** Set when this data was written by a newer app. */
  newerDataError: () => string | null;
  choosePorts: () => Promise<void>;
  restoreJournalExists: () => boolean;
  recover: () => Promise<{ ok: boolean; action?: string }>;
  provisionKey: () => string;
  lastProvisionKey: () => string;
  provision: () => Promise<{ ok: boolean; error?: string }>;
  saveProvisionKey: (key: string) => void;
  /** A first start of a newer version with a different Hermes: the backup message, or null when none is needed. */
  backupNeeded: () => string | null;
  backup: (onProgress?: (fraction: number) => void) => Promise<{ ok: boolean; error?: string }>;
  recordStart: () => void;
  /** Another launcher's gateway: take it over, use it as is, or quit. Resolves "own" when there was none. */
  claimGateway: () => Promise<"own" | "external" | "quit">;
  startGateway: () => Promise<void>;
  gatewayUp: (external: boolean) => Promise<{ ok: boolean; voice?: boolean; detail?: string }>;
  gatewayDetail: () => string;
  startWeb: () => Promise<{ ok: boolean; detail?: string }>;
  openDashboard: () => Promise<void>;
  quit: () => void;
  now: () => number;
  log: (event: string, fields?: Record<string, unknown>) => void;
};

export type BootResult = "ready" | "error" | "quit";

type StepId = Parameters<BootDeps["setStep"]>[0];

/**
 * A supervisor that came back on its own (its restart after a crash, or the slow retry) while the start screen shows
 * a failure: the boot runs again without anyone pressing Retry. Nothing happens once the dashboard is open (no step
 * is in error then) or while a boot is already under way (it will see the recovery itself).
 */
export function recoversBoot(event: { type: string; state?: string }, steps: { state: string }[], bootRunning: boolean): boolean {
  return event.type === "state" && event.state === "running" && !bootRunning && steps.some((s) => s.state === "error");
}

export function createBoot(deps: BootDeps) {
  let running: Promise<BootResult> | null = null;
  // The step under way, so a throw from inside it (a port search that found none, a window that wouldn't load) is
  // shown on that step with Retry, instead of a spinner that never ends.
  let current: StepId = "runtime";

  async function sequence(): Promise<BootResult> {
    const started = deps.now();
    const timed = new Map<string, number>();
    const step = (id: StepId, state: StepState, detail = "") => {
      if (state === "working") current = id;
      if (state === "working" && !timed.has(id)) timed.set(id, deps.now());
      if (state === "done" || state === "error") deps.log(`boot.${id}.${state}`, { ms: deps.now() - (timed.get(id) ?? started), ...(detail ? { detail } : {}) });
      deps.setStep(id, state, detail);
    };
    const fail = (id: StepId, detail: string): BootResult => {
      step(id, "error", detail);
      return "error";
    };

    await deps.showBootPage();

    step("runtime", "working");
    const gone = deps.missing();
    if (gone.length) return fail("runtime", `Missing: ${gone.join("; ")}`);
    try {
      deps.loadToken();
    } catch (e) {
      return fail("runtime", e instanceof Error ? e.message : String(e));
    }
    step("runtime", "done");

    step("prepare", "working");
    const newer = deps.newerDataError();
    if (newer) return fail("prepare", newer);
    await deps.choosePorts();
    if (deps.restoreJournalExists()) {
      const recovered = await deps.recover();
      if (recovered.ok && recovered.action === "rolled-back") step("prepare", "working", "An interrupted restore was undone.");
    }
    const key = deps.provisionKey();
    if (key !== deps.lastProvisionKey()) {
      const provisioned = await deps.provision();
      if (!provisioned.ok) return fail("prepare", provisioned.error || "Preparing Hermes failed.");
      deps.saveProvisionKey(key);
    } else deps.log("boot.provision.skipped");
    const backupMessage = deps.backupNeeded();
    if (backupMessage) {
      step("prepare", "working", backupMessage);
      // A large setup takes minutes: the step shows how far it is, so a long backup visibly moves.
      let shown = -1;
      const saved = await deps.backup((fraction) => {
        const pct = Math.floor(fraction * 100);
        if (pct !== shown) deps.setStep("prepare", "working", `${backupMessage} ${pct}%`);
        shown = pct;
      });
      if (!saved.ok) return fail("prepare", `The backup before this version's first start failed: ${saved.error}. Chief wasn't started, so nothing changed.`);
    }
    deps.recordStart();
    step("prepare", "done");

    // Chief's gateway and the dashboard server start together; the window opens once both answer.
    const gateway = (async (): Promise<BootResult> => {
      step("gateway", "working");
      const claim = await deps.claimGateway();
      if (claim === "quit") return "quit";
      if (claim === "own") await deps.startGateway();
      const up = await deps.gatewayUp(claim === "external");
      if (!up.ok) return fail("gateway", deps.gatewayDetail() || up.detail || "Chief didn't start.");
      step("gateway", "done", up.voice ? "" : "Voice isn't available yet; text chat works.");
      return "ready";
    })();
    const web = (async (): Promise<BootResult> => {
      step("web", "working");
      const r = await deps.startWeb();
      if (!r.ok) return fail("web", r.detail || "The dashboard didn't start.");
      step("web", "done");
      return "ready";
    })();
    const [g, w] = await Promise.all([gateway, web]);
    if (g === "quit") {
      deps.quit();
      return "quit";
    }
    if (g !== "ready" || w !== "ready") return "error";
    await deps.openDashboard();
    deps.log("boot.ready", { ms: deps.now() - started });
    return "ready";
  }

  return {
    /** Start (or retry). A call while a boot is running returns that boot. */
    run(): Promise<BootResult> {
      if (!running) {
        running = sequence()
          .catch((e): BootResult => {
            const message = e instanceof Error ? e.message : String(e);
            deps.log("boot.unhandled", { step: current, error: message });
            deps.setStep(current, "error", message);
            return "error";
          })
          .finally(() => {
            running = null;
          });
      }
      return running;
    },
    get running() {
      return running !== null;
    },
  };
}
