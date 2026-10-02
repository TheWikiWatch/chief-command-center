"""Model providers (providers.py): catalog shaping, key handling and refusals, against a fake Hermes registry."""

import contextlib
import importlib
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
package = types.ModuleType("test_providers_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(ROOT / "hermes/tests/.runtime/hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
providers = importlib.import_module("test_providers_plugin.providers")

_MISSING = object()


def fake_module(test: unittest.TestCase, name: str, **attrs) -> types.ModuleType:
    """Put a fake Hermes module in sys.modules for one test; whatever was there comes back afterwards."""
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    old = sys.modules.get(name, _MISSING)
    sys.modules[name] = module

    def restore():
        if old is _MISSING:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = old

    test.addCleanup(restore)
    return module


KEY_REG = types.SimpleNamespace(auth_type="api_key", api_key_env_vars=("NOVA_API_KEY", "NOVA_OLD_KEY"))
OAUTH_REG = types.SimpleNamespace(auth_type="oauth_device_code", api_key_env_vars=())


class ProviderTestCase(unittest.TestCase):
    def setUp(self):
        scope = patch.object(providers, "chief_config_scope", contextlib.nullcontext)
        scope.start()
        self.addCleanup(scope.stop)
        self.env = {"NOVA_API_KEY": "synthetic-saved-value", "BLANK_API_KEY": "   "}
        self.config = {"model": {"provider": "orbit", "default": "orbit-large"}}
        self.saved: list[tuple[str, str]] = []
        self.removed: list[str] = []
        fake_module(self, "hermes_cli")
        fake_module(self, "hermes_cli.auth", PROVIDER_REGISTRY={"nova": KEY_REG, "orbit": OAUTH_REG}, has_usable_secret=lambda k: len(k) >= 8)
        fake_module(self, "hermes_cli.config", load_env=lambda: dict(self.env), load_config=lambda: self.config)
        fake_module(
            self,
            "hermes_cli.credential_lifecycle",
            save_provider_env_credential=lambda name, value: self.saved.append((name, value)),
            remove_provider_env_credential=lambda name: self.removed.append(name),
        )


class CatalogTests(ProviderTestCase):
    def setUp(self):
        super().setUp()
        self.payload = {
            "provider": "nova",
            "model": "nova-small",
            "providers": [
                {
                    "slug": "nova",
                    "name": "Nova AI",
                    "authenticated": True,
                    "is_current": True,
                    "models": [f"nova-{i}" for i in range(300)],
                    "featured_models": [f"nova-{i}" for i in range(20)],
                },
                {"slug": "orbit", "name": "Orbit", "authenticated": False, "models": ["orbit-large"]},
                {"slug": "custom", "name": "My box", "is_user_defined": True, "authenticated": True, "models": ["local-7b"]},
                {"slug": "openrouter", "authenticated": False},
                {"slug": "moa", "name": "Mixture"},
                "not a row",
            ],
        }
        self.refresh_seen: list[bool] = []

        def build(_ctx, include_unconfigured, refresh):
            self.assertTrue(include_unconfigured)
            self.refresh_seen.append(refresh)
            return self.payload

        fake_module(self, "hermes_cli.inventory", build_model_options_payload=build, load_picker_context=lambda: {})
        status = patch.object(providers, "status", return_value={"ready": True, "provider": "nova", "model": "nova-small", "error": ""})
        status.start()
        self.addCleanup(status.stop)

    def test_rows_are_shaped_for_the_dashboard(self):
        result = providers.catalog()
        self.assertEqual(result["contract"], providers.CONTRACT)
        self.assertEqual((result["provider"], result["model"]), ("nova", "nova-small"))
        rows = {r["slug"]: r for r in result["providers"]}
        self.assertEqual(list(rows), ["nova", "orbit", "custom", "openrouter"], "moa and non-dict rows are left out")
        nova = rows["nova"]
        self.assertEqual((nova["kind"], nova["authType"], nova["keyEnv"]), ("key", "api_key", "NOVA_API_KEY"))
        self.assertTrue(nova["connected"] and nova["current"])
        self.assertEqual(len(nova["models"]), 200)
        self.assertEqual(len(nova["featured"]), 12)
        self.assertEqual(rows["orbit"]["kind"], "external")
        self.assertEqual(rows["orbit"]["keyEnv"], "")
        self.assertEqual(rows["custom"]["kind"], "custom")
        self.assertEqual(rows["openrouter"]["name"], "openrouter")
        self.assertEqual((rows["openrouter"]["kind"], rows["openrouter"]["keyEnv"]), ("key", "OPENROUTER_API_KEY"))

    def test_key_saved_reports_names_only_never_values(self):
        result = providers.catalog()
        rows = {r["slug"]: r for r in result["providers"]}
        self.assertTrue(rows["nova"]["keySaved"])
        self.assertFalse(rows["openrouter"]["keySaved"])
        self.assertFalse(rows["orbit"]["keySaved"])
        self.assertNotIn("synthetic-saved-value", json.dumps(result))

    def test_refresh_is_passed_through(self):
        providers.catalog(refresh=True)
        providers.catalog()
        self.assertEqual(self.refresh_seen, [True, False])

    def test_provider_models_and_unknown_slug(self):
        with patch.object(providers, "recommended_model", return_value="nova-3"):
            found = providers.provider_models("nova")
        self.assertTrue(found["ok"])
        self.assertEqual(found["recommended"], "nova-3")
        self.assertEqual(len(found["featured"]), 12)
        self.assertEqual(providers.provider_models("ghost"), {"ok": False, "error": "Unknown provider."})

    def test_connected_models_lists_connected_providers_current_first(self):
        self.payload["providers"].append(
            {"slug": "aurora", "name": "Aurora", "auth_type": "api_key", "key_env": "AURORA_KEY", "authenticated": True, "featured_models": ["aurora-1"]}
        )
        self.payload["providers"].append({"slug": "empty", "name": "Empty", "auth_type": "api_key", "key_env": "EMPTY_KEY", "authenticated": True})
        result = providers.connected_models()
        self.assertEqual(result["current"], {"provider": "nova", "model": "nova-small"})
        self.assertEqual([g["provider"] for g in result["groups"]], ["nova", "aurora", "custom"])
        aurora = next(g for g in result["groups"] if g["provider"] == "aurora")
        self.assertEqual(aurora["models"], ["aurora-1"], "featured models stand in when no full list is known")


class KeyTests(ProviderTestCase):
    def test_save_key_refuses_bad_input_before_touching_hermes(self):
        long_key = "k" * 4097
        cases = [
            ("../nova", "abc12345", "Unknown provider."),
            ("", "abc12345", "Unknown provider."),
            ("orbit", "abc12345", "This provider isn't set up with a key."),
            ("ghost", "abc12345", "This provider isn't set up with a key."),
            ("nova", "", "That doesn't look like an API key."),
            ("nova", "two words", "That doesn't look like an API key."),
            ("nova", long_key, "That doesn't look like an API key."),
        ]
        for slug, key, error in cases:
            with self.subTest(slug=slug, key=key[:12]):
                self.assertEqual(providers.save_key(slug, key), {"ok": False, "error": error})
        self.assertEqual(self.saved, [])

    def test_save_key_writes_the_first_variable_and_never_echoes_the_key(self):
        result = providers.save_key("  Nova ", "  synthetic-key-123  ")
        self.assertEqual(result, {"ok": True, "provider": "nova"})
        self.assertEqual(self.saved, [("NOVA_API_KEY", "synthetic-key-123")])

    def test_unregistered_openrouter_uses_its_known_variable(self):
        self.assertTrue(providers.save_key("openrouter", "synthetic-key-123")["ok"])
        self.assertEqual(self.saved, [("OPENROUTER_API_KEY", "synthetic-key-123")])

    def test_remove_key_refuses_the_chiefs_own_provider(self):
        self.config = {"model": {"provider": "Nova", "default": "nova-small"}}
        result = providers.remove_key("nova")
        self.assertEqual(result["code"], "in_use")
        self.assertEqual(self.removed, [])

    def test_remove_key_refuses_a_key_the_app_did_not_store(self):
        self.env = {}
        result = providers.remove_key("nova")
        self.assertEqual(result["code"], "not_saved")
        self.assertEqual(self.removed, [])

    def test_remove_key_forgets_a_stored_key(self):
        self.assertEqual(providers.remove_key("nova"), {"ok": True, "provider": "nova"})
        self.assertEqual(self.removed, ["NOVA_API_KEY"])

    def test_remove_key_refuses_providers_without_a_key(self):
        for slug in ("orbit", "../x", ""):
            with self.subTest(slug=slug):
                self.assertFalse(providers.remove_key(slug)["ok"])
        self.assertEqual(self.removed, [])

    def test_key_env_falls_back_to_the_rows_own_variable(self):
        self.assertEqual(providers._key_env("zephyr", {"auth_type": "api_key", "key_env": "ZEPHYR_KEY"}), "ZEPHYR_KEY")
        self.assertEqual(providers._key_env("zephyr", {"auth_type": "oauth", "key_env": "ZEPHYR_KEY"}), "")
        self.assertEqual(providers._key_env("orbit"), "")


class StatusTests(ProviderTestCase):
    def runtime(self, **resolved):
        fake_module(self, "hermes_cli.runtime_provider", resolve_runtime_provider=lambda requested, target_model: resolved)

    def test_no_model_chosen(self):
        self.config = {}
        self.assertEqual(providers.status()["error"], "No model is chosen yet.")
        self.config = {"model": "not a mapping"}
        self.assertFalse(providers.status()["ready"])

    def test_a_usable_key_is_ready(self):
        self.runtime(api_key="synthetic-long-key")
        self.assertEqual(providers.status(), {"ready": True, "provider": "orbit", "model": "orbit-large", "error": ""})

    def test_a_short_key_is_not_usable(self):
        self.runtime(api_key="short")
        result = providers.status()
        self.assertFalse(result["ready"])
        self.assertEqual(result["error"], "No usable credentials for orbit.")

    def test_keyless_runtimes_are_ready(self):
        for resolved in ({"api_key": lambda: "token"}, {"api_key": "no-key-required"}, {"api_key": "aws-sdk"}, {"api_key": "", "command": "orbit-cli"}):
            with self.subTest(resolved=sorted(resolved)):
                self.runtime(**resolved)
                self.assertTrue(providers.status()["ready"])

    def test_a_local_endpoint_needs_no_key(self):
        self.runtime(api_key="", base_url="http://127.0.0.1:11434/v1")
        fake_module(self, "agent")
        fake_module(self, "agent.model_metadata", is_local_endpoint=lambda url: "127.0.0.1" in url)
        self.assertTrue(providers.status()["ready"])

    def test_a_failing_resolver_hides_secrets_in_its_error(self):
        def boom(requested, target_model):
            raise RuntimeError("bad credentials sk-abcdefghijklmnopqrstuv\nsecond line")

        fake_module(self, "hermes_cli.runtime_provider", resolve_runtime_provider=boom)
        result = providers.status()
        self.assertFalse(result["ready"])
        self.assertEqual(result["error"], "bad credentials [hidden]")


class ChooseModelTests(ProviderTestCase):
    def setUp(self):
        super().setUp()
        self.answer: dict = {"ok": True}
        self.bodies: list = []

        class Assignment:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)

        async def assign(body):
            self.bodies.append(body)
            return self.answer

        fake_module(self, "hermes_cli.web_models", ModelAssignment=Assignment)
        fake_module(self, "hermes_cli.web_routers")
        fake_module(self, "hermes_cli.web_routers.models", set_model_assignment=assign)
        status = patch.object(providers, "status", return_value={"ready": True})
        status.start()
        self.addCleanup(status.stop)

    def test_refuses_missing_or_oversized_choices(self):
        for slug, model in (("", "m"), ("nova", ""), ("nova", "m" * 201), ("bad slug", "m")):
            with self.subTest(slug=slug, model=model[:10]):
                self.assertEqual(providers.choose_model(slug, model), {"ok": False, "error": "Choose a provider and a model."})
        self.assertEqual(self.bodies, [])

    def test_a_good_choice_goes_through_hermes_main_scope(self):
        result = providers.choose_model("nova", "nova-small")
        self.assertEqual(result, {"ok": True, "provider": "nova", "model": "nova-small", "status": {"ready": True}})
        body = self.bodies[0]
        self.assertEqual((body.scope, body.provider, body.model, body.confirm_expensive_model), ("main", "nova", "nova-small", False))

    def test_the_expensive_model_guard_asks_first(self):
        self.answer = {"confirm_required": True, "confirm_message": "Nova Max costs a lot. Continue?"}
        self.assertEqual(providers.choose_model("nova", "nova-max"), {"ok": False, "confirm": "Nova Max costs a lot. Continue?"})
        self.answer = {"confirm_required": True}
        self.assertIn("expensive", providers.choose_model("nova", "nova-max")["confirm"])

    def test_hermes_refusal_is_reported(self):
        self.answer = {"ok": False, "detail": "Unknown model."}
        self.assertEqual(providers.choose_model("nova", "nova-ghost"), {"ok": False, "error": "Unknown model."})

    def test_another_profile_gets_no_chief_status(self):
        with patch.object(providers, "_scope", return_value=contextlib.nullcontext()) as scope:
            result = providers.choose_model("nova", "nova-small", home=Path("worker-home"))
        scope.assert_called_once_with(Path("worker-home"))
        self.assertNotIn("status", result)


class EndpointAndErrorTests(ProviderTestCase):
    def test_check_endpoint_needs_an_http_address(self):
        for url in ("", "localhost:11434", "ftp://box/v1", "http:// spaced"):
            with self.subTest(url=url):
                result = providers.check_endpoint(url)
                self.assertFalse(result["ok"] or result["reachable"])

    def test_save_endpoint_needs_both_parts(self):
        self.assertFalse(providers.save_endpoint("Box", "http://127.0.0.1:1234/v1", "")["ok"])
        self.assertFalse(providers.save_endpoint("Box", "", "local-7b")["ok"])

    def test_test_message_needs_a_model(self):
        with patch.object(providers, "status", return_value={"ready": False, "provider": "", "model": ""}):
            self.assertEqual(providers.test_message(), {"ok": False, "error": "Choose a model first."})

    def test_failures_are_explained_in_plain_words(self):
        def error(name, **attrs):
            return type(name, (Exception,), attrs)("synthetic")

        cases = [
            (error("APIStatusError", status_code=401), "rejected"),
            (error("PermissionDeniedError"), "rejected"),
            (error("NotFoundError"), "model"),
            (error("APIStatusError", status_code=429), "rate"),
            (error("ReadTimeout"), "timeout"),
            (error("APIConnectionError"), "unreachable"),
            (error("Weird"), "other"),
        ]
        for exc, code in cases:
            with self.subTest(code=code):
                self.assertEqual(providers._explain(exc)["code"], code)

    def test_plain_errors_hide_keys_and_stay_short(self):
        self.assertEqual(providers._plain(RuntimeError("token_abcdefghijklmnop rejected")), "[hidden] rejected")
        self.assertEqual(len(providers._plain(RuntimeError("x" * 1000))), 240)
        self.assertEqual(providers._plain(RuntimeError("")), "RuntimeError")

    def test_reply_text_from_a_choice_or_a_plain_value(self):
        reply = types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=" ready \n"))])
        self.assertEqual(providers._reply_text(reply), "ready")
        self.assertEqual(providers._reply_text("  plain  "), "plain")
        self.assertEqual(providers._reply_text(None), "")


if __name__ == "__main__":
    unittest.main()
