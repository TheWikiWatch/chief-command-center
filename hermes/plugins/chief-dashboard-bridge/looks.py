"""Bot looks (contract `chief.looks.v1`): how each bot's face appears in the dashboard, on Hermes's own metadata.

Each Hermes profile's `profile.yaml` has `ui_meta`, a dict namespaced by app key. Hermes's Bot Mode keeps a bot's
look in `ui_meta["hermes-bots"]` (shape, color, custom, imageKind, pet, beside title/description/sections) plus
`assets/avatar.<ext>`. Ours goes in our own key, `ui_meta["chief"] = {"v": 1, "face": FACE}`, and every write
also updates the Hermes-native keys (merged, never replacing the dict) so Hermes's own UIs show the nearest face.

- One schema (`validate_face`): unknown keys are dropped, a wrong value is a plain 400 message, colours are
  normalised to lowercase `#rrggbb`. Reading is lenient (`read_face`): anything malformed is None, so the
  dashboard draws the hashed default instead of a broken face.
- Writes go through Hermes's own `_configure_ui_meta` (per-key compare-and-swap revisions, the 64 KB cap, an
  atomic YAML write); none of its logic is copied. A client's expected revisions make a stale save a 409 with the
  current look; our own read-modify-write of `hermes-bots` is pinned to the revision it read and retried.
- Photos: PNG/JPEG/WebP up to 2 MB, sniffed by magic bytes, re-encoded to a square PNG (at most 512 px, no
  metadata) with Pillow, and stored as `assets/avatar.png` (other avatar files removed first, as Hermes does).
- Portraits use the chief's image generator (Settings → Tools), the same `image_generate` tool the Tools test runs.
- Pets are Hermes's petdex pets: installed into the bot's own profile (`<profile>/pets/<slug>/`) and selected with
  `display.pet` in its config.yaml, through Hermes's own store and config helpers.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import struct
import sys
import threading
import time
import types
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import changes, data, hermes_api, persona
from .util import subdict

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.looks.v1"
NS = "chief"
BOTS = "hermes-bots"
VERSION = 1

STYLES = ("bubble", "blob", "shape", "photo")
# A Bubble body and the Hermes blob silhouette that looks most like it (the mirror Hermes's own UIs draw).
BODY_TO_BLOB = {"bean": "organic", "round": "round", "drop": "droplet", "pebble": "boxy", "cloud": "cloud", "tall": "capsule"}
BODIES = tuple(BODY_TO_BLOB)
EYES = ("dot", "oval", "diamond", "happy", "sleepy")
BLOB_KINDS = ("round", "organic", "boxy", "capsule", "nub", "cloud", "droplet", "hexagon", "sun", "triangle")
SHAPES = ("circle", "squircle", "pill", "triangle", "hexagon", "cloud", "drop")
# The hermes-bots keys a look owns; a reset removes exactly these.
MIRROR_KEYS = ("shape", "color", "custom", "imageKind")
_DEFAULTS = {"body": "bean", "eyes": "dot", "blobKind": "organic", "shape": "circle"}

AVATAR_MAX = 2 * 1024 * 1024  # 2 MB in (Hermes takes 2,000,000 bytes; ours is re-encoded to a small PNG first)
AVATAR_SIDE = 512
GENERATED_MAX = 25 * 1024 * 1024  # a generator's picture, before it is re-encoded
_AVATAR_EXTS = ("png", "jpg", "jpeg", "webp", "gif")  # every name data.avatar_bytes serves
_MAGIC = {"png": [(0, 8, b"\x89PNG\r\n\x1a\n")], "jpg": [(0, 3, b"\xff\xd8\xff")], "webp": [(0, 4, b"RIFF"), (8, 12, b"WEBP")]}
_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")

PORTRAIT_TIMEOUT = 150.0
CATALOG_TTL = 3600.0
_CATALOG_RETRY = 300.0
NO_IMAGE_GENERATOR = "No image generator is set up (Settings → Tools)."

# Colour words the chief may use instead of a hex value (the dashboard's palette family).
NAMED_COLORS = {
    "red": "#e5484d",
    "crimson": "#e93d82",
    "orange": "#f76b15",
    "amber": "#ffb224",
    "gold": "#ffc53d",
    "yellow": "#f5d90a",
    "lime": "#99d52a",
    "green": "#30a46c",
    "mint": "#3dd68c",
    "teal": "#12a594",
    "cyan": "#05a2c2",
    "sky": "#7ce2fe",
    "blue": "#0090ff",
    "indigo": "#3e63dd",
    "violet": "#6e56cf",
    "purple": "#8e4ec6",
    "pink": "#d6409f",
    "brown": "#a07553",
    "gray": "#8b8d98",
    "grey": "#8b8d98",
    "slate": "#696e77",
    "black": "#1c2024",
    "white": "#f0f0f3",
}
_PALETTE = ("#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594", "#05a2c2", "#0090ff", "#3e63dd", "#6e56cf", "#d6409f")


class LookError(ValueError):
    """A look that can't be saved, with the HTTP status the route answers."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- the schema


def normalize_color(value: Any) -> str:
    """`#rrggbb` (lowercase) from `#rgb` or `#rrggbb`; LookError otherwise."""
    if not isinstance(value, str) or not _COLOR.match(value.strip()):
        raise LookError("The colour must look like #3fa7d6.")
    text = value.strip().lower()
    return "#" + "".join(c * 2 for c in text[1:]) if len(text) == 4 else text


def _enum(raw: dict, key: str, allowed: tuple[str, ...], label: str) -> str:
    value = raw.get(key)
    if value is None:
        return _DEFAULTS[key]
    if not isinstance(value, str) or value not in allowed:
        raise LookError(f"{label} must be one of: {', '.join(allowed)}.")
    return value


def _valid_seed(seed: Any) -> bool:
    # Hermes splits `blobatar:<seed>:<kind>` on colons.
    return isinstance(seed, str) and 1 <= len(seed.strip()) <= 40 and seed.strip().isprintable() and ":" not in seed


def validate_face(raw: Any, profile_id: str = "chief") -> dict[str, Any]:
    """The face to store, complete for its style; LookError (400) with a plain message when it isn't valid."""
    if not isinstance(raw, dict):
        raise LookError("The face must be an object (or null to reset).")
    style = raw.get("style")
    if style not in STYLES:
        raise LookError(f"The style must be one of: {', '.join(STYLES)}.")
    face: dict[str, Any] = {"style": style}
    if style == "photo":
        # A colour is optional with a photo (a glow); a bad one is dropped, not an error.
        try:
            if raw.get("color") is not None:
                face["color"] = normalize_color(raw.get("color"))
        except LookError:
            pass
        return face
    if raw.get("color") is None:
        raise LookError("Pick a colour.")
    face["color"] = normalize_color(raw["color"])
    if style == "bubble":
        face["body"] = _enum(raw, "body", BODIES, "The body")
        face["eyes"] = _enum(raw, "eyes", EYES, "The eyes")
        cheeks = raw.get("cheeks", False)
        if not isinstance(cheeks, bool):
            raise LookError("Cheeks must be true or false.")
        face["cheeks"] = cheeks
    elif style == "blob":
        seed = raw.get("seed")
        seed = (profile_id or "chief") if seed is None else seed
        if not _valid_seed(seed):
            raise LookError("The blob seed must be 1 to 40 printable characters, without ':'.")
        face["seed"] = str(seed).strip()
        face["blobKind"] = _enum(raw, "blobKind", BLOB_KINDS, "The blob kind")
    else:
        face["shape"] = _enum(raw, "shape", SHAPES, "The shape")
    return face


def read_face(ui_meta: Any, profile_id: str = "chief") -> dict[str, Any] | None:
    """The stored face, or None when there is none or it is malformed (never an error)."""
    ours = subdict(ui_meta, NS)
    if ours.get("v") != VERSION or ours.get("face") is None:
        return None
    try:
        return validate_face(ours["face"], profile_id)
    except LookError:
        return None


def mirror(face: dict[str, Any] | None, profile_id: str, bots: dict[str, Any]) -> dict[str, Any]:
    """`ui_meta["hermes-bots"]` with this face's Hermes-native keys, every other key kept (title, sections...)."""
    out = dict(bots)
    if face is None:
        for key in MIRROR_KEYS:
            out.pop(key, None)
        return out
    style = face["style"]
    if style == "photo":
        out["imageKind"] = "photo"
        return out
    if style == "bubble":
        shape = f"blobatar:{profile_id}:{BODY_TO_BLOB[face['body']]}"
    elif style == "blob":
        shape = f"blobatar:{face['seed']}:{face['blobKind']}"
    else:
        shape = face["shape"]
    out.update(shape=shape, color=face["color"], custom=True, imageKind="shape")
    return out


def default_color(profile_id: str) -> str:
    """The palette colour a bot gets when it is given a style without one (stable per bot)."""
    return _PALETTE[sum(profile_id.encode("utf-8")) % len(_PALETTE)]


def color_word(hex_color: str) -> str:
    return next((name for name, value in NAMED_COLORS.items() if value == hex_color), hex_color)


def describe(face: dict[str, Any] | None) -> str:
    """ "a teal bubble", "an amber hexagon shape", "a photo"."""
    if face is None:
        return "the default face"
    if face["style"] == "photo":
        return "a photo"
    noun = f"{face['shape']} shape" if face["style"] == "shape" else face["style"]
    words = f"{color_word(face['color'])} {noun}"
    return ("an " if words[0] in "aeiou" else "a ") + words


# ---------------------------------------------------------------- profile.yaml and the write path


def _home(profile_id: str) -> Path:
    try:
        return persona.profile_home(profile_id)
    except persona.PersonaError as exc:
        raise LookError(str(exc), 404) from exc


def _read_meta(home: Path) -> dict[str, Any]:
    """profile.yaml read fresh (no cache): the write path must see the document it is about to replace."""
    path = home / "profile.yaml"
    try:
        import yaml
        from yaml.loader import SafeLoader

        value = yaml.load(path.read_text(encoding="utf-8"), Loader=SafeLoader) if path.is_file() else {}
    except Exception:
        logger.debug("profile.yaml read failed", exc_info=True)
        return {}
    return value if isinstance(value, dict) else {}


def _revisions(meta: dict[str, Any]) -> dict[str, int]:
    raw = subdict(meta, "_ui_meta_revisions")
    out = {}
    for key in (NS, BOTS):
        value = raw.get(key, 0)
        out[key] = max(0, value) if isinstance(value, int) and not isinstance(value, bool) else 0
    return out


def has_avatar(home: Path) -> bool:
    return any((home / "assets" / f"avatar.{ext}").is_file() for ext in _AVATAR_EXTS)


_UI_META_LOCK = threading.Lock()
_bound: tuple[Any, Callable[..., Any]] | None = None


def _configure_fn() -> Callable[..., Any]:
    """Hermes's `_configure_ui_meta`, runnable here.

    Hermes's profile handlers are written as bodies over `tui_gateway.server`'s globals (`json`, the ui_meta lock)
    and rebound onto that module when it loads (method_ctx.bind_module). The gateway doesn't load the TUI server,
    so when it isn't loaded the same code runs over its own module's globals plus those two names; when it is, its
    bound copy (and its lock) is used."""
    global _bound
    server = sys.modules.get("tui_gateway.server")
    bound: Any = getattr(server, "_configure_ui_meta", None) if server is not None else None
    if callable(bound):
        return bound
    fn = hermes_api.get("tui_gateway.methods_profiles", "_configure_ui_meta")
    if _bound is not None and _bound[0] is fn:
        return _bound[1]
    scope = dict(fn.__globals__)
    scope.setdefault("json", json)
    scope.setdefault("_profile_ui_meta_lock", _UI_META_LOCK)
    real = types.FunctionType(fn.__code__, scope, fn.__name__, fn.__defaults__, fn.__closure__)
    _bound = (fn, real)
    return real


def _configure(home: Path, incoming: dict[str, Any], expected: dict[str, int]) -> dict[str, Any]:
    applied: dict[str, Any] = {}
    _configure_fn()(home, {"ui_meta": incoming, "ui_meta_expected_revisions": expected}, applied)
    return applied


def _clean_expected(raw: Any) -> dict[str, int] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise LookError("expected must be an object of revisions.")
    out = {}
    for key in (NS, BOTS):
        if key in raw:
            value = raw[key]
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise LookError("Revisions are whole numbers.")
            out[key] = value
    return out or None


def _write(home: Path, build: Callable[[dict[str, Any]], dict[str, Any]], expected: dict[str, int] | None = None) -> tuple[dict[str, Any], int]:
    """Read profile.yaml, let `build(ui_meta)` return the keys to write, and write them through Hermes.

    Each written key is pinned to the revision just read (or the client's expected revision): a conflict on a
    client-pinned key is a 409 with the current look; one caused by another writer in between is retried."""
    pid = home.name
    for _attempt in range(4):
        meta = _read_meta(home)
        revisions = _revisions(meta)
        incoming = build(subdict(meta, "ui_meta"))
        want = {key: revisions.get(key, 0) for key in incoming}
        if expected:
            want.update({k: v for k, v in expected.items() if k in incoming})
        applied = _configure(home, incoming, want)
        if applied.get("ui_meta"):
            changes.bump("look")
            return {"ok": True, **state(pid, home)}, 200
        conflicts = applied.get("ui_meta_conflicts")
        if not isinstance(conflicts, dict) or not conflicts:
            raise LookError("Hermes didn't save the look (the profile may be read-only or too large).", 500)
        if expected and any(key in expected for key in conflicts):
            break
    return {"ok": False, "conflict": True, "error": "Changed elsewhere; showing the latest.", **state(pid, home)}, 409


def state(profile_id: str, home: Path | None = None) -> dict[str, Any]:
    """{id, look, pet, revisions, hasAvatar} for one bot."""
    home = home or _home(profile_id)
    meta = _read_meta(home)
    return {
        "id": home.name,
        "look": read_face(meta.get("ui_meta"), home.name),
        "pet": active_pet(home, home.name),
        "revisions": _revisions(meta),
        "hasAvatar": has_avatar(home),
    }


def get_look(profile_id: str) -> dict[str, Any]:
    home = _home(profile_id)
    return {"ok": True, **state(profile_id, home), "portrait": image_ready(), "pets": pets_usable()}


_MISSING = object()


def write_face(profile_id: str, face: Any = _MISSING, expected: Any = None) -> tuple[dict[str, Any], int]:
    """Save a face (None resets to the dashboard's hashed default). Returns (body, status)."""
    if face is _MISSING:
        raise LookError("Send a face (or null to reset).")
    home = _home(profile_id)
    pid = home.name
    clean = None if face is None else validate_face(face, pid)
    if clean is not None and clean["style"] == "photo" and not has_avatar(home):
        raise LookError("Upload a photo first.")
    pinned = _clean_expected(expected)

    def build(ui: dict[str, Any]) -> dict[str, Any]:
        bots = mirror(clean, pid, subdict(ui, BOTS))
        return {NS: {"v": VERSION, "face": clean} if clean is not None else None, BOTS: bots or None}

    return _write(home, build, pinned)


def _set_bots_key(home: Path, key: str, value: Any) -> None:
    def build(ui: dict[str, Any]) -> dict[str, Any]:
        bots = dict(subdict(ui, BOTS))
        if value is None:
            bots.pop(key, None)
        else:
            bots[key] = value
        return {BOTS: bots or None}

    _write(home, build)


# ---------------------------------------------------------------- photos and portraits


def sniff(blob: bytes) -> str | None:
    """ "png", "jpg" or "webp" from the file's own bytes (the declared type is never trusted)."""
    return next((ext for ext, magic in _MAGIC.items() if all(blob[a:b] == m for a, b, m in magic)), None)


def encode_avatar(blob: bytes, limit: int = AVATAR_MAX) -> tuple[bytes, str]:
    """(bytes, ext) to store: a square PNG of at most 512 px without metadata when Pillow is there, else the
    checked original."""
    if not blob:
        raise LookError("The picture is empty.")
    if len(blob) > limit:
        raise LookError("The picture is over 2 MB." if limit == AVATAR_MAX else "The picture is too large.", 413)
    ext = sniff(blob)
    if ext is None:
        raise LookError("Use a PNG, JPEG or WebP picture.")
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return blob, ext
    try:
        with Image.open(io.BytesIO(blob)) as opened:
            if (opened.format or "").upper() not in ("PNG", "JPEG", "WEBP"):
                raise LookError("Use a PNG, JPEG or WebP picture.")
            if opened.width * opened.height > 40_000_000:
                raise LookError("The picture has too many pixels.")
            img = ImageOps.exif_transpose(opened) or opened
            img = img.convert("RGBA")
            side = min(img.width, img.height)
            left, top = (img.width - side) // 2, (img.height - side) // 2
            img = img.crop((left, top, left + side, top + side))
            if side > AVATAR_SIDE:
                img = img.resize((AVATAR_SIDE, AVATAR_SIDE), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            img.save(out, format="PNG", optimize=True)
    except LookError:
        raise
    except Exception as exc:
        raise LookError("That picture couldn't be read.") from exc
    return out.getvalue(), "png"


def _store_avatar(home: Path, raw: bytes, ext: str) -> None:
    assets = home / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    for old in _AVATAR_EXTS:  # one avatar file per bot, as Hermes keeps it
        (assets / f"avatar.{old}").unlink(missing_ok=True)
    tmp = assets / f"avatar.{ext}.tmp"
    tmp.write_bytes(raw)
    os.replace(tmp, assets / f"avatar.{ext}")


def _photo_face(home: Path) -> dict[str, Any]:
    current = read_face(_read_meta(home).get("ui_meta"), home.name)
    face: dict[str, Any] = {"style": "photo"}
    if current and current.get("color"):
        face["color"] = current["color"]
    return face


def save_avatar(profile_id: str, blob: bytes, limit: int = AVATAR_MAX) -> tuple[dict[str, Any], int]:
    """Store an uploaded picture as the bot's avatar and switch its face to the photo."""
    home = _home(profile_id)
    raw, ext = encode_avatar(blob, limit)
    _store_avatar(home, raw, ext)
    return write_face(home.name, _photo_face(home))


_ready_cache: tuple[float, bool] | None = None


def image_ready() -> bool:
    """Whether the chief has a working image generator (cached for 30 s; the Look drawer asks on open)."""
    global _ready_cache
    if _ready_cache and time.monotonic() - _ready_cache[0] < 30:
        return _ready_cache[1]
    try:
        from . import tools_settings

        ready = tools_settings.image_ready()
    except Exception:
        ready = False
    _ready_cache = (time.monotonic(), ready)
    return ready


def _soul_line(home: Path) -> str:
    try:
        text = (home / "SOUL.md").read_text(encoding="utf-8-sig")
    except OSError:
        return ""
    for line in text.splitlines():
        line = line.strip().lstrip("#>*- ").strip()
        if line:
            return line[:200]
    return ""


def portrait_prompt(home: Path, extra: str = "") -> str:
    meta = _read_meta(home)
    bots = subdict(subdict(meta, "ui_meta"), BOTS)
    title, _desc = data._bot_identity(meta, bots, home.name)
    from .identity import split_title

    name = split_title(title) or title
    role = title[len(name) :].strip(" -–—|:") if title.startswith(name) else ""
    lines = [f"A friendly soft 3D character portrait of an AI assistant named {name}" + (f", the {role}" if role else "") + "."]
    soul = _soul_line(home)
    if soul:
        lines.append(f"Its character: {soul}")
    extra = " ".join(str(extra or "").split())[:300]
    if extra:
        lines.append(extra)
    lines.append("Centered head and shoulders, plain dark background, soft studio light, no text or letters.")
    return " ".join(lines)


def _within(fn: Callable[[], Any], seconds: float) -> Any:
    box: dict[str, Any] = {}

    def run() -> None:
        try:
            box["value"] = fn()
        except BaseException as exc:  # handed to the caller below
            box["error"] = exc

    worker = threading.Thread(target=run, name="chief-portrait", daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        raise LookError("The image generator took too long. Try again.", 504)
    if "error" in box:
        raise box["error"]
    return box.get("value")


def _generate(prompt: str) -> str:
    """A local file with the generated picture (Hermes's own `image_generate` tool, on the chief's settings)."""
    from . import tools_settings

    registry = hermes_api.get("tools.registry", "registry")
    with data.chief_config_scope():
        raw = registry.dispatch("image_generate", {"prompt": prompt, "aspect_ratio": "square"})
    result = raw if isinstance(raw, dict) else tools_settings._json(raw)
    if not result.get("success", not result.get("error")):
        raise LookError(tools_settings._plain_error(result.get("error")), 502)
    path = tools_settings._local_image(str(result.get("image") or ""), name="portrait")
    if not path:
        raise LookError("No picture came back from the image generator.", 502)
    return path


def portrait(profile_id: str, prompt: str = "") -> tuple[dict[str, Any], int]:
    """Generate a square portrait for the bot and make it its photo."""
    home = _home(profile_id)
    if not image_ready():
        raise LookError(NO_IMAGE_GENERATOR)
    path = _within(lambda: _generate(portrait_prompt(home, prompt)), PORTRAIT_TIMEOUT)
    try:
        blob = Path(path).read_bytes()
    except OSError as exc:
        raise LookError("The generated picture couldn't be read.", 502) from exc
    return save_avatar(home.name, blob, GENERATED_MAX)


# ---------------------------------------------------------------- pets


_geometry_cache: dict[str, Any] | None = None
_CODEX_ROWS = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"]
_LEGACY_ROWS = ["idle", "wave", "run", "failed", "review", "jump", "extra1", "extra2"]


def _geometry() -> dict[str, Any]:
    """Hermes's pet frame geometry (agent/pet/constants.py), with petdex's defaults if it ever moves."""
    global _geometry_cache
    if _geometry_cache is None:
        geo: dict[str, Any] = {"w": 192, "h": 208, "steps": 6, "loopMs": 1100, "rows_for": None}
        try:
            const = hermes_api.get("agent.pet.constants")
            geo.update(w=int(const.FRAME_W), h=int(const.FRAME_H), steps=int(const.FRAMES_PER_STATE), loopMs=int(const.LOOP_MS))
            geo["rows_for"] = const.state_rows_for_grid
        except Exception:
            pass
        _geometry_cache = geo
    return _geometry_cache


_size_cache: dict[str, tuple[int, tuple[int, int] | None]] = {}


def image_size(path: Path) -> tuple[int, int] | None:
    """(width, height) from a PNG or WebP header, without decoding the picture."""
    try:
        key, mtime = str(path), path.stat().st_mtime_ns
        hit = _size_cache.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
        with path.open("rb") as fh:
            head = fh.read(64)
    except OSError:
        return None
    size: tuple[int, int] | None = None
    if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
        size = struct.unpack(">II", head[16:24])
    elif head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        chunk = head[12:16]
        if chunk == b"VP8X":
            size = (int.from_bytes(head[24:27], "little") + 1, int.from_bytes(head[27:30], "little") + 1)
        elif chunk == b"VP8L":
            bits = int.from_bytes(head[21:25], "little")
            size = ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        elif chunk == b"VP8 ":
            w, h = struct.unpack("<HH", head[26:30])
            size = (w & 0x3FFF, h & 0x3FFF)
    if len(_size_cache) > 500:
        _size_cache.clear()
    _size_cache[key] = (mtime, size)
    return size


def _spritesheet(folder: Path) -> tuple[Path, dict[str, Any]] | None:
    """The pet's sheet and pet.json, found the way Hermes's store finds them (agent/pet/store.py)."""
    meta: dict[str, Any] = {}
    try:
        loaded = json.loads((folder / "pet.json").read_text(encoding="utf-8-sig"))
        meta = loaded if isinstance(loaded, dict) else {}
    except (OSError, ValueError):
        pass
    declared = str(meta.get("spritesheetPath") or "").strip()
    names = ([Path(declared).name] if declared else []) + ["spritesheet.webp", "spritesheet.png", "sprite.webp", "sprite.png"]
    sheet = next((folder / n for n in names if (folder / n).is_file()), None)
    return (sheet, meta) if sheet else None


def _truthy(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.strip().lower() in ("1", "true", "yes", "on"))


def _pet_config(home: Path) -> dict[str, Any]:
    return subdict(subdict(data.load_yaml(home / "config.yaml"), "display"), "pet")


def frames_for(sheet: Path) -> dict[str, Any]:
    geo = _geometry()
    size = image_size(sheet)
    # A sheet smaller than one frame (or unreadable) gets petdex's usual grid.
    cols, rows = (size[0] // geo["w"], size[1] // geo["h"]) if size and size[0] >= geo["w"] and size[1] >= geo["h"] else (8, 9)
    rows_for: Any = geo.get("rows_for")
    try:
        states = list(rows_for(rows)) if rows_for is not None else (_CODEX_ROWS if rows >= len(_CODEX_ROWS) else _LEGACY_ROWS)
    except Exception:
        states = _CODEX_ROWS if rows >= len(_CODEX_ROWS) else _LEGACY_ROWS
    return {"width": geo["w"], "height": geo["h"], "cols": cols, "rows": rows, "steps": min(geo["steps"], cols), "loopMs": geo["loopMs"], "states": states}


def active_pet(home: Path, profile_id: str) -> dict[str, Any] | None:
    """{slug, name, sheetUrl, frames} when the bot has an enabled, installed pet; else None (never an error)."""
    try:
        cfg = _pet_config(home)
        slug = str(cfg.get("slug") or "").strip()
        if not _truthy(cfg.get("enabled")) or not _SLUG.match(slug):
            return None
        found = _spritesheet(home / "pets" / slug)
        if not found:
            return None
        sheet, meta = found
        return {"slug": slug, "name": str(meta.get("displayName") or slug), "sheetUrl": f"/pet/{profile_id}/sheet", "frames": frames_for(sheet)}
    except Exception:
        logger.debug("pet read failed", exc_info=True)
        return None


def pet_sheet(profile_id: str) -> tuple[Path, str] | None:
    """The bot's active pet's sprite sheet and its content type."""
    if not data.PROFILE_ID_RE.match(profile_id or ""):
        return None
    try:
        home = _home(profile_id)
    except LookError:
        return None
    pet = active_pet(home, home.name)
    found = _spritesheet(home / "pets" / pet["slug"]) if pet else None
    if not found:
        return None
    sheet = found[0]
    return sheet, "image/png" if sheet.suffix.lower() == ".png" else "image/webp"


_catalog_lock = threading.Lock()
_catalog: tuple[float, list[dict[str, Any]], dict[str, str]] | None = None
_catalog_failed: float = 0.0


def catalog() -> dict[str, Any]:
    """The petdex gallery: {pets: [{slug, name, description, thumbUrl, curated}]}, cached for an hour."""
    global _catalog, _catalog_failed
    with _catalog_lock:
        if _catalog and time.monotonic() - _catalog[0] < CATALOG_TTL:
            return {"ok": True, "pets": _catalog[1]}
        try:
            fetch = hermes_api.get("agent.pet.manifest", "fetch_manifest")
            entries = fetch(timeout=15.0)
        except Exception as exc:
            _catalog_failed = time.monotonic()
            logger.info("pet gallery unavailable: %s", type(exc).__name__)
            return {"ok": False, "pets": [], "error": "Couldn't reach the pet gallery (petdex.dev). Check the internet connection."}
        pets, sheets = [], {}
        for entry in entries:
            slug = str(getattr(entry, "slug", "") or "")
            if not _SLUG.match(slug):
                continue
            url = str(getattr(entry, "spritesheet_url", "") or "")
            sheets[slug] = url
            pets.append(
                {
                    "slug": slug,
                    "name": str(getattr(entry, "display_name", "") or slug),
                    "description": "",
                    "thumbUrl": f"/pets/thumb/{slug}",
                    "curated": "/curated/" in url,
                }
            )
        _catalog = (time.monotonic(), pets, sheets)
        _catalog_failed = 0.0
        return {"ok": True, "pets": pets}


def pets_usable() -> bool:
    """Whether the Companion row can work: Hermes has its pet store and the gallery didn't just fail."""
    if _catalog_failed and time.monotonic() - _catalog_failed < _CATALOG_RETRY:
        return False
    try:
        hermes_api.get("agent.pet.manifest", "fetch_manifest")
        hermes_api.get("agent.pet.store", "install_pet")
    except hermes_api.HermesMissing:
        return False
    return True


def thumb(slug: str) -> bytes | None:
    """A small PNG of the pet's first frame (Hermes's `thumbnail_png`, cached in the chief's pets folder)."""
    if not _SLUG.match(slug or ""):
        return None
    if _catalog is None:
        catalog()
    source = (_catalog[2] if _catalog else {}).get(slug, "")
    try:
        thumbnail_png = hermes_api.get("agent.pet.store", "thumbnail_png")
        with data.chief_config_scope():
            return thumbnail_png(slug, source_url=source)
    except Exception:
        logger.debug("pet thumbnail failed", exc_info=True)
        return None


def set_pet(profile_id: str, slug: Any) -> tuple[dict[str, Any], int]:
    """Install a petdex pet into the bot's own profile and select it (`display.pet`), or turn it off (None)."""
    home = _home(profile_id)
    text = str(slug or "").strip()
    off = slug is None or text.lower() in ("", "none", "off")
    if not off and not _SLUG.match(text):
        raise LookError("Unknown pet.")
    with persona.profile_scope(home):
        if off:
            hermes_api.get("hermes_cli.pets", "_set_enabled")(False)
        else:
            install = hermes_api.get("agent.pet.store", "install_pet")
            try:
                install(text)
            except Exception as exc:
                logger.info("pet install of %s failed: %s", text, exc)
                raise LookError("That pet couldn't be fetched from the gallery. Try again, or pick another.", 502) from exc
            hermes_api.get("hermes_cli.pets", "_set_active")(text)
    _set_bots_key(home, "pet", None if off else text)
    changes.bump("look")
    return {"ok": True, **state(home.name, home)}, 200


# ---------------------------------------------------------------- route glue


def call(fn: Callable[[], Any]) -> Any:
    """Run a look action for a route: LookError is its status with a plain message, never a traceback."""
    try:
        return fn()
    except LookError as exc:
        return {"ok": False, "error": str(exc)}, exc.status
    except persona.PersonaError as exc:
        return {"ok": False, "error": str(exc)}, 404
    except hermes_api.HermesMissing:
        return {"ok": False, "error": "This Hermes can't change looks from the app (see Status)."}, 501
    except Exception as exc:
        logger.warning("look action failed: %s", type(exc).__name__, exc_info=True)
        return {"ok": False, "error": "The look couldn't be changed."}, 500


# ---------------------------------------------------------------- the chief's tool


_SELF = {"", "me", "self", "myself", "you", "yourself", "chief"}


def resolve_profile(raw: Any) -> str:
    """A profile id from an id or a display name; "me"/"self"/"chief" is the chief."""
    text = " ".join(str(raw or "").split())
    low = text.lower()
    if low in _SELF:
        return "chief"
    if data.PROFILE_ID_RE.match(low) and (data.profiles_dir() / low).is_dir():
        return low
    from .identity import split_title

    for person in data.list_roster().get("people") or []:
        title = str(person.get("name") or "")
        if low in (title.lower(), split_title(title).lower()):
            return str(person["id"])
    raise LookError(f"There's no bot called '{text}'. fleet_roster lists them.", 404)


def _tool_color(value: Any) -> str:
    word = str(value or "").strip().lower()
    return NAMED_COLORS[word] if word in NAMED_COLORS else normalize_color(word)


_LOOK_ARGS = ("style", "color", "body", "eyes", "cheeks", "shape", "seed", "blob_kind")


def _given(args: dict[str, Any], key: str) -> bool:
    return args.get(key) not in (None, "")


def face_from_args(args: dict[str, Any], current: dict[str, Any] | None, profile_id: str) -> dict[str, Any]:
    """The tool's arguments over the bot's current face: "make Ivy teal" keeps her style."""
    style = str(args.get("style") or (current or {}).get("style") or "bubble").strip().lower()
    face: dict[str, Any] = dict(current) if current and current.get("style") == style else {"style": style}
    if current and current.get("color") and "color" not in face:
        face["color"] = current["color"]
    face["style"] = style
    if _given(args, "color"):
        face["color"] = _tool_color(args["color"])
    for key, arg in (("body", "body"), ("eyes", "eyes"), ("shape", "shape"), ("blobKind", "blob_kind")):
        if _given(args, arg):
            face[key] = str(args[arg]).strip().lower()
    if _given(args, "seed"):
        face["seed"] = str(args["seed"]).strip()
    cheeks = args.get("cheeks")
    if isinstance(cheeks, str) and cheeks.strip().lower() in ("true", "false", "yes", "no"):
        cheeks = cheeks.strip().lower() in ("true", "yes")
    if cheeks is not None:
        face["cheeks"] = cheeks
    if style != "photo" and "color" not in face:
        face["color"] = default_color(profile_id)
    return validate_face(face, profile_id)


def announce(text: str, profile_id: str) -> None:
    """A look change by the chief: logged, and sent to the open dashboards' live channel as a `cc_look` event."""
    logger.info("looks: %s", text)
    changes.bump("look")
    try:
        server = getattr(sys.modules.get(__package__ or ""), "_server", None)
        if server is not None:
            server.broadcast({"type": "cc_look", "at": time.time(), "profile": profile_id, "text": text})
    except Exception:
        logger.debug("look announcement failed", exc_info=True)


def _display_name(profile_id: str) -> str:
    from .identity import split_title

    for person in data.list_roster().get("people") or []:
        if person.get("id") == profile_id:
            return split_title(str(person.get("name") or "")) or profile_id
    return profile_id


def set_bot_look(args: dict[str, Any]) -> dict[str, Any]:
    """The `set_bot_look` tool: restyle a bot (or the chief), give it a pet, or reset it."""
    pid = resolve_profile(args.get("profile"))
    name = _display_name(pid)
    from .identity import assistant_name

    chief = assistant_name()
    notes: list[str] = []
    result: dict[str, Any] | None = None
    if _truthy(args.get("reset")):
        result, status = write_face(pid, None)
        if status != 200:
            raise LookError(str(result.get("error") or "The look couldn't be reset."))
        notes.append(f"{chief} gave {name} the default face back")
    elif any(_given(args, key) for key in _LOOK_ARGS):
        home = _home(pid)
        face = face_from_args(args, read_face(_read_meta(home).get("ui_meta"), pid), pid)
        result, status = write_face(pid, face)
        if status != 200:
            raise LookError(str(result.get("error") or "The look couldn't be saved."))
        notes.append(f"{chief} gave {name} {describe(face)}")
    if _given(args, "pet"):
        pet = str(args["pet"]).strip()
        off = pet.lower() in ("none", "off", "no")
        result, _status = set_pet(pid, None if off else pet)
        notes.append(f"{name} has no pet now" if off else f"{name} now has the pet '{pet}'")
    if not notes:
        raise LookError("Say what to change: a style, a colour, the eyes, a pet, or reset.")
    text = "; ".join(notes)
    announce(text, pid)
    out = {"ok": True, "profile": pid, "message": text + "."}
    if result:
        out.update(look=result.get("look"), pet=result.get("pet"))
    return out


TOOL_SCHEMA = {
    "name": "set_bot_look",
    "description": (
        "Change how a bot (or you, the chief) looks in the dashboard: face style, colour, body, eyes, a companion pet, "
        "or back to the default. Cosmetic and reversible, so no need to ask first; say what you changed. "
        "Styles: bubble (soft character with eyes), blob, shape, photo (only if it already has an uploaded photo)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "profile": {"type": "string", "description": "the bot's id or name; 'me' for yourself (the chief)"},
            "style": {"type": "string", "enum": list(STYLES)},
            "color": {"type": "string", "description": "#rrggbb, or a colour word: " + ", ".join(NAMED_COLORS)},
            "body": {"type": "string", "enum": list(BODIES), "description": "bubble only"},
            "eyes": {"type": "string", "enum": list(EYES), "description": "bubble only"},
            "cheeks": {"type": "boolean", "description": "bubble only: rosy cheeks"},
            "shape": {"type": "string", "enum": list(SHAPES), "description": "shape style only"},
            "seed": {"type": "string", "description": "blob only: any short word; each gives a different blob"},
            "blob_kind": {"type": "string", "enum": list(BLOB_KINDS), "description": "blob only"},
            "pet": {"type": "string", "description": "a petdex pet slug to give it a companion, or 'none'"},
            "reset": {"type": "boolean", "description": "true to go back to the default face"},
        },
        "required": ["profile"],
    },
}
