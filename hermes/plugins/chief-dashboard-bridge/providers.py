"""Model provider connection for onboarding and Settings: contract `chief.providers.v1`.

Every provider fact comes from Hermes itself, never from a list kept here:

- the catalog and each provider's auth type / key variable: ``hermes_cli.inventory`` (the same builder as
  Hermes's `model.options` RPC and its dashboard's /api/model/options) and ``hermes_cli.auth.PROVIDER_REGISTRY``;
- saving a key: ``hermes_cli.credential_lifecycle.save_provider_env_credential`` (writes the profile's .env
  and rotates stale copies);
- choosing the main model: the dashboard's own /api/model/set handler (model validation, the expensive-model
  guard, credential pointers);
- custom and local OpenAI-compatible endpoints: the dashboard's custom-endpoint handlers (probe /models,
  save under `providers:`, keys in .env by reference);
- the live test: ``agent.auxiliary_client.call_llm``, which speaks every provider's API style.

Everything runs in the chief profile's scope. Keys are accepted, never returned or logged. A contract test
(hermes/tests/contract) exercises these imports against each Hermes pin before it ships.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Optional

from .data import chief_config_scope

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.providers.v1"
_SLUG = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,63}$")
_ENV = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
# Rows a person can finish connecting inside the app. OAuth and cloud-SDK providers are listed but set up
# with Hermes's own tools for now.
_KEY_AUTH = {"api_key"}


def _run(coro):
    """Run a dashboard coroutine from a bridge request thread (which has no event loop)."""
    return asyncio.run(coro)


# OpenRouter is Hermes's default aggregator and is not in PROVIDER_REGISTRY; Hermes's own setup flow
# (hermes_cli/model_setup_flows.py) synthesizes it with this variable.
_UNREGISTERED_KEY_ENV = {"openrouter": "OPENROUTER_API_KEY"}


def _key_env(slug: str, raw: Optional[dict[str, Any]] = None) -> str:
    reg = _registry(slug)
    if reg is not None and getattr(reg, "auth_type", "") in _KEY_AUTH:
        env_vars = [str(v) for v in (getattr(reg, "api_key_env_vars", None) or ()) if v]
        if env_vars:
            return env_vars[0]
    if raw and str(raw.get("auth_type") or "") in _KEY_AUTH and raw.get("key_env"):
        return str(raw["key_env"])
    return _UNREGISTERED_KEY_ENV.get(slug, "")


def _registry(slug: str):
    try:
        from hermes_cli.auth import PROVIDER_REGISTRY

        return PROVIDER_REGISTRY.get(slug)
    except Exception:
        return None


def _row(raw: dict[str, Any]) -> dict[str, Any]:
    slug = str(raw.get("slug") or "")
    reg = _registry(slug)
    auth_type = str(getattr(reg, "auth_type", "") or raw.get("auth_type") or "")
    key_env = _key_env(slug, raw)
    if slug == "custom" or raw.get("is_user_defined"):
        kind = "custom"
    elif key_env:
        kind = "key"
    else:
        kind = "external"  # OAuth, cloud SDK or external process: set up with Hermes's own tools
    return {
        "slug": slug,
        "name": str(raw.get("name") or slug),
        "kind": kind,
        "authType": auth_type,
        "keyEnv": key_env,
        "connected": bool(raw.get("authenticated")),
        "current": bool(raw.get("is_current")),
        "models": [str(m) for m in (raw.get("models") or [])][:200],
        "featured": [str(m) for m in (raw.get("featured_models") or [])][:12],
        "warning": str(raw.get("warning") or ""),
    }


def catalog(refresh: bool = False) -> dict[str, Any]:
    """Every provider Hermes knows, the current main model, and whether the chief can answer."""
    with chief_config_scope():
        from hermes_cli.inventory import build_model_options_payload, load_picker_context

        payload = build_model_options_payload(load_picker_context(), include_unconfigured=True, refresh=bool(refresh))
    rows = [_row(r) for r in payload.get("providers") or [] if isinstance(r, dict) and r.get("slug") not in ("moa",)]
    return {"ok": True, "contract": CONTRACT, "provider": str(payload.get("provider") or ""),
            "model": str(payload.get("model") or ""), "providers": rows, "status": status()}


def status() -> dict[str, Any]:
    """Can the chief's configured main model be served? Same resolver as a new session."""
    with chief_config_scope():
        try:
            from hermes_cli.config import load_config

            cfg = load_config() or {}
            model_cfg = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
            provider = str(model_cfg.get("provider") or "").strip()
            model = str(model_cfg.get("default") or model_cfg.get("model") or "").strip()
            if not provider or not model:
                return {"ready": False, "provider": provider, "model": model, "error": "No model is chosen yet."}
            from hermes_cli.auth import has_usable_secret
            from hermes_cli.runtime_provider import resolve_runtime_provider

            runtime = resolve_runtime_provider(requested=provider, target_model=model)
            api_key = runtime.get("api_key")
            key_text = "" if callable(api_key) else str(api_key or "").strip()
            usable = (callable(api_key) or key_text in {"aws-sdk", "no-key-required"} or has_usable_secret(key_text)
                      or bool(runtime.get("command")) or _is_local(str(runtime.get("base_url") or "")))
            if not usable:
                return {"ready": False, "provider": provider, "model": model,
                        "error": f"No usable credentials for {provider}."}
            return {"ready": True, "provider": provider, "model": model, "error": ""}
        except Exception as exc:
            logger.info("provider status: %s", type(exc).__name__)
            return {"ready": False, "provider": "", "model": "", "error": _plain(exc)}


def _is_local(url: str) -> bool:
    try:
        from agent.model_metadata import is_local_endpoint

        return bool(url) and bool(is_local_endpoint(url))
    except Exception:
        return False


def save_key(slug: str, key: str) -> dict[str, Any]:
    """Store an API key for a key-based provider (profile .env). Never echoes the key."""
    slug = (slug or "").strip().lower()
    key = (key or "").strip()
    if not _SLUG.match(slug):
        return {"ok": False, "error": "Unknown provider."}
    env_var = _key_env(slug)
    if not env_var or not _ENV.match(env_var):
        return {"ok": False, "error": "This provider isn't set up with a key."}
    if not key or len(key) > 4096 or any(c.isspace() for c in key):
        return {"ok": False, "error": "That doesn't look like an API key."}
    with chief_config_scope():
        from hermes_cli.credential_lifecycle import save_provider_env_credential

        save_provider_env_credential(env_var, key)
    return {"ok": True, "provider": slug}


def recommended_model(slug: str) -> str:
    with chief_config_scope():
        try:
            from hermes_cli.web_routers.models import get_recommended_default_model

            return str((get_recommended_default_model(provider=slug) or {}).get("model") or "")
        except Exception:
            return ""


def provider_models(slug: str) -> dict[str, Any]:
    """Models a connected provider offers (fetched fresh), with Hermes's recommended default."""
    for row in catalog(refresh=True)["providers"]:
        if row["slug"] == slug:
            return {"ok": True, "provider": slug, "models": row["models"], "featured": row["featured"],
                    "recommended": recommended_model(slug), "connected": row["connected"]}
    return {"ok": False, "error": "Unknown provider."}


def choose_model(slug: str, model: str, *, confirm_expensive: bool = False) -> dict[str, Any]:
    """Make provider/model the chief's main model, through Hermes's own model assignment."""
    slug, model = (slug or "").strip(), (model or "").strip()
    if not _SLUG.match(slug.lower()) or not model or len(model) > 200:
        return {"ok": False, "error": "Choose a provider and a model."}
    with chief_config_scope():
        from hermes_cli.web_models import ModelAssignment
        from hermes_cli.web_routers.models import set_model_assignment

        body = ModelAssignment(scope="main", provider=slug, model=model, confirm_expensive_model=confirm_expensive)
        try:
            result = _run(set_model_assignment(body))
        except Exception as exc:
            return {"ok": False, "error": _plain(exc)}
    if isinstance(result, dict) and result.get("confirm_required"):
        return {"ok": False, "confirm": str(result.get("confirm_message") or "This model is expensive. Use it anyway?")}
    if isinstance(result, dict) and result.get("ok") is False:
        return {"ok": False, "error": str(result.get("error") or result.get("detail") or "Hermes did not accept that model.")}
    return {"ok": True, "provider": slug, "model": model, "status": status()}


def check_endpoint(base_url: str, api_key: str = "") -> dict[str, Any]:
    """Probe an OpenAI-compatible endpoint (root or /v1) and list its models. The key is optional."""
    base_url = (base_url or "").strip()
    if not re.match(r"^https?://[^\s/]+", base_url):
        return {"ok": False, "reachable": False, "error": "Enter the endpoint's address, for example http://127.0.0.1:11434/v1"}
    with chief_config_scope():
        from hermes_cli.web_models import CustomEndpointUpdate
        from hermes_cli.web_routers.config_env import validate_custom_endpoint

        body = CustomEndpointUpdate(name="probe", base_url=base_url, model="", api_key=(api_key or "").strip() or None)
        try:
            result = _run(validate_custom_endpoint(body))
        except Exception as exc:
            return {"ok": False, "reachable": False, "error": _plain(exc)}
    return {
        "ok": bool(result.get("ok")),
        "reachable": bool(result.get("reachable")),
        "error": str(result.get("message") or ""),
        "models": [str(m) for m in (result.get("models") or [])][:200],
        "baseUrl": str(result.get("resolved_base_url") or base_url),
    }


def save_endpoint(name: str, base_url: str, model: str, api_key: str = "") -> dict[str, Any]:
    """Save a custom endpoint and make it the main model (key, if any, kept in .env by reference)."""
    name = (name or "").strip() or "Local model"
    base_url, model = (base_url or "").strip(), (model or "").strip()
    if not base_url or not model:
        return {"ok": False, "error": "An endpoint and a model are both needed."}
    with chief_config_scope():
        from hermes_cli.web_models import CustomEndpointUpdate
        from hermes_cli.web_routers.config_env import upsert_custom_endpoint

        body = CustomEndpointUpdate(name=name[:60], base_url=base_url, model=model,
                                    api_key=(api_key or "").strip() or None, make_default=True)
        try:
            result = upsert_custom_endpoint(body)
        except Exception as exc:
            return {"ok": False, "error": _plain(exc)}
    return {"ok": True, "provider": str(result.get("id") or ""), "model": model, "status": status()}


def test_message(timeout: float = 45.0) -> dict[str, Any]:
    """Ask the main model for one tiny reply. Proves the key, the endpoint and the model together."""
    current = status()
    if not current.get("provider") or not current.get("model"):
        return {"ok": False, "error": "Choose a model first."}
    with chief_config_scope():
        try:
            from agent.auxiliary_client import call_llm

            reply = call_llm(provider=current["provider"], model=current["model"],
                             messages=[{"role": "user", "content": "Reply with the single word: ready"}],
                             max_tokens=16, timeout=timeout)
        except Exception as exc:
            return {"ok": False, **_explain(exc)}
    text = _reply_text(reply)
    return {"ok": True, "reply": text[:120], "provider": current["provider"], "model": current["model"]}


def _reply_text(reply: Any) -> str:
    try:
        choice = reply.choices[0]
        return str(getattr(choice.message, "content", "") or "").strip()
    except Exception:
        return str(reply or "").strip()


def _explain(exc: Exception) -> dict[str, str]:
    """A person-sized reason for a failed test, never the key or a stack trace."""
    status_code = getattr(exc, "status_code", None) or getattr(getattr(exc, "response", None), "status_code", None)
    name = type(exc).__name__
    if status_code in (401, 403) or "Authentication" in name or "PermissionDenied" in name:
        return {"code": "rejected", "error": "The provider rejected the key."}
    if status_code == 404 or "NotFound" in name:
        return {"code": "model", "error": "The provider doesn't offer that model. Pick another one."}
    if status_code == 429 or "RateLimit" in name:
        return {"code": "rate", "error": "The key works but the provider is rate-limiting it right now. Try again in a minute."}
    if "Timeout" in name:
        return {"code": "timeout", "error": "The provider didn't answer in time."}
    if "Connection" in name or "ConnectError" in name:
        return {"code": "unreachable", "error": "Couldn't reach the provider. Check the internet connection or the endpoint address."}
    return {"code": "other", "error": _plain(exc)}


def _plain(exc: Exception) -> str:
    text = str(getattr(exc, "detail", "") or exc or type(exc).__name__)
    text = re.sub(r"(sk|key|token)[-_A-Za-z0-9]{12,}", "[hidden]", text)
    return text.splitlines()[0][:240] if text else type(exc).__name__
