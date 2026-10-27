"""Small helpers shared by the bridge modules (no Hermes imports, safe to import from anywhere)."""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("chief-dashboard-bridge")

TRY_AGAIN = "That didn't work. Try again."


def subdict(parent: Any, key: str) -> dict:
    """`parent[key]` when both are dicts, else an empty dict (YAML and JSON from disk can hold anything)."""
    value = parent.get(key) if isinstance(parent, dict) else None
    return value if isinstance(value, dict) else {}


def sublist(parent: Any, key: str) -> list:
    """`parent[key]` when it is a list, else an empty list."""
    value = parent.get(key) if isinstance(parent, dict) else None
    return value if isinstance(value, list) else []


def owner_error(exc: BaseException, known: tuple[type[BaseException], ...] = (), fallback: str = TRY_AGAIN, *, what: str = "bridge action") -> str:
    """What the owner reads when something failed. The bridge's own error types (`known`) are written as plain
    sentences and keep theirs; any other exception's text can carry a path with the owner's home folder, a command
    line or a key, so it becomes `fallback` and only its type goes to the log."""
    if known and isinstance(exc, known):
        text = " ".join(str(exc).split())
        if text:
            return text
    logger.warning("chief-dashboard-bridge: %s failed: %s", what, type(exc).__name__)
    logger.debug("chief-dashboard-bridge: %s failure", what, exc_info=exc)
    return fallback


def write_json_atomic(path: Path, value: Any, *, indent: int | None = 2, sort_keys: bool = False) -> None:
    """Write JSON through a temp file of its own and swap it in: two writers never share a temp name, and a reader
    never sees half a file."""
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_text(json.dumps(value, indent=indent, sort_keys=sort_keys), encoding="utf-8")
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
