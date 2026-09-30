"""Chief Command Center loopback bridge: an HTTP server inside the chief's gateway.

No tools, no model, no SOUL. Registers the Command Center messaging platform (the app's chat), reads
profiles, kanban and the Command Center session, injects the owner's turns, and sends phone alerts.
If Command Center is disabled it falls back to a Discord DM session.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from pathlib import Path

from .server import BridgeServer

logger = logging.getLogger("chief-dashboard-bridge")

_server: BridgeServer | None = None
_register_lock = threading.Lock()


def _argv_tokens() -> list[str]:
    return [str(a).lower() for a in sys.argv]


def _is_gateway_run(argv: list[str]) -> bool:
    try:
        idx = argv.index("gateway")
    except ValueError:
        return False
    return idx + 1 < len(argv) and argv[idx + 1] == "run"


def _running_in_gateway() -> bool:
    from .data import is_chief_home

    argv = _argv_tokens()
    if "serve" in argv:
        return False
    if not _is_gateway_run(argv):
        return False
    return is_chief_home()


def register(ctx):
    global _server
    if not _running_in_gateway():
        logger.info("chief-dashboard-bridge: skip bind outside gateway (pid=%s)", os.getpid())
        return
    with _register_lock:
        if _server is not None:
            logger.info("chief-dashboard-bridge already bound; ignoring second register()")
            return
        _register(ctx)


def _register(ctx):
    global _server
    plugin_dir = Path(__file__).resolve().parent
    token = (
        str(ctx.get_config("token", "") or "").strip()
        or os.environ.get("CHIEF_DASHBOARD_TOKEN", "").strip()
        or _read_token(plugin_dir)
    )
    port_cfg = ctx.get_config("port", None)
    session_cfg = ctx.get_config("session_key", "")
    if not token:
        logger.error("chief-dashboard-bridge: no token; refusing to bind")
        return

    port = int(port_cfg or os.environ.get("CHIEF_DASHBOARD_PORT") or 7790)
    session_key = str(session_cfg or os.environ.get("CHIEF_DASHBOARD_SESSION_KEY") or "").strip()

    server = BridgeServer(
        token=token,
        port=port,
        session_key_override=session_key,
        inject=lambda content, sk: bool(ctx.inject_message(content, role="user", session_key=sk)),
    )

    def on_discord(native, adapter):
        server.set_discord_bot(native)
        server.set_discord_adapter(adapter)

    try:
        ctx.register_platform_handler("discord", on_discord)
    except Exception:
        logger.warning("chief-dashboard-bridge: could not register discord handler", exc_info=True)

    # Attach an already-supported Command Center platform when available.
    # Without this callback the bridge deliberately keeps the Discord binding.
    try:
        from .adapter import register_platform
        register_platform(ctx)
        ctx.register_platform_handler(
            "command_center", lambda native, adapter: server.set_command_center_adapter(adapter)
        )
    except Exception:
        logger.warning("Command Center adapter unavailable; using Discord", exc_info=True)

    thread = threading.Thread(target=server.serve_forever, name="chief-dashboard-bridge", daemon=True)
    thread.start()
    _server = server
    logger.info("chief-dashboard-bridge listening on 127.0.0.1:%s", port)


def _read_token(plugin_dir: Path) -> str:
    path = plugin_dir / ".token"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
