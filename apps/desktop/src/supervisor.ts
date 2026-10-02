/**
 * Keeps one child process running (PLAN §4 "Crash recovery"): an unexpected exit restarts it after 1 s, 5 s,
 * then 30 s; more than 5 restarts in 10 minutes reports `failed`, and from there it tries again every 10 minutes
 * (or at once on Retry). An exit the app asked for (Quit, a restore) is never restarted.
 *
 * While running, an optional health probe runs every 30 s; three failures in a row end the child and count as a
 * crash (a gateway that is up but no longer answers). Pure logic with an injected clock and timers, so the state
 * machine is tested without processes (tests/shell.test.ts).
 */
export type SupervisorState = "stopped" | "starting" | "running" | "backoff" | "failed" | "stopping";

export type SupervisorEvent =
  | { type: "state"; state: SupervisorState; detail?: string }
  | { type: "restart-scheduled"; inMs: number; attempt: number }
  | { type: "retry-scheduled"; inMs: number }
  | { type: "unhealthy"; failures: number };

export type ChildHandle = { pid?: number; stop: (graceful: boolean) => Promise<void> };

export type SupervisorDeps = {
  launch: () => Promise<ChildHandle>;
  /** Resolves once the child is usable (e.g. /health answers); rejects when it never becomes ready. */
  ready: (child: ChildHandle) => Promise<void>;
  /** While running: does the child still answer? Omitted, nothing is probed. */
  health?: (child: ChildHandle) => Promise<boolean>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onEvent?: (event: SupervisorEvent) => void;
};

export const BACKOFF_MS = [1_000, 5_000, 30_000];
export const WINDOW_MS = 10 * 60_000;
export const MAX_RESTARTS = 5;
export const HEALTH_EVERY_MS = 30_000;
export const HEALTH_FAILURES = 3;
export const FAILED_RETRY_MS = 10 * 60_000;

export class Supervisor {
  state: SupervisorState = "stopped";
  detail = "";
  child: ChildHandle | null = null;
  /** When the next automatic attempt is due (backoff or the slow retry), for the page's banner; 0 when none. */
  nextAttemptAt = 0;
  private restarts: number[] = [];
  private timer: unknown = null;
  private healthTimer: unknown = null;
  private healthFailures = 0;
  private wanted = false;
  private generation = 0;
  private starting: Promise<void> | null = null;
  /** Children this supervisor ended itself: their exit is expected, never a crash. */
  private ended = new Set<number>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: SupervisorDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  private set(state: SupervisorState, detail = "") {
    this.state = state;
    this.detail = detail;
    this.deps.onEvent?.({ type: "state", state, detail });
  }

  private clearTimers() {
    if (this.timer) this.clearTimer(this.timer);
    if (this.healthTimer) this.clearTimer(this.healthTimer);
    this.timer = null;
    this.healthTimer = null;
    this.nextAttemptAt = 0;
  }

  /**
   * Start (or, from `failed` or a pending restart, retry at once). Resets the crash-loop window. Calling it while
   * a start is under way, or while running, changes nothing (boot and Retry can both ask).
   */
  async start(): Promise<void> {
    if (this.wanted && this.starting) return this.starting;
    if (this.wanted && this.state === "running") return;
    this.wanted = true;
    this.restarts = [];
    this.clearTimers();
    await this.launchOnce();
  }

  private launchOnce(): Promise<void> {
    const run = this.launch();
    this.starting = run;
    void run.finally(() => {
      if (this.starting === run) this.starting = null;
    });
    return run;
  }

  private async launch(): Promise<void> {
    const generation = ++this.generation;
    this.nextAttemptAt = 0;
    this.set("starting");
    let child: ChildHandle;
    try {
      child = await this.deps.launch();
    } catch (e) {
      if (generation !== this.generation) return;
      this.crashed(e instanceof Error ? e.message : "It couldn't start.");
      return;
    }
    if (generation !== this.generation || !this.wanted) {
      await this.end(child, true);
      return;
    }
    this.child = child;
    try {
      await this.deps.ready(child);
    } catch (e) {
      if (generation !== this.generation) return;
      this.child = null;
      await this.end(child, false);
      this.crashed(e instanceof Error ? e.message : "It didn't become ready.");
      return;
    }
    if (generation === this.generation && this.wanted) {
      this.set("running");
      this.healthFailures = 0;
      this.scheduleHealth(generation);
    }
  }

  /** End a child on purpose; its exit is then not a crash. */
  private async end(child: ChildHandle, graceful: boolean) {
    if (child.pid !== undefined) this.ended.add(child.pid);
    await child.stop(graceful).catch(() => undefined);
  }

  private scheduleHealth(generation: number) {
    if (!this.deps.health) return;
    this.healthTimer = this.setTimer(() => {
      this.healthTimer = null;
      void this.probe(generation);
    }, HEALTH_EVERY_MS);
  }

  private async probe(generation: number) {
    const child = this.child;
    if (!child || generation !== this.generation || this.state !== "running") return;
    const ok = await this.deps.health!(child).catch(() => false);
    if (generation !== this.generation || this.state !== "running") return;
    if (ok) {
      this.healthFailures = 0;
      this.scheduleHealth(generation);
      return;
    }
    this.healthFailures += 1;
    this.deps.onEvent?.({ type: "unhealthy", failures: this.healthFailures });
    if (this.healthFailures < HEALTH_FAILURES) {
      this.scheduleHealth(generation);
      return;
    }
    this.generation++;
    this.child = null;
    await this.end(child, false);
    this.crashed("It stopped answering.");
  }

  /** The child exited. Expected exits (stop, or a child this supervisor ended) are ignored; others restart with backoff. */
  exited(code: number | null, pid?: number): void {
    if (pid !== undefined && this.ended.delete(pid)) return;
    if (pid !== undefined && this.child?.pid !== undefined && pid !== this.child.pid) return; // a stale child
    if (!this.child && this.state !== "running" && this.state !== "starting") return; // nothing of ours was running
    this.child = null;
    if (!this.wanted || this.state === "stopping" || this.state === "stopped") return;
    this.generation++;
    if (this.healthTimer) this.clearTimer(this.healthTimer);
    this.healthTimer = null;
    this.crashed(code === null ? "It stopped unexpectedly." : `It exited (code ${code}).`);
  }

  private crashed(detail: string) {
    const now = this.now();
    this.restarts = this.restarts.filter((t) => now - t < WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.set("failed", detail);
      // Keep trying, slowly: a PC waking from sleep or a network drive coming back can fix what failed.
      this.nextAttemptAt = now + FAILED_RETRY_MS;
      this.deps.onEvent?.({ type: "retry-scheduled", inMs: FAILED_RETRY_MS });
      this.timer = this.setTimer(() => {
        this.timer = null;
        if (!this.wanted) return;
        this.restarts = [];
        void this.launchOnce();
      }, FAILED_RETRY_MS);
      return;
    }
    const attempt = this.restarts.length;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    this.restarts.push(now);
    this.nextAttemptAt = now + delay;
    this.set("backoff", detail);
    this.deps.onEvent?.({ type: "restart-scheduled", inMs: delay, attempt: attempt + 1 });
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.wanted) void this.launchOnce();
    }, delay);
  }

  /** Stop on purpose (Quit, restore). `graceful` asks the child to finish first. */
  async stop(graceful = true): Promise<void> {
    this.wanted = false;
    this.generation++;
    this.clearTimers();
    const child = this.child;
    this.child = null;
    if (!child) {
      this.set("stopped");
      return;
    }
    this.set("stopping");
    try {
      await this.end(child, graceful);
    } finally {
      this.set("stopped");
    }
  }
}
