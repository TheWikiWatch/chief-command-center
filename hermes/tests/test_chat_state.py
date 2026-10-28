"""The chat's extras: the chief's open question, notices that aren't replies, and the current step."""

import asyncio
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
        'To stop or manage this job, send me a new message (e.g. "stop reminder Second Brain: nightly").'
    )

    def test_the_answer_and_the_routine(self):
        body, routine = chat_state.unwrap_cron(self.WRAPPED)
        self.assertEqual(body, "Logged three changes to the Inbox.")
        self.assertEqual(routine, {"name": "Second Brain: nightly", "jobId": "a94696753a42", "profile": "chief"})

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

    def test_the_chat_apps_skip_line_stays_out_of_the_question(self):
        # Hermes 0.22 appends it for chat apps, in the owner's language; the card answers its own way.
        self.assertEqual(chat_state._without_skip_hint('Which colour?\nReply "skip" to skip this question.'), "Which colour?")
        self.assertEqual(chat_state._without_skip_hint("Welche Farbe?\nAntworte mit „skip“, um diese Frage zu überspringen."), "Welche Farbe?")
        self.assertEqual(chat_state._without_skip_hint("Which colour?"), "Which colour?")
        # A question that happens to mention skipping keeps every line.
        self.assertEqual(chat_state._without_skip_hint("Plan the week.\nShould we skip Friday?"), "Plan the week.\nShould we skip Friday?")

    def test_an_open_question_is_read_and_answered_with_a_choice(self):
        entry = _Entry("c1", "Which inbox?", ["Gmail (Recommended)", "Outlook"])
        with patch.dict(sys.modules, _fake_clarify(entry)):
            self.assertEqual(
                chat_state.pending_clarify("session"), {"id": "c1", "question": "Which inbox?", "choices": ["Gmail (Recommended)", "Outlook"], "multi": False}
            )
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
            conn.execute(
                "INSERT INTO messages VALUES (2, 'assistant', '', '11.0', ?, 's', 1)", (json.dumps([{"function": {"name": "clarify", "arguments": "{}"}}]),)
            )
            conn.execute(
                "INSERT INTO messages VALUES (3, 'tool', ?, '12.0', NULL, 's', 1)",
                (json.dumps({"question": "Which inbox?", "choices_offered": ["Gmail", "Outlook"], "user_response": "Gmail"}),),
            )
            conn.execute("INSERT INTO messages VALUES (4, 'tool', '{\"ok\": true}', '12.5', NULL, 's', 1)")
            conn.execute("INSERT INTO messages VALUES (5, 'assistant', 'Gmail it is.', '13.0', NULL, 's', 1)")
        rows = data.transcript("session")["messages"]
        asked = [m for m in rows if m.get("asked")]
        self.assertEqual(len(asked), 1)
        self.assertEqual(asked[0]["asked"], [{"question": "Which inbox?", "choices": ["Gmail", "Outlook"], "answer": "Gmail"}])
        self.assertEqual([m["id"] for m in rows], [1, 2, 3, 5])

    def test_batched_and_unanswered_questions(self):
        result = {
            "responses": [
                {"question": "A?", "choices_offered": ["x"], "user_response": ["x"]},
                {"question": "B?", "choices_offered": None, "user_response": ""},
            ],
            "timed_out": True,
        }
        asked = chat_state.asked_from_tool_row(json.dumps(result))
        self.assertEqual(asked[0]["answer"], ["x"])
        self.assertTrue(asked[1]["unanswered"])
        self.assertEqual(chat_state.asked_from_tool_row('{"ok": true}'), [])
        self.assertEqual(chat_state.asked_from_tool_row("not json"), [])

    # ------------------------------------------------------------------ notices

    def test_notices_are_sends_that_are_not_replies(self):
        with self.database() as conn:
            conn.execute("INSERT INTO messages VALUES (1, 'assistant', ?, '100.0', NULL, 's', 1)", ("Here is the plan:\n\n1. one\n2. two",))
        rows = [
            ("Here is the plan:\n\n1. one\n2. two", "send", 100.1),  # the reply itself
            ("1. one", "send", 100.2),  # a piece of the reply
            ("⏳ Working — 3 min — iteration 5, clarify", "send", 150.0),  # busy status: never a notice
            ("Morning brief: 3 tasks due", "cron", 160.0),  # a scheduled job
            ("📬 No home channel is set", "send", 170.0),  # a gateway notice
        ]
        path = outbox._outbox_path()
        path.write_text(
            "".join(
                json.dumps({"id": f"o{i}", "at": at, "chat_id": "owner", "message": m, "source": src, "read": False}) + "\n"
                for i, (m, src, at) in enumerate(rows)
            ),
            encoding="utf-8",
        )
        found = chat_state.notices("session", since=0)
        self.assertEqual([(n["text"], n["source"]) for n in found], [("Morning brief: 3 tasks due", "scheduled"), ("📬 No home channel is set", "notice")])
        self.assertEqual([n["text"] for n in chat_state.notices("session", since=165)], ["📬 No home channel is set"])
        self.assertEqual(chat_state.notice_head(), "o4")

    def write_outbox(self, *messages: str) -> None:
        outbox._outbox_path().write_text(
            "".join(
                json.dumps({"id": f"o{i}", "at": 100.0 + i, "chat_id": "owner", "message": m, "source": "send", "read": False}) + "\n"
                for i, m in enumerate(messages)
            ),
            encoding="utf-8",
        )

    def test_what_the_app_shows_its_own_way_is_not_a_notice_but_a_refusal_is(self):
        refused = "⏳ Another turn is still running on this session. To protect the transcript, this message was not processed. Wait for the active turn to finish, then resend it."
        self.write_outbox(
            "⏩ Steered into current run (iteration 2). Your message arrives after the next tool call.\n\n💡 First-time tip — Send `/busy interrupt`.",
            "⏩ Steer queued — arrives after the next tool call: 'x'",
            "⏳ Queued for the next turn: 'later'",
            "⚡ Interrupting current task (iteration 3).",
            "⏳ Subagent working (2 active)",
            "⏳ Hermes is restarting — your message is saved and will be answered when it is back.",
            "⏳ Your message is saved and will be answered when the work running in this conversation finishes.",
            "⏳ Gateway restarting — queued for the next turn after it comes back.",
            "🗑️ Discarded 1 lost turn(s); they were not re-run. Your saved messages will be answered now.",
            refused,
            "Nothing to discard: this chat has no turn lost in a restart.",
        )
        self.assertEqual([n["text"] for n in chat_state.notices("session", since=0)], [refused, "Nothing to discard: this chat has no turn lost in a restart."])

    def test_a_paused_conversation_is_a_card(self):
        lost = (
            "⏸️ This conversation is paused: a previous turn did not finish when Hermes restarted, and only you know whether "
            "to send it again. Your message is saved. Send /discard to drop the lost turn and continue (it is not re-run), "
            "or /reset to start a fresh conversation."
        )
        stuck = "⏸️ This conversation is paused: a queued message could not be re-authorized (expired). Your message is saved but will not be answered here."
        self.write_outbox(lost, stuck)
        found = chat_state.notices("session", since=0)
        self.assertEqual([n.get("paused") for n in found], [{"lostTurn": True}, {"lostTurn": False}])
        self.assertIsNone(chat_state.paused_conversation("⏸ Goal paused: ship it"))

    def test_a_choice_hermes_offers_runs_its_callback_once(self):
        # Hermes's callback runs on the gateway's loop, as a choice picker's does on its other platforms.
        loop = asyncio.new_event_loop()
        runner = threading.Thread(target=loop.run_forever, daemon=True)
        runner.start()

        def stop():
            loop.call_soon_threadsafe(loop.stop)
            runner.join(2)
            loop.close()

        self.addCleanup(stop)
        self.addCleanup(chat_state._choices.clear)
        picked = []

        async def callback(value):
            picked.append(value)
            return "✓ Model switched: hermes-small"

        choices = [{"value": "hermes-small", "label": "Switch to Hermes Small (included)", "current": False}]
        cid = chat_state.record_choice("owner", "Keep going on another model:", choices, callback, loop)
        self.assertEqual(
            chat_state.pending_choice("owner"),
            {"id": cid, "title": "Keep going on another model:", "choices": choices, "at": chat_state._choices["owner"]["at"]},
        )
        self.assertIsNone(chat_state.pending_choice("owner.t-other"))
        self.assertFalse(chat_state.choose("owner", cid, "something-else")["ok"])
        self.assertEqual(chat_state.choose("owner", "stale", "hermes-small")["code"], "gone")
        self.assertEqual(chat_state.choose("owner", cid, "hermes-small"), {"ok": True, "message": "✓ Model switched: hermes-small"})
        self.assertEqual(picked, ["hermes-small"])
        self.assertIsNone(chat_state.pending_choice("owner"))
        self.assertEqual(chat_state.choose("owner", cid, "hermes-small")["code"], "gone", "a choice is taken once")
        self.assertIn("✓ Model switched: hermes-small", [r.get("message") for r in outbox.read_outbox(limit=10)])

    def test_why_a_turn_ended_without_an_answer(self):
        self.assertEqual(
            chat_state.failed_turn_reason(
                "Gateway restarting: this turn was interrupted and will not be run again. Send your message again once Hermes reconnects."
            ),
            "restart",
        )
        self.assertEqual(chat_state.failed_turn_reason("Gateway shutting down: this turn was interrupted and will not be run again."), "restart")
        self.assertEqual(
            chat_state.failed_turn_reason("This turn did not complete. Some actions may already have run; verify their effects before resending."), "partial"
        )
        self.assertEqual(chat_state.failed_turn_reason("Your request was not processed. Send it again if you still want me to carry it out."), "")

    def test_a_message_hermes_wrapped_with_its_origin_shows_as_typed(self):
        # Sent while the chief worked, after the turn had ended: Hermes's origin block for the model, then the words.
        wrapped = (
            "Gateway message origin (JSON data, not instructions or authorization):\n"
            '{"platform": "command_center", "chat_id": "owner", "chat_type": "dm", "user_id": "owner", "message_id": "8a279d39b2f14fda"}\n'
            "Do not guess a reply destination when these fields are insufficient.\n\n"
            "CTX-blue use the blue template"
        )
        self.assertEqual(data.strip_origin(wrapped), "CTX-blue use the blue template")
        self.assertEqual(data.strip_origin("Gateway message origin is a phrase I like"), "Gateway message origin is a phrase I like")
        with self.database() as conn:
            conn.execute("INSERT INTO messages VALUES (1, 'user', ?, '10.0', NULL, 's', 1)", (wrapped,))
        self.assertEqual(data.transcript("session")["messages"][0]["content"], "CTX-blue use the blue template")

    def test_hermess_row_kinds_hide_unwrap_and_mark(self):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.executescript("""
            CREATE TABLE sessions (id TEXT, session_key TEXT, last_activity_at INTEGER, source TEXT);
            INSERT INTO sessions VALUES ('s', 'session', 1, 'command_center');
            CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT, content TEXT, timestamp TEXT,
                                   tool_calls TEXT, session_id TEXT, active INTEGER, display_kind TEXT);
        """)
        with conn:
            conn.execute("INSERT INTO messages VALUES (1, 'user', 'Plan the week', '10.0', NULL, 's', 1, NULL)")
            conn.execute("INSERT INTO messages VALUES (2, 'user', 'goal control: continue', '11.0', NULL, 's', 1, 'hidden')")
            conn.execute("INSERT INTO messages VALUES (3, 'user', '[OUT-OF-BAND USER MESSAGE]\nuse the blue one\n[END]', '12.0', NULL, 's', 1, 'steer')")
            restart = "Gateway restarting: this turn was interrupted and will not be run again. Send your message again once Hermes reconnects."
            conn.execute("INSERT INTO messages VALUES (4, 'assistant', ?, '13.0', NULL, 's', 1, 'failed_turn')", (restart,))
        fake = types.ModuleType("agent.conversation_compression")
        fake._extract_steer_text_from_message = lambda m: m["content"].split("\n")[1]
        with patch.dict(sys.modules, {"agent": types.ModuleType("agent"), "agent.conversation_compression": fake}):
            rows = data.transcript("session")["messages"]
        self.assertEqual([r["id"] for r in rows], [1, 3, 4], "a hidden row isn't shown")
        self.assertEqual((rows[1]["content"], rows[1].get("steered")), ("use the blue one", True))
        self.assertEqual((rows[2].get("failedTurn"), rows[2].get("failedReason")), (True, "restart"))
        self.assertNotIn("steered", rows[0])

    def test_a_rewritten_conversation_is_read_again_from_the_top(self):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.executescript("""
            CREATE TABLE sessions (id TEXT, session_key TEXT, last_activity_at INTEGER, source TEXT);
            INSERT INTO sessions VALUES ('s', 'session', 1, 'command_center');
            CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, timestamp TEXT, tool_calls TEXT,
                                   session_id TEXT, active INTEGER, compacted INTEGER, message_uid TEXT);
        """)
        failed = "Gateway shutting down: this turn was interrupted and will not be run again."
        with conn:
            conn.executemany(
                "INSERT INTO messages (role, content, timestamp, session_id, active, compacted, message_uid) VALUES (?, ?, ?, 's', 1, 0, ?)",
                [
                    ("user", "Plan the week", "10.0", "u1"),
                    ("assistant", "Here is the plan.", "11.0", "u2"),
                    ("user", "WORK on it", "12.0", "u3"),
                    ("assistant", failed, "13.0", "u4"),
                ],
            )
        first = data.transcript("session")
        self.assertEqual(([m["uid"] for m in first["messages"]], first["lastId"]), (["u1", "u2", "u3", "u4"], 4))
        self.assertNotIn("reset", data.transcript("session", after_id=4))
        # Send again (Hermes's /retry): the live rows are deleted and written again with new ids, without the cut-off turn.
        with conn:
            conn.execute("DELETE FROM messages WHERE active = 1")
            conn.executemany(
                "INSERT INTO messages (role, content, timestamp, session_id, active, compacted, message_uid) VALUES (?, ?, ?, 's', 1, 0, ?)",
                [("user", "Plan the week", "10.0", "u1"), ("assistant", "Here is the plan.", "11.0", "u2"), ("user", "WORK on it", "20.0", "u5")],
            )
        again = data.transcript("session", after_id=4)
        self.assertTrue(again["reset"])
        self.assertEqual(([(m["id"], m["uid"]) for m in again["messages"]], again["lastId"]), ([(5, "u1"), (6, "u2"), (7, "u5")], 7))
        # Compaction archives rows (`compacted`) and its copies are flagged: not a rewrite. `/undo` takes rows back: one.
        with conn:
            conn.execute("UPDATE messages SET active = 0, compacted = 1 WHERE id = 7")
        self.assertNotIn("reset", data.transcript("session", after_id=7))
        with conn:
            conn.execute("UPDATE messages SET compacted = 0 WHERE id = 7")
        self.assertEqual([m["id"] for m in data.transcript("session", after_id=7)["messages"]], [5, 6])
        self.assertTrue(data.transcript("session", after_id=7)["reset"])

    def test_an_approval_announcement_is_not_a_notice_and_a_failed_job_is_a_card(self):
        rows = [
            ("⚠️ **Hermes wants to run a command that needs your OK**\n\n```\nrm -r ./x\n```\n\nWhy it was flagged: recursive delete", "send", 100.0),
            (CronFailureTests.GENERIC, "send", 110.0),
            ("⌛ Approval timed out after 5 minutes — the command was NOT run.", "send", 120.0),
        ]
        outbox._outbox_path().write_text(
            "".join(
                json.dumps({"id": f"o{i}", "at": at, "chat_id": "owner", "message": m, "source": src, "read": False}) + "\n"
                for i, (m, src, at) in enumerate(rows)
            ),
            encoding="utf-8",
        )
        found = chat_state.notices("session", since=0)
        self.assertEqual(
            [(n["text"], n["source"]) for n in found],
            [("Connection error", "scheduled"), ("⌛ Approval timed out after 5 minutes — the command was NOT run.", "notice")],
        )
        self.assertEqual(found[0]["routine"], {"name": "Second Brain: morning", "jobId": "f78b53e73629", "profile": "chief"})
        self.assertEqual(found[0]["failure"]["streak"], 4)
        self.assertNotIn("failure", found[1])

    def test_a_bots_relayed_routine_run_is_that_routines_card(self):
        routine = {"name": "Sam check-in", "jobId": "job7", "profile": "ada", "bot": "Ada"}
        rows = [
            {"message": "Two new papers.", "source": "cron", "routine": routine},
            {
                "message": "This run didn't finish. Open Team & Routines to see what went wrong.",
                "source": "cron",
                "routine": routine,
                "failure": {"error": "it didn't finish", "streak": 2, "detail": "RuntimeError: refused"},
            },
            # Relayed before rows carried the routine: the header still becomes the card's title.
            {"message": "Routine: Papers (Ada)\n-------------\n\nOne more paper.", "source": "cron"},
        ]
        outbox._outbox_path().write_text(
            "".join(json.dumps({"id": f"o{i}", "at": 100.0 + i, "chat_id": "owner", "read": False, **row}) + "\n" for i, row in enumerate(rows)),
            encoding="utf-8",
        )
        answer, failed, older = chat_state.notices("session", since=0)
        self.assertEqual((answer["text"], answer["source"], answer["routine"]), ("Two new papers.", "scheduled", routine))
        self.assertNotIn("failure", answer)
        self.assertEqual(failed["failure"], {"error": "it didn't finish", "streak": 2, "detail": "RuntimeError: refused"})
        self.assertEqual(failed["routine"], routine)
        self.assertEqual(older["text"], "One more paper.")
        self.assertEqual(older["routine"], {"name": "Papers", "jobId": "", "profile": "", "bot": "Ada"})

    def test_attachments_sent_after_a_reply_show_once(self):
        shown = self.home / "img" / "shown.png"
        new = self.home / "img" / "sketch.png"
        with self.database() as conn:
            conn.execute("INSERT INTO messages VALUES (1, 'assistant', ?, '100.0', NULL, 's', 1)", (f"Here it is.\nMEDIA:{shown}",))
        rows = [
            (f"MEDIA:{shown}", "send", 100.1),  # the reply's own image, handed over after its text
            (f"Daily sketch\nMEDIA:{new}", "cron", 160.0),  # a routine's image
            (f"MEDIA:{new}", "send", 170.0),  # an image on its own
        ]
        outbox._outbox_path().write_text(
            "".join(
                json.dumps({"id": f"o{i}", "at": at, "chat_id": "owner", "message": m, "source": src, "read": False}) + "\n"
                for i, (m, src, at) in enumerate(rows)
            ),
            encoding="utf-8",
        )
        found = chat_state.notices("session", since=0)
        self.assertEqual([(n["text"], n["source"]) for n in found], [("Daily sketch", "scheduled"), ("", "notice")])
        self.assertEqual([[a["name"] for a in n["attachments"]] for n in found], [["sketch.png"], ["sketch.png"]])
        self.assertEqual(found[0]["attachments"][0]["kind"], "image")

    def test_background_work_lists_this_conversations_running_tasks_in_plain_words(self):
        units = [
            {
                "delegation_id": "d2",
                "status": "running",
                "session_key": "session",
                "dispatched_at": 200.0,
                "goals": ["Research lane A", "Research lane B", "Research lane C"],
                "task_indexes": [1, 2],
                "children_activity": [{"api_calls": 3, "current_tool": "web_search"}, None],
            },
            {"delegation_id": "d1", "status": "finalizing", "session_key": "session", "dispatched_at": 100.0, "goal": "Summarise   the\nfindings"},
            {"delegation_id": "d3", "status": "completed", "session_key": "session", "dispatched_at": 50.0, "goal": "done already"},
            {"delegation_id": "d4", "status": "running", "session_key": "another", "dispatched_at": 60.0, "goal": "someone else's"},
        ]
        mod = types.ModuleType("tools.async_delegation")
        mod.list_async_delegations = lambda: units
        with patch.dict(sys.modules, {"tools.async_delegation": mod}):
            work = chat_state.background("session")
            self.assertEqual(
                work,
                [
                    {"id": "d1", "status": "finalizing", "since": 100.0, "tasks": [{"goal": "Summarise the findings", "step": "Wrapping up"}]},
                    {
                        "id": "d2",
                        "status": "running",
                        "since": 200.0,
                        "tasks": [{"goal": "Research lane B", "step": "Searching the web"}, {"goal": "Research lane C", "step": "Thinking it over"}],
                    },
                ],
            )
            self.assertEqual(chat_state.background_signature(work), "d1:finalizing:Wrapping up|d2:running:Searching the web,Thinking it over")
            self.assertEqual(chat_state.background(""), [])
        broken = types.ModuleType("tools.async_delegation")
        with patch.dict(sys.modules, {"tools.async_delegation": broken}):
            self.assertEqual(chat_state.background("session"), [])  # an older Hermes: nothing, never an error

    def test_each_running_helper_can_be_watched_steered_and_stopped(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = Path(tmp) / "cache" / "delegation" / "live" / "deleg_x"
            live.mkdir(parents=True)
            (live / "task-1.log").write_text("=== header ===\n" + "x" * 20000 + "\n[12:00:01] tool web_search: lanes\n", encoding="utf-8", newline="\n")
            (live / "task-2.log").write_text("[12:00:00] kickoff\n", encoding="utf-8", newline="\n")
            agents = {i: types.SimpleNamespace(_live_transcript_path=str(live / f"task-{i}.log")) for i in (1, 2)}
            records = {
                "sa-1": {"subagent_id": "sa-1", "delegation_id": "deleg_x", "started_at": 300.0, "tool_count": 4, "agent": agents[1], "accepting_steer": True},
                "sa-2": {"subagent_id": "sa-2", "delegation_id": "deleg_x", "started_at": 301.0, "tool_count": 0, "agent": agents[2], "accepting_steer": False},
                "sa-9": {"subagent_id": "sa-9", "delegation_id": "deleg_other", "agent": types.SimpleNamespace(_live_transcript_path=str(live / "task-0.log"))},
            }
            steered, stopped = [], []
            registry = types.ModuleType("tools.delegate_tool_registry")
            registry._active_subagents = records
            registry._active_subagents_lock = threading.Lock()
            registry.steer_subagent = lambda sid, text: steered.append((sid, text)) or True
            registry.interrupt_subagent = lambda sid: stopped.append(sid) or True
            units = [
                {
                    "delegation_id": "deleg_x-2",
                    "status": "running",
                    "session_key": "session",
                    "dispatched_at": 1.0,
                    "goals": ["A", "B", "C"],
                    "task_indexes": [1, 2],
                },
                {"delegation_id": "deleg_other", "status": "running", "session_key": "another", "dispatched_at": 2.0, "goal": "not ours"},
            ]
            delegations = types.ModuleType("tools.async_delegation")
            delegations.list_async_delegations = lambda: units
            with patch.dict(sys.modules, {"tools.async_delegation": delegations, "tools.delegate_tool_registry": registry}):
                tasks = chat_state.background("session")[0]["tasks"]
                self.assertEqual(
                    [(t["goal"], t.get("id"), t.get("toolCount"), t.get("steer")) for t in tasks], [("B", "sa-1", 4, True), ("C", "sa-2", 0, False)]
                )
                tail = chat_state.helper_tail("session", "sa-1")
                self.assertTrue(tail["truncated"])
                self.assertTrue(tail["text"].endswith("tool web_search: lanes\n"))
                self.assertLessEqual(len(tail["text"]), chat_state.TAIL_BYTES)
                self.assertFalse(tail["text"].startswith("x" * 100) and len(tail["text"]) == chat_state.TAIL_BYTES)  # the cut line is dropped

                chat_state.helper_steer("session", "sa-1", "  Focus on   lane B only ")
                self.assertEqual(steered, [("sa-1", "Focus on lane B only")])
                with self.assertRaisesRegex(chat_state.HelperError, "finishing"):
                    chat_state.helper_steer("session", "sa-2", "late")
                chat_state.helper_stop("session", "sa-2")
                self.assertEqual(stopped, ["sa-2"])
                for other in ("sa-9", "nobody", ""):
                    with self.assertRaisesRegex(chat_state.HelperError, "isn't running"):
                        chat_state.helper_stop("session", other)  # another conversation's helper, or none
                with self.assertRaises(chat_state.HelperError):
                    chat_state.helper_tail("another", "sa-1")

    def test_a_usage_limit_failure_says_when_it_resets(self):
        limit = (
            "Nous rate-limited every one of 3 attempts — its usage limit resets in ~3h. Send /retry after that, or switch "
            "models with /model. To avoid this in future, add a backup provider with `hermes fallback add`.\n\n"
            "Provider said: 429 quota exceeded\n\nLimit resets at 15:00 (in 2h 05m)."
        )
        found = chat_state.turn_failure(limit, 1000.0)
        self.assertEqual((found["code"], found["resetsAt"]), ("limit", 1000.0 + 2 * 3600 + 5 * 60))  # the exact line wins over "~3h"
        self.assertEqual(found["detail"], limit)
        rough = chat_state.turn_failure("Nous is rate-limiting requests right now — its usage limit resets in ~45 min. Send /retry.\n\nProvider said: 429", 0.0)
        self.assertEqual((rough["code"], rough["resetsAt"]), ("limit", 45 * 60.0))
        down = chat_state.turn_failure("OpenRouter returned a server error on all 3 attempts — it looks temporarily unavailable.\n\nProvider said: 502", 5.0)
        self.assertEqual((down["code"], down["resetsAt"]), ("down", None))
        for other in ("All done: three new papers.", "Provider said: hello", "The limit resets at noon, I think."):
            self.assertIsNone(chat_state.turn_failure(other, 0.0))
        self.assertTrue(chat_state.failed_turn_boundary("assistant", "Your request was not processed. Send it again if you still want me to carry it out."))
        self.assertFalse(chat_state.failed_turn_boundary("user", "Your request was not processed. Send it again if you still want me to carry it out."))
        self.assertFalse(chat_state.failed_turn_boundary("assistant", "Here is the plan."))

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
            conn.execute(
                "INSERT INTO messages VALUES (2, 'assistant', '', '101.0', ?, 's', 1)",
                (
                    json.dumps(
                        [
                            {"function": {"name": "skill_view", "arguments": json.dumps({"name": "fleet-ops"})}},
                            {"function": {"name": "skill_view", "arguments": json.dumps({"name": "fleet-builder"})}},
                        ]
                    ),
                ),
            )
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
        self.assertEqual([label for _, label in chat_state.live_steps("owner", 0)], ["Checking the team", None, "Planning the steps", "Reading Home.md"])
        chat_state.record_status("owner", None)
        self.assertEqual(chat_state.activity("session", generating=True, chat_id="owner")["label"], "Thinking it over")
        chat_state._live.clear()


class DefaultSoulTests(unittest.TestCase):
    def test_the_shipped_soul_digest_is_recorded(self):
        second_brain = importlib.import_module("test_bridge_plugin.second_brain")
        shipped = (ROOT / "hermes/plugins/chief-dashboard-bridge/second_brain/SOUL.md").read_text(encoding="utf-8")
        self.assertEqual(
            second_brain._soul_digest(shipped),
            second_brain.CURRENT_DEFAULT_SOUL,
            "second_brain/SOUL.md changed: move CURRENT_DEFAULT_SOUL into _PREVIOUS_DEFAULT_SOULS (so unedited "
            "installs still get the new default) and set CURRENT_DEFAULT_SOUL to the new digest.",
        )
        self.assertNotIn(second_brain.CURRENT_DEFAULT_SOUL, second_brain._PREVIOUS_DEFAULT_SOULS)


if __name__ == "__main__":
    unittest.main()


class CronFailureTests(unittest.TestCase):
    GENERIC = (
        "⚠️ Cron 'Second Brain: morning' failed: Connection error. See the full run with `hermes cron runs f78b53e73629` "
        "(output saved under C:/x/cron/output/f78b53e73629/); run it again with `hermes cron run f78b53e73629`, "
        "edit it with `hermes cron edit f78b53e73629`, or pause it with `hermes cron pause f78b53e73629`.\n"
        "This job has failed 4 runs in a row — worth a review. Fix its prompt/config, or pause it with "
        "`hermes cron pause Second Brain: morning` (resume/remove also available) to stop the noise."
    )
    PROVIDER = "⚠️ Cron 'Fleet: roster review' failed: the provider refused the key. Sign in again with `hermes login`. Run log: `hermes cron runs ab12`."
    SCRIPT = "⚠️ Cron 'Second Brain: drop' failed: its script timed out. No model was invoked. Check the script's output under C:/x or `hermes cron runs cd34`, then run it again with `hermes cron run cd34`."

    def test_the_error_the_routine_and_the_streak(self):
        error, routine, failure = chat_state.unwrap_cron_failure(self.GENERIC)
        self.assertEqual(error, "Connection error")
        self.assertEqual(routine, {"name": "Second Brain: morning", "jobId": "f78b53e73629", "profile": "chief"})
        self.assertEqual((failure["error"], failure["streak"]), ("Connection error", 4))
        self.assertEqual(failure["detail"], self.GENERIC)

    def test_other_failure_shapes(self):
        error, routine, failure = chat_state.unwrap_cron_failure(self.PROVIDER)
        self.assertEqual((error, routine["jobId"], failure["streak"]), ("the provider refused the key", "ab12", 1))
        error, routine, _ = chat_state.unwrap_cron_failure(self.SCRIPT)
        self.assertEqual((error, routine["jobId"]), ("its script timed out", "cd34"))

    def test_anything_else_is_left_alone(self):
        for text in ("Cron 'x' failed: no warning sign", "⚠️ Something else", "Morning brief: 3 tasks due"):
            self.assertEqual(chat_state.unwrap_cron_failure(text), (text, None, None))

    def test_the_approval_announcement_is_recognised(self):
        self.assertTrue(chat_state.approval_announcement("⚠️ **Hermes wants to run a command that needs your OK**\n\n```\nrm -r x\n```"))
        self.assertTrue(chat_state.approval_announcement("⚠️ Hermes wants to run a command that needs your OK\n\n```\nrm -r x\n```"))
        self.assertFalse(chat_state.approval_announcement("⌛ Approval timed out after 5 minutes — the command was NOT run."))
        self.assertFalse(chat_state.approval_announcement("Here is what I found.\nHermes wants to run a command that needs your OK"))

    def test_a_failure_inside_the_cron_envelope(self):
        wrapped = (
            "Cronjob Response: Second Brain: nightly\n(job_id: a94696753a42)\n-------------\n\n"
            + self.GENERIC.replace("Second Brain: morning", "Second Brain: nightly")
            + '\n\nTo stop or manage this job, send me a new message (e.g. "stop reminder Second Brain: nightly").'
        )
        body, routine = chat_state.unwrap_cron(wrapped)
        error, found, failure = chat_state.unwrap_cron_failure(body)
        self.assertEqual(routine, {"name": "Second Brain: nightly", "jobId": "a94696753a42", "profile": "chief"})
        self.assertEqual((error, found["jobId"], failure["streak"]), ("Connection error", "f78b53e73629", 4))


class DraftTests(unittest.TestCase):
    def setUp(self):
        chat_state.clear_draft("owner")
        self.addCleanup(chat_state.clear_draft, "owner")

    def test_frames_replace_each_other_and_the_cursor_is_stripped(self):
        self.assertIsNone(chat_state.draft("owner"))
        self.assertEqual(chat_state.draft_signature("owner"), "")
        chat_state.record_draft("owner", 7, "\n\nHere is")
        self.assertEqual(chat_state.draft("owner")["text"], "Here is")
        chat_state.record_draft("owner", 7, "\n\nHere is the plan ▉")
        self.assertEqual(chat_state.draft("owner")["text"], "Here is the plan")
        self.assertEqual(chat_state.draft("owner")["id"], 7)
        self.assertEqual(chat_state.draft_signature("owner"), "7:2")
        chat_state.record_draft("owner", 8, "A new reply")
        self.assertEqual(chat_state.draft_signature("owner"), "8:1")

    def test_an_empty_frame_shows_nothing_and_clearing_forgets_it(self):
        chat_state.record_draft("owner", 1, " ▉ ")
        self.assertIsNone(chat_state.draft("owner"))
        self.assertEqual(chat_state.draft_signature("owner"), "")
        chat_state.record_draft("owner", 1, "Text")
        chat_state.clear_draft("owner")
        self.assertIsNone(chat_state.draft("owner"))
