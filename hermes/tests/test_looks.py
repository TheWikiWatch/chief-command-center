"""Bot looks (looks.py): the face schema, the Hermes-native mirror, compare-and-swap saves, photos, pets, the
chief's set_bot_look tool and the snapshot's `look`/`pet` fields."""

import contextlib
import importlib
import io
import json
import struct
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
RUNTIME = ROOT / "hermes/tests/.runtime"
package = types.ModuleType("test_looks_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(RUNTIME / "hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
data = importlib.import_module("test_looks_plugin.data")
persona = importlib.import_module("test_looks_plugin.persona")
identity = importlib.import_module("test_looks_plugin.identity")
looks = importlib.import_module("test_looks_plugin.looks")
fleet = importlib.import_module("test_looks_plugin.fleet")

_MISSING = object()


def fake_module(test: unittest.TestCase, name: str, **attrs) -> types.ModuleType:
    """Put a fake Hermes module in sys.modules for one test; whatever was there comes back afterwards."""
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    old = sys.modules.get(name, _MISSING)
    sys.modules[name] = module

    def restore():
        if old is _MISSING:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = old

    test.addCleanup(restore)
    return module


def write_yaml(path: Path, value: dict) -> None:
    path.write_text(yaml.safe_dump(value, sort_keys=False), encoding="utf-8")


def read_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


# The same semantics as Hermes's `_configure_ui_meta` (tui_gateway/methods_profiles.py): a key-wise merge (None
# deletes), per-key compare-and-swap on `_ui_meta_revisions`, a 64 KB cap, and failures as applied["ui_meta"] False.
# Like Hermes's, its body uses names it doesn't define (`_profile_ui_meta_lock`): looks.py must supply them.
def _read_profile_yaml(profile_dir):
    path = Path(profile_dir) / "profile.yaml"
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except Exception:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _clean_revisions(raw):
    return {str(k): max(0, int(v)) for k, v in raw.items() if isinstance(v, int) and not isinstance(v, bool)}


def fake_configure_ui_meta(profile_dir, params, applied):
    applied["ui_meta"] = False
    try:
        incoming = params["ui_meta"]
        if len(json.dumps(incoming)) > 65536:
            return
        expected = params.get("ui_meta_expected_revisions")
        with _profile_ui_meta_lock:  # noqa: F821 (supplied when the body is rebound, as in Hermes)
            existing = _read_profile_yaml(profile_dir)
            raw = existing.get("_ui_meta_revisions")
            revisions = _clean_revisions(raw if isinstance(raw, dict) else {})
            conflicts = {}
            for key in incoming if isinstance(expected, dict) else ():
                wanted, actual = expected.get(key), revisions.get(key, 0)
                if not isinstance(wanted, int) or isinstance(wanted, bool) or wanted != actual:
                    conflicts[key] = {"expected": wanted, "actual": actual}
            if conflicts:
                applied["ui_meta_conflicts"] = conflicts
                return
            current = existing.get("ui_meta") if isinstance(existing.get("ui_meta"), dict) else {}
            for key, value in incoming.items():
                if value is None:
                    current.pop(key, None)
                else:
                    current[key] = value
                revisions[key] = revisions.get(key, 0) + 1
            if current:
                existing["ui_meta"] = current
            else:
                existing.pop("ui_meta", None)
            existing["_ui_meta_revisions"] = revisions
            write_yaml(Path(profile_dir) / "profile.yaml", existing)
            applied["ui_meta"] = True
    except Exception:
        applied["ui_meta"] = False


# The fake as Hermes's server.py binds it (with the lock), for tests that wrap it.
bound_fake = types.FunctionType(fake_configure_ui_meta.__code__, {**globals(), "_profile_ui_meta_lock": threading.Lock()})


def png_header(width: int, height: int) -> bytes:
    """Just enough of a PNG for looks.image_size (the signature and IHDR)."""
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + b"\x08\x06\x00\x00\x00" + b"\x00" * 8


def picture(fmt: str = "PNG", size=(800, 600), exif: bool = False) -> bytes:
    from PIL import Image

    img = Image.new("RGB", size, (18, 165, 148))
    out = io.BytesIO()
    kwargs = {}
    if exif:
        info = Image.Exif()
        info[0x010E] = "synthetic description"
        kwargs["exif"] = info.tobytes()
    img.save(out, format=fmt, **kwargs)
    return out.getvalue()


class LooksTestCase(unittest.TestCase):
    def setUp(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=RUNTIME)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.profiles = self.root / "profiles"
        self.chief = self.profiles / "chief"
        self.chief.mkdir(parents=True)
        write_yaml(self.chief / "profile.yaml", {"ui_meta": {"hermes-bots": {"title": "Chief - Chief of Staff"}}})
        self.ada = self.profiles / "ada"
        self.ada.mkdir()
        self.ada_meta = {
            "description": "Finds sources",
            "ui_meta": {
                "hermes-bots": {"title": "Ada - Research", "description": "Finds sources", "sectionId": "s1", "groups": ["desk"], "shape": "cloud"},
                "other-app": {"keep": True},
            },
        }
        write_yaml(self.ada / "profile.yaml", self.ada_meta)
        self.scoped: list[Path] = []

        @contextlib.contextmanager
        def scope(home):
            self.scoped.append(Path(home))
            yield

        for target, name, value in (
            (data, "install_root", lambda: self.root),
            (data, "chief_config_scope", contextlib.nullcontext),
            (persona, "profile_scope", scope),
            (looks, "_bound", None),
            (looks, "_catalog", None),
            (looks, "_catalog_failed", 0.0),
            (looks, "_ready_cache", None),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        identity._cache.clear()
        self.addCleanup(identity._cache.clear)
        fake_module(self, "tui_gateway")
        fake_module(self, "tui_gateway.methods_profiles", _configure_ui_meta=fake_configure_ui_meta)

    def meta(self, home: Path | None = None) -> dict:
        return read_yaml((home or self.ada) / "profile.yaml")


class SchemaTests(unittest.TestCase):
    def test_each_style_is_completed_and_unknown_keys_dropped(self):
        self.assertEqual(
            looks.validate_face({"style": "bubble", "color": "#ABC", "junk": 1, "shape": "pill"}),
            {"style": "bubble", "color": "#aabbcc", "body": "bean", "eyes": "dot", "cheeks": False},
        )
        self.assertEqual(
            looks.validate_face({"style": "bubble", "color": "#12A594", "body": "tall", "eyes": "happy", "cheeks": True}),
            {"style": "bubble", "color": "#12a594", "body": "tall", "eyes": "happy", "cheeks": True},
        )
        self.assertEqual(
            looks.validate_face({"style": "blob", "color": "#000000", "eyes": "dot"}, "ada"),
            {"style": "blob", "color": "#000000", "seed": "ada", "blobKind": "organic"},
        )
        self.assertEqual(
            looks.validate_face({"style": "blob", "color": "#000", "seed": " Lucky 7 ", "blobKind": "sun"}),
            {"style": "blob", "color": "#000000", "seed": "Lucky 7", "blobKind": "sun"},
        )
        self.assertEqual(
            looks.validate_face({"style": "shape", "color": "#fff", "shape": "hexagon"}), {"style": "shape", "color": "#ffffff", "shape": "hexagon"}
        )
        self.assertEqual(looks.validate_face({"style": "photo", "color": "#F00", "body": "bean"}), {"style": "photo", "color": "#ff0000"})
        self.assertEqual(looks.validate_face({"style": "photo", "color": "red"}), {"style": "photo"}, "a bad colour with a photo is dropped")

    def test_bad_values_are_plain_400s(self):
        cases = [
            (None, "object"),
            ("bubble", "object"),
            ({"style": "neon", "color": "#fff"}, "style must be one of"),
            ({"style": "bubble"}, "Pick a colour"),
            ({"style": "bubble", "color": "teal"}, "#3fa7d6"),
            ({"style": "bubble", "color": "#12345"}, "#3fa7d6"),
            ({"style": "bubble", "color": 255}, "#3fa7d6"),
            ({"style": "bubble", "color": "#fff", "body": "square"}, "body must be one of"),
            ({"style": "bubble", "color": "#fff", "eyes": "laser"}, "eyes must be one of"),
            ({"style": "bubble", "color": "#fff", "cheeks": "yes"}, "Cheeks"),
            ({"style": "blob", "color": "#fff", "seed": "a:b"}, "seed"),
            ({"style": "blob", "color": "#fff", "seed": "x" * 41}, "seed"),
            ({"style": "blob", "color": "#fff", "seed": ""}, "seed"),
            ({"style": "blob", "color": "#fff", "blobKind": "star"}, "blob kind"),
            ({"style": "shape", "color": "#fff", "shape": "star"}, "shape must be one of"),
        ]
        for raw, message in cases:
            with self.subTest(raw=raw):
                with self.assertRaises(looks.LookError) as caught:
                    looks.validate_face(raw)
                self.assertIn(message, str(caught.exception))
                self.assertEqual(caught.exception.status, 400)

    def test_reading_is_lenient(self):
        good = {"style": "shape", "color": "#ffffff", "shape": "pill"}
        self.assertEqual(looks.read_face({"chief": {"v": 1, "face": good}}), good)
        for ui in (
            None,
            "x",
            {},
            {"chief": "x"},
            {"chief": {"face": good}},
            {"chief": {"v": 2, "face": good}},
            {"chief": {"v": 1, "face": {"style": "shape"}}},
        ):
            with self.subTest(ui=ui):
                self.assertIsNone(looks.read_face(ui))

    def test_the_hermes_mirror_for_each_style_keeps_everything_else(self):
        bots = {"title": "Ada - Research", "description": "d", "sections": ["a"], "shape": "cloud", "pet": "boba"}
        bubble = looks.validate_face({"style": "bubble", "color": "#123456", "body": "pebble"})
        self.assertEqual(
            looks.mirror(bubble, "ada", bots),
            {**bots, "shape": "blobatar:ada:boxy", "color": "#123456", "custom": True, "imageKind": "shape"},
        )
        for body, kind in looks.BODY_TO_BLOB.items():
            self.assertEqual(looks.mirror({**bubble, "body": body}, "ada", {})["shape"], f"blobatar:ada:{kind}")
        blob = looks.validate_face({"style": "blob", "color": "#123456", "seed": "s1", "blobKind": "nub"})
        self.assertEqual(looks.mirror(blob, "ada", bots)["shape"], "blobatar:s1:nub")
        shape = looks.validate_face({"style": "shape", "color": "#123456", "shape": "drop"})
        self.assertEqual(looks.mirror(shape, "ada", bots), {**bots, "shape": "drop", "color": "#123456", "custom": True, "imageKind": "shape"})
        self.assertEqual(looks.mirror({"style": "photo"}, "ada", bots), {**bots, "imageKind": "photo"})
        reset = looks.mirror(None, "ada", {**bots, "color": "#123456", "custom": True, "imageKind": "photo"})
        self.assertEqual(reset, {"title": "Ada - Research", "description": "d", "sections": ["a"], "pet": "boba"})
        self.assertEqual(bots["shape"], "cloud", "the input is not changed")

    def test_describe(self):
        self.assertEqual(looks.describe({"style": "bubble", "color": "#12a594"}), "a teal bubble")
        self.assertEqual(looks.describe({"style": "shape", "color": "#ffb224", "shape": "hexagon"}), "an amber hexagon shape")
        self.assertEqual(looks.describe({"style": "blob", "color": "#010203"}), "a #010203 blob")
        self.assertEqual(looks.describe({"style": "photo"}), "a photo")


class WriteTests(LooksTestCase):
    def test_a_face_is_saved_with_its_mirror_and_hermes_keys_are_kept(self):
        body, status = looks.write_face("ada", {"style": "bubble", "color": "#0090FF", "eyes": "oval", "extra": "dropped"})
        self.assertEqual(status, 200)
        face = {"style": "bubble", "color": "#0090ff", "body": "bean", "eyes": "oval", "cheeks": False}
        self.assertEqual(body["look"], face)
        self.assertEqual(body["revisions"], {"chief": 1, "hermes-bots": 1})
        self.assertFalse(body["hasAvatar"])
        meta = self.meta()
        self.assertEqual(meta["ui_meta"]["chief"], {"v": 1, "face": face})
        self.assertEqual(
            meta["ui_meta"]["hermes-bots"],
            {
                "title": "Ada - Research",
                "description": "Finds sources",
                "sectionId": "s1",
                "groups": ["desk"],
                "shape": "blobatar:ada:organic",
                "color": "#0090ff",
                "custom": True,
                "imageKind": "shape",
            },
        )
        self.assertEqual(meta["ui_meta"]["other-app"], {"keep": True})
        self.assertEqual(meta["description"], "Finds sources")

    def test_reset_removes_ours_and_the_mirror_keys_only(self):
        looks.write_face("ada", {"style": "shape", "color": "#fff", "shape": "pill"})
        body, status = looks.write_face("ada", None)
        self.assertEqual(status, 200)
        self.assertIsNone(body["look"])
        ui = self.meta()["ui_meta"]
        self.assertNotIn("chief", ui)
        self.assertEqual(ui["hermes-bots"], {"title": "Ada - Research", "description": "Finds sources", "sectionId": "s1", "groups": ["desk"]})

    def test_a_stale_save_is_a_409_with_the_current_look(self):
        first, _ = looks.write_face("ada", {"style": "shape", "color": "#fff", "shape": "pill"})
        stale = {"chief": 0, "hermes-bots": 0}
        body, status = looks.write_face("ada", {"style": "shape", "color": "#000", "shape": "drop"}, stale)
        self.assertEqual(status, 409)
        self.assertTrue(body["conflict"])
        self.assertEqual(body["look"]["shape"], "pill")
        self.assertEqual(body["revisions"], first["revisions"])
        body, status = looks.write_face("ada", {"style": "shape", "color": "#000", "shape": "drop"}, first["revisions"])
        self.assertEqual(status, 200)
        self.assertEqual(body["look"]["shape"], "drop")
        with self.assertRaises(looks.LookError):
            looks.write_face("ada", None, {"chief": "1"})

    def test_another_writer_in_between_is_retried_not_overwritten(self):
        calls = []

        def racing(profile_dir, params, applied):
            if not calls:  # Hermes's own editor renames the bot between our read and our write
                meta = _read_profile_yaml(profile_dir)
                meta["ui_meta"]["hermes-bots"]["title"] = "Ada - Sources"
                meta["_ui_meta_revisions"] = {"hermes-bots": 7}
                write_yaml(Path(profile_dir) / "profile.yaml", meta)
            calls.append(dict(params["ui_meta_expected_revisions"]))
            bound_fake(profile_dir, params, applied)

        fake_module(self, "tui_gateway.methods_profiles", _configure_ui_meta=racing)
        body, status = looks.write_face("ada", {"style": "shape", "color": "#fff", "shape": "pill"})
        self.assertEqual(status, 200)
        self.assertEqual(calls, [{"chief": 0, "hermes-bots": 0}, {"chief": 0, "hermes-bots": 7}])
        self.assertEqual(self.meta()["ui_meta"]["hermes-bots"]["title"], "Ada - Sources")
        self.assertEqual(body["revisions"], {"chief": 1, "hermes-bots": 8})

    def test_hermes_refusing_the_write_is_an_error_not_a_success(self):
        fake_module(self, "tui_gateway.methods_profiles", _configure_ui_meta=lambda d, p, applied: applied.update(ui_meta=False))
        with self.assertRaises(looks.LookError) as caught:
            looks.write_face("ada", {"style": "shape", "color": "#fff"})
        self.assertEqual(caught.exception.status, 500)

    def test_the_tui_servers_bound_writer_is_used_when_loaded(self):
        used = []
        fake_module(self, "tui_gateway.server", _configure_ui_meta=lambda d, p, a: used.append(Path(d).name) or bound_fake(d, p, a))
        fake_module(self, "tui_gateway.methods_profiles")  # no unbound copy needed when the server has one
        _, status = looks.write_face("ada", {"style": "shape", "color": "#fff"})
        self.assertEqual(status, 200)
        self.assertEqual(used, ["ada"])

    def test_unknown_profiles_and_a_missing_face(self):
        for pid in ("nobody", "../chief", "ada/x"):
            with self.assertRaises(looks.LookError) as caught:
                looks.write_face(pid, None)
            self.assertEqual(caught.exception.status, 404)
        with self.assertRaises(looks.LookError):
            looks.write_face("ada")
        self.assertEqual(looks.call(lambda: looks.write_face("nobody", None)), ({"ok": False, "error": "Unknown profile."}, 404))

    def test_photo_needs_an_avatar(self):
        with self.assertRaises(looks.LookError) as caught:
            looks.write_face("ada", {"style": "photo"})
        self.assertIn("photo first", str(caught.exception))

    def test_the_chief_is_written_in_its_own_home(self):
        _, status = looks.write_face("chief", {"style": "bubble", "color": "#e93d82"})
        self.assertEqual(status, 200)
        self.assertEqual(self.meta(self.chief)["ui_meta"]["hermes-bots"]["shape"], "blobatar:chief:organic")
        self.assertEqual(self.meta(self.chief)["ui_meta"]["hermes-bots"]["title"], "Chief - Chief of Staff")


class AvatarTests(LooksTestCase):
    def test_a_picture_becomes_a_square_png_avatar_and_the_face_a_photo(self):
        assets = self.ada / "assets"
        assets.mkdir()
        (assets / "avatar.jpg").write_bytes(b"old")
        looks.write_face("ada", {"style": "bubble", "color": "#12a594"})
        body, status = looks.save_avatar("ada", picture("JPEG", (900, 600), exif=True))
        self.assertEqual(status, 200)
        self.assertEqual(body["look"], {"style": "photo", "color": "#12a594"})
        self.assertTrue(body["hasAvatar"])
        self.assertFalse((assets / "avatar.jpg").exists())
        from PIL import Image

        with Image.open(assets / "avatar.png") as img:
            self.assertEqual((img.format, img.size), ("PNG", (512, 512)))
            self.assertNotIn("exif", img.info)
        bots = self.meta()["ui_meta"]["hermes-bots"]
        self.assertEqual(bots["imageKind"], "photo")
        self.assertEqual(bots["title"], "Ada - Research")

    def test_small_pictures_are_not_enlarged(self):
        raw, ext = looks.encode_avatar(picture("WEBP", (120, 200)))
        from PIL import Image

        self.assertEqual(ext, "png")
        with Image.open(io.BytesIO(raw)) as img:
            self.assertEqual(img.size, (120, 120))

    def test_only_real_png_jpeg_or_webp_up_to_2mb(self):
        cases = [
            (b"", 400),
            (b"GIF89a" + b"\x00" * 20, 400),
            (b"<svg xmlns='http://www.w3.org/2000/svg'/>", 400),
            (b"\x89PNG\r\n\x1a\n" + b"\x00" * 40, 400),  # a PNG signature on junk
            (b"\x89PNG\r\n\x1a\n" + b"\x00" * looks.AVATAR_MAX, 413),
        ]
        for blob, status in cases:
            with self.subTest(blob=blob[:12]):
                with self.assertRaises(looks.LookError) as caught:
                    looks.save_avatar("ada", blob)
                self.assertEqual(caught.exception.status, status)
        self.assertFalse((self.ada / "assets").exists())
        self.assertEqual(looks.sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "webp")
        self.assertEqual(looks.sniff(b"\xff\xd8\xff\xe0"), "jpg")

    def test_without_pillow_the_checked_original_is_kept(self):
        blob = b"\xff\xd8\xff\xe0synthetic-jpeg"
        with patch.dict(sys.modules, {"PIL": None}):
            self.assertEqual(looks.encode_avatar(blob), (blob, "jpg"))


class PetTests(LooksTestCase):
    def install(self, home: Path, slug: str = "boba", size=(1536, 1872), sheet: str = "spritesheet.png", enabled=True) -> None:
        folder = home / "pets" / slug
        folder.mkdir(parents=True)
        (folder / "pet.json").write_text(json.dumps({"id": slug, "displayName": slug.title(), "spritesheetPath": sheet}), encoding="utf-8")
        (folder / sheet).write_bytes(png_header(*size))
        write_yaml(home / "config.yaml", {"display": {"pet": {"enabled": enabled, "slug": slug, "scale": 0.33}}})

    def test_an_active_installed_pet_with_its_frames(self):
        self.install(self.ada)
        pet = looks.active_pet(self.ada, "ada")
        self.assertEqual(pet["slug"], "boba")
        self.assertEqual(pet["name"], "Boba")
        self.assertEqual(pet["sheetUrl"], "/pet/ada/sheet")
        self.assertEqual(pet["frames"], {"width": 192, "height": 208, "cols": 8, "rows": 9, "steps": 6, "loopMs": 1100, "states": looks._CODEX_ROWS})
        self.assertEqual(looks.pet_sheet("ada"), (self.ada / "pets" / "boba" / "spritesheet.png", "image/png"))

    def test_an_older_sheet_has_the_legacy_rows(self):
        self.install(self.ada, size=(1728, 1664))
        frames = looks.active_pet(self.ada, "ada")["frames"]
        self.assertEqual((frames["cols"], frames["rows"], frames["states"]), (9, 8, looks._LEGACY_ROWS))

    def test_webp_headers_are_measured(self):
        path = self.root / "sheet.webp"
        vp8x = b"RIFF\x00\x00\x00\x00WEBPVP8X" + b"\x0a\x00\x00\x00" + b"\x00\x00\x00\x00" + (1535).to_bytes(3, "little") + (1871).to_bytes(3, "little")
        path.write_bytes(vp8x + b"\x00" * 30)
        self.assertEqual(looks.image_size(path), (1536, 1872))
        lossless = self.root / "sheet2.webp"
        bits = (1536 - 1) | ((1872 - 1) << 14)
        lossless.write_bytes(b"RIFF\x00\x00\x00\x00WEBPVP8L" + b"\x00\x00\x00\x00\x2f" + bits.to_bytes(4, "little") + b"\x00" * 30)
        self.assertEqual(looks.image_size(lossless), (1536, 1872))

    def test_no_pet_or_a_broken_one_is_none_never_an_error(self):
        self.assertIsNone(looks.active_pet(self.ada, "ada"))
        self.install(self.ada, enabled=False)
        self.assertIsNone(looks.active_pet(self.ada, "ada"))
        write_yaml(self.ada / "config.yaml", {"display": {"pet": {"enabled": True, "slug": "ghost"}}})
        self.assertIsNone(looks.active_pet(self.ada, "ada"))
        write_yaml(self.ada / "config.yaml", {"display": {"pet": {"enabled": True, "slug": "../chief"}}})
        self.assertIsNone(looks.active_pet(self.ada, "ada"))
        write_yaml(self.ada / "config.yaml", {"display": "compact"})
        self.assertIsNone(looks.active_pet(self.ada, "ada"))
        self.assertIsNone(looks.pet_sheet("ada"))
        self.assertIsNone(looks.pet_sheet("../ada"))

    def test_choosing_a_pet_installs_it_in_the_bots_profile_and_selects_it(self):
        calls = []

        def install_pet(slug):
            calls.append(("install", slug, self.scoped[-1].name))
            folder = self.scoped[-1] / "pets" / slug
            folder.mkdir(parents=True)
            (folder / "spritesheet.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBPVP8X" + b"\x00" * 30)

        def set_active(slug):
            calls.append(("select", slug, self.scoped[-1].name))
            write_yaml(self.scoped[-1] / "config.yaml", {"display": {"pet": {"enabled": True, "slug": slug}}})

        def set_enabled(enabled):
            calls.append(("enabled", enabled, self.scoped[-1].name))
            cfg = read_yaml(self.scoped[-1] / "config.yaml")
            cfg["display"]["pet"]["enabled"] = enabled
            write_yaml(self.scoped[-1] / "config.yaml", cfg)

        fake_module(self, "agent.pet.store", install_pet=install_pet)
        fake_module(self, "hermes_cli.pets", _set_active=set_active, _set_enabled=set_enabled)
        body, status = looks.set_pet("ada", "boba")
        self.assertEqual(status, 200)
        self.assertEqual(body["pet"]["slug"], "boba")
        self.assertEqual(body["pet"]["frames"]["cols"], 8, "an unreadable header falls back to the petdex grid")
        self.assertEqual(calls, [("install", "boba", "ada"), ("select", "boba", "ada")])
        self.assertEqual(self.meta()["ui_meta"]["hermes-bots"]["pet"], "boba")
        self.assertEqual(self.meta()["ui_meta"]["hermes-bots"]["title"], "Ada - Research")
        body, _ = looks.set_pet("ada", None)
        self.assertIsNone(body["pet"])
        self.assertEqual(calls[-1], ("enabled", False, "ada"))
        self.assertNotIn("pet", self.meta()["ui_meta"]["hermes-bots"])
        with self.assertRaises(looks.LookError):
            looks.set_pet("ada", "../../etc")

    def test_a_failed_download_is_a_plain_error(self):
        def install_pet(slug):
            raise RuntimeError("download failed for https://synthetic.example/x")

        fake_module(self, "agent.pet.store", install_pet=install_pet)
        fake_module(self, "hermes_cli.pets", _set_active=lambda slug: None, _set_enabled=lambda on: None)
        with self.assertLogs("chief-dashboard-bridge", level="INFO"):
            body, status = looks.call(lambda: looks.set_pet("ada", "boba"))
        self.assertEqual(status, 502)
        self.assertNotIn("synthetic.example", body["error"])

    def test_the_catalog_is_cached_and_a_network_failure_is_an_empty_list(self):
        fetched = []
        entries = [
            types.SimpleNamespace(slug="boba", display_name="Boba", spritesheet_url="https://assets.petdex.dev/curated/boba.webp"),
            types.SimpleNamespace(slug="bad slug", display_name="x", spritesheet_url="https://assets.petdex.dev/x.webp"),
            types.SimpleNamespace(slug="mochi", display_name="", spritesheet_url="https://assets.petdex.dev/m.webp"),
        ]
        fake_module(self, "agent.pet.manifest", fetch_manifest=lambda timeout: fetched.append(timeout) or entries)
        fake_module(self, "agent.pet.store", install_pet=None, thumbnail_png=lambda slug, source_url: f"{slug}|{source_url}".encode())
        result = looks.catalog()
        self.assertEqual(
            result["pets"],
            [
                {"slug": "boba", "name": "Boba", "description": "", "thumbUrl": "/pets/thumb/boba", "curated": True},
                {"slug": "mochi", "name": "mochi", "description": "", "thumbUrl": "/pets/thumb/mochi", "curated": False},
            ],
        )
        looks.catalog()
        self.assertEqual(len(fetched), 1)
        self.assertEqual(looks.thumb("boba"), b"boba|https://assets.petdex.dev/curated/boba.webp")
        self.assertIsNone(looks.thumb("../x"))
        self.assertTrue(looks.pets_usable())

        def offline(timeout):
            raise OSError("offline")

        looks._catalog = None
        fake_module(self, "agent.pet.manifest", fetch_manifest=offline)
        with self.assertLogs("chief-dashboard-bridge", level="INFO"):
            failed = looks.catalog()
        self.assertEqual(failed["pets"], [])
        self.assertIn("pet gallery", failed["error"])
        self.assertFalse(looks.pets_usable())


class PortraitTests(LooksTestCase):
    def test_no_generator_is_a_plain_400(self):
        with patch.object(looks, "image_ready", return_value=False):
            self.assertEqual(looks.call(lambda: looks.portrait("ada")), ({"ok": False, "error": looks.NO_IMAGE_GENERATOR}, 400))

    def test_a_generated_portrait_becomes_the_photo(self):
        (self.ada / "SOUL.md").write_text("# You are Ada, a careful researcher.\n\nMore.\n", encoding="utf-8")
        generated = self.root / "generated.png"
        generated.write_bytes(picture("PNG", (1024, 1024)))
        prompts = []
        with patch.object(looks, "image_ready", return_value=True), patch.object(looks, "_generate", lambda prompt: prompts.append(prompt) or str(generated)):
            body, status = looks.portrait("ada", "  wearing   round glasses ")
        self.assertEqual(status, 200)
        self.assertEqual(body["look"], {"style": "photo"})
        self.assertIn("named Ada, the Research.", prompts[0])
        self.assertIn("Its character: You are Ada, a careful researcher.", prompts[0])
        self.assertIn("wearing round glasses", prompts[0])
        self.assertIn("plain dark background", prompts[0])

    def test_a_slow_generator_times_out(self):
        with patch.object(looks, "PORTRAIT_TIMEOUT", 0.05), patch.object(looks, "image_ready", return_value=True):
            event = threading.Event()
            self.addCleanup(event.set)
            with patch.object(looks, "_generate", lambda prompt: event.wait(5)):
                body, status = looks.call(lambda: looks.portrait("ada"))
        self.assertEqual(status, 504)


class ToolTests(LooksTestCase):
    def tool(self, **args) -> dict:
        handler = {name: h for name, _schema, h, _emoji in fleet.TOOLS}["set_bot_look"]
        return json.loads(handler(args))

    def test_profiles_resolve_by_id_name_or_me(self):
        self.assertEqual(looks.resolve_profile("me"), "chief")
        self.assertEqual(looks.resolve_profile(" Yourself "), "chief")
        self.assertEqual(looks.resolve_profile("ada"), "ada")
        self.assertEqual(looks.resolve_profile("Ada"), "ada")
        self.assertEqual(looks.resolve_profile("ada - research"), "ada")
        with self.assertRaises(looks.LookError):
            looks.resolve_profile("Grace")

    def test_the_chief_restyles_a_bot_step_by_step(self):
        first = self.tool(profile="Ada", style="bubble", color="teal", eyes="happy", cheeks=True)
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["message"], "Chief gave Ada a teal bubble.")
        self.assertEqual(first["look"], {"style": "bubble", "color": "#12a594", "body": "bean", "eyes": "happy", "cheeks": True})
        second = self.tool(profile="ada", color="#F76B15")
        self.assertEqual(second["look"], {"style": "bubble", "color": "#f76b15", "body": "bean", "eyes": "happy", "cheeks": True}, "the rest is kept")
        third = self.tool(profile="ada", style="shape", shape="hexagon")
        self.assertEqual(third["look"], {"style": "shape", "color": "#f76b15", "shape": "hexagon"}, "the colour carries over")
        self.assertEqual(third["message"], "Chief gave Ada an orange hexagon shape.")
        mine = self.tool(profile="me", style="blob", blob_kind="sun")
        self.assertEqual(mine["profile"], "chief")
        self.assertEqual(mine["look"]["seed"], "chief")
        self.assertEqual(mine["look"]["color"], looks.default_color("chief"))
        reset = self.tool(profile="ada", reset=True)
        self.assertIsNone(reset["look"])
        self.assertIn("default face", reset["message"])

    def test_bad_requests_come_back_as_plain_errors(self):
        for args, message in (
            ({"profile": "ada", "style": "bubble", "eyes": "laser"}, "eyes must be one of"),
            ({"profile": "ada", "color": "chartreuse-ish"}, "#3fa7d6"),
            ({"profile": "ada"}, "Say what to change"),
            ({"profile": "Grace", "color": "teal"}, "no bot called"),
            ({"profile": "ada", "style": "photo"}, "photo first"),
        ):
            with self.subTest(args=args):
                answer = self.tool(**args)
                self.assertFalse(answer["ok"])
                self.assertIn(message, answer["error"])

    def test_a_pet_by_tool(self):
        fake_module(self, "agent.pet.store", install_pet=lambda slug: None)
        fake_module(self, "hermes_cli.pets", _set_active=lambda slug: None, _set_enabled=lambda on: None)
        answer = self.tool(profile="ada", pet="none")
        self.assertTrue(answer["ok"])
        self.assertEqual(answer["message"], "Ada has no pet now.")

    def test_the_schema_matches_the_validator(self):
        props = looks.TOOL_SCHEMA["parameters"]["properties"]
        self.assertEqual(props["style"]["enum"], list(looks.STYLES))
        self.assertEqual(props["eyes"]["enum"], list(looks.EYES))
        self.assertEqual(props["blob_kind"]["enum"], list(looks.BLOB_KINDS))
        self.assertIn("cosmetic", looks.TOOL_SCHEMA["description"].lower())


class SnapshotTests(LooksTestCase):
    def test_the_roster_carries_look_and_pet_and_malformed_ones_are_null(self):
        looks.write_face("ada", {"style": "bubble", "color": "#3e63dd"})
        write_yaml(self.chief / "profile.yaml", {"ui_meta": {"chief": {"v": 1, "face": {"style": "bubble", "color": "red"}}}})
        folder = self.ada / "pets" / "boba"
        folder.mkdir(parents=True)
        (folder / "spritesheet.webp").write_bytes(b"not a picture")
        write_yaml(self.ada / "config.yaml", {"display": {"pet": {"enabled": "true", "slug": "boba"}}})
        people = {p["id"]: p for p in data.list_roster()["people"]}
        self.assertEqual(people["ada"]["look"], {"style": "bubble", "color": "#3e63dd", "body": "bean", "eyes": "dot", "cheeks": False})
        self.assertEqual(people["ada"]["pet"]["slug"], "boba")
        self.assertEqual(people["ada"]["pet"]["sheetUrl"], "/pet/ada/sheet")
        self.assertEqual(people["ada"]["shape"], "blobatar:ada:organic")
        self.assertIsNone(people["chief"]["look"])
        self.assertIsNone(people["chief"]["pet"])

    def test_a_photo_avatar_url_changes_with_the_picture(self):
        looks.save_avatar("ada", picture())
        url = next(p for p in data.list_roster()["people"] if p["id"] == "ada")["avatarUrl"]
        self.assertTrue(url.startswith("/api/bridge/avatar/ada?v="), url)


if __name__ == "__main__":
    unittest.main()
