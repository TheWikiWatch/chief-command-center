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
  // Rendering the whole chat can take several seconds when the full suite runs in parallel on a busy PC.
  await waitFor(() => expect(api.transcript).toHaveBeenCalledTimes(3), { timeout: 12_000 });
  expect(api.transcript.mock.calls[0].slice(0, 1)).toEqual([0]);
  expect(api.transcript.mock.calls[0][2]).toBeUndefined(); // the first load never waits
  expect(api.transcript.mock.calls[1][0]).toBe(50);
  expect(api.transcript.mock.calls[1][2]).toEqual({ wait: 25, gen: true, approval: "r1", clarify: "", notice: "" });
  expect(api.transcript.mock.calls[2][2]).toEqual({ wait: 25, gen: false, approval: "", clarify: "", notice: "" });
  expect(update.mock.calls.map((c) => c[0]?.requestId ?? null)).toEqual(["r1", null]);
}, 20_000);

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

it("shows the reply as it's written and asks the bridge to wake on the next frame", async () => {
  api.transcript
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 50, messages: rows(1, 50), generating: true, longpoll: true, draft: { id: 4, text: "Here is", at: 1 }, draftSig: "4:1" })
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 50, messages: [], generating: true, longpoll: true, draft: { id: 4, text: "Here is the plan", at: 2 }, draftSig: "4:2" })
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 51, messages: rows(51, 51), generating: false, longpoll: true, draft: null, draftSig: "" })
    .mockReturnValue(new Promise(() => {}));
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  expect(await screen.findByText("Here is the plan", {}, { timeout: 12_000 })).toBeInTheDocument();
  await waitFor(() => expect(api.transcript).toHaveBeenCalledTimes(4), { timeout: 12_000 });
  expect(api.transcript.mock.calls[1][2]).toMatchObject({ draft: "4:1" });
  expect(api.transcript.mock.calls[2][2]).toMatchObject({ draft: "4:2" });
  expect(await screen.findByText("reply 51")).toBeInTheDocument();
  expect(screen.queryByLabelText("Nova is writing")).toBeNull();
}, 20_000);

it("a draft is done with once its reply has landed, even while the turn is still ending", async () => {
  api.transcript
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 50, messages: rows(1, 50), generating: true, longpoll: true, draft: { id: 4, text: "Here is the plan", at: 1 }, draftSig: "4:1" })
    // The stored reply lands while generating is still true and the bridge still reports the draft.
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 51, messages: [{ id: 51, role: "assistant", content: "Here is the plan: one, two.", timestamp: "1790000001" }], generating: true, longpoll: true, draft: { id: 4, text: "Here is the plan: one, two.", at: 2 }, draftSig: "4:2" })
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 51, messages: [], generating: true, longpoll: true, draft: { id: 4, text: "Here is the plan: one, two.", at: 2 }, draftSig: "4:2" })
    .mockReturnValue(new Promise(() => {}));
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  expect(await screen.findByText("Here is the plan", {}, { timeout: 12_000 })).toBeInTheDocument();
  expect(await screen.findByText("Here is the plan: one, two.", {}, { timeout: 12_000 })).toBeInTheDocument();
  await waitFor(() => expect(api.transcript).toHaveBeenCalledTimes(4), { timeout: 12_000 });
  await waitFor(() => expect(screen.queryByLabelText("Nova is writing")).toBeNull());
  expect(screen.getAllByText("Here is the plan: one, two.")).toHaveLength(1);
}, 20_000);

it("a page Load earlier asked for before a reset never goes in front of the rewritten conversation", async () => {
  let page!: (v: unknown) => void;
  api.earlier.mockReturnValueOnce(new Promise((r) => (page = r)));
  api.transcript
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 150, messages: rows(101, 150), generating: false, longpoll: true })
    // Send again ran Hermes's /retry while the page was on its way: every row written again with new ids.
    .mockImplementationOnce(() => new Promise((r) => setTimeout(() => r({ sessionKey: "s", lastId: 250, messages: rows(201, 250), generating: false, longpoll: true, reset: true, more: true }), 300)))
    .mockReturnValue(new Promise(() => {}));
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  fireEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
  expect(await screen.findByText("reply 201", {}, { timeout: 6000 })).toBeInTheDocument();
  page({ sessionKey: "s", lastId: 41, messages: rows(41, 100), more: true, cursor: 41 });
  expect(await screen.findByRole("button", { name: "Load earlier" })).toBeEnabled();
  expect(screen.queryByText("reply 41")).toBeNull();
  expect(screen.queryByText("reply 101")).toBeNull();
}, 12_000);

it("rows Load earlier added stay while the owner reads them, and go once they're back at the newest", async () => {
  let deliver!: (v: unknown) => void;
  api.transcript
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 1600, messages: rows(1001, 1600), generating: false, longpoll: true, more: true })
    .mockReturnValueOnce(new Promise((r) => (deliver = r)))
    .mockResolvedValueOnce({ sessionKey: "s", lastId: 1602, messages: rows(1602, 1602), generating: false, longpoll: true })
    .mockReturnValue(new Promise(() => {}));
  api.earlier.mockResolvedValueOnce({ sessionKey: "s", lastId: 991, messages: rows(991, 1000), more: true, cursor: 991 });
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  fireEvent.click(await screen.findByRole("button", { name: "Load earlier" }, { timeout: 12_000 }));
  expect(await screen.findByText("reply 991")).toBeInTheDocument();
  // A reply lands while the owner is up there reading: the chat is past its limit, and keeps what was just loaded.
  deliver({ sessionKey: "s", lastId: 1601, messages: rows(1601, 1601), generating: false, longpoll: true });
  expect(await screen.findByText("reply 1601")).toBeInTheDocument();
  expect(screen.getByText("reply 991")).toBeInTheDocument();
  // Back at the newest (a scroll at the bottom): the next reply trims the oldest again.
  fireEvent.scroll(screen.getByText("reply 1601").closest(".overflow-y-auto")!);
  expect(await screen.findByText("reply 1602", {}, { timeout: 6000 })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText("reply 991")).toBeNull());
}, 20_000);
