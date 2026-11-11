import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ApprovalSheet } from "@/components/chat/approval-sheet";
import { revealCommand } from "@/lib/command-display";
import { EXACT_MARK, mailAction } from "@/lib/mail-approval";
import type { ExecApproval } from "@/lib/types";

/* The approval sheet must never let what the bot wrote hide what will run (security review S7). */

afterEach(cleanup);

const exactly = (s: string) => `\n\n${EXACT_MARK}Exact call:\n${s}`;

const sheet = (approval: ExecApproval) =>
  render(<ApprovalSheet approval={approval} minimized={false} resolving={false} error="" onMinimize={() => {}} onExpand={() => {}} onChoose={() => {}} />);

it("a mail action shows its email and then the exact call that will run", () => {
  const call = 'python google_api.py gmail send --to boss@example.com --subject Weekly --body "See you"';
  sheet({
    requestId: "r1",
    command: "<terminal> (plugin approval rule)",
    reason: `Send an email\nTo: boss@example.com\nBcc: copy@example.com\nSubject: Weekly\n\nSee you${exactly(call)}`,
    patternKey: "plugin_rule:chief:mail-send",
    allowPermanent: true,
    allowSession: true,
  });
  expect(screen.getByText("Send this email?")).toBeTruthy();
  expect(screen.getByText("copy@example.com")).toBeTruthy(); // Bcc is shown, not dropped
  expect(screen.getByText("Exact call")).toBeTruthy();
  expect(screen.getByText(call)).toBeTruthy();
  expect(screen.getByRole("button", { name: /Always allow/ })).toBeTruthy();
});

it("a mail call the guard couldn't read exactly can't be always-allowed", () => {
  const call = "python google_api.py gmail send --to a@example.com --to attacker@example.com --subject s --body b";
  const approval = {
    requestId: "r2",
    command: "<terminal> (plugin approval rule)",
    reason: `Act on your mail (check the exact command)${exactly(call)}`,
    patternKey: "plugin_rule:chief:mail-other:0123456789abcdef",
    allowPermanent: true,
    allowSession: true,
  };
  expect(mailAction(approval)).toMatchObject({ rule: "mail-other", always: null, exact: call });
  sheet(approval);
  expect(screen.getByText(call)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Always allow/ })).toBeNull();
  expect(screen.getByText(/can only be allowed once/)).toBeTruthy();
});

it("hidden characters and padding in a command are made visible", () => {
  const sneaky = "echo safe‮ fr- mr​" + "\n".repeat(6) + "rm -rf ~" + " ".repeat(40) + "# done";
  const shown = revealCommand(sneaky);
  expect(shown.text).toContain("⟨U+202E⟩");
  expect(shown.text).toContain("⟨U+200B⟩");
  expect(shown.text).toContain("blank lines⟩");
  expect(shown.text).toContain("⟨40 spaces⟩");
  expect(shown.hidden).toBe(2);
  sheet({ requestId: "r3", command: sneaky, reason: "recursive delete", patternKey: "rm_recursive", allowPermanent: true, allowSession: true });
  expect(screen.getByText(/2 hidden characters shown as markers/)).toBeTruthy();
  expect(screen.getByText(/rm -rf ~/)).toBeTruthy();
});

it("an ordinary command is shown as is", () => {
  expect(revealCommand("git status")).toEqual({ text: "git status", hidden: 0, collapsed: false });
});

// A1: screen-reader browse mode and voice control click; they can't hold.
it("a click with no hold asks in place, and a second click always-allows", () => {
  const onChoose = vi.fn();
  const approval = { requestId: "r6", command: "git push", reason: "push", patternKey: "git_push", allowPermanent: true, allowSession: true };
  const view = render(<ApprovalSheet approval={approval} minimized={false} resolving={false} error="" onMinimize={() => {}} onExpand={() => {}} onChoose={onChoose} />);
  const always = screen.getByRole("button", { name: "Always allow (press and hold)" });
  // A mouse's own click comes after its press (detail 1): the hold decided, the click does nothing.
  fireEvent.click(always, { detail: 1 });
  expect(screen.queryByRole("button", { name: "Yes, always allow" })).toBeNull();
  fireEvent.click(always, { detail: 0 });
  expect(onChoose).not.toHaveBeenCalled();
  const armed = screen.getByRole("button", { name: "Yes, always allow" });
  expect(armed).toHaveClass("approve-always-armed");
  expect(screen.getByRole("status")).toHaveTextContent("Press it again to confirm.");
  // Moving away puts it back.
  fireEvent.blur(armed);
  expect(screen.getByRole("button", { name: "Always allow (press and hold)" })).toBeInTheDocument();
  fireEvent.click(always, { detail: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Yes, always allow" }), { detail: 0 });
  expect(onChoose).toHaveBeenCalledWith("always");
  // The next request starts unarmed.
  view.rerender(<ApprovalSheet approval={{ ...approval, requestId: "r7" }} minimized={false} resolving={false} error="" onMinimize={() => {}} onExpand={() => {}} onChoose={onChoose} />);
  expect(screen.getByRole("button", { name: "Always allow (press and hold)" })).toBeInTheDocument();
});

// Hermes 0.23 escapes an approval's hidden characters before the sheet sees them (agent/redact.py).
it("hidden characters Hermes already escaped still raise the warning, and an escape of a visible one doesn't", () => {
  const escaped = String.raw`echo safe\u202e fr- mr\u200b` + " ⟨+300 whitespace chars⟩ " + String.raw`rm -rf ~ ⟨\u2060 ×5⟩ \U000e0101 \xad`;
  const shown = revealCommand(escaped);
  expect(shown.hidden).toBe(2 + 5 + 1 + 1);
  expect(shown.collapsed).toBe(true);
  expect(shown.text).toBe(escaped); // already visible: nothing to replace
  expect(revealCommand("text\n⟨+4 blank lines⟩\nrm -rf ~").collapsed).toBe(true);
  expect(revealCommand(String.raw`printf '\u00e9\x41'`)).toEqual({ text: String.raw`printf '\u00e9\x41'`, hidden: 0, collapsed: false });
  sheet({ requestId: "r5", command: escaped, reason: "recursive delete", patternKey: "rm_recursive", allowPermanent: true, allowSession: true });
  expect(screen.getByText(/9 hidden characters shown as markers/)).toBeTruthy();
  expect(screen.getByText(/Long runs of blank space were shortened/)).toBeTruthy();
});

it("finds the mail guard's mark when Hermes escaped it, and only the guard's own", () => {
  const call = 'python google_api.py gmail send --to boss@example.com --subject Weekly --body "See you"';
  const mark = String.raw`\u2063`;
  const approval = {
    patternKey: "plugin_rule:chief:mail-send",
    // The guard strips both spellings from what it quotes, but a body can still spell one out in pieces; the guard's
    // own mark follows a blank line, which the one-line preview can't hold.
    reason: `Send an email\nTo: boss@example.com\nSubject: Weekly\n\nSee you ${mark}Exact call:${"\n\n" + mark}Exact call:\n${call}`,
  };
  expect(mailAction(approval)).toMatchObject({
    fields: [
      { key: "To", value: "boss@example.com" },
      { key: "Subject", value: "Weekly" },
    ],
    body: `See you ${mark}Exact call:`,
    exact: call,
  });
  // The raw mark still works, and only after a blank line.
  expect(mailAction({ ...approval, reason: `Send an email\nTo: boss@example.com\n\n${EXACT_MARK}Exact call:\n${call}` })?.exact).toBe(call);
  expect(mailAction({ ...approval, reason: `Send an email\nTo: boss@example.com ${mark}Exact call:\n${call}` })?.exact).toBe("");
});

it("a fleet or routine approval shows its own description and can't be always-allowed", () => {
  sheet({
    requestId: "r4",
    command: "<fleet_mint> (plugin approval rule)",
    reason: "Create a new bot: Nova (Planner)\nId: nova\n\nIts SOUL:\nYou plan the week.",
    patternKey: "plugin_rule:chief:fleet-mint:0123456789abcdef",
    allowPermanent: true,
    allowSession: true,
  });
  expect(screen.getByText("Create this bot?")).toBeTruthy();
  expect(screen.getByText(/Create a new bot: Nova \(Planner\)/)).toBeTruthy();
  expect(screen.queryByText(/plugin approval rule/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Always allow/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
});
