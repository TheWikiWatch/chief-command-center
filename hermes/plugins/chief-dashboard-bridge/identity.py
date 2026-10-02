"""Who the chief is and who owns this install, for Hermes events and phone alerts.

- owner_id: the Command Center chat id. It is part of the session key
  (agent:main:command_center:dm:<owner_id>), so an existing install keeps its value
  (COMMAND_CENTER_HOME_CHANNEL); a new one uses "owner".
- owner_name: how the chief sees the person it talks to (CHIEF_OWNER_NAME; empty means "the user").
- assistant_name: the chief's own name, read from its profile title ("Name - Role"), else "Chief".
- push_contact: the VAPID contact push services may use about misbehaving senders
  (CHIEF_PUSH_CONTACT, a mailto: or https: URL).
"""

from __future__ import annotations

import os
import re
import time
from .util import subdict

DEFAULT_OWNER_ID = "owner"
DEFAULT_ASSISTANT = "Chief"
DEFAULT_PUSH_CONTACT = "https://github.com/TheWikiWatch/chief-command-center"

_cache: dict[str, tuple[float, str]] = {}


def owner_id() -> str:
    return (os.environ.get("COMMAND_CENTER_HOME_CHANNEL") or "").strip() or DEFAULT_OWNER_ID


def owner_name() -> str:
    return (os.environ.get("CHIEF_OWNER_NAME") or "").strip()


def owner_label() -> str:
    """For Hermes's chat and user name fields, which must not be empty."""
    return owner_name() or "User"


def split_title(title: str) -> str:
    match = re.match(r"^(.{1,60}?)\s+[-–—|:]\s+(.+)$", (title or "").strip())
    return (match.group(1) if match else (title or "")).strip()


def assistant_name(ttl: float = 30.0) -> str:
    hit = _cache.get("assistant")
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    name = _assistant_from_profile() or DEFAULT_ASSISTANT
    _cache["assistant"] = (time.monotonic(), name)
    return name


def _assistant_from_profile() -> str | None:
    try:
        from .data import chief_home, load_yaml

        meta = load_yaml(chief_home() / "profile.yaml")
        ui = subdict(meta, "ui_meta")
        bots = subdict(ui, "hermes-bots")
        return split_title(str(bots.get("title") or "")) or None
    except Exception:
        return None


def push_contact() -> str:
    value = (os.environ.get("CHIEF_PUSH_CONTACT") or "").strip()
    if value.startswith(("mailto:", "https://")):
        return value
    return DEFAULT_PUSH_CONTACT
