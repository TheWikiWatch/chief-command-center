"""The bridge's bearer token, held in this process only.

The desktop app hands the token to the gateway as ``CHIEF_DASHBOARD_TOKEN``. Hermes builds every child's
environment from ``os.environ`` at spawn time, and its secret scrub doesn't know this name, so a token left in
the environment reaches the agent's own terminal and code children: a prompt-injected command could then call
``/approve`` on its own pending approval. ``take()`` reads it once and removes it from the environment.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

ENV = "CHIEF_DASHBOARD_TOKEN"
_lock = threading.Lock()
_token = ""


def _file_token() -> str:
    path = Path(__file__).resolve().with_name(".token")
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def take(configured: str = "") -> str:
    """The token (plugin config, then the environment, then a legacy ``.token`` file), removed from the environment."""
    global _token
    with _lock:
        env_value = os.environ.pop(ENV, "").strip()
        _token = str(configured or "").strip() or env_value or _token or _file_token()
        return _token


def get() -> str:
    """The token taken at registration; outside the gateway (a separate cron process) the environment or file."""
    with _lock:
        return _token or os.environ.get(ENV, "").strip() or _file_token()
