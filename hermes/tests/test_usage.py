"""Usage and budget (usage.py) over throwaway session stores."""

import importlib
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import test_bridge  # noqa: F401  (sets up the plugin package and Hermes stand-ins)

ROOT = Path(__file__).resolve().parents[2]
data = importlib.import_module("test_bridge_plugin.data")
usage = importlib.import_module("test_bridge_plugin.usage")

NOW = datetime(2026, 10, 15, 12, 0, 0)


def store(home: Path, sessions, aux=()):
    home.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(home / "state.db")
    conn.executescript("""
        CREATE TABLE sessions (id TEXT, model TEXT, started_at REAL, input_tokens INT, output_tokens INT,
          cache_read_tokens INT, cache_write_tokens INT, reasoning_tokens INT, api_call_count INT,
          estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT);
        CREATE TABLE session_model_usage (session_id TEXT, model TEXT, task TEXT, first_seen REAL, input_tokens INT,
          output_tokens INT, cache_read_tokens INT, cache_write_tokens INT, reasoning_tokens INT, api_call_count INT,
          estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT);
    """)
    for s in sessions:
        conn.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", s)
    for a in aux:
        conn.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", a)
    conn.commit()
    conn.close()


def at(days_ago: float, hour: int = 10) -> float:
    return (NOW - timedelta(days=days_ago)).replace(hour=hour).timestamp()


class UsageTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        profiles = Path(self.temp.name) / "profiles"
        self.chief = profiles / "chief"
        p = patch.object(data, "chief_home", return_value=self.chief)
        p.start()
        self.addCleanup(p.stop)
        store(
            self.chief,
            [
                ("s1", "deepseek-flash", at(0), 1000, 200, 5000, 0, 10, 4, 0.010, None, "estimated"),
                ("s2", "deepseek-flash", at(3), 2000, 400, 0, 0, 0, 2, 0.020, 0.025, "actual"),
                ("s3", "deepseek-flash", at(10), 4000, 800, 0, 0, 0, 3, 0.040, None, "estimated"),  # earlier this month
                ("s4", "deepseek-flash", at(40), 9000, 900, 0, 0, 0, 3, 0.090, None, "estimated"),  # last month
            ],
            aux=[
                ("s1", "deepseek-flash", "title_generation", at(0), 200, 10, 0, 0, 0, 1, 0.001, 0.0, None),
                ("s1", "deepseek-flash", "", at(0), 1000, 200, 5000, 0, 10, 4, 0.010, 0.0, "estimated"),  # the main row: not added twice
            ],
        )
        (self.chief / "profile.yaml").write_text("ui_meta:\n  hermes-bots:\n    title: Nova - Chief of Staff\n", encoding="utf-8")
        store(
            profiles / "research-desk",
            [
                ("r1", "copilot-gpt", at(1), 3000, 300, 0, 0, 0, 2, None, None, None),  # no price known
            ],
        )

    def test_periods_bots_models_and_days(self):
        month = usage.summary("month", NOW)
        self.assertAlmostEqual(month["totals"]["cost"], 0.010 + 0.025 + 0.040 + 0.001)  # actual cost wins over estimated
        self.assertEqual(month["totals"]["sessions"], 4)  # aux rows add tokens and cost, not sessions
        self.assertEqual(month["totals"]["unpriced"], 1)
        self.assertEqual([b["id"] for b in month["bots"]], ["chief", "research-desk"])
        self.assertEqual(month["bots"][0]["name"], "Nova")
        self.assertEqual(len(month["daily"]), 15)  # the 1st to the 15th, gaps included
        self.assertAlmostEqual(month["daily"][-1]["cost"], 0.011)
        week = usage.summary("7d", NOW)
        self.assertAlmostEqual(week["totals"]["cost"], 0.010 + 0.025 + 0.001)
        self.assertEqual(len(week["daily"]), 7)
        today = usage.summary("today", NOW)
        self.assertEqual(today["totals"]["tokens"], 1000 + 200 + 5000 + 200 + 10)
        self.assertAlmostEqual(today["month"]["cost"], month["totals"]["cost"])
        self.assertEqual(usage.summary("bogus", NOW)["period"], "month")

    def test_budget_is_advisory_and_alerts_once_a_month(self):
        self.assertEqual(usage.summary("month", NOW)["budget"]["state"], "none")
        self.assertFalse(usage.set_budget("lots")["ok"])
        self.assertTrue(usage.set_budget(0.09)["ok"])
        self.assertEqual(usage.summary("month", NOW)["budget"]["state"], "warn")  # 0.076 of 0.09
        self.assertIsNone(usage.check_budget(NOW))
        usage.set_budget(0.05)
        self.assertEqual(usage.summary("month", NOW)["budget"]["state"], "over")
        alert = usage.check_budget(NOW)
        self.assertAlmostEqual(alert["limit"], 0.05)
        self.assertIsNone(usage.check_budget(NOW))  # once a month
        self.assertTrue(usage.set_budget(None)["ok"])
        self.assertEqual(usage.summary("month", NOW)["budget"]["state"], "none")


def ledger_store(home: Path, sessions, ledger):
    """A session store with the pinned Hermes columns: providers on both tables, `last_seen` on the ledger."""
    home.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(home / "state.db")
    conn.executescript("""
        CREATE TABLE sessions (id TEXT, model TEXT, billing_provider TEXT, started_at REAL, input_tokens INT,
          output_tokens INT, cache_read_tokens INT, cache_write_tokens INT, reasoning_tokens INT, api_call_count INT,
          estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT);
        CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, task TEXT,
          first_seen REAL, last_seen REAL, input_tokens INT, output_tokens INT, cache_read_tokens INT,
          cache_write_tokens INT, reasoning_tokens INT, api_call_count INT, estimated_cost_usd REAL,
          actual_cost_usd REAL, cost_status TEXT);
    """)
    for s in sessions:
        conn.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", s)
    for row in ledger:
        conn.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
    conn.commit()
    conn.close()


class ModelSwitchTests(unittest.TestCase):
    """The dashboard's model picker switches a live conversation; its spend follows the model each call used."""

    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        chief = Path(self.temp.name) / "profiles" / "chief"
        p = patch.object(data, "chief_home", return_value=chief)
        p.start()
        self.addCleanup(p.stop)
        ledger_store(
            chief,
            [
                # A long conversation, started last month on one model and switched to another two days ago.
                ("main", "deepseek-flash", "deepseek", at(25), 5000, 500, 0, 0, 0, 5, 0.050, None, "estimated"),
                # A session whose totals hold more than its ledger: the remainder stays with its own model.
                ("p1", "model-a", "prov-a", at(1), 1500, 0, 0, 0, 0, 3, 0.015, None, "estimated"),
            ],
            [
                ("main", "deepseek-flash", "deepseek", "", at(25), at(20), 3000, 300, 0, 0, 0, 3, 0.030, 0.0, "estimated"),
                ("main", "glm-5.3-flash", "zai", "", at(2), at(1), 2000, 200, 0, 0, 0, 2, 0.020, 0.0, "estimated"),
                ("main", "glm-5.3-flash", "zai", "title_generation", at(2), at(2), 100, 10, 0, 0, 0, 1, 0.001, 0.0, None),
                ("p1", "model-a", "prov-a", "", at(1), at(1), 1000, 0, 0, 0, 0, 2, 0.010, 0.0, "estimated"),
            ],
        )

    def models(self, period):
        return {(m["model"], m["provider"]): m for m in usage.summary(period, NOW)["models"]}

    def test_spend_follows_the_model_each_call_used(self):
        week = self.models("7d")
        self.assertEqual(set(week), {("glm-5.3-flash", "zai"), ("model-a", "prov-a")})  # nothing new under deepseek
        self.assertAlmostEqual(week[("glm-5.3-flash", "zai")]["cost"], 0.021)
        self.assertEqual(week[("glm-5.3-flash", "zai")]["sessions"], 1)
        self.assertEqual(week[("glm-5.3-flash", "zai")]["providerName"], "zai")  # Hermes's name when it has one
        month = self.models("30d")
        self.assertAlmostEqual(month[("deepseek-flash", "deepseek")]["cost"], 0.030)
        self.assertEqual(month[("deepseek-flash", "deepseek")]["calls"], 3)

    def test_a_row_is_spread_over_the_days_it_ran(self):
        month = usage.summary("month", NOW)  # 1–15 October; the deepseek row ran 20–25 September
        self.assertAlmostEqual(month["totals"]["cost"], 0.021 + 0.015)
        self.assertEqual(month["totals"]["sessions"], 2)
        self.assertEqual(month["totals"]["calls"], 3 + 3)

    def test_the_remainder_beyond_the_ledger_is_kept(self):
        p1 = self.models("7d")[("model-a", "prov-a")]
        self.assertEqual(p1["input"], 1500)
        self.assertEqual(p1["calls"], 3)
        self.assertAlmostEqual(p1["cost"], 0.015)
        self.assertEqual(p1["sessions"], 1)


class JournalTests(unittest.TestCase):
    """A long conversation's running total is spread over the days it was used, and later calls land on their day."""

    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.chief = Path(self.temp.name) / "profiles" / "chief"
        p = patch.object(data, "chief_home", return_value=self.chief)
        p.start()
        self.addCleanup(p.stop)
        # A conversation open for ten days: four calls, 1000 input tokens, 4 cents. The chief replied three
        # times ten days ago and once today.
        ledger_store(
            self.chief,
            [
                ("long", "deepseek-flash", "deepseek", at(10), 1000, 0, 0, 0, 0, 4, 0.04, None, "estimated"),
            ],
            [
                ("long", "deepseek-flash", "deepseek", "", at(10), at(0), 1000, 0, 0, 0, 0, 4, 0.04, 0.0, "estimated"),
            ],
        )
        conn = sqlite3.connect(self.chief / "state.db")
        conn.execute("CREATE TABLE messages (session_id TEXT, role TEXT, timestamp REAL)")
        conn.executemany(
            "INSERT INTO messages VALUES (?,?,?)",
            [
                ("long", "user", at(10)),
                ("long", "assistant", at(10)),
                ("long", "assistant", at(10, 11)),
                ("long", "assistant", at(10, 12)),
                ("long", "user", at(0)),
                ("long", "assistant", at(0)),
            ],
        )
        conn.commit()
        conn.close()

    def grow(self, input_tokens, calls, cost, last):
        conn = sqlite3.connect(self.chief / "state.db")
        conn.execute(
            "UPDATE session_model_usage SET input_tokens = input_tokens + ?, api_call_count = api_call_count + ?, "
            "estimated_cost_usd = estimated_cost_usd + ?, last_seen = ?",
            (input_tokens, calls, cost, last),
        )
        conn.execute(
            "UPDATE sessions SET input_tokens = input_tokens + ?, api_call_count = api_call_count + ?, estimated_cost_usd = estimated_cost_usd + ?",
            (input_tokens, calls, cost),
        )
        conn.commit()
        conn.close()

    def test_first_sight_spreads_a_long_conversation_by_the_chiefs_replies(self):
        today = usage.summary("today", NOW)["totals"]
        self.assertEqual((today["input"], today["calls"]), (250, 1))  # one reply of four was today
        self.assertAlmostEqual(today["cost"], 0.01)
        month = usage.summary("30d", NOW)["totals"]
        self.assertEqual((month["input"], month["calls"]), (1000, 4))  # nothing lost to the split
        self.assertAlmostEqual(month["cost"], 0.04)
        self.assertIsNotNone(usage.summary("today", NOW)["exactSince"])

    def test_after_that_only_what_grew_is_added_on_its_day(self):
        usage.summary("today", NOW)
        self.grow(200, 1, 0.002, at(0, 15))
        today = usage.summary("today", NOW)["totals"]
        self.assertEqual((today["input"], today["calls"]), (450, 2))
        self.assertAlmostEqual(today["cost"], 0.012)
        self.assertEqual(usage.summary("30d", NOW)["totals"]["input"], 1200)
        usage.summary("today", NOW)  # a sync with nothing new adds nothing
        self.assertEqual(usage.summary("30d", NOW)["totals"]["input"], 1200)

    def test_history_outlives_hermes_pruning_and_shrinking_totals(self):
        usage.summary("today", NOW)

        def change(*statements):
            conn = sqlite3.connect(self.chief / "state.db")
            for sql in statements:
                conn.execute(sql)
            conn.commit()
            conn.close()

        # A repaired session whose totals shrank (Hermes writes both tables together): never a negative day.
        change("UPDATE session_model_usage SET input_tokens = 10", "UPDATE sessions SET input_tokens = 10")
        self.assertEqual(usage.summary("30d", NOW)["totals"]["input"], 1000)
        change("DELETE FROM session_model_usage", "DELETE FROM sessions")
        self.assertEqual(usage.summary("30d", NOW)["totals"]["input"], 1000)


if __name__ == "__main__":
    unittest.main()
