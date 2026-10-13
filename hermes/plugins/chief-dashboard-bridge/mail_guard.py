"""Read freely, ask before sending: the owner's rule for what a bot may do with connected mail.

A `pre_tool_call` hook (registered in every Chief process). Searching and reading mail, calendars and documents
don't ask. Everything else a bot does with mail asks first: Hermes's own approval gate (Allow once / this chat /
Always / Deny), which fails closed with nobody there to ask (`tools.approval.request_tool_approval`). The sheet shows
who it goes to, the subject and the start of the message, and always the exact call underneath, so what it shows
and what runs can't disagree.

What it covers:
- **Quick connections** (Nous Connectors' `connectors__gmail__…`, Outlook's): an allow-list. Known read actions
  (search, fetch, list, get) and writing a draft run; every other action asks. Calendar asks before inviting people
  or deleting an event; Drive before sharing.
- **The Google Workspace skill on this PC** (`google_api.py`, through the terminal): read with the skill's own
  option names. Anything this can't read exactly (repeated or abbreviated options, a second call, shell operators,
  an action it doesn't know) asks as "Act on your mail" with the full command.
- **Obvious other routes to the same mailbox** (the `gws` tool, Gmail's API addresses, the token file) ask too, and
  reading `google_token.json` with the file tools is refused.

**What it is not.** A bot that can run arbitrary code as the owner can reach the mailbox in ways no pattern check
can list (an obfuscated script, a renamed copy). This raises the cost and keeps honest mistakes and casual injection
in front of the owner; the boundary that holds is keeping the Google token where bots can't read it (the next step:
Gmail on this PC through a bridge tool that holds the token, docs/PLAN-2026-10-12-security.md S8).

The sheet (apps/web/components/chat/approval-sheet.tsx, lib/mail-approval.ts) recognises the `chief:` rule keys and
lays the reason out as an email above the exact call.
"""

from __future__ import annotations

import hashlib
import json
import re
import shlex
from typing import Any

RULE_SEND = "chief:mail-send"
RULE_DELETE = "chief:mail-delete"
RULE_MOVE = "chief:mail-move"
RULE_INVITE = "chief:calendar-invite"
RULE_SHARE = "chief:file-share"
RULE_MAIL = "chief:mail-other"

# Separates the description from the exact call. An invisible character no description or command keeps (it is
# stripped from both), so text inside an email can't fake where the exact call starts.
EXACT_MARK = "⁣"
_EXACT_HEAD = "\n\n" + EXACT_MARK + "Exact call:\n"
_EXACT_MAX = 4000

# The services whose connector tools the guard reads (Nous Connectors slugs).
_MAIL = {"gmail", "outlook"}
_CALENDAR = {"googlecalendar", "outlookcalendar"}
_FILES = {"googledrive", "googledocs", "onedrive"}

# Mail actions that only read: allowed when the action has one of these and none of the write words.
_READ_VERBS = {"FETCH", "GET", "LIST", "SEARCH", "FIND", "READ", "QUERY", "COUNT", "LOOKUP", "VIEW"}
_WRITE_WORDS = {
    "SEND",
    "REPLY",
    "FORWARD",
    "FORWARDING",
    "DELETE",
    "TRASH",
    "PURGE",
    "MOVE",
    "ARCHIVE",
    "MODIFY",
    "CREATE",
    "UPDATE",
    "PATCH",
    "INSERT",
    "ADD",
    "REMOVE",
    "SET",
    "CHANGE",
    "IMPORT",
    "UPLOAD",
    "SHARE",
    "FILTER",
    "FILTERS",
    "RULE",
    "RULES",
    "VACATION",
    "AUTO",
    "AUTOREPLY",
    "DELEGATE",
    "SETTINGS",
    "MARK",
    "STAR",
    "WATCH",
    "STOP",
    "EMPTY",
    "BATCH",
    "SPAM",
    "UNTRASH",
    "RESTORE",
    "SUBSCRIBE",
}
_SEND_WORDS = {"SEND", "REPLY", "FORWARD"}
_DELETE_WORDS = {"DELETE", "TRASH", "PURGE", "EMPTY"}
_MOVE_WORDS = {"MOVE", "ARCHIVE", "LABEL", "LABELS", "MODIFY", "SPAM"}

_BODY_PREVIEW = 280
_FIELD_MAX = 200

_TO_KEYS = ("recipient_email", "to", "to_email", "to_recipients", "recipients", "recipient", "email", "emails")
_CC_KEYS = ("cc", "cc_emails", "cc_recipients")
_BCC_KEYS = ("bcc", "bcc_emails", "bcc_recipients", "extra_recipients")
_FROM_KEYS = ("from", "from_email", "sender", "from_header")
_ATTACH_KEYS = ("attachment", "attachments", "file_path", "files", "attachment_paths")
_SUBJECT_KEYS = ("subject", "title", "summary")
_BODY_KEYS = ("body", "message_body", "content", "text", "html_body", "comment", "description")

# The skill's own options per action (skills/productivity/google-workspace/scripts/google_api.py): value options,
# switches and how many positional arguments come first.
_SKILL_ACTIONS: dict[tuple[str, str], tuple[set[str], set[str], int]] = {
    ("gmail", "send"): ({"--to", "--subject", "--body", "--cc", "--from", "--thread-id"}, {"--html"}, 0),
    ("gmail", "reply"): ({"--body", "--from"}, set(), 1),
    ("gmail", "modify"): ({"--add-labels", "--remove-labels"}, set(), 1),
    ("calendar", "create"): ({"--summary", "--start", "--end", "--location", "--description", "--attendees", "--calendar"}, set(), 0),
    ("calendar", "delete"): ({"--calendar"}, set(), 1),
    ("drive", "share"): ({"--role", "--type", "--email", "--domain"}, {"--notify"}, 1),
    ("drive", "delete"): (set(), {"--permanent"}, 1),
}
# Read-only actions of the skill: no question.
_SKILL_READS = {
    ("gmail", "search"),
    ("gmail", "get"),
    ("gmail", "labels"),
    ("calendar", "list"),
    ("drive", "search"),
    ("drive", "get"),
    ("drive", "download"),
    ("contacts", "list"),
    ("sheets", "get"),
}

# Other routes to the same mailbox from the terminal or code: ask (heuristics; see "What it is not").
_MAIL_ROUTES = re.compile(r"google_token\.json|gmail\.googleapis\.com|googleapis\.com/(?:gmail|upload/gmail)|\bgws\s+gmail\b|\bgws\b.*\bsend\b", re.IGNORECASE)
_TOKEN_FILE = re.compile(r"google_token\.json|google_client_secret\.json", re.IGNORECASE)


def _connector_parts(tool_name: str) -> tuple[str, str] | None:
    """("gmail", "SEND_EMAIL") for `connectors__gmail__SEND_EMAIL` or `connectors__gmail__GMAIL_SEND_EMAIL`."""
    parts = tool_name.split("__")
    if len(parts) < 3 or parts[0] != "connectors":
        return None
    app = parts[1].lower()
    action = "__".join(parts[2:]).upper()
    prefix = app.upper() + "_"
    if action.startswith(prefix):
        action = action[len(prefix) :]
    return app, action


def _words(action: str) -> set[str]:
    return set(re.split(r"[^A-Z]+", action.upper())) - {""}


def _clean(text: str) -> str:
    return str(text).replace(EXACT_MARK, "")


def _flat(value: Any) -> str:
    """A field as one short line: lists joined, objects' addresses pulled out."""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ", ".join(x for x in (_flat(v) for v in value) if x)
    if isinstance(value, dict):
        for key in ("email", "address", "emailAddress", "name", "path", "filename"):
            if key in value:
                return _flat(value[key])
        return ""
    text = " ".join(_clean(value).split())
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


_HEADS = {
    RULE_SEND: "Send an email",
    RULE_DELETE: "Delete email",
    RULE_MOVE: "Move or relabel email",
    RULE_INVITE: "Invite people to an event",
    RULE_SHARE: "Share a file",
    RULE_MAIL: "Act on your mail",
}


def describe(kind: str, fields: dict[str, str], exact: str = "") -> str:
    """The reason on the approval sheet: what (first line), `Key: value` lines, the start of the message, and the exact
    call after an invisible mark. The sheet parses this shape for `chief:` rules; as plain text it still reads well."""
    head = _clean(fields.get("Head", "")) or _HEADS.get(kind, "Act on your mail")
    if kind == RULE_DELETE and fields.get("File"):
        head = "Delete a file"
    lines = [head]
    for key in ("To", "Cc", "Bcc", "From", "Subject", "Attach", "Event", "When", "File", "With"):
        value = _clean(fields.get(key, ""))
        if value:
            lines.append(f"{key}: {' '.join(value.split())}")
    body = _clean(fields.get("Body", ""))
    if body:
        preview = " ".join(body.split())
        if len(preview) > _BODY_PREVIEW:
            preview = preview[: _BODY_PREVIEW - 1].rstrip() + "…"
        lines.append("")
        lines.append(preview)
    text = "\n".join(lines)
    if exact:
        call = _clean(exact)
        if len(call) > _EXACT_MAX:
            call = call[:_EXACT_MAX] + f"… ({len(call) - _EXACT_MAX} more characters)"
        text += _EXACT_HEAD + call
    return text


def _mail_fields(args: dict[str, Any]) -> dict[str, str]:
    return {
        "To": _first(args, _TO_KEYS),
        "Cc": _first(args, _CC_KEYS),
        "Bcc": _first(args, _BCC_KEYS),
        "From": _first(args, _FROM_KEYS),
        "Subject": _first(args, _SUBJECT_KEYS),
        "Attach": _first(args, _ATTACH_KEYS),
        "Body": _first(args, _BODY_KEYS),
    }


def _connector_rule(app: str, action: str, args: dict[str, Any]) -> tuple[str, dict[str, str]] | None:
    words = _words(action)
    if app in _MAIL:
        if words & _READ_VERBS and not words & _WRITE_WORDS:
            return None  # reading
        if "DRAFT" in words and words & {"CREATE", "UPDATE"} and not words & {"SEND", "DELETE"}:
            return None  # writing a draft is fine; sending it is not
        fields = _mail_fields(args)
        if words & _SEND_WORDS:
            return RULE_SEND, fields
        if words & _DELETE_WORDS:
            return RULE_DELETE, {}
        if words & _MOVE_WORDS:
            return RULE_MOVE, {}
        # Anything else (forwarding rules, filters, vacation replies, settings, a new action): ask.
        return RULE_MAIL, {**fields, "Head": f"{app.title()}: {action.replace('_', ' ').lower()}"}
    if app in _CALENDAR:
        attendees = _first(args, ("attendees", "attendee_emails", "invitees", "guests"))
        if words & {"DELETE", "REMOVE", "CANCEL"}:
            return RULE_INVITE, {"Event": _first(args, ("event_id", "summary", "title"))}
        if words & {"CREATE", "UPDATE", "PATCH", "QUICK", "INVITE", "ADD"} and (attendees or words & {"ATTENDEE", "ATTENDEES", "INVITE"}):
            return RULE_INVITE, {"Event": _first(args, _SUBJECT_KEYS), "When": _first(args, ("start_datetime", "start", "start_time")), "With": attendees}
        return None
    if app in _FILES and words & {"SHARE", "SHARING", "PERMISSION", "PERMISSIONS"}:
        return RULE_SHARE, {"File": _first(args, ("file_id", "file_name", "name")), "With": _first(args, ("email_address", "email", "emails", "recipient"))}
    return None


def _unquoted_operators(command: str) -> bool:
    """True when the command has shell structure outside quotes (`;`, `&`, `|`, `<`, `>`, a newline, `$(` or a
    backtick): a second command could run beside the one the sheet describes."""
    quote = ""
    i = 0
    while i < len(command):
        ch = command[i]
        if quote == "'":
            if ch == "'":
                quote = ""
        elif ch == "\\" and quote != "'":
            i += 2
            continue
        elif quote == '"':
            if ch == '"':
                quote = ""
            elif ch == "`" or command.startswith("$(", i):
                return True
        elif ch in "'\"":
            quote = ch
        elif ch in ";&|<>\n\r`" or command.startswith("$(", i):
            return True
        i += 1
    return bool(quote)  # an unclosed quote: the shell and this reader may disagree


def _strict(rest: list[str], values: set[str], switches: set[str], positional: int) -> dict[str, str] | None:
    """The options as the skill would read them, or None when this can't be sure: an option it doesn't have (an
    abbreviation argparse would accept), one given twice (the last would win), or arguments left over."""
    out: dict[str, str] = {}
    args = list(rest)
    pos: list[str] = []
    while args:
        tok = args.pop(0)
        if tok.startswith("-"):
            name, eq, value = tok.partition("=")
            if name in out:
                return None
            if name in switches and not eq:
                out[name] = "yes"
            elif name in values:
                if not eq:
                    if not args:
                        return None
                    value = args.pop(0)
                out[name] = value
            else:
                return None
        else:
            pos.append(tok)
    if len(pos) != positional:
        return None
    out["_pos"] = pos[0] if pos else ""
    return out


def _skill_rule(command: str) -> tuple[str, dict[str, str]] | None:
    """The Google Workspace skill's `google_api.py <service> <action>`, or another obvious route to the mailbox."""
    calls = len(re.findall(r"google_api\.py", command))
    if not calls:
        return (RULE_MAIL, {"Head": "Reach your mailbox another way"}) if _MAIL_ROUTES.search(command) else None
    unsure: tuple[str, dict[str, str]] = (RULE_MAIL, {"Head": "Act on your mail (check the exact command)"})
    if calls > 1 or _unquoted_operators(command) or _MAIL_ROUTES.search(command):
        return unsure
    try:
        argv = shlex.split(command, posix=True)
    except ValueError:
        return unsure
    at = next((i for i, tok in enumerate(argv) if tok.replace("\\", "/").endswith("google_api.py")), -1)
    if at < 0 or at + 2 >= len(argv):
        return unsure
    service, action, rest = argv[at + 1], argv[at + 2], argv[at + 3 :]
    if (service, action) in _SKILL_READS:
        return None
    spec = _SKILL_ACTIONS.get((service, action))
    if spec is None:
        return unsure  # an action this guard doesn't know: ask
    opts = _strict(rest, *spec)
    if opts is None:
        return unsure
    if (service, action) == ("gmail", "send"):
        return RULE_SEND, {
            "To": opts.get("--to", ""),
            "Cc": opts.get("--cc", ""),
            "From": opts.get("--from", ""),
            "Subject": opts.get("--subject", ""),
            "Body": opts.get("--body", ""),
        }
    if (service, action) == ("gmail", "reply"):
        return RULE_SEND, {"Subject": "Reply in an existing thread", "From": opts.get("--from", ""), "Body": opts.get("--body", "")}
    if (service, action) == ("gmail", "modify"):
        adds, removes = _labels(opts.get("--add-labels", "")), _labels(opts.get("--remove-labels", ""))
        # Marking read or starring is housekeeping; anything that moves mail out of sight asks.
        if adds - {"STARRED", "IMPORTANT"} or removes - {"UNREAD", "STARRED", "IMPORTANT"}:
            return RULE_MOVE, {}
        return None
    if (service, action) == ("calendar", "delete"):
        return RULE_INVITE, {"Event": opts["_pos"]}
    if (service, action) == ("calendar", "create"):
        if not opts.get("--attendees"):
            return None
        return RULE_INVITE, {"Event": opts.get("--summary", ""), "When": opts.get("--start", ""), "With": opts["--attendees"]}
    if (service, action) == ("drive", "share"):
        return RULE_SHARE, {"File": opts["_pos"], "With": opts.get("--email") or opts.get("--domain") or opts.get("--type", "")}
    if (service, action) == ("drive", "delete"):
        return RULE_DELETE, {"File": opts["_pos"]}
    return unsure


def _exact_connector(tool_name: str, args: dict[str, Any]) -> str:
    try:
        return f"{tool_name} {json.dumps(args, ensure_ascii=False, sort_keys=True)}"
    except (TypeError, ValueError):
        return f"{tool_name} {args!r}"


def check(tool_name: str, args: Any) -> dict[str, Any] | None:
    """The hook's answer for one call: None (let it run), Hermes's `approve` escalation, or a refusal."""
    args = args if isinstance(args, dict) else {}
    name = str(tool_name or "")
    # The Google token is the mailbox: bots never read it with their file tools.
    if name in ("read_file", "search_files", "file_read", "view_file"):
        target = " ".join(str(args.get(k) or "") for k in ("path", "file_path", "pattern", "glob"))
        if _TOKEN_FILE.search(target):
            return {"action": "block", "message": "The Google sign-in file isn't readable by bots. Use the Google tools instead."}
        return None
    parts = _connector_parts(name)
    if parts is not None:
        rule = _connector_rule(parts[0], parts[1], args)
        exact = _exact_connector(name, args)
    elif name == "terminal":
        command = str(args.get("command") or "")
        rule = _skill_rule(command)
        exact = command
    elif name == "execute_code":
        code = str(args.get("code") or args.get("source") or "")
        rule = (RULE_MAIL, {"Head": "Run code that reaches your mailbox"}) if _MAIL_ROUTES.search(code) or "google_api.py" in code else None
        exact = code
    else:
        return None
    if rule is None:
        return None
    kind, fields = rule
    # "Always allow" trusts a rule key from then on. A kind of action ("send email") may be trusted as a kind; something
    # this couldn't read exactly may only ever be trusted as that exact call.
    key = f"{kind}:{hashlib.sha256(exact.encode('utf-8')).hexdigest()[:16]}" if kind == RULE_MAIL else kind
    return {"action": "approve", "message": describe(kind, fields, exact), "rule_key": key}


def pre_tool_call(tool_name: str = "", args: Any = None, **_kw: Any) -> dict[str, Any] | None:
    """Hermes's `pre_tool_call` hook. Never raises (Hermes would block every tool). A call it can't read asks the
    owner when it touches mail at all, and is left alone otherwise."""
    try:
        return check(tool_name, args)
    except Exception:
        name = str(tool_name or "")
        blob = json.dumps(args, default=str) if isinstance(args, dict) else ""
        if name.startswith(("connectors__gmail__", "connectors__outlook__")) or "google_api.py" in blob or _MAIL_ROUTES.search(blob):
            return {"action": "approve", "message": "Act on your mail", "rule_key": RULE_MAIL}
        return None
