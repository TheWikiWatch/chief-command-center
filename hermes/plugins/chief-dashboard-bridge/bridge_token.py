"""The bridge's bearer token, held in this process only.

The desktop app hands the token to the gateway as ``CHIEF_DASHBOARD_TOKEN``. Hermes builds every child's
environment from ``os.environ`` at spawn time, and its secret scrub doesn't know this name, so a token left in
the environment reaches the agent's own terminal and code children: a prompt-injected command could then call
``/approve`` on its own pending approval. ``take()`` reads it once and removes it from the environment.

Hermes can import the plugin a second time in the same gateway process (a fresh copy, its module globals empty).
That copy must still find the token, or it stops before registering the Command Center platform and Hermes then
refuses every message from the dashboard ("Unauthorized user"). So the token lives in a holder registered in
``sys.modules``, which outlives any copy of the plugin's own modules: memory of this process only, never a file
or the environment.
"""

from __future__ import annotations

import os
import sys
import threading
import types

ENV = "CHIEF_DASHBOARD_TOKEN"
_HOLDER = "_chief_dashboard_bridge_token"
_lock = threading.Lock()


def _holder() -> types.ModuleType:
    held = sys.modules.get(_HOLDER)
    if held is None:
        held = types.ModuleType(_HOLDER)
        held.token = ""  # type: ignore[attr-defined]
        sys.modules[_HOLDER] = held
    return held


def take(configured: str = "") -> str:
    """The token (plugin config, then the environment, then what an earlier copy of the plugin took), removed from
    the environment. Never a file: a plain-text ``.token`` beside the plugin was readable by the agent's own file
    tools (the app removes it and rotates)."""
    with _lock:
        held = _holder()
        env_value = os.environ.pop(ENV, "").strip()
        held.token = str(configured or "").strip() or env_value or str(getattr(held, "token", "") or "")  # type: ignore[attr-defined]
        return held.token  # type: ignore[attr-defined]


def get() -> str:
    """The token taken at registration; outside the gateway (a separate cron process) the environment."""
    with _lock:
        return str(getattr(_holder(), "token", "") or "") or os.environ.get(ENV, "").strip()
