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

    def save(self, files: dict, when: float):
        """One save touching several files of the skill (SKILL.md is "SKILL.md"), recorded `when` seconds ago."""
        t = time.time() - when
        for name, text in files.items():
            path = self.skill.parent / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if text is None:
                path.unlink()
                continue
            path.write_text(text, encoding="utf-8")
            os.utime(path, (t, t))
        conn = sqlite3.connect(os.environ["CHIEF_LEARNING_DIR"] + "/ledger.db")
        before = conn.execute("SELECT COALESCE(MAX(id), 0) FROM versions").fetchone()[0] if self._has_ledger(conn) else 0
        conn.close()
        self.ledger.snapshot()
        conn = sqlite3.connect(os.environ["CHIEF_LEARNING_DIR"] + "/ledger.db")
        conn.execute("UPDATE versions SET seen_at = ? WHERE id > ?", (t, before))
        conn.commit()
        conn.close()

    @staticmethod
    def _has_ledger(conn) -> bool:
        return bool(conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'versions'").fetchone())

    RULES = ("Check the vault index before writing a new note.", "Never overwrite a daily note; append under the last heading.")

    def rework_week(self):
        """A skill written ten days ago whose two rules are reworded in four saves over the last three days."""
        self.ledger.snapshot()  # the ledger's first look: a baseline, not an edit
        self.edit("# Review\n" + "\n".join(self.RULES) + "\n", when=10 * 86400)
        for n, hours in enumerate((70, 50, 30, 10), start=1):
            self.edit("# Review\n" + "\n".join(f"{r} (take {n})" for r in self.RULES) + "\n", when=hours * 3600)

    def test_edits_are_saves_and_growth_is_not_rework(self):
        L = self.ledger
        L.snapshot()
        self.edit("older\n", when=5 * 86400)  # its own episode, days before the burst
        for i in range(6):
            self.edit(f"v{i}\n" + "rule\n" * i, when=3600 * (10 - i))  # six edits in the last 10 hours, each adding a line
        self.save({"SKILL.md": "v6\n" + "rule\n" * 6, "references/notes.md": "detail\n"}, when=1800)  # one save, two files
        report = L.report()
        skill = report["skills"][0]
        self.assertEqual(skill["key"], "ada/devops/review")
        self.assertEqual(skill["edits48h"], 7)  # the two-file save is one edit
        self.assertEqual(skill["edits7d"], 8)
        self.assertEqual([e["edits"] for e in skill["episodes"]], [7, 1])
        self.assertEqual({c["episode"] for c in skill["changes"]}, {e["id"] for e in skill["episodes"]})
        self.assertEqual(skill["rework"]["reworkSaves"], [])
        self.assertEqual([f for f in report["flags"] if f["kind"] == "churn"], [])  # busy and growing is healthy
        self.assertEqual(report["thresholds"]["reworkSaves"], L.REWORK_SAVES)

    def test_rules_reworded_again_and_again_are_flagged_once_per_run(self):
        L = self.ledger
        self.rework_week()
        report = L.report()
        rework = report["skills"][0]["rework"]
        self.assertEqual(len(rework["reworkSaves"]), 4)
        self.assertTrue(rework["flagged"])
        churn = [f for f in report["flags"] if f["kind"] == "churn"]
        self.assertEqual(len(churn), 1)
        flag = churn[0]
        self.assertEqual(flag["id"], f"churn:ada/devops/review:{rework['runId']}")
        self.assertEqual(flag["subject"], "churn:ada/devops/review")
        self.assertAlmostEqual(flag["evidenceAt"], time.time() - 10 * 3600, delta=60)
        self.assertIn("All 4 of its edits in 7 days rewrote lines", flag["detail"])
        self.assertIn("“Check the vault index before writing a new note. (take 3)”", flag["detail"])  # quotes a rule being fought over
        # Another rewrite continues the same run: same id, so the phone isn't told again.
        self.edit("# Review\n" + "\n".join(f"{r} (take 5)" for r in self.RULES) + "\n", when=3600)
        self.assertEqual([f["id"] for f in L.report()["flags"] if f["kind"] == "churn"], [flag["id"]])

    def test_a_quiet_two_days_clears_the_flag(self):
        L = self.ledger
        L.snapshot()
        self.edit("# Review\n" + "\n".join(self.RULES) + "\n", when=10 * 86400)
        for n, hours in enumerate((120, 100, 80), start=1):
            self.edit("# Review\n" + "\n".join(f"{r} (take {n})" for r in self.RULES) + "\n", when=hours * 3600)
        report = L.report()
        self.assertEqual(len(report["skills"][0]["rework"]["reworkSaves"]), 3)
        self.assertEqual([f for f in report["flags"] if f["kind"] == "churn"], [])

    def test_front_matter_moves_and_a_new_skills_first_days_are_not_rework(self):
        L = self.ledger
        rules = "\n".join(self.RULES)
        L.snapshot()
        # A new skill, written and rewritten over its first day: still taking shape.
        for n, hours in enumerate((30, 20, 12, 4), start=1):
            self.edit("# Review\n" + "\n".join(f"{r} (draft {n})" for r in self.RULES) + "\n", when=hours * 3600)
        self.assertEqual(L.report()["skills"][0]["rework"]["reworkSaves"], [])
        # Past its first days (no grace): version bumps in the front matter, then the rules moved into a reference
        # in one save. Neither rewrites a rule.
        self.edit(f"---\nversion: 1.0.0\n---\n# Review\n{rules}\n", when=1 * 3600)
        with patch.object(L, "NEW_SKILL_GRACE", 0):
            for n, hours in enumerate((50, 40, 30), start=1):
                self.edit(f"---\nversion: 1.0.{n}\n---\n# Review\n{rules}\n", when=hours * 60)
            self.save({"SKILL.md": "---\nversion: 1.1.0\n---\n# Review\nSee references/rules.md.\n", "references/rules.md": f"{rules}\n"}, when=600)
            report = L.report()
        since = time.time() - 55 * 60
        self.assertEqual([s for s in report["skills"][0]["rework"]["reworkSaves"] if s["at"] > since], [])
        self.assertTrue(report["skills"][0]["rework"]["reworkSaves"])  # the drafts do count once the grace is gone

    def write_acks(self, items=None, asked=None):
        Path(os.environ["CHIEF_LEARNING_DIR"], "flag-acks.json").write_text(json.dumps({"items": items or {}, "asked": asked or {}}), encoding="utf-8")

    def test_the_tidy_up_the_owner_asked_for_is_not_rework(self):
        L = self.ledger
        L.snapshot()
        self.edit("# Review\n" + "\n".join(self.RULES) + "\n", when=10 * 86400)
        for n, hours in enumerate((70, 50), start=1):
            self.edit("# Review\n" + "\n".join(f"{r} (take {n})" for r in self.RULES) + "\n", when=hours * 3600)
        asked = time.time() - 12 * 3600
        self.write_acks(asked={"ada/devops/review": [asked]})
        self.edit("# Review\n" + "\n".join(f"{r} (settled)" for r in self.RULES) + "\n", when=11 * 3600)  # an hour after asking
        report = L.report()
        skill = report["skills"][0]
        self.assertEqual(len(skill["rework"]["reworkSaves"]), 2)
        self.assertFalse(skill["rework"]["flagged"])
        self.assertTrue(skill["changes"][0].get("requested"))  # labelled in Show changes
        self.assertNotIn("requested", skill["changes"][1])

    def test_editing_another_skill_while_answering_a_request_is_not_rework(self):
        L = self.ledger
        L.snapshot()
        self.edit("# Review\n" + "\n".join(self.RULES) + "\n", when=10 * 86400)
        for n, hours in enumerate((40, 30, 20), start=1):
            self.edit("# Review\n" + "\n".join(f"{r} (take {n})" for r in self.RULES) + "\n", when=hours * 3600)
        self.assertTrue(L.report()["skills"][0]["rework"]["flagged"])
        # The owner asked about a different skill each time, an hour before: the chief was answering them.
        self.write_acks(asked={"ada/other/skill": [time.time() - h * 3600 for h in (41, 31, 21)]})
        skill = L.report()["skills"][0]
        self.assertFalse(skill["rework"]["flagged"])
        self.assertTrue(skill["changes"][0].get("handling"))
        self.assertNotIn("requested", skill["changes"][0])

    def test_looks_fine_hides_a_flag_until_something_new_happens(self):
        L = self.ledger
        self.rework_week()
        flag = next(f for f in L.report()["flags"] if f["kind"] == "churn")
        self.write_acks(items={flag["subject"]: {"action": "fine", "at": time.time()}})
        report = L.report()
        self.assertEqual([f for f in report["flags"] if f["kind"] == "churn"], [])
        hidden = [f for f in report["hiddenFlags"] if f["kind"] == "churn"]
        self.assertEqual(hidden[0]["ack"]["action"], "fine")
        # New rework after the owner looked: back on screen.
        self.edit("# Review\n" + "\n".join(f"{r} (take 9)" for r in self.RULES) + "\n", when=-60)
        self.assertEqual([f["subject"] for f in L.report()["flags"] if f["kind"] == "churn"], [flag["subject"]])
        # A flag with no per-event evidence (a full memory) stays hidden for a week.
        now = time.time()
        memory = {"evidenceAt": None}
        self.assertTrue(L.acknowledged(memory, {"action": "fine", "at": now - 6 * 86400}, now))
        self.assertFalse(L.acknowledged(memory, {"action": "fine", "at": now - 8 * 86400}, now))
        self.assertFalse(L.acknowledged(memory, None, now))

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

    def test_the_old_second_brain_renders_are_relabelled_and_real_edits_stay(self):
        # A tester's rows: the second-brain skill re-rendered with new facts (chief and two bots), counted as edits.
        L = self.ledger
        L.snapshot()

        def render(facts: str) -> str:
            return f"---\nname: second-brain\nauthor: Chief Command Center\n---\n## Critical facts\n\n{L.OLD_FACTS_HEADING}\n\n{facts}\n"

        renders = []
        for profile in ("ada", "gift-desk", "research-desk"):
            f = self.hermes / "profiles" / profile / "skills" / "note-taking" / "second-brain" / "SKILL.md"
            f.parent.mkdir(parents=True, exist_ok=True)
            renders.append(f)
        for i in range(5):
            for f in renders:
                f.write_text(render(f"- **Focus:** week {i}"), encoding="utf-8")
            with patch.object(L, "reclassify_app_writes", lambda conn, apps: 0):
                L.snapshot()
        self.skill.write_text("v1\nmy own rule\n", encoding="utf-8")  # a real edit elsewhere
        with patch.object(L, "reclassify_app_writes", lambda conn, apps: 0):
            L.snapshot()
        self.assertGreater(len(L.report()["changes"]), 10)
        L.snapshot()  # the next run relabels the renders
        changes = L.report()["changes"]
        self.assertEqual([(c["skill"], c["change"]) for c in changes], [("devops/review", "changed")])
        self.assertEqual([f for f in L.report()["flags"] if f["kind"] == "churn"], [])

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
        # Only the desks that use the skill count: another desk's bad fortnight isn't this skill's doing.
        other = [dict(r, assignee="morgan") for r in events({"completed": 9, "gave_up": 1}, {"completed": 2, "gave_up": 8})]
        mixed = events({"completed": 9, "gave_up": 1}, {"completed": 9, "gave_up": 1}) + other
        self.assertEqual(L.episode_verdict(mixed, ["ada"], start, end, now)["label"], "no clear change")
        unused = L.episode_verdict(mixed, [], start, end, now)
        self.assertEqual(unused["label"], "too little work")  # never the whole team's cards
        self.assertIn("no desk has used", unused["why"])

    def test_a_shared_skill_is_judged_on_the_desks_that_used_it(self):
        L = self.ledger
        shared = self.hermes / "skills" / "ops" / "desk-update" / "SKILL.md"
        shared.parent.mkdir(parents=True)
        shared.write_text("v1\n", encoding="utf-8")
        for desk in ("chief", "morgan"):
            (self.hermes / "profiles" / desk / "skills").mkdir(parents=True)
            (self.hermes / "profiles" / desk / "config.yaml").write_text("model: {}\n", encoding="utf-8")
        usage = {"desk-update": {"use_count": 3, "view_count": 3}, "other": {"use_count": 0, "view_count": 0, "last_used_at": None}}
        (self.hermes / "profiles" / "chief" / "skills" / ".usage.json").write_text(json.dumps(usage), encoding="utf-8")
        (self.hermes / "profiles" / "morgan" / "skills" / ".usage.json").write_text(json.dumps({"other": {"use_count": 2}}), encoding="utf-8")
        self.assertEqual(L.skill_users(["ada", "chief", "morgan"]), {"desk-update": ["chief"], "other": ["morgan"]})
        L.snapshot()
        shared.write_text("v2\n", encoding="utf-8")
        L.snapshot()
        skill = next(s for s in L.report()["skills"] if s["scope"] == "shared")
        self.assertEqual(skill["episodes"][0]["judgedOn"], ["chief"])

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
