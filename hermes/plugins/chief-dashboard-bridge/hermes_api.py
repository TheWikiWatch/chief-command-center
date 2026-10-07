"""Every part of Hermes the bridge relies on, in one list, checked when the gateway starts.

Hermes is upstream code that changes between releases, and the bridge uses some of its private names. When one
moves, the feature that needs it must say so, not fail quietly: `check()` imports every listed name (in the
background, once per process) and `/health` reports the features that are missing, which the dashboard's status
sheet shows. `get()` is the way in for code that must not fail silently (approvals first): a missing name is
logged once as a warning and raised as `HermesMissing`.

`hermes/tests/test_hermes_api.py` fails when a plugin module imports a Hermes name that isn't listed here, so
the check stays complete, and the upstream compatibility suite runs `check()` against a candidate Hermes.
"""

from __future__ import annotations

import importlib
import logging
import threading
from typing import Any

logger = logging.getLogger("chief-dashboard-bridge")

# feature -> {module: (names...)}; an empty tuple means the module itself. A name written "new|old" is found under
# either (the first that exists): how the bridge spans a Hermes rename without a release in lockstep.
CAPABILITIES: dict[str, dict[str, tuple[str, ...]]] = {
    "approvals": {
        "tools.approval": ("get_pending_gateway_approval", "list_gateway_approvals", "resolve_gateway_approval"),
        "tools.slash_confirm": ("get_pending",),
        # The words Hermes posts when it asks for an approval: the chat drops that announcement (the sheet shows it).
        "gateway.platforms.base_exec_approval": ("EA_HEADER_TEXT",),
    },
    "questions": {
        "tools.clarify_gateway": ("mark_awaiting_text", "resolve_gateway_clarify", "get_pending_for_session"),
    },
    "chat platform": {
        "gateway.config": ("Platform", "PlatformConfig"),
        "gateway.platforms._shared": ("get_scoped_secret", "seed_extra_from_env"),
        "gateway.platforms.base": ("BasePlatformAdapter", "SendResult"),
        "gateway.platforms.event": ("MessageEvent", "MessageType"),
    },
    "status line": {
        "agent.display": ("build_status_phrase",),
    },
    "profiles": {
        "hermes_constants": (
            "get_default_hermes_root",
            "get_hermes_home",
            "named_profile_is_deleted",
            "reset_hermes_home_override",
            "set_hermes_home_override",
        ),
        "hermes_cli": (),
    },
    "models and keys": {
        "hermes_cli.auth": ("PROVIDER_REGISTRY", "has_usable_secret"),
        "hermes_cli.config": ("custom_endpoint_key_env", "load_config", "load_env", "read_user_config_raw", "remove_env_value", "save_env_value"),
        "hermes_cli.credential_lifecycle": ("remove_provider_env_credential", "save_provider_env_credential"),
        "hermes_cli.inventory": ("build_model_options_payload", "load_picker_context"),
        "hermes_cli.runtime_provider": ("resolve_runtime_provider",),
        "hermes_cli.web_models": ("CustomEndpointUpdate", "ModelAssignment"),
        "hermes_cli.web_routers.config_env": ("upsert_custom_endpoint", "validate_custom_endpoint"),
        "hermes_cli.web_routers.models": ("get_recommended_default_model", "set_model_assignment"),
        "agent.auxiliary_client": ("call_llm",),
        "agent.model_metadata": ("is_local_endpoint",),
    },
    "identity and memory": {
        "hermes_cli.default_soul": ("DEFAULT_SOUL_MD", "_normalize_soul", "is_legacy_template_soul"),
        "tools.memory_tool": ("ENTRY_DELIMITER", "load_on_disk_store"),
        "tools.threat_patterns": ("scan_for_threats",),
        "agent.prompt_builder": ("_get_context_file_max_chars",),
        "utils": ("atomic_write_text",),
    },
    "fleet": {
        "hermes_cli.profiles": ("create_profile", "export_profile", "import_profile", "launch_model_seed"),
    },
    "routines": {
        "cron.jobs": (
            "use_cron_store",
            "list_jobs",
            "get_job",
            "create_job",
            "update_job",
            "pause_job",
            "resume_job",
            "remove_job",
            "trigger_job",
            "_job_output_dir",
        ),
    },
    "voice": {
        "tools.tts_tool": ("_get_provider", "_load_tts_config", "text_to_speech_tool"),
        "tools.tts_command_provider": ("BUILTIN_TTS_PROVIDERS",),
        "agent.tts_registry": ("get_provider",),
        "tools.voice_mode": ("transcribe_recording",),
        "tools.transcription_tools": ("_get_provider", "_load_stt_config", "is_stt_enabled"),
    },
    "tool settings": {
        "hermes_cli.tools_config": ("TOOL_CATEGORIES", "get_nous_subscription_features"),
        "hermes_cli.tools_config_providers": (
            "STT_MODEL_CATALOG",
            "STT_MODEL_CONFIG_KEY|_STT_MODEL_CONFIG_KEY",
            "_visible_providers",
            "provider_readiness_status",
        ),
        "tools.tool_backend_helpers": ("resolve_provider_secret",),
    },
    "background work": {
        "tools.async_delegation": ("list_async_delegations",),
    },
    "critical facts": {
        # The plugin API behind ctx.register_system_prompt_section (the owner's facts in each conversation).
        "hermes_cli.plugins_dispatch": ("PluginSystemPromptSection",),
    },
    "images and web search": {
        "hermes_cli.tools_config": (
            "TOOL_CATEGORIES",
            "IMAGEGEN_BACKENDS",
            "_is_provider_active",
            "_plugin_image_gen_catalog",
            "_visible_providers",
            "apply_provider_selection",
            "get_nous_subscription_features",
            "provider_readiness_status",
            "web_provider_capabilities",
        ),
        "hermes_cli.config": ("get_env_value", "load_config", "save_config"),
        "tools.web_tools": ("_get_extract_backend", "_get_search_backend"),
        "tools.registry": ("registry",),
    },
    "bot looks": {
        # Bot Mode's ui_meta writer (per-key compare-and-swap, 64 KB cap, atomic write), and what its body uses.
        "tui_gateway.methods_profiles": ("_configure_ui_meta",),
        "utils": ("atomic_yaml_write",),
        "hermes_yaml": (),
        # Pets: the petdex gallery, the per-profile store, its frame geometry, and `display.pet` in config.yaml.
        "agent.pet.manifest": ("fetch_manifest",),
        "agent.pet.store": ("install_pet", "thumbnail_png"),
        "agent.pet.constants": ("FRAME_W", "FRAME_H", "FRAMES_PER_STATE", "LOOP_MS", "state_rows_for_grid"),
        "hermes_cli.pets": ("_set_active", "_set_enabled"),
        # Portraits: the chief's image generator, the same tool Settings → Tools tests.
        "tools.registry": ("registry",),
    },
}


class HermesMissing(RuntimeError):
    """A part of Hermes the bridge needs isn't there (an upstream change)."""


_warned: set[str] = set()
_lock = threading.Lock()
_result: dict[str, Any] | None = None
_running = False


def get(module: str, name: str = "") -> Any:
    """`module.name` from Hermes, or HermesMissing (logged once as a warning, never a silent None).

    `name` may be "new|old": the first of them the module has."""
    key = f"{module}.{name}" if name else module
    try:
        mod = importlib.import_module(module)
        if not name:
            return mod
        for candidate in name.split("|"):
            if hasattr(mod, candidate):
                return getattr(mod, candidate)
        raise AttributeError(f"module {module!r} has none of {name!r}")
    except Exception as exc:  # ImportError, AttributeError, or an error while importing
        if key not in _warned:
            _warned.add(key)
            logger.warning("chief-dashboard-bridge: Hermes no longer has %s (%s); the feature that needs it is off", key, exc)
        raise HermesMissing(key) from exc


def run_check() -> dict[str, Any]:
    """Import every listed name now; returns {"ok", "missing": [...], "features": {feature: ok}}."""
    missing: list[str] = []
    features: dict[str, bool] = {}
    for feature, modules in CAPABILITIES.items():
        ok = True
        for module, names in modules.items():
            for name in names or ("",):
                try:
                    get(module, name)
                except HermesMissing as exc:
                    ok = False
                    missing.append(f"{exc} ({feature})")
        features[feature] = ok
    return {"ok": not missing, "missing": missing, "features": features}


def check(background: bool = True) -> dict[str, Any]:
    """The cached result, or {"pending": True} while the first check runs in the background."""
    global _result, _running
    with _lock:
        if _result is not None:
            return _result
        if _running:
            return {"pending": True}
        _running = True

    def work():
        global _result, _running
        result = run_check()
        if result["missing"]:
            logger.warning("chief-dashboard-bridge: Hermes compatibility: %d missing: %s", len(result["missing"]), "; ".join(result["missing"]))
        with _lock:
            _result = result
            _running = False

    if background:
        threading.Thread(target=work, name="chief-hermes-check", daemon=True).start()
        return {"pending": True}
    work()
    return _result or {"pending": True}


def reset_for_tests() -> None:
    global _result, _running
    with _lock:
        _result = None
        _running = False
    _warned.clear()
