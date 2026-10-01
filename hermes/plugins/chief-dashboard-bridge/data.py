"""Read-only fleet + chat snapshots for the dashboard bridge."""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import sys
import threading
import copy
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

import yaml

from hermes_constants import get_default_hermes_root, named_profile_is_deleted

logger = logging.getLogger("chief-dashboard-bridge")

_AVATAR_EXTS = ("png", "jpg", "jpeg", "webp", "gif")
_SKIP_ROLES = {"system", "session_meta"}
_MEDIA_EXTS = (
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg",
    "mp4", "webm", "mov", "mkv", "avi",
    "mp3", "wav", "ogg", "opus", "m4a", "flac",
    "pdf", "zip", "docx", "xlsx", "pptx", "txt", "md", "csv",
)
_IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"}
_VIDEO_EXTS = {"mp4", "webm", "mov", "mkv", "avi"}
_AUDIO_EXTS = {"mp3", "wav", "ogg", "opus", "m4a", "flac"}
_MIME = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
    "gif": "image/gif", "bmp": "image/bmp", "svg": "image/svg+xml",
    "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
    "mkv": "video/x-matroska", "avi": "video/x-msvideo",
    "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
    "opus": "audio/ogg", "m4a": "audio/mp4", "flac": "audio/flac",
    "pdf": "application/pdf", "zip": "application/zip",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "txt": "text/plain", "md": "text/markdown", "csv": "text/csv",
}
_EXT_GROUP = "|".join(_MEDIA_EXTS)
_MEDIA_PATH_RE = re.compile(rf"(?P<path>[^\n]+?\.(?:{_EXT_GROUP}))(?=\s+MEDIA:|\s*$)", re.IGNORECASE)
# A path followed by more words on the same line: stop at the first file extension.
_MEDIA_INLINE_RE = re.compile(rf"(?P<path>[^\n]+?\.(?:{_EXT_GROUP}))(?=[\s,;)\]]|$)", re.IGNORECASE)
# What follows "MEDIA:" must look like a path or URL; otherwise it is prose that mentions the word
# (a sentence fragment used to become a fake file chip).
_PATHLIKE_RE = re.compile(r"""^[ \t]*[`"']?(?:[A-Za-z]:[\\/]|\\\\|/|~[\\/]|\.{1,2}[\\/]|https?://)""")
_DENIED_NAMES = {".env", "auth.json", "state.db", "credentials.json", ".netrc", ".token", "id_rsa", "id_ed25519"}
_DENIED_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".kdbx")
# Never served back: Hermes SQLite databases and side files (state.db-wal holds recent chat).
_SERVE_DENIED_SUFFIXES = (".db", ".db-wal", ".db-shm", ".db-journal", ".sqlite", ".sqlite3", ".sqlite-wal", ".sqlite-shm")
_recent_media_paths: set[str] = set()
# Match Hermes reclaim: a live PID with no heartbeat for >1h is wedged, not working.
_HEARTBEAT_MAX_STALE_SECONDS = 60 * 60


def install_root() -> Path:
    try:
        return Path(get_default_hermes_root())
    except Exception:
        local = os.environ.get("LOCALAPPDATA", "")
        return Path(local) / "hermes" if local else Path.home() / "AppData" / "Local" / "hermes"


def chief_home(root: Optional[Path] = None) -> Path:
    root = root or install_root()
    return root / "profiles" / "chief"


def is_chief_home(path: Optional[Path] = None) -> bool:
    try:
        from hermes_constants import get_hermes_home

        home = Path(path) if path is not None else Path(get_hermes_home())
        return home.resolve() == chief_home().resolve()
    except Exception:
        return False


@contextmanager
def chief_config_scope() -> Iterator[None]:
    """Force load/save onto the chief profile, even if this thread inherited another HERMES_HOME."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(chief_home())
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def profiles_dir(root: Optional[Path] = None) -> Path:
    return (root or install_root()) / "profiles"


_yaml_lock = threading.Lock()
_yaml_cache: dict[str, tuple[int, dict]] = {}


def load_yaml(path: Path) -> dict:
    """Preserve the installed bridge's serialized, cached pure-Python loader."""
    try:
        key = str(path.resolve())
        mtime = path.stat().st_mtime_ns
        with _yaml_lock:
            hit = _yaml_cache.get(key)
            if hit and hit[0] == mtime:
                return copy.deepcopy(hit[1])
            from yaml.loader import SafeLoader
            value = yaml.load(path.read_text(encoding="utf-8"), Loader=SafeLoader) or {}
            result = value if isinstance(value, dict) else {}
            _yaml_cache[key] = (mtime, result)
            return copy.deepcopy(result)
    except Exception:
        logger.debug("yaml read failed", exc_info=True)
        return {}


def _pretty_folder(profile_id: str) -> str:
    raw = re.sub(r"[-_]+", " ", profile_id).strip()
    return raw.title() if raw else profile_id


def _bot_identity(meta: dict, bots: dict, profile_id: str) -> tuple[str, str]:
    title = str(bots.get("title") or "").strip()
    name = title or _pretty_folder(profile_id)
    desc = str(meta.get("description") or bots.get("description") or "").strip()
    return name, desc


def _roster_flavor(root: Path) -> dict[str, dict[str, str]]:
    """Optional roster notes (a Markdown table naming each bot's status) from CHIEF_ROSTER_FILE."""
    raw = (os.environ.get("CHIEF_ROSTER_FILE") or "").strip()
    if not raw:
        return {}
    path = Path(raw)
    if not path.is_file():
        return {}
    out: dict[str, dict[str, str]] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 5:
            continue
        agent, _desk, _reach, pin, status = cells[0], cells[1], cells[2], cells[3], cells[4]
        m = re.search(r"`([a-z0-9][a-z0-9_-]*)`", agent)
        if not m:
            if "chief" in agent.lower() and "chief" in agent.lower():
                pid = "chief"
            else:
                continue
        else:
            pid = m.group(1)
        flavor = "certified" if "certified" in status.lower() else ("seeded" if "seeded" in status.lower() else ("live" if "live" in status.lower() else ""))
        out[pid] = {"flavor": flavor, "pin": pin, "status_note": re.sub(r"\s+", " ", status)[:240]}
    return out


def list_roster() -> dict[str, Any]:
    root = install_root()
    pdir = profiles_dir(root)
    sections_path = root / "bot-sections.json"
    sections_doc = {}
    if sections_path.is_file():
        try:
            sections_doc = json.loads(sections_path.read_text(encoding="utf-8"))
        except Exception:
            sections_doc = {}
    section_order = [s for s in (sections_doc.get("sections") or []) if isinstance(s, str)]
    assign = sections_doc.get("assign") if isinstance(sections_doc.get("assign"), dict) else {}
    flavor = _roster_flavor(root)

    people: list[dict[str, Any]] = []
    if pdir.is_dir():
        for entry in sorted(pdir.iterdir()):
            if not entry.is_dir() or entry.name.startswith(".") or entry.name == "default":
                continue
            if named_profile_is_deleted(entry):
                continue
            meta = load_yaml(entry / "profile.yaml")
            bots = (meta.get("ui_meta") or {}).get("hermes-bots") if isinstance(meta.get("ui_meta"), dict) else {}
            bots = bots if isinstance(bots, dict) else {}
            cfg = load_yaml(entry / "config.yaml")
            model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
            name, desc = _bot_identity(meta, bots, entry.name)
            avatar = None
            # Bot Mode backfills shape faces as PNG; only real photos should use <img>.
            if str(bots.get("imageKind") or "") == "photo":
                assets = entry / "assets"
                for ext in _AVATAR_EXTS:
                    cand = assets / f"avatar.{ext}"
                    if cand.is_file():
                        avatar = f"/api/bridge/avatar/{entry.name}"
                        break
            flav = flavor.get(entry.name, {})
            people.append({
                "id": entry.name,
                "name": name,
                "title": name,
                "description": desc,
                "section": str(assign.get(entry.name) or ""),
                "shape": str(bots.get("shape") or ""),
                "color": str(bots.get("color") or ""),
                "imageKind": str(bots.get("imageKind") or ""),
                "custom": bool(bots.get("custom")),
                "pet": bots.get("pet"),
                "avatarUrl": avatar,
                "model": str(model.get("default") or ""),
                "provider": str(model.get("provider") or ""),
                "flavor": flav.get("flavor") or "",
                "isChief": entry.name == "chief",
            })

    people.sort(key=lambda p: (0 if p["isChief"] else 1, p["section"], p["name"].lower()))
    return {
        "people": people,
        "sections": section_order,
        "root": str(root),
    }


def _profile_key(raw: Any) -> str:
    s = str(raw or "").strip()
    if s.startswith("@"):
        s = s[1:]
    return s.lower()


def _pid_exists_win32(pid: int) -> bool:
    """psutil-free Windows liveness probe. Never os.kill(pid, 0) — that is CTRL_C_EVENT."""
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.restype = ctypes.c_uint
        kernel32.GetLastError.restype = ctypes.c_uint
        process_query_limited_information, synchronize = 0x1000, 0x100000
        wait_timeout, error_access_denied = 0x00000102, 5
        handle = kernel32.OpenProcess(process_query_limited_information | synchronize, False, pid)
        if not handle:
            return kernel32.GetLastError() == error_access_denied
        try:
            return kernel32.WaitForSingleObject(handle, 0) == wait_timeout
        finally:
            kernel32.CloseHandle(handle)
    except (OSError, AttributeError):
        return False


def _pid_alive(pid: Any) -> bool:
    try:
        pid_int = int(pid)
    except (TypeError, ValueError):
        return False
    if pid_int <= 0:
        return False
    try:
        import psutil  # type: ignore
        try:
            if psutil.Process(pid_int).status() == getattr(psutil, "STATUS_ZOMBIE", "zombie"):
                return False
        except getattr(psutil, "NoSuchProcess", ()):
            return False
        except getattr(psutil, "AccessDenied", ()):
            return True
        except Exception:
            pass
        return bool(psutil.pid_exists(pid_int))
    except ImportError:
        pass
    if sys.platform == "win32":
        return _pid_exists_win32(pid_int)
    try:
        os.kill(pid_int, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _heartbeat_fresh(last_heartbeat_at: Any) -> bool:
    if last_heartbeat_at in (None, ""):
        return True
    try:
        hb = int(float(last_heartbeat_at))
    except (TypeError, ValueError):
        return True
    if hb <= 0:
        return True
    return (time.time() - hb) <= _HEARTBEAT_MAX_STALE_SECONDS


def job_for_person(jobs: dict[str, dict[str, Any]], person_id: str) -> dict[str, Any]:
    key = _profile_key(person_id)
    if key in jobs:
        return jobs[key]
    for k, v in jobs.items():
        if _profile_key(k) == key:
            return v
    return {}


def work_status() -> dict[str, Any]:
    db_path = install_root() / "kanban.db"
    workers: list[dict[str, Any]] = []
    jobs: dict[str, dict[str, Any]] = {}
    if not db_path.is_file():
        return {"workers": workers, "jobs": jobs}

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT r.id AS run_id, r.task_id, t.title AS task_title, t.status AS task_status, "
            "t.assignee AS task_assignee, r.profile, r.worker_pid, r.started_at, r.last_heartbeat_at "
            "FROM task_runs r JOIN tasks t ON t.id = r.task_id "
            "WHERE r.ended_at IS NULL AND r.worker_pid IS NOT NULL AND t.status = 'running' "
            "ORDER BY r.started_at ASC"
        ).fetchall()
        for row in rows:
            rec = dict(row)
            if not _pid_alive(rec.get("worker_pid")):
                continue
            if not _heartbeat_fresh(rec.get("last_heartbeat_at")):
                continue
            workers.append(rec)
            pid = rec.get("profile") or rec.get("task_assignee")
            key = _profile_key(pid)
            if key:
                jobs[key] = {
                    "title": rec.get("task_title") or "",
                    "status": "working",
                    "taskId": rec.get("task_id"),
                    "startedAt": rec.get("started_at"),
                }
        latest = conn.execute(
            "SELECT assignee, title, status, updated_at, id FROM tasks "
            "WHERE assignee IS NOT NULL AND assignee != '' AND status != 'archived' "
            "ORDER BY updated_at DESC"
        ).fetchall()
        seen: set[str] = set()
        for row in latest:
            aid = _profile_key(row["assignee"])
            if not aid or aid in seen:
                continue
            seen.add(aid)
            if aid in jobs:
                continue
            st = row["status"]
            ring = "failed" if st == "blocked" else "idle"
            jobs[aid] = {
                "title": row["title"] or "",
                "status": ring,
                "kanbanStatus": st,
                "taskId": row["id"],
            }
    except Exception:
        logger.debug("kanban read failed", exc_info=True)
    finally:
        conn.close()
    return {"workers": workers, "jobs": jobs}


def _allowed_user_id() -> str:
    env_path = chief_home() / ".env"
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("DISCORD_ALLOWED_USERS="):
                return line.split("=", 1)[1].strip().split(",")[0].strip()
    except OSError:
        pass
    return ""


def _session_keys_from_db() -> list[str]:
    db_path = chief_home() / "state.db"
    if not db_path.is_file():
        return []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = conn.execute(
                "SELECT session_key FROM sessions "
                "WHERE ifnull(session_key,'') != '' "
                "AND ifnull(source,'') IN ('discord', 'command_center') "
                "ORDER BY last_activity_at DESC"
            ).fetchall()
        finally:
            conn.close()
        return [str(r[0]) for r in rows if r and r[0]]
    except Exception:
        logger.debug("session key scan failed", exc_info=True)
        return []


def _command_center_enabled() -> bool:
    raw = os.environ.get("COMMAND_CENTER_ENABLED", "1")
    return str(raw).strip().lower() in ("", "1", "true", "yes", "on")


def _cc_home() -> str:
    from .identity import owner_id

    return owner_id()


def _known_session_keys() -> list[str]:
    sessions_path = chief_home() / "sessions" / "sessions.json"
    keys: list[str] = []
    if sessions_path.is_file():
        try:
            loaded = json.loads(sessions_path.read_text(encoding="utf-8"))
            keys = list(loaded.keys()) if isinstance(loaded, dict) else []
        except Exception:
            keys = []
    seen = set(keys)
    for key in _session_keys_from_db():
        if key not in seen:
            keys.append(key)
            seen.add(key)
    return keys


def resolve_session_key(override: str = "", *, command_center_ready: bool = False) -> dict[str, Any]:
    cc_on = _command_center_enabled()
    cc_home = _cc_home()
    cc_dm = f"agent:main:command_center:dm:{cc_home}"
    # A saved Discord session must not receive dashboard sends after Discord is off.
    if cc_on and override and ":discord:" in override:
        logger.warning("ignoring discord session override while command center is enabled")
        override = ""
    if override and ":command_center:" in override:
        if not cc_on and not command_center_ready:
            return {"sessionKey": "", "kind": "adapter-unavailable", "bound": False, "platform": "command_center", "userId": cc_home}
        return {
            "sessionKey": override,
            "kind": "command_center" if command_center_ready else "command_center-pending",
            "bound": bool(command_center_ready),
            "userId": cc_home,
            "platform": "command_center",
        }
    if override and not cc_on:
        kind = "override"
        if ":discord:" in override:
            kind = "discord"
        return {"sessionKey": override, "kind": kind, "bound": True, "platform": "discord"}
    user = _allowed_user_id()
    keys = _known_session_keys()
    if cc_on:
        chosen = cc_dm
        if cc_dm not in keys:
            for key in keys:
                if ":command_center:dm:" in key:
                    chosen = key
                    break
        known = chosen in keys
        return {
            "sessionKey": chosen,
            "kind": "command_center" if command_center_ready and known else "command_center-pending",
            "bound": bool(command_center_ready and known),
            "userId": cc_home,
            "platform": "command_center",
        }
    dm = f"agent:main:discord:dm:{user}" if user else ""
    if dm and dm in keys:
        return {"sessionKey": dm, "kind": "dm", "bound": True, "userId": user, "platform": "discord"}
    for k in keys:
        if ":discord:dm:" in k and (not user or k.endswith(":" + user) or k.endswith(user)):
            return {"sessionKey": k, "kind": "dm", "bound": True, "userId": user, "platform": "discord"}
    for k in keys:
        if ":discord:group:" in k and user and k.endswith(":" + user) and ":thread:" not in k:
            return {"sessionKey": k, "kind": "group-fallback", "bound": True, "userId": user, "platform": "discord"}
    if dm:
        return {"sessionKey": dm, "kind": "dm-pending", "bound": False, "userId": user, "platform": "discord"}
    return {"sessionKey": "", "kind": "unbound", "bound": False, "userId": user}


def _kind_for_ext(ext: str) -> str:
    if ext in _IMAGE_EXTS:
        return "image"
    if ext in _VIDEO_EXTS:
        return "video"
    if ext in _AUDIO_EXTS:
        return "audio"
    return "file"


def _attach_from_path(raw: str) -> dict[str, Any] | None:
    path = raw.strip().strip("`\"'")
    if not path or path.startswith("data:"):
        return None
    name = Path(path).name if not path.startswith(("http://", "https://")) else path.rsplit("/", 1)[-1]
    ext = Path(name.split("?")[0]).suffix.lower().lstrip(".")
    return {
        "path": path,
        "name": name or path,
        "kind": _kind_for_ext(ext) if ext else ("image" if path.startswith("http") else "file"),
        "mime": _MIME.get(ext) or "application/octet-stream",
    }


def _extract_media_from_text(text: str) -> tuple[str, list[dict[str, Any]]]:
    if not text or "MEDIA:" not in text:
        return text, []
    attachments: list[dict[str, Any]] = []
    parts = text.split("MEDIA:")
    visible = [parts[0]]
    for chunk in parts[1:]:
        if not _PATHLIKE_RE.match(chunk):
            visible.append("MEDIA:" + chunk)
            continue
        match = _MEDIA_PATH_RE.match(chunk) or _MEDIA_INLINE_RE.match(chunk)
        if match:
            att = _attach_from_path(match.group("path"))
            rest = chunk[match.end():]
        else:
            line, _, leftover = chunk.partition("\n")
            att = _attach_from_path(line)
            rest = leftover
        if att:
            attachments.append(att)
        visible.append(rest)
    body = re.sub(r"[ \t]+\n", "\n", "".join(visible))
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    return body, attachments


def _lift_blocks(item: dict[str, Any]) -> list[dict[str, Any]]:
    atts: list[dict[str, Any]] = []
    typ = str(item.get("type") or "")
    url = item.get("path") or item.get("url") or item.get("file") or item.get("filename")
    image_url = item.get("image_url")
    source = item.get("source")
    if isinstance(image_url, dict):
        url = url or image_url.get("url")
    elif isinstance(image_url, str):
        url = url or image_url
    if isinstance(source, dict):
        url = url or source.get("path") or source.get("url")
    if typ in {"image", "image_url", "input_image", "file", "audio", "video", "input_file"} or url:
        if isinstance(url, str) and url and not url.startswith("data:"):
            att = _attach_from_path(url)
            if att:
                if typ in {"image", "image_url", "input_image"}:
                    att["kind"] = "image"
                elif typ in {"audio"}:
                    att["kind"] = "audio"
                elif typ in {"video"}:
                    att["kind"] = "video"
                atts.append(att)
    return atts


def parse_message_content(content: Any) -> tuple[str, list[dict[str, Any]]]:
    attachments: list[dict[str, Any]] = []
    if content is None:
        return "", attachments
    if isinstance(content, str):
        s = content.strip()
        if s.startswith("{") or s.startswith("["):
            try:
                return parse_message_content(json.loads(s))
            except Exception:
                return _extract_media_from_text(content)
        return _extract_media_from_text(content)
    if isinstance(content, list):
        texts: list[str] = []
        for item in content:
            if isinstance(item, str):
                t, a = _extract_media_from_text(item)
                texts.append(t)
                attachments.extend(a)
            elif isinstance(item, dict):
                attachments.extend(_lift_blocks(item))
                if item.get("type") == "text" or "text" in item:
                    t, a = _extract_media_from_text(str(item.get("text") or ""))
                    texts.append(t)
                    attachments.extend(a)
        return "".join(texts), attachments
    if isinstance(content, dict):
        attachments.extend(_lift_blocks(content))
        if "text" in content:
            t, a = _extract_media_from_text(str(content.get("text") or ""))
            attachments.extend(a)
            return t, attachments
        return str(content), attachments
    return str(content), attachments


_INLINE_EXTS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".log", ".json", ".xml", ".yaml", ".yml",
    ".py", ".ts", ".tsx", ".js", ".jsx", ".html", ".css", ".toml",
}
_INLINE_MAX = 100_000
MAX_ATTACHMENTS = 8
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
_NOTE_BLOCK = re.compile(r"\[The user sent[^\]]*\]\s*", re.DOTALL)
_USER_SENT_BLOCK = re.compile(r"\[User sent[^\]]*\]\s*")
_CONTENT_BLOCK = re.compile(r"\[Content of ([^\]]+)\]:\n.*?\[End of \1\]\s*", re.DOTALL)


class UploadError(ValueError):
    pass


def strip_agent_attachment_notes(text: str) -> str:
    """Hide Hermes file notes from the bubble. The chips already show the files."""
    cleaned = _CONTENT_BLOCK.sub("", text or "")
    cleaned = _NOTE_BLOCK.sub("", cleaned)
    cleaned = _USER_SENT_BLOCK.sub("", cleaned)
    return cleaned.strip()


def _safe_upload_name(name: str) -> str:
    base = Path(str(name or "")).name.replace("\x00", "").strip()
    base = re.sub(r"[^\w.\- ]", "_", base)
    return base or "file"


def stage_uploads(items: list[Any], dest: Optional[Path] = None) -> list[dict[str, Any]]:
    """Write composer uploads into the inbound cache and return paths the chief can read."""
    if not items:
        return []
    if len(items) > MAX_ATTACHMENTS:
        raise UploadError(f"Attach up to {MAX_ATTACHMENTS} files at a time.")
    root = dest or (chief_home() / "cache" / "inbound")
    root.mkdir(parents=True, exist_ok=True)
    staged: list[dict[str, Any]] = []
    for raw in items:
        if not isinstance(raw, dict):
            raise UploadError("A file could not be read.")
        name = _safe_upload_name(str(raw.get("name") or "file"))
        if _denied_file(Path(name)):
            raise UploadError(f"{name} cannot be attached.")
        mime = str(raw.get("mime") or raw.get("mime_type") or "application/octet-stream").split(";", 1)[0].strip().lower()
        data_url = str(raw.get("data_url") or raw.get("dataUrl") or "").strip()
        if not data_url.startswith("data:") or "," not in data_url:
            raise UploadError(f"{name} is not a valid file.")
        header, encoded = data_url.split(",", 1)
        if ";base64" not in header:
            raise UploadError(f"{name} is not a valid file.")
        try:
            import base64
            import binascii

            payload = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            raise UploadError(f"{name} is not a valid file.") from None
        if not payload:
            raise UploadError(f"{name} is empty.")
        if len(payload) > MAX_ATTACHMENT_BYTES:
            raise UploadError(f"{name} is over 25MB.")
        ext = Path(name).suffix.lower()
        kind = "image" if mime.startswith("image/") or ext.lstrip(".") in _IMAGE_EXTS else (
            "video" if mime.startswith("video/") or ext.lstrip(".") in _VIDEO_EXTS else (
                "audio" if mime.startswith("audio/") or ext.lstrip(".") in _AUDIO_EXTS else "file"
            )
        )
        path = root / f"up_{uuid_hex()}_{name}"
        path.write_bytes(payload)
        remember_media_path(str(path))
        inline = ""
        if ext in _INLINE_EXTS and len(payload) <= _INLINE_MAX:
            inline = payload.decode("utf-8", errors="replace")
        staged.append({
            "path": str(path),
            "name": name,
            "mime": mime or "application/octet-stream",
            "kind": kind,
            "inline": inline,
        })
    return staged


def discard_staged(staged: list[dict[str, Any]]) -> None:
    """Remove uploads the chief never received, so failed sends do not pile up in the inbound cache."""
    for item in staged:
        raw = str(item.get("path") or "")
        if not raw:
            continue
        _recent_media_paths.discard(raw)
        try:
            Path(raw).unlink(missing_ok=True)
        except OSError:
            logger.debug("could not discard staged upload", exc_info=True)


def compose_user_turn(text: str, staged: list[dict[str, Any]]) -> dict[str, Any]:
    """Caption plus MEDIA lines, with small text files inlined the way Hermes expects."""
    inline_blocks: list[str] = []
    media_lines: list[str] = []
    media: list[dict[str, Any]] = []
    kinds: list[str] = []
    for item in staged:
        inline = str(item.get("inline") or "")
        if inline:
            name = str(item.get("name") or "file")
            inline_blocks.append(f"[Content of {name}]:\n{inline}\n[End of {name}]")
        media_lines.append(f"MEDIA:{item['path']}")
        media.append({
            "path": item["path"],
            "mime": item.get("mime") or "application/octet-stream",
            "name": item.get("name") or "",
            "inlined": bool(inline),
        })
        kinds.append(str(item.get("kind") or "file"))
    parts = list(inline_blocks)
    caption = (text or "").strip()
    if caption:
        parts.append(caption)
    body = "\n\n".join(parts)
    if media_lines:
        body = f"{body}\n\n" + "\n".join(media_lines) if body else "\n".join(media_lines)
    if kinds and all(kind == "image" for kind in kinds):
        message_type = "photo"
    elif kinds and all(kind == "video" for kind in kinds):
        message_type = "video"
    elif kinds and all(kind == "audio" for kind in kinds):
        message_type = "audio"
    elif kinds:
        message_type = "document"
    else:
        message_type = "text"
    return {"text": body.strip(), "media": media, "message_type": message_type}


def uuid_hex() -> str:
    import uuid

    return uuid.uuid4().hex[:12]


def _stringify_content(content: Any) -> str:
    text, _atts = parse_message_content(content)
    return text


def _allow_roots() -> list[Path]:
    roots: list[Path] = []
    home = Path.home()
    for rel in ("Documents", "Downloads", "Pictures", "Desktop"):
        roots.append(home / rel)
    roots.append(install_root())
    # The Second Brain (set up through the app; Hermes publishes its .env into the environment) and the real
    # Documents folder, which Windows may redirect (e.g. to OneDrive).
    if (os.environ.get("OBSIDIAN_VAULT_PATH") or "").strip():
        roots.append(Path(os.environ["OBSIDIAN_VAULT_PATH"].strip()))
    try:
        from .second_brain import default_folder

        roots.append(Path(default_folder()).parent)
    except Exception:
        pass
    # Extra folders the owner lets the app show files from (CHIEF_FILE_ROOTS, separated by ';').
    for extra in (os.environ.get("CHIEF_FILE_ROOTS") or "").split(os.pathsep):
        if extra.strip():
            roots.append(Path(extra.strip()))
    cache = os.environ.get("LOCALAPPDATA", "")
    if cache:
        roots.append(Path(cache) / "hermes")
    return roots


def _denied_file(path: Path) -> bool:
    name = path.name.lower()
    if name in _DENIED_NAMES or name.startswith(".env"):
        return True
    if any(name.endswith(suf) for suf in _DENIED_SUFFIXES):
        return True
    for part in path.parts:
        low = part.lower()
        if low in {".ssh", ".gnupg"}:
            return True
    return False


def _under_allowlist(resolved: Path) -> bool:
    for root in _allow_roots():
        try:
            resolved.relative_to(root.resolve())
            return True
        except (ValueError, OSError):
            continue
    return False


def remember_media_path(raw: str) -> None:
    if not raw or raw.startswith(("http://", "https://", "data:")):
        return
    try:
        resolved = str(Path(raw).expanduser().resolve())
    except OSError:
        resolved = raw
    _recent_media_paths.add(resolved)
    _recent_media_paths.add(raw)


def warm_media_cache(session_key: str) -> None:
    if _recent_media_paths or not session_key:
        return
    transcript(session_key, limit=80)


def _has_stream_colon(raw: str) -> bool:
    """A colon past the drive letter is an NTFS alternate data stream (auth.json::$DATA)."""
    rest = raw[2:] if re.match(r"^[A-Za-z]:", raw) else raw
    return ":" in rest


def file_is_allowed(raw: str) -> tuple[Path, str] | None:
    if not raw or raw.startswith(("http://", "https://", "data:")):
        return None
    # Streams would slip past the name denylist.
    if "\x00" in raw or _has_stream_colon(raw):
        return None
    try:
        path = Path(raw).expanduser()
        resolved = path.resolve()
    except (OSError, RuntimeError):
        return None
    if _denied_file(resolved) or _denied_file(path):
        return None
    if any(p.name.lower().endswith(_SERVE_DENIED_SUFFIXES) for p in (path, resolved)):
        return None
    if not resolved.is_file():
        return None
    key = str(resolved)
    known = key in _recent_media_paths or raw in _recent_media_paths
    if not known and not _under_allowlist(resolved):
        return None
    ext = resolved.suffix.lower().lstrip(".")
    mime = _MIME.get(ext) or "application/octet-stream"
    return resolved, mime


def _message_session_id(conn: sqlite3.Connection, session_key: str) -> str:
    """Discord session_key lives on sessions; messages.session_id is sessions.id."""
    if not session_key:
        return ""
    try:
        row = conn.execute(
            "SELECT id FROM sessions WHERE session_key = ? ORDER BY last_activity_at DESC LIMIT 1",
            (session_key,),
        ).fetchone()
        if row:
            return str(row["id"])
        row = conn.execute("SELECT id FROM sessions WHERE id = ? LIMIT 1", (session_key,)).fetchone()
        if row:
            return str(row["id"])
    except Exception:
        logger.debug("session id map failed", exc_info=True)
    return session_key


def _tool_names(tool_calls: Any) -> list[str]:
    """Tool names of a row's calls; a deferred call through Hermes's `tool_call` bridge counts as the tools it ran."""
    if not tool_calls:
        return []
    try:
        from .chat_state import _calls

        return [name or "tool" for name, _args in _calls(tool_calls)]
    except Exception:
        return []


_COMPACTION_PREFIX = "[CONTEXT COMPACTION"
# Copies sit at or before the marker's timestamp; allow for float rounding.
_REPLAY_SLACK_SECONDS = 0.5


def _replay_window(conn: sqlite3.Connection, session_id: str) -> tuple[int, int | None] | None:
    """Rows Hermes re-inserted at the latest context compaction: (marker id, first genuine row id).

    Compaction archives the session (active=0) and writes the kept tail again as NEW rows right after
    a `[CONTEXT COMPACTION` marker. Those copies carry the marker's timestamp (assistant/tool) or
    their original, older one (user, in-flight turn); the first row stamped after the marker is new.
    A reader that pages by id would otherwise see every copy as a fresh reply (upstream #121519,
    closed as by design).
    """
    marker = conn.execute(
        "SELECT id, CAST(timestamp AS REAL) AS t FROM messages "
        "WHERE session_id = ? AND active = 1 AND content LIKE ? ORDER BY id DESC LIMIT 1",
        (session_id, _COMPACTION_PREFIX + "%"),
    ).fetchone()
    if not marker or marker["t"] is None:
        return None
    end = conn.execute(
        "SELECT MIN(id) AS id FROM messages WHERE session_id = ? AND id > ? AND CAST(timestamp AS REAL) > ?",
        (session_id, marker["id"], float(marker["t"]) + _REPLAY_SLACK_SECONDS),
    ).fetchone()
    return int(marker["id"]), (int(end["id"]) if end and end["id"] is not None else None)


def head_id(session_key: str) -> int:
    """The newest active row id of the session: a cheap "anything new?" for the long-poll."""
    db_path = chief_home() / "state.db"
    if not session_key or not db_path.is_file():
        return 0
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            sid = _message_session_id(conn, session_key)
            row = conn.execute("SELECT MAX(id) AS id FROM messages WHERE session_id = ? AND active = 1", (sid,)).fetchone()
            return int(row["id"] or 0) if row else 0
        finally:
            conn.close()
    except Exception:
        logger.debug("head id read failed", exc_info=True)
        return 0


def _all_replay_windows(conn: sqlite3.Connection, session_id: str) -> list[tuple[int, int | None]]:
    """Every compaction's re-inserted block in the session, archived or not (see _replay_window)."""
    out: list[tuple[int, int | None]] = []
    for marker in conn.execute(
        "SELECT id, CAST(timestamp AS REAL) AS t FROM messages WHERE session_id = ? AND content LIKE ? ORDER BY id",
        (session_id, _COMPACTION_PREFIX + "%"),
    ).fetchall():
        if marker["t"] is None:
            continue
        end = conn.execute(
            "SELECT MIN(id) AS id FROM messages WHERE session_id = ? AND id > ? AND CAST(timestamp AS REAL) > ?",
            (session_id, marker["id"], float(marker["t"]) + _REPLAY_SLACK_SECONDS),
        ).fetchone()
        out.append((int(marker["id"]), int(end["id"]) if end and end["id"] is not None else None))
    return out


def transcript(session_key: str, after_id: int = 0, limit: int = 120, before_id: int = 0) -> dict[str, Any]:
    """Rows after `after_id` (oldest first), the latest `limit` (after_id 0), or with `before_id` the
    page before it (Load earlier: `more` says whether older rows exist, `cursor` is the next `before`).
    Load earlier also reads rows archived by context compaction (active = 0): that is the conversation
    before the chief's last compaction. The copies each compaction re-inserted are flagged `replay`."""
    db_path = chief_home() / "state.db"
    messages: list[dict[str, Any]] = []
    if not session_key or not db_path.is_file():
        return {"sessionKey": session_key, "messages": messages, "lastId": after_id}
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    cursor = after_id
    older = False
    trimmed = False
    scanned_from = before_id
    try:
        sid = _message_session_id(conn, session_key)
        fetch = max(limit * 6, 240)
        if before_id:
            rows = conn.execute(
                "SELECT id, role, content, timestamp, tool_calls FROM messages "
                "WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
                (sid, before_id, fetch),
            ).fetchall()
            rows = list(reversed(rows))
            older = len(rows) == fetch
            scanned_from = rows[0]["id"] if rows else before_id
        elif after_id:
            rows = conn.execute(
                "SELECT id, role, content, timestamp, tool_calls FROM messages "
                "WHERE session_id = ? AND active = 1 AND id > ? ORDER BY id ASC LIMIT ?",
                (sid, after_id, fetch),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, role, content, timestamp, tool_calls FROM messages "
                "WHERE session_id = ? AND active = 1 ORDER BY id DESC LIMIT ?",
                (sid, fetch),
            ).fetchall()
            rows = list(reversed(rows))
        window = _replay_window(conn, sid)
        windows = _all_replay_windows(conn, sid) if before_id else ([window] if window else [])
        for row in rows:
            if after_id and len(messages) >= limit:
                break
            cursor = row["id"]
            role = str(row["role"] or "")
            if role in _SKIP_ROLES:
                continue
            names = _tool_names(row["tool_calls"])
            if role == "tool":
                # A question the chief asked with `clarify`, and the owner's answer.
                from .chat_state import asked_from_tool_row

                asked = asked_from_tool_row(row["content"])
                if asked:
                    messages.append({"id": row["id"], "role": "assistant", "content": "", "timestamp": row["timestamp"],
                                     "tools": [], "attachments": [], "asked": asked})
                continue
            content = ""
            attachments: list[dict[str, Any]] = []
            if role != "tool":
                content, attachments = parse_message_content(row["content"])
                if role == "user":
                    content = strip_agent_attachment_notes(content)
                for att in attachments:
                    remember_media_path(str(att.get("path") or ""))
            if role == "tool" and not names:
                continue
            if role not in {"user", "assistant", "tool"}:
                continue
            if not content.strip() and not names and not attachments:
                continue
            item = {
                "id": row["id"],
                "role": role,
                "content": content,
                "timestamp": row["timestamp"],
                "tools": names,
                "attachments": attachments,
            }
            # A compaction copy of a row the reader has already seen: history, never a new reply.
            if any(row["id"] > w[0] and (w[1] is None or row["id"] < w[1]) for w in windows):
                item["replay"] = True
            messages.append(item)
        if after_id:
            messages = messages[:limit]
        elif len(messages) > limit:
            older = older or bool(before_id)
            trimmed = True
            messages = messages[-limit:]
    except Exception:
        logger.debug("transcript query failed", exc_info=True)
    finally:
        conn.close()
    if before_id:
        # The next page starts before the oldest row read (or shown, when this page was cut to `limit`),
        # so rows filtered out here are never read twice. `more` when anything older is left.
        nxt = messages[0]["id"] if trimmed and messages else scanned_from
        return {"sessionKey": session_key, "messages": messages, "lastId": nxt, "cursor": nxt, "more": older}
    last = cursor if after_id else (messages[-1]["id"] if messages else cursor)
    return {"sessionKey": session_key, "messages": messages, "lastId": last}


def profile_peek(name: str) -> dict[str, Any]:
    root = install_root()
    home = profiles_dir(root) / name
    if not home.is_dir() or named_profile_is_deleted(home):
        return {"ok": False, "error": "unknown profile"}
    cfg = load_yaml(home / "config.yaml")
    meta = load_yaml(home / "profile.yaml")
    skills_dir = home / "skills"
    skill_names: list[str] = []
    if skills_dir.is_dir():
        for md in sorted(skills_dir.rglob("SKILL.md")):
            skill_names.append(md.parent.name)
    toolsets = cfg.get("toolsets") if isinstance(cfg.get("toolsets"), list) else []
    tools_block = cfg.get("tools") if isinstance(cfg.get("tools"), dict) else {}
    enabled = tools_block.get("enabled_toolsets") if isinstance(tools_block.get("enabled_toolsets"), list) else toolsets
    jobs = work_status()["jobs"]
    job = job_for_person(jobs, name)
    flavor = _roster_flavor(root).get(name, {})
    bots = (meta.get("ui_meta") or {}).get("hermes-bots") if isinstance(meta.get("ui_meta"), dict) else {}
    bots = bots if isinstance(bots, dict) else {}
    _, desc = _bot_identity(meta, bots, name)

    def read_md(rel: str) -> str:
        p = home / rel
        try:
            return p.read_text(encoding="utf-8") if p.is_file() else ""
        except OSError:
            return ""

    return {
        "ok": True,
        "id": name,
        "soul": read_md("SOUL.md"),
        "memory": read_md("memories/MEMORY.md"),
        "userMemory": read_md("memories/USER.md"),
        "toolsets": [str(t) for t in enabled],
        "skills": skill_names,
        "model": (cfg.get("model") or {}) if isinstance(cfg.get("model"), dict) else {},
        "description": desc,
        "job": job or None,
        "flavor": flavor,
    }


def pending_approval(session_key: str) -> dict[str, Any] | None:
    """Oldest unresolved gateway exec approval for the bound Discord session."""
    if not session_key:
        return None
    try:
        from tools.approval import get_pending_gateway_approval, list_gateway_approvals
    except Exception:
        return None
    try:
        pending = get_pending_gateway_approval(session_key)
        if not pending:
            items = list_gateway_approvals(session_key)
            pending = items[0] if items else None
        if not pending:
            return None
        smart = bool(pending.get("smart_denied"))
        allow_permanent = pending.get("allow_permanent")
        if allow_permanent is None:
            allow_permanent = not smart
        allow_session = pending.get("allow_session")
        if allow_session is None:
            allow_session = not smart
        return {
            "requestId": str(pending.get("request_id") or ""),
            "command": str(pending.get("command") or ""),
            "reason": str(pending.get("description") or pending.get("reason") or ""),
            "patternKey": str(pending.get("pattern_key") or ""),
            "allowPermanent": bool(allow_permanent),
            "allowSession": bool(allow_session),
        }
    except Exception:
        logger.debug("pending approval read failed", exc_info=True)
        return None


def resolve_approval(session_key: str, request_id: str, choice: str) -> dict[str, Any]:
    allowed = {"once", "session", "always", "deny"}
    if not request_id.strip():
        return {"ok": False, "error": "request ID required"}
    if choice not in allowed:
        return {"ok": False, "error": "bad choice"}
    if not session_key:
        return {"ok": False, "error": "no session bound"}
    try:
        from tools.approval import resolve_gateway_approval

        n = resolve_gateway_approval(session_key, choice, request_id=request_id or None)
        return {"ok": True, "resolved": int(n)}
    except Exception:
        logger.warning("resolve approval failed", exc_info=True)
        return {"ok": False, "error": "resolve failed"}


def avatar_bytes(name: str) -> tuple[bytes, str] | None:
    home = profiles_dir() / name
    assets = home / "assets"
    types = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}
    for ext, mime in types.items():
        cand = assets / f"avatar.{ext}"
        if cand.is_file():
            return cand.read_bytes(), mime
    return None
