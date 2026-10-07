"""The Hermes capability list: complete for what the plugin imports, and honest about what's missing."""

import ast
import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
package = types.ModuleType("test_hermes_api_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
hermes_api = importlib.import_module("test_hermes_api_plugin.hermes_api")

HERMES_ROOTS = {"hermes_cli", "hermes_constants", "tools", "gateway", "agent", "cron", "run_agent", "model_tools", "toolsets", "utils"}


def plugin_imports():
    found = set()
    for path in PLUGIN.rglob("*.py"):
        if "ledger" in path.parts:  # a separate program with its own imports
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ImportFrom) and node.module and node.level == 0 and node.module.split(".")[0] in HERMES_ROOTS:
                found.update((node.module, alias.name, path.name) for alias in node.names)
            elif isinstance(node, ast.Import):
                found.update((alias.name, "", path.name) for alias in node.names if alias.name.split(".")[0] in HERMES_ROOTS)
    return found


class CapabilityListTests(unittest.TestCase):
    def test_every_hermes_import_in_the_plugin_is_listed(self):
        listed = {(module, name) for modules in hermes_api.CAPABILITIES.values() for module, names in modules.items() for name in (names or ("",))}
        listed_modules = {module for module, _ in listed}
        unlisted = []
        for module, name, where in sorted(plugin_imports()):
            # `from tools import approval` imports a module: listed as "tools.approval".
            if (module, name) in listed or f"{module}.{name}" in listed_modules or (not name and module in listed_modules):
                continue
            unlisted.append(f"{where}: from {module} import {name}")
        self.assertEqual(unlisted, [], "add these to hermes_api.CAPABILITIES")

    def test_a_new_or_old_name_resolves_to_whichever_this_hermes_has(self):
        old = types.ModuleType("hermes_api_fake_old")
        old._KEY = {"elevenlabs": "model_id"}
        new = types.ModuleType("hermes_api_fake_new")
        new.KEY = {"elevenlabs": "model_id", "mistral": "model"}
        new._KEY = {"stale": True}
        sys.modules.update({old.__name__: old, new.__name__: new})
        try:
            self.assertIs(hermes_api.get(old.__name__, "KEY|_KEY"), old._KEY)
            self.assertIs(hermes_api.get(new.__name__, "KEY|_KEY"), new.KEY)  # the first listed wins
            with self.assertLogs("chief-dashboard-bridge", level="WARNING"), self.assertRaises(hermes_api.HermesMissing):
                hermes_api.get(old.__name__, "GONE|_GONE")
        finally:
            for name in (old.__name__, new.__name__):
                sys.modules.pop(name, None)
            hermes_api.reset_for_tests()

    def test_missing_names_are_reported_by_feature_and_raised_not_returned_as_none(self):
        fake = types.ModuleType("tools.approval")
        fake.get_pending_gateway_approval = lambda key: None  # the other two are "gone upstream"
        saved = {name: sys.modules.get(name) for name in ("tools", "tools.approval")}
        sys.modules["tools"] = types.ModuleType("tools")
        sys.modules["tools.approval"] = fake
        try:
            hermes_api.reset_for_tests()
            with self.assertRaises(hermes_api.HermesMissing):
                hermes_api.get("tools.approval", "resolve_gateway_approval")
            with self.assertLogs("chief-dashboard-bridge", level="WARNING"):
                result = hermes_api.check(background=False)
            self.assertFalse(result["ok"])
            self.assertFalse(result["features"]["approvals"])
            self.assertIn("tools.approval.list_gateway_approvals (approvals)", result["missing"])
            self.assertNotIn("tools.approval.get_pending_gateway_approval (approvals)", result["missing"])
            self.assertIs(hermes_api.check(), result)  # cached
        finally:
            for name, mod in saved.items():
                if mod is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = mod
            hermes_api.reset_for_tests()


if __name__ == "__main__":
    unittest.main()
