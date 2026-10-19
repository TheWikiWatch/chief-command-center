"""The app's look (contract `chief.app_look.v1`): its accent colour and light, dark or system mode.

Kept on the bridge (`<chief home>/chief_app_look.json`) rather than in each browser, so every window and the phone
follow one choice, and so the chief can change it: Hermes 0.22's `set_theme` works only inside Hermes's own desktop
app (a callback into its window), so the bridge gives the bots their own `set_app_look`. A change is cosmetic and
reversible: no approval, the previous look is kept for Undo, and open windows restyle at once (a `cc_app_look`
event on the live channel).

Accents use Hermes's swatch ids (the colours themselves are the dashboard's, lib/app-look.ts), "theme" for the
app's own red, or any `#rrggbb`.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
import time
from typing import Any

from . import changes
from .data import chief_home

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.app_look.v1"
SWATCHES = ("theme", "mono", "green", "cyan", "nous", "violet", "pink", "red", "orange")
MODES = ("dark", "light", "system")
DEFAULT = {"accent": "theme", "mode": "dark"}
_FILE = "chief_app_look.json"
_HEX = re.compile(r"^#[0-9a-f]{6}$")
_lock = threading.Lock()


class LookError(ValueError):
    pass


def _clean(accent: Any, mode: Any) -> dict[str, str]:
    accent = str(accent or "").strip().lower()
    mode = str(mode or "").strip().lower()
    return {
        "accent": accent if accent in SWATCHES or _HEX.match(accent) else DEFAULT["accent"],
        "mode": mode if mode in MODES else DEFAULT["mode"],
    }


def _read() -> dict[str, Any]:
    try:
        doc = json.loads((chief_home() / _FILE).read_text(encoding="utf-8"))
        return doc if isinstance(doc, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(doc: dict[str, Any]) -> None:
    path = chief_home() / _FILE
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    tmp.replace(path)


def get() -> dict[str, Any]:
    doc = _read()
    look = _clean(doc.get("accent"), doc.get("mode"))
    previous = doc.get("previous") if isinstance(doc.get("previous"), dict) else None
    return {
        "ok": True,
        "contract": CONTRACT,
        **look,
        # Who made the current look: "owner" (Settings) or a bot's name, for "Changed by Chief · Undo".
        "by": str(doc.get("by") or "owner"),
        "at": float(doc.get("at") or 0),
        "canUndo": previous is not None,
    }


def _validate(accent: str | None, mode: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if accent is not None:
        text = str(accent).strip().lower()
        if not (text in SWATCHES or _HEX.match(text)):
            raise LookError(f"Unknown accent {accent!r}: use one of {', '.join(SWATCHES)} or a colour like #8b5cf6.")
        out["accent"] = text
    if mode is not None:
        text = str(mode).strip().lower()
        if text not in MODES:
            raise LookError(f"Unknown mode {mode!r}: use dark, light or system.")
        out["mode"] = text
    if not out:
        raise LookError("Say an accent, a mode, or both.")
    return out


def set_look(accent: str | None = None, mode: str | None = None, *, by: str = "owner") -> dict[str, Any]:
    change = _validate(accent, mode)
    with _lock:
        doc = _read()
        now = _clean(doc.get("accent"), doc.get("mode"))
        after = {**now, **change}
        if after != now:
            _write({**after, "by": by[:40] or "owner", "at": time.time(), "previous": now})
    if after != now:
        _announce()
    return get()


def undo() -> dict[str, Any]:
    with _lock:
        doc = _read()
        previous = doc.get("previous")
        if not isinstance(previous, dict):
            raise LookError("There's nothing to undo.")
        now = _clean(doc.get("accent"), doc.get("mode"))
        _write({**_clean(previous.get("accent"), previous.get("mode")), "by": "owner", "at": time.time(), "previous": now})
    _announce()
    return get()


def reset() -> dict[str, Any]:
    return set_look(DEFAULT["accent"], DEFAULT["mode"], by="owner")


def _announce() -> None:
    changes.bump("app_look")
    try:
        server = getattr(sys.modules.get(__package__ or ""), "_server", None)
        if server is not None:
            server.broadcast({"type": "cc_app_look", "at": time.time()})
    except Exception:
        logger.debug("app look announcement failed", exc_info=True)


def call(fn: Any) -> Any:
    try:
        return fn()
    except LookError as exc:
        return {"ok": False, "error": str(exc)}, 400


# ----------------------------------------------------------------------------- the bots

TOOL_SCHEMA = {
    "name": "set_app_look",
    "description": (
        "Change how the owner's Chief Command Center app looks: its accent colour and light, dark or system mode. "
        "It applies at once on every open window and phone, and the owner can undo it in Settings. Use it when the "
        'owner asks ("make it violet", "light mode please"); don\'t change the look unasked.'
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "accent": {
                "type": "string",
                "description": f"A swatch ({', '.join(s for s in SWATCHES if s != 'theme')}), 'theme' for the app's own red, or a colour '#rrggbb'.",
            },
            "mode": {"type": "string", "enum": list(MODES)},
        },
    },
}


def tool_handler(args: dict, **_kw: Any) -> str:
    args = args or {}
    accent = args.get("accent") if isinstance(args.get("accent"), str) and args.get("accent", "").strip() else None
    mode = args.get("mode") if isinstance(args.get("mode"), str) and args.get("mode", "").strip() else None
    try:
        from . import identity

        look = set_look(accent, mode, by=identity.assistant_name())
    except LookError as exc:
        return json.dumps({"success": False, "error": str(exc), "accents": list(SWATCHES), "modes": list(MODES)})
    except Exception as exc:
        logger.warning("set_app_look failed: %s", type(exc).__name__)
        return json.dumps({"success": False, "error": f"That didn't work ({type(exc).__name__})."})
    return json.dumps(
        {
            "success": True,
            "applied": {"accent": look["accent"], "mode": look["mode"]},
            "note": "Tell the owner what changed, and that Settings → General has Undo.",
        }
    )
