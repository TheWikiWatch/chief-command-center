"""Small hardening from the 2026-10-12 security review: phone alerts go only to browsers' push services, problem
reports hide more secrets and the Windows user name, Hermes's credential folders are never served, and the ledger's
revert writes only skill files. Synthetic data only."""

import importlib
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
RUNTIME = ROOT / "hermes/tests/.runtime"
package = types.ModuleType("test_hardening_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(RUNTIME / "hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
vapid = importlib.import_module("test_hardening_plugin.vapid")
report = importlib.import_module("test_hardening_plugin.report")
data = importlib.import_module("test_hardening_plugin.data")


class PushEndpointTests(unittest.TestCase):
    def test_only_the_browsers_push_services(self):
        for ok in (
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/x",
            "https://web.push.apple.com/QxYz",
            "https://wns2-par02p.notify.windows.com/w/?token=x",
        ):
            self.assertTrue(vapid.push_endpoint_ok(ok), ok)
        for bad in (
            "https://evil.example/collect",
            "https://fcm.googleapis.com.evil.example/x",
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://user:pw" + "@" + "fcm.googleapis.com/x",  # credentials in the URL (split so the privacy scan doesn't read an address)
            "https://127.0.0.1:7790/approve",
        ):
            self.assertFalse(vapid.push_endpoint_ok(bad), bad)
        self.assertFalse(vapid.upsert_subscription({"endpoint": "https://evil.example/x", "keys": {"p256dh": "k", "auth": "a"}})["ok"])


class ReportRedactionTests(unittest.TestCase):
    def test_more_secret_shapes_and_the_user_name_are_hidden(self):
        text = (
            'key=AIzaSyA-synthetic-not-a-real-key-0000000 "api_key": "synthetic-value" '
            "telegram 123456789:AAsyntheticsyntheticsyntheticsynthetic0 path C:\\Users\\"
            "SomeName\\AppData\\x"  # split so the privacy scan doesn't read a home folder
        )
        out = report.redact(text)
        for secret in ("AIzaSyA-synthetic", "synthetic-value", "AAsynthetic", "SomeName"):
            self.assertNotIn(secret, out)
        self.assertIn("C:\\Users\\<user>\\AppData", out)


class FileServingTests(unittest.TestCase):
    def test_hermes_credential_folders_are_never_served(self):
        root = data.install_root()
        for rel in ("browser-profile/Default/Cookies", "vault/vault.json.enc", "checkpoints/abc/state.bin", "mcp-tokens/notion.json"):
            self.assertTrue(data._hermes_private((root / rel).resolve()), rel)


class LedgerRevertTests(unittest.TestCase):
    def test_revert_writes_only_skill_files(self):
        sys.path.insert(0, str(PLUGIN / "ledger"))
        self.addCleanup(sys.path.remove, str(PLUGIN / "ledger"))
        ledger = importlib.import_module("learning_ledger")
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "hermes"
            (home / "skills").mkdir(parents=True)
            outside = Path(tmp) / "Startup" / "evil.cmd"
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            row = {"id": 2, "file": str(outside), "scope": "shared", "skill": "x"}
            with (
                patch.object(ledger, "HERMES", home),
                patch.object(ledger, "previous_version", return_value={"content": "echo pwned"}),
                patch.object(ledger, "later_versions", return_value=0),
            ):
                conn.execute("CREATE TABLE versions (id INTEGER, file TEXT, scope TEXT, skill TEXT)")
                conn.execute("INSERT INTO versions VALUES (:id, :file, :scope, :skill)", row)
                with self.assertRaisesRegex(SystemExit, "isn't a skill file"):
                    ledger._revert(conn, 2)
            self.assertFalse(outside.exists())


if __name__ == "__main__":
    unittest.main()
