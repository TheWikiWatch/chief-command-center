"""Phone-alert identity (VAPID key pair) and the list of subscribed devices, in the chief profile.

File names match the Command Center platform plugin that used to own them, so an existing install's
key pair — and with it every phone that already subscribed — carries over unchanged:

- command_center_vapid.json                   {"publicKey": <base64url P-256 point>, "private_pem": <PEM>}
- command_center_push_subscriptions.json      {"subscriptions": [{endpoint, keys: {p256dh, auth}}, ...]}

A new install gets a key pair the first time a device asks for the public key.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Optional

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from . import data
from .webpush import b64url_encode

_lock = threading.Lock()


def vapid_path() -> Path:
    return data.chief_home() / "command_center_vapid.json"


def subs_path() -> Path:
    return data.chief_home() / "command_center_push_subscriptions.json"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def load_vapid() -> Optional[dict[str, str]]:
    try:
        data = json.loads(vapid_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not data.get("private_pem") or not data.get("publicKey"):
        return None
    return {"publicKey": str(data["publicKey"]), "private_pem": str(data["private_pem"])}


def ensure_vapid() -> dict[str, str]:
    """The key pair, created (once) if this install has none."""
    with _lock:
        existing = load_vapid()
        if existing:
            return existing
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption()).decode("ascii")
        public = b64url_encode(key.public_key().public_bytes(serialization.Encoding.X962,
                                                             serialization.PublicFormat.UncompressedPoint))
        record = {"publicKey": public, "private_pem": pem}
        _atomic_write(vapid_path(), json.dumps(record, indent=2))
        return record


def public_key() -> str:
    return ensure_vapid()["publicKey"]


def private_key() -> ec.EllipticCurvePrivateKey:
    vapid = load_vapid()
    if not vapid:
        raise FileNotFoundError("no VAPID key pair")
    key = serialization.load_pem_private_key(vapid["private_pem"].encode("ascii"), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise ValueError("VAPID key is not an EC key")
    return key


def load_subs() -> list[dict[str, Any]]:
    try:
        data = json.loads(subs_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    subs = data.get("subscriptions") if isinstance(data, dict) else None
    return [s for s in (subs or []) if isinstance(s, dict) and s.get("endpoint")]


def save_subs(subs: list[dict[str, Any]]) -> None:
    with _lock:
        _atomic_write(subs_path(), json.dumps({"subscriptions": subs}, indent=2))


def upsert_subscription(sub: dict[str, Any]) -> dict[str, Any]:
    endpoint = str((sub or {}).get("endpoint") or "").strip()
    if not endpoint.startswith("https://"):
        return {"ok": False, "error": "missing endpoint"}
    keys = (sub or {}).get("keys") or {}
    if not keys.get("p256dh") or not keys.get("auth"):
        return {"ok": False, "error": "missing keys"}
    item = {
        "endpoint": endpoint,
        "keys": {"p256dh": str(keys["p256dh"]), "auth": str(keys["auth"])},
        "expirationTime": (sub or {}).get("expirationTime"),
    }
    subs = [s for s in load_subs() if s.get("endpoint") != endpoint]
    subs.append(item)
    save_subs(subs)
    return {"ok": True, "count": len(subs)}


def remove_subscription(endpoint: str) -> dict[str, Any]:
    endpoint = (endpoint or "").strip()
    before = load_subs()
    subs = [s for s in before if s.get("endpoint") != endpoint]
    save_subs(subs)
    return {"ok": True, "removed": len(before) - len(subs), "count": len(subs)}
