"""Backup and restore engine tests on synthetic homes (PLAN §16 test list).

Run: python -B -m unittest discover -s backup/tests -t backup
"""

from __future__ import annotations

import errno
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chief_backup import archive, crypto, restore  # noqa: E402
from chief_backup.__main__ import main as cli  # noqa: E402

KEY_LINE = "OPENROUTER_API_KEY=synthetic-openrouter-value\n"


def make_home(base: Path, vault: Path) -> Path:
    """A small but realistic Hermes root with one profile, secrets, caches and databases."""
    root = base / "hermes"
    chief = root / "profiles" / "chief"
    (chief / "memories").mkdir(parents=True)
    (chief / "skills" / "note-taking" / "second-brain").mkdir(parents=True)
    (chief / "cache").mkdir()
    (chief / "logs").mkdir()
    (chief / "models" / "faster-whisper-base").mkdir(parents=True)
    (chief / "cron").mkdir()
    (root / "bin").mkdir(parents=True)
    (root / "installs" / "abc").mkdir(parents=True)
    (chief / "SOUL.md").write_text("You are Chief.\n", encoding="utf-8")
    (chief / "memories" / "MEMORY.md").write_text("Owner likes tea.\n", encoding="utf-8")
    (chief / ".env").write_text(
        f'{KEY_LINE}OBSIDIAN_VAULT_PATH={vault}\nWIKI_PATH="{str(vault / "40 Knowledge").replace(chr(92), chr(92) * 2)}"\nCHIEF_DASHBOARD_PORT=7790\n',
        encoding="utf-8",
    )
    (chief / "auth.json").write_text('{"token": "synthetic"}', encoding="utf-8")
    (chief / "command_center_vapid.json").write_text('{"private": "synthetic"}', encoding="utf-8")
    (chief / "config.yaml").write_text(f"model:\n  default: tiny\nterminal:\n  cwd: {base / 'hermes'}\\work\n", encoding="utf-8")
    (chief / "second_brain.json").write_text(json.dumps({"path": str(vault), "mode": "new"}), encoding="utf-8")
    (chief / "skills" / "note-taking" / "second-brain" / "SKILL.md").write_text(f"Vault: `{vault}`\n", encoding="utf-8")
    (chief / "cache" / "big.bin").write_bytes(b"x" * 1000)
    (chief / "logs" / "gateway.log").write_text("log", encoding="utf-8")
    (chief / "models" / "faster-whisper-base" / "model.bin").write_bytes(b"m" * 1000)
    (chief / "gateway.lock").write_text("", encoding="utf-8")
    (chief / "models_dev_cache.json").write_text("{}", encoding="utf-8")
    (root / "bin" / "hermes.cmd").write_text("@echo off", encoding="utf-8")
    (root / "crash-dumps").mkdir()
    (root / "crash-dumps" / "gateway.dmp").write_bytes(b"d" * 1000)
    db = sqlite3.connect(chief / "state.db")
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)")
    db.executemany("INSERT INTO messages (body) VALUES (?)", [(f"message {i}",) for i in range(50)])
    db.commit()
    db.close()
    return root


def make_vault(base: Path) -> Path:
    vault = base / "Second Brain"
    (vault / "00 Inbox").mkdir(parents=True)
    (vault / ".obsidian").mkdir()
    (vault / "AGENTS.md").write_text("rules\n", encoding="utf-8")
    (vault / "00 Inbox" / "Idea.md").write_text("- [ ] try it\n", encoding="utf-8")
    (vault / ".obsidian" / "app.json").write_text("{}", encoding="utf-8")
    return vault


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="chief-backup-test-"))
        self.old = self.tmp / "old-pc"
        self.vault = make_vault(self.old)
        self.root = make_home(self.old, self.vault)
        self.app = self.old / "app"
        self.app.mkdir()
        (self.app / "settings.json").write_text('{"backup": {"folder": "D:/Backups"}}', encoding="utf-8")
        self.dest = self.tmp / "Backups"

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def backup(self, parts=("setup", "second-brain"), **kw):
        return archive.create(self.dest, parts=list(parts), hermes_root=self.root, app_dir=self.app, second_brain=self.vault, app_version="1.0.0", **kw)

    def names(self, path: str) -> list[str]:
        with zipfile.ZipFile(path) as zf:
            return zf.namelist()


class BackupContents(Case):
    def test_everything_without_passphrase_leaves_secrets_and_junk_out(self):
        result = self.backup()
        names = self.names(result["path"])
        self.assertTrue(result["path"].endswith(".chiefbackup"))
        for kept in (
            "hermes/profiles/chief/SOUL.md",
            "hermes/profiles/chief/memories/MEMORY.md",
            "hermes/profiles/chief/state.db",
            "hermes/profiles/chief/config.yaml",
            "hermes/profiles/chief/.env",
            "app/settings.json",
            "second-brain/AGENTS.md",
            "second-brain/00 Inbox/Idea.md",
            "second-brain/.obsidian/app.json",
            "manifest.json",
        ):
            self.assertIn(kept, names)
        for left_out in (
            "auth.json",
            "command_center_vapid.json",
            "cache/big.bin",
            "logs/gateway.log",
            "models/faster-whisper-base/model.bin",
            "gateway.lock",
            "models_dev_cache.json",
            "hermes/bin/hermes.cmd",
            "installs",
            "state.db-wal",
            "crash-dumps",
        ):
            self.assertFalse(any(left_out in n for n in names), left_out)
        with zipfile.ZipFile(result["path"]) as zf:
            env = zf.read("hermes/profiles/chief/.env").decode()
            manifest = json.loads(zf.read("manifest.json"))
        self.assertNotIn("synthetic-openrouter-value", env)
        self.assertIn("OBSIDIAN_VAULT_PATH", env)
        self.assertIn("CHIEF_DASHBOARD_PORT=7790", env)
        self.assertIn("OPENROUTER_API_KEY", manifest["dropped_secrets"])
        self.assertIn("sign-ins (auth.json)", manifest["dropped_secrets"])
        self.assertFalse(manifest["secrets_included"])
        self.assertEqual(manifest["summary"]["profiles"], ["chief"])
        self.assertEqual(manifest["summary"]["notes"], 2)
        self.assertFalse(list(self.dest.glob(".*partial")))

    def test_encrypted_backup_includes_secrets_and_needs_the_passphrase(self):
        result = self.backup(passphrase="correct horse battery")
        self.assertTrue(crypto.is_encrypted(Path(result["path"])))
        self.assertEqual(restore.inspect(Path(result["path"])), {"ok": True, "encrypted": True, "needs_passphrase": True})
        with self.assertRaises(crypto.BadPassphrase):
            restore.inspect(Path(result["path"]), "wrong passphrase")
        info = restore.inspect(Path(result["path"]), "correct horse battery", app_version="1.0.0")
        self.assertTrue(info["secrets_included"])
        self.assertEqual(info["dropped_secrets"], [])
        with open(result["path"], "rb") as handle:
            self.assertNotIn(b"synthetic-openrouter-value", handle.read())

    def test_setup_only_and_second_brain_only(self):
        setup = self.names(self.backup(parts=("setup",))["path"])
        self.assertFalse(any(n.startswith("second-brain/") for n in setup))
        time.sleep(1.1)
        brain = self.names(self.backup(parts=("second-brain",))["path"])
        self.assertFalse(any(n.startswith(("hermes/", "app/")) for n in brain))

    def test_a_destination_inside_the_vault_is_not_backed_up_into_itself(self):
        self.dest = self.vault / "Backups"
        self.backup()
        time.sleep(1.1)
        names = self.names(self.backup()["path"])
        self.assertFalse(any("Backups" in n for n in names))

    def test_disk_full_leaves_no_partial_file(self):
        real = zipfile.ZipFile.write

        def full(*args, **kwargs):
            raise OSError(errno.ENOSPC, "No space left on device")

        with mock.patch.object(zipfile.ZipFile, "write", full):
            with self.assertRaisesRegex(archive.BackupError, "enough free space"):
                self.backup()
        self.assertEqual(list(self.dest.iterdir()), [])
        self.assertIs(zipfile.ZipFile.write, real)

    def test_backup_while_chief_is_writing_is_consistent(self):
        db_path = self.root / "profiles" / "chief" / "state.db"
        stop = threading.Event()

        def writer():
            conn = sqlite3.connect(db_path, timeout=30)
            i = 0
            while not stop.is_set():
                conn.execute("INSERT INTO messages (body) VALUES (?)", (f"live {i}" * 50,))
                conn.commit()
                i += 1
            conn.close()

        thread = threading.Thread(target=writer)
        thread.start()
        try:
            time.sleep(0.2)
            result = self.backup(parts=("setup",))
        finally:
            stop.set()
            thread.join()
        with zipfile.ZipFile(result["path"]) as zf:
            out = self.tmp / "check.db"
            out.write_bytes(zf.read("hermes/profiles/chief/state.db"))
        conn = sqlite3.connect(out)
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertGreaterEqual(conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 50)
        conn.close()

    def test_automatic_backups_keep_the_newest_four_and_never_touch_manual_ones(self):
        self.dest.mkdir()
        for day in range(1, 7):
            (self.dest / f"Chief backup (auto) 2026-09-0{day} 100000.chiefbackup").write_bytes(b"x")
        (self.dest / "Chief backup 2026-08-01 100000.chiefbackup").write_bytes(b"x")
        removed = archive.prune(self.dest, 4)
        self.assertEqual(sorted(removed), ["Chief backup (auto) 2026-09-01 100000.chiefbackup", "Chief backup (auto) 2026-09-02 100000.chiefbackup"])
        self.assertTrue((self.dest / "Chief backup 2026-08-01 100000.chiefbackup").exists())

    def test_backups_before_updates_keep_the_newest_two_and_leave_the_others_alone(self):
        self.dest.mkdir()
        for day in range(1, 5):
            (self.dest / f"Chief backup (before update) 2026-09-0{day} 100000.chiefbackup").write_bytes(b"x")
        (self.dest / "Chief backup (auto) 2026-09-01 100000.chiefbackup").write_bytes(b"x")
        (self.dest / "Chief backup 2026-08-01 100000.chiefbackup").write_bytes(b"x")
        removed = archive.prune(self.dest, 2, "pre-update")
        self.assertEqual(
            sorted(removed), ["Chief backup (before update) 2026-09-01 100000.chiefbackup", "Chief backup (before update) 2026-09-02 100000.chiefbackup"]
        )
        self.assertTrue((self.dest / "Chief backup (auto) 2026-09-01 100000.chiefbackup").exists())
        self.assertTrue((self.dest / "Chief backup 2026-08-01 100000.chiefbackup").exists())


class Crypto(Case):
    def test_tampering_and_truncation_are_detected(self):
        src = self.tmp / "plain.bin"
        src.write_bytes(os.urandom(crypto.CHUNK * 2 + 123))
        enc = self.tmp / "enc.bin"
        with open(enc, "wb") as out:
            crypto.encrypt_file(src, out, "pass phrase")
        with open(self.tmp / "dec.bin", "wb") as out:
            crypto.decrypt_file(enc, out, "pass phrase")
        self.assertEqual((self.tmp / "dec.bin").read_bytes(), src.read_bytes())
        data = bytearray(enc.read_bytes())
        data[len(data) // 2] ^= 1
        (self.tmp / "tampered.bin").write_bytes(data)
        with self.assertRaises(crypto.CorruptBackup), open(self.tmp / "x", "wb") as out:
            crypto.decrypt_file(self.tmp / "tampered.bin", out, "pass phrase")
        full = enc.read_bytes()
        header_end = len(crypto.MAGIC) + 4 + int.from_bytes(full[len(crypto.MAGIC) : len(crypto.MAGIC) + 4], "big")
        first = int.from_bytes(full[header_end : header_end + 4], "big")
        (self.tmp / "short.bin").write_bytes(full[: header_end + 4 + first])  # only the first chunk
        with self.assertRaisesRegex(crypto.CorruptBackup, "incomplete"), open(self.tmp / "y", "wb") as out:
            crypto.decrypt_file(self.tmp / "short.bin", out, "pass phrase")


class Restore(Case):
    def new_pc(self):
        new = self.tmp / "new-pc"
        return new / "hermes", new / "app", new / "Notes" / "Second Brain", new / "state", new / "safety"

    def test_round_trip_to_a_new_pc_with_different_paths(self):
        result = self.backup()
        root, app, vault, state, safety = self.new_pc()
        info = restore.inspect(Path(result["path"]), app_version="1.0.0")
        self.assertTrue(info["compatible"])
        self.assertEqual(sorted(info["parts"]), ["second-brain", "setup"])
        restore.stage(
            Path(result["path"]),
            "",
            parts=["setup", "second-brain"],
            hermes_root=root,
            app_dir=app,
            second_brain=vault,
            current_second_brain=None,
            state_dir=state,
            app_version="1.0.0",
        )
        self.assertFalse(root.exists())  # nothing live changes at stage time
        report = restore.apply(state, safety_dir=safety, app_version="1.0.0")
        chief = root / "profiles" / "chief"
        self.assertEqual((chief / "SOUL.md").read_text(encoding="utf-8"), "You are Chief.\n")
        self.assertEqual((vault / "00 Inbox" / "Idea.md").read_text(encoding="utf-8"), "- [ ] try it\n")
        self.assertEqual((app / "settings.json").read_text(encoding="utf-8"), '{"backup": {"folder": "D:/Backups"}}')
        conn = sqlite3.connect(chief / "state.db")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 50)
        conn.close()
        env = restore._env_read((chief / ".env").read_text(encoding="utf-8"))
        self.assertEqual(env["OBSIDIAN_VAULT_PATH"], str(vault))
        self.assertEqual(env["WIKI_PATH"], str(vault / "40 Knowledge"))
        self.assertEqual(json.loads((chief / "second_brain.json").read_text(encoding="utf-8"))["path"], str(vault))
        self.assertIn(str(vault), (chief / "skills" / "note-taking" / "second-brain" / "SKILL.md").read_text(encoding="utf-8"))
        self.assertIn("OPENROUTER_API_KEY", report["missing_secrets"])
        self.assertTrue(any(r["file"].endswith("config.yaml") and "cwd" in r["text"] for r in report["review"]), report["review"])
        self.assertEqual(report["safety_backup"], "")  # nothing to protect on a new PC
        self.assertEqual(restore.finish(state), {"ok": True, "finished": True})

    def test_same_pc_restore_takes_a_safety_backup_and_carries_secrets_over(self):
        result = self.backup()
        (self.root / "profiles" / "chief" / "SOUL.md").write_text("Changed since the backup.\n", encoding="utf-8")
        state, safety = self.tmp / "state", self.tmp / "safety"
        restore.stage(
            Path(result["path"]),
            "",
            parts=["setup"],
            hermes_root=self.root,
            app_dir=self.app,
            second_brain=None,
            current_second_brain=self.vault,
            state_dir=state,
            app_version="1.0.0",
        )
        report = restore.apply(state, safety_dir=safety, app_version="1.0.0")
        chief = self.root / "profiles" / "chief"
        self.assertEqual((chief / "SOUL.md").read_text(encoding="utf-8"), "You are Chief.\n")
        self.assertIn(KEY_LINE.strip(), (chief / ".env").read_text(encoding="utf-8"))  # carried over
        self.assertEqual(report["missing_secrets"], [])
        self.assertTrue(Path(report["safety_backup"]).is_file())
        with zipfile.ZipFile(report["safety_backup"]) as zf:
            self.assertIn("Changed since the backup.", zf.read("hermes/profiles/chief/SOUL.md").decode())
            self.assertIn("synthetic-openrouter-value", zf.read("hermes/profiles/chief/.env").decode())
        previous = [p for p in self.root.parent.iterdir() if ".before-restore-" in p.name]
        self.assertEqual(len(previous), 2)  # hermes and app
        # This PC's own pieces (not in any backup) move into the restored root...
        self.assertTrue((chief / "models" / "faster-whisper-base" / "model.bin").is_file())
        self.assertTrue((self.root / "bin" / "hermes.cmd").is_file())
        restore.rollback(state)
        self.assertEqual((chief / "SOUL.md").read_text(encoding="utf-8"), "Changed since the backup.\n")
        # ...and come back on rollback.
        self.assertTrue((chief / "models" / "faster-whisper-base" / "model.bin").is_file())
        self.assertTrue((self.root / "bin" / "hermes.cmd").is_file())
        self.assertFalse([p for p in self.root.parent.iterdir() if ".before-restore-" in p.name])

    def test_second_brain_only_goes_to_an_empty_or_current_folder_and_repoints_chief(self):
        result = self.backup(parts=("second-brain",))
        state, safety = self.tmp / "state", self.tmp / "safety"
        busy = self.tmp / "Busy"
        busy.mkdir()
        (busy / "keep.md").write_text("mine", encoding="utf-8")
        with self.assertRaisesRegex(restore.RestoreError, "already has files"):
            restore.stage(
                Path(result["path"]),
                "",
                parts=["second-brain"],
                hermes_root=self.root,
                app_dir=None,
                second_brain=busy,
                current_second_brain=self.vault,
                state_dir=state,
                app_version="1.0.0",
            )
        fresh = self.tmp / "Restored Brain"
        restore.stage(
            Path(result["path"]),
            "",
            parts=["second-brain"],
            hermes_root=self.root,
            app_dir=None,
            second_brain=fresh,
            current_second_brain=self.vault,
            state_dir=state,
            app_version="1.0.0",
        )
        report = restore.apply(state, safety_dir=safety)
        self.assertTrue((fresh / "AGENTS.md").is_file())
        self.assertTrue((self.vault / "AGENTS.md").is_file())  # the current folder is untouched
        env = restore._env_read((self.root / "profiles" / "chief" / ".env").read_text(encoding="utf-8"))
        self.assertEqual(env["OBSIDIAN_VAULT_PATH"], str(fresh))
        self.assertIn("synthetic-openrouter-value", (self.root / "profiles" / "chief" / ".env").read_text(encoding="utf-8"))  # setup untouched
        self.assertEqual(report["missing_secrets"], [])

    def test_encrypted_restore_brings_secrets_back(self):
        result = self.backup(passphrase="pass phrase here")
        root, app, vault, state, safety = self.new_pc()
        with self.assertRaises(crypto.BadPassphrase):
            restore.stage(
                Path(result["path"]),
                "nope",
                parts=["setup"],
                hermes_root=root,
                app_dir=app,
                second_brain=None,
                current_second_brain=None,
                state_dir=state,
                app_version="1.0.0",
            )
        restore.stage(
            Path(result["path"]),
            "pass phrase here",
            parts=["setup"],
            hermes_root=root,
            app_dir=app,
            second_brain=None,
            current_second_brain=None,
            state_dir=state,
            app_version="1.0.0",
        )
        report = restore.apply(state, safety_dir=safety)
        self.assertIn("synthetic-openrouter-value", (root / "profiles" / "chief" / ".env").read_text(encoding="utf-8"))
        self.assertTrue((root / "profiles" / "chief" / "auth.json").is_file())
        self.assertEqual(report["missing_secrets"], [])

    def test_a_corrupted_backup_changes_nothing(self):
        result = self.backup()
        path = Path(result["path"])
        with zipfile.ZipFile(path) as zf:
            info = zf.getinfo("hermes/profiles/chief/SOUL.md")
            offset = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
        data = bytearray(path.read_bytes())
        for i in range(offset, offset + max(info.compress_size, 1)):
            data[i] ^= 0x55
        path.write_bytes(data)
        state = self.tmp / "state"
        with self.assertRaises(restore.RestoreError):
            restore.stage(
                path,
                "",
                parts=["setup"],
                hermes_root=self.root,
                app_dir=self.app,
                second_brain=None,
                current_second_brain=self.vault,
                state_dir=state,
                app_version="1.0.0",
            )
        self.assertEqual((self.root / "profiles" / "chief" / "SOUL.md").read_text(encoding="utf-8"), "You are Chief.\n")
        self.assertFalse([p for p in self.root.parent.iterdir() if p.name.endswith(".chief-restore")])
        self.assertFalse((state / restore.JOURNAL).exists())

    def test_a_backup_from_a_newer_app_is_refused(self):
        result = self.backup()
        info = restore.inspect(Path(result["path"]), app_version="0.9.0")
        self.assertFalse(info["compatible"])
        self.assertIn("Update the app first", info["problem"])
        with self.assertRaisesRegex(restore.RestoreError, "Update the app first"):
            restore.stage(
                Path(result["path"]),
                "",
                parts=["setup"],
                hermes_root=self.root,
                app_dir=None,
                second_brain=None,
                current_second_brain=None,
                state_dir=self.tmp / "state",
                app_version="0.9.0",
            )

    def test_unsafe_paths_in_a_backup_are_refused(self):
        evil = self.tmp / "evil.chiefbackup"
        with zipfile.ZipFile(evil, "w") as zf:
            data = b"pwned"
            import hashlib

            zf.writestr("hermes/../../escape.txt", data)
            zf.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "format": archive.FORMAT,
                        "format_version": 1,
                        "app_version": "1.0.0",
                        "parts": ["setup"],
                        "files": [{"path": "hermes/../../escape.txt", "size": 5, "sha256": hashlib.sha256(data).hexdigest()}],
                    }
                ),
            )
        root, app, vault, state, safety = self.new_pc()
        with self.assertRaisesRegex(restore.RestoreError, "unsafe path"):
            restore.stage(
                evil, "", parts=["setup"], hermes_root=root, app_dir=None, second_brain=None, current_second_brain=None, state_dir=state, app_version="1.0.0"
            )
        self.assertFalse((self.tmp / "escape.txt").exists())

    def test_restore_refuses_while_chief_is_running(self):
        result = self.backup(parts=("setup",))
        (self.root / "profiles" / "chief" / "gateway.pid").write_text(json.dumps({"pid": os.getpid()}), encoding="utf-8")
        state = self.tmp / "state"
        restore.stage(
            Path(result["path"]),
            "",
            parts=["setup"],
            hermes_root=self.root,
            app_dir=None,
            second_brain=None,
            current_second_brain=None,
            state_dir=state,
            app_version="1.0.0",
        )
        with self.assertRaisesRegex(restore.RestoreError, "still running"):
            restore.apply(state, safety_dir=self.tmp / "safety")
        restore.discard_staging(state)

    def test_a_failure_mid_swap_rolls_back(self):
        result = self.backup(parts=("setup",))
        state = self.tmp / "state"
        restore.stage(
            Path(result["path"]),
            "",
            parts=["setup"],
            hermes_root=self.root,
            app_dir=self.app,
            second_brain=None,
            current_second_brain=None,
            state_dir=state,
            app_version="1.0.0",
        )

        def boom():
            raise OSError("disk went away")

        with self.assertRaises(OSError):
            restore.apply(state, safety_dir=self.tmp / "safety", hooks={"after_old:app": boom})
        self.assertEqual((self.root / "profiles" / "chief" / "SOUL.md").read_text(encoding="utf-8"), "You are Chief.\n")
        self.assertTrue((self.app / "settings.json").is_file())
        self.assertIn("synthetic-openrouter-value", (self.root / "profiles" / "chief" / ".env").read_text(encoding="utf-8"))

    def test_a_process_killed_mid_swap_is_recovered_at_next_start(self):
        result = self.backup(parts=("setup",))
        state = self.tmp / "state"
        restore.stage(
            Path(result["path"]),
            "",
            parts=["setup"],
            hermes_root=self.root,
            app_dir=self.app,
            second_brain=None,
            current_second_brain=None,
            state_dir=state,
            app_version="1.0.0",
        )
        script = (
            f"import sys, os; sys.path.insert(0, {str(ROOT)!r});\n"
            "from pathlib import Path; from chief_backup import restore\n"
            f"restore.apply(Path({str(state)!r}), safety_dir=Path({str(self.tmp / 'safety')!r}), hooks={{'after_old:app': lambda: os._exit(9)}})\n"
        )
        code = subprocess.run([sys.executable, "-c", script]).returncode
        self.assertEqual(code, 9)
        self.assertFalse(self.app.exists())  # killed with the app folder moved aside
        self.assertEqual(restore.recover(state)["action"], "rolled-back")
        self.assertTrue((self.app / "settings.json").is_file())
        self.assertEqual((self.root / "profiles" / "chief" / "SOUL.md").read_text(encoding="utf-8"), "You are Chief.\n")
        self.assertIn("synthetic-openrouter-value", (self.root / "profiles" / "chief" / ".env").read_text(encoding="utf-8"))


class CommandLine(Case):
    def run_cli(self, argv, stdin=""):
        from io import StringIO

        out = StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stdin", StringIO(stdin)), mock.patch("sys.stderr", StringIO()):
            code = cli(argv)
        return code, json.loads(out.getvalue())

    def test_backup_list_and_inspect_with_a_passphrase_from_stdin(self):
        code, made = self.run_cli(
            [
                "backup",
                "--dest",
                str(self.dest),
                "--parts",
                "setup,second-brain",
                "--hermes-root",
                str(self.root),
                "--second-brain",
                str(self.vault),
                "--app-version",
                "1.0.0",
                "--passphrase-stdin",
            ],
            "a long passphrase\n",
        )
        self.assertEqual(code, 0, made)
        self.assertTrue(made["encrypted"])
        code, listed = self.run_cli(["list", "--dest", str(self.dest)])
        self.assertEqual([b["encrypted"] for b in listed["backups"]], [True])
        code, wrong = self.run_cli(["inspect", "--file", made["path"], "--passphrase-stdin"], "not it\n")
        self.assertEqual((code, wrong.get("code")), (1, "passphrase"))
        code, info = self.run_cli(["inspect", "--file", made["path"], "--app-version", "1.0.0", "--passphrase-stdin"], "a long passphrase\n")
        self.assertEqual(code, 0)
        self.assertTrue(info["secrets_included"])

    def test_errors_are_plain_json(self):
        code, result = self.run_cli(["backup", "--dest", str(self.dest), "--parts", "setup", "--hermes-root", str(self.tmp / "missing")])
        self.assertEqual((code, result), (1, {"ok": False, "error": "Chief's data folder wasn't found."}))


if __name__ == "__main__":
    unittest.main()
