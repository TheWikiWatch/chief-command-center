"""What the chat shows besides transcript rows: the chief's open question, notices, and its current step.

- **Question** (`pending_clarify` / `resolve_clarify`): Hermes's `clarify` tool blocks the turn until the
  owner answers. The entry lives in Hermes's own registry (`tools.clarify_gateway`); the dashboard shows
  it as a card and answers through the same resolver a chat platform's buttons use.
- **Notices** (`notices`): messages the gateway sent that are not transcript rows (scheduled-job results,
  gateway notices). The adapter writes every send to the outbox; a send whose text is a transcript reply
  is a reply, not a notice. Busy "⏳ Working" notices are never shown as notices.
- **Step** (`activity`): what the running turn is doing, in plain words, from its newest rows.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from .data import _message_session_id, chief_home
from .util import subdict, sublist

logger = logging.getLogger("chief-dashboard-bridge")

# ----------------------------------------------------------------------------- question (clarify)


def pending_clarify(session_key: str) -> dict[str, Any] | None:
    """The oldest unanswered question the chief asked in this session, or None."""
    if not session_key:
        return None
    try:
        from tools import clarify_gateway as cg
    except Exception:
        return None
    try:
        entry = cg.get_pending_for_session(session_key, include_choice_prompts=True)
        if entry is None or entry.event.is_set():
            return None
        return {
            "id": str(entry.clarify_id),
            "question": str(entry.question or ""),
            "choices": [str(c) for c in (entry.choices or [])],
            "multi": bool(entry.multi_select),
        }
    except Exception:
        logger.debug("pending clarify read failed", exc_info=True)
        return None


def resolve_clarify(session_key: str, clarify_id: str, answer: Any) -> dict[str, Any]:
    """Answer the open question: a choice (its text), several choices (a list, multi-select), or the
    owner's own words. Only the question that is open for this session can be answered."""
    clarify_id = str(clarify_id or "").strip()
    if not clarify_id:
        return {"ok": False, "error": "Which question?"}
    pending = pending_clarify(session_key)
    if not pending or pending["id"] != clarify_id:
        return {"ok": False, "code": "gone", "error": "That question is no longer open."}
    choices = pending["choices"]
    if isinstance(answer, list):
        picked = [str(a).strip() for a in answer if str(a).strip()]
        if not pending["multi"] or not picked or any(p not in choices for p in picked):
            return {"ok": False, "error": "Pick from the listed choices."}
        response = json.dumps(picked, ensure_ascii=False)
    else:
        response = str(answer or "").strip()
        if not response:
            return {"ok": False, "error": "Type an answer first."}
        if len(response) > 4000:
            return {"ok": False, "error": "That answer is too long."}
        if pending["multi"] and response in choices:
            response = json.dumps([response], ensure_ascii=False)
    try:
        from tools import clarify_gateway as cg

        if not cg.resolve_gateway_clarify(clarify_id, response):
            return {"ok": False, "code": "gone", "error": "That question is no longer open."}
    except Exception:
        logger.warning("resolve clarify failed", exc_info=True)
        return {"ok": False, "error": "The answer didn't reach the chief."}
    return {"ok": True}


def asked_from_tool_row(content: Any) -> list[dict[str, Any]]:
    """A finished `clarify` call's result, as the questions and the owner's answers (empty if not one)."""
    try:
        data = json.loads(content) if isinstance(content, str) else content
    except (TypeError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    responses = data.get("responses")
    items = responses if isinstance(responses, list) else [data]
    out = []
    for item in items:
        if not isinstance(item, dict) or "question" not in item or "user_response" not in item:
            return []
        answer = item.get("user_response")
        out.append(
            {
                "question": str(item.get("question") or ""),
                "choices": [str(c) for c in (item.get("choices_offered") or [])],
                "answer": [str(a) for a in answer] if isinstance(answer, list) else str(answer or ""),
            }
        )
    if out and data.get("timed_out"):
        for item in out:
            item.setdefault("unanswered", not item["answer"])
    return out


# ----------------------------------------------------------------------------- notices

_BUSY = re.compile(r"^\s*⏳\s*Working\b")
_SPACE = re.compile(r"\s+")


def _norm(text: str) -> str:
    return _SPACE.sub(" ", str(text or "")).strip()


def _reply_texts(session_key: str, since: float) -> tuple[list[str], set[str]]:
    """Assistant texts of this session from `since` on (normalized), and the files they showed, to tell
    replies from notices."""
    db_path = chief_home() / "state.db"
    if not session_key or not db_path.is_file():
        return [], set()
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            sid = _message_session_id(conn, session_key)
            rows = conn.execute(
                "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND CAST(timestamp AS REAL) >= ? ORDER BY id DESC LIMIT 400",
                (sid, since - 120),
            ).fetchall()
        finally:
            conn.close()
    except Exception:
        logger.debug("reply texts read failed", exc_info=True)
        return [], set()
    from .data import parse_message_content

    texts: list[str] = []
    files: set[str] = set()
    for row in rows:
        text, attachments = parse_message_content(row["content"])
        if _norm(text):
            texts.append(_norm(text))
        files.update(_file_key(a.get("path")) for a in attachments)
    return texts, files


def _file_key(path: Any) -> str:
    """The same file however a message spelled its path (slashes, case on Windows, a trailing "./")."""
    raw = str(path or "").strip()
    return raw if raw.startswith(("http://", "https://")) else os.path.normcase(os.path.normpath(raw))


def busy_line(text: str) -> bool:
    return bool(_BUSY.match(str(text or "")))


_CRON_DIVIDER = "\n-------------\n\n"
_CRON_FOOTER = '\n\nTo stop or manage this job, send me a new message (e.g. "stop reminder '


def unwrap_cron(text: str) -> tuple[str, dict[str, str] | None]:
    """Hermes wraps a scheduled job's answer (cron/scheduler_delivery.py, `cron.wrap_response`):

        Cronjob Response: <name>
        (job_id: <id>)
        -------------

        <the answer>

        To stop or manage this job, send me a new message (e.g. "stop reminder <name>").

    The app shows the routine's name in its own card header and a Manage link instead, so this returns the
    answer alone and the routine. Anything that doesn't have exactly this shape is returned unchanged."""
    if not text.startswith("Cronjob Response: "):
        return text, None
    divider = text.find(_CRON_DIVIDER)
    footer = text.rfind(_CRON_FOOTER)
    head = text[:divider] if divider > 0 else ""
    if divider < 0 or footer <= divider or "\n(job_id: " not in head:
        return text, None
    name_line, _, id_line = head.partition("\n")
    name = name_line[len("Cronjob Response: ") :].strip()
    job_id = id_line.strip().removeprefix("(job_id: ").removesuffix(")").strip()
    body = text[divider + len(_CRON_DIVIDER) : footer].strip()
    if not body:
        return text, None
    return body, {"name": name, "jobId": job_id}


def notices(session_key: str, since: float = 0.0, limit: int = 30, chat_id: str = "") -> list[dict[str, Any]]:
    """Gateway sends at or after `since` that aren't replies: newest `limit`, oldest first. With `chat_id`, only
    that thread's (the main chat also gets sends without a chat)."""
    from . import identity
    from .outbox import read_since

    rows = read_since(since)
    if chat_id:
        main = chat_id == identity.owner_id()
        rows = [r for r in rows if str(r.get("chat_id") or "") == chat_id or (main and not r.get("chat_id"))]
    rows = [r for r in rows if not busy_line(str(r.get("message") or "")) and _norm(str(r.get("message") or ""))]
    if not rows:
        return []
    replies, shown = _reply_texts(session_key, min(float(r.get("at") or 0) for r in rows))
    from .data import parse_message_content, remember_media_path

    out = []
    for row in rows:
        raw = str(row.get("message") or "")
        # The adapter sends a reply's attachments after its text as "MEDIA:<path>" lines (adapter._send_media).
        stripped, attachments = parse_message_content(raw) if "MEDIA:" in raw else (raw, [])
        text = _norm(stripped)
        attachments = [a for a in attachments if _file_key(a.get("path")) not in shown]
        # A long reply can reach the adapter in pieces: a piece of a reply is a reply too.
        if not attachments and (not text or any(text == reply or text in reply for reply in replies)):
            continue
        for a in attachments:
            remember_media_path(str(a.get("path") or ""))
        body, routine = unwrap_cron(stripped)
        item: dict[str, Any] = {
            "id": str(row.get("id") or ""),
            "at": float(row.get("at") or 0),
            "text": body,
            # Hermes delivers a scheduled job's answer as "Cronjob Response: <name>"; the app's own relays say "cron".
            "source": "scheduled" if row.get("source") == "cron" or raw.startswith("Cronjob Response:") else "notice",
        }
        if routine:
            item["routine"] = routine
        if attachments:
            item["attachments"] = attachments
        out.append(item)
    return out[-limit:]


def notice_head() -> str:
    """The newest outbox id (a cheap "anything new?" for the long-poll: the outbox is read incrementally)."""
    from .outbox import head_id

    return head_id()


# ----------------------------------------------------------------------------- current step

_FRIENDLY = {
    "clarify": "Waiting for your answer",
    "todo_list": "Planning the steps",
    "memory": "Updating its memory",
    "session_search": "Searching past conversations",
    "web_search": "Searching the web",
    "web_extract": "Reading a web page",
    "terminal": "Running a command",
    "process_manage": "Checking a running command",
    "execute_code": "Running code",
    "delegate_task": "Handing work to a helper",
    "skills_list": "Looking through its skills",
    "skill_manage": "Updating a skill",
    "cronjob_manage": "Updating a schedule",
    "text_to_speech": "Preparing audio",
    "vision_analyze": "Looking at an image",
    "image_generate": "Making an image",
    "tool_search": "Looking up its tools",
    "tool_describe": "Looking up its tools",
    "fleet_roster": "Checking the team",
    "fleet_models": "Checking the available models",
    "fleet_mint": "Setting up a new specialist",
    "fleet_set_model": "Changing a specialist's model",
    "fleet_retire": "Retiring a specialist",
    "fleet_restore": "Restoring a specialist",
}
_FILE_READ = {"read_file", "search_files", "list_files"}
_FILE_WRITE = {"write_file", "patch", "edit_file"}


def _calls(tool_calls: Any) -> list[tuple[str, dict]]:
    """(name, arguments) of each call; a deferred call through `tool_call` counts as the tools it runs."""
    out: list[tuple[str, dict]] = []
    try:
        parsed = json.loads(tool_calls) if isinstance(tool_calls, str) else tool_calls
    except (TypeError, ValueError):
        return out
    for tc in parsed if isinstance(parsed, list) else []:
        if not isinstance(tc, dict):
            continue
        fn = subdict(tc, "function")
        name = str(tc.get("name") or fn.get("name") or "")
        raw = fn.get("arguments", tc.get("arguments"))
        try:
            args = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (TypeError, ValueError):
            args = {}
        if name == "tool_call" and isinstance(args, dict):
            inner = sublist(args, "calls")
            for call in inner:
                if isinstance(call, dict) and call.get("name"):
                    out.append((str(call["name"]), subdict(call, "arguments")))
            if inner:
                continue
        out.append((name, args if isinstance(args, dict) else {}))
    return out


def _in_folder(path: str, folder: str) -> bool:
    if not path or not folder:
        return False
    try:
        return Path(path).resolve().is_relative_to(Path(folder).resolve())
    except (OSError, ValueError):
        return False


def step_label(name: str, args: dict, vault: str = "") -> str:
    """One step in plain words."""
    if name in _FILE_READ or name in _FILE_WRITE:
        path = str(args.get("path") or args.get("file_path") or args.get("directory") or "")
        brain = _in_folder(path, vault)
        if name in _FILE_WRITE:
            return "Writing to your Second Brain" if brain else "Writing a file"
        return "Reading your Second Brain" if brain else "Reading files"
    if name == "skill_view":
        skill = str(args.get("name") or "").strip()
        if skill in ("second-brain", "second-brain-writes") or skill.startswith("obsidian"):
            return "Reading your Second Brain rules"
        return f"Reading the {skill} skill" if skill else "Reading a skill"
    if name.startswith("kanban"):
        return "Updating the task board"
    if name.startswith("browser"):
        return "Using the browser"
    if name in _FRIENDLY:
        return _FRIENDLY[name]
    return f"Using {name.replace('_', ' ')}" if name else "Working"


# Live steps. Hermes tells a status-capable adapter about each tool as it starts (`set_status_text`,
# with a phrase built by `agent.display.build_status_phrase`); the turn's rows reach the database only
# when it ends. The phrase drops what the app wants to say ("is using fleet_roster", a file name
# without its folder), so the tool and arguments behind the next phrase are noted as it is built, on
# the same thread, and labelled here. Without that (a Hermes that builds phrases differently) the
# phrase itself is used, tidied.
_tls = threading.local()
_live_lock = threading.Lock()
_live: dict[str, list[tuple[float, str | None]]] = {}
_vault_cache: tuple[float, str] = (0.0, "")


def vault_path() -> str:
    """The Second Brain folder, cached briefly (step labels ask on every tool)."""
    global _vault_cache
    now = time.monotonic()
    if _vault_cache[0] and now - _vault_cache[0] < 30:
        return _vault_cache[1]
    try:
        from . import second_brain

        path = str(second_brain.status().get("path") or "")
    except Exception:
        path = ""
    _vault_cache = (now, path)
    return path


def install_status_capture() -> bool:
    """Note the tool behind each status phrase Hermes builds. Idempotent; False if Hermes lacks the hook."""
    try:
        import agent.display as display
    except Exception:
        return False
    current = getattr(display, "build_status_phrase", None)
    if current is None:
        return False
    if getattr(current, "_chief_capture", False):
        return True

    def build_status_phrase(tool_name, args, *rest, **kw):
        _tls.last = (str(tool_name or ""), args if isinstance(args, dict) else {})
        return current(tool_name, args, *rest, **kw)

    build_status_phrase._chief_capture = True  # type: ignore[attr-defined]
    display.build_status_phrase = build_status_phrase
    return True


def _tidy(phrase: str) -> str:
    text = str(phrase or "").strip().rstrip("…").rstrip(".").strip()
    if text.lower().startswith("is "):
        text = text[3:]
    return text[:1].upper() + text[1:] if text else "Working"


def record_status(chat_id: str, phrase: str | None) -> None:
    """A tool started (`phrase`) or finished (None) in this chat's running turn."""
    last = getattr(_tls, "last", None)
    _tls.last = None
    label = None
    if phrase:
        label = step_label(last[0], last[1], vault_path()) if last and last[0] else _tidy(phrase)
    with _live_lock:
        steps = _live.setdefault(str(chat_id or ""), [])
        steps.append((time.time(), label))
        del steps[:-80]


def live_steps(chat_id: str, since: float) -> list[tuple[float, str | None]]:
    with _live_lock:
        return [s for s in _live.get(str(chat_id or ""), []) if s[0] >= since]


def activity(session_key: str, generating: bool, vault: str = "", chat_id: str = "") -> dict[str, Any] | None:
    """While a turn runs: when it started, how many steps it has taken, and what it's doing now."""
    if not generating or not session_key:
        return None
    db_path = chief_home() / "state.db"
    if not db_path.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            sid = _message_session_id(conn, session_key)
            rows = conn.execute(
                "SELECT id, role, tool_calls, CAST(timestamp AS REAL) AS t FROM messages WHERE session_id = ? AND active = 1 ORDER BY id DESC LIMIT 60",
                (sid,),
            ).fetchall()
        finally:
            conn.close()
    except Exception:
        logger.debug("activity read failed", exc_info=True)
        return None
    turn: list[sqlite3.Row] = []
    for row in rows:  # newest first, back to the owner's message that started this turn
        if row["role"] == "user":
            since = float(row["t"] or 0)
            break
        turn.append(row)
    else:
        since = float(rows[-1]["t"] or 0) if rows else 0.0
    live = live_steps(chat_id, since) if chat_id else []
    if live:
        started = [label for _, label in live if label]
        newest = live[-1][1]
        return {"since": since, "steps": len(started), "label": newest or "Thinking it over"}
    steps = sum(len(_calls(r["tool_calls"])) for r in turn if r["role"] == "assistant")
    label = "Thinking"
    if turn:
        newest = turn[0]
        if newest["role"] == "assistant" and newest["tool_calls"]:
            calls = _calls(newest["tool_calls"])
            labels = list(dict.fromkeys(step_label(n, a, vault) for n, a in calls))
            label = labels[0] if len(labels) == 1 else (labels[0] + " and more" if labels else "Working")
        elif newest["role"] == "tool":
            label = "Thinking it over"
    return {"since": since, "steps": steps, "label": label}
