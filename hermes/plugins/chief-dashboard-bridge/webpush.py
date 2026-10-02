"""Web Push delivery: message encryption (RFC 8291, aes128gcm per RFC 8188) and VAPID (RFC 8292).

Built on `cryptography` and `requests`, both core Hermes dependencies, so phone alerts need no extra
package and no second interpreter. One function per concern:

- `encrypt(plaintext, p256dh, auth)` → the aes128gcm request body for one subscription.
- `vapid_authorization(endpoint, private_key, public_key_b64, subject)` → the Authorization header.
- `send(subscription, payload, ...)` → POST it; returns ("sent" | "gone" | "error", detail).
"""

from __future__ import annotations

import base64
import json
import os
import struct
import time
from typing import Any
from urllib.parse import urlparse

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hmac import HMAC

RECORD_SIZE = 4096


def b64url_decode(value: str) -> bytes:
    value = (value or "").strip()
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    mac = HMAC(salt, hashes.SHA256())
    mac.update(ikm)
    return mac.finalize()


def _hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    # One block is enough for every length used here (≤ 32 bytes).
    mac = HMAC(prk, hashes.SHA256())
    mac.update(info + b"\x01")
    return mac.finalize()[:length]


def _public_bytes(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def encrypt(plaintext: bytes, p256dh: str, auth: str, *, salt: bytes | None = None, sender_key: ec.EllipticCurvePrivateKey | None = None) -> bytes:
    """The aes128gcm body for one push subscription (`salt`/`sender_key` only for tests)."""
    ua_public = b64url_decode(p256dh)
    auth_secret = b64url_decode(auth)
    if len(ua_public) != 65 or len(auth_secret) < 16:
        raise ValueError("subscription keys are malformed")
    receiver = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    sender = sender_key or ec.generate_private_key(ec.SECP256R1())
    as_public = _public_bytes(sender.public_key())
    shared = sender.exchange(ec.ECDH(), receiver)
    # RFC 8291 §3.3-3.4: combine the ECDH secret with the subscription's auth secret.
    ikm = _hkdf_expand(_hkdf_extract(auth_secret, shared), b"WebPush: info\x00" + ua_public + as_public, 32)
    salt = salt or os.urandom(16)
    prk = _hkdf_extract(salt, ikm)
    cek = _hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12)
    # One record: the content, then the 0x02 last-record delimiter (RFC 8188 §2).
    if len(plaintext) + 1 + 16 > RECORD_SIZE:
        raise ValueError("push payload is too large for one record")
    ciphertext = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)
    header = salt + struct.pack("!IB", RECORD_SIZE, len(as_public)) + as_public
    return header + ciphertext


def vapid_authorization(endpoint: str, private_key: ec.EllipticCurvePrivateKey, subject: str, *, expires_in: int = 12 * 3600) -> str:
    """`vapid t=<JWT>, k=<public key>` for the push service that owns `endpoint` (RFC 8292)."""
    parsed = urlparse(endpoint)
    audience = f"{parsed.scheme}://{parsed.netloc}"
    header = b64url_encode(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64url_encode(json.dumps({"aud": audience, "exp": int(time.time()) + expires_in, "sub": subject}, separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}".encode("ascii")
    r, s = decode_dss_signature(private_key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    signature = b64url_encode(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    public = b64url_encode(_public_bytes(private_key.public_key()))
    return f"vapid t={header}.{claims}.{signature}, k={public}"


def send(
    subscription: dict[str, Any],
    payload: bytes,
    *,
    private_key: ec.EllipticCurvePrivateKey,
    subject: str,
    ttl: int,
    timeout: float,
    headers: dict[str, str] | None = None,
    session: Any = None,
) -> tuple[str, str]:
    """Deliver one encrypted push. ("sent", ""), ("gone", status) for an expired subscription, or ("error", why)."""
    import requests

    endpoint = str(subscription.get("endpoint") or "")
    keys = subscription.get("keys") or {}
    if not endpoint.startswith("https://"):
        return "error", "subscription endpoint is not https"
    try:
        body = encrypt(payload, str(keys.get("p256dh") or ""), str(keys.get("auth") or ""))
    except ValueError as exc:
        return "error", str(exc)
    request_headers = {
        "TTL": str(max(0, int(ttl))),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Authorization": vapid_authorization(endpoint, private_key, subject),
        **(headers or {}),
    }
    try:
        response = (session or requests).post(endpoint, data=body, headers=request_headers, timeout=timeout)
    except Exception as exc:  # network errors: the caller logs, the subscription stays
        return "error", f"{type(exc).__name__}: {exc}"[:200]
    if response.status_code in (200, 201, 202):
        return "sent", ""
    if response.status_code in (404, 410):
        return "gone", str(response.status_code)
    return "error", f"push service answered {response.status_code}: {response.text[:120]}"
