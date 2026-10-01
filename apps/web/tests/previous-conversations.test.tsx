import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/lib/bridge", () => ({
  fetchPreviousConversation: vi.fn(async () => ({
    messages: [
      { id: 1, role: "user", content: "Plan the Lisbon trip", timestamp: "2026-09-20T10:00:00Z" },
      { id: 2, role: "assistant", content: "Here is a first plan.", timestamp: "2026-09-20T10:01:00Z" },
    ],
  })),
}));

import { PreviousConversations } from "@/components/chat/previous-conversations";
import { fetchPreviousConversation } from "@/lib/bridge";

const items = [1, 2, 3].map((n) => ({ id: `s${n}`, title: `Talk ${n}`, started: 1_790_000_000 + n, ended: 1_790_000_100 + n, messages: n }));

afterEach(cleanup);

it("lists a thread's earlier conversations, two at first, and opens one read-only", async () => {
  render(<PreviousConversations items={items} chief={undefined} phone={false} />);
  expect(screen.getByText("Earlier in this thread")).toBeInTheDocument();
  expect(screen.queryByText("Talk 3")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show all 3" }));
  expect(screen.getByText("Talk 3")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Talk 1/ }));
  expect(fetchPreviousConversation).toHaveBeenCalledWith("s1");
  expect(await screen.findByText("Here is a first plan.")).toBeInTheDocument();
  expect(screen.getByText(/read only/)).toBeInTheDocument();
});

it("shows nothing when there is no history", () => {
  const { container } = render(<PreviousConversations items={[]} chief={undefined} phone={false} />);
  expect(container).toBeEmptyDOMElement();
});
