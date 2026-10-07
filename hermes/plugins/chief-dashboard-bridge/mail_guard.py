"""Read freely, ask before sending: the owner's rule for what a bot may do with connected mail.

A `pre_tool_call` hook (registered in every Chief process). Searching and reading mail, calendars and documents
never ask. Sending, replying, forwarding, deleting and moving mail, inviting people to an event or sharing a
document returns `{"action": "approve", ...}`, which puts the call on Hermes's own approval gate: the same
Allow once / Allow for this chat / Always / Deny sheet commands use, and it fails closed with nobody there to ask
(`tools.approval.request_tool_approval`). Email is untrusted input, so this gate is also what stops a message from
talking a bot into forwarding the inbox.

It covers every way a bot reaches mail:
- Nous Connectors' tools (`connectors__gmail__SEND_EMAIL`, Outlook's, Google Calendar's), by action name;
- the Google Workspace skill's `google_api.py`, run through the terminal (mail "on this PC");
- nothing else: work tools from the MCP catalog keep Hermes's own rules.

`describe()` writes the reason the sheet shows: who it goes to, the subject and the first lines. The sheet
(apps/web/components/chat/approval-sheet.tsx) recognises the `chief:` rule keys and lays the reason out as an email.
"""

from __future__ import annotations

import re
import shlex
from typing import Any

RULE_SEND = "chief:mail-send"
RULE_DELETE = "chief:mail-delete"
RULE_MOVE = "chief:mail-move"
RULE_INVITE = "chief:calendar-invite"
RULE_SHARE = "chief:file-share"

# The services whose connector tools the guard reads (Nous Connectors slugs).
_MAIL = {"gmail", "outlook"}
_CALENDAR = {"googlecalendar", "outlookcalendar"}
_FILES = {"googledrive", "googledocs", "onedrive"}

_SEND_WORDS = ("SEND", "REPLY", "FORWARD")
_DELETE_WORDS = ("DELETE", "TRASH", "PURGE")
_MOVE_WORDS = ("MOVE", "ARCHIVE")
_LABEL_WORDS = ("LABEL", "MODIFY")
# Label changes that move mail out of sight: archiving (INBOX removed), binning, marking as spam.
_MOVING_ADDS = {"TRASH", "SPAM"}
_MOVING_REMOVES = {"INBOX"}

_BODY_PREVIEW = 280
_FIELD_MAX = 200

_TO_KEYS = ("recipient_email", "to", "to_email", "to_recipients", "recipients", "recipient", "email", "emails")
_CC_KEYS = ("cc", "cc_emails", "cc_recipients")
_SUBJECT_KEYS = ("subject", "title", "summary")
_BODY_KEYS = ("body", "message_body", "content", "text", "html_body", "comment", "description")


def _connector_parts(tool_name: str) -> tuple[str, str] | None:
    """("gmail", "SEND_EMAIL") for `connectors__gmail__SEND_EMAIL` or `connectors__gmail__GMAIL_SEND_EMAIL`."""
    parts = tool_name.split("__")
    if len(parts) < 3 or parts[0] != "connectors":
        return None
    app = parts[1].lower()
    action = parts[-1].upper()
    prefix = app.upper() + "_"
    if action.startswith(prefix):
        action = action[len(prefix) :]
    return app, action


def _words(action: str) -> set[str]:
    return set(re.split(r"[^A-Z]+", action.upper())) - {""}


def _flat(value: Any) -> str:
    """A field as one short line: lists joined, objects' addresses pulled out."""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ", ".join(x for x in (_flat(v) for v in value) if x)
    if isinstance(value, dict):
        for key in ("email", "address", "emailAddress", "name"):
            if key in value:
                return _flat(value[key])
        return ""
    text = " ".join(str(value).split())
    return text[:_FIELD_MAX]


def _first(args: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        if key in args and _flat(args[key]):
            return _flat(args[key])
    return ""


def _labels(value: Any) -> set[str]:
    if isinstance(value, str):
        return {v.strip().upper() for v in value.split(",") if v.strip()}
    if isinstance(value, (list, tuple)):
        return {str(v).strip().upper() for v in value if str(v).strip()}
    return set()


def _moves_mail(args: dict[str, Any]) -> bool:
    adds: set[str] = set()
    removes: set[str] = set()
    for key, value in args.items():
        low = key.lower()
        if "add" in low and "label" in low:
            adds |= _labels(value)
        elif "remove" in low and "label" in low:
            removes |= _labels(value)
    return bool(adds & _MOVING_ADDS or removes & _MOVING_REMOVES)


def describe(kind: str, fields: dict[str, str]) -> str:
    """The reason on the approval sheet. The first line says what; `Key: value` lines follow; then the body.

    The sheet parses this shape for `chief:` rules, and anything else still reads well as plain text."""
    head = {
        RULE_SEND: "Send an email",
        RULE_DELETE: "Delete email",
        RULE_MOVE: "Move email out of the inbox",
        RULE_INVITE: "Invite people to an event",
        RULE_SHARE: "Share a file",
    }.get(kind, "Act on your mail")
    if kind == RULE_DELETE and fields.get("File"):
        head = "Delete a file"
    lines = [head]
    for key in ("To", "Cc", "Subject", "Event", "When", "File", "With"):
        value = fields.get(key, "")
        if value:
            lines.append(f"{key}: {value}")
    body = fields.get("Body", "")
    if body:
        preview = " ".join(body.split())
        if len(preview) > _BODY_PREVIEW:
            preview = preview[: _BODY_PREVIEW - 1].rstrip() + "…"
        lines.append("")
        lines.append(preview)
    return "\n".join(lines)


def _connector_rule(app: str, action: str, args: dict[str, Any]) -> tuple[str, dict[str, str]] | None:
    words = _words(action)
    if app in _MAIL:
        if "DRAFT" in words and not words & {"SEND"}:
            return None  # writing a draft is fine; sending it is not
        fields = {"To": _first(args, _TO_KEYS), "Cc": _first(args, _CC_KEYS), "Subject": _first(args, _SUBJECT_KEYS), "Body": _first(args, _BODY_KEYS)}
        if words & set(_SEND_WORDS):
            return RULE_SEND, fields
        if words & set(_DELETE_WORDS):
            return RULE_DELETE, {}
        if words & set(_MOVE_WORDS):
            return RULE_MOVE, {}
        if words & set(_LABEL_WORDS) and _moves_mail(args):
            return RULE_MOVE, {}
        return None
    if app in _CALENDAR:
        attendees = _first(args, ("attendees", "attendee_emails", "invitees", "guests"))
        if words & {"DELETE", "REMOVE"}:
            return RULE_INVITE, {"Event": _first(args, ("event_id", "summary", "title"))}
        if words & {"CREATE", "UPDATE", "PATCH", "QUICK", "INVITE"} and attendees:
            return RULE_INVITE, {"Event": _first(args, _SUBJECT_KEYS), "When": _first(args, ("start_datetime", "start", "start_time")), "With": attendees}
        return None
    if app in _FILES and words & {"SHARE", "SHARING", "PERMISSION", "PERMISSIONS"}:
        return RULE_SHARE, {"File": _first(args, ("file_id", "file_name", "name")), "With": _first(args, ("email_address", "email", "emails", "recipient"))}
    return None


def _flag(argv: list[str], name: str) -> str:
    for i, tok in enumerate(argv):
        if tok == name and i + 1 < len(argv):
            return argv[i + 1]
        if tok.startswith(name + "="):
            return tok.split("=", 1)[1]
    return ""


def _skill_rule(command: str) -> tuple[str, dict[str, str]] | None:
    """The Google Workspace skill's `google_api.py <service> <action>`, inside any terminal command."""
    if "google_api.py" not in command:
        return None
    try:
        argv = shlex.split(command, posix=True)
    except ValueError:
        argv = command.split()
    for i, tok in enumerate(argv):
        if not tok.replace("\\", "/").endswith("google_api.py") or i + 2 >= len(argv):
            continue
        service, action, rest = argv[i + 1], argv[i + 2], argv[i + 3 :]
        if service == "gmail" and action == "send":
            return RULE_SEND, {"To": _flag(rest, "--to"), "Cc": _flag(rest, "--cc"), "Subject": _flag(rest, "--subject"), "Body": _flag(rest, "--body")}
        if service == "gmail" and action == "reply":
            return RULE_SEND, {"Subject": "Reply in an existing thread", "Body": _flag(rest, "--body")}
        if service == "gmail" and action == "modify":
            adds, removes = _labels(_flag(rest, "--add-labels")), _labels(_flag(rest, "--remove-labels"))
            if adds & _MOVING_ADDS or removes & _MOVING_REMOVES:
                return RULE_MOVE, {}
            return None
        if service == "calendar" and action == "delete":
            return RULE_INVITE, {"Event": rest[0] if rest else ""}
        if service == "calendar" and action == "create" and _flag(rest, "--attendees"):
            return RULE_INVITE, {"Event": _flag(rest, "--summary"), "When": _flag(rest, "--start"), "With": _flag(rest, "--attendees")}
        if service == "drive" and action == "share":
            return RULE_SHARE, {"File": rest[0] if rest else "", "With": _flag(rest, "--email") or _flag(rest, "--domain") or _flag(rest, "--type")}
        if service == "drive" and action == "delete":
            return RULE_DELETE, {"File": rest[0] if rest else ""}
        if service == "gmail" and action not in {"search", "get", "labels"}:
            return RULE_SEND, {"Subject": f"gmail {action}"}  # an action this guard doesn't know yet: ask
    return None


def check(tool_name: str, args: Any) -> dict[str, Any] | None:
    """The hook's answer for one call: None (let it run) or Hermes's `approve` escalation."""
    args = args if isinstance(args, dict) else {}
    rule: tuple[str, dict[str, str]] | None = None
    parts = _connector_parts(str(tool_name or ""))
    if parts is not None:
        rule = _connector_rule(parts[0], parts[1], args)
    elif tool_name == "terminal":
        rule = _skill_rule(str(args.get("command") or ""))
    if rule is None:
        return None
    kind, fields = rule
    return {"action": "approve", "message": describe(kind, fields), "rule_key": kind}


def pre_tool_call(tool_name: str = "", args: Any = None, **_kw: Any) -> dict[str, Any] | None:
    """Hermes's `pre_tool_call` hook. Never raises (Hermes would block every tool). A call it can't read asks the
    owner when it touches mail at all, and is left alone otherwise."""
    try:
        return check(tool_name, args)
    except Exception:
        name = str(tool_name or "")
        command = str(args.get("command") or "") if isinstance(args, dict) else ""
        if name.startswith(("connectors__gmail__", "connectors__outlook__")) or "google_api.py" in command:
            return {"action": "approve", "message": "Act on your mail", "rule_key": RULE_SEND}
        return None
