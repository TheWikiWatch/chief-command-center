"""The adapter's outbox: every message the gateway sends to the Command Center, one JSON line each.

Kept apart from the adapter (which needs a running Hermes to import) so the bridge and tests can read it.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from . import identity


def _outbox_path() -> Path:
    from .data import chief_home

    return chief_home() / "command_center_outbox.jsonl"


def append_outbox(chat_id: str, message: str, *, source: str = "adapter") -> str:
    mid = uuid.uuid4().hex[:12]
    row = {
        "id": mid,
        "at": time.time(),
        "chat_id": chat_id or identity.owner_id(),
        "message": message,
        "source": source,
        "read": False,
    }
    path = _outbox_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return mid


def read_outbox(*, after_id: str = "", limit: int = 50) -> list[dict]:
    path = _outbox_path()
    if not path.is_file():
        return []
    rows: list[dict] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    seen = False if after_id else True
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not seen:
            if str(row.get("id")) == after_id:
                seen = True
            continue
        rows.append(row)
        if len(rows) >= limit:
            break
    return rows
