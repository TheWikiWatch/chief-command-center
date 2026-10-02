"""Small helpers shared by the bridge modules (no Hermes imports, safe to import from anywhere)."""

from __future__ import annotations

from typing import Any


def subdict(parent: Any, key: str) -> dict:
    """`parent[key]` when both are dicts, else an empty dict (YAML and JSON from disk can hold anything)."""
    value = parent.get(key) if isinstance(parent, dict) else None
    return value if isinstance(value, dict) else {}


def sublist(parent: Any, key: str) -> list:
    """`parent[key]` when it is a list, else an empty list."""
    value = parent.get(key) if isinstance(parent, dict) else None
    return value if isinstance(value, list) else []
