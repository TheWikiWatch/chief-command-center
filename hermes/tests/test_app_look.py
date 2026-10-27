"""The app's look (app_look.py): one stored accent and mode for every window, the bots' set_app_look tool, Undo."""

import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_bridge  # noqa: F401  (sets up the plugin package and Hermes stand-ins)

app_look = importlib.import_module("test_bridge_plugin.app_look")
identity = importlib.import_module("test_bridge_plugin.identity")


class AppLookTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.announced = []
        for p in (
            patch.object(app_look, "chief_home", lambda: self.home),
            patch.object(app_look, "_announce", lambda: self.announced.append(1)),
            patch.object(identity, "assistant_name", lambda ttl=30.0: "Chief"),
        ):
            p.start()
            self.addCleanup(p.stop)

    def test_the_default_is_the_apps_own_dark_red(self):
        look = app_look.get()
        self.assertEqual((look["accent"], look["mode"], look["by"], look["canUndo"]), ("theme", "dark", "owner", False))

    def test_the_chief_changes_it_and_the_owner_undoes_it(self):
        result = json.loads(app_look.tool_handler({"accent": "Violet", "mode": "light"}))
        self.assertEqual(result["applied"], {"accent": "violet", "mode": "light"})
        look = app_look.get()
        self.assertEqual((look["accent"], look["mode"], look["by"], look["canUndo"]), ("violet", "light", "Chief", True))
        self.assertEqual(len(self.announced), 1)  # open windows restyle at once
        app_look.undo()
        look = app_look.get()
        self.assertEqual((look["accent"], look["mode"], look["by"]), ("theme", "dark", "owner"))

    def test_a_colour_or_a_mode_alone_and_bad_values_refused(self):
        app_look.set_look("#8B5CF6")
        app_look.set_look(mode="system")
        self.assertEqual((app_look.get()["accent"], app_look.get()["mode"]), ("#8b5cf6", "system"))
        for bad in ({"accent": "plaid"}, {"accent": "#12345"}, {"mode": "sepia"}, {}):
            out = json.loads(app_look.tool_handler(bad))
            self.assertFalse(out["success"], bad)
        self.assertEqual(app_look.call(lambda: app_look.set_look("url(javascript:x)"))[1], 400)

    def test_nothing_changed_announces_nothing_and_a_broken_file_reads_as_default(self):
        app_look.set_look("theme", "dark")
        self.assertEqual(self.announced, [])
        (self.home / "chief_app_look.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(app_look.get()["accent"], "theme")
        (self.home / "chief_app_look.json").write_text(json.dumps({"accent": "</style>", "mode": "neon"}), encoding="utf-8")
        self.assertEqual((app_look.get()["accent"], app_look.get()["mode"]), ("theme", "dark"))

    def test_reset_is_the_default_again(self):
        app_look.set_look("pink", "light")
        app_look.reset()
        self.assertEqual((app_look.get()["accent"], app_look.get()["mode"]), ("theme", "dark"))

    def test_a_look_that_couldnt_be_saved_is_a_plain_error(self):
        with patch.object(app_look, "chief_home", lambda: self.home / "gone"), self.assertLogs("chief-dashboard-bridge", level="WARNING"):
            answer = app_look.call(lambda: app_look.set_look("pink"))
        self.assertEqual(answer, ({"ok": False, "error": "Couldn't save the look. Try again."}, 500))


if __name__ == "__main__":
    unittest.main()
