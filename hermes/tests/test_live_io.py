"""Live I/O: outbox growth and compaction, HTTP byte ranges for served files, and many long-polls woken by one change."""

import importlib
import io
import json
import random
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
RUNTIME = ROOT / "hermes/tests/.runtime"
package = types.ModuleType("test_live_io_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(RUNTIME / "hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
data = importlib.import_module("test_live_io_plugin.data")
changes = importlib.import_module("test_live_io_plugin.changes")
outbox = importlib.import_module("test_live_io_plugin.outbox")
server = importlib.import_module("test_live_io_plugin.server")
routes = importlib.import_module("test_live_io_plugin.routes")


def row(i: int, at: float, message: str = "") -> dict:
    return {"id": f"r{i:05d}", "at": at, "chat_id": "owner", "message": message or f"notice {i}", "source": "adapter", "read": False}


class LiveTestCase(unittest.TestCase):
    """A throwaway Hermes root with the chief's profile; the outbox lives there."""

    def setUp(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=RUNTIME)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.home = self.root / "profiles" / "chief"
        self.home.mkdir(parents=True)
        patcher = patch.object(data, "install_root", lambda: self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        outbox._cache.update(path="", offset=0, rows=[], times=[])
        self.addCleanup(outbox._cache.update, path="", offset=0, rows=[], times=[])
        self.path = self.home / "command_center_outbox.jsonl"

    def lines(self) -> list[str]:
        return self.path.read_text(encoding="utf-8").splitlines()


# ---------------------------------------------------------------------------------------------- outbox


class OutboxGrowthTests(LiveTestCase):
    def test_an_append_past_the_size_limit_compacts_the_file(self):
        old = time.time() - 40 * 86400
        self.path.write_text("".join(json.dumps(row(i, old + i, "x" * 80)) + "\n" for i in range(400)), encoding="utf-8")
        before = self.path.stat().st_size
        with patch.object(outbox, "COMPACT_BYTES", 20_000), patch.object(outbox, "KEEP_MIN_ROWS", 50):
            self.assertEqual(len(outbox.read_outbox(limit=10_000)), 400)
            newest = outbox.append_outbox("owner", "fresh notice")
        self.assertLess(self.path.stat().st_size, before)
        kept = outbox.read_outbox(limit=10_000)
        self.assertEqual(len(kept), 50, "old rows go, but never below the newest KEEP_MIN_ROWS")
        self.assertEqual(kept[0]["id"], "r00351")
        self.assertEqual((kept[-1]["id"], outbox.head_id()), (newest, newest))
        self.assertEqual(len(self.lines()), 50)
        self.assertFalse(self.path.with_name(self.path.name + ".tmp").exists())

    def test_a_small_file_is_never_compacted(self):
        old = time.time() - 40 * 86400
        self.path.write_text("".join(json.dumps(row(i, old)) + "\n" for i in range(10)), encoding="utf-8")
        outbox.append_outbox("owner", "fresh")
        self.assertEqual(len(self.lines()), 11)
        self.assertEqual(outbox.compact(), 0, "fewer rows than KEEP_MIN_ROWS: nothing goes")

    def test_reads_follow_the_file_as_it_grows_and_after_it_shrinks(self):
        first = [outbox.append_outbox("owner", f"mine {i}") for i in range(3)]
        self.assertEqual([r["id"] for r in outbox.read_outbox()], first)
        self.assertEqual(outbox._cache["offset"], self.path.stat().st_size, "everything read is remembered by offset")
        with open(self.path, "a", encoding="utf-8") as f:  # another process (a scheduled job) appends
            f.write(json.dumps(row(1, time.time())) + "\n" + json.dumps(row(2, time.time())) + "\n")
        self.assertEqual([r["id"] for r in outbox.read_outbox()][-2:], ["r00001", "r00002"])
        self.assertEqual(len(outbox.read_outbox()), 5)
        # Another process compacted it: a smaller file is read again from the start.
        self.path.write_text(json.dumps(row(9, time.time())) + "\n", encoding="utf-8")
        self.assertEqual([r["id"] for r in outbox.read_outbox()], ["r00009"])
        self.path.unlink()
        self.assertEqual((outbox.read_outbox(), outbox.head_id()), ([], ""))

    def test_compaction_backs_off_when_another_process_appends_meanwhile(self):
        now = time.time()
        rows = [row(i, now - 40 * 86400) for i in range(600)] + [row(600, now)]
        self.path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        real_write_text = Path.write_text

        def write_then_race(target, *args, **kwargs):
            written = real_write_text(target, *args, **kwargs)
            if target.name.endswith(".tmp"):
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(row(601, now)) + "\n")
            return written

        with patch.object(Path, "write_text", write_then_race):
            self.assertEqual(outbox.compact(now), 0)
        self.assertEqual(len(self.lines()), 602, "nothing lost, the racing row included")
        self.assertFalse(self.path.with_name(self.path.name + ".tmp").exists())
        self.assertEqual(outbox.compact(now), 602 - outbox.KEEP_MIN_ROWS, "the next try succeeds")

    def test_many_threads_appending_at_once_lose_and_tear_nothing(self):
        ids: list[str] = []
        lock = threading.Lock()

        def writer(n):
            for i in range(40):
                mid = outbox.append_outbox("owner", f"writer {n} line {i} " + "é" * 20)
                with lock:
                    ids.append(mid)

        workers = [threading.Thread(target=writer, args=(n,)) for n in range(8)]
        for w in workers:
            w.start()
        for w in workers:
            w.join(10)
        self.assertEqual(len(ids), 320)
        self.assertEqual(len(set(ids)), 320)
        parsed = [json.loads(line) for line in self.lines()]
        self.assertEqual(sorted(r["id"] for r in parsed), sorted(ids))
        self.assertEqual(sorted(r["id"] for r in outbox.read_outbox(limit=1000)), sorted(ids))

    def test_lines_that_are_not_rows_are_skipped(self):
        good = row(1, time.time())
        self.path.write_text("not json\n[1, 2]\n\n   \n" + json.dumps(good) + "\n" + '"a string"\n', encoding="utf-8")
        self.assertEqual(outbox.read_outbox(), [good])

    def test_paging_by_id_and_limit(self):
        ids = [outbox.append_outbox("owner", f"n{i}") for i in range(10)]
        self.assertEqual([r["id"] for r in outbox.read_outbox(limit=3)], ids[:3])
        self.assertEqual([r["id"] for r in outbox.read_outbox(after_id=ids[2], limit=3)], ids[3:6])
        self.assertEqual(outbox.read_outbox(after_id=ids[-1]), [])

    def test_read_since_after_compaction(self):
        now = time.time()
        rows = [row(i, now - 40 * 86400 + i) for i in range(550)] + [row(550 + i, now - 30 + i) for i in range(3)]
        self.path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        self.assertEqual([r["id"] for r in outbox.read_since(now - 60)], ["r00550", "r00551", "r00552"])
        outbox.compact(now)
        self.assertEqual([r["id"] for r in outbox.read_since(now - 60)], ["r00550", "r00551", "r00552"])
        self.assertEqual(outbox.read_since(now + 60), [])


# ---------------------------------------------------------------------------------------------- byte ranges


class ByteRangeTests(unittest.TestCase):
    def test_satisfiable_ranges(self):
        cases = [
            ("bytes=0-0", 1000, (0, 0, True)),
            ("bytes=999-", 1000, (999, 999, True)),
            ("bytes=-1", 1000, (999, 999, True)),
            ("bytes=500-999", 1000, (500, 999, True)),
            ("bytes= 10-20 , 30-40", 1000, (10, 20, True)),  # several ranges: the first is served
            ("bytes=0-5", 1, (0, 0, True)),
        ]
        for header, size, expected in cases:
            with self.subTest(header=header, size=size):
                self.assertEqual(server.byte_range(header, size), expected)

    def test_unsatisfiable_or_backwards_ranges_are_the_whole_file(self):
        for header in ("bytes=-0", "bytes=--5", "bytes=5-3", "bytes=1000-", "bytes=2000-2100", "bytes=5--3", "bytes=a-", "items=0-10"):
            with self.subTest(header=header):
                self.assertEqual(server.byte_range(header, 1000), (0, 999, False))

    def test_every_answer_is_a_real_span_of_the_file(self):
        rng = random.Random(7)
        parts = ["", "0", "1", "5", "-3", "999", "1000", "1001", "99999", "x", " "]
        bad = set()
        for _ in range(2000):
            size = rng.choice([1, 2, 10, 1000])
            header = f"bytes={rng.choice(parts)}-{rng.choice(parts)}"
            start, end, partial = server.byte_range(header, size)
            if not 0 <= start <= end < size or (not partial and (start, end) != (0, size - 1)):
                bad.add((header, size, start, end, partial))
        self.assertEqual(sorted(bad), [])


class FakeHandler:
    def __init__(self, range_header: str = ""):
        self.headers = {"Range": range_header} if range_header else {}
        self.status = 0
        self.sent: dict[str, str] = {}
        self.wfile = io.BytesIO()

    def send_response(self, code):
        self.status = code

    def send_header(self, name, value):
        self.sent[name] = value

    def end_headers(self):
        pass

    def _reject(self, code, message):
        self.status = code


class FileRouteTests(LiveTestCase):
    def setUp(self):
        super().setUp()
        self.blob = bytes(range(256)) * 300  # 76 800 bytes, more than one 64 KB chunk
        self.file = self.root / "clip.mp3"
        self.file.write_bytes(self.blob)
        for name, value in (
            ("warm_media_cache", lambda key: None),
            ("file_is_allowed", lambda raw: (Path(raw), "audio/mpeg") if raw == str(self.file) else None),
        ):
            patcher = patch.object(data, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
        bridge.binding = lambda: {"sessionKey": "session"}
        self.route = routes.find(routes.build(bridge), "GET", "/file")

    def get(self, range_header: str = "", path: str = "") -> FakeHandler:
        handler = FakeHandler(range_header)
        self.route.run(routes.Request(handler=handler, path="/file", qs={"path": [path or str(self.file)]}))
        return handler

    def test_a_range_is_served_as_partial_content(self):
        h = self.get("bytes=70000-")
        self.assertEqual(h.status, 206)
        self.assertEqual(h.sent["Content-Range"], f"bytes 70000-{len(self.blob) - 1}/{len(self.blob)}")
        self.assertEqual(h.sent["Content-Length"], str(len(self.blob) - 70000))
        self.assertEqual(h.wfile.getvalue(), self.blob[70000:])
        h = self.get("bytes=-100")
        self.assertEqual(h.wfile.getvalue(), self.blob[-100:])

    def test_no_range_or_an_unsatisfiable_one_is_the_whole_file(self):
        for header in ("", "bytes=-0", f"bytes={len(self.blob)}-", "bytes=9-3"):
            with self.subTest(header=header):
                h = self.get(header)
                self.assertEqual(h.status, 200)
                self.assertNotIn("Content-Range", h.sent)
                self.assertEqual(h.sent["Content-Length"], str(len(self.blob)))
                self.assertEqual(h.wfile.getvalue(), self.blob)
                self.assertEqual(h.sent["Accept-Ranges"], "bytes")

    def test_a_path_that_is_not_allowed_is_not_found(self):
        h = self.get("bytes=0-10", path=str(self.root / "other.mp3"))
        self.assertEqual((h.status, h.wfile.getvalue()), (404, b""))


# ---------------------------------------------------------------------------------------------- long-polls


def run_all(target, count: int) -> list[threading.Thread]:
    workers = [threading.Thread(target=target, args=(i,), daemon=True) for i in range(count)]
    for w in workers:
        w.start()
    return workers


class SignalFanOutTests(unittest.TestCase):
    def test_one_bump_wakes_every_waiter(self):
        start = changes.version()
        woke: dict[int, tuple[int, float]] = {}
        workers = run_all(lambda i: woke.__setitem__(i, (changes.wait(start, 5.0), time.monotonic())), 8)
        time.sleep(0.2)
        self.assertEqual(woke, {}, "nobody returns before the change")
        bumped = time.monotonic()
        changes.bump("test")
        for w in workers:
            w.join(3)
        self.assertEqual(len(woke), 8)
        self.assertEqual({v for v, _ in woke.values()}, {start + 1})
        self.assertLess(max(t for _, t in woke.values()) - bumped, 1.0)

    def test_bumps_from_many_threads_are_all_counted(self):
        start = changes.version()
        workers = run_all(lambda i: [changes.bump("many") for _ in range(250)], 8)
        for w in workers:
            w.join(5)
        self.assertEqual(changes.version(), start + 2000)

    def test_a_late_waiter_with_an_old_version_returns_at_once(self):
        old = changes.version()
        changes.bump("before")
        t0 = time.monotonic()
        self.assertEqual(changes.wait(old, 5.0), old + 1)
        self.assertLess(time.monotonic() - t0, 0.5)
        self.assertEqual(changes.wait(old + 1, 0), old + 1, "a zero timeout never blocks")


class LongPollFanOutTests(LiveTestCase):
    """Several dashboard long-polls (phone, desktop, a second window) are woken together by one outbox row."""

    def setUp(self):
        super().setUp()
        conn = sqlite3.connect(self.home / "state.db")
        conn.executescript("""
            CREATE TABLE sessions (id TEXT, session_key TEXT, last_activity_at INTEGER, source TEXT);
            INSERT INTO sessions VALUES ('s', 'session', 1, 'command_center');
            CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT, content TEXT, timestamp TEXT,
                                   tool_calls TEXT, session_id TEXT, active INTEGER);
        """)
        conn.executemany("INSERT INTO messages VALUES (?, 'assistant', ?, '1', NULL, 's', 1)", [(i, f"reply {i}") for i in range(1, 6)])
        conn.commit()
        conn.close()
        self.bridge = server.BridgeServer(token="t", port=0, session_key_override="", inject=lambda *_: True)
        self.bridge.binding = lambda: {"sessionKey": "session"}
        for target, name, value in ((server, "_LONGPOLL_STEP", 10.0), (data, "pending_approval", lambda key: None)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_one_outbox_row_wakes_every_waiting_long_poll(self):
        head = outbox.append_outbox("", "earlier notice")
        answers: dict[int, tuple[dict, float]] = {}

        def poll(i):
            payload = self.bridge.live_transcript(5, wait=5, gen="0", approval="", clarify="", notice=head)
            answers[i] = (payload, time.monotonic())

        workers = run_all(poll, 5)
        time.sleep(0.3)
        self.assertEqual(answers, {}, "every long-poll holds while nothing changes")
        sent = time.monotonic()
        newest = outbox.append_outbox("", "Your routine finished.")
        for w in workers:
            w.join(5)
        self.assertEqual(len(answers), 5)
        for payload, at in answers.values():
            self.assertEqual(payload["noticeHead"], newest)
            self.assertEqual(payload["messages"], [])
            self.assertTrue(payload["longpoll"])
            self.assertLess(at - sent, 2.0, "woken by the signal, not the fallback timer")
        self.assertEqual([n["text"] for n in answers[0][0]["notices"]], ["earlier notice", "Your routine finished."])


if __name__ == "__main__":
    unittest.main()
