"""The change signal, its watcher and the incremental outbox. No Hermes process."""
import importlib
import json
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
package = types.ModuleType("test_changes_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(ROOT / "hermes/tests/.runtime/hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
changes = importlib.import_module("test_changes_plugin.changes")
outbox = importlib.import_module("test_changes_plugin.outbox")


def wait_for(pred, seconds=3.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.05)
    return pred()


class SignalTests(unittest.TestCase):
    def test_wait_returns_at_once_on_a_bump_and_times_out_without_one(self):
        start = changes.version()
        threading.Timer(0.1, changes.bump).start()
        t0 = time.monotonic()
        self.assertNotEqual(changes.wait(start, 5.0), start)
        self.assertLess(time.monotonic() - t0, 2.0)
        now = changes.version()
        t0 = time.monotonic()
        self.assertEqual(changes.wait(now, 0.2), now)
        self.assertGreaterEqual(time.monotonic() - t0, 0.15)

    def test_watcher_sees_commits_from_another_connection_and_memory_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "state.db"
            writer = sqlite3.connect(db)
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT)")
            writer.commit()
            state = {"working": ()}
            watcher = changes.Watcher(lambda: [db, Path(tmp) / "missing.db"], lambda: state["working"], every=0.05)
            watcher.start()
            try:
                time.sleep(0.2)  # first look: remembers the current versions, no bump
                before = changes.version()
                writer.execute("INSERT INTO messages (content) VALUES ('a reply')")
                writer.commit()
                self.assertTrue(wait_for(lambda: changes.version() != before), "a commit wakes waiters")
                before = changes.version()
                state["working"] = ("agent:main:command_center:dm:owner",)
                self.assertTrue(wait_for(lambda: changes.version() != before), "a session starting work wakes waiters")
            finally:
                watcher.stop()
                writer.close()


class OutboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "command_center_outbox.jsonl"
        patcher = patch.object(outbox, "_outbox_path", return_value=self.path)
        patcher.start()
        self.addCleanup(patcher.stop)
        outbox._cache.update(path="", offset=0, rows=[], times=[])

    def test_appends_are_read_incrementally_and_wake_waiters(self):
        before = changes.version()
        first = outbox.append_outbox("owner", "one")
        self.assertNotEqual(changes.version(), before)
        self.assertEqual([r["id"] for r in outbox.read_outbox()], [first])
        second = outbox.append_outbox("owner", "two")
        self.assertEqual(outbox.head_id(), second)
        self.assertEqual([r["message"] for r in outbox.read_outbox(after_id=first)], ["two"])
        # A row another process is still writing (no newline yet) waits for the next read.
        with open(self.path, "a", encoding="utf-8") as f:
            f.write('{"id": "partial", "at": 1')
        self.assertEqual(outbox.head_id(), second)

    def test_an_unknown_id_gives_nothing(self):
        outbox.append_outbox("owner", "one")
        self.assertEqual(outbox.read_outbox(after_id="gone"), [])

    def test_read_since_and_compaction_keep_recent_rows(self):
        now = time.time()
        old = [{"id": f"o{i}", "at": now - 40 * 86400 + i, "chat_id": "owner", "message": f"old {i}", "source": "adapter", "read": False} for i in range(600)]
        new = [{"id": f"n{i}", "at": now - 60 + i, "chat_id": "owner", "message": f"new {i}", "source": "adapter", "read": False} for i in range(5)]
        self.path.write_text("".join(json.dumps(r) + "\n" for r in old + new), encoding="utf-8")
        self.assertEqual([r["id"] for r in outbox.read_since(now - 120)], [f"n{i}" for i in range(5)])
        dropped = outbox.compact(now)
        kept = outbox.read_outbox(limit=10_000)
        # Older than 30 days goes, but never below the newest 500 rows.
        self.assertEqual(len(kept), outbox.KEEP_MIN_ROWS)
        self.assertEqual(dropped, 605 - outbox.KEEP_MIN_ROWS)
        self.assertEqual(kept[-1]["id"], "n4")
        self.assertEqual(outbox.read_since(now - 120)[0]["id"], "n0")


if __name__ == "__main__":
    unittest.main()
