import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

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
  expect(screen.getByText(/can only be allowed one time at a time/)).toBeTruthy();
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
