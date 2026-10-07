import type { ExecApproval } from "@/lib/types";

/*
 * Mail actions on the approval sheet. The bridge's mail guard (mail_guard.py) escalates sending, deleting and moving
 * mail, inviting people and sharing files to Hermes's approval gate under `plugin_rule:chief:<rule>`, with a reason
 * written as: a first line saying what, `Key: value` lines, a blank line, then the start of the message. This reads
 * that back so the sheet can show who it goes to and what it says instead of a command line.
 */

export type MailRule = "mail-send" | "mail-delete" | "mail-move" | "calendar-invite" | "file-share";

export type MailAction = {
  rule: MailRule;
  title: string;
  /** What "Always allow" would trust from now on. */
  always: string;
  what: string;
  fields: { key: string; value: string }[];
  body: string;
};

const RULES: Record<MailRule, { title: string; always: string }> = {
  "mail-send": { title: "Send this email?", always: "send email without asking" },
  "mail-delete": { title: "Delete this?", always: "delete without asking" },
  "mail-move": { title: "Move this email?", always: "archive and move email without asking" },
  "calendar-invite": { title: "Send these invitations?", always: "invite people without asking" },
  "file-share": { title: "Share this file?", always: "share files without asking" },
};

const FIELD = /^(To|Cc|Subject|Event|When|File|With): (.*)$/;

export function mailAction(approval: Pick<ExecApproval, "patternKey" | "reason">): MailAction | null {
  const match = /^plugin_rule:chief:([a-z-]+)$/.exec(approval.patternKey || "");
  const rule = match?.[1] as MailRule | undefined;
  if (!rule || !(rule in RULES)) return null;
  const lines = (approval.reason || "").split("\n");
  const what = (lines.shift() || "").trim();
  const fields: MailAction["fields"] = [];
  while (lines.length && FIELD.test(lines[0])) {
    const [, key, value] = FIELD.exec(lines.shift()!)!;
    if (value.trim()) fields.push({ key, value: value.trim() });
  }
  const body = lines.join("\n").trim();
  return { rule, ...RULES[rule], what, fields, body };
}
