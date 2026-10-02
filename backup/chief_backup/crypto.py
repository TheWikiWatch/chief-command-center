"""Passphrase encryption for .chiefbackup files.

Layout: MAGIC, a 4-byte big-endian header length, a JSON header, then chunks. Each chunk is a 4-byte length and
AES-256-GCM ciphertext of up to CHUNK bytes. scrypt (N=2^17, r=8, p=1) over the passphrase and a random salt
gives 64 bytes: the AES key, and a verifier whose hash is in the header, so a wrong passphrase is told apart
from a damaged file before any chunk is read. Every chunk's nonce is an 8-byte random prefix plus the 4-byte chunk index, and its
associated data binds the header, the index and a final-chunk flag, so chunks can't be reordered, dropped or
truncated without the tag check failing. A wrong passphrase fails on the first chunk.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import struct
from pathlib import Path
from typing import BinaryIO

MAGIC = b"CHIEFBK1\n"
CHUNK = 1 << 20
_SCRYPT = {"n": 1 << 17, "r": 8, "p": 1}


class BadPassphrase(ValueError):
    pass


class CorruptBackup(ValueError):
    pass


def is_encrypted(path: Path) -> bool:
    with open(path, "rb") as handle:
        return handle.read(len(MAGIC)) == MAGIC


def _keys(passphrase: str, salt: bytes, n: int, r: int, p: int) -> tuple[bytes, str]:
    """(AES key, passphrase check) from one scrypt derivation."""
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

    if not passphrase:
        raise BadPassphrase("Enter the backup's passphrase.")
    material = Scrypt(salt=salt, length=64, n=n, r=r, p=p).derive(passphrase.encode("utf-8"))
    return material[:32], hashlib.sha256(b"chief-backup-check" + material[32:]).hexdigest()[:32]


def _aad(header: bytes, index: int, final: bool) -> bytes:
    return header + struct.pack(">I?", index, final)


def encrypt_file(src: Path, dst: BinaryIO, passphrase: str) -> None:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    salt = os.urandom(16)
    prefix = os.urandom(8)
    key, check = _keys(passphrase, salt, **_SCRYPT)
    header = json.dumps(
        {
            "v": 1,
            "cipher": "AES-256-GCM",
            "kdf": "scrypt",
            **_SCRYPT,
            "salt": base64.b64encode(salt).decode(),
            "nonce": base64.b64encode(prefix).decode(),
            "chunk": CHUNK,
            "check": check,
        },
        sort_keys=True,
    ).encode()
    aes = AESGCM(key)
    dst.write(MAGIC + struct.pack(">I", len(header)) + header)
    size = src.stat().st_size
    index = 0
    with open(src, "rb") as handle:
        while True:
            block = handle.read(CHUNK)
            final = handle.tell() >= size
            sealed = aes.encrypt(prefix + struct.pack(">I", index), block, _aad(header, index, final))
            dst.write(struct.pack(">I", len(sealed)) + sealed)
            index += 1
            if final:
                break


def decrypt_file(src: Path, dst: BinaryIO, passphrase: str) -> None:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    with open(src, "rb") as handle:
        if handle.read(len(MAGIC)) != MAGIC:
            raise CorruptBackup("This isn't an encrypted Chief backup.")
        try:
            (length,) = struct.unpack(">I", handle.read(4))
            header = handle.read(length)
            meta = json.loads(header)
            salt, prefix = base64.b64decode(meta["salt"]), base64.b64decode(meta["nonce"])
            n, r, p = int(meta["n"]), int(meta["r"]), int(meta["p"])
            expected = str(meta["check"])
        except (struct.error, ValueError, KeyError, TypeError) as exc:
            raise CorruptBackup("The backup's header is damaged.") from exc
        if n > 1 << 20 or r > 32 or p > 16:
            raise CorruptBackup("The backup's header is damaged.")
        key, check = _keys(passphrase, salt, n, r, p)
        if not hmac.compare_digest(check, expected):
            raise BadPassphrase("That passphrase doesn't open this backup.")
        aes = AESGCM(key)
        index = 0
        while True:
            raw = handle.read(4)
            if len(raw) < 4:
                raise CorruptBackup("The backup file is incomplete.")
            (length,) = struct.unpack(">I", raw)
            sealed = handle.read(length)
            if len(sealed) != length:
                raise CorruptBackup("The backup file is incomplete.")
            nonce = prefix + struct.pack(">I", index)
            final = handle.peek(1)[:1] == b"" if hasattr(handle, "peek") else False
            try:
                block = aes.decrypt(nonce, sealed, _aad(header, index, final))
            except InvalidTag:
                try:  # the chunk is intact but the file ends in the wrong place: truncated
                    aes.decrypt(nonce, sealed, _aad(header, index, not final))
                except InvalidTag:
                    raise CorruptBackup("The backup file is damaged.") from None
                raise CorruptBackup("The backup file is incomplete.") from None
            dst.write(block)
            index += 1
            if final:
                return
