"""The chief's workforce (contract `chief.fleet.v1`): mint, pin a model, retire to an archive, restore.

Used by the dashboard (Fleet tab, each bot's Look drawer) and by the chief itself through the `fleet` toolset
(plugin tools), so both go through the same code and the same rules:

- Mint needs the owner's sign-off. The worker is a Hermes profile created by Hermes (`create_profile`, no skills,
  **no alias**: Hermes would otherwise write a command wrapper named after the profile into a folder shared by
  every Hermes install of this user). It starts on the chief's model (the owner's default), gets only the API
  key that model needs, its own working folder, a display name, its signed SOUL and a place on the roster.
- A bot's model can be changed to any model of a connected provider; the key goes with it.
- Retire = Hermes's own `export_profile` (secrets are left out) into `fleet-archive/`, then only that profile's
  folder is removed. Never `delete_profile`: on Windows it also disables the scheduled task named after the
  profile, which can belong to ANOTHER Hermes install on the same PC (see docs/FRAGILE_SEAMS.md).
- Restore imports the archive and gives the bot its provider key again. Removing an archive is permanent and
  is offered to the owner only (not a tool).
- A new bot can arrive with a look (looks.py); the chief restyles any bot with `set_bot_look`, cosmetic and
  reversible, so it needs no sign-off.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import stat
import time
from pathlib import Path
from typing import Any

from . import data, looks, persona, providers
from .util import subdict

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.fleet.v1"
_NAME = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_RESERVED = {"chief", "default"}
_SOUL_MAX = 20_000
TEAM_SECTION = "Team"


class FleetError(ValueError):
    pass


def _root() -> Path:
    return data.install_root()


def _archive_dir() -> Path:
    return _root() / "fleet-archive"


def _load_yaml(path: Path) -> dict[str, Any]:
    return data.load_yaml(path) if path.is_file() else {}


def _write_yaml(path: Path, value: dict[str, Any]) -> None:
    import yaml

    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(yaml.safe_dump(value, sort_keys=False, allow_unicode=True), encoding="utf-8")
    os.replace(tmp, path)
    data.forget_yaml(path)


def _worker_dirs() -> list[Path]:
    pdir = data.profiles_dir(_root())
    if not pdir.is_dir():
        return []
    out = []
    for entry in sorted(pdir.iterdir()):
        if entry.is_dir() and not entry.name.startswith(".") and entry.name not in _RESERVED and not data.named_profile_is_deleted(entry):
            out.append(entry)
    return out


def _busy(name: str) -> bool:
    try:
        jobs = data.work_status().get("jobs") or {}
        return (data.job_for_person(jobs, name).get("status") or "") == "working"
    except Exception:
        return False


def _describe(entry: Path) -> dict[str, Any]:
    meta = _load_yaml(entry / "profile.yaml")
    ui = (meta.get("ui_meta") or {}).get("hermes-bots") if isinstance(meta.get("ui_meta"), dict) else {}
    ui = ui if isinstance(ui, dict) else {}
    cfg = _load_yaml(entry / "config.yaml")
    model = subdict(cfg, "model")
    terminal = subdict(cfg, "terminal")
    return {
        "id": entry.name,
        "title": str(ui.get("title") or entry.name),
        "description": str(meta.get("description") or ""),
        "model": {"provider": str(model.get("provider") or ""), "model": str(model.get("default") or "")},
        "cwd": str(terminal.get("cwd") or ""),
        "working": _busy(entry.name),
    }


def roster() -> dict[str, Any]:
    return {"ok": True, "contract": CONTRACT, "workers": [_describe(e) for e in _worker_dirs()], "archives": archives()}


# ---------------------------------------------------------------- sections (the Fleet tab's grouping)


def _sections_assign(name: str, section: str | None) -> None:
    path = _root() / "bot-sections.json"
    try:
        doc = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except ValueError:
        doc = {}
    sections = [s for s in (doc.get("sections") or []) if isinstance(s, str)]
    assign = subdict(doc, "assign")
    if section:
        if section not in sections:
            sections.append(section)
        assign[name] = section
    else:
        assign.pop(name, None)
    doc["sections"], doc["assign"] = sections, assign
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------- mint


def _chief_model() -> dict[str, str]:
    cfg = _load_yaml(data.chief_home() / "config.yaml")
    model = subdict(cfg, "model")
    return {"provider": str(model.get("provider") or ""), "model": str(model.get("default") or "")}


def mint(name: str, display_name: str, role: str, description: str, soul: str, *, owner_signed: bool, cwd: str = "", look: Any = None) -> dict[str, Any]:
    if not owner_signed:
        raise FleetError("A new bot needs the owner's sign-off on its SOUL draft first. Show the draft and ask.")
    name = (name or "").strip().lower()
    display_name, role = " ".join(str(display_name or "").split()), " ".join(str(role or "").split())
    description, soul = " ".join(str(description or "").split()), str(soul or "").replace("\r\n", "\n").strip()
    if not _NAME.match(name) or name in _RESERVED:
        raise FleetError("Use a short lowercase id like 'research-desk' (letters, digits, dashes).")
    if not display_name or len(display_name) > 40 or not role or len(role) > 60:
        raise FleetError("Give the bot a first name and a short role.")
    if not soul or len(soul) > _SOUL_MAX:
        raise FleetError("The SOUL is empty or too long (one screen is the goal).")
    if (data.profiles_dir(_root()) / name).exists():
        raise FleetError(f"A bot with the id '{name}' already exists.")
    face = None
    if look:
        if not isinstance(look, dict):
            raise FleetError("The look must be an object like {style, color}.")
        try:
            face = looks.face_from_args({**look, "blob_kind": look.get("blob_kind") or look.get("blobKind")}, None, name)
        except looks.LookError as exc:
            raise FleetError(f"The look: {exc}") from exc
        if face["style"] == "photo":
            raise FleetError("A new bot can't start with a photo; give it a bubble, blob or shape (a photo can be added later).")
    chief_model = _chief_model()
    with data.chief_config_scope():
        from hermes_cli.profiles import create_profile, launch_model_seed

        home = Path(create_profile(name, no_alias=True, no_skills=True, description=description[:300] or None))
    try:
        cfg = _load_yaml(home / "config.yaml")
        if not cfg.get("model"):
            # Hermes seeds the active profile's model; make sure it's the chief's (the owner's default).
            from hermes_cli.config import read_user_config_raw

            seed = launch_model_seed(read_user_config_raw(data.chief_home() / "config.yaml") or {})
            if seed:
                _write_yaml(home / "config.yaml", {**cfg, **seed})
        workdir = _workdir(cwd) if cwd else _root() / "workspaces" / name
        workdir.mkdir(parents=True, exist_ok=True)
        from cli import save_config_value

        with persona.profile_scope(home):
            save_config_value("terminal.cwd", str(workdir))
        meta = _load_yaml(home / "profile.yaml")
        if not isinstance(meta.get("ui_meta"), dict):
            meta["ui_meta"] = {}
        ui = meta["ui_meta"]
        bots = subdict(ui, "hermes-bots")
        bots["title"] = f"{display_name} - {role}"
        ui["hermes-bots"] = bots
        if description:
            meta["description"] = description[:300]
        _write_yaml(home / "profile.yaml", meta)
        (home / "SOUL.md").write_text(soul + "\n", encoding="utf-8")
        granted = providers.grant_provider(chief_model["provider"], home) if chief_model["provider"] else {"keys": 0}
        # The owner's Second Brain, the same way the chief has it (when one is set up).
        from . import second_brain

        second_brain.share_with(home)
        _sections_assign(name, TEAM_SECTION)
        if face is not None:
            looks.write_face(name, face)
    except Exception:
        logger.warning("mint of %s failed part-way; removing the half-made profile", name)
        _remove_tree(home)
        raise
    logger.info("fleet: minted %s on %s/%s", name, chief_model["provider"], chief_model["model"])
    return {"ok": True, "worker": _describe(home), "keys_granted": granted.get("keys", 0)}


# ---------------------------------------------------------------- model


def models(refresh: bool = False) -> dict[str, Any]:
    return providers.connected_models(refresh=refresh)


def set_model(profile: str, provider: str, model: str, *, confirm_expensive: bool = False) -> dict[str, Any]:
    profile = (profile or "chief").strip().lower()
    offered = {(g["provider"], m) for g in models()["groups"] for m in g["models"]}
    if (provider, model) not in offered:
        raise FleetError("That model isn't offered by a connected provider. Add the provider's key first.")
    if profile == "chief":
        return providers.choose_model(provider, model, confirm_expensive=confirm_expensive)
    home = persona.profile_home(profile)
    granted = providers.grant_provider(provider, home)
    result = providers.choose_model(provider, model, confirm_expensive=confirm_expensive, home=home)
    if result.get("ok"):
        logger.info("fleet: %s now on %s/%s", profile, provider, model)
        result["keys_granted"] = granted.get("keys", 0)
    return result


def _model_home(profile: str) -> Path | None:
    profile = (profile or "chief").strip().lower()
    return None if profile == "chief" else persona.profile_home(profile)


def effort(profile: str) -> dict[str, Any]:
    """How hard the profile's current model thinks, and the levels it takes."""
    return providers.effort(_model_home(profile))


def set_effort(profile: str, value: str) -> dict[str, Any]:
    return providers.set_effort(value, _model_home(profile))


# ---------------------------------------------------------------- retire / restore


def _remove_tree(path: Path) -> None:
    def _writable(func, target, _exc):
        try:
            os.chmod(target, stat.S_IWRITE)
            func(target)
        except OSError:
            pass

    for _ in range(3):
        if path.exists():
            shutil.rmtree(path, onexc=_writable)
        if not path.exists():
            return
        time.sleep(0.5)
    if path.exists():
        raise FleetError("Some of the bot's files are in use. Close anything using them and try again.")


def archives() -> list[dict[str, Any]]:
    folder = _archive_dir()
    out = []
    for sidecar in sorted(folder.glob("*.json"), reverse=True) if folder.is_dir() else []:
        try:
            info = json.loads(sidecar.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if Path(info.get("file", "")).is_file():
            info["id"] = sidecar.stem
            out.append(info)
    return out


def _workdir(cwd: str) -> Path:
    """A bot's own working folder: a full path on this PC (never a network share), outside Chief's own files."""
    path = Path(str(cwd).strip().strip('"')).expanduser()
    text = str(path)
    if not path.is_absolute() or text.startswith(("\\\\", "//")):
        raise FleetError("Give the working folder as a full path on this PC, like C:\\Users\\you\\Projects\\research.")
    resolved = path.resolve(strict=False)
    root = _root().resolve(strict=False)
    inside_chief = resolved == root or root in resolved.parents
    in_workspaces = (root / "workspaces") in resolved.parents
    if inside_chief and not in_workspaces:
        raise FleetError("That folder belongs to Chief itself. Choose one of your own folders.")
    return path


def _archive(archive_id: str) -> tuple[Path, dict[str, Any]]:
    """An archive's sidecar and what it says, checked: a bot can write into `fleet-archive\\`, so the archive it
    names must be a file in that folder with the expected name, and the bot id must be a valid one."""
    if not re.fullmatch(r"[a-z0-9-]+-\d{8}-\d{6}", archive_id or ""):
        raise FleetError("Unknown archive.")
    folder = _archive_dir()
    sidecar = folder / f"{archive_id}.json"
    if not sidecar.is_file():
        raise FleetError("Unknown archive.")
    try:
        info = json.loads(sidecar.read_text(encoding="utf-8"))
    except ValueError:
        raise FleetError("That archive's record is damaged.") from None
    if not isinstance(info, dict):
        raise FleetError("That archive's record is damaged.")
    file = Path(str(info.get("file") or ""))
    try:
        inside = file.resolve(strict=False).parent == folder.resolve(strict=False)
    except OSError:
        inside = False
    if not inside or not file.name.startswith(archive_id):
        raise FleetError("That archive's record points outside the archive folder.")
    name = str(info.get("id") or archive_id.rsplit("-", 2)[0])
    if not _NAME.match(name) or name in _RESERVED:
        raise FleetError("That archive's record names an invalid bot.")
    info["id"] = name
    return sidecar, info


def retire(profile: str, *, owner_confirmed: bool) -> dict[str, Any]:
    if not owner_confirmed:
        raise FleetError("Retiring a bot needs the owner's go-ahead. Ask first.")
    name = (profile or "").strip().lower()
    if name in _RESERVED or not _NAME.match(name):
        raise FleetError("That bot can't be retired.")
    home = persona.profile_home(name)
    if _busy(name):
        raise FleetError("That bot is working on a task. Let it finish (or stop the task) before retiring it.")
    summary = _describe(home)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    folder = _archive_dir()
    folder.mkdir(parents=True, exist_ok=True)
    with data.chief_config_scope():
        from hermes_cli.profiles import export_profile

        archive = Path(export_profile(name, str(folder / f"{name}-{stamp}")))
    sidecar = folder / f"{name}-{stamp}.json"
    sidecar.write_text(json.dumps({**summary, "retired_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "file": str(archive)}, indent=2), encoding="utf-8")
    _remove_tree(home)
    _sections_assign(name, None)
    logger.info("fleet: retired %s to %s", name, archive.name)
    return {"ok": True, "archive": f"{name}-{stamp}", "title": summary["title"]}


def restore(archive_id: str) -> dict[str, Any]:
    sidecar, info = _archive(archive_id)
    name = str(info.get("id") or archive_id.rsplit("-", 2)[0])
    if (data.profiles_dir(_root()) / name).exists():
        raise FleetError(f"A bot with the id '{name}' exists again. Retire or rename it first.")
    with data.chief_config_scope():
        from hermes_cli.profiles import import_profile

        home = Path(import_profile(str(info["file"]), name))
    provider = _describe(home)["model"]["provider"]
    granted = providers.grant_provider(provider, home) if provider else {"keys": 0}
    _sections_assign(name, TEAM_SECTION)
    Path(info["file"]).unlink(missing_ok=True)
    sidecar.unlink(missing_ok=True)
    logger.info("fleet: restored %s", name)
    return {"ok": True, "worker": _describe(home), "keys_granted": granted.get("keys", 0)}


def remove_archive(archive_id: str) -> dict[str, Any]:
    sidecar, info = _archive(archive_id)
    Path(info["file"]).unlink(missing_ok=True)
    sidecar.unlink(missing_ok=True)
    return {"ok": True}


# ---------------------------------------------------------------- the chief's tools

# The owner's consent for the tools that create, remove or bring back a bot, or pin a costly model, comes from Hermes's
# approval sheet (`approval_for`, through the plugin's pre_tool_call hook), never from a flag the model sets. Set by
# the plugin once that hook is registered: without it these tools refuse instead of running unasked.
guard = {"active": False}

_GUARDED = ("fleet_mint", "fleet_retire", "fleet_restore")


def approval_for(tool_name: str, args: Any) -> dict[str, Any] | None:
    """The approval this fleet call needs, as Hermes's pre_tool_call answer, or None."""
    import hashlib

    args = args if isinstance(args, dict) else {}
    if tool_name == "fleet_mint":
        soul = str(args.get("soul") or "").strip()
        lines = [
            f"Create a new bot: {' '.join(str(args.get('display_name') or '?').split())} ({' '.join(str(args.get('role') or '').split())})",
            f"Id: {args.get('id') or '?'}",
        ]
        if args.get("cwd"):
            lines.append(f"Working folder: {args.get('cwd')}")
        lines += ["", "Its SOUL:", soul[:1200] + ("…" if len(soul) > 1200 else "")]
        reason = "\n".join(lines)
    elif tool_name == "fleet_retire":
        reason = f"Retire the bot {args.get('profile') or '?'} (it is archived and can be restored)"
    elif tool_name == "fleet_restore":
        reason = f"Bring back the retired bot from archive {args.get('archive_id') or '?'}"
    elif tool_name == "fleet_set_model" and args.get("confirm_expensive"):
        reason = f"Pin {args.get('profile') or '?'} to {args.get('provider') or '?'} / {args.get('model') or '?'}, which costs more than usual"
    else:
        return None
    # "Always allow" can only ever trust this exact request, never every future one.
    key = hashlib.sha256(json.dumps(args, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]
    return {"action": "approve", "message": reason, "rule_key": f"chief:{tool_name.replace('_', '-')}:{key}"}


def pre_tool_call(tool_name: str = "", args: Any = None, **_kw: Any) -> dict[str, Any] | None:
    """Hermes's hook: never raises; a fleet call it can't read asks anyway."""
    try:
        return approval_for(str(tool_name or ""), args)
    except Exception:
        if str(tool_name or "") in _GUARDED or tool_name == "fleet_set_model":
            return {"action": "approve", "message": f"A fleet action: {tool_name}", "rule_key": "chief:fleet-unknown"}
        return None


def _consented() -> bool:
    if not guard["active"]:
        raise FleetError("This needs the owner's approval, and the approval check isn't available. Ask the owner to do it in the app.")
    return True


def _tool(fn):
    def handle(args: dict, **_kw) -> str:
        try:
            result = fn(args or {})
        except (FleetError, persona.PersonaError, looks.LookError) as exc:
            result = {"ok": False, "error": str(exc)}
        except Exception as exc:  # never a traceback (or a value) into the conversation
            logger.warning("fleet tool failed: %s", type(exc).__name__)
            result = {"ok": False, "error": f"That didn't work ({type(exc).__name__})."}
        return json.dumps(result)

    return handle


def _schema(name: str, description: str, properties: dict, required: tuple = ()) -> dict:
    return {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": list(required)}}


_S = {"type": "string"}
_B = {"type": "boolean"}

TOOLS = (
    (
        "fleet_roster",
        _schema(
            "fleet_roster",
            "List the chief's workforce: each bot's id, name, role, model, working folder and whether it is busy, plus retired bots that can be restored.",
            {},
        ),
        _tool(lambda a: roster()),
        "👥",
    ),
    (
        "fleet_models",
        _schema("fleet_models", "List every model of the owner's connected providers (what a bot can be pinned to).", {}),
        _tool(lambda a: models()),
        "🧠",
    ),
    (
        "fleet_mint",
        _schema(
            "fleet_mint",
            "Create a new specialist bot. ONLY after the owner has signed off on the SOUL draft in this chat "
            "(the app then asks them on its approval sheet, with the SOUL). It starts on the chief's model, with its own working folder.",
            {
                "id": {**_S, "description": "short lowercase id, e.g. research-desk"},
                "display_name": {**_S, "description": "the bot's human first name"},
                "role": {**_S, "description": "short role, e.g. Researcher"},
                "description": {**_S, "description": "one or two sentences on what it is good at (used for routing)"},
                "soul": {**_S, "description": "the signed one-screen SOUL.md text"},
                "cwd": {**_S, "description": "optional working folder (absolute path)"},
                "look": {
                    "type": "object",
                    "description": "optional face, as set_bot_look takes it: {style: bubble|blob|shape, color: '#rrggbb', body, eyes, "
                    "cheeks, shape, seed, blobKind}",
                },
            },
            ("id", "display_name", "role", "description", "soul"),
        ),
        _tool(
            lambda a: mint(
                a.get("id", ""),
                a.get("display_name", ""),
                a.get("role", ""),
                a.get("description", ""),
                a.get("soul", ""),
                owner_signed=_consented(),
                cwd=str(a.get("cwd") or ""),
                look=a.get("look") if isinstance(a.get("look"), dict) else None,
            )
        ),
        "🛠️",
    ),
    (
        "fleet_set_model",
        _schema(
            "fleet_set_model",
            "Pin a bot (or 'chief') to a model from fleet_models. Its provider key goes with it. "
            "If the result asks for confirmation (expensive model), call it again with confirm_expensive=true: the app asks the owner.",
            {"profile": _S, "provider": _S, "model": _S, "confirm_expensive": _B},
            ("profile", "provider", "model"),
        ),
        _tool(lambda a: set_model(a.get("profile", ""), a.get("provider", ""), a.get("model", ""), confirm_expensive=bool(a.get("confirm_expensive")))),
        "🔁",
    ),
    (
        "fleet_retire",
        _schema(
            "fleet_retire",
            "Retire (unmint) a bot: it is archived (restorable) and removed. The app asks the owner on its approval sheet.",
            {"profile": _S},
            ("profile",),
        ),
        _tool(lambda a: retire(a.get("profile", ""), owner_confirmed=_consented())),
        "📦",
    ),
    (
        "fleet_restore",
        _schema("fleet_restore", "Bring a retired bot back from its archive (ids from fleet_roster).", {"archive_id": _S}, ("archive_id",)),
        _tool(lambda a: _consented() and restore(a.get("archive_id", ""))),
        "♻️",
    ),
    ("set_bot_look", looks.TOOL_SCHEMA, _tool(looks.set_bot_look), "🎨"),
)
