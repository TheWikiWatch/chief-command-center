import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const markdown = vi.hoisted(() => ({ renders: 0 }));
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: string }) => {
    markdown.renders += 1;
    return <div>{children}</div>;
  },
}));

import { Thread } from "@/components/chat/thread";
import type { ChatMessage } from "@/lib/types";

const reply = (id: number, content: string): ChatMessage => ({ id, role: "assistant", content, timestamp: "2026-09-23T20:00:00Z" });

it("renders only the new reply's markdown when a message arrives", () => {
  const first = [reply(1, "one"), reply(2, "two"), reply(3, "three")];
  const view = render(<Thread messages={first} chief={undefined} awaiting={false} waitingApproval={false} connected onSuggestion={() => undefined} />);
  expect(markdown.renders).toBe(3);
  // Same message objects plus one new one (what mergeMsgs produces).
  const next = [...first, reply(4, "four")];
  view.rerender(<Thread messages={next} chief={undefined} awaiting={false} waitingApproval={false} connected onSuggestion={() => undefined} />);
  // Row 3 stops being the last of its group, so its timestamp moves: it and the new row render.
  expect(markdown.renders).toBe(5);
  // Thinking chrome toggling re-renders the thread but none of its messages.
  view.rerender(<Thread messages={[...next]} chief={undefined} awaiting={true} waitingApproval={false} connected onSuggestion={() => undefined} />);
  expect(markdown.renders).toBe(5);
});

it("keeps notice rows (scheduled-job results) from re-rendering when a reply arrives", () => {
  markdown.renders = 0;
  const notices = [{ id: "n1", at: Date.parse("2026-09-23T19:00:00Z") / 1000, text: "Morning brief: three things today.", source: "scheduled" as const }];
  const first = [reply(1, "one")];
  const view = render(<Thread messages={first} notices={notices} chief={undefined} awaiting={false} waitingApproval={false} connected onSuggestion={() => undefined} />);
  const afterFirst = markdown.renders;
  // The same notice objects on the next update (what the chat keeps), plus a new reply.
  view.rerender(<Thread messages={[...first, reply(2, "two")]} notices={notices} chief={undefined} awaiting={false} waitingApproval={false} connected onSuggestion={() => undefined} />);
  // Only the new reply and the row it follows: the notice doesn't run its markdown again.
  expect(markdown.renders - afterFirst).toBe(2);
});

it("a draft frame renders the draft alone, and the stored reply then replaces it", async () => {
  markdown.renders = 0;
  const first = [reply(1, "one"), reply(2, "two")];
  const view = render(<Thread messages={first} chief={undefined} awaiting={true} waitingApproval={false} connected onSuggestion={() => undefined} draft={{ id: 9, text: "Here is", at: 1 }} />);
  const afterFirst = markdown.renders;
  expect(afterFirst).toBe(3);
  view.rerender(<Thread messages={first} chief={undefined} awaiting={true} waitingApproval={false} connected onSuggestion={() => undefined} draft={{ id: 9, text: "Here is the plan", at: 2 }} />);
  // Only the draft re-rendered its markdown.
  expect(markdown.renders - afterFirst).toBe(1);
  expect(view.getByLabelText("Nova is writing")).toHaveTextContent("Here is the plan");
  view.rerender(<Thread messages={[...first, reply(3, "Here is the plan: one, two.")]} chief={undefined} awaiting={false} waitingApproval={false} connected onSuggestion={() => undefined} draft={null} />);
  // The draft row leaves after its exit animation.
  await waitFor(() => expect(view.queryByLabelText("Nova is writing")).toBeNull());
  expect(view.getByText("Here is the plan: one, two.")).toBeInTheDocument();
});
