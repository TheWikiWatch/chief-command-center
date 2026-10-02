import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ChiefChat } from "@/components/chief-chat";

const api = vi.hoisted(() => ({ transcript: vi.fn(), earlier: vi.fn() }));
vi.mock("@blobatar/react/gaze", () => ({ useGaze: () => ({ ref: null, lookAt: () => {} }) }));
vi.mock("@/lib/dashboard-prefs", () => ({ VOICE_EVENT: "voice", fullPhotosOn: () => true, useDashboardPrefs: () => ({ fontPx: 16, speakOn: false, compactChat: false }) }));
vi.mock("@/lib/bridge", () => ({
  fetchTranscript: api.transcript,
  fetchEarlier: api.earlier,
  fetchVoiceConfig: async () => ({ ok: true }),
  sendToChief: vi.fn(),
  resolveApproval: vi.fn(),
}));
vi.mock("@/components/bot-face", () => ({ BotFace: () => null, FaceRing: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/emoji-picker", () => ({ EmojiPicker: () => null }));
vi.mock("@/components/mic-button", () => ({ MicButton: () => null }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: unknown }) => children }));

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i, role: "assistant", content: `reply ${from + i}`, timestamp: "1790000000" }));
const approval = { requestId: "r1", command: "git push", reason: "", allowSession: true, allowPermanent: true };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(cleanup);

it("long-polls once the bridge can hold requests, with what the bridge last reported", async () => {
  const hold = new Promise(() => {}); // the third request stays open, like a real long-poll
  api.transcript
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 50, messages: rows(1, 50), generating: true, approval, longpoll: true })
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 51, messages: rows(51, 51), generating: false, approval: null, longpoll: true })
    .mockReturnValue(hold);
  const update = vi.fn();
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact onApprovalUpdate={update} />);
  // Rendering the whole chat can take over a second when the full suite runs in parallel.
  await waitFor(() => expect(api.transcript).toHaveBeenCalledTimes(3), { timeout: 5000 });
  expect(api.transcript.mock.calls[0].slice(0, 1)).toEqual([0]);
  expect(api.transcript.mock.calls[0][2]).toBeUndefined(); // the first load never waits
  expect(api.transcript.mock.calls[1][0]).toBe(50);
  expect(api.transcript.mock.calls[1][2]).toEqual({ wait: 25, gen: true, approval: "r1", clarify: "", notice: "" });
  expect(api.transcript.mock.calls[2][2]).toEqual({ wait: 25, gen: false, approval: "", clarify: "", notice: "" });
  expect(update.mock.calls.map((c) => c[0]?.requestId ?? null)).toEqual(["r1", null]);
});

it("Load earlier prepends older messages and says when the start is reached", async () => {
  api.transcript.mockResolvedValueOnce({ sessionKey: "s", lastId: 150, messages: rows(101, 150), generating: false }).mockReturnValue(new Promise(() => {}));
  api.earlier.mockResolvedValueOnce({ sessionKey: "s", lastId: 41, messages: rows(41, 100), more: true, cursor: 41 }).mockResolvedValueOnce({ sessionKey: "s", lastId: 1, messages: rows(1, 40), more: false, cursor: 1 });
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  fireEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
  expect(await screen.findByText("reply 41")).toBeInTheDocument();
  expect(api.earlier).toHaveBeenLastCalledWith(101);
  fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
  expect(await screen.findByText("Start of the conversation")).toBeInTheDocument();
  expect(api.earlier).toHaveBeenLastCalledWith(41);
  expect(screen.getByText("reply 1")).toBeInTheDocument();
});
