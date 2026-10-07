"""Contract check for looks.py (bot faces, photos, pets) against a real Hermes runtime.

    set HERMES_HOME=<temp>\\profiles\\chief
    <payload python> hermes\\tests\\contract\\run_looks_contract.py <payload dir>

Round-trips a look on a throwaway profile through Hermes's own `_configure_ui_meta` (compare-and-swap revisions,
atomic write), checks that Hermes still reads the profile afterwards, stores a photo, and selects a locally made pet
through Hermes's pet store and config helpers. Offline unless CONTRACT_NETWORK=1 (then the petdex gallery too).
Throwaway home only. Exit 0 = the contract holds.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import threading
import types
from pathlib import Path

payload = Path(sys.argv[1]).resolve()
sys.path[:0] = [str(payload / "hermes-agent"), str(payload / "venv" / "Lib" / "site-packages")]
home = Path(os.environ["HERMES_HOME"]).resolve()
assert home.parent.name == "profiles" and home.name == "chief", "HERMES_HOME must be <root>/profiles/chief"
root = home.parent.parent
home.mkdir(parents=True, exist_ok=True)
helper = home.parent / "helper"
helper.mkdir(exist_ok=True)

plugin = Path(__file__).resolve().parents[2] / "plugins" / "chief-dashboard-bridge"
package = types.ModuleType("bridge")
package.__path__ = [str(plugin)]
sys.modules["bridge"] = package


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"bridge.{name}", plugin / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"bridge.{name}"] = module
    spec.loader.exec_module(module)
    return module


data = load("data")
data.chief_home = lambda root_=None: home
data.profiles_dir = lambda root_=None: home.parent
data.install_root = lambda: root
hermes_api = load("hermes_api")
persona = load("persona")
looks = load("looks")

failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({str(detail)[:300]})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


import yaml

result = hermes_api.run_check()
check("Hermes has every name bot looks uses", result["features"].get("bot looks") is True, [m for m in result["missing"] if "bot looks" in m])

(helper / "profile.yaml").write_text(
    yaml.safe_dump(
        {
            "description": "Finds sources",
            "ui_meta": {"hermes-bots": {"title": "Sam - Researcher", "description": "Finds sources", "sectionId": "team", "shape": "cloud"}},
        },
        sort_keys=False,
    ),
    encoding="utf-8",
)


def meta() -> dict:
    return yaml.safe_load((helper / "profile.yaml").read_text(encoding="utf-8")) or {}


# A face, written through Hermes's own writer.
body, status = looks.write_face("helper", {"style": "bubble", "color": "#12A594", "eyes": "happy", "unknown": 1})
saved = meta()
bots = saved.get("ui_meta", {}).get("hermes-bots", {})
check("a bubble face saves through Hermes's ui_meta writer", status == 200 and body["look"]["color"] == "#12a594", body)
check("our namespace holds the face", saved.get("ui_meta", {}).get("chief") == {"v": 1, "face": body["look"]}, saved.get("ui_meta"))
check(
    "the Hermes mirror is written and the bot's other keys are kept",
    bots.get("shape") == "blobatar:helper:organic"
    and bots.get("color") == "#12a594"
    and bots.get("custom") is True
    and bots.get("imageKind") == "shape"
    and bots.get("title") == "Sam - Researcher"
    and bots.get("sectionId") == "team",
    bots,
)
check("Hermes keeps per-key revisions", saved.get("_ui_meta_revisions") == {"chief": 1, "hermes-bots": 1}, saved.get("_ui_meta_revisions"))
check("the TUI server is not loaded to write a look", "tui_gateway.server" not in sys.modules)

from hermes_cli.profiles import read_profile_meta

hermes_meta = read_profile_meta(helper)
check(
    "Hermes still reads the profile's title and description",
    hermes_meta.get("bot_title") == "Sam - Researcher" and hermes_meta.get("description") == "Finds sources",
    hermes_meta,
)

stale, code = looks.write_face("helper", {"style": "shape", "color": "#fff", "shape": "pill"}, {"chief": 0, "hermes-bots": 0})
check("a stale save is a conflict with the current look", code == 409 and stale.get("conflict") is True and stale["look"]["style"] == "bubble", stale)
fresh, code = looks.write_face("helper", {"style": "shape", "color": "#fff", "shape": "pill"}, body["revisions"])
check(
    "a save with the current revisions goes through",
    code == 200 and fresh["look"]["shape"] == "pill" and fresh["revisions"] == {"chief": 2, "hermes-bots": 2},
    fresh,
)

# Two writers at once: both land (our read-modify-write retries), the file stays whole.
errors: list[object] = []


def writer(color: str) -> None:
    try:
        for _ in range(5):
            looks.write_face("helper", {"style": "shape", "color": color, "shape": "drop"})
    except Exception as exc:  # reported below
        errors.append(exc)


threads = [threading.Thread(target=writer, args=(c,)) for c in ("#111111", "#222222")]
for t in threads:
    t.start()
for t in threads:
    t.join()
after = meta()
check(
    "concurrent saves all land and the profile stays whole",
    not errors and after["ui_meta"]["hermes-bots"]["title"] == "Sam - Researcher" and after["ui_meta"]["chief"]["face"]["shape"] == "drop",
    errors or after,
)

reset, code = looks.write_face("helper", None)
bots = meta().get("ui_meta", {}).get("hermes-bots", {})
check(
    "a reset removes our face and the mirror keys, nothing else",
    code == 200 and reset["look"] is None and "chief" not in meta().get("ui_meta", {}) and not {"shape", "color", "custom", "imageKind"} & set(bots),
    bots,
)
check("the title survives a reset", bots.get("title") == "Sam - Researcher", bots)

# A photo: re-encoded with the payload's Pillow, stored as Hermes stores avatars.
from PIL import Image

buf = io.BytesIO()
Image.new("RGB", (900, 700), (200, 80, 40)).save(buf, format="JPEG")
photo, code = looks.save_avatar("helper", buf.getvalue())
with Image.open(helper / "assets" / "avatar.png") as img:
    size = img.size
check(
    "a photo is stored as a square 512 px PNG and the face becomes the photo", code == 200 and photo["look"]["style"] == "photo" and size == (512, 512), photo
)
check("Hermes's imageKind says photo", meta()["ui_meta"]["hermes-bots"].get("imageKind") == "photo")
try:
    looks.save_avatar("helper", b"GIF89a" + b"\0" * 32)
    check("a GIF is refused", False)
except looks.LookError:
    check("a GIF is refused", True)

# A pet, made locally (no network) and selected through Hermes's store and config, in the bot's own profile.
from agent.pet import store

sheet = io.BytesIO()
Image.new("RGBA", (1536, 1872), (0, 0, 0, 0)).save(sheet, format="WEBP", lossless=True)
with persona.profile_scope(helper):
    store.register_local_pet(sheet.getvalue(), slug="contract-pet", display_name="Contract Pet")
chosen, code = looks.set_pet("helper", "contract-pet")
config = yaml.safe_load((helper / "config.yaml").read_text(encoding="utf-8")) or {}
pet_cfg = (config.get("display") or {}).get("pet") or {}
check(
    "selecting a pet writes display.pet in the bot's own config",
    code == 200 and pet_cfg.get("slug") == "contract-pet" and pet_cfg.get("enabled") is True,
    pet_cfg,
)
check(
    "the chief's config is untouched",
    "pet" not in ((yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}) if (home / "config.yaml").is_file() else {}).get("display", {}),
)
frames = (chosen.get("pet") or {}).get("frames") or {}
check(
    "the pet comes with Hermes's frame geometry",
    chosen.get("pet", {}).get("name") == "Contract Pet"
    and (frames.get("cols"), frames.get("rows"), frames.get("width"), frames.get("height")) == (8, 9, 192, 208)
    and frames.get("states", [None])[0] == "idle",
    chosen.get("pet"),
)
check("the pet sheet is served", (looks.pet_sheet("helper") or (None, ""))[1] == "image/webp")
check("Hermes-bots mirrors the pet", meta()["ui_meta"]["hermes-bots"].get("pet") == "contract-pet")
people = {p["id"]: p for p in data.list_roster()["people"]}
check(
    "the snapshot roster carries look and pet",
    people["helper"]["look"] == {"style": "photo"} and people["helper"]["pet"]["slug"] == "contract-pet",
    people.get("helper"),
)
off, code = looks.set_pet("helper", None)
check("a pet can be turned off", code == 200 and off["pet"] is None and "pet" not in meta()["ui_meta"]["hermes-bots"], off)

if os.environ.get("CONTRACT_NETWORK") == "1":
    gallery = looks.catalog()
    check("the petdex gallery lists pets", gallery.get("ok") is True and len(gallery["pets"]) > 0, gallery.get("error"))
    if gallery.get("pets"):
        check("a gallery thumbnail is a PNG", (looks.thumb(gallery["pets"][0]["slug"]) or b"")[:4] == b"\x89PNG")

print(json.dumps({"failures": failures}))
sys.exit(1 if failures else 0)
