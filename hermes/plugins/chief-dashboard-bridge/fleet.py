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
from typing import Any, Optional

from . import data, persona, providers

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
    model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    terminal = cfg.get("terminal") if isinstance(cfg.get("terminal"), dict) else {}
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


def _sections_assign(name: str, section: Optional[str]) -> None:
    path = _root() / "bot-sections.json"
    try:
        doc = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except ValueError:
        doc = {}
    sections = [s for s in (doc.get("sections") or []) if isinstance(s, str)]
    assign = doc.get("assign") if isinstance(doc.get("assign"), dict) else {}
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
    model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    return {"provider": str(model.get("provider") or ""), "model": str(model.get("default") or "")}


def mint(name: str, display_name: str, role: str, description: str, soul: str, *, owner_signed: bool, cwd: str = "") -> dict[str, Any]:
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
        workdir = Path(cwd).expanduser() if cwd else _root() / "workspaces" / name
        workdir.mkdir(parents=True, exist_ok=True)
        from cli import save_config_value

        with persona.profile_scope(home):
            save_config_value("terminal.cwd", str(workdir))
        meta = _load_yaml(home / "profile.yaml")
        if not isinstance(meta.get("ui_meta"), dict):
            meta["ui_meta"] = {}
        ui = meta["ui_meta"]
        bots = ui.get("hermes-bots") if isinstance(ui.get("hermes-bots"), dict) else {}
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


def _archive(archive_id: str) -> tuple[Path, dict[str, Any]]:
    if not re.fullmatch(r"[a-z0-9-]+-\d{8}-\d{6}", archive_id or ""):
        raise FleetError("Unknown archive.")
    sidecar = _archive_dir() / f"{archive_id}.json"
    if not sidecar.is_file():
        raise FleetError("Unknown archive.")
    return sidecar, json.loads(sidecar.read_text(encoding="utf-8"))


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


def _tool(fn):
    def handle(args: dict, **_kw) -> str:
        try:
            result = fn(args or {})
        except (FleetError, persona.PersonaError) as exc:
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
    ("fleet_roster", _schema("fleet_roster", "List the chief's workforce: each bot's id, name, role, model, working folder and whether it is "
                                             "busy, plus retired bots that can be restored.", {}),
     _tool(lambda a: roster()), "👥"),
    ("fleet_models", _schema("fleet_models", "List every model of the owner's connected providers (what a bot can be pinned to).", {}),
     _tool(lambda a: models()), "🧠"),
    ("fleet_mint", _schema("fleet_mint", "Create a new specialist bot. ONLY after the owner has signed off on the SOUL draft in this chat "
                                         "(owner_signed=true). It starts on the chief's model, with its own working folder.",
                           {"id": {**_S, "description": "short lowercase id, e.g. research-desk"},
                            "display_name": {**_S, "description": "the bot's human first name"},
                            "role": {**_S, "description": "short role, e.g. Researcher"},
                            "description": {**_S, "description": "one or two sentences on what it is good at (used for routing)"},
                            "soul": {**_S, "description": "the signed one-screen SOUL.md text"},
                            "cwd": {**_S, "description": "optional working folder (absolute path)"},
                            "owner_signed": {**_B, "description": "true only if the owner approved this exact SOUL"}},
                           ("id", "display_name", "role", "description", "soul", "owner_signed")),
     _tool(lambda a: mint(a.get("id", ""), a.get("display_name", ""), a.get("role", ""), a.get("description", ""), a.get("soul", ""),
                          owner_signed=bool(a.get("owner_signed")), cwd=str(a.get("cwd") or ""))), "🛠️"),
    ("fleet_set_model", _schema("fleet_set_model", "Pin a bot (or 'chief') to a model from fleet_models. Its provider key goes with it. "
                                                   "If the result asks for confirmation (expensive model), ask the owner first.",
                                {"profile": _S, "provider": _S, "model": _S, "confirm_expensive": _B}, ("profile", "provider", "model")),
     _tool(lambda a: set_model(a.get("profile", ""), a.get("provider", ""), a.get("model", ""), confirm_expensive=bool(a.get("confirm_expensive")))), "🔁"),
    ("fleet_retire", _schema("fleet_retire", "Retire (unmint) a bot: it is archived (restorable) and removed. ONLY after the owner said yes "
                                             "in this chat (owner_confirmed=true).", {"profile": _S, "owner_confirmed": _B}, ("profile", "owner_confirmed")),
     _tool(lambda a: retire(a.get("profile", ""), owner_confirmed=bool(a.get("owner_confirmed")))), "📦"),
    ("fleet_restore", _schema("fleet_restore", "Bring a retired bot back from its archive (ids from fleet_roster).", {"archive_id": _S}, ("archive_id",)),
     _tool(lambda a: restore(a.get("archive_id", ""))), "♻️"),
)
