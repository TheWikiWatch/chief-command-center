"""Hermes's copies of its node, npm and Python for the chief's terminal (terminal_tools.py): made when the gateway starts."""

import contextlib
import importlib
import os
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
package = types.ModuleType("test_terminal_tools_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(ROOT / "hermes/tests/.runtime/hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
terminal_tools = importlib.import_module("test_terminal_tools_plugin.terminal_tools")
hermes_api = importlib.import_module("test_terminal_tools_plugin.hermes_api")


class WarmTests(unittest.TestCase):
    def test_hermes_makes_them_in_the_background_as_the_chief(self):
        calls = []
        done = threading.Event()
        scope = []

        @contextlib.contextmanager
        def chief_scope():
            scope.append("in")
            yield Path("chief")
            scope.append("out")

        def user_facing_path(path):
            calls.append((path, threading.current_thread().name, list(scope)))
            done.set()
            return path

        with (
            patch.object(terminal_tools, "chief_config_scope", chief_scope),
            patch.object(hermes_api, "get", lambda module, name: user_facing_path),
            patch.dict(os.environ, {"PATH": "C:\\Tools"}),
        ):
            terminal_tools.warm_with_gateway()
            self.assertTrue(done.wait(5))
        self.assertEqual(calls, [("C:\\Tools", "chief-terminal-tools", ["in"])])

    def test_a_hermes_without_them_or_a_failed_copy_leaves_the_gateway_alone(self):
        def missing(module, name):
            raise hermes_api.HermesMissing(f"{module}.{name}")

        def broken(path):
            raise OSError("disk full")

        for get in (missing, lambda module, name: broken):
            with patch.object(hermes_api, "get", get), self.assertNoLogs("chief-dashboard-bridge", level="ERROR"):
                terminal_tools.warm_with_gateway()
                for thread in [t for t in threading.enumerate() if t.name == "chief-terminal-tools"]:
                    thread.join(5)


if __name__ == "__main__":
    unittest.main()
