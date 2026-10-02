"""The chat's extras: the chief's open question, notices that aren't replies, and the current step."""
import importlib
import json
import sqlite3
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import test_bridge  # noqa: F401  (sets up the plugin package and Hermes stand-ins)

ROOT = Path(__file__).resolve().parents[2]
data = importlib.import_module("test_bridge_plugin.data")
chat_state = importlib.import_module("test_bridge_plugin.chat_state")
outbox = importlib.import_module("test_bridge_plugin.outbox")


class _Entry:
    def __init__(self, cid, question, choices, multi=False):
        self.clarify_id, self.question, self.choices, self.multi_select = cid, question, choices, multi
        self.event = threading.Event()
        self.response = None


def _fake_clarify(entry):
    """A stand-in for Hermes's tools.clarify_gateway holding one pending entry."""
    mod = types.ModuleType("tools.clarify_gateway")
    mod.get_pending_for_session = lambda sk, include_choice_prompts=False: entry if sk == "session" and not entry.event.is_set() else None

    def resolve(cid, response):
        if cid != entry.clarify_id or entry.event.is_set():
            return False
        entry.response = response
        entry.event.set()
        return True

    mod.resolve_gateway_clarify = resolve
    tools = types.ModuleType("tools")
    tools.clarify_gateway = mod
    return {"tools": tools, "tools.clarify_gateway": mod}


class CronUnwrapTests(unittest.TestCase):
    """Hermes's scheduled-job wrapper (cron/scheduler_delivery.py) becomes a routine name and the answer."""

    WRAPPED = (
        "Cronjob Response: Second Brain: nightly\n"
        "(job_id: a94696753a42)\n"
        "-------------\n\n"
        "Logged three changes to the Inbox.\n\n"
        "To stop or manage this job, send me a new message (e.g. \"stop reminder Second Brain: nightly\")."
    )

    def test_the_answer_and_the_routine(self):
        body, routine = chat_state.unwrap_cron(self.WRAPPED)
        self.assertEqual(body, "Logged three changes to the Inbox.")
        self.assertEqual(routine, {"name": "Second Brain: nightly", "jobId": "a94696753a42"})

    def test_anything_else_is_left_alone(self):
        for text in ("A plain notice.", "Cronjob Response: half a wrapper", self.WRAPPED.replace("(job_id: ", "(id: ")):
            self.assertEqual(chat_state.unwrap_cron(text), (text, None))


class ChatStateTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.home = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        p = patch.object(data, "chief_home", return_value=self.home)
        p.start()
        self.addCleanup(p.stop)
        p2 = patch.object(chat_state, "chief_home", return_value=self.home)
        p2.start()
        self.addCleanup(p2.stop)

    def database(self):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.executescript("""
            CREATE TABLE sessions (id TEXT, session_key TEXT, last_activity_at INTEGER, source TEXT);
            INSERT INTO sessions VALUES ('s', 'session', 1, 'command_center');
            CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT, content TEXT, timestamp TEXT,
                                   tool_calls TEXT, session_id TEXT, active INTEGER);
        """)
        return conn

    # ------------------------------------------------------------------ the question

    def test_an_open_question_is_read_and_answered_with_a_choice(self):
        entry = _Entry("c1", "Which inbox?", ["Gmail (Recommended)", "Outlook"])
        with patch.dict(sys.modules, _fake_clarify(entry)):
            self.assertEqual(chat_state.pending_clarify("session"),
                             {"id": "c1", "question": "Which inbox?", "choices": ["Gmail (Recommended)", "Outlook"], "multi": False})
            self.assertIsNone(chat_state.pending_clarify("other"))
            self.assertEqual(chat_state.resolve_clarify("session", "c1", "Outlook"), {"ok": True})
            self.assertEqual(entry.response, "Outlook")
            self.assertIsNone(chat_state.pending_clarify("session"))
            self.assertEqual(chat_state.resolve_clarify("session", "c1", "Gmail")["code"], "gone")

    def test_own_words_and_multiple_choices(self):
        entry = _Entry("c2", "Which days?", ["Mon", "Tue", "Wed"], multi=True)
        with patch.dict(sys.modules, _fake_clarify(entry)):
            self.assertFalse(chat_state.resolve_clarify("session", "c2", ["Mon", "Fri"])["ok"])
            self.assertFalse(chat_state.resolve_clarify("session", "c2", [])["ok"])
            self.assertTrue(chat_state.resolve_clarify("session", "c2", ["Mon", "Wed"])["ok"])
            self.assertEqual(json.loads(entry.response), ["Mon", "Wed"])
        free = _Entry("c3", "Anything else?", [])
        with patch.dict(sys.modules, _fake_clarify(free)):
            self.assertFalse(chat_state.resolve_clarify("session", "c3", "   ")["ok"])
            self.assertFalse(chat_state.resolve_clarify("session", "c3", ["x"])["ok"])
            self.assertTrue(chat_state.resolve_clarify("session", "c3", "Use the work account")["ok"])
            self.assertEqual(free.response, "Use the work account")

    def test_only_the_open_question_can_be_answered(self):
        entry = _Entry("c4", "Q?", ["A"])
        with patch.dict(sys.modules, _fake_clarify(entry)):
            self.assertEqual(chat_state.resolve_clarify("session", "someone-else", "A")["code"], "gone")
            self.assertFalse(entry.event.is_set())

    def test_a_finished_question_shows_in_the_transcript_with_its_answer(self):
        with self.database() as conn:
            conn.execute("INSERT INTO messages VALUES (1, 'user', 'I want an email bot', '10.0', NULL, 's', 1)")
            conn.execute("INSERT INTO messages VALUES (2, 'assistant', '', '11.0', ?, 's', 1)",
                         (json.dumps([{"function": {"name": "clarify", "arguments": "{}"}}]),))
            conn.execute("INSERT INTO messages VALUES (3, 'tool', ?, '12.0', NULL, 's', 1)",
                         (json.dumps({"question": "Which inbox?", "choices_offered": ["Gmail", "Outlook"], "user_response": "Gmail"}),))
            conn.execute("INSERT INTO messages VALUES (4, 'tool', '{\"ok\": true}', '12.5', NULL, 's', 1)")
            conn.execute("INSERT INTO messages VALUES (5, 'assistant', 'Gmail it is.', '13.0', NULL, 's', 1)")
        rows = data.transcript("session")["messages"]
        asked = [m for m in rows if m.get("asked")]
        self.assertEqual(len(asked), 1)
        self.assertEqual(asked[0]["asked"], [{"question": "Which inbox?", "choices": ["Gmail", "Outlook"], "answer": "Gmail"}])
        self.assertEqual([m["id"] for m in rows], [1, 2, 3, 5])

    def test_batched_and_unanswered_questions(self):
        result = {"responses": [{"question": "A?", "choices_offered": ["x"], "user_response": ["x"]},
                                {"question": "B?", "choices_offered": None, "user_response": ""}], "timed_out": True}
        asked = chat_state.asked_from_tool_row(json.dumps(result))
        self.assertEqual(asked[0]["answer"], ["x"])
        self.assertTrue(asked[1]["unanswered"])
        self.assertEqual(chat_state.asked_from_tool_row('{"ok": true}'), [])
        self.assertEqual(chat_state.asked_from_tool_row("not json"), [])

    # ------------------------------------------------------------------ notices

    def test_notices_are_sends_that_are_not_replies(self):
        with self.database() as conn:
            conn.execute("INSERT INTO messages VALUES (1, 'assistant', ?, '100.0', NULL, 's', 1)",
                         ("Here is the plan:\n\n1. one\n2. two",))
        rows = [
            ("Here is the plan:\n\n1. one\n2. two", "send", 100.1),    # the reply itself
            ("1. one", "send", 100.2),                                 # a piece of the reply
            ("⏳ Working — 3 min — iteration 5, clarify", "send", 150.0),  # busy status: never a notice
            ("Morning brief: 3 tasks due", "cron", 160.0),             # a scheduled job
            ("📬 No home channel is set", "send", 170.0),              # a gateway notice
        ]
        path = outbox._outbox_path()
        path.write_text("".join(json.dumps({"id": f"o{i}", "at": at, "chat_id": "owner", "message": m, "source": src, "read": False}) + "\n"
                                for i, (m, src, at) in enumerate(rows)), encoding="utf-8")
        found = chat_state.notices("session", since=0)
        self.assertEqual([(n["text"], n["source"]) for n in found],
                         [("Morning brief: 3 tasks due", "scheduled"), ("📬 No home channel is set", "notice")])
        self.assertEqual([n["text"] for n in chat_state.notices("session", since=165)], ["📬 No home channel is set"])
        self.assertEqual(chat_state.notice_head(), "o4")

    def test_no_outbox_means_no_notices(self):
        self.assertEqual(chat_state.notices("session"), [])
        self.assertEqual(chat_state.notice_head(), "")

    # ------------------------------------------------------------------ the current step

    def test_steps_in_plain_words(self):
        brain = str(self.home / "brain")
        self.assertEqual(chat_state.step_label("read_file", {"path": str(self.home / "brain" / "Home.md")}, brain), "Reading your Second Brain")
        self.assertEqual(chat_state.step_label("write_file", {"path": str(self.home / "x.txt")}, brain), "Writing a file")
        self.assertEqual(chat_state.step_label("skill_view", {"name": "second-brain"}), "Reading your Second Brain rules")
        self.assertEqual(chat_state.step_label("skill_view", {"name": "fleet-ops"}), "Reading the fleet-ops skill")
        self.assertEqual(chat_state.step_label("kanban_create", {}), "Updating the task board")
        self.assertEqual(chat_state.step_label("fleet_roster", {}), "Checking the team")
        self.assertEqual(chat_state.step_label("mystery_tool", {}), "Using mystery tool")

    def test_a_deferred_call_counts_as_the_tool_it_runs(self):
        calls = json.dumps([{"function": {"name": "tool_call", "arguments": json.dumps({"calls": [{"name": "fleet_roster", "arguments": {}}]})}}])
        self.assertEqual(data._tool_names(calls), ["fleet_roster"])

    def test_activity_follows_the_running_turn(self):
        self.assertIsNone(chat_state.activity("session", generating=False))
        with self.database() as conn:
            conn.execute("INSERT INTO messages VALUES (1, 'user', 'hi', '100.0', NULL, 's', 1)")
            conn.execute("INSERT INTO messages VALUES (2, 'assistant', '', '101.0', ?, 's', 1)",
                         (json.dumps([{"function": {"name": "skill_view", "arguments": json.dumps({"name": "fleet-ops"})}},
                                      {"function": {"name": "skill_view", "arguments": json.dumps({"name": "fleet-builder"})}}]),))
        now = chat_state.activity("session", generating=True)
        self.assertEqual(now["since"], 100.0)
        self.assertEqual(now["steps"], 2)
        self.assertEqual(now["label"], "Reading the fleet-ops skill and more")
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        with conn:
            conn.execute("INSERT INTO messages VALUES (3, 'tool', '{}', '102.0', NULL, 's', 1)")
        self.assertEqual(chat_state.activity("session", generating=True)["label"], "Thinking it over")


    def test_live_steps_come_from_hermes_status_as_tools_start(self):
        display = types.ModuleType("agent.display")
        display.build_status_phrase = lambda tool_name, args, max_len=49: f"is using {tool_name}…"
        agent = types.ModuleType("agent")
        agent.display = display
        chat_state._live.clear()
        with patch.dict(sys.modules, {"agent": agent, "agent.display": display}), patch.object(chat_state, "vault_path", return_value=""):
            self.assertTrue(chat_state.install_status_capture())
            self.assertTrue(chat_state.install_status_capture())  # idempotent: one wrapper
            # Hermes builds the phrase, then hands it to the adapter, on the same thread.
            chat_state.record_status("owner", display.build_status_phrase("fleet_roster", {}))
            chat_state.record_status("owner", None)  # finished: thinking again
            chat_state.record_status("owner", display.build_status_phrase("todo_list", {}))
            # A phrase without a noted tool (another Hermes) is tidied instead.
            chat_state.record_status("owner", "is reading Home.md…")
        with self.database() as conn:
            conn.execute("INSERT INTO messages VALUES (1, 'user', 'hi', '0', NULL, 's', 1)")
        now = chat_state.activity("session", generating=True, chat_id="owner")
        self.assertEqual(now["steps"], 3)
        self.assertEqual(now["label"], "Reading Home.md")
        self.assertEqual([label for _, label in chat_state.live_steps("owner", 0)],
                         ["Checking the team", None, "Planning the steps", "Reading Home.md"])
        chat_state.record_status("owner", None)
        self.assertEqual(chat_state.activity("session", generating=True, chat_id="owner")["label"], "Thinking it over")
        chat_state._live.clear()


class DefaultSoulTests(unittest.TestCase):
    def test_the_shipped_soul_digest_is_recorded(self):
        second_brain = importlib.import_module("test_bridge_plugin.second_brain")
        shipped = (ROOT / "hermes/plugins/chief-dashboard-bridge/second_brain/SOUL.md").read_text(encoding="utf-8")
        self.assertEqual(
            second_brain._soul_digest(shipped), second_brain.CURRENT_DEFAULT_SOUL,
            "second_brain/SOUL.md changed: move CURRENT_DEFAULT_SOUL into _PREVIOUS_DEFAULT_SOULS (so unedited "
            "installs still get the new default) and set CURRENT_DEFAULT_SOUL to the new digest.")
        self.assertNotIn(second_brain.CURRENT_DEFAULT_SOUL, second_brain._PREVIOUS_DEFAULT_SOULS)


if __name__ == "__main__":
    unittest.main()
