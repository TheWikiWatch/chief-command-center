"""The adapter's outbox: every message the gateway sends to the Command Center, one JSON line each.

Kept apart from the adapter (which needs a running Hermes to import) so the bridge and tests can read it.

The file is read incrementally: rows already parsed are kept in memory with the byte offset they end at, and a
read parses only what was appended since (a smaller file means it was compacted, and it is read again). Appends
from this process are serialized; a scheduled job run by a separate Hermes process may append too, which is why
compaction checks that the file didn't grow while it was being rewritten. Compaction keeps 30 days, and never
fewer than the last 500 rows, once the file passes 2 MB.
"""

from __future__ import annotations

import bisect
import json
import os
import threading
import time
import uuid
from pathlib import Path

from . import changes
from . import identity

KEEP_DAYS = 30
KEEP_MIN_ROWS = 500
COMPACT_BYTES = 2 * 1024 * 1024

_lock = threading.RLock()
_cache: dict[str, object] = {"path": "", "offset": 0, "rows": [], "times": []}


def _outbox_path() -> Path:
    from .data import chief_home

    return chief_home() / "command_center_outbox.jsonl"


def _parse(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _rows() -> list[dict]:
    """Every row, oldest first, parsing only what was appended since the last read."""
    path = _outbox_path()
    with _lock:
        if _cache["path"] != str(path):
            _cache.update(path=str(path), offset=0, rows=[], times=[])
        try:
            size = path.stat().st_size
        except OSError:
            _cache.update(offset=0, rows=[], times=[])
            return []
        offset = int(_cache["offset"])  # type: ignore[arg-type]
        if size < offset:
            offset = 0
            _cache.update(rows=[], times=[])
        if size > offset:
            try:
                with open(path, "rb") as f:
                    f.seek(offset)
                    chunk = f.read(size - offset)
            except OSError:
                return list(_cache["rows"])  # type: ignore[arg-type]
            # Only whole lines: a row still being written by another process is read next time.
            end = chunk.rfind(b"\n") + 1
            if end:
                new = _parse(chunk[:end].decode("utf-8", "ignore"))
                rows: list[dict] = _cache["rows"]  # type: ignore[assignment]
                times: list[float] = _cache["times"]  # type: ignore[assignment]
                rows.extend(new)
                times.extend(float(r.get("at") or 0) for r in new)
                _cache["offset"] = offset + end
        return list(_cache["rows"])  # type: ignore[arg-type]


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
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        try:
            if path.stat().st_size > COMPACT_BYTES:
                compact()
        except OSError:
            pass
    changes.bump("outbox")
    return mid


def compact(now: float | None = None) -> int:
    """Drop rows older than KEEP_DAYS (keeping at least the newest KEEP_MIN_ROWS). Returns how many were dropped."""
    path = _outbox_path()
    cutoff = (now or time.time()) - KEEP_DAYS * 86400
    with _lock:
        try:
            before = path.stat().st_size
            rows = _parse(path.read_text(encoding="utf-8"))
        except OSError:
            return 0
        keep_from = len(rows)
        for i, row in enumerate(rows):
            if float(row.get("at") or 0) >= cutoff:
                keep_from = i
                break
        keep_from = min(keep_from, max(0, len(rows) - KEEP_MIN_ROWS))
        if keep_from == 0:
            return 0
        kept = rows[keep_from:]
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in kept), encoding="utf-8")
        try:
            # Another process appended meanwhile: keep the file as it is and try again at the next append.
            if path.stat().st_size != before:
                tmp.unlink(missing_ok=True)
                return 0
            os.replace(tmp, path)
        except OSError:
            tmp.unlink(missing_ok=True)
            return 0
        _cache.update(path=str(path), offset=0, rows=[], times=[])
        return keep_from


def read_since(at: float) -> list[dict]:
    """Rows sent at or after `at`, oldest first (a binary search over the cached rows)."""
    rows = _rows()
    with _lock:
        times: list[float] = _cache["times"]  # type: ignore[assignment]
        start = bisect.bisect_left(times, at) if len(times) == len(rows) else 0
    return [r for r in rows[start:] if float(r.get("at") or 0) >= at]


def head_id() -> str:
    """The newest row's id."""
    rows = _rows()
    return str(rows[-1].get("id") or "") if rows else ""


def read_outbox(*, after_id: str = "", limit: int = 50) -> list[dict]:
    """Rows after `after_id`, at most `limit` (all rows from the start when it is empty). An id that isn't there
    (unknown, or compacted away) gives nothing, as before: the desktop notifier pages with it, and re-reading
    from the start would announce old notices again."""
    rows = _rows()
    start = 0
    if after_id:
        start = -1
        for i in range(len(rows) - 1, -1, -1):
            if str(rows[i].get("id")) == after_id:
                start = i + 1
                break
        if start < 0:
            return []
    return rows[start : start + limit]
