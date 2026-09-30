"""Hermes-backed voice settings: same catalog and yaml as `hermes tools`."""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.error
import urllib.request
from typing import Any

from . import voice
from .data import chief_config_scope

logger = logging.getLogger("chief-dashboard-bridge")

_STATUS_RANK = {"ready": 0, "needs_setup": 1, "needs_keys": 2, "needs_auth": 3}
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
_ALWAYS_SECRET = frozenset({"ELEVENLABS_API_KEY"})
DEFAULT_ELEVENLABS_VOICE_ID = "pNInz6obpgDQGcFmaJgB"
_EL_VOICE_TTL = 30.0
_el_voice_cache: tuple[float, list[dict[str, str]], str | None] | None = None

EDGE_VOICES = [
    {"id": "en-US-AriaNeural", "label": "Aria (US)"},
    {"id": "en-US-GuyNeural", "label": "Guy (US)"},
    {"id": "en-US-JennyNeural", "label": "Jenny (US)"},
    {"id": "en-US-AndrewNeural", "label": "Andrew (US)"},
    {"id": "en-US-EmmaNeural", "label": "Emma (US)"},
    {"id": "en-GB-SoniaNeural", "label": "Sonia (UK)"},
    {"id": "en-GB-RyanNeural", "label": "Ryan (UK)"},
    {"id": "en-AU-NatashaNeural", "label": "Natasha (AU)"},
    {"id": "en-AU-WilliamNeural", "label": "William (AU)"},
    {"id": "en-CA-ClaraNeural", "label": "Clara (CA)"},
    {"id": "en-CA-LiamNeural", "label": "Liam (CA)"},
]


def _load_config() -> dict[str, Any]:
    from hermes_cli.config import load_config

    with chief_config_scope():
        return load_config() or {}


def _stt_model_key(provider: str) -> str:
    try:
        from hermes_cli.tools_config_providers import _STT_MODEL_CONFIG_KEY

        return str(_STT_MODEL_CONFIG_KEY.get(provider) or "model")
    except Exception:
        return "model_id" if provider == "elevenlabs" else "model"


def _stt_model_value(stt_cfg: dict[str, Any], provider: str) -> str:
    key = _stt_model_key(provider)
    nested = stt_cfg.get(provider) if isinstance(stt_cfg.get(provider), dict) else {}
    return str((nested or {}).get(key) or stt_cfg.get("model") or "")


def _stt_models(provider: str) -> list[str]:
    try:
        from hermes_cli.tools_config_providers import STT_MODEL_CATALOG

        return list(STT_MODEL_CATALOG.get(provider) or [])
    except Exception:
        if provider == "local":
            return ["base", "tiny", "small", "medium", "large-v3"]
        return []


def _row_env(row: dict[str, Any]) -> tuple[str, str]:
    for item in row.get("env_vars") or []:
        if isinstance(item, dict) and item.get("key"):
            return str(item["key"]), str(item.get("url") or "")
        if isinstance(item, (list, tuple)) and item:
            return str(item[0]), ""
        if isinstance(item, str):
            return item, ""
    return "", ""


def _hint(status: str, row: dict[str, Any], slug: str = "") -> str:
    if status == "ready":
        return ""
    if status == "needs_keys":
        if slug == "elevenlabs":
            return "Add an ElevenLabs key to the chief’s profile"
        return "Add this key to the chief’s profile"
    if status == "needs_auth":
        return "Needs Nous login"
    if status == "needs_setup":
        return "Needs setup in Hermes"
    return status.replace("_", " ")


def _slug(row: dict[str, Any], kind: str) -> str:
    key = "stt_provider" if kind == "stt" else "tts_provider"
    return str(row.get(key) or "").strip()


def _secret_present(env_var: str, provider_id: str) -> bool:
    if not env_var:
        return False
    try:
        from tools.tool_backend_helpers import resolve_provider_secret

        return bool((resolve_provider_secret(env_var, provider_id) or "").strip())
    except Exception:
        return False


def _catalog(kind: str, config: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        from hermes_cli.tools_config import TOOL_CATEGORIES, get_nous_subscription_features
        from hermes_cli.tools_config_providers import _visible_providers, provider_readiness_status
    except Exception:
        logger.debug("settings catalog import failed", exc_info=True)
        return []

    cat = TOOL_CATEGORIES.get(kind)
    if not cat:
        return []
    try:
        features = get_nous_subscription_features(config, force_fresh=False)
    except Exception:
        features = None
    try:
        visible = _visible_providers(cat, config, features=features)
    except Exception:
        logger.debug("settings visible providers failed", exc_info=True)
        return []

    best: dict[str, tuple[dict[str, Any], str]] = {}
    order: list[str] = []
    for row in visible:
        slug = _slug(row, kind)
        if not slug:
            continue
        try:
            status = provider_readiness_status(row, config, features=features)
        except Exception:
            status = "needs_setup"
        if status == "needs_keys":
            env_key, _url = _row_env(row)
            if _secret_present(env_key, slug):
                status = "ready"
        prev = best.get(slug)
        if prev is None:
            best[slug] = (row, status)
            order.append(slug)
            continue
        old_row, old_status = prev
        new_rank = _STATUS_RANK.get(status, 9)
        old_rank = _STATUS_RANK.get(old_status, 9)
        if new_rank < old_rank:
            best[slug] = (row, status)
        elif new_rank == old_rank and old_row.get("managed_nous_feature") and not row.get("managed_nous_feature"):
            best[slug] = (row, status)

    out: list[dict[str, Any]] = []
    for slug in order:
        row, status = best[slug]
        env_key, key_url = _row_env(row)
        item: dict[str, Any] = {
            "id": slug,
            "name": str(row.get("name") or slug),
            "status": status,
            "hint": _hint(status, row, slug),
        }
        if env_key:
            item["env_key"] = env_key
        if key_url:
            item["key_url"] = key_url
        out.append(item)
    return out


def _edge_voices(current: str) -> list[dict[str, str]]:
    voices = list(EDGE_VOICES)
    ids = {v["id"] for v in voices}
    if current and current not in ids:
        voices.append({"id": current, "label": current})
    return voices


def _el_fallback_voices(current: str) -> list[dict[str, str]]:
    voice_id = current or DEFAULT_ELEVENLABS_VOICE_ID
    label = "Adam" if voice_id == DEFAULT_ELEVENLABS_VOICE_ID else voice_id
    return [{"id": voice_id, "label": label}]


def _forget_el_voices() -> None:
    global _el_voice_cache
    _el_voice_cache = None


def _elevenlabs_voices(current: str) -> tuple[list[dict[str, str]], str | None]:
    global _el_voice_cache
    now = time.monotonic()
    if _el_voice_cache and now - _el_voice_cache[0] < _EL_VOICE_TTL:
        voices = list(_el_voice_cache[1])
        err = _el_voice_cache[2]
        ids = {v["id"] for v in voices}
        if current and current not in ids:
            voices.append({"id": current, "label": current})
        return voices, err

    api_key = ""
    try:
        from tools.tool_backend_helpers import resolve_provider_secret

        api_key = (resolve_provider_secret("ELEVENLABS_API_KEY", "elevenlabs") or "").strip()
    except Exception:
        api_key = ""
    if not api_key:
        return _el_fallback_voices(current), "missing"

    try:
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/voices",
            headers={"Accept": "application/json", "xi-api-key": api_key},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            logger.info("ElevenLabs voices unauthorized")
            voices = _el_fallback_voices(current)
            _el_voice_cache = (now, list(voices), "unauthorized")
            return voices, "unauthorized"
        logger.warning("ElevenLabs voice list failed: HTTP %s", exc.code)
        return _el_fallback_voices(current), "network"
    except Exception:
        logger.warning("ElevenLabs voice list failed", exc_info=True)
        return _el_fallback_voices(current), "network"

    voices: list[dict[str, str]] = []
    for item in payload.get("voices") or []:
        if not isinstance(item, dict):
            continue
        voice_id = str(item.get("voice_id") or "").strip()
        if not voice_id:
            continue
        name = str(item.get("name") or voice_id).strip()
        category = str(item.get("category") or "").strip()
        label = f"{name} ({category})" if category else name
        voices.append({"id": voice_id, "label": label})
    voices.sort(key=lambda row: row["label"].lower())
    ids = {v["id"] for v in voices}
    if current and current not in ids:
        voices.append({"id": current, "label": current})
    if not voices:
        voices = _el_fallback_voices(current)
    _el_voice_cache = (now, list(voices), None)
    return voices, None


def _mark_elevenlabs_rejected(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        if row.get("id") == "elevenlabs":
            row["status"] = "needs_keys"
            row["hint"] = "That key was rejected."


def get_settings() -> dict[str, Any]:
    with chief_config_scope():
        return _get_settings_inner()


def _get_settings_inner() -> dict[str, Any]:
    current = voice.voice_config()
    stt_provider = str((current.get("stt") or {}).get("provider") or "local")
    tts_provider = str((current.get("tts") or {}).get("provider") or "edge")
    tts_voice = str((current.get("tts") or {}).get("voice") or "")
    stt_enabled = bool((current.get("stt") or {}).get("enabled", True))
    stt_model = str((current.get("stt") or {}).get("model") or "")
    stt_providers: list[dict[str, Any]] = []
    tts_providers: list[dict[str, Any]] = []
    try:
        config = _load_config()
        stt_cfg = config.get("stt") if isinstance(config.get("stt"), dict) else {}
        stt_model = _stt_model_value(stt_cfg or {}, stt_provider)
        stt_providers = _catalog("stt", config)
        tts_providers = _catalog("tts", config)
    except Exception:
        logger.debug("settings catalog failed", exc_info=True)

    voice_label = ""
    if tts_provider == "elevenlabs":
        voices, voice_err = _elevenlabs_voices(tts_voice)
        voice_label = "ElevenLabs voice"
        if voice_err == "unauthorized":
            _mark_elevenlabs_rejected(tts_providers)
            _mark_elevenlabs_rejected(stt_providers)
    elif tts_provider == "edge":
        voices = _edge_voices(tts_voice)
        voice_label = "Edge voice"
    else:
        listed = _plugin_voices(tts_provider)
        if listed is not None:
            voices = listed
            voice_label = f"{_plugin_display(tts_provider)} voice"
            tts_voice = _plugin_current_voice(tts_provider) or tts_voice
        else:
            voices = [{"id": tts_voice, "label": tts_voice}] if tts_voice else []

    return {
        "ok": True,
        "source": "hermes:chief",
        "stt": {
            "provider": stt_provider,
            "enabled": stt_enabled,
            "model": stt_model,
            "providers": stt_providers,
            "models": _stt_models(stt_provider),
        },
        "tts": {
            "provider": tts_provider,
            "voice": tts_voice,
            "providers": tts_providers,
            "voices": voices,
            "voice_label": voice_label,
        },
    }


def _plugin_voices(provider: str) -> list[dict[str, str]] | None:
    """Voices of a plugin TTS provider that lists them (VoiceStudio), or None when it cannot."""
    plugin = voice.plugin_tts_provider(provider)
    if plugin is None or not callable(getattr(plugin, "list_voices", None)):
        return None
    try:
        rows = plugin.list_voices() or []
    except Exception:
        logger.debug("plugin voice list failed", exc_info=True)
        return None
    voices: list[dict[str, str]] = []
    for row in rows:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        item = {"id": str(row["id"]), "label": str(row.get("display") or row.get("label") or row["id"])}
        if row.get("group"):
            item["group"] = str(row["group"])
        voices.append(item)
    return voices or None


def _plugin_display(provider: str) -> str:
    plugin = voice.plugin_tts_provider(provider)
    name = str(getattr(plugin, "display_name", "") or provider)
    return name.split(" (")[0]


def _plugin_current_voice(provider: str) -> str:
    plugin = voice.plugin_tts_provider(provider)
    current = getattr(plugin, "current_voice", None)
    if callable(current):
        try:
            return str(current() or "")
        except Exception:
            return ""
    return ""


def _row_by_id(rows: list[dict[str, Any]], provider_id: str) -> dict[str, Any] | None:
    for row in rows:
        if row.get("id") == provider_id:
            return row
    return None


def _save(path: str, value: Any) -> str | None:
    try:
        from cli import save_config_value
    except Exception as exc:
        logger.warning("save_config_value import failed: %s", exc)
        return "Could not write Hermes config"
    try:
        with chief_config_scope():
            if not save_config_value(path, value):
                return "Could not write Hermes config"
    except Exception as exc:
        logger.warning("save_config_value failed: %s", exc)
        return "Could not write Hermes config"
    return None


def _allowed_secret_names(rows: list[dict[str, Any]]) -> set[str]:
    names = set(_ALWAYS_SECRET)
    for row in rows:
        key = str(row.get("env_key") or "").strip()
        if key:
            names.add(key)
    return names


def _probe_elevenlabs_key(api_key: str) -> str | None:
    try:
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/voices",
            headers={"Accept": "application/json", "xi-api-key": api_key},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            resp.read(64)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return "That key was rejected."
    except Exception:
        logger.debug("ElevenLabs key probe skipped", exc_info=True)
    return None


def _save_secret(env_var: str, value: str, allowed: set[str]) -> str | None:
    env_var = env_var.strip()
    value = value.strip()
    if not env_var or not value:
        return "API key is empty"
    if env_var not in allowed or not _ENV_NAME.match(env_var):
        return "Unknown key name"
    if env_var == "ELEVENLABS_API_KEY":
        rejected = _probe_elevenlabs_key(value)
        if rejected:
            return rejected
    try:
        from hermes_cli.credential_lifecycle import save_provider_env_credential

        with chief_config_scope():
            save_provider_env_credential(env_var, value)
    except Exception as exc:
        logger.warning("save credential failed: %s", type(exc).__name__)
        return "Could not save API key to Hermes"
    if env_var == "ELEVENLABS_API_KEY":
        _forget_el_voices()
    return None


def _collect_secrets(
    body: dict[str, Any],
    stt_body: dict[str, Any],
    tts_body: dict[str, Any],
    stt_rows: list[dict[str, Any]],
    tts_rows: list[dict[str, Any]],
    stt_now: str,
    tts_now: str,
) -> dict[str, str]:
    out: dict[str, str] = {}
    raw = body.get("secrets") if isinstance(body.get("secrets"), dict) else {}
    for key, val in raw.items():
        text = str(val or "").strip()
        if text:
            out[str(key)] = text
    stt_key = str(stt_body.get("api_key") or "").strip()
    if stt_key:
        target = str(stt_body.get("provider") or stt_now).strip()
        row = _row_by_id(stt_rows, target)
        env_key = str((row or {}).get("env_key") or "") or (
            "ELEVENLABS_API_KEY" if target == "elevenlabs" else ""
        )
        if env_key:
            out[env_key] = stt_key
    tts_key = str(tts_body.get("api_key") or "").strip()
    if tts_key:
        target = str(tts_body.get("provider") or tts_now).strip()
        row = _row_by_id(tts_rows, target)
        env_key = str((row or {}).get("env_key") or "") or (
            "ELEVENLABS_API_KEY" if target == "elevenlabs" else ""
        )
        if env_key:
            out[env_key] = tts_key
    return out


def patch_settings(body: dict[str, Any]) -> dict[str, Any]:
    with chief_config_scope():
        return _patch_settings_inner(body)


def _patch_settings_inner(body: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(body, dict):
        return {"ok": False, "error": "Invalid settings payload"}
    stt_body = body.get("stt") if isinstance(body.get("stt"), dict) else {}
    tts_body = body.get("tts") if isinstance(body.get("tts"), dict) else {}
    secrets_body = body.get("secrets") if isinstance(body.get("secrets"), dict) else {}
    if not stt_body and not tts_body and not secrets_body:
        return get_settings()

    current = get_settings()
    stt_now = str((current.get("stt") or {}).get("provider") or "local")
    tts_now = str((current.get("tts") or {}).get("provider") or "edge")
    stt_rows = list((current.get("stt") or {}).get("providers") or [])
    tts_rows = list((current.get("tts") or {}).get("providers") or [])

    secrets = _collect_secrets(body, stt_body, tts_body, stt_rows, tts_rows, stt_now, tts_now)
    if secrets:
        allowed = _allowed_secret_names(stt_rows + tts_rows)
        for env_var, value in secrets.items():
            err = _save_secret(env_var, value, allowed)
            if err:
                return {"ok": False, "error": err}
        current = get_settings()
        stt_now = str((current.get("stt") or {}).get("provider") or stt_now)
        tts_now = str((current.get("tts") or {}).get("provider") or tts_now)
        stt_rows = list((current.get("stt") or {}).get("providers") or [])
        tts_rows = list((current.get("tts") or {}).get("providers") or [])

    stt_provider = str(stt_body.get("provider") or "").strip()
    stt_model = str(stt_body.get("model") or "").strip()
    tts_provider = str(tts_body.get("provider") or "").strip()
    tts_voice = str(tts_body.get("voice") or "").strip()

    if stt_provider:
        row = _row_by_id(stt_rows, stt_provider)
        if not row:
            return {"ok": False, "error": f"Unknown hearing provider: {stt_provider}"}
        if row.get("status") != "ready" and stt_provider != stt_now:
            return {"ok": False, "error": row.get("hint") or "That hearing provider is not ready in Hermes"}
        err = _save("stt.provider", stt_provider)
        if err:
            return {"ok": False, "error": err}
        stt_now = stt_provider

    if stt_model:
        models = _stt_models(stt_now)
        if not models:
            return {"ok": False, "error": "That hearing provider has no model list"}
        if stt_model not in models:
            return {"ok": False, "error": f"Unknown hearing model: {stt_model}"}
        key = _stt_model_key(stt_now)
        err = _save(f"stt.{stt_now}.{key}", stt_model)
        if err:
            return {"ok": False, "error": err}

    if tts_provider:
        row = _row_by_id(tts_rows, tts_provider)
        if not row:
            return {"ok": False, "error": f"Unknown speaking provider: {tts_provider}"}
        if row.get("status") != "ready" and tts_provider != tts_now:
            return {"ok": False, "error": row.get("hint") or "That speaking provider is not ready in Hermes"}
        err = _save("tts.provider", tts_provider)
        if err:
            return {"ok": False, "error": err}
        tts_now = tts_provider

    if tts_voice:
        if tts_now == "edge":
            allowed = {v["id"] for v in _edge_voices(str((current.get("tts") or {}).get("voice") or ""))}
            if tts_voice not in allowed:
                return {"ok": False, "error": f"Unknown Edge voice: {tts_voice}"}
            err = _save("tts.edge.voice", tts_voice)
            if err:
                return {"ok": False, "error": err}
        elif tts_now == "elevenlabs":
            listed, voice_err = _elevenlabs_voices(str((current.get("tts") or {}).get("voice") or ""))
            allowed = {v["id"] for v in listed}
            if voice_err != "network" and allowed and tts_voice not in allowed:
                return {"ok": False, "error": "Unknown ElevenLabs voice"}
            err = _save("tts.elevenlabs.voice_id", tts_voice)
            if err:
                return {"ok": False, "error": err}
        else:
            listed = _plugin_voices(tts_now)
            if listed is None:
                return {"ok": False, "error": "This speaking engine has no voice list"}
            if tts_voice not in {v["id"] for v in listed}:
                return {"ok": False, "error": "Unknown voice for this engine"}
            err = _save(f"tts.{tts_now}.voice", tts_voice)
            if err:
                return {"ok": False, "error": err}

    return get_settings()
