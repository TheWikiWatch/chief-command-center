import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { FollowupCards, followupAsk, noteFinishedJob, useFollowupWatch } from "@/components/chat/followup-cards";
import { detectPromise, followedUp, readFollowups, type Followup } from "@/lib/followups";
import type { ChatMessage, Person } from "@/lib/types";

vi.mock("@/components/bot-face", () => ({ BotFace: () => null, faceProps: () => ({}) }));
vi.mock("@/lib/fx", () => ({ fx: vi.fn() }));

const msg = (id: number, role: ChatMessage["role"], content: string): ChatMessage => ({ id, role, content, timestamp: "2026-09-23T09:00:00Z" });
const ada = { id: "ada", name: "Ada - Coding Projects Lead", isChief: false } as Person;
const finished = (extra: Partial<Followup> = {}): Followup => ({
  id: "finished:ada:Print studio",
  kind: "finished",
  who: "Ada",
  whoId: "ada",
  title: "Print studio",
  createdAt: 0,
  dueAt: 0,
  afterId: 10,
  shown: false,
  ...extra,
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("spots Nova's check-back promises and quotes the sentence", () => {
  expect(detectPromise("Card is on the board. I'll check back once Ada lands it. Anything else?")).toBe("I'll check back once Ada lands it.");
  expect(detectPromise("Let me follow up with Iris after lunch")).toBe("Let me follow up with Iris after lunch");
  expect(detectPromise("I will let you know when the build is green.")).toBe("I will let you know when the build is green.");
  expect(detectPromise("You can check back later if you like.")).toBeNull();
  expect(detectPromise("Done — all three steps verified.")).toBeNull();
});

it("counts a kanban note plus a reply, or a reply naming the bot, as a follow-up", () => {
  expect(followedUp(finished(), [msg(11, "user", "[kanban] Task t_1 completed."), msg(12, "assistant", "Verified.")])).toBe(true);
  expect(followedUp(finished(), [msg(12, "assistant", "Ada's card checks out.")])).toBe(true);
  expect(followedUp(finished(), [msg(12, "assistant", "Here's the ANOC summary.")])).toBe(false);
  expect(followedUp(finished(), [msg(9, "assistant", "Ada is on it.")])).toBe(false);
  expect(followedUp(finished({ afterId: null }), [msg(12, "assistant", "Ada done.")])).toBe(false);
  expect(followedUp(finished({ kind: "promise" }), [msg(12, "assistant", "Update: all green.")])).toBe(true);
});

it("waits 3 minutes after a job finishes, then shows the card unless Nova followed up", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const history = [msg(10, "assistant", "Ada's card t_1 is on the board.")];
  const { result, rerender } = renderHook(({ m, busy }) => useFollowupWatch(m, { primed: true, busy }), {
    initialProps: { m: history, busy: false },
  });
  act(() => noteFinishedJob(ada, "Print studio", "Ada"));
  expect(readFollowups()[0].afterId).toBe(10);
  act(() => vi.advanceTimersByTime(2 * 60_000));
  expect(result.current).toEqual([]);
  // Nova is mid-turn at the deadline: stay quiet.
  rerender({ m: history, busy: true });
  act(() => vi.advanceTimersByTime(90_000));
  expect(result.current).toEqual([]);
  rerender({ m: history, busy: false });
  act(() => vi.advanceTimersByTime(10_000));
  expect(result.current.map((f) => f.who)).toEqual(["Ada"]);
  // Nova finally mentions Ada: the card goes away.
  rerender({ m: [...history, msg(11, "assistant", "Ada finished; verifying now.")], busy: false });
  expect(result.current).toEqual([]);
});

it("starts a 20-minute reminder when a new reply promises to check back, never from history", () => {
  vi.useFakeTimers({ now: 5_000_000 });
  const history = [msg(1, "assistant", "I'll check back tomorrow.")];
  const { rerender } = renderHook(({ m }) => useFollowupWatch(m, { primed: true, busy: false }), { initialProps: { m: history } });
  expect(readFollowups()).toEqual([]);
  rerender({ m: [...history, msg(2, "assistant", "Card created. I'll report back when Iris is done.")] });
  const [item] = readFollowups();
  expect(item.kind).toBe("promise");
  expect(item.title).toBe("I'll report back when Iris is done.");
  expect(item.dueAt - Date.now()).toBe(20 * 60_000);
});

it("asks Nova from the card and clears it", async () => {
  const onAsk = vi.fn(async () => undefined);
  const item = finished({ shown: true });
  localStorage.setItem("chief-followups", JSON.stringify([item]));
  render(<FollowupCards items={[item]} people={[ada]} chief={undefined} disabled={false} onAsk={onAsk} />);
  expect(screen.getByText(/No word from Nova/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Ask Nova" }));
  expect(onAsk).toHaveBeenCalledWith(item);
  await waitFor(() => expect(readFollowups()).toEqual([]));
  expect(followupAsk(item)).toBe('Ada just finished "Print studio". Please review it and follow up with me.');
});
