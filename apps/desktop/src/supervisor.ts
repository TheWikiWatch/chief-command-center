/**
 * Keeps one child process running (PLAN §4 "Crash recovery"): an unexpected exit restarts it after 1 s, 5 s,
 * then 30 s; more than 5 restarts in 10 minutes stops trying and reports `failed` until Retry. An exit the
 * app asked for (Quit, a restore) is never restarted. Pure logic with an injected clock and timers, so the
 * state machine is tested without processes (tests/supervisor.test.ts).
 */
export type SupervisorState = "stopped" | "starting" | "running" | "backoff" | "failed" | "stopping";

export type SupervisorEvent =
  | { type: "state"; state: SupervisorState; detail?: string }
  | { type: "restart-scheduled"; inMs: number; attempt: number };

export type ChildHandle = { pid?: number; stop: (graceful: boolean) => Promise<void> };

export type SupervisorDeps = {
  launch: () => Promise<ChildHandle>;
  /** Resolves once the child is usable (e.g. /health answers); rejects when it never becomes ready. */
  ready: (child: ChildHandle) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onEvent?: (event: SupervisorEvent) => void;
};

export const BACKOFF_MS = [1_000, 5_000, 30_000];
export const WINDOW_MS = 10 * 60_000;
export const MAX_RESTARTS = 5;

export class Supervisor {
  state: SupervisorState = "stopped";
  detail = "";
  child: ChildHandle | null = null;
  private restarts: number[] = [];
  private timer: unknown = null;
  private wanted = false;
  private generation = 0;
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

  /** Start (or, from `failed`, retry). Resets the crash-loop window. */
  async start(): Promise<void> {
    this.wanted = true;
    this.restarts = [];
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    await this.launchOnce();
  }

  private async launchOnce(): Promise<void> {
    const generation = ++this.generation;
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
      await child.stop(true).catch(() => undefined);
      return;
    }
    this.child = child;
    try {
      await this.deps.ready(child);
    } catch (e) {
      if (generation !== this.generation) return;
      await child.stop(false).catch(() => undefined);
      this.child = null;
      this.crashed(e instanceof Error ? e.message : "It didn't become ready.");
      return;
    }
    if (generation === this.generation && this.wanted) this.set("running");
  }

  /** The child exited. Expected exits (stop) are ignored; others restart with backoff. */
  exited(code: number | null, pid?: number): void {
    if (pid !== undefined && this.child?.pid !== undefined && pid !== this.child.pid) return; // a stale child
    this.child = null;
    if (!this.wanted || this.state === "stopping" || this.state === "stopped") return;
    this.generation++;
    this.crashed(code === null ? "It stopped unexpectedly." : `It exited (code ${code}).`);
  }

  private crashed(detail: string) {
    const now = this.now();
    this.restarts = this.restarts.filter((t) => now - t < WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.set("failed", detail);
      return;
    }
    const attempt = this.restarts.length;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    this.restarts.push(now);
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
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    if (!child) {
      this.set("stopped");
      return;
    }
    this.set("stopping");
    try {
      await child.stop(graceful);
    } finally {
      this.set("stopped");
    }
  }
}
