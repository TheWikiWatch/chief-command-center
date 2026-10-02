import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const speech = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/components/chat/use-reply-speech", async (orig) => ({ ...(await orig<object>()), readAloud: speech.read }));

import { Thread } from "@/components/chat/thread";
import { looksFailed, stepDuration, toolLabel } from "@/lib/tool-labels";
import type { ChatMessage } from "@/lib/types";

afterEach(() => cleanup());

describe("tool labels", () => {
  it("say what a step did in plain words, and keep unknown tools readable", () => {
    expect(toolLabel("terminal")).toBe("Ran a command");
    expect(toolLabel("web_search")).toBe("Searched the web");
    expect(toolLabel("browser_navigate")).toBe("Used the browser");
    expect(toolLabel("mcp__calendar__list_events")).toBe("List events");
  });
  it("spot failed output, and show durations from a second up", () => {
    expect(looksFailed('{"success": false, "error": "no such file"}')).toBe(true);
    expect(looksFailed('{"output": "ok", "exit_code": 2}')).toBe(true);
    expect(looksFailed("Traceback (most recent call last):\n  File")).toBe(true);
    expect(looksFailed('{"output": "the word error appears later", "exit_code": 0}')).toBe(false);
    expect(stepDuration(400)).toBe("");
    expect(stepDuration(4200)).toBe("4s");
    expect(stepDuration(65_000)).toBe("1m 05s");
  });
});

const at = (s: number) => new Date(Date.UTC(2026, 8, 23, 20, 0, s)).toISOString();
const tool = (id: number, name: string, content: string, s: number): ChatMessage => ({ id, role: "tool", content, tools: [name], timestamp: at(s) });
const reply = (id: number, content: string, s: number): ChatMessage => ({ id, role: "assistant", content, timestamp: at(s) });
const thread = (messages: ChatMessage[]) => render(<Thread messages={messages} chief={undefined} awaiting={false} waitingApproval={false} connected onSuggestion={() => undefined} />);

describe("the chat's tool timeline", () => {
  it("folds steps into one line, and opens to each step with its time; a failed step is flagged and open", () => {
    thread([tool(1, "terminal", '{"output": "done", "exit_code": 0}', 0), tool(2, "read_file", '{"success": false, "error": "missing"}', 4), reply(3, "All set.", 9)]);
    const toggle = screen.getByRole("button", { name: /2 steps/ });
    expect(toggle).toHaveTextContent("Ran a command · Read a file");
    expect(toggle).toHaveTextContent("1 failed");
    fireEvent.click(toggle);
    const steps = screen.getByRole("list", { name: "Tool steps" }).querySelectorAll("li");
    expect(steps[0]).toHaveTextContent("Ran a command");
    expect(steps[0]).toHaveTextContent("4s");
    expect(steps[1]).toHaveTextContent("missing");
  });

  it("a single tool step is a timeline too", () => {
    thread([tool(1, "web_search", "results", 0), reply(2, "Found it.", 3)]);
    expect(screen.getByRole("button", { name: /1 step/ })).toHaveTextContent("Searched the web");
  });

  it("offers Copy and Read aloud on the chief's replies", () => {
    thread([reply(1, "Here is the plan.", 0)]);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    expect(speech.read).toHaveBeenCalledWith("Here is the plan.");
    expect(screen.getByRole("button", { name: "Copy reply" })).toBeInTheDocument();
  });
});
