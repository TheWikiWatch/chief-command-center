"""The chief's terminal in the installed app: Hermes's own node, npm and Python, copied out of the package.

Since 0.22.5 Hermes runs terminal commands with copies of its bundled node, npm and Python made outside the app's
package, because inside it a program from elsewhere can't start them (`pm/user_facing.py`). It makes the copies the
first time a command runs: about two and a half minutes, and some 280 MB, on a fresh install or after an update moves
those versions, while the chief's first command (and its approval) waits. So the bridge has Hermes make them in the
background when the gateway starts. A command that comes meanwhile waits on Hermes's install lock for what's left;
copies made before are found in about a second.
"""

from __future__ import annotations

import logging
import os
import threading
import time

from . import hermes_api
from .data import chief_config_scope

logger = logging.getLogger("chief-dashboard-bridge")


def warm_with_gateway() -> None:
    def run() -> None:
        try:
            user_facing_path = hermes_api.get("pm.user_facing", "user_facing_path")
        except hermes_api.HermesMissing:
            return  # logged once by hermes_api, and reported on /health
        started = time.monotonic()
        try:
            with chief_config_scope():
                user_facing_path(os.environ.get("PATH", ""))
            logger.info("terminal: Hermes's tool copies ready (%.1fs)", time.monotonic() - started)
        except Exception:
            logger.warning("terminal: Hermes's tool copies weren't made; the first command makes them", exc_info=True)

    threading.Thread(target=run, name="chief-terminal-tools", daemon=True).start()
