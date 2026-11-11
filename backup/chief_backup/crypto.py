"""Passphrase encryption for .chiefbackup files.

Layout: MAGIC, a 4-byte big-endian header length, a JSON header, then chunks. Each chunk is a 4-byte length and
AES-256-GCM ciphertext of up to CHUNK bytes. scrypt (N=2^17, r=8, p=1) over the passphrase and a random salt
gives 64 bytes: the AES key, and a verifier whose hash is in the header, so a wrong passphrase is told apart
from a damaged file before any chunk is read. Every chunk's nonce is an 8-byte random prefix plus the 4-byte chunk index, and its
associated data binds the header, the index and a final-chunk flag, so chunks can't be reordered, dropped or
truncated without the tag check failing. A wrong passphrase fails on the first chunk.

A backup is encrypted as it is zipped (`Encryptor`) and read back in place (`DecryptedView`): its plaintext never
exists as a file, at the destination or in a temporary folder.
"""

from __future__ import annotations

import base64
import bisect
import errno
import hashlib
import hmac
import io
import json
import os
import struct
from pathlib import Path
from typing import BinaryIO, Protocol

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


class Writable(Protocol):
    def write(self, data: bytes, /) -> int: ...
    def flush(self) -> None: ...


class Encryptor:
    """Encrypts what is written to it into `dst`, chunk by chunk (the layout above). It can't seek, so a zip written
    through it puts each entry's sizes after the entry's data and never goes back over what it wrote. `close()` seals
    the last chunk; it doesn't close `dst`."""

    def __init__(self, dst: Writable, passphrase: str):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        salt = os.urandom(16)
        self._prefix = os.urandom(8)
        key, check = _keys(passphrase, salt, **_SCRYPT)
        self._header = json.dumps(
            {
                "v": 1,
                "cipher": "AES-256-GCM",
                "kdf": "scrypt",
                **_SCRYPT,
                "salt": base64.b64encode(salt).decode(),
                "nonce": base64.b64encode(self._prefix).decode(),
                "chunk": CHUNK,
                "check": check,
            },
            sort_keys=True,
        ).encode()
        self._aes = AESGCM(key)
        self._dst = dst
        self._pending = bytearray()
        self._index = 0
        self._size = 0
        self._closed = False
        dst.write(MAGIC + struct.pack(">I", len(self._header)) + self._header)

    def write(self, data: bytes, /) -> int:
        self._pending += data
        self._size += len(data)
        # A full chunk is sealed only once more follows it: until then it could be the last one.
        done = 0
        while len(self._pending) - done > CHUNK:
            self._seal(bytes(self._pending[done : done + CHUNK]), final=False)
            done += CHUNK
        if done:
            del self._pending[:done]
        return len(data)

    def tell(self) -> int:
        return self._size

    def flush(self) -> None:
        self._dst.flush()

    def close(self) -> None:
        if not self._closed:
            self._seal(bytes(self._pending), final=True)
            self._pending.clear()
            self._closed = True

    def _seal(self, block: bytes, final: bool) -> None:
        sealed = self._aes.encrypt(self._prefix + struct.pack(">I", self._index), block, _aad(self._header, self._index, final))
        self._dst.write(struct.pack(">I", len(sealed)) + sealed)
        self._index += 1


def encrypt_file(src: Path, dst: BinaryIO, passphrase: str) -> None:
    sink = Encryptor(dst, passphrase)
    with open(src, "rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            sink.write(block)
    sink.close()


def _read_header(handle: BinaryIO) -> tuple[bytes, bytes, bytes, int, int, int, str]:
    """(header bytes, salt, nonce prefix, n, r, p, passphrase check) of an encrypted backup open at its start."""
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
    return header, salt, prefix, n, r, p, expected


class DecryptedView(io.BufferedIOBase):
    """An encrypted backup's plaintext, read in place: seekable, and decrypted one chunk at a time as it is read, so
    `zipfile` can open the backup without a decrypted copy on disk. Every chunk read is authenticated, the last one as
    the last (reading a zip starts at its end, so a cut-off file is caught at once)."""

    def __init__(self, path: Path, passphrase: str):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        self._handle = open(path, "rb")
        try:
            self._header, salt, self._prefix, n, r, p, expected = _read_header(self._handle)
            key, check = _keys(passphrase, salt, n, r, p)
            if not hmac.compare_digest(check, expected):
                raise BadPassphrase("That passphrase doesn't open this backup.")
            self._aes = AESGCM(key)
            self._chunks: list[tuple[int, int]] = []  # (where its ciphertext starts, its length)
            self._starts: list[int] = []  # where each chunk's plaintext starts
            end = os.fstat(self._handle.fileno()).st_size
            at, plain = self._handle.tell(), 0
            while at < end:
                self._handle.seek(at)
                raw = self._handle.read(4)
                if len(raw) < 4 or at + 4 + struct.unpack(">I", raw)[0] > end:
                    raise CorruptBackup("The backup file is incomplete.")
                (length,) = struct.unpack(">I", raw)
                if length < 16:  # shorter than its own tag
                    raise CorruptBackup("The backup file is damaged.")
                self._chunks.append((at + 4, length))
                self._starts.append(plain)
                plain += length - 16
                at += 4 + length
            if not self._chunks:
                raise CorruptBackup("The backup file is incomplete.")
        except BaseException:
            self._handle.close()
            raise
        self._size = plain
        self._pos = 0
        self._cached: tuple[int, bytes] = (-1, b"")

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET, /) -> int:
        position = offset + (0 if whence == io.SEEK_SET else self._pos if whence == io.SEEK_CUR else self._size)
        if position < 0:
            raise OSError(errno.EINVAL, "Invalid argument")
        self._pos = position
        return position

    def read(self, size: int | None = -1, /) -> bytes:
        end = self._size if size is None or size < 0 else min(self._size, self._pos + size)
        parts = []
        while self._pos < end:
            index = bisect.bisect_right(self._starts, self._pos) - 1
            offset = self._pos - self._starts[index]
            piece = self._chunk(index)[offset : offset + end - self._pos]
            if not piece:
                raise CorruptBackup("The backup file is damaged.")
            parts.append(piece)
            self._pos += len(piece)
        return b"".join(parts)

    def read1(self, size: int = -1, /) -> bytes:
        return self.read(size)

    def close(self) -> None:
        handle = getattr(self, "_handle", None)  # absent when the file itself couldn't be opened
        if handle:
            handle.close()
        super().close()

    def _chunk(self, index: int) -> bytes:
        from cryptography.exceptions import InvalidTag

        if self._cached[0] != index:
            at, length = self._chunks[index]
            self._handle.seek(at)
            sealed = self._handle.read(length)
            nonce = self._prefix + struct.pack(">I", index)
            final = index == len(self._chunks) - 1
            try:
                block = self._aes.decrypt(nonce, sealed, _aad(self._header, index, final))
            except InvalidTag:
                cut_off = final and self._opens(nonce, sealed, _aad(self._header, index, False))  # intact, but not the last
                raise CorruptBackup("The backup file is incomplete." if cut_off else "The backup file is damaged.") from None
            self._cached = (index, block)
        return self._cached[1]

    def _opens(self, nonce: bytes, sealed: bytes, aad: bytes) -> bool:
        from cryptography.exceptions import InvalidTag

        try:
            self._aes.decrypt(nonce, sealed, aad)
            return True
        except InvalidTag:
            return False


def decrypt_file(src: Path, dst: BinaryIO, passphrase: str) -> None:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    with open(src, "rb") as handle:
        header, salt, prefix, n, r, p, expected = _read_header(handle)
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
