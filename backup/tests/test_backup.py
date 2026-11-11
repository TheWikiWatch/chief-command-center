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

    @unittest.skipUnless(os.name == "nt", "Windows permissions")
    def test_a_local_backup_with_secrets_in_the_clear_is_owner_only(self):
        res = self.backup(parts=("setup",), kind="pre-update", secrets_plain=True)
        acl = subprocess.run(["icacls", res["path"]], capture_output=True, text=True).stdout
        self.assertNotIn("(I)", acl)  # nothing inherited from the folder
        self.assertNotRegex(acl, r"BUILTIN\\Users|Everyone|Authenticated Users")

    def test_an_encrypted_backup_never_writes_its_plaintext_anywhere(self):
        temp = self.tmp / "temp"
        temp.mkdir()
        markers = (b"synthetic-openrouter-value", b"Owner likes tea.", b"hermes/profiles/chief/SOUL.md")
        found = []
        real = archive._verify_zip

        def look_first(*args, **kwargs):  # the moment before the rename: everything the backup wrote is still there
            for path in self.tmp.rglob("*"):
                if path.is_file() and not any(p in path.parents for p in (self.root, self.vault)):
                    found.extend(f"{path.name}: {m.decode()}" for m in markers if m in path.read_bytes())
            return real(*args, **kwargs)

        with mock.patch.object(tempfile, "tempdir", str(temp)), mock.patch.object(archive, "_verify_zip", look_first):
            result = self.backup(passphrase="correct horse battery")
        self.assertEqual(found, [])
        self.assertEqual(list(temp.iterdir()), [])
        self.assertEqual([p.name for p in self.dest.iterdir()], [Path(result["path"]).name])
        self.assertFalse(list(self.root.parent.glob("chief-backup-*")))  # the database copies' folder is gone too

    def test_leftovers_of_killed_runs_are_swept_and_a_running_ones_are_kept(self):
        long_ago = time.time() - 2 * 24 * 3600
        temp = self.tmp / "temp"
        temp.mkdir()
        dead = self.root.parent / "chief-backup-999999-abcdefgh"
        dead.mkdir()
        (dead / "db.snapshot").write_bytes(b"x")
        running = self.root.parent / "chief-backup-4242-abcdefgh"
        running.mkdir()
        old_style = temp / "chief-backup-abcd1234"  # an earlier version's, in %TEMP%: a whole plaintext zip
        old_style.mkdir()
        (old_style / "backup.zip").write_bytes(b"plain")
        os.utime(old_style, (long_ago, long_ago))
        recent = temp / "chief-restore-efgh5678"
        recent.mkdir()
        unrelated = temp / "chief-backup-test-abcdefgh"
        unrelated.mkdir()
        os.utime(unrelated, (long_ago, long_ago))
        self.dest.mkdir()
        abandoned = self.dest / ".Chief backup 2026-01-01 000000.chiefbackup.partial"
        abandoned.write_bytes(b"x")
        os.utime(abandoned, (long_ago, long_ago))
        writing = self.dest / ".Chief backup 2026-01-02 000000.chiefbackup.partial"  # another PC's, on a shared folder
        writing.write_bytes(b"x")
        with mock.patch.object(tempfile, "tempdir", str(temp)), mock.patch.object(archive, "pid_alive", lambda pid: pid == 4242):
            self.backup(parts=("setup",))
        self.assertFalse(dead.exists())
        self.assertTrue(running.exists())
        self.assertFalse(old_style.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(unrelated.exists())
        self.assertFalse(abandoned.exists())
        self.assertTrue(writing.exists())

    def test_a_backup_that_reads_back_differently_is_not_kept(self):
        real = os.fsync

        def then_damage(fd):  # what a failing drive (or a tool rewriting the file) does after the write
            real(fd)
            for partial in self.dest.glob(".*.partial"):
                with open(partial, "r+b") as handle:
                    handle.seek(partial.stat().st_size // 2)
                    byte = handle.read(1)
                    handle.seek(-1, os.SEEK_CUR)
                    handle.write(bytes([byte[0] ^ 0xFF]))

        with mock.patch.object(archive.os, "fsync", then_damage):
            with self.assertRaisesRegex(archive.BackupError, "didn't read back"):
                self.backup(parts=("setup",))
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_reading_the_backup_back_keeps_reporting_so_it_is_never_taken_for_a_hung_tool(self):
        calls = []
        clock = iter(range(0, 10**6, 5))  # every look at the clock is five seconds on
        with mock.patch.object(archive.time, "monotonic", lambda: next(clock)):
            self.backup(parts=("setup",), progress=lambda done, total: calls.append((done, total)))
        total = calls[-1][1]
        self.assertGreater(calls.count((total, total)), 2)  # the zip's own last step is one; the rest come from the read-back

    def test_junctions_and_links_are_never_followed(self):
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "private.txt").write_text("not part of Chief", encoding="utf-8")
        made = []
        if os.name == "nt":  # a junction needs no special rights; os.path.islink is false for one
            for link in (self.root / "profiles" / "chief" / "junction", self.vault / "junction"):
                subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(elsewhere)], check=True, capture_output=True)
                made.append(link.name)
        try:
            os.symlink(elsewhere / "private.txt", self.root / "profiles" / "chief" / "file-link.md")
            os.symlink(elsewhere, self.vault / "folder-link", target_is_directory=True)
            made += ["file-link.md", "folder-link"]
        except OSError:
            pass  # symbolic links need Developer Mode or an administrator on Windows
        if not made:
            self.skipTest("no link could be made here")
        result = self.backup()
        names = self.names(result["path"])
        for name in made + ["private.txt"]:
            self.assertFalse(any(name in n for n in names), name)
        with zipfile.ZipFile(result["path"]) as zf:
            self.assertFalse(any(b"not part of Chief" in zf.read(n) for n in names))

    def test_a_backup_with_keys_in_the_clear_is_refused_when_it_cant_be_made_private(self):
        with mock.patch.object(archive, "owner_only", return_value=False):
            with self.assertRaisesRegex(archive.BackupError, "private to your Windows account"):
                self.backup(parts=("setup",), kind="pre-update", secrets_plain=True)
        self.assertEqual(list(self.dest.iterdir()), [])

    @unittest.skipUnless(os.name == "nt", "Windows permissions")
    def test_databases_are_copied_beside_the_hermes_root_in_an_owner_only_folder(self):
        seen = []
        real = archive._copy_sqlite

        def copy(src, dst):
            seen.append((dst.parent, subprocess.run(["icacls", str(dst.parent)], capture_output=True, text=True).stdout))
            real(src, dst)

        with mock.patch.object(archive, "_copy_sqlite", copy):
            self.backup(parts=("setup",))
        folder, acl = seen[0]
        self.assertEqual(folder.parent, self.root.parent)
        self.assertRegex(folder.name, r"^chief-backup-\d+-")
        self.assertNotIn("(I)", acl)
        self.assertNotRegex(acl, r"BUILTIN\\Users|Everyone|Authenticated Users")
        self.assertFalse(folder.exists())

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

    @mock.patch.dict(crypto._SCRYPT, {"n": 1 << 10})  # the layout is what is tested here, not the key's cost
    def test_the_streaming_encryptor_and_the_in_place_view_match_the_file_functions(self):
        for size in (0, 1, crypto.CHUNK - 1, crypto.CHUNK, crypto.CHUNK + 1, 2 * crypto.CHUNK + 123):
            plain = os.urandom(size)
            streamed = self.tmp / f"streamed-{size}.bin"
            with open(streamed, "wb") as out:
                sink = crypto.Encryptor(out, "pass phrase")
                for start in range(0, size, 70_001):  # pieces that never line up with the chunks
                    sink.write(plain[start : start + 70_001])
                self.assertEqual(sink.tell(), size)
                sink.close()
            with open(self.tmp / "back.bin", "wb") as out:
                crypto.decrypt_file(streamed, out, "pass phrase")
            self.assertEqual((self.tmp / "back.bin").read_bytes(), plain, size)
            (self.tmp / "plain.bin").write_bytes(plain)
            made = self.tmp / f"made-{size}.bin"
            with open(made, "wb") as out:
                crypto.encrypt_file(self.tmp / "plain.bin", out, "pass phrase")
            for encrypted in (streamed, made):
                view = crypto.DecryptedView(encrypted, "pass phrase")
                try:
                    self.assertEqual(view.read(), plain, size)
                    for at in {0, size // 3, max(size - 5, 0), crypto.CHUNK - 2}:
                        view.seek(at)
                        self.assertEqual(view.read(7), plain[at : at + 7], (size, at))
                    if size >= 3:
                        self.assertEqual(view.seek(-3, os.SEEK_END), size - 3)
                        self.assertEqual(view.read(), plain[-3:])
                    with self.assertRaises(OSError):  # zipfile relies on this to find a small file's end record
                        view.seek(-(size + 1), os.SEEK_END)
                finally:
                    view.close()

    @mock.patch.dict(crypto._SCRYPT, {"n": 1 << 10})
    def test_the_in_place_view_catches_a_wrong_passphrase_a_cut_off_file_and_a_changed_byte(self):
        plain = os.urandom(crypto.CHUNK * 2 + 10)
        (self.tmp / "plain.bin").write_bytes(plain)
        enc = self.tmp / "enc.bin"
        with open(enc, "wb") as out:
            crypto.encrypt_file(self.tmp / "plain.bin", out, "pass phrase")
        with self.assertRaises(crypto.BadPassphrase):
            crypto.DecryptedView(enc, "another one")
        full = enc.read_bytes()
        header_end = len(crypto.MAGIC) + 4 + int.from_bytes(full[len(crypto.MAGIC) : len(crypto.MAGIC) + 4], "big")
        first = int.from_bytes(full[header_end : header_end + 4], "big")
        (self.tmp / "short.bin").write_bytes(full[: header_end + 4 + first])  # cut off where a chunk ends
        view = crypto.DecryptedView(self.tmp / "short.bin", "pass phrase")
        with self.assertRaisesRegex(crypto.CorruptBackup, "incomplete"):
            view.seek(-22, os.SEEK_END)
            view.read()
        view.close()
        (self.tmp / "torn.bin").write_bytes(full[:-100])  # cut off inside a chunk
        with self.assertRaisesRegex(crypto.CorruptBackup, "incomplete"):
            crypto.DecryptedView(self.tmp / "torn.bin", "pass phrase")
        changed = bytearray(full)
        changed[header_end + 4 + first + 4 + 50] ^= 1  # inside the second chunk
        (self.tmp / "changed.bin").write_bytes(changed)
        view = crypto.DecryptedView(self.tmp / "changed.bin", "pass phrase")
        self.assertEqual(view.read(100), plain[:100])  # the first chunk is intact
        with self.assertRaisesRegex(crypto.CorruptBackup, "damaged"):
            view.read()
        view.close()


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

    def staged_same_pc(self, parts=("setup",)) -> Path:
        result = self.backup(parts=parts)
        (self.root / "profiles" / "chief" / "SOUL.md").write_text("Changed since the backup.\n", encoding="utf-8")
        state = self.tmp / "state"
        restore.stage(
            Path(result["path"]),
            "",
            parts=list(parts),
            hermes_root=self.root,
            app_dir=self.app,
            second_brain=None,
            current_second_brain=None,
            state_dir=state,
            app_version="1.0.0",
        )
        return state

    def leftovers(self) -> list[str]:
        marks = (".before-restore-", ".rolled-back-", ".chief-restore")
        return sorted(p.name for p in self.root.parent.iterdir() if any(m in p.name for m in marks))

    def test_a_crash_right_after_the_live_folder_is_moved_aside_is_recovered(self):
        state = self.staged_same_pc()
        # Dies the moment the first rename returns: before anything after it could be written down.
        script = (
            f"import os, sys; sys.path.insert(0, {str(ROOT)!r})\n"
            "from pathlib import Path; from chief_backup import restore\n"
            "real = os.replace\n"
            "def dying(src, dst):\n"
            "    real(src, dst)\n"
            f"    if os.fspath(src) == {str(self.root)!r}: os._exit(9)\n"
            "os.replace = dying\n"
            f"restore.apply(Path({str(state)!r}), safety_dir=Path({str(self.tmp / 'safety')!r}))\n"
        )
        self.assertEqual(subprocess.run([sys.executable, "-c", script]).returncode, 9)
        self.assertFalse(self.root.exists())
        self.assertEqual(restore.recover(state), {"ok": True, "action": "rolled-back"})
        self.assertEqual((self.root / "profiles" / "chief" / "SOUL.md").read_text(encoding="utf-8"), "Changed since the backup.\n")
        self.assertTrue((self.app / "settings.json").is_file())
        self.assertEqual(self.leftovers(), [])
        self.assertFalse((state / restore.JOURNAL).exists())

    def test_every_rename_is_in_the_journal_on_disk_before_it_happens(self):
        state = self.staged_same_pc()
        journal = os.fspath(state / restore.JOURNAL)
        events = []
        real_replace, real_fsync = os.replace, os.fsync

        def replace(src, dst):
            if os.fspath(dst) == journal:
                events.append(("journal", json.loads(Path(src).read_text(encoding="utf-8"))))
            else:
                events.append(("rename", os.fspath(src)))
            return real_replace(src, dst)

        def fsync(fd):
            events.append(("fsync", None))
            return real_fsync(fd)

        with mock.patch.object(restore.os, "replace", replace), mock.patch.object(restore.os, "fsync", fsync):
            restore.apply(state, safety_dir=self.tmp / "safety", app_version="1.0.0")
        moves = [i for i, (kind, what) in enumerate(events) if kind == "rename" and what in (str(self.root), str(self.app))]
        self.assertEqual(len(moves), 2)
        for i in moves:
            last = max(j for j in range(i) if events[j][0] == "journal")
            self.assertEqual(events[last - 1][0], "fsync")  # the journal's bytes reached the drive first
            self.assertEqual(events[last][1]["steps"][-1]["target"], events[i][1])  # and it named this rename
            self.assertFalse([e for e in events[last + 1 : i] if e[0] == "rename"])

    def test_a_rollback_that_cant_move_the_restored_folder_says_so_and_the_next_start_finishes_it(self):
        state = self.staged_same_pc()
        restore.apply(state, safety_dir=self.tmp / "safety", app_version="1.0.0")
        real = os.replace

        def in_use(src, dst):
            if os.fspath(dst).startswith(str(self.root) + ".rolled-back-"):
                raise PermissionError(13, "The process cannot access the file because it is being used by another process")
            return real(src, dst)

        with mock.patch.object(restore.os, "replace", in_use):
            self.assertEqual(restore.rollback(state), {"ok": False, "rolled_back": False, "error": restore._NOT_BACK})
        self.assertEqual(json.loads((state / restore.JOURNAL).read_text(encoding="utf-8"))["state"], "rolling-back")
        self.assertEqual((self.root / "profiles" / "chief" / "SOUL.md").read_text(encoding="utf-8"), "You are Chief.\n")  # restored, intact
        (previous,) = self.root.parent.glob("hermes.before-restore-*")
        self.assertEqual((previous / "profiles" / "chief" / "SOUL.md").read_text(encoding="utf-8"), "Changed since the backup.\n")
        self.assertEqual(restore.recover(state), {"ok": True, "action": "rolled-back"})
        self.assertEqual((self.root / "profiles" / "chief" / "SOUL.md").read_text(encoding="utf-8"), "Changed since the backup.\n")
        self.assertTrue((self.root / "bin" / "hermes.cmd").is_file())  # carried back with it
        self.assertEqual(self.leftovers(), [])
        self.assertFalse((state / restore.JOURNAL).exists())

    def test_a_rollback_that_cant_return_the_old_folder_leaves_the_restored_one_in_place(self):
        state = self.staged_same_pc()
        restore.apply(state, safety_dir=self.tmp / "safety", app_version="1.0.0")
        real = os.replace

        def in_use(src, dst):
            if os.fspath(src).startswith(str(self.root) + ".before-restore-"):
                raise PermissionError(13, "in use")
            return real(src, dst)

        with mock.patch.object(restore.os, "replace", in_use):
            self.assertFalse(restore.rollback(state)["ok"])
        self.assertEqual((self.root / "profiles" / "chief" / "SOUL.md").read_text(encoding="utf-8"), "You are Chief.\n")  # never left empty
        self.assertEqual(len(list(self.root.parent.glob("hermes.before-restore-*"))), 1)
        self.assertEqual(restore.rollback(state), {"ok": True, "rolled_back": True})
        self.assertEqual((self.root / "profiles" / "chief" / "SOUL.md").read_text(encoding="utf-8"), "Changed since the backup.\n")
        self.assertEqual(self.leftovers(), [])

    def test_a_journal_from_an_earlier_version_is_still_rolled_back(self):
        state = self.staged_same_pc()
        restore.apply(state, safety_dir=self.tmp / "safety", app_version="1.0.0")
        journal = json.loads((state / restore.JOURNAL).read_text(encoding="utf-8"))
        for step in journal["steps"]:
            del step["had_old"], step["aside"]
        (state / restore.JOURNAL).write_text(json.dumps(journal), encoding="utf-8")
        real = os.replace

        def in_use(src, dst):
            if os.fspath(src).startswith(str(self.root) + ".before-restore-"):
                raise PermissionError(13, "in use")
            return real(src, dst)

        # Cut short once: what it worked out about the old folders must not be read again from its own renames.
        with mock.patch.object(restore.os, "replace", in_use):
            self.assertFalse(restore.rollback(state)["ok"])
        self.assertEqual(restore.rollback(state), {"ok": True, "rolled_back": True})
        self.assertEqual((self.root / "profiles" / "chief" / "SOUL.md").read_text(encoding="utf-8"), "Changed since the backup.\n")
        self.assertTrue((self.app / "settings.json").is_file())
        self.assertEqual(self.leftovers(), [])

    def test_an_encrypted_backup_is_inspected_and_staged_without_a_decrypted_copy(self):
        temp = self.tmp / "temp"
        temp.mkdir()
        result = self.backup(passphrase="pass phrase here")
        root, app, vault, state, safety = self.new_pc()
        nowhere = AssertionError("a temporary folder for a decrypted copy")
        with mock.patch.object(tempfile, "tempdir", str(temp)), mock.patch.object(tempfile, "mkdtemp", side_effect=nowhere):
            self.assertTrue(restore.inspect(Path(result["path"]), "pass phrase here", app_version="1.0.0")["secrets_included"])
            restore.stage(
                Path(result["path"]),
                "pass phrase here",
                parts=["setup", "second-brain"],
                hermes_root=root,
                app_dir=app,
                second_brain=vault,
                current_second_brain=None,
                state_dir=state,
                app_version="1.0.0",
            )
        self.assertEqual(list(temp.iterdir()), [])
        self.assertEqual([p.name for p in state.iterdir()], [restore.JOURNAL])
        self.assertEqual([p.name for p in self.dest.iterdir()], [Path(result["path"]).name])
        self.assertEqual(list(self.tmp.rglob("*.zip")), [])


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

    def test_a_backup_that_cant_be_made_private_says_so_by_code(self):
        # The app then makes the pre-update backup in its own data folder instead (apps/desktop runtime.ts).
        args = [
            "backup",
            "--dest",
            str(self.dest),
            "--parts",
            "setup",
            "--kind",
            "pre-update",
            "--local",
            "--hermes-root",
            str(self.root),
            "--app-version",
            "1.0.0",
        ]
        with mock.patch.object(archive, "owner_only", return_value=False):
            code, result = self.run_cli(args)
        self.assertEqual((code, result.get("code")), (1, "not-private"))


if __name__ == "__main__":
    unittest.main()
