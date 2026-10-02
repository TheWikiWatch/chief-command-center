"""Separate conversations with the chief (contract `chief.threads.v1`).

Each thread is its own chat on the Command Center platform, so Hermes gives it its own session: the main
thread is the owner's chat (`owner`, the session the app has always used) and every other thread is
`owner.t-<id>`. Hermes runs one turn per session and sessions side by side, and keys everything else per
chat or session too: whether it is busy, its open question, its live steps, `/stop`, `/queue` and steering.
Memory, skills and the Second Brain belong to the profile, so every thread shares them.

The list (titles, archived or not) is `command_center_threads.json` in the chief's profile. A thread's title is
the owner's, else the title Hermes gave its latest session.
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

from . import identity
from .data import chief_home

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.threads.v1"
MAIN = "main"
FILE = "command_center_threads.json"
_ID = re.compile(r"^t-[0-9a-f]{6,12}$")
_lock = threading.Lock()
_MAX_TITLE = 60


class ThreadError(ValueError):
    pass


def _path() -> Path:
    return chief_home() / FILE


def _load() -> dict[str, Any]:
    try:
        value = json.loads(_path().read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("threads"), list):
            return value
    except (OSError, ValueError):
        pass
    return {"threads": []}


def _save(state: dict[str, Any]) -> None:
    path = _path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def valid(thread: str) -> bool:
    return thread == MAIN or bool(_ID.match(thread or ""))


def chat_id(thread: str) -> str:
    """The thread's chat id on the Command Center platform."""
    owner = identity.owner_id()
    return owner if not thread or thread == MAIN else f"{owner}.{thread}"


def session_key(thread: str) -> str:
    return f"agent:main:command_center:dm:{chat_id(thread)}"


def thread_of(chat: str) -> str:
    """The thread a chat id belongs to (an unknown chat is the main thread)."""
    owner = identity.owner_id()
    prefix = f"{owner}."
    if chat and chat.startswith(prefix) and _ID.match(chat[len(prefix):]):
        return chat[len(prefix):]
    return MAIN


def exists(thread: str) -> bool:
    if thread == MAIN:
        return True
    return any(t.get("id") == thread for t in _load()["threads"])


def _sessions(key: str) -> list[dict[str, Any]]:
    """Every Hermes session of a thread's key, newest first (a fresh start adds one)."""
    db = chief_home() / "state.db"
    if not db.is_file():
        return []
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT id, title, started_at, ended_at, last_activity_at, message_count FROM sessions "
                "WHERE session_key = ? ORDER BY COALESCE(last_activity_at, started_at) DESC", (key,)).fetchall()
        finally:
            conn.close()
        return [dict(r) for r in rows]
    except sqlite3.Error:
        logger.debug("thread sessions read failed", exc_info=True)
        return []


def previous_sessions(thread: str) -> list[dict[str, Any]]:
    """The thread's earlier conversations (before its fresh starts), newest first."""
    rows = _sessions(session_key(thread))[1:]
    return [{"id": r["id"], "title": str(r.get("title") or ""), "started": float(r.get("started_at") or 0),
             "ended": float(r.get("last_activity_at") or r.get("ended_at") or 0), "messages": int(r.get("message_count") or 0)}
            for r in rows if int(r.get("message_count") or 0) > 0]


def describe(thread: str, entry: Optional[dict[str, Any]] = None, *, busy=None, question=None, approval=None) -> dict[str, Any]:
    key = session_key(thread)
    sessions = _sessions(key)
    latest = sessions[0] if sessions else {}
    owner_title = str((entry or {}).get("title") or "")
    title = owner_title or (str(latest.get("title") or "") if thread != MAIN else "") or ("Main" if thread == MAIN else "New thread")
    return {
        "id": thread,
        "title": title,
        "named": bool(owner_title),
        "sessionKey": key,
        "created": float((entry or {}).get("created") or (latest.get("started_at") or 0)),
        "archived": bool((entry or {}).get("archived")),
        "lastActivity": float(latest.get("last_activity_at") or latest.get("started_at") or (entry or {}).get("created") or 0),
        "working": bool(busy(key)) if busy else False,
        "question": bool(question(key)) if question else False,
        "approval": bool(approval(key)) if approval else False,
    }


def any_working(busy) -> bool:
    """Whether any thread other than the main one is working, from the in-memory busy check alone (no database
    read: /snapshot asks every few seconds)."""
    for entry in _load()["threads"]:
        tid = str(entry.get("id") or "")
        if tid != MAIN and _ID.match(tid) and busy(session_key(tid)):
            return True
    return False


def list_threads(*, busy=None, question=None, approval=None) -> dict[str, Any]:
    state = _load()
    main_entry = next((t for t in state["threads"] if t.get("id") == MAIN), None)
    items = [describe(MAIN, main_entry, busy=busy, question=question, approval=approval)]
    for entry in state["threads"]:
        if entry.get("id") == MAIN or not _ID.match(str(entry.get("id") or "")):
            continue
        items.append(describe(entry["id"], entry, busy=busy, question=question, approval=approval))
    items[1:] = sorted(items[1:], key=lambda t: -t["lastActivity"])
    return {"ok": True, "contract": CONTRACT, "threads": items}


def _clean_title(title: str) -> str:
    title = " ".join(str(title or "").split())
    if len(title) > _MAX_TITLE:
        raise ThreadError(f"Keep the title under {_MAX_TITLE} characters.")
    return title


def create(title: str = "") -> dict[str, Any]:
    title = _clean_title(title)
    with _lock:
        state = _load()
        thread = f"t-{secrets.token_hex(4)}"
        state["threads"].append({"id": thread, "title": title, "created": time.time(), "archived": False})
        _save(state)
    logger.info("threads: created %s", thread)
    return {"ok": True, "thread": describe(thread, state["threads"][-1])}


def _update(thread: str, **changes: Any) -> dict[str, Any]:
    if not valid(thread):
        raise ThreadError("Unknown thread.")
    with _lock:
        state = _load()
        entry = next((t for t in state["threads"] if t.get("id") == thread), None)
        if entry is None:
            if thread != MAIN:
                raise ThreadError("Unknown thread.")
            entry = {"id": MAIN, "title": "", "created": time.time(), "archived": False}
            state["threads"].insert(0, entry)
        entry.update(changes)
        _save(state)
    return {"ok": True, "thread": describe(thread, entry)}


def rename(thread: str, title: str) -> dict[str, Any]:
    return _update(thread, title=_clean_title(title))


def archive(thread: str, archived: bool = True) -> dict[str, Any]:
    if thread == MAIN and archived:
        raise ThreadError("The main thread can't be archived.")
    return _update(thread, archived=bool(archived))
