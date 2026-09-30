"""Voice relay for the Chief dashboard: Hermes STT/TTS, no secrets on the wire."""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import tempfile
import time
from typing import Any

from .data import chief_config_scope

logger = logging.getLogger("chief-dashboard-bridge")

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
_AUDIO_EXT = {
    "audio/webm": ".webm",
    "audio/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/m4a": ".m4a",
    "audio/x-m4a": ".m4a",
    "video/webm": ".webm",
}
_SPEAK_MIME = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
}


def _unlink(path: str) -> None:
    if not path:
        return
    try:
        os.unlink(path)
    except OSError:
        pass


def _ext_for_mime(mime_type: str) -> str:
    key = (mime_type or "").split(";", 1)[0].strip().lower()
    return _AUDIO_EXT.get(key, ".webm")


def plugin_tts_provider(name: str) -> Any:
    """The plugin-registered TTS provider for `name` (e.g. voicestudio), or None for built-ins."""
    key = (name or "").strip().lower()
    if not key:
        return None
    try:
        from tools.tts_command_provider import BUILTIN_TTS_PROVIDERS

        if key in BUILTIN_TTS_PROVIDERS:
            return None
        from agent.tts_registry import get_provider

        return get_provider(key)
    except Exception:
        logger.debug("plugin tts lookup failed", exc_info=True)
        return None


def _fallback_status(provider_name: str) -> dict[str, Any] | None:
    plugin = plugin_tts_provider(provider_name)
    status = getattr(plugin, "fallback_status", None)
    if not callable(status):
        return None
    try:
        return status()
    except Exception:
        return None


def voice_config() -> dict[str, Any]:
    with chief_config_scope():
        return _voice_config_inner()


def _voice_config_inner() -> dict[str, Any]:
    stt_provider = "local"
    stt_enabled = True
    stt_model = ""
    tts_provider = "edge"
    tts_voice = ""
    try:
        from tools.transcription_tools import _get_provider, _load_stt_config, is_stt_enabled

        stt_cfg = _load_stt_config()
        stt_enabled = is_stt_enabled(stt_cfg)
        stt_provider = _get_provider(stt_cfg)
        nested = stt_cfg.get(stt_provider) if isinstance(stt_cfg.get(stt_provider), dict) else {}
        local = stt_cfg.get("local") if isinstance(stt_cfg.get("local"), dict) else {}
        stt_model = str(
            (nested or {}).get("model")
            or (nested or {}).get("model_id")
            or (local or {}).get("model")
            or stt_cfg.get("model")
            or ""
        )
    except Exception:
        logger.debug("voice-config stt probe failed", exc_info=True)
    try:
        from tools.tts_tool import _get_provider as _tts_provider
        from tools.tts_tool import _load_tts_config

        tts_cfg = _load_tts_config()
        tts_provider = _tts_provider(tts_cfg)
        tts_voice = str(tts_cfg.get("voice") or "")
        named = tts_cfg.get(tts_provider) if isinstance(tts_cfg.get(tts_provider), dict) else {}
        if not tts_voice and named:
            tts_voice = str(named.get("voice") or named.get("voice_id") or "")
    except Exception:
        logger.debug("voice-config tts probe failed", exc_info=True)
    tts: dict[str, Any] = {"provider": tts_provider, "voice": tts_voice}
    fallback = _fallback_status(tts_provider)
    if fallback:
        tts["fallback"] = fallback
    return {
        "ok": True,
        "stt": {"provider": stt_provider, "enabled": stt_enabled, "model": stt_model},
        "tts": tts,
    }


def _local_model_missing() -> bool:
    """Hermes's local STT would download its model from the Hub on first use; the app asks first instead."""
    try:
        from tools.transcription_tools import _get_provider, _load_stt_config

        from .speech_model import local_model_ready

        with chief_config_scope():
            cfg = _load_stt_config()
            if _get_provider(cfg) != "local":
                return False
        return not local_model_ready(cfg)
    except Exception:
        logger.debug("local model probe failed", exc_info=True)
        return False


def transcribe(body: dict[str, Any]) -> dict[str, Any]:
    data_url = str(body.get("data_url") or body.get("dataUrl") or "").strip()
    mime_type = str(body.get("mime_type") or body.get("mimeType") or "").strip()
    if not data_url.startswith("data:") or "," not in data_url:
        return {"ok": False, "error": "Invalid audio payload"}
    header, encoded = data_url.split(",", 1)
    if ";base64" not in header:
        return {"ok": False, "error": "Audio payload must be base64 encoded"}
    if not mime_type:
        mime_type = header[5:].split(";", 1)[0]
    kind = mime_type.split(";", 1)[0].lower()
    if not (kind.startswith("audio/") or kind == "video/webm"):
        return {"ok": False, "error": "Payload must be an audio recording"}
    try:
        audio_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return {"ok": False, "error": "Audio payload is not valid base64"}
    if not audio_bytes:
        return {"ok": False, "error": "Audio recording is empty"}
    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        return {"ok": False, "error": "Audio recording is too large"}

    if _local_model_missing():
        return {"ok": False, "code": "model_missing",
                "error": "Voice typing needs its speech model. Download it in Settings, then Voice (Check my system)."}

    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(
            prefix="chief-dashboard-voice-", suffix=_ext_for_mime(mime_type), delete=False
        ) as tmp:
            tmp.write(audio_bytes)
            temp_path = tmp.name
        from tools.voice_mode import transcribe_recording

        with chief_config_scope():
            result = transcribe_recording(temp_path)
    except Exception as exc:
        logger.warning("transcribe failed: %s", exc)
        return {"ok": False, "error": "Transcription failed"}
    finally:
        _unlink(temp_path)

    if not result.get("success"):
        err = str(result.get("error") or "Transcription failed")
        if "empty transcript" in err.lower():
            return {"ok": True, "transcript": "", "provider": result.get("provider")}
        return {"ok": False, "error": err}
    return {
        "ok": True,
        "transcript": str(result.get("transcript") or "").strip(),
        "provider": result.get("provider"),
        "filtered": bool(result.get("filtered")),
        "no_speech": bool(result.get("no_speech")),
    }


def speak(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "Text is required"}
    started = time.time()
    try:
        from tools.tts_tool import text_to_speech_tool

        with chief_config_scope():
            result_json = text_to_speech_tool(text)
        result = json.loads(result_json) if isinstance(result_json, str) else result_json
    except Exception as exc:
        logger.warning("speak failed: %s", exc)
        return {"ok": False, "error": "Speech synthesis failed"}
    if not isinstance(result, dict) or not result.get("success"):
        err = ""
        if isinstance(result, dict):
            err = str(result.get("error") or "")
        return {"ok": False, "error": err or "Speech synthesis failed"}
    paths = [str(p) for p in (result.get("file_paths") or []) if p]
    file_path = str(result.get("file_path") or "")
    if file_path and file_path not in paths:
        paths.insert(0, file_path)
    if not paths:
        return {"ok": False, "error": "Audio file missing"}
    clips: list[str] = []
    mime_type = "audio/mpeg"
    try:
        for path in paths:
            if not os.path.isfile(path):
                return {"ok": False, "error": "Audio file missing"}
            mime_type = _SPEAK_MIME.get(os.path.splitext(path)[1].lower(), "audio/mpeg")
            try:
                with open(path, "rb") as fh:
                    audio_bytes = fh.read()
            except OSError as exc:
                return {"ok": False, "error": f"Could not read audio: {exc}"}
            clips.append(f"data:{mime_type};base64,{base64.b64encode(audio_bytes).decode('ascii')}")
    finally:
        for path in paths:
            _unlink(path)
    out = {
        "ok": True,
        "data_url": clips[0],
        "data_urls": clips,
        "mime_type": mime_type,
        "provider": result.get("provider"),
    }
    # A plugin provider (VoiceStudio) that fell back to Edge during this call says so.
    fallback = _fallback_status(str(result.get("provider") or _current_tts_provider()))
    if fallback and float(fallback.get("at") or 0) >= started:
        out["fallback"] = True
        out["fallback_reason"] = str(fallback.get("reason") or "")
    return out


def _current_tts_provider() -> str:
    try:
        from tools.tts_tool import _get_provider, _load_tts_config

        with chief_config_scope():
            return str(_get_provider(_load_tts_config()) or "")
    except Exception:
        return ""
