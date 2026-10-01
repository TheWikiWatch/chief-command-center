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
        store(self.chief, [
            ("s1", "deepseek-flash", at(0), 1000, 200, 5000, 0, 10, 4, 0.010, None, "estimated"),
            ("s2", "deepseek-flash", at(3), 2000, 400, 0, 0, 0, 2, 0.020, 0.025, "actual"),
            ("s3", "deepseek-flash", at(10), 4000, 800, 0, 0, 0, 3, 0.040, None, "estimated"),  # earlier this month
            ("s4", "deepseek-flash", at(40), 9000, 900, 0, 0, 0, 3, 0.090, None, "estimated"),  # last month
        ], aux=[
            ("s1", "deepseek-flash", "title_generation", at(0), 200, 10, 0, 0, 0, 1, 0.001, 0.0, None),
            ("s1", "deepseek-flash", "", at(0), 1000, 200, 5000, 0, 10, 4, 0.010, 0.0, "estimated"),  # the main row: not added twice
        ])
        (self.chief / "profile.yaml").write_text("ui_meta:\n  hermes-bots:\n    title: Nova - Chief of Staff\n", encoding="utf-8")
        store(profiles / "research-desk", [
            ("r1", "copilot-gpt", at(1), 3000, 300, 0, 0, 0, 2, None, None, None),  # no price known
        ])

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


if __name__ == "__main__":
    unittest.main()
