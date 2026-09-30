/**
 * When the chat follows new messages (PLAN-2026-09-23 §3). Pure state so it can be tested without a DOM.
 *
 * - Pinned means "keep the newest message in view". Only an upward scroll you make unpins it; the app
 *   only ever scrolls down, and content growing (images, the thinking row) never moves scrollTop up.
 * - While unpinned, your touches, wheel turns and the scrolls they cause count as activity. After
 *   IDLE_MS of none, a new message from Chief brings you back down (and pins again).
 * - Your own sends always scroll down.
 */
export const NEAR_PX = 120;
export const IDLE_MS = 8_000;
/** A scroll this soon after a gesture is yours (touch momentum keeps producing scroll events). */
const GESTURE_MS = 1_500;

export type FollowReason = "mine" | "incoming" | "grow" | "shown";

export class StickState {
  pinned = true;
  private lastTop = 0;
  private lastGestureAt = -Infinity;
  private lastActivityAt = -Infinity;

  gesture(now: number) {
    this.lastGestureAt = now;
    this.lastActivityAt = now;
  }

  scroll(top: number, scrollHeight: number, clientHeight: number, now: number) {
    const near = scrollHeight - top - clientHeight < NEAR_PX;
    const movedUp = top < this.lastTop - 2;
    this.lastTop = top;
    if (near) {
      this.pinned = true;
      return;
    }
    const yours = now - this.lastGestureAt < GESTURE_MS;
    if (movedUp && yours) this.pinned = false;
    // Reading: every scroll while unpinned (including momentum) keeps the idle clock fresh.
    if (!this.pinned) this.lastActivityAt = now;
  }

  idle(now: number) {
    return now - this.lastActivityAt >= IDLE_MS;
  }

  /** Should this change bring the newest message into view? Following re-pins. */
  follow(reason: FollowReason, now: number): boolean {
    let go: boolean;
    if (reason === "mine") go = true;
    else if (reason === "grow") go = this.pinned;
    else go = this.pinned || this.idle(now);
    if (go) this.pinned = true;
    return go;
  }

  /** Where the last scroll event left us (used after a programmatic jump). */
  at(top: number) {
    this.lastTop = top;
  }
}
