"""Tests for the bundled learning ledger (Fleet Health) against a throwaway Hermes tree (never the real one)."""

import importlib.util
import json
import os
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

HERE = Path(__file__).resolve().parents[1] / "plugins" / "chief-dashboard-bridge" / "ledger"


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.hermes = root / "hermes"
        self.skill = self.hermes / "profiles" / "ada" / "skills" / "devops" / "review" / "SKILL.md"
        self.skill.parent.mkdir(parents=True)
        (self.hermes / "profiles" / "ada" / "config.yaml").write_text("memory:\n  memory_char_limit: 4400\n", encoding="utf-8")
        (self.hermes / "skills").mkdir()
        self.skill.write_text("v1\n", encoding="utf-8")
        env = patch.dict(os.environ, {"CHIEF_HERMES_ROOT": str(self.hermes), "CHIEF_LEARNING_DIR": str(root / "learning")})
        env.start()
        self.addCleanup(env.stop)
        spec = importlib.util.spec_from_file_location("learning_ledger_under_test", HERE / "learning_ledger.py")
        self.ledger = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.ledger)
        self.ledger.crashes = lambda days=7: []  # no event log in tests

    def test_baseline_change_diff_revert(self):
        L = self.ledger
        self.assertEqual(L.snapshot(), 0)  # first run is the baseline, not a change
        self.skill.write_text("v1\nnew rule\n", encoding="utf-8")
        self.assertEqual(L.snapshot(), 1)
        report = L.report()
        change = report["changes"][0]
        self.assertEqual((change["scope"], change["skill"], change["change"]), ("ada", "devops/review", "changed"))
        self.assertNotIn("diff", change)  # diffs are fetched on demand
        self.assertEqual((change["added"], change["removed"]), (1, 0))
        conn = L.connect()
        self.assertIn("+new rule", L.diff_text(conn, conn.execute("SELECT * FROM versions WHERE id = ?", (change["id"],)).fetchone()))
        conn.close()
        self.assertTrue(change["canRevert"])
        self.assertEqual(report["skills"][0]["episodes"][0]["verdict"]["label"], "too early")
        self.assertEqual(report["desks"][0]["memory"]["memoryLimit"], 4400)
        L.revert(change["id"])
        self.assertEqual(self.skill.read_text(encoding="utf-8"), "v1\n")
        self.assertTrue(list(self.skill.parent.glob("SKILL.md.bak-ledger-*")))
        self.assertEqual(L.snapshot(), 0)  # the revert itself is already recorded

    def test_revert_refuses_to_drop_later_edits_unless_told(self):
        L = self.ledger
        L.snapshot()
        self.skill.write_text("v2\n", encoding="utf-8")
        L.snapshot()
        self.skill.write_text("v3\n", encoding="utf-8")
        L.snapshot()
        first, latest = sorted(c["id"] for c in L.report()["changes"])
        self.assertEqual({c["id"]: c["newer"] for c in L.report()["changes"]}, {first: 1, latest: 0})
        with self.assertRaises(SystemExit) as refused:
            L.revert(first)
        self.assertIn("1 later edit", str(refused.exception))
        self.assertEqual(self.skill.read_text(encoding="utf-8"), "v3\n")
        with self.assertRaises(SystemExit):
            L.revert(first, discard_newer=2)  # the count the caller saw must match
        L.revert(first, discard_newer=1)
        self.assertEqual(self.skill.read_text(encoding="utf-8"), "v1\n")

    def test_revert_records_an_unseen_edit_first(self):
        L = self.ledger
        L.snapshot()
        self.skill.write_text("v2\n", encoding="utf-8")
        L.snapshot()
        change = L.report()["changes"][0]["id"]
        self.skill.write_text("v2\nedited since the last run\n", encoding="utf-8")
        with self.assertRaises(SystemExit):
            L.revert(change)  # the new edit is recorded and counts as a later edit
        self.assertIn("edited since the last run", self.skill.read_text(encoding="utf-8"))

    def test_cli_passes_discard_count(self):
        L = self.ledger
        L.snapshot()
        self.skill.write_text("v2\n", encoding="utf-8")
        L.snapshot()
        self.skill.write_text("v3\n", encoding="utf-8")
        L.snapshot()
        first = min(c["id"] for c in L.report()["changes"])
        self.assertEqual(L.main(["ledger", "revert", str(first), "--discard-newer", "1"]), 0)
        self.assertEqual(self.skill.read_text(encoding="utf-8"), "v1\n")

    def edit(self, text, when):
        """Write the skill and record it as if the change happened `when` seconds ago."""
        self.skill.write_text(text, encoding="utf-8")
        t = time.time() - when
        os.utime(self.skill, (t, t))
        self.ledger.snapshot()
        conn = sqlite3.connect(os.environ["CHIEF_LEARNING_DIR"] + "/ledger.db")
        conn.execute("UPDATE versions SET seen_at = ? WHERE id = (SELECT MAX(id) FROM versions)", (t,))
        conn.commit()
        conn.close()

    def test_skills_group_edits_into_episodes_and_flag_churn(self):
        L = self.ledger
        L.snapshot()
        self.edit("older\n", when=5 * 86400)  # its own episode, days before the burst
        for i in range(6):
            self.edit(f"v{i}\n" + "rule\n" * i, when=3600 * (10 - i))  # six edits in the last 10 hours
        report = L.report()
        skill = report["skills"][0]
        self.assertEqual(skill["key"], "ada/devops/review")
        self.assertEqual(skill["edits48h"], 6)
        self.assertEqual(skill["edits7d"], 7)
        self.assertEqual([e["edits"] for e in skill["episodes"]], [6, 1])
        self.assertEqual({c["episode"] for c in skill["changes"]}, {e["id"] for e in skill["episodes"]})
        churn = [f for f in report["flags"] if f["kind"] == "churn"]
        self.assertEqual(len(churn), 1)
        self.assertTrue(churn[0]["id"].startswith("churn:ada/devops/review:"))
        self.assertIn("none by the background review", churn[0]["detail"])  # says who, since the fix differs
        self.assertEqual(L._who({"review": 5, "outside": 0}), "all by the background review after conversations")
        self.assertEqual(L._who({"review": 3, "outside": 2}), "3 by the background review after conversations, 2 outside it")
        self.assertEqual(report["thresholds"]["churn48h"], L.CHURN_48H)

    def _library(self, profile: str) -> list[Path]:
        """A bundled skill as a new bot gets it: SKILL.md and 18 references, written the same for every profile."""
        base = self.hermes / "profiles" / profile / "skills" / "autonomous-ai-agents" / "hermes-agent"
        files = [base / "SKILL.md"] + [base / "references" / f"ref-{i:02d}.md" for i in range(18)]
        for i, f in enumerate(files):
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(f"bundled hermes-agent file {i}\n", encoding="utf-8")
        return files

    def test_a_new_bots_copied_skill_library_is_not_churn(self):
        # A tester saw "19 edits in 7 days (19 in the last 48 hours)" on two new bots: nothing had been edited.
        L = self.ledger
        self._library("ada")
        L.snapshot()
        for bot in ("researcher", "writer"):
            (self.hermes / "profiles" / bot).mkdir(parents=True, exist_ok=True)
            self._library(bot)
        self.assertEqual(L.snapshot(), 0)
        conn = L.connect()
        kinds = {r[0] for r in conn.execute("SELECT change FROM versions WHERE scope IN ('researcher', 'writer')")}
        conn.close()
        self.assertEqual(kinds, {"copied"})
        report = L.report()
        self.assertEqual([f for f in report["flags"] if f["kind"] == "churn"], [])
        self.assertEqual(report["changes"], [])

    def test_a_genuinely_new_skill_file_still_counts(self):
        L = self.ledger
        L.snapshot()
        mine = self.hermes / "profiles" / "ada" / "skills" / "devops" / "deploy" / "SKILL.md"
        mine.parent.mkdir(parents=True)
        mine.write_text("a rule nobody else has\n", encoding="utf-8")
        self.assertEqual(L.snapshot(), 1)
        self.assertEqual([c["change"] for c in L.report()["changes"]], ["added"])

    def test_copies_recorded_as_edits_before_the_fix_are_relabelled(self):
        L = self.ledger
        self._library("ada")
        L.snapshot()
        (self.hermes / "profiles" / "writer").mkdir(parents=True, exist_ok=True)
        self._library("writer")
        with patch.object(L, "known_content", lambda *a: False), patch.object(L, "reclassify_copies", lambda conn: 0):
            self.assertEqual(L.snapshot(), 19)  # what the earlier ledger recorded: one "edit" per copied file
        self.assertTrue(L.report()["changes"])
        L.snapshot()  # the next run relabels them
        conn = L.connect()
        rows = conn.execute("SELECT change, source FROM versions WHERE scope = 'writer'").fetchall()
        conn.close()
        self.assertEqual({r[0] for r in rows}, {"copied"})
        self.assertTrue(all("relabelled" in r[1] for r in rows))
        self.assertEqual(L.report()["changes"], [])

    def test_a_retired_bots_untouched_copies_going_away_is_not_churn(self):
        L = self.ledger
        self._library("ada")
        L.snapshot()
        writer = self.hermes / "profiles" / "writer"
        writer.mkdir(parents=True, exist_ok=True)
        self._library("writer")
        L.snapshot()
        import shutil

        shutil.rmtree(writer / "skills")
        self.assertEqual(L.snapshot(), 0)
        conn = L.connect()
        kinds = {r[0] for r in conn.execute("SELECT change FROM versions WHERE scope = 'writer'")}
        conn.close()
        self.assertEqual(kinds, {"copied", "dropped"})
        self.assertEqual(L.report()["changes"], [])
        self.assertEqual([f for f in L.report()["flags"] if f["kind"] == "churn"], [])
        self._library("writer")  # minted again under the same name: still copies
        self.assertEqual(L.snapshot(), 0)
        self.assertEqual(L.report()["changes"], [])

    def _app_write(self, text: str):
        """Write the skill as the app does: the file, and the app's record of what it wrote there."""
        import hashlib

        self.skill.write_text(text, encoding="utf-8")
        skills = self.hermes / "profiles" / "ada" / "skills"
        record = {self.skill.relative_to(skills).as_posix(): hashlib.sha256(self.skill.read_bytes()).hexdigest()}
        (skills / ".chief-generated.json").write_text(json.dumps(record), encoding="utf-8")

    def test_the_apps_own_writes_are_not_edits(self):
        # A tester's Fleet Health said "5 edits in 7 days" on skills nobody had edited: the app had rewritten them
        # (each update, and the Second Brain skill re-rendered with the owner's facts).
        L = self.ledger
        L.snapshot()
        for i in range(6):
            self._app_write(f"rendered {i}\n")
            self.assertEqual(L.snapshot(), 0)
        report = L.report()
        self.assertEqual(report["changes"], [])
        self.assertEqual([f for f in report["flags"] if f["kind"] == "churn"], [])
        self.skill.write_text("rendered 5\nmy own rule\n", encoding="utf-8")  # an edit after the app's write counts
        self.assertEqual(L.snapshot(), 1)
        self.assertEqual([c["change"] for c in L.report()["changes"]], ["changed"])

    def test_an_update_that_only_moves_the_install_folder_is_not_an_edit(self):
        L = self.ledger
        old = 'run "C:/Program Files/WindowsApps/ChiefCommandCenter_0.1.22.0_x64__abc123def/python.exe" health\n'
        self.skill.write_text(old, encoding="utf-8")
        L.snapshot()
        self.skill.write_text(old.replace("0.1.22.0", "0.1.23.0"), encoding="utf-8")
        self.assertEqual(L.snapshot(), 0)
        self.assertEqual(L.report()["changes"], [])

    def test_app_writes_recorded_as_edits_before_the_fix_are_relabelled(self):
        L = self.ledger
        L.snapshot()
        old = 'run "C:/WindowsApps/ChiefCommandCenter_0.1.22.0_x64__abc123def/python.exe"\n'
        with (
            patch.object(L, "app_records", lambda: {}),
            patch.object(L, "only_install_folder_changed", lambda *a: False),
            patch.object(L, "reclassify_app_writes", lambda conn, apps: 0),
        ):
            self.skill.write_text(old, encoding="utf-8")
            L.snapshot()  # a real edit
            self.skill.write_text(old.replace("0.1.22.0", "0.1.23.0"), encoding="utf-8")
            L.snapshot()  # an update moving the folder, recorded as an edit by the earlier ledger
            self._app_write("rendered by the app\n")
            L.snapshot()  # the app's own write, likewise
        self.assertEqual(len(L.report()["changes"]), 3)
        L.snapshot()  # the next run relabels them
        changes = L.report()["changes"]
        self.assertEqual(len(changes), 1)
        conn = L.connect()
        content = conn.execute("SELECT content FROM versions WHERE id = ?", (changes[0]["id"],)).fetchone()[0]
        conn.close()
        self.assertIn("0.1.22.0", content)  # the real edit is the one left

    def test_bloat_and_full_memory_are_flagged(self):
        L = self.ledger
        L.snapshot()
        self.skill.write_text("x" * (L.BLOAT_BYTES + 10), encoding="utf-8")
        L.snapshot()
        memories = self.hermes / "profiles" / "ada" / "memories"
        memories.mkdir()
        (memories / "MEMORY.md").write_text("m" * 4300, encoding="utf-8")  # of 4400
        kinds = {f["kind"]: f for f in L.report()["flags"]}
        self.assertIn("bloat", kinds)
        self.assertEqual(kinds["memory"]["desk"], "ada")
        self.assertIn("98% full", kinds["memory"]["title"])

    def test_episode_verdicts_use_quality_and_call_out_crash_spikes(self):
        L = self.ledger
        day = L.DAY
        start = end = 100 * day
        now = end + 20 * day

        def events(before, after):
            rows = []
            for side, kinds in (("b", before), ("a", after)):
                base = start - 5 * day if side == "b" else end + 5 * day
                for kind, n in kinds.items():
                    rows += [{"kind": kind, "created_at": base + i, "assignee": "ada", "started_at": None, "completed_at": None} for i in range(n)]
            return rows

        worse = L.episode_verdict(events({"completed": 9, "gave_up": 1}, {"completed": 5, "gave_up": 5}), ["ada"], start, end, now)
        self.assertEqual(worse["label"], "worse")
        helped = L.episode_verdict(events({"completed": 5, "gave_up": 5}, {"completed": 9, "gave_up": 1}), ["ada"], start, end, now)
        self.assertEqual(helped["label"], "helped")
        crashy = L.episode_verdict(events({"completed": 9, "gave_up": 1}, {"completed": 5, "gave_up": 5, "crashed": 8}), ["ada"], start, end, now)
        self.assertEqual(crashy["label"], "confounded")
        early = L.episode_verdict([], ["ada"], start, end, end + day)
        self.assertEqual(early["label"], "too early")
        self.assertAlmostEqual(early["judgeAt"], end + L.IMPACT_WINDOW)

    def test_decisions_mark_proposals_and_approved_ones_applied(self):
        L = self.ledger
        L.snapshot()
        out = Path(os.environ["CHIEF_LEARNING_DIR"])
        (out / "proposals.json").write_text(
            json.dumps(
                {
                    "items": [
                        {"id": "20260901-1", "kind": "skill", "target": "review", "change": "split it"},
                        {"id": "20260901-2", "kind": "skill", "target": "cron jobs", "change": "retire three"},
                        {"id": "20260901-3", "kind": "skill", "target": "other", "change": "later"},
                    ]
                }
            ),
            encoding="utf-8",
        )
        decided_at = time.time() - 60
        (out / "decisions.json").write_text(
            json.dumps(
                {
                    "items": {
                        "20260901-1": {"decision": "approve", "at": decided_at},
                        "20260901-2": {"decision": "dismiss", "at": decided_at},
                    }
                }
            ),
            encoding="utf-8",
        )
        self.skill.write_text("v1\nsplit\n", encoding="utf-8")
        L.snapshot()
        report = L.report()
        status = {p["id"]: p["status"] for p in report["proposals"]}
        self.assertEqual(status, {"20260901-1": "applied", "20260901-2": "dismissed", "20260901-3": "open"})
        stale = [f for f in report["flags"] if f["kind"] == "proposal"]
        self.assertEqual([f["proposal"] for f in stale], ["20260901-3"])  # only the undecided one waits

    def test_diff_from_shows_the_net_change_of_several_edits(self):
        import contextlib
        import io

        L = self.ledger
        L.snapshot()
        for text in ("v1\na\n", "v1\na\nb\n", "v1\nb\n"):
            self.skill.write_text(text, encoding="utf-8")
            L.snapshot()
        ids = sorted(c["id"] for c in L.report()["changes"])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(L.main(["ledger", "diff", str(ids[-1]), "--from", str(ids[0])]), 0)
        self.assertIn("+b", buf.getvalue())
        self.assertNotIn("+a", buf.getvalue())  # added and removed again: not part of the net change

    def test_removed_file_is_recorded(self):
        L = self.ledger
        L.snapshot()
        self.skill.unlink()
        self.assertEqual(L.snapshot(), 1)
        conn = sqlite3.connect(os.environ["CHIEF_LEARNING_DIR"] + "/ledger.db")
        self.assertEqual(conn.execute("SELECT change FROM versions ORDER BY id DESC LIMIT 1").fetchone()[0], "removed")
        conn.close()


if __name__ == "__main__":
    unittest.main()
