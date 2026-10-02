"""Settings → Tools: which service the chief uses to make images and to search the web.

The same rows, readiness and config writes as `hermes tools` and Hermes's own web dashboard
(hermes_cli/web_routers/tools.py): providers come from TOOL_CATEGORIES plus the image/web plugins, a pick goes
through ``apply_provider_selection``, keys go to the chief's profile, and the test runs the real tool.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from .data import chief_config_scope, chief_home
from .util import subdict

logger = logging.getLogger("chief-dashboard-bridge")

# The app's names for the two tools, and Hermes's category keys.
TOOLS = {"image": "image_gen", "web": "web"}
_WRITE_LOCK = threading.Lock()

# Shown first; every other row is under "More services". The active row is always shown first too.
_RECOMMENDED = {
    "image_gen": ["OpenAI (Codex auth)", "OpenAI", "FAL.ai", "OpenRouter (image)", "xAI Grok Imagine (image)"],
    "web": ["Exa · Free (keyless)", "Parallel · Free (keyless)", "Tavily", "Brave Search (Free)", "Perplexity", "Firecrawl"],
}
_LABELS = {
    "OpenAI (Codex auth)": "ChatGPT sign-in",
    "OpenAI": "OpenAI API key",
    "OpenRouter (image)": "OpenRouter",
    "xAI Grok Imagine (image)": "xAI Grok",
    "xAI Web Search (Grok)": "xAI Grok",
    "OpenAI Native Web Search (Codex Responses)": "OpenAI built-in search",
}
# Hermes's badge says "free" for the ChatGPT sign-in; it uses the plan the person already pays for.
_BADGES = {"OpenAI (Codex auth)": "your ChatGPT plan"}
_TEST_PROMPT = "A small friendly hexagon-shaped robot waving hello, soft studio light, simple background"
_TEST_QUERY = "today's top science news"


def _label(name: str) -> str:
    """A short name: "Exa · Free (keyless)" is "Exa" (the badge says free) and "Exa · Paid (API key)" "Exa (with a key)"."""
    if name in _LABELS:
        return _LABELS[name]
    base, sep, tier = name.partition(" · ")
    if not sep:
        return name
    return base if tier.lower().startswith("free") else f"{base} (with a key)" if tier.lower().startswith("paid") else name


def _hint(row: dict[str, Any], status: str) -> str:
    if status == "ready":
        return ""
    if status == "needs_keys":
        return "Needs an API key" if any("URL" not in k for k in _env_keys(row)) else "Needs its address"
    if status == "needs_auth":
        if row.get("managed_nous_feature") or row.get("requires_nous_auth"):
            return "Needs a Nous Portal subscription"
        if row.get("post_setup") == "openai_codex":
            return "Needs a ChatGPT sign-in in Hermes"
        if row.get("post_setup") == "xai_grok":
            return "Needs an xAI sign-in in Hermes"
        return "Needs a sign-in in Hermes"
    return "Needs setup in Hermes (hermes tools)"


def _env_keys(row: dict[str, Any]) -> list[str]:
    out = []
    for item in row.get("env_vars") or []:
        key = item.get("key") if isinstance(item, dict) else item
        if key:
            out.append(str(key))
    return out


def _rows(category: str, config: dict[str, Any]) -> tuple[list[dict[str, Any]], Any]:
    """The picker rows Hermes shows for a category, and the subscription state their readiness needs."""
    from hermes_cli.tools_config import TOOL_CATEGORIES, _visible_providers, get_nous_subscription_features

    cat = TOOL_CATEGORIES.get(category)
    if not cat:
        return [], None
    try:
        features = get_nous_subscription_features(config, force_fresh=False)
    except Exception:
        features = None
    return list(_visible_providers(cat, config, features=features)), features


def _describe(category: str, config: dict[str, Any]) -> dict[str, Any]:
    from hermes_cli.config import get_env_value
    from hermes_cli.tools_config import _is_provider_active, provider_readiness_status

    rows, features = _rows(category, config)
    active_name = None
    out: list[dict[str, Any]] = []
    for row in rows:
        name = str(row.get("name") or "")
        try:
            active = bool(_is_provider_active(row, config))
        except Exception:
            active = False
        try:
            status = provider_readiness_status(row, config, features=features, is_active=active)
        except Exception:
            status = "needs_setup"
        if active and active_name is None:
            active_name = name
        keys = []
        for item in row.get("env_vars") or []:
            if not isinstance(item, dict) or not item.get("key"):
                continue
            keys.append(
                {
                    "key": str(item["key"]),
                    "label": str(item.get("prompt") or item["key"]),
                    "url": str(item.get("url") or ""),
                    "set": bool(get_env_value(str(item["key"]))),
                }
            )
        item: dict[str, Any] = {
            "name": name,
            "label": _label(name),
            "blurb": str(row.get("tag") or ""),
            "badge": _BADGES.get(name, str(row.get("badge") or "")),
            "status": status,
            "hint": _hint(row, status),
            "keys": keys,
            "active": False,
            "recommended": name in _RECOMMENDED.get(category, []),
        }
        if category == "web" and row.get("web_backend"):
            item["searchOnly"] = _capabilities(str(row["web_backend"])) == ["search"]
        out.append(item)
    for item in out:
        item["active"] = item["name"] == active_name
    rank = {n: i for i, n in enumerate(_RECOMMENDED.get(category, []))}
    out.sort(key=lambda r: (not r["active"], not r["recommended"], rank.get(r["name"], 99)))
    return {"active": active_name, "providers": out}


def _capabilities(backend: str) -> list[str]:
    try:
        from hermes_cli.tools_config import web_provider_capabilities

        return list(web_provider_capabilities(backend))
    except Exception:
        return ["search", "extract"]


def _model_catalog(config: dict[str, Any], row: dict[str, Any] | None) -> tuple[dict[str, Any], str | None]:
    """The active image backend's models, as Hermes's dashboard lists them."""
    if not row:
        return {}, None
    plugin = row.get("image_gen_plugin_name") or row.get("imagegen_backend")
    if not plugin:
        return {}, None
    try:
        from hermes_cli.tools_config import IMAGEGEN_BACKENDS, _plugin_image_gen_catalog

        backend = IMAGEGEN_BACKENDS.get(plugin)
        catalog, default = backend["catalog_fn"](config) if backend else _plugin_image_gen_catalog(plugin)
        return dict(catalog or {}), default
    except Exception:
        logger.debug("image model catalog failed", exc_info=True)
        return {}, None


def _active_row(category: str, config: dict[str, Any]) -> dict[str, Any] | None:
    from hermes_cli.tools_config import _is_provider_active

    rows, _features = _rows(category, config)
    return next((r for r in rows if _safe(lambda r=r: _is_provider_active(r, config))), None)


def _safe(fn) -> bool:
    try:
        return bool(fn())
    except Exception:
        return False


def _image_model(config: dict[str, Any]) -> dict[str, Any] | None:
    catalog, default = _model_catalog(config, _active_row("image_gen", config))
    if not catalog:
        return None
    section = config.get("image_gen") if isinstance(config.get("image_gen"), dict) else {}
    current = str((section or {}).get("model") or "").strip()
    if current not in catalog:
        current = default if default in catalog else ""
    options = []
    for model_id, meta in catalog.items():
        meta = meta if isinstance(meta, dict) else {}
        detail = " · ".join(str(meta.get(k)) for k in ("speed", "price") if meta.get(k) and str(meta.get(k)).lower() != "varies")
        options.append({"id": str(model_id), "label": str(meta.get("display") or model_id), "detail": detail})
    return {"current": current, "options": options}


def _web_backends() -> dict[str, str]:
    try:
        from tools.web_tools import _get_extract_backend, _get_search_backend

        return {"search": str(_get_search_backend() or ""), "extract": str(_get_extract_backend() or "")}
    except Exception:
        return {"search": "", "extract": ""}


def get_tools() -> dict[str, Any]:
    from hermes_cli.config import load_config

    try:
        with chief_config_scope():
            config = load_config() or {}
            image = _describe("image_gen", config)
            image["model"] = _image_model(config)
            web = _describe("web", config)
            web["backends"] = _web_backends()
    except Exception:
        logger.warning("tools settings read failed", exc_info=True)
        return {"ok": False, "error": "Couldn't read the chief's tools from Hermes"}
    return {"ok": True, "image": image, "web": web}


def patch_tools(body: dict[str, Any]) -> dict[str, Any]:
    """{tool: "image"|"web", keys?: {NAME: value}, provider?: row name, model?: id}: keys first, then the pick."""
    from hermes_cli.config import load_config, save_config

    from .settings import _save_secret

    if not isinstance(body, dict) or body.get("tool") not in TOOLS:
        return {"ok": False, "error": "Unknown tool"}
    category = TOOLS[str(body["tool"])]
    keys = body.get("keys") if isinstance(body.get("keys"), dict) else {}
    provider = str(body.get("provider") or "").strip()
    model = str(body.get("model") or "").strip()
    with _WRITE_LOCK, chief_config_scope():
        config = load_config() or {}
        if keys:
            rows, _features = _rows(category, config)
            allowed = {k for row in rows for k in _env_keys(row)}
            for name, value in keys.items():
                if str(value or "").strip():
                    err = _save_secret(str(name), str(value), allowed)
                    if err:
                        return {"ok": False, "error": err}
            config = load_config() or {}
        if provider:
            described = {r["name"]: r for r in _describe(category, config)["providers"]}
            row = described.get(provider)
            if row is None:
                return {"ok": False, "error": "That service isn't available"}
            if row["status"] != "ready":
                return {"ok": False, "error": row["hint"] or "That service isn't ready yet"}
            err = _select(category, provider, config)
            if err:
                return {"ok": False, "error": err}
            save_config(config)
        if model:
            if category != "image_gen":
                return {"ok": False, "error": "Only image generation has a model choice"}
            catalog, _default = _model_catalog(config, _active_row(category, config))
            if model not in catalog:
                return {"ok": False, "error": "Unknown model for this service"}
            section = config.setdefault("image_gen", {})
            if not isinstance(section, dict):
                section = config["image_gen"] = {}
            section["model"] = model
            save_config(config)
    return get_tools()


def _select(category: str, provider: str, config: dict[str, Any]) -> str | None:
    from hermes_cli.tools_config import apply_provider_selection

    rows, _features = _rows(category, config)
    row = next((r for r in rows if r.get("name") == provider), None)
    backend = str((row or {}).get("web_backend") or "")
    if category == "web" and backend and _capabilities(backend) == ["search"]:
        # A search-only service (DuckDuckGo, Brave Free) takes searches; reading pages stays where it was.
        web = config.setdefault("web", {})
        if not isinstance(web, dict):
            web = config["web"] = {}
        web["search_backend"] = backend
        return None
    try:
        apply_provider_selection(category, provider, config)
    except KeyError:
        return "That service isn't available"
    if category == "web":
        # A whole pick replaces any earlier per-capability override, or it would keep winning.
        web = subdict(config, "web")
        for key in ("search_backend", "extract_backend"):
            if web.get(key):
                web[key] = ""
    return None


def test_tool(body: dict[str, Any]) -> dict[str, Any]:
    """Run the real tool once: one image, or one search. It uses the chosen service (and may cost a little)."""
    tool = str((body or {}).get("tool") or "")
    if tool not in TOOLS:
        return {"ok": False, "error": "Unknown tool"}
    try:
        from tools.registry import registry

        with chief_config_scope():
            if tool == "image":
                raw = registry.dispatch("image_generate", {"prompt": _TEST_PROMPT, "aspect_ratio": "square"})
            else:
                raw = registry.dispatch("web_search", {"query": _TEST_QUERY, "limit": 3})
    except Exception as exc:
        logger.warning("tool test failed: %s", type(exc).__name__)
        return {"ok": False, "error": "The test couldn't run"}
    result = raw if isinstance(raw, dict) else _json(raw)
    if not result.get("success", not result.get("error")):
        return {"ok": False, "error": _plain_error(result.get("error"))}
    if tool == "web":
        items = (result.get("data") or {}).get("web") or []
        found = [{"title": str(i.get("title") or i.get("url") or ""), "url": str(i.get("url") or "")} for i in items if isinstance(i, dict)][:3]
        return {"ok": True, "results": found} if found else {"ok": False, "error": "The search came back empty"}
    image = str(result.get("image") or "")
    path = _local_image(image)
    if not path:
        return {"ok": False, "error": "No image came back"}
    from .data import _attach_from_path, remember_media_path

    remember_media_path(path)
    return {"ok": True, "image": _attach_from_path(path)}


def _json(raw: Any) -> dict[str, Any]:
    try:
        value = json.loads(raw) if isinstance(raw, str) else {}
    except ValueError:
        return {"error": str(raw)[:200]}
    return value if isinstance(value, dict) else {}


_STATUS_WORDS = {
    "401": "The service turned down the key.",
    "402": "The account with this service is out of credit.",
    "403": "The service refused the request.",
    "429": "The service is busy or the account is over its limit.",
}


def _plain_error(error: Any) -> str:
    text = str(error or "").strip()
    if not text:
        return "The service didn't answer"
    # Hermes's errors can carry a traceback tail or a provider's whole JSON body: keep the first line, and from a
    # body only its "message", led by what the status code means.
    line = text.splitlines()[0]
    found = re.search(r"""['"]message['"]\s*:\s*(['"])(.+?)\1\s*[,}]""", line)
    detail = found.group(2) if found else line
    code = re.search(r"\b(401|402|403|429)\b", line)
    said = f"{_STATUS_WORDS[code.group(1)]} {detail}" if code and found else detail
    return said[:240]


def _local_image(image: str) -> str:
    """A local file the dashboard can show: the tool's own path, or a hosted image saved to the chief's cache."""
    if not image:
        return ""
    if not image.startswith(("http://", "https://")):
        return image if Path(image).is_file() else ""
    folder = chief_home() / "cache" / "tool-tests"
    folder.mkdir(parents=True, exist_ok=True)
    suffix = Path(image.split("?")[0]).suffix.lower()
    target = folder / f"test-image-{int(time.time())}{suffix if suffix in ('.png', '.jpg', '.jpeg', '.webp') else '.png'}"
    try:
        with urllib.request.urlopen(image, timeout=30) as resp:
            target.write_bytes(resp.read(25 * 1024 * 1024))
    except Exception:
        logger.debug("test image download failed", exc_info=True)
        return ""
    return str(target)
