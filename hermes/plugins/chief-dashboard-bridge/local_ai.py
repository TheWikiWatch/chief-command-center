"""Local models (contract `chief.local_models.v1`): run a model on this PC with Hermes's managed llama.cpp runtime.

Every step is Hermes's own (`hermes_cli/web_routers/local_models.py`, plain functions plus an in-memory job table,
the same ones its desktop app and CLI drive): the hardware probe, the catalog priced for this machine (what fits,
which build, how big), installing the engine (PM, pinned SHA-256s), downloads with byte progress, pause and resume,
the one-click quickstart (engine, this machine's build of the recommended model, start the server, make it the
default), activating a model for the chief, starting and stopping the server, removing a model.

What the app adds:

- **The folder.** Hermes keeps models under its own root; patch 0006 adds `local_runtime.models_dir` (models,
  companions and download partials together, so a finished file is renamed into place, never copied across
  drives). The owner chooses it before the first download; the suggestion is the roomiest drive that isn't the
  system drive. A folder with models in it isn't switched (they'd be stranded).
- **The catalog stays the release's.** Hermes refreshes its model list from upstream main every six hours, unsigned;
  provisioning sets `local_runtime.catalog_refresh: false` (patch 0006), so the list is the one the app shipped.
- **The server starts with the gateway** when local models are on (Hermes's own dashboard does this; the gateway
  alone doesn't, and the first message would then fail while the server boots).

Model files come from Hugging Face over HTTPS and aren't hash-checked by Hermes (the engine is). Nothing secret
passes through here.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import string
import threading
from pathlib import Path
from typing import Any

from . import data
from .data import chief_config_scope
from .util import TRY_AGAIN, subdict

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.local_models.v1"
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$")
# Hermes's names for its llama.cpp provider (web_routers/local_models.py), in case it stops exporting them.
_LLAMACPP = ("llamacpp", "llama.cpp", "llama-cpp")
_SUGGEST_MIN_FREE = 40 * 1024**3
FOLDER_NAME = "Chief models"


class LocalModelsError(ValueError):
    pass


def _lm():
    from hermes_cli.web_routers import local_models

    return local_models


def _run(value: Any) -> Any:
    """Hermes's async handlers, from a bridge request thread (which has no event loop)."""
    return asyncio.run(value) if asyncio.iscoroutine(value) else value


# What Hermes's local-model handlers refuse with, in the owner's words: their HTTPException details are written for
# developers, and a 502 carries the raw error. Anything not listed is the plain fallback for its status.
_HERMES_SAYS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^model not found$"), "That model isn't downloaded any more."),
    (re.compile(r"^unknown model "), "That isn't a model this app knows."),
    (re.compile(r" is not downloaded$"), "That model isn't downloaded yet."),
    (re.compile(r"^(job not found|unknown download job)$"), "That download has ended."),
    (re.compile(r"^Setup is already running$"), "Setup is already running."),
    (re.compile(r"^No automatic recommendation"), "There's no automatic pick for this PC. Choose a model from the list."),
    (re.compile(r"^no catalog model fits"), "None of the models fits this PC."),
    (re.compile(r"^no variant of .+ fits"), "That model doesn't fit this PC."),
    (re.compile(r"needs llama\.cpp .+ or newer"), "That model needs a newer engine. Update the engine first."),
    (re.compile(r"^Another Hermes process owns this server"), "Another copy of Hermes runs the local server, so it can't be stopped from here."),
    (re.compile(r"^local server is not running$"), "The local server isn't running."),
    (re.compile(r"could not start"), "The local server couldn't start. Check the engine is installed, then try again."),
    (re.compile(r"^action must be"), "Start or stop."),
)


def hermes_refusal(status: Any, detail: Any) -> str:
    """A Hermes refusal in a sentence the owner can act on."""
    text = " ".join(str(detail or "").split())
    for pattern, sentence in _HERMES_SAYS:
        if pattern.search(text):
            return sentence
    return "The local server didn't answer. Try again." if status == 502 else TRY_AGAIN


def _call(fn, *args: Any, **kwargs: Any) -> Any:
    """A Hermes handler in the chief's scope; its HTTPException becomes a plain error."""
    with chief_config_scope():
        try:
            return _run(fn(*args, **kwargs))
        except Exception as exc:
            if type(exc).__name__ == "HTTPException":
                logger.info("local models: Hermes refused (%s)", getattr(exc, "status_code", ""))
                raise LocalModelsError(hermes_refusal(getattr(exc, "status_code", None), getattr(exc, "detail", ""))) from exc
            raise


def _id(value: str, what: str = "model") -> str:
    value = str(value or "").strip()
    if not _ID.match(value):
        raise LocalModelsError(f"That isn't a {what} this app knows.")
    return value


# ----------------------------------------------------------------------------- the folder


def folder_supported() -> bool:
    """This Hermes has patch 0006 (a models folder of the owner's choosing)."""
    try:
        from hermes_cli.local_runtime import bootstrap

        return hasattr(bootstrap, "partials_dir")
    except Exception:
        return False


def _drives() -> list[Path]:
    """This PC's fixed drives (not removable, optical or network: a model there would vanish with the drive)."""
    if os.name != "nt":
        return []
    import ctypes

    out = []
    for letter in string.ascii_uppercase[2:]:  # C: onward; the system drive is filtered by the caller
        root = Path(f"{letter}:\\")
        try:
            if ctypes.windll.kernel32.GetDriveTypeW(str(root)) == 3 and root.exists():  # DRIVE_FIXED
                out.append(root)
        except (OSError, AttributeError):
            continue
    return out


def suggested_folder(default: Path) -> Path:
    """The biggest fixed drive other than the system drive (a PC's storage drive, usually) that has room for a few
    models; else Hermes's own folder."""
    system = Path(os.environ.get("SystemDrive", "C:") + "\\").resolve().drive.upper()
    best: tuple[int, Path] | None = None
    for root in _drives():
        if root.drive.upper() == system:
            continue
        try:
            usage = shutil.disk_usage(root)
        except OSError:
            continue
        if usage.free >= _SUGGEST_MIN_FREE and (best is None or usage.total > best[0]):
            best = (usage.total, root)
    return best[1] / FOLDER_NAME if best else default


def _free_bytes(path: Path) -> int | None:
    probe = path
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return None


def _models_in(folder: Path) -> int:
    try:
        return sum(1 for p in folder.glob("*.gguf") if p.is_file())
    except OSError:
        return 0


def _default_models_dir() -> Path:
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root() / "models"


def folder() -> dict[str, Any]:
    with chief_config_scope():
        from hermes_cli.config import load_config_readonly
        from hermes_cli.local_runtime import bootstrap

        current = bootstrap.models_dir()
        configured = str(((load_config_readonly() or {}).get("local_runtime") or {}).get("models_dir") or "").strip()
    return {
        "path": str(current),
        "chosen": bool(configured),
        "supported": folder_supported(),
        # Only while the owner hasn't chosen: it measures every drive, and the pane polls during a download.
        "suggested": str(current) if configured else str(suggested_folder(_default_models_dir())),
        "freeBytes": _free_bytes(current),
        "models": _models_in(current),
    }


def set_folder(path: str) -> dict[str, Any]:
    """Choose where models go, before the first download (or once the old folder is empty)."""
    if not folder_supported():
        raise LocalModelsError("This version of Chief keeps models in Hermes's own folder.")
    raw = str(path or "").strip().strip('"')
    target = Path(os.path.expandvars(os.path.expanduser(raw))) if raw else None
    if target is None or not target.is_absolute() or len(raw) > 240:
        raise LocalModelsError("Choose a folder on this PC, like E:\\Chief models.")
    lowered = str(target).lower()
    if "windowsapps" in lowered or lowered.startswith("\\\\"):
        raise LocalModelsError("Choose a folder on a drive of this PC (not inside the app, not a network share).")
    if _active_jobs():
        raise LocalModelsError("Wait for the download to finish (or cancel it) before moving the folder.")
    now = folder()
    if Path(now["path"]) != target and now["models"]:
        raise LocalModelsError("Models are already downloaded in the current folder. Remove them first, then choose another folder.")
    try:
        target.mkdir(parents=True, exist_ok=True)
        probe = target / ".chief-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        raise LocalModelsError(f"Chief can't write to that folder ({type(exc).__name__}). Choose another one.") from exc
    _write_runtime_setting("models_dir", str(target))
    return {"ok": True, "folder": folder()}


def _write_runtime_setting(key: str, value: Any) -> None:
    """One `local_runtime` setting, through Hermes's one-key writer (a whole-file rewrite would undo a setting
    Hermes saved meanwhile)."""
    with chief_config_scope():
        from cli import save_config_value
        from hermes_cli.config import get_config_path

        path = get_config_path()
        if not save_config_value(f"local_runtime.{key}", value):
            raise LocalModelsError("Couldn't save that setting. Try again.")
    data.forget_yaml(path)


# ----------------------------------------------------------------------------- what Hermes says


def _job_view(job: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "job_id",
        "kind",
        "target",
        "model_id",
        "status",
        "phase",
        "detail",
        "total_bytes",
        "done_bytes",
        "percent",
        "bytes_per_sec",
        "eta_seconds",
        "error",
        "can_pause",
        "can_resume",
        "started_at",
    )
    return {k: job.get(k) for k in keys if k in job}


def _active_jobs() -> list[dict[str, Any]]:
    try:
        jobs = _call(_lm().local_models_jobs).get("jobs") or []
    except Exception:
        return []
    return [j for j in jobs if j.get("status") in ("running", "paused")]


def status() -> dict[str, Any]:
    """The engine, the server, what's downloaded and active, the machine, the folder and the jobs in flight."""
    lm = _lm()
    state = _call(lm.local_models_status)
    try:
        machine = _call(lm.local_models_hardware)
    except Exception:
        logger.debug("local models: hardware probe failed", exc_info=True)
        machine = {}
    jobs = (_call(lm.local_models_jobs).get("jobs") or [])[:10]
    return {
        "ok": True,
        "contract": CONTRACT,
        "enabled": bool(state.get("enabled")),
        "engine": {
            "installed": bool(state.get("runtime_installed")),
            "backend": state.get("runtime_backend"),
            "version": state.get("tag"),
            "updateAvailable": bool(state.get("update_available")),
        },
        "server": {"running": bool(state.get("server_running"))},
        "active": state.get("active_model_id"),
        "loaded": state.get("loaded_models") or {},
        "models": state.get("models") or [],
        "machine": {
            "gpu": machine.get("gpu_name"),
            "vram": machine.get("vram_label"),
            "vramBytes": machine.get("vram_total_bytes"),
            "ramBytes": machine.get("ram_total_bytes"),
            "sharedMemory": bool(machine.get("uma")),
        },
        "folder": folder(),
        "jobs": [_job_view(j) for j in jobs],
    }


def catalog() -> dict[str, Any]:
    keys = (
        "id",
        "display_name",
        "description",
        "native_context_label",
        "recommended",
        "recommended_reason",
        "downloaded",
        "downloaded_model_id",
        "vision",
        "needs_engine",
        "min_engine",
        "fits",
        "model_id",
        "quant",
        "size_bytes",
        "size_label",
        "fit_summary",
        "fit_detail",
        "spilled",
    )
    rows = _call(_lm().local_models_catalog).get("models") or []
    return {"ok": True, "models": [{k: r.get(k) for k in keys if k in r} for r in rows]}


# ----------------------------------------------------------------------------- doing things


def _needs_folder() -> None:
    """The first download waits for the owner to choose a folder (the decision is theirs: a model is 16 GB+)."""
    if folder_supported() and not folder()["chosen"]:
        raise LocalModelsError("Choose a folder for the models first.")


def install_engine() -> dict[str, Any]:
    lm = _lm()
    return {"ok": True, **_call(lm.local_models_runtime_install, lm.RuntimeInstallBody())}


def quickstart(model_id: str = "") -> dict[str, Any]:
    _needs_folder()
    lm = _lm()
    body = lm.QuickstartBody(model_id=_id(model_id) if model_id else None)
    return {"ok": True, **_call(lm.local_models_quickstart, body, None)}


def download(model_id: str) -> dict[str, Any]:
    _needs_folder()
    lm = _lm()
    return {"ok": True, **_call(lm.local_models_download, lm.ModelDownloadBody(model_id=_id(model_id)))}


def pause(job_id: str) -> dict[str, Any]:
    lm = _lm()
    return {"ok": True, **_call(lm.local_models_download_pause, lm.JobIdBody(job_id=_id(job_id, "download")))}


def resume(job_id: str) -> dict[str, Any]:
    lm = _lm()
    return {"ok": True, **_call(lm.local_models_download_resume, lm.JobIdBody(job_id=_id(job_id, "download")))}


def _who_uses(model_id: str) -> str:
    """The name of the chief or the bot whose model this is ("" when none): removing it would leave them without one."""
    from .usage import _title

    names = tuple(str(p).lower() for p in getattr(_lm(), "_LLAMACPP_PROVIDERS", _LLAMACPP))
    chief = data.chief_home()
    folder = data.profiles_dir()
    bots = sorted(p for p in folder.iterdir() if p.is_dir() and p != chief and (p / "config.yaml").is_file()) if folder.is_dir() else []
    for home in [chief, *bots]:
        model = subdict(data.load_yaml(home / "config.yaml"), "model")
        if str(model.get("provider") or "").lower() in names and str(model.get("default") or "") == model_id:
            return _title("chief" if home == chief else home.name, home)
    return ""


def remove(model_id: str) -> dict[str, Any]:
    model_id = _id(model_id)
    user = _who_uses(model_id)
    if user:
        raise LocalModelsError(f"{user} is using this model. Choose another model for {user} first.")
    try:
        return {"ok": True, **_call(_lm().local_models_delete, model_id)}
    except PermissionError as exc:  # Windows won't delete a file the server has loaded
        raise LocalModelsError("The local server is using this model. Stop the server first, then remove it.") from exc


def activate(model_id: str) -> dict[str, Any]:
    """Make a downloaded model the chief's model, and make sure the server is up. The chief's only: Hermes's handler
    scopes a bot's profile by switching this whole process to hosting several profiles, after which any credential
    read in the gateway without a profile's scope fails. A bot gets a local model from its own Models picker."""
    lm = _lm()
    return {"ok": True, **_call(lm.local_models_activate, lm.ModelActivateBody(model_id=_id(model_id)), None)}


def server(action: str) -> dict[str, Any]:
    action = str(action or "").strip().lower()
    if action not in ("start", "stop"):
        raise LocalModelsError("Start or stop.")
    lm = _lm()
    return _call(lm.local_models_server, lm.ServerActionBody(action=action))


def job(job_id: str) -> dict[str, Any]:
    return {"ok": True, "job": _job_view(_call(_lm().local_models_job, _id(job_id, "download")))}


# ----------------------------------------------------------------------------- with the gateway


def boot_with_gateway() -> None:
    """Start the managed server when local models are on, in the background (Hermes's own dashboard does this at
    start; without it the first message would fail while the server boots)."""

    def run() -> None:
        try:
            with chief_config_scope():
                from hermes_cli.config import load_config

                config = load_config() or {}
                if not (config.get("local_runtime") or {}).get("enabled"):
                    return
                from hermes_cli.local_runtime.bootstrap import ensure_local_runtime

                ensure_local_runtime(config)
                logger.info("local models: server started with the gateway")
        except Exception:
            logger.warning("local models: the server didn't start with the gateway", exc_info=True)

    threading.Thread(target=run, name="chief-local-models-boot", daemon=True).start()


def call(fn: Any) -> Any:
    try:
        return fn()
    except LocalModelsError as exc:
        return {"ok": False, "error": str(exc)}, 400
    except ImportError:
        return {"ok": False, "error": "This Hermes can't run local models from the app."}, 501
    except Exception as exc:
        logger.warning("local models action failed: %s", type(exc).__name__, exc_info=True)
        return {"ok": False, "error": "That didn't work. Try again."}, 500
