"""Chief Command Center loopback bridge: an HTTP server inside the chief's gateway.

No model, no SOUL. Registers the Command Center messaging platform (the app's chat), reads profiles, kanban
and the Command Center session, injects the owner's turns, and sends phone alerts. If Command Center is disabled
it falls back to a Discord DM session. Its one toolset, `fleet` (fleet.py), lets the chief mint, re-pin,
retire and restore its workers through the same code as the dashboard.
"""

from __future__ import annotations

import logging
import os
import sys
import threading

from .server import BridgeServer, note_legacy

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


LOG_BYTES = 2 * 1024 * 1024
LOG_KEEP = 3


def attach_log_file(home) -> logging.Handler | None:
    """The bridge's own rotating log in the chief's profile (`logs/chief-bridge.log`, 2 MB x 3), once per process.

    Hermes's console output already reaches the app's gateway log; this file keeps the bridge's warnings findable
    when that log has rolled over, and it is what the diagnostics bundle collects.
    """
    from logging.handlers import RotatingFileHandler
    from pathlib import Path

    for handler in logger.handlers:
        if getattr(handler, "_chief_bridge_file", False):
            return None
    try:
        folder = Path(home) / "logs"
        folder.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(folder / "chief-bridge.log", maxBytes=LOG_BYTES, backupCount=LOG_KEEP, encoding="utf-8")
    except OSError as exc:
        logger.warning("chief-dashboard-bridge: no log file (%s)", exc)
        return None
    handler._chief_bridge_file = True  # type: ignore[attr-defined]
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(handler)
    if logger.level == logging.NOTSET or logger.level > logging.INFO:
        logger.setLevel(logging.INFO)
    return handler


def _register_facts(ctx) -> None:
    """The owner's `CRITICAL_FACTS.md`, read when each of the chief's conversations starts (every process: the
    gateway, scheduled jobs and the terminal). The file is the only copy (second_brain.facts_prompt)."""
    add = getattr(ctx, "register_system_prompt_section", None)
    if add is None:
        logger.warning("chief-dashboard-bridge: this Hermes can't add prompt sections; the critical facts aren't given")
        return
    try:
        from . import second_brain

        add("chief-critical-facts", lambda _info: second_brain.facts_prompt(), max_chars=second_brain.FACTS_PROMPT_MAX)
    except ValueError:
        pass  # already registered in this process
    except Exception:
        logger.warning("chief-dashboard-bridge: critical facts section unavailable", exc_info=True)


def register(ctx):
    global _server
    _register_facts(ctx)
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
    from . import bridge_token

    # Read once and removed from the environment, so the agent's own commands never inherit it (bridge_token.py).
    token = bridge_token.take(str(ctx.get_config("token", "") or ""))
    port_cfg = ctx.get_config("port", None)
    session_cfg = ctx.get_config("session_key", "")
    if not token:
        logger.error("chief-dashboard-bridge: no token; refusing to bind")
        return

    try:
        from .data import chief_home

        attach_log_file(chief_home())
    except Exception:  # logging never stops the bridge
        logger.debug("chief-dashboard-bridge: log file setup failed", exc_info=True)

    # Every part of Hermes the bridge relies on, checked in the background; /health reports what's missing.
    from . import hermes_api

    hermes_api.check()

    port = int(port_cfg or os.environ.get("CHIEF_DASHBOARD_PORT") or 7790)
    session_key = str(session_cfg or os.environ.get("CHIEF_DASHBOARD_SESSION_KEY") or "").strip()

    bridge = BridgeServer(
        token=token,
        port=port,
        session_key_override=session_key,
        inject=lambda content, sk: bool(ctx.inject_message(content, role="user", session_key=sk)),
    )

    def on_discord(native, adapter):
        note_legacy("Discord platform connected")
        bridge.set_discord_bot(native)
        bridge.set_discord_adapter(adapter)

    try:
        ctx.register_platform_handler("discord", on_discord)
    except Exception:
        logger.warning("chief-dashboard-bridge: could not register discord handler", exc_info=True)

    # Attach an already-supported Command Center platform when available.
    # Without this callback the bridge deliberately keeps the Discord binding.
    try:
        from .adapter import register_platform

        register_platform(ctx)
        ctx.register_platform_handler("command_center", lambda native, adapter: bridge.set_command_center_adapter(adapter))
    except Exception:
        logger.warning("Command Center adapter unavailable; using Discord", exc_info=True)

    try:
        from .fleet import TOOLS

        for name, schema, handler, emoji in TOOLS:
            ctx.register_tool(name=name, toolset="fleet", schema=schema, handler=handler, emoji=emoji, description=schema.get("description", ""))
    except Exception:
        logger.warning("chief-dashboard-bridge: fleet tools unavailable", exc_info=True)

    thread = threading.Thread(target=bridge.serve_forever, name="chief-dashboard-bridge", daemon=True)
    thread.start()
    _server = bridge
    logger.info("chief-dashboard-bridge listening on 127.0.0.1:%s", port)
