import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ChiefChat } from "@/components/chief-chat";
import { setChatThread } from "@/lib/chat-thread";

/* Review C1: a message goes to the thread it was written in, whatever is open by the time it goes. */

const api = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@blobatar/react/gaze", () => ({ useGaze: () => ({ ref: null, lookAt: () => {} }) }));
vi.mock("@/lib/dashboard-prefs", () => ({ VOICE_EVENT: "voice", fullPhotosOn: () => true, useDashboardPrefs: () => ({ fontPx: 16, speakOn: false, compactChat: false }) }));
vi.mock("@/lib/bridge", () => ({
  fetchTranscript: async () => ({ sessionKey: "s", lastId: 0, messages: [], generating: false }),
  fetchVoiceConfig: async () => ({ ok: true }),
  sendToChief: api.send,
  resolveApproval: vi.fn(),
}));
vi.mock("@/components/bot-face", () => ({ BotFace: () => null, FaceRing: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/emoji-picker", () => ({ EmojiPicker: () => null }));
vi.mock("@/components/mic-button", () => ({ MicButton: () => null }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: unknown }) => children }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  setChatThread("main");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const A = "t-aaaa1111";
const B = "t-bbbb2222";
const chat = (connected: boolean) => <ChiefChat chief={undefined} lookAtEl={null} connected={connected} compact />;
/** The chat as the shell mounts it: once per thread, with that thread current (command-shell.tsx keys it). */
function openThread(thread: string, connected: boolean) {
  setChatThread(thread);
  return render(chat(connected));
}
const attach = (name: string) =>
  fireEvent.change(document.querySelector("input[type=file]") as HTMLInputElement, { target: { files: [new File(["hello"], name, { type: "text/plain" })] } });

it("a message queued in one thread goes to that thread after a switch, and shows only there", async () => {
  api.send.mockResolvedValue({ ok: true });
  const first = openThread(A, false);
  fireEvent.change(screen.getByRole("textbox", { name: "Nova is offline. Messages wait and go when they're back." }), { target: { value: "for thread A" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue for Nova" }));
  expect(await screen.findByText("Queued · sends when Nova is back")).toBeInTheDocument();
  first.unmount();

  const second = openThread(B, false);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText("for thread A")).toBeNull();
  // Back online while thread B is open: it goes to thread A, by name, and still doesn't show here.
  second.rerender(chat(true));
  await waitFor(() => expect(api.send).toHaveBeenCalledWith("for thread A", [], expect.any(String), A));
  await waitFor(() => expect(localStorage.getItem("chief-outbox")).toBeNull());
  expect(screen.queryByText("for thread A")).toBeNull();
});

it("a message waiting behind a slow upload goes to the thread it was written in", async () => {
  let finish!: (v: { ok: boolean }) => void;
  api.send.mockImplementationOnce(() => new Promise((r) => (finish = r))).mockResolvedValue({ ok: true });
  const first = openThread(A, true);
  const input = screen.getByRole("textbox", { name: "Message Nova" });
  attach("plans.txt");
  expect(await screen.findByLabelText("Remove plans.txt")).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "with the plans" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
  fireEvent.change(input, { target: { value: "and one more thing" } });
  fireEvent.submit(input.closest("form")!);
  // The owner opens another thread while the upload is still going.
  first.unmount();
  openThread(B, true);
  finish({ ok: true });
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
  expect(api.send.mock.calls.map((c) => [c[0], c[3]])).toEqual([
    ["with the plans", A],
    ["and one more thing", A],
  ]);
});

it("an upload that timed out twice waits for Retry or Cancel instead of trying every 15 s", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const late = () => Object.assign(new Error("That took too long. Check whether it finished before trying again."), { status: 408 });
  api.send.mockRejectedValueOnce(late()).mockRejectedValueOnce(late()).mockResolvedValue({ ok: true });
  openThread("main", true);
  const input = screen.getByRole("textbox", { name: "Message Nova" });
  attach("scan.txt");
  expect(await screen.findByLabelText("Remove scan.txt")).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "the scan" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText(/Couldn't reach Nova · retrying/)).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(16_000);
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/The upload timed out twice/)).toBeInTheDocument();
  // Held: nothing more on its own, however long it waits.
  await vi.advanceTimersByTimeAsync(120_000);
  expect(api.send).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(3));
  // The same message each time, under the same id, so the bridge drops a repeat.
  expect(new Set(api.send.mock.calls.map((c) => c[2])).size).toBe(1);
  await waitFor(() => expect(screen.queryByText(/The upload timed out twice/)).toBeNull());
});

it("a message without files keeps retrying after timeouts (nothing big to send again)", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const late = () => Object.assign(new Error("That took too long."), { status: 408 });
  api.send.mockRejectedValueOnce(late()).mockRejectedValueOnce(late()).mockResolvedValue({ ok: true });
  openThread("main", true);
  const input = screen.getByRole("textbox", { name: "Message Nova" });
  fireEvent.change(input, { target: { value: "just words" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText(/Couldn't reach Nova · retrying/)).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(16_000);
  await vi.advanceTimersByTimeAsync(16_000);
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(3));
  expect(screen.queryByText(/The upload timed out twice/)).toBeNull();
});

it("a file added to the box makes one preview, even when React runs its updates twice", async () => {
  const made = vi.spyOn(URL, "createObjectURL");
  setChatThread("main");
  render(<StrictMode>{chat(true)}</StrictMode>);
  attach("notes.txt");
  expect(await screen.findByLabelText("Remove notes.txt")).toBeInTheDocument();
  expect(made).toHaveBeenCalledTimes(1);
});
