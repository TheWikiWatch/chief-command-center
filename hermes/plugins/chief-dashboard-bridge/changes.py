"""One change signal for everything the dashboard waits on.

Long-polls (`/transcript?wait=`) and the `/events` stream used to re-read Hermes's files and databases on a
timer, every half second per waiting client. Now whatever changes something they show bumps a counter and wakes
them: an outbox row (replies, notices, scheduled-job results), a question or its retirement, a live step, a
message handed to the agent, a new pending approval (the watch loop), and any commit to the chief's `state.db`
(transcript rows land there when a turn ends), seen through SQLite's `PRAGMA data_version` on one connection.
Waiters still re-check on a slow fallback timer, so a missed signal costs seconds, never correctness.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger("chief-dashboard-bridge")

_cond = threading.Condition()
_version = 0


def bump(reason: str = "") -> None:
    """Something the dashboard shows changed: wake every waiter."""
    global _version
    with _cond:
        _version += 1
        _cond.notify_all()


def version() -> int:
    with _cond:
        return _version


def wait(after: int, timeout: float) -> int:
    """Block until the version passes `after` or `timeout` seconds go by; returns the current version."""
    with _cond:
        _cond.wait_for(lambda: _version != after, timeout=max(0.0, timeout))
        return _version


class Watcher:
    """Bumps on every commit to the watched SQLite databases by another connection (`PRAGMA data_version`), and
    whenever an in-memory signature changes (which sessions are working, the pending approval): every 250 ms."""

    def __init__(self, paths: Callable[[], list[Path]], signature: Optional[Callable[[], object]] = None, every: float = 0.25):
        self._paths = paths
        self._signature = signature
        self._every = every
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="chief-change-watch", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        conns: dict[str, sqlite3.Connection] = {}
        seen: dict[str, int] = {}
        last_sig: object = None
        while not self._stop.wait(self._every):
            if self._signature is not None:
                try:
                    sig = self._signature()
                    if last_sig is not None and sig != last_sig:
                        bump("memory")
                    last_sig = sig
                except Exception:
                    logger.debug("signature check failed", exc_info=True)
            for path in self._paths():
                key = str(path)
                try:
                    conn = conns.get(key)
                    if conn is None:
                        if not path.is_file():
                            continue
                        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
                        conns[key] = conn
                        seen.pop(key, None)
                    current = int(conn.execute("PRAGMA data_version").fetchone()[0])
                    if key in seen and current != seen[key]:
                        bump(path.name)
                    seen[key] = current
                except sqlite3.Error:
                    # The file was replaced or locked for a moment (a restore, a migration): reopen next time.
                    logger.debug("%s watch: reopening", path.name, exc_info=True)
                    old = conns.pop(key, None)
                    if old is not None:
                        try:
                            old.close()
                        except sqlite3.Error:
                            pass
        for conn in conns.values():
            conn.close()
