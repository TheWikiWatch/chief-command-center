"""Chat-media helpers: cached thumbnails + light previews for large videos.

Both are best-effort and fail open:
- `thumb_for` returns None when a thumbnail cannot be made.
- `preview_for` returns the ORIGINAL path whenever a light preview is not
  (yet) available, so callers can always serve something playable.
"""
from __future__ import annotations

import hashlib
import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger("chief-dashboard-bridge")

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
THUMB_TIMEOUT = 25
PREVIEW_TIMEOUT = 240
PREVIEW_MIN_BYTES = 50 * 1024 * 1024
PREVIEW_MAX_BYTES = 2 * 1024 * 1024 * 1024

_inflight: set[str] = set()
_lock = threading.Lock()


def _cache_root() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "hermes" / "profiles" / "chief" / "cache" / "bridge-media"


def _key(src: Path) -> str:
    try:
        st = src.stat()
        seed = f"{src}|{st.st_size}|{st.st_mtime_ns}"
    except OSError:
        seed = str(src)
    return hashlib.md5(seed.encode("utf-8", "replace")).hexdigest()[:24]


def _run(cmd: list[str], timeout: int) -> bool:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).returncode == 0
    except Exception:
        return False


def thumb_for(src: Path) -> Optional[Path]:
    """Cached jpeg frame for a video; None when unavailable."""
    out = _cache_root() / "thumbs" / (_key(src) + ".jpg")
    if out.is_file() and out.stat().st_size > 0:
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".tmp.jpg")
    for ss in ("3", "1", "0"):
        ok = _run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-ss", ss, "-i", str(src),
             "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", str(tmp)],
            THUMB_TIMEOUT,
        )
        if ok and tmp.is_file() and tmp.stat().st_size > 0:
            try:
                os.replace(tmp, out)
            except OSError:
                pass
            return out
    try:
        tmp.unlink(missing_ok=True)
    except OSError:
        pass
    return None


def preview_for(src: Path) -> Path:
    """Original immediately; build the light mp4 in the background when big."""
    try:
        size = src.stat().st_size
    except OSError:
        return src
    if size <= PREVIEW_MIN_BYTES or size > PREVIEW_MAX_BYTES:
        return src
    out = _cache_root() / "previews" / (_key(src) + ".mp4")
    if out.is_file() and out.stat().st_size > 0:
        return out
    key = str(out)
    with _lock:
        if key in _inflight:
            return src
        _inflight.add(key)
    threading.Thread(target=_build_preview, args=(src, out, key), daemon=True).start()
    return src


def _build_preview(src: Path, out: Path, key: str) -> None:
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.stem + ".tmp.mp4")
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src)]
        height = _probe_height(src)
        if height and height > 720:
            cmd += ["-vf", "scale=-2:720"]
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(tmp)]
        if _run(cmd, PREVIEW_TIMEOUT) and tmp.is_file() and tmp.stat().st_size > 0:
            try:
                os.replace(tmp, out)
            except OSError:
                pass
        else:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
    except Exception:
        logger.debug("preview build failed for %s", src, exc_info=True)
    finally:
        with _lock:
            _inflight.discard(key)


def _probe_height(src: Path) -> Optional[int]:
    try:
        r = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=height", "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, timeout=20,
        )
        raw = (r.stdout or "").strip().split("\n")[0]
        return int(float(raw)) if raw else None
    except Exception:
        return None
