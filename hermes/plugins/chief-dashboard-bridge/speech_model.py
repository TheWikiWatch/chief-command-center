"""The on-device speech model for voice typing (contract `chief.speech_model.v1`).

Hermes's `stt.local` provider (faster-whisper) downloads its model from Hugging Face on first use. The app never
lets that happen silently: the owner taps Download in Check my system (or Settings), sees the size, and can
cancel; the download resumes where it stopped and every file is checked against a pinned SHA-256. When it
finishes, `stt.provider: local` and `stt.local.model: <folder>` point Hermes at the downloaded copy, so Hermes
loads it from disk and never contacts the Hub.

Models live in `<chief home>/models/faster-whisper-<id>/`; deleting that folder removes one.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any
from collections.abc import Callable

from . import data
from .util import subdict

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.speech_model.v1"
_TOKENIZER = ("tokenizer.json", 2203239, "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab")
_VOCABULARY = ("vocabulary.txt", 459861, "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913")

# Systran's CTranslate2 conversions of OpenAI Whisper (MIT), pinned to a commit.
MODELS: dict[str, dict[str, Any]] = {
    "base": {
        "label": "Standard",
        "repo": "Systran/faster-whisper-base",
        "revision": "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
        "files": [
            ("config.json", 2309, "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a"),
            ("model.bin", 145217532, "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"),
            _TOKENIZER,
            _VOCABULARY,
        ],
    },
    "tiny": {
        "label": "Small and quick",
        "repo": "Systran/faster-whisper-tiny",
        "revision": "d90ca5fe260221311c53c58e660288d3deb8d356",
        "files": [
            ("config.json", 2249, "a73a28cdfe1c43ccc7202fa333d1f89c202477271407ae9a7f19afa52039cac8"),
            ("model.bin", 75538270, "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1"),
            _TOKENIZER,
            _VOCABULARY,
        ],
    },
}
DEFAULT_MODEL = "base"
_MARKER = "chief-model.json"
_CHUNK = 1 << 20


class SpeechModelError(ValueError):
    pass


def models_root() -> Path:
    return data.chief_home() / "models"


def model_dir(model_id: str) -> Path:
    return models_root() / f"faster-whisper-{model_id}"


def _spec(model_id: str) -> dict[str, Any]:
    spec = MODELS.get(str(model_id or ""))
    if not spec:
        raise SpeechModelError("Unknown speech model.")
    return spec


def total_bytes(model_id: str) -> int:
    return sum(size for _, size, _ in _spec(model_id)["files"])


def installed(model_id: str) -> bool:
    folder = model_dir(model_id)
    try:
        marker = json.loads((folder / _MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    spec = _spec(model_id)
    if marker.get("revision") != spec["revision"]:
        return False
    return all((folder / name).is_file() and (folder / name).stat().st_size == size for name, size, _ in spec["files"])


# ---------------------------------------------------------------- the one download job


class _Job:
    def __init__(self, model_id: str):
        self.model_id = model_id
        self.state = "downloading"  # downloading | verifying | done | cancelled | error
        self.received = 0
        self.total = total_bytes(model_id)
        self.error = ""
        self.cancel = threading.Event()
        self.started = time.time()

    def view(self) -> dict[str, Any]:
        return {"id": self.model_id, "state": self.state, "received": self.received, "total": self.total, "error": self.error}


_lock = threading.Lock()
_job: _Job | None = None
# Tests replace this with a local fetcher: (url, headers, timeout) -> response with .status_code, .headers,
# .iter_content(n) and .close().
_http_get: Callable[..., Any] | None = None


def _get(url: str, headers: dict[str, str]):
    if _http_get is not None:
        return _http_get(url, headers=headers, timeout=(15, 60))
    import requests

    return requests.get(url, headers=headers, stream=True, timeout=(15, 60), allow_redirects=True)


def _endpoint() -> str:
    return (os.environ.get("HF_ENDPOINT") or "https://huggingface.co").rstrip("/")


def _hash_file(path: Path, job: _Job | None = None) -> hashlib._Hash:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            if job and job.cancel.is_set():
                raise _Cancelled()
            block = handle.read(_CHUNK)
            if not block:
                break
            digest.update(block)
    return digest


class _Cancelled(Exception):
    pass


def _plain_network_error(exc: BaseException) -> str:
    name = type(exc).__name__
    host = _endpoint().split("://", 1)[-1]
    if "Timeout" in name:
        return f"{host} stopped answering. Try again; the download resumes where it stopped."
    if "SSL" in name:
        return f"A secure connection to {host} couldn't be made (a proxy or antivirus may be in the way)."
    return f"Couldn't reach {host}. Check the connection and try again; the download resumes where it stopped."


def _fetch_file(job: _Job, spec: dict[str, Any], folder: Path, name: str, size: int, sha: str, done_before: int) -> None:
    final = folder / name
    if final.is_file() and final.stat().st_size == size:
        if _hash_file(final, job).hexdigest() == sha:
            job.received = done_before + size
            return
        final.unlink()
    part = folder / f"{name}.part"
    have = part.stat().st_size if part.exists() else 0
    if have > size:
        part.unlink()
        have = 0
    digest = _hash_file(part, job) if have else hashlib.sha256()
    job.received = done_before + have
    if have < size:
        url = f"{_endpoint()}/{spec['repo']}/resolve/{spec['revision']}/{name}"
        headers = {"User-Agent": "chief-command-center"}
        if have:
            headers["Range"] = f"bytes={have}-"
        try:
            response = _get(url, headers)
        except Exception as exc:
            raise SpeechModelError(_plain_network_error(exc)) from exc
        try:
            status = int(getattr(response, "status_code", 0))
            if have and status == 200:
                # The server ignored the range: start this file over.
                have = 0
                digest = hashlib.sha256()
                part.unlink(missing_ok=True)
                job.received = done_before
            elif status not in (200, 206):
                raise SpeechModelError(f"The model server answered {status}. Try again later.")
            with open(part, "ab") as out:
                for block in response.iter_content(_CHUNK):
                    if job.cancel.is_set():
                        raise _Cancelled()
                    if not block:
                        continue
                    out.write(block)
                    digest.update(block)
                    have += len(block)
                    job.received = done_before + have
                    if have > size:
                        break
        except (_Cancelled, SpeechModelError):
            raise
        except Exception as exc:
            raise SpeechModelError(_plain_network_error(exc)) from exc
        finally:
            try:
                response.close()
            except Exception:
                pass
    if have != size:
        if have > size:
            part.unlink(missing_ok=True)
            raise SpeechModelError(f"{name} came out larger than expected and was discarded. Try again.")
        raise SpeechModelError(_plain_network_error(ConnectionError()))
    job.state = "verifying"
    if digest.hexdigest() != sha:
        part.unlink(missing_ok=True)
        raise SpeechModelError(f"{name} didn't match its checksum and was discarded. Try again.")
    os.replace(part, final)
    job.state = "downloading"


def _run(job: _Job) -> None:
    spec = _spec(job.model_id)
    folder = model_dir(job.model_id)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        done = 0
        for name, size, sha in spec["files"]:
            _fetch_file(job, spec, folder, name, size, sha, done)
            done += size
        (folder / _MARKER).write_text(
            json.dumps({"id": job.model_id, "repo": spec["repo"], "revision": spec["revision"], "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S")}),
            encoding="utf-8",
        )
        err = use(job.model_id)
        if err:
            raise SpeechModelError(err)
        job.state = "done"
        logger.info("speech model %s downloaded (%d bytes)", job.model_id, job.total)
    except _Cancelled:
        job.state = "cancelled"
    except SpeechModelError as exc:
        job.state, job.error = "error", str(exc)
    except OSError as exc:
        job.state, job.error = "error", f"Couldn't save the model on this PC ({exc.strerror or type(exc).__name__})."
    except Exception as exc:  # never a traceback to the UI
        logger.warning("speech model download failed: %s", type(exc).__name__)
        job.state, job.error = "error", "The download failed. Try again."


def download(model_id: str = DEFAULT_MODEL, *, wait: bool = False) -> dict[str, Any]:
    global _job
    _spec(model_id)
    with _lock:
        if _job and _job.state in ("downloading", "verifying"):
            if _job.model_id == model_id:
                return {"ok": True, "job": _job.view()}
            return {"ok": False, "error": "Another speech model is downloading. Cancel it first."}
        _job = _Job(model_id)
        job = _job
    thread = threading.Thread(target=_run, args=(job,), name="chief-speech-model", daemon=True)
    thread.start()
    if wait:
        thread.join()
    return {"ok": True, "job": job.view()}


def cancel() -> dict[str, Any]:
    with _lock:
        job = _job
    if job and job.state in ("downloading", "verifying"):
        job.cancel.set()
    return {"ok": True}


def delete(model_id: str) -> dict[str, Any]:
    _spec(model_id)
    with _lock:
        if _job and _job.model_id == model_id and _job.state in ("downloading", "verifying"):
            return {"ok": False, "error": "Cancel the download first."}
    folder = model_dir(model_id)
    if folder.exists():
        shutil.rmtree(folder)
    return {"ok": True}


# ---------------------------------------------------------------- Hermes config


def _stt_config() -> dict[str, Any]:
    from tools.transcription_tools import _load_stt_config

    with data.chief_config_scope():
        cfg = _load_stt_config()
    return cfg if isinstance(cfg, dict) else {}


def use(model_id: str) -> str:
    """Point Hermes's local STT at a downloaded model. Returns an error text, or ''."""
    if not installed(model_id):
        return "That speech model isn't downloaded yet."
    from cli import save_config_value

    with data.chief_config_scope():
        for path, value in (("stt.enabled", True), ("stt.provider", "local"), ("stt.local.model", str(model_dir(model_id)))):
            if not save_config_value(path, value):
                return "Couldn't update Hermes's voice settings."
    return ""


def local_model_ready(stt_cfg: dict[str, Any] | None = None) -> bool:
    """Whether Hermes's local STT can load its model without downloading anything."""
    cfg = stt_cfg if stt_cfg is not None else _stt_config()
    local = subdict(cfg, "local")
    model = str((local or {}).get("model") or "base")
    candidate = Path(model)
    if candidate.is_absolute():
        return (candidate / "model.bin").is_file()
    try:
        from huggingface_hub import try_to_load_from_cache

        found = try_to_load_from_cache(f"Systran/faster-whisper-{model}", "model.bin")
        return isinstance(found, str) and Path(found).is_file()
    except Exception:
        return False


def status() -> dict[str, Any]:
    cfg = _stt_config()
    try:
        from tools.transcription_tools import _get_provider, is_stt_enabled

        with data.chief_config_scope():
            provider = _get_provider(cfg)
            enabled = bool(is_stt_enabled(cfg))
    except Exception:
        provider, enabled = str(cfg.get("provider") or ""), bool(cfg.get("enabled", True))
    local = provider == "local"
    with _lock:
        job = _job.view() if _job else None
    return {
        "ok": True,
        "contract": CONTRACT,
        "default": DEFAULT_MODEL,
        "models": [
            {"id": mid, "label": spec["label"], "bytes": total_bytes(mid), "installed": installed(mid), "source": f"huggingface.co/{spec['repo']}"}
            for mid, spec in MODELS.items()
        ],
        "job": job,
        "stt": {
            "provider": provider or "none",
            "enabled": enabled,
            "local": local,
            # Voice typing works now without any download (a keyed provider, or a local model on disk).
            "ready": enabled and (not local or local_model_ready(cfg)) and provider not in ("", "none"),
        },
    }
