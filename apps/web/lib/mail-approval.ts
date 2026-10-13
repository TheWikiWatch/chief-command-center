import type { ExecApproval } from "@/lib/types";

/*
 * Mail actions on the approval sheet. The bridge's mail guard (mail_guard.py) escalates sending, deleting and moving
 * mail, inviting people and sharing files to Hermes's approval gate under `plugin_rule:chief:<rule>` (an unsure call's
 * rule also carries a fingerprint of that exact call). Its reason reads: a first line saying what, `Key: value` lines,
 * a blank line, the start of the message, then an invisible mark and the exact call. This reads that back so the sheet
 * shows who it goes to and what it says, with the exact call underneath.
 */

export type MailRule = "mail-send" | "mail-delete" | "mail-move" | "calendar-invite" | "file-share" | "mail-other";

export type MailAction = {
  rule: MailRule;
  title: string;
  /** What "Always allow" would trust from now on; null when it must not be offered (an unsure call). */
  always: string | null;
  what: string;
  fields: { key: string; value: string }[];
  body: string;
  /** The exact call Hermes will run, as the guard saw it. */
  exact: string;
};

/** The mark before the exact call (mail_guard.EXACT_MARK): an invisible separator stripped from everything else. */
export const EXACT_MARK = "⁣";
const EXACT_HEAD = `${EXACT_MARK}Exact call:\n`;

const RULES: Record<MailRule, { title: string; always: string | null }> = {
  "mail-send": { title: "Send this email?", always: "send email without asking" },
  "mail-delete": { title: "Delete this?", always: "delete without asking" },
  "mail-move": { title: "Move this email?", always: "archive and move email without asking" },
  "calendar-invite": { title: "Send these invitations?", always: "invite people without asking" },
  "file-share": { title: "Share this file?", always: "share files without asking" },
  "mail-other": { title: "Check this mail action", always: null },
};

const FIELD = /^(To|Cc|Bcc|From|Subject|Attach|Event|When|File|With): (.*)$/;

export function mailAction(approval: Pick<ExecApproval, "patternKey" | "reason">): MailAction | null {
  const match = /^plugin_rule:chief:([a-z-]+)(?::[0-9a-f]{8,64})?$/.exec(approval.patternKey || "");
  const rule = match?.[1] as MailRule | undefined;
  if (!rule || !(rule in RULES)) return null;
  const reason = approval.reason || "";
  const at = reason.indexOf(EXACT_HEAD);
  const exact = at >= 0 ? reason.slice(at + EXACT_HEAD.length) : "";
  const lines = (at >= 0 ? reason.slice(0, at) : reason).replace(/\n+$/, "").split("\n");
  const what = (lines.shift() || "").trim();
  const fields: MailAction["fields"] = [];
  while (lines.length && FIELD.test(lines[0])) {
    const [, key, value] = FIELD.exec(lines.shift()!)!;
    if (value.trim()) fields.push({ key, value: value.trim() });
  }
  const body = lines.join("\n").trim();
  return { rule, ...RULES[rule], what, fields, body, exact };
}

/** The bridge's other approvals (fleet.py, routines.py): what to call them on the sheet. */
const CHIEF_ACTIONS: Record<string, string> = {
  "fleet-mint": "Create this bot?",
  "fleet-retire": "Retire this bot?",
  "fleet-restore": "Bring this bot back?",
  "fleet-set-model": "Use this costlier model?",
  "fleet-unknown": "Change the team?",
  routine: "Schedule this job?",
  "routine-unknown": "Schedule or change a job?",
};

export type ChiefAction = { title: string; text: string };

/**
 * A fleet or routine approval: its title and the bridge's description. Each is fingerprinted to its exact request
 * (an "always" would only ever trust that one), so the sheet doesn't offer "Always allow" for them.
 */
export function chiefAction(approval: Pick<ExecApproval, "patternKey" | "reason">): ChiefAction | null {
  const match = /^plugin_rule:chief:([a-z-]+?)(?::[0-9a-f]{8,64})?$/.exec(approval.patternKey || "");
  const title = match ? CHIEF_ACTIONS[match[1]] : undefined;
  return title ? { title, text: (approval.reason || "").trim() } : null;
}
