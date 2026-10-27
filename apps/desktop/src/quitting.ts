/**
 * Quitting the app, as a sequence over injected dependencies (tested in tests/quitting.test.ts without Electron).
 *
 * - One quit at a time: a second Quit (the tray again, an installer's `--quit`) joins the one under way instead of
 *   asking again in a second dialog.
 * - "Wait for Chief" shows a screen that says so, with "Quit now" and "Keep running", instead of nothing at all.
 * - Every way out ends in the same shutdown (Quit, Windows signing out, an update handing over, the start screen's
 *   "Quit"): the notifier stops, phone access is paused so it doesn't point at a dead port, the dashboard server and
 *   Chief stop, then the app exits. Once.
 * - A launch while the app is closing isn't lost: the app opens again once it has closed.
 */
export type Work = { busy: boolean; reasons: string[] };

export type QuitDeps = {
  /** What Chief is in the middle of (the bridge's snapshot); not busy when it can't be asked. */
  work: () => Promise<Work>;
  /** Another launcher runs Chief: nothing here waits for it or stops it. */
  external: () => boolean;
  /** The "Chief is busy" question. */
  ask: (reasons: string[]) => Promise<"wait" | "quit" | "cancel">;
  /** The window, shown, says it waits for Chief (with "Quit now" and "Keep running"). */
  showWaiting: (reasons: string[]) => Promise<void>;
  /** "Keep running": the dashboard again. */
  reopen: () => Promise<void>;
  /** From the first moment of the shutdown: the tray and the rest of the app know the app is closing. */
  closing: () => void;
  /** Past a second of stopping, the window says it is closing instead of hanging. */
  showClosing: () => void;
  hide: () => void;
  stopNotifier: () => void;
  pauseServe: () => Promise<void>;
  stopWeb: () => Promise<void>;
  stopGateway: () => Promise<void>;
  relaunch: (args: string[]) => void;
  exit: () => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long a wait lasts before the question comes back (10 minutes), and how often it looks. */
  waitMs?: number;
  pollMs?: number;
  feedbackMs?: number;
};

export type WaitChoice = "quit" | "stay";

export function createQuitter(deps: QuitDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let asking: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let answer: ((choice: WaitChoice) => void) | null = null;
  let relaunchArgs: string[] | null = null;

  /** Until Chief is done, the owner presses a button, or the wait runs out ("done" then asks again). */
  async function waitForChief(reasons: string[]): Promise<"done" | WaitChoice> {
    await deps.showWaiting(reasons);
    let settled = false;
    const chosen = new Promise<WaitChoice>((resolve) => (answer = resolve));
    const finished = (async (): Promise<"done"> => {
      const until = now() + (deps.waitMs ?? 10 * 60_000);
      while (!settled && now() < until) {
        await sleep(deps.pollMs ?? 2000);
        if (!settled && !(await deps.work()).busy) break;
      }
      return "done";
    })();
    const result = await Promise.race([chosen, finished]);
    settled = true;
    answer = null;
    return result;
  }

  async function askThenShutdown(): Promise<void> {
    if (!deps.external()) {
      let work = await deps.work();
      while (work.busy) {
        const choice = await deps.ask(work.reasons);
        if (choice === "cancel") return;
        if (choice === "quit") break;
        const waited = await waitForChief(work.reasons);
        if (waited === "stay") {
          deps.log("app.quit-cancelled");
          await deps.reopen();
          return;
        }
        if (waited === "quit") break;
        work = await deps.work();
      }
    }
    await shutdown();
  }

  function shutdown(opts: { hide?: boolean } = {}): Promise<void> {
    stopping ??= (async () => {
      deps.log("app.quit");
      deps.closing();
      answer?.("quit");
      if (opts.hide) deps.hide();
      const feedback = opts.hide ? null : setTimeout(deps.showClosing, deps.feedbackMs ?? 1000);
      try {
        deps.stopNotifier();
        await deps.pauseServe().catch(() => undefined);
        await deps.stopWeb().catch(() => undefined);
        if (!deps.external()) await deps.stopGateway().catch(() => undefined);
      } finally {
        if (feedback) clearTimeout(feedback);
        if (relaunchArgs) {
          deps.log("app.relaunch");
          deps.relaunch(relaunchArgs);
        }
        deps.exit();
      }
    })();
    return stopping;
  }

  return {
    /** Quit as the owner asked: about work in progress first, then the shutdown. */
    quit(): Promise<void> {
      if (stopping) return stopping;
      asking ??= askThenShutdown().finally(() => {
        asking = null;
      });
      return asking;
    },
    shutdown,
    /** The waiting screen's buttons. */
    answer(choice: WaitChoice) {
      answer?.(choice);
    },
    /** A launch that arrived while closing: these arguments open the app again once it has exited. */
    relaunchAfter(args: string[]) {
      relaunchArgs = args;
    },
    get closing() {
      return stopping !== null;
    },
    get relaunching() {
      return relaunchArgs !== null;
    },
  };
}
