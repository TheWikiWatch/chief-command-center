"""Threads with the chief (threads.py) over a throwaway profile."""

import importlib
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_bridge  # noqa: F401  (sets up the plugin package and Hermes stand-ins)

ROOT = Path(__file__).resolve().parents[2]
data = importlib.import_module("test_bridge_plugin.data")
threads = importlib.import_module("test_bridge_plugin.threads")


class ThreadTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        p = patch.object(threads, "chief_home", return_value=self.home)
        p.start()
        self.addCleanup(p.stop)

    def sessions(self, rows):
        conn = sqlite3.connect(self.home / "state.db")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (id TEXT, session_key TEXT, title TEXT, started_at REAL, ended_at REAL, last_activity_at REAL, message_count INT)"
        )
        conn.executemany("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)", rows)
        conn.commit()
        conn.close()

    def test_each_thread_is_its_own_chat_and_session(self):
        self.assertEqual(threads.chat_id("main"), "owner")
        self.assertEqual(threads.session_key("main"), "agent:main:command_center:dm:owner")
        self.assertEqual(threads.chat_id("t-0a1b2c3d"), "owner.t-0a1b2c3d")
        self.assertEqual(threads.session_key("t-0a1b2c3d"), "agent:main:command_center:dm:owner.t-0a1b2c3d")
        self.assertEqual(threads.thread_of("owner.t-0a1b2c3d"), "t-0a1b2c3d")
        self.assertEqual(threads.thread_of("owner"), "main")
        self.assertEqual(threads.thread_of("owner.t-zz"), "main")
        self.assertFalse(threads.valid("../x"))

    def test_create_rename_archive_and_list(self):
        made = threads.create("Trip planning")["thread"]
        self.assertTrue(threads.exists(made["id"]))
        other = threads.create()["thread"]
        self.assertEqual(other["title"], "New thread")
        listed = threads.list_threads(busy=lambda key: key.endswith(made["id"]))["threads"]
        self.assertEqual(listed[0]["id"], "main")
        self.assertEqual({t["id"]: t["working"] for t in listed}[made["id"]], True)
        # The snapshot's flag, from the busy check alone (the main thread doesn't count).
        self.assertTrue(threads.any_working(lambda key: key.endswith(made["id"])))
        self.assertFalse(threads.any_working(lambda key: key.endswith(":owner")))
        self.assertEqual(threads.rename(made["id"], "Trip to Lisbon")["thread"]["title"], "Trip to Lisbon")
        self.assertTrue(threads.archive(made["id"])["thread"]["archived"])
        self.assertFalse(threads.archive(made["id"], False)["thread"]["archived"])
        with self.assertRaises(threads.ThreadError):
            threads.archive("main")
        with self.assertRaises(threads.ThreadError):
            threads.rename("t-ffffffff", "x")
        with self.assertRaises(threads.ThreadError):
            threads.create("x" * 61)
        self.assertEqual(threads.rename("main", "Everyday")["thread"]["title"], "Everyday")

    def test_titles_and_earlier_conversations_come_from_hermes_sessions(self):
        made = threads.create()["thread"]
        key = threads.session_key(made["id"])
        self.sessions(
            [
                ("s-old", key, "Packing list", 100.0, 150.0, 150.0, 12),
                ("s-new", key, "Flights to Lisbon", 200.0, None, 260.0, 4),
                ("s-empty", key, "", 50.0, 60.0, 60.0, 0),
            ]
        )
        listed = {t["id"]: t for t in threads.list_threads()["threads"]}
        self.assertEqual(listed[made["id"]]["title"], "Flights to Lisbon")  # Hermes's title for the latest session
        self.assertEqual(listed[made["id"]]["lastActivity"], 260.0)
        previous = threads.previous_sessions(made["id"])
        self.assertEqual([p["id"] for p in previous], ["s-old"])  # empty sessions are not conversations
        self.assertEqual(previous[0]["title"], "Packing list")


if __name__ == "__main__":
    unittest.main()
