"""The bridge's bearer token, held in this process only.

The desktop app hands the token to the gateway as ``CHIEF_DASHBOARD_TOKEN``. Hermes builds every child's
environment from ``os.environ`` at spawn time, and its secret scrub doesn't know this name, so a token left in
the environment reaches the agent's own terminal and code children: a prompt-injected command could then call
``/approve`` on its own pending approval. ``take()`` reads it once and removes it from the environment.
"""

from __future__ import annotations

import os
import threading

ENV = "CHIEF_DASHBOARD_TOKEN"
_lock = threading.Lock()
_token = ""


def take(configured: str = "") -> str:
    """The token (plugin config, then the environment), removed from the environment. Never a file: a plain-text
    ``.token`` beside the plugin was readable by the agent's own file tools (the app removes it and rotates)."""
    global _token
    with _lock:
        env_value = os.environ.pop(ENV, "").strip()
        _token = str(configured or "").strip() or env_value or _token
        return _token


def get() -> str:
    """The token taken at registration; outside the gateway (a separate cron process) the environment."""
    with _lock:
        return _token or os.environ.get(ENV, "").strip()
