import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AskedRow, NoticeBody, QuestionCard, choiceLabel } from "@/components/chat/question";
import { Thread, withNotices } from "@/components/chat/thread";
import { permittedOperation } from "@/lib/proxy-policy";
import type { ChatMessage, PendingQuestion } from "@/lib/types";

afterEach(cleanup);

const QUESTION: PendingQuestion = {
  id: "c1",
  question: "Which inbox should the email bot own?",
  choices: ["Gmail / Google Workspace (Recommended)", "Outlook / Microsoft 365"],
  multi: false,
};

it("a choice answers the question with its exact text; the recommended one is a badge, not part of the label", async () => {
  const onAnswer = vi.fn(async () => undefined);
  render(<QuestionCard question={QUESTION} chief={undefined} onAnswer={onAnswer} />);
  expect(screen.getByRole("heading", { name: QUESTION.question })).toBeInTheDocument();
  expect(screen.getByText("Recommended")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Outlook \/ Microsoft 365/ }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("c1", "Outlook / Microsoft 365"));
  expect(choiceLabel("Gmail (Recommended)")).toEqual({ text: "Gmail", recommended: true });
});

it("'Something else' answers in your own words", async () => {
  const onAnswer = vi.fn(async () => undefined);
  render(<QuestionCard question={QUESTION} chief={undefined} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByRole("button", { name: "Something else…" }));
  fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "My work Fastmail" } });
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("c1", "My work Fastmail"));
});

it("multi-select sends the picked choices together", async () => {
  const onAnswer = vi.fn(async () => undefined);
  render(<QuestionCard question={{ id: "c2", question: "Which days?", choices: ["Mon", "Tue", "Wed"], multi: true }} chief={undefined} onAnswer={onAnswer} />);
  expect(screen.getByRole("button", { name: "Pick at least one" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Mon" }));
  fireEvent.click(screen.getByRole("button", { name: "Wed" }));
  expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Send 2 choices" }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("c2", ["Mon", "Wed"]));
});

it("an open-ended question shows a text box straight away, and a failed answer says why", async () => {
  const onAnswer = vi.fn(async () => {
    throw new Error("That question is no longer open.");
  });
  render(<QuestionCard question={{ id: "c3", question: "Anything else?", choices: [], multi: false }} chief={undefined} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "no" } });
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("That question is no longer open.");
});

it("past questions show the answer given, or that none was", () => {
  render(<AskedRow items={[{ question: "Which inbox?", choices: ["Gmail"], answer: "Gmail (Recommended)" }, { question: "Days?", choices: [], answer: "" }]} />);
  expect(screen.getByText("Gmail")).toBeInTheDocument();
  expect(screen.getByText("No answer")).toBeInTheDocument();
});

it("notices sit among messages by time and are labelled", () => {
  const messages: ChatMessage[] = [
    { id: 1, role: "user", content: "hi", timestamp: "100" },
    { id: 2, role: "assistant", content: "hello", timestamp: "200" },
  ];
  const merged = withNotices(messages, [
    { id: "a", at: 150, text: "Morning brief", source: "scheduled" },
    { id: "b", at: 300, text: "Later", source: "notice" },
  ]);
  expect(merged.map((m) => m.notice?.id ?? m.id)).toEqual([1, "a", 2, "b"]);
  render(<NoticeBody notice={{ id: "a", at: 150, text: "Morning brief", source: "scheduled" }} />);
  expect(screen.getByText("Scheduled job")).toBeInTheDocument();
});

it("the thread shows the open question in place of 'thinking', and the current step otherwise", async () => {
  const base = { messages: [{ id: 1, role: "user", content: "hi", timestamp: "100" }] as ChatMessage[], chief: undefined, waitingApproval: false, connected: true, onSuggestion: () => {} };
  const { rerender } = render(<Thread {...base} awaiting activity={{ since: Date.now() / 1000, steps: 2, label: "Checking the team" }} />);
  expect(screen.getByText("Checking the team…")).toBeInTheDocument();
  rerender(<Thread {...base} awaiting question={QUESTION} onAnswer={async () => undefined} />);
  await waitFor(() => expect(screen.queryByText(/Checking the team/)).toBeNull());
  expect(screen.getByRole("heading", { name: QUESTION.question })).toBeInTheDocument();
});

it("the proxy forwards answers", () => {
  expect(permittedOperation("bridge", "POST", ["clarify"])).toBe(true);
  expect(permittedOperation("bridge", "GET", ["clarify"])).toBe(false);
});

const CONFIRM_NEW = "⚠️ **Confirm /new**\n\nThis starts a fresh session.\n\n_Text fallback: reply `/approve`, `/always`, or `/cancel`._";

it("a gateway prompt's text fallback becomes buttons that send the command", async () => {
  const { quickReplies } = await import("@/components/chat/question");
  expect(quickReplies(CONFIRM_NEW)).toEqual(["/approve", "/always", "/cancel"]);
  expect(quickReplies("Morning brief: 3 tasks due")).toEqual([]);
  const send = vi.fn(async () => undefined);
  render(<NoticeBody notice={{ id: "n", at: 1, text: CONFIRM_NEW, source: "notice" }} onQuickReply={send} />);
  fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("/approve"));
  expect(screen.getByRole("button", { name: "Always approve" })).toBeDisabled();
});

it("only the newest notice offers its buttons", () => {
  const send = vi.fn(async () => undefined);
  const base = { chief: undefined, awaiting: false, waitingApproval: false, connected: true, onSuggestion: () => {}, onQuickReply: send };
  const older = { id: "a", at: 100, text: CONFIRM_NEW, source: "notice" as const };
  const { rerender } = render(<Thread {...base} messages={[{ id: 1, role: "user", content: "hi", timestamp: "50" }]} notices={[older]} />);
  expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
  rerender(<Thread {...base} messages={[{ id: 1, role: "user", content: "hi", timestamp: "50" }, { id: 2, role: "assistant", content: "Fresh start.", timestamp: "200" }]} notices={[older]} />);
  expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
});
