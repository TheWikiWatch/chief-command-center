"""Isolated bridge contracts. No Hermes process, real credentials or external writes."""
import base64
import importlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
package = types.ModuleType("test_bridge_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules[package.__name__] = package
constants = types.ModuleType("hermes_constants")
constants.get_default_hermes_root = lambda: str(ROOT / "hermes/tests/.runtime/hermes")
constants.named_profile_is_deleted = lambda _: False
sys.modules["hermes_constants"] = constants
# No PyYAML install is needed for these boundary tests. Parsing itself is not mocked in production.
try:
    import yaml
except ImportError:
    yaml = types.ModuleType("yaml")
    yaml.load = lambda text, **kwargs: json.loads(text)
    loader = types.ModuleType("yaml.loader")
    loader.SafeLoader = object
    sys.modules["yaml"] = yaml
    sys.modules["yaml.loader"] = loader
data = importlib.import_module("test_bridge_plugin.data")
server = importlib.import_module("test_bridge_plugin.server")
media = importlib.import_module("test_bridge_plugin.media")
vapid = importlib.import_module("test_bridge_plugin.vapid")
webpush = importlib.import_module("test_bridge_plugin.webpush")
identity = importlib.import_module("test_bridge_plugin.identity")
bridge_token = importlib.import_module("test_bridge_plugin.bridge_token")


class BridgeTokenTests(unittest.TestCase):
    """The token is read once and leaves the environment, so the agent's commands can't inherit it."""

    def tearDown(self):
        bridge_token._token = ""
        os.environ.pop(bridge_token.ENV, None)

    def test_take_removes_it_from_the_environment(self):
        os.environ[bridge_token.ENV] = "  secret-from-desktop  "
        self.assertEqual(bridge_token.take(""), "secret-from-desktop")
        self.assertNotIn(bridge_token.ENV, os.environ)
        self.assertEqual(bridge_token.get(), "secret-from-desktop")

    def test_plugin_config_wins_and_the_environment_is_still_cleared(self):
        os.environ[bridge_token.ENV] = "from-env"
        self.assertEqual(bridge_token.take("from-config"), "from-config")
        self.assertNotIn(bridge_token.ENV, os.environ)

    def test_a_second_take_keeps_the_first_token(self):
        os.environ[bridge_token.ENV] = "first"
        bridge_token.take("")
        self.assertEqual(bridge_token.take(""), "first")


class BridgeTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.home = Path(self.temp.name).resolve()
        assert self.home.is_relative_to(scratch.resolve())
        self.addCleanup(self.temp.cleanup)
        self.patch_home = patch.object(data, "chief_home", return_value=self.home)
        self.patch_home.start()
        self.addCleanup(self.patch_home.stop)
        data._recent_media_paths.clear()

    def database(self):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.executescript("""
            CREATE TABLE sessions (id TEXT, session_key TEXT, last_activity_at INTEGER, source TEXT);
            INSERT INTO sessions VALUES ('s', 'session', 1, 'discord');
            CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT, content TEXT, timestamp TEXT,
                                   tool_calls TEXT, session_id TEXT, active INTEGER);
        """)
        return conn

    def test_filtered_rows_advance_cursor_without_losing_reply(self):
        with self.database() as conn:
            conn.executemany("INSERT INTO messages VALUES (?, 'tool', '', '', NULL, 's', 1)", [(i,) for i in range(2, 722)])
            conn.execute("INSERT INTO messages VALUES (722, 'assistant', 'later reply', '', NULL, 's', 1)")
        first = data.transcript("session", after_id=1)
        self.assertEqual(first["messages"], [])
        self.assertEqual(first["lastId"], 721)
        second = data.transcript("session", after_id=first["lastId"])
        self.assertEqual([m["id"] for m in second["messages"]], [722])

    def test_scheduled_messages_copied_into_the_chat_stay_out_of_it(self):
        # The morning brief is mirrored into the session (attach_to_session) so Chief knows its questions;
        # the chat shows it once, as a notice, never as the owner's own message.
        with self.database() as conn:
            conn.executemany("INSERT INTO messages VALUES (?, ?, ?, '1', NULL, 's', 1)", [
                (2, "user", "[Cron delivery: Second Brain: morning brief]\n# Morning brief\n1. Pick a date?"),
                (3, "user", "1. Friday"),
                (4, "assistant", "Filed: Friday."),
            ])
        page = data.transcript("session", after_id=1)
        self.assertEqual([m["id"] for m in page["messages"]], [3, 4])
        self.assertEqual(page["lastId"], 4)

    def test_compaction_copies_are_marked_as_replays(self):
        # Rows 2-4 are the originals. Compaction archives them and re-inserts the tail as 6-8, stamped
        # at the marker's time (assistant) or their old time (user). 9 is a genuinely new reply.
        db = self.database()
        with db as conn:
            conn.executemany("INSERT INTO messages VALUES (?, ?, ?, ?, NULL, 's', 0)", [
                (2, "user", "status?", "100.0"), (3, "assistant", "all green", "101.0"), (4, "assistant", "next up", "102.0"),
            ])
            conn.executemany("INSERT INTO messages VALUES (?, ?, ?, ?, NULL, 's', 1)", [
                (5, "user", "[CONTEXT COMPACTION] summary", "500.0"),
                (6, "user", "status?", "100.0"), (7, "assistant", "all green", "500.0"), (8, "assistant", "next up", "500.0"),
                (9, "assistant", "fresh reply", "503.5"),
            ])
        page = data.transcript("session", after_id=4)
        self.assertEqual([(m["id"], bool(m.get("replay"))) for m in page["messages"]],
                         [(5, False), (6, True), (7, True), (8, True), (9, False)])
        # A reader that joins after the compaction pages past the block and sees nothing flagged.
        self.assertEqual([m.get("replay") for m in data.transcript("session", after_id=8)["messages"]], [None])
        # Right after a compaction, before any new row, the whole tail is still a replay.
        with db as conn:
            conn.execute("DELETE FROM messages WHERE id = 9")
        self.assertTrue(all(m.get("replay") for m in data.transcript("session", after_id=5)["messages"]))

    def test_visible_limit_does_not_skip_next_page(self):
        with self.database() as conn:
            conn.executemany("INSERT INTO messages VALUES (?, 'assistant', 'reply', '', NULL, 's', 1)", [(i,) for i in range(2, 252)])
        first = data.transcript("session", after_id=1)
        second = data.transcript("session", after_id=first["lastId"])
        self.assertEqual(len(first["messages"]), 120)
        self.assertEqual(second["messages"][0]["id"], 122)

    def test_token_is_denied_under_root_and_when_remembered(self):
        token = self.home / ".token"
        token.write_text("synthetic-not-a-credential", encoding="utf-8")
        image = self.home / "picture.png"
        image.write_bytes(b"synthetic")
        with patch.object(data, "_allow_roots", return_value=[self.home]):
            self.assertIsNone(data.file_is_allowed(str(token)))
            data.remember_media_path(str(token))
            self.assertIsNone(data.file_is_allowed(str(token)))
            self.assertEqual(data.file_is_allowed(str(image))[1], "image/png")

    def test_sqlite_files_and_streams_are_never_served(self):
        for name in ("state.db", "state.db-wal", "state.db-shm", "kanban.db", "cache.sqlite3"):
            (self.home / name).write_bytes(b"synthetic")
        image = self.home / "picture.png"
        image.write_bytes(b"synthetic")
        with patch.object(data, "_allow_roots", return_value=[self.home]):
            for name in ("state.db", "state.db-wal", "state.db-shm", "kanban.db", "cache.sqlite3"):
                data.remember_media_path(str(self.home / name))
                self.assertIsNone(data.file_is_allowed(str(self.home / name)), name)
            self.assertIsNone(data.file_is_allowed(str(image) + ":hidden"))
            self.assertIsNone(data.file_is_allowed(str(image) + "::$DATA"))
            self.assertIsNotNone(data.file_is_allowed(str(image)))

    def test_hermes_logs_sessions_and_config_are_never_served(self):
        root = self.home / "hermes-root"
        for rel in ("logs/gateway.log", "sessions/sessions.json", "memories/MEMORY.md", "profiles/chief/config.yaml",
                    "profiles/chief/logs/agent.png", "image_cache/shot.png"):
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_bytes(b"synthetic")
        with patch.object(data, "install_root", return_value=root), patch.object(data, "_allow_roots", return_value=[root]):
            for rel in ("logs/gateway.log", "sessions/sessions.json", "memories/MEMORY.md", "profiles/chief/config.yaml", "profiles/chief/logs/agent.png"):
                data.remember_media_path(str(root / rel))
                self.assertIsNone(data.file_is_allowed(str(root / rel)), rel)
            self.assertEqual(data.file_is_allowed(str(root / "image_cache/shot.png"))[1], "image/png")

    def test_only_media_paths_are_remembered_and_the_memory_is_bounded(self):
        outside = self.home / "outside"
        outside.mkdir()
        (outside / "notes.ini").write_text("synthetic", encoding="utf-8")
        (outside / "chart.png").write_bytes(b"synthetic")
        with patch.object(data, "_allow_roots", return_value=[]):
            data.remember_media_path(str(outside / "notes.ini"))
            self.assertIsNone(data.file_is_allowed(str(outside / "notes.ini")))
            data.remember_media_path(str(outside / "chart.png"))
            self.assertIsNotNone(data.file_is_allowed(str(outside / "chart.png")))
        for i in range(data._RECENT_MEDIA_MAX + 50):
            data.remember_media_path(f"D:/synthetic/{i}.png")
        self.assertLessEqual(len(data._recent_media_paths), data._RECENT_MEDIA_MAX)

    def test_profile_names_cannot_leave_the_profiles_folder(self):
        for name in ("..", "../..", "chief/../..", "Chief", "a" * 70, ""):
            self.assertEqual(data.profile_peek(name), {"ok": False, "error": "unknown profile"}, name)
            self.assertIsNone(data.avatar_bytes(name), name)

    def handler(self, bridge, path, body: bytes, length=None):
        handler_class = server._make_handler(bridge)
        h = object.__new__(handler_class)
        h.path = path
        h.command = "POST"
        h.headers = {"Content-Length": str(len(body) if length is None else length), "Authorization": "Bearer test"}
        h.client_address = ("127.0.0.1", 1)
        h.rfile = types.SimpleNamespace(read=lambda n: body[:n])
        out = {}
        h._reject = lambda code, msg: out.update(code=code, error=msg)
        h._json = lambda payload, code=200: out.update(code=code, payload=payload)
        return h, out

    def test_cut_off_body_is_reported_not_treated_as_empty(self):
        bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
        sent = []
        bridge.send = lambda *a: sent.append(a) or {"ok": True}
        for body in (b'{"text": "hi", "attachments": [{"data_url": "data:', b"[1, 2]"):
            h, out = self.handler(bridge, "/send", body)
            h.do_POST()
            self.assertEqual(out["code"], 400)
        h, out = self.handler(bridge, "/send", b"{}", length=-1)
        h.do_POST()
        self.assertEqual(out["code"], 400)
        self.assertEqual(sent, [])
        h, out = self.handler(bridge, "/send", b'{"text": "hi"}')
        h.do_POST()
        self.assertEqual(out["payload"], {"ok": True})

    def test_token_in_query_string_is_not_accepted(self):
        bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
        h, _ = self.handler(bridge, "/health?token=test", b"")
        h.headers = {}
        self.assertFalse(h._authorized())
        h.headers = {"Authorization": "Bearer test"}
        self.assertTrue(h._authorized())

    def test_failed_send_leaves_no_uploads_behind(self):
        image = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n").decode("ascii")
        inbound = self.home / "cache" / "inbound"
        with patch.dict(os.environ, {"COMMAND_CENTER_ENABLED": "1"}):
            bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
            bridge._started -= 600  # past start-up: no waiting for an adapter that isn't coming
            with patch.object(data, "resolve_session_key", return_value={"sessionKey": "agent:main:command_center:dm:owner", "platform": "command_center"}):
                detached = bridge.send("look", [{"name": "a.png", "mime": "image/png", "data_url": image}])
                self.assertFalse(detached["ok"])
                self.assertFalse(inbound.exists() and any(inbound.iterdir()))

                class Refuses:
                    def queue_user_text(self, *_):
                        return False

                bridge.command_center_adapter = Refuses()
                with patch.object(server, "_live_command_center_adapter", return_value=None):
                    refused = bridge.send("look", [{"name": "a.png", "mime": "image/png", "data_url": image}])
        self.assertFalse(refused["ok"])
        self.assertEqual(list(inbound.iterdir()), [])

    def test_retry_with_same_send_id_reaches_chief_once(self):
        queued = []

        class Adapter:
            def __init__(self):
                self.accept = False

            def queue_user_text(self, text, media=None, message_type="text"):
                queued.append(text)
                return self.accept

        adapter = Adapter()
        with patch.dict(os.environ, {"COMMAND_CENTER_ENABLED": "1"}):
            bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
            bridge.command_center_adapter = adapter
            bind = {"sessionKey": "agent:main:command_center:dm:owner", "platform": "command_center"}
            with patch.object(data, "resolve_session_key", return_value=bind), patch.object(server, "_live_command_center_adapter", return_value=None):
                self.assertFalse(bridge.send("hi", [], "id-1")["ok"])  # refused: the id stays reusable
                adapter.accept = True
                self.assertTrue(bridge.send("hi", [], "id-1")["ok"])
                again = bridge.send("hi", [], "id-1")
                self.assertTrue(again["ok"])
                self.assertTrue(again.get("duplicate"))
                self.assertTrue(bridge.send("hi", [], "id-2")["ok"])
                self.assertTrue(bridge.send("hi", [])["ok"])
        self.assertEqual(len(queued), 4)

    def test_media_tag_only_takes_real_paths(self):
        # Prose that mentions MEDIA: stays text; it used to become a fake file chip.
        text, atts = data._extract_media_from_text("The MEDIA: tag lists files (preview, auth). It powers the thumbnails.md")
        self.assertEqual(atts, [])
        self.assertIn("MEDIA: tag lists files", text)
        # Real paths still become attachments, including paths with spaces and several tags.
        text, atts = data._extract_media_from_text("Here you go\nMEDIA:C:\\Users\\me\\My Pictures\\a b.png MEDIA:E:/clips/x.mp4")
        self.assertEqual([a["name"] for a in atts], ["a b.png", "x.mp4"])
        self.assertEqual(text, "Here you go")
        # A path followed by more words on the same line keeps the words as text.
        text, atts = data._extract_media_from_text("MEDIA:C:\\out\\report.pdf is ready for review")
        self.assertEqual([a["name"] for a in atts], ["report.pdf"])
        self.assertEqual(text, "is ready for review")
        text, atts = data._extract_media_from_text("MEDIA:https://example.com/p.png")
        self.assertEqual([a["kind"] for a in atts], ["image"])

    def test_platform_fallback_and_attachment(self):
        env = {"COMMAND_CENTER_ENABLED": "1"}
        discord_keys = ["agent:main:discord:group:1546:owner"]
        with patch.object(data, "_allowed_user_id", return_value="owner"), patch.object(data, "_session_keys_from_db", return_value=discord_keys), patch.dict(os.environ, env):
            bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
            bound = bridge.binding()
            self.assertEqual(bound["platform"], "command_center")
            self.assertNotIn("discord", bound["sessionKey"])
            bridge.command_center_adapter = object()
            self.assertEqual(bridge.binding()["platform"], "command_center")
            pending = data.resolve_session_key("agent:main:command_center:dm:owner")
            self.assertEqual(pending["kind"], "command_center-pending")
            self.assertEqual(pending["sessionKey"], "agent:main:command_center:dm:owner")
            self.assertFalse(pending["bound"])

    def test_discord_fallback_only_when_command_center_disabled(self):
        with patch.object(data, "_allowed_user_id", return_value="owner"), patch.object(data, "_session_keys_from_db", return_value=["agent:main:discord:dm:owner"]), patch.dict(os.environ, {"COMMAND_CENTER_ENABLED": "0"}):
            bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
            self.assertEqual(bridge.binding()["platform"], "discord")

    def test_uploads_are_staged_inlined_and_handed_to_chief(self):
        note = b"hello from the file"
        payload = "data:text/plain;base64," + base64.b64encode(note).decode("ascii")
        image = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n").decode("ascii")
        staged = data.stage_uploads([
            {"name": "notes.txt", "mime": "text/plain", "data_url": payload},
            {"name": "shot.png", "mime": "image/png", "data_url": image},
        ])
        self.assertEqual(staged[0]["inline"], "hello from the file")
        self.assertFalse(staged[1]["inline"])
        self.assertTrue(Path(staged[0]["path"]).is_file())
        composed = data.compose_user_turn("look", staged)
        self.assertIn("MEDIA:", composed["text"])
        self.assertIn("[Content of notes.txt]:", composed["text"])
        self.assertEqual(composed["message_type"], "document")
        self.assertTrue(composed["media"][0]["inlined"])
        visible, attachments = data.parse_message_content(
            "[The user sent a document: 'notes.txt'. It is saved at: "
            + staged[0]["path"]
            + "]\n\n"
            + composed["text"]
        )
        visible = data.strip_agent_attachment_notes(visible)
        self.assertEqual(visible, "look")
        self.assertEqual(len(attachments), 2)
        seen = {}

        class Adapter:
            def queue_user_text(self, text, media=None, message_type="text"):
                seen["text"] = text
                seen["media"] = media
                seen["message_type"] = message_type
                return True

        with patch.dict(os.environ, {"COMMAND_CENTER_ENABLED": "1"}):
            bridge = server.BridgeServer(
                token="test",
                port=0,
                session_key_override="agent:main:command_center:dm:owner",
                inject=lambda *_: False,
            )
            bridge.command_center_adapter = Adapter()
            with patch.object(data, "resolve_session_key", return_value={"sessionKey": "agent:main:command_center:dm:owner", "platform": "command_center", "kind": "dm"}):
                result = bridge.send("look", [
                    {"name": "notes.txt", "mime": "text/plain", "data_url": payload},
                    {"name": "shot.png", "mime": "image/png", "data_url": image},
                ])
        self.assertTrue(result["ok"])
        self.assertEqual(seen["message_type"], "document")
        self.assertEqual(len(seen["media"]), 2)
        self.assertIn("look", seen["text"])

    def test_send_does_not_inject_into_discord_when_command_center_enabled(self):
        injected = []
        with patch.dict(os.environ, {"COMMAND_CENTER_ENABLED": "1"}):
            bridge = server.BridgeServer(
                token="test",
                port=0,
                session_key_override="agent:main:discord:group:1546:owner",
                inject=lambda text, sk: injected.append((text, sk)) or True,
            )
            bridge._started -= 600  # long past start-up: a missing adapter is a fault, reported at once
            started = time.monotonic()
            result = bridge.send("hello")
        self.assertFalse(result["ok"])
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(injected, [])
        self.assertIn("not attached", result["error"].lower())

    def test_a_send_right_after_start_waits_for_the_adapter(self):
        received = []

        class Adapter:
            def queue_user_text(self, text, media=None, message_type="text"):
                received.append(text)
                return True

        with patch.dict(os.environ, {"COMMAND_CENTER_ENABLED": "1"}):
            bridge = server.BridgeServer(token="test", port=0, session_key_override="agent:main:command_center:dm:owner", inject=lambda text, sk: False)
            threading.Timer(0.6, lambda: setattr(bridge, "command_center_adapter", Adapter())).start()
            result = bridge.send("hello")
        self.assertTrue(result["ok"], result)
        self.assertEqual(received, ["hello"])

    def test_approval_requires_specific_request(self):
        self.assertFalse(data.resolve_approval("session", "", "always")["ok"])

    def test_events_reaches_sse_not_avatar_handler(self):
        bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
        handler_class = server._make_handler(bridge)
        handler = object.__new__(handler_class)
        handler.path = "/events"
        handler._authorized = lambda: True
        called = []
        handler._sse = lambda: called.append("sse")
        handler.do_GET()
        self.assertEqual(called, ["sse"])

    def test_yaml_cache_returns_independent_values(self):
        fixture = self.home / "config.yaml"
        fixture.write_text('{"model": {"name": "test"}}', encoding="utf-8")
        first = data.load_yaml(fixture)
        first["model"]["name"] = "changed"
        self.assertEqual(data.load_yaml(fixture)["model"]["name"], "test")


class MediaHelperTests(unittest.TestCase):
    def test_cache_key_changes_with_file(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            f = Path(tmp) / "a.mp4"
            f.write_bytes(b"123")
            k1 = media._key(f)
            f.write_bytes(b"1234")
            self.assertNotEqual(k1, media._key(f))

    def test_preview_skips_small_and_huge(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            f = Path(tmp) / "small.mp4"
            f.write_bytes(b"x" * 10)
            self.assertEqual(media.preview_for(f), f)
            with patch.object(media, "PREVIEW_MIN_BYTES", 1), patch.object(media, "PREVIEW_MAX_BYTES", 5):
                self.assertEqual(media.preview_for(f), f)
            with patch.object(media, "PREVIEW_MIN_BYTES", 1000):
                self.assertEqual(media.preview_for(f), f)

    def test_thumb_generation_with_ffmpeg(self):
        import shutil
        if not shutil.which("ffmpeg"):
            self.skipTest("ffmpeg not on PATH")
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            src = Path(tmp) / "sample.mp4"
            gen = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                 "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10", str(src)],
                capture_output=True, text=True,
            )
            if gen.returncode != 0 or not src.is_file():
                self.skipTest("cannot synthesize sample video")
            with patch.object(media, "_cache_root", return_value=Path(tmp) / "cache"):
                out = media.thumb_for(src)
            self.assertIsNotNone(out)
            self.assertTrue(out.is_file() and out.stat().st_size > 0)


push = importlib.import_module("test_bridge_plugin.push")


class FakeWebPushError(Exception):
    def __init__(self, status):
        super().__init__(f"push service said {status}")
        self.response = types.SimpleNamespace(status_code=status)


class PushTests(unittest.TestCase):
    """Phone alerts: keys and subscriptions (vapid.py), encryption and signing (webpush.py), sending (push.py)."""

    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        patcher = patch.object(data, "chief_home", return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import serialization

        def device(endpoint):
            key = ec.generate_private_key(ec.SECP256R1())
            public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
            auth = os.urandom(16)
            return key, auth, {"endpoint": endpoint, "keys": {"p256dh": webpush.b64url_encode(public), "auth": webpush.b64url_encode(auth)}}

        vapid.public_key()  # a device subscribes only after fetching the key, which creates the pair
        self.devices = [device("https://fcm.example/a"), device("https://moz.example/b")]
        for _key, _auth, sub in self.devices:
            vapid.upsert_subscription(sub)
        self.posts = []
        test = self

        class Session:
            def post(self, url, data=None, headers=None, timeout=None):
                test.posts.append({"url": url, "data": data, "headers": headers, "timeout": timeout})
                status = 410 if url.endswith("/gone") else 201
                return types.SimpleNamespace(status_code=status, text="")

        self.session = Session()

    def decrypt(self, body, key, auth):
        """Receiver side of RFC 8291, to prove what the phone would read."""
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        salt, idlen = body[:16], body[20]
        sender_public = body[21:21 + idlen]
        ua_public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        shared = key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), sender_public))
        ikm = webpush._hkdf_expand(webpush._hkdf_extract(auth, shared), b"WebPush: info\x00" + ua_public + sender_public, 32)
        prk = webpush._hkdf_extract(salt, ikm)
        cek = webpush._hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16)
        nonce = webpush._hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12)
        plain = AESGCM(cek).decrypt(nonce, body[21 + idlen:], None)
        self.assertEqual(plain[-1:], b"\x02")
        return plain[:-1]

    def test_rfc8291_example(self):
        from cryptography.hazmat.primitives.asymmetric import ec
        sender = ec.derive_private_key(int.from_bytes(webpush.b64url_decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"), ec.SECP256R1())
        body = webpush.encrypt(b"When I grow up, I want to be a watermelon",
                               "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
                               "BTBZMqHH6r4Tts7J_aSIgg", salt=webpush.b64url_decode("DGv6ra1nlYgDCS1FRnbzlw"), sender_key=sender)
        self.assertEqual(webpush.b64url_encode(body),
                         "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")

    def test_send_sets_ttl_timeout_topic_and_signs_per_push_service(self):
        with patch.dict(os.environ, {"CHIEF_PUSH_CONTACT": "mailto:owner@example.com"}):
            result = push.send("Chief", "hello", tag="approval-abc:123", ttl=900, urgency="high", session=self.session)
        self.assertEqual(result["sent"], 2)
        public = vapid.public_key()
        for post, (key, auth, sub) in zip(self.posts, self.devices):
            self.assertEqual(post["url"], sub["endpoint"])
            self.assertEqual(post["timeout"], push.SEND_TIMEOUT)
            h = post["headers"]
            self.assertEqual((h["TTL"], h["Urgency"], h["Topic"], h["Content-Encoding"]), ("900", "high", "approval-abc123", "aes128gcm"))
            token, k = h["Authorization"].removeprefix("vapid t=").split(", k=")
            self.assertEqual(k, public)
            claims = json.loads(webpush.b64url_decode(token.split(".")[1]))
            self.assertEqual(claims["aud"], sub["endpoint"].rsplit("/", 1)[0])
            self.assertEqual(claims["sub"], "mailto:owner@example.com")
            payload = json.loads(self.decrypt(post["data"], key, auth))
            self.assertEqual((payload["title"], payload["body"], payload["tag"]), ("Chief", "hello", "approval-abc:123"))

    def test_gone_subscription_is_dropped(self):
        vapid.upsert_subscription({"endpoint": "https://fcm.example/gone", "keys": self.devices[0][2]["keys"]})
        result = push.send("Chief", "x", session=self.session)
        self.assertEqual((result["sent"], result["gone"]), (2, 1))
        self.assertEqual([s["endpoint"] for s in vapid.load_subs()], ["https://fcm.example/a", "https://moz.example/b"])

    def test_keys_are_created_once_and_existing_keys_are_kept(self):
        first = vapid.public_key()
        self.assertEqual(vapid.public_key(), first)
        record = json.loads((self.home / "command_center_vapid.json").read_text(encoding="utf-8"))
        self.assertEqual(set(record), {"publicKey", "private_pem"})
        self.assertTrue(record["private_pem"].startswith("-----BEGIN PRIVATE KEY-----"))
        vapid.private_key()  # loads

    def test_no_subscriptions_sends_nothing(self):
        vapid.save_subs([])
        self.assertEqual(push.send("Chief", "x", session=self.session)["sent"], 0)
        self.assertEqual(self.posts, [])

    def test_contact_must_be_mailto_or_https(self):
        with patch.dict(os.environ, {"CHIEF_PUSH_CONTACT": "not a url"}):
            self.assertTrue(identity.push_contact().startswith("https://"))

    def test_replies_are_plain_text_and_machine_notes_stay_quiet(self):
        queued = []
        with patch.object(push, "enqueue", lambda title, body, **kw: queued.append((title, body, kw)) or True):
            self.assertFalse(push.notify_reply("[kanban] card t_1 moved to done"))
            self.assertFalse(push.notify_reply("   "))
            self.assertTrue(push.notify_reply("## Done\n**Shipped** the [fix](http://x) in `app.ts`.\nMEDIA: E:\\out\\a.png"))
        self.assertEqual(queued[0][1], "Done Shipped the fix in app.ts.")
        self.assertEqual(queued[0][2]["tag"], "chief-reply")

    def test_plain_text_cuts_at_a_word(self):
        text = push.plain_text("word " * 100, 40)
        self.assertLessEqual(len(text), 40)
        self.assertTrue(text.endswith("word…"))

    def test_enqueue_never_blocks_the_caller(self):
        import threading
        release = threading.Event()
        started = threading.Event()

        def slow(*args, **kwargs):
            started.set()
            release.wait(5)

        with patch.object(push, "send", slow):
            self.assertTrue(push.enqueue("Chief", "one"))
            self.assertTrue(started.wait(2))
            self.assertTrue(push.enqueue("Chief", "two"))  # returns while the first send is stuck
            release.set()
            push._queue.join()


class WatchPushTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        patcher = patch.object(data, "chief_home", return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.bridge = server.BridgeServer(token="t", port=0, session_key_override="", inject=lambda *_: True)
        self.bridge.binding = lambda: {"sessionKey": "agent:main:command_center:dm:owner"}

    def test_each_approval_is_pushed_once(self):
        sent = []
        current = {"requestId": "r1", "command": "rm -rf build"}
        with patch.object(data, "pending_approval", lambda sk: current), patch.object(push, "notify_approval", sent.append):
            self.bridge._push_new_approval()
            self.bridge._push_new_approval()
            current = {"requestId": "r2", "command": "git push"}
            self.bridge._push_new_approval()
        self.assertEqual([a["requestId"] for a in sent], ["r1", "r2"])

    def test_flags_are_seeded_quietly_then_pushed_once_each(self):
        report = self.home / "report.json"
        pushed = []

        def write(flags, mtime):
            report.write_text(json.dumps({"flags": flags}), encoding="utf-8")
            os.utime(report, (mtime, mtime))

        with patch.object(server, "learning_report_path", lambda: report), patch.object(push, "notify_flags", pushed.append):
            write([{"id": "churn:a", "title": "a churns"}], 1000)
            self.bridge._push_new_flags()
            self.assertEqual(pushed, [])  # first run: already flagged, shown in Health
            write([{"id": "churn:a"}, {"id": "memory:chief", "title": "Nova's memory is full"}], 2000)
            self.bridge._push_new_flags()
            self.bridge._push_new_flags()  # unchanged report: nothing
            write([{"id": "churn:a"}, {"id": "memory:chief"}], 3000)
            self.bridge._push_new_flags()
        self.assertEqual([[f["id"] for f in batch] for batch in pushed], [["memory:chief"]])


class LivePathTests(unittest.TestCase):
    """Long-poll transcript, Load earlier and the binding cache (PLAN-2026-09-29 phase 4)."""

    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        patcher = patch.object(data, "chief_home", return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        conn = sqlite3.connect(self.home / "state.db")
        conn.executescript("""
            CREATE TABLE sessions (id TEXT, session_key TEXT, last_activity_at INTEGER, source TEXT);
            INSERT INTO sessions VALUES ('s', 'session', 1, 'command_center');
            CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT, content TEXT, timestamp TEXT,
                                   tool_calls TEXT, session_id TEXT, active INTEGER);
        """)
        conn.executemany("INSERT INTO messages VALUES (?, 'assistant', ?, '1', NULL, 's', 1)", [(i, f"reply {i}") for i in range(1, 151)])
        conn.commit()
        conn.close()
        self.bridge = server.BridgeServer(token="t", port=0, session_key_override="", inject=lambda *_: True)
        self.bridge.binding = lambda: {"sessionKey": "session"}
        self.approval = None
        for name, value in (("_LONGPOLL_STEP", 0.02),):
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(data, "pending_approval", lambda sk: self.approval)
        p.start()
        self.addCleanup(p.stop)

    def add_row(self, row_id, delay):
        import threading

        def later():
            time.sleep(delay)
            conn = sqlite3.connect(self.home / "state.db")
            conn.execute("INSERT INTO messages VALUES (?, 'assistant', 'fresh', '2', NULL, 's', 1)", (row_id,))
            conn.commit()
            conn.close()

        t = threading.Thread(target=later)
        t.start()
        self.addCleanup(t.join)

    def test_long_poll_returns_as_soon_as_a_row_lands(self):
        self.add_row(151, 0.15)
        started = time.monotonic()
        payload = self.bridge.live_transcript(150, wait=5, gen="0", approval="")
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual([m["id"] for m in payload["messages"]], [151])
        self.assertTrue(payload["longpoll"])
        self.assertIsNone(payload["approval"])

    def test_long_poll_returns_on_a_new_approval_and_times_out_quietly(self):
        with patch.object(server, "_LONGPOLL_MAX", 0.3):
            started = time.monotonic()
            quiet = self.bridge.live_transcript(150, wait=5, gen="0", approval="")
            self.assertGreaterEqual(time.monotonic() - started, 0.25)
            self.assertEqual(quiet["messages"], [])
            self.approval = {"requestId": "r1", "command": "git push"}
            started = time.monotonic()
            asked = self.bridge.live_transcript(150, wait=5, gen="0", approval="")
            self.assertLess(time.monotonic() - started, 0.2)
            self.assertEqual(asked["approval"]["requestId"], "r1")

    def test_an_empty_conversation_holds_until_the_first_row(self):
        # A fresh install has no rows, so the dashboard asks with after=0. That used to answer at
        # once and turn the long-poll into a tight loop.
        conn = sqlite3.connect(self.home / "state.db")
        conn.execute("DELETE FROM messages")
        conn.commit()
        conn.close()
        with patch.object(server, "_LONGPOLL_MAX", 0.3):
            started = time.monotonic()
            quiet = self.bridge.live_transcript(0, wait=5, gen="0", approval="")
            self.assertGreaterEqual(time.monotonic() - started, 0.25)
            self.assertEqual(quiet["messages"], [])
        self.add_row(1, 0.1)
        first = self.bridge.live_transcript(0, wait=5, gen="0", approval="")
        self.assertEqual([m["id"] for m in first["messages"]], [1])

    def test_with_rows_and_after_zero_it_answers_at_once(self):
        started = time.monotonic()
        payload = self.bridge.live_transcript(0, wait=5, gen="0", approval="")
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(len(payload["messages"]), 120)

    def test_without_wait_it_answers_at_once(self):
        started = time.monotonic()
        self.bridge.live_transcript(150)
        self.assertLess(time.monotonic() - started, 0.2)

    def test_load_earlier_pages_back_until_the_start(self):
        first = self.bridge.live_transcript(0)
        self.assertEqual(first["messages"][0]["id"], 31)  # the latest 120
        page = self.bridge.live_transcript(0, before=31)
        self.assertEqual([m["id"] for m in page["messages"]], list(range(1, 31)))
        self.assertFalse(page["more"])
        conn = sqlite3.connect(self.home / "state.db")
        conn.executemany("INSERT INTO messages VALUES (?, 'assistant', 'old', '0', NULL, 's', 1)", [(i,) for i in range(-400, 0)])
        conn.commit()
        conn.close()
        page = self.bridge.live_transcript(0, before=31)
        self.assertEqual(len(page["messages"]), 60)
        self.assertTrue(page["more"])
        self.assertEqual(page["cursor"], page["messages"][0]["id"])

    def test_load_earlier_reads_history_archived_by_compaction(self):
        # Rows -20..-11 were archived by an older compaction whose marker is -10; -9..-8 are its copies
        # of -12..-11 (stamped at the marker's time), -7 is genuinely new. All archived (active = 0).
        conn = sqlite3.connect(self.home / "state.db")
        conn.executemany("INSERT INTO messages VALUES (?, 'assistant', ?, '100', NULL, 's', 0)", [(i, f"old {i}") for i in range(-20, -10)])
        conn.execute("INSERT INTO messages VALUES (-10, 'user', '[CONTEXT COMPACTION] summary', '200', NULL, 's', 0)")
        conn.executemany("INSERT INTO messages VALUES (?, 'assistant', ?, '200', NULL, 's', 0)", [(-9, "old -12"), (-8, "old -11")])
        conn.execute("INSERT INTO messages VALUES (-7, 'assistant', 'after the old compaction', '300', NULL, 's', 0)")
        conn.commit()
        conn.close()
        page = self.bridge.live_transcript(0, before=1)
        by_id = {m["id"]: m for m in page["messages"]}
        self.assertIn(-20, by_id)  # archived history is readable
        self.assertTrue(by_id[-9].get("replay") and by_id[-8].get("replay"))  # that compaction's copies
        self.assertFalse(by_id[-7].get("replay"))
        self.assertFalse(by_id[-12].get("replay"))
        self.assertFalse(page["more"])

    def test_load_earlier_cursor_moves_past_rows_it_filters(self):
        conn = sqlite3.connect(self.home / "state.db")
        conn.executemany("INSERT INTO messages VALUES (?, 'session_meta', 'x', '1', NULL, 's', 1)", [(i,) for i in range(-500, 0)])
        conn.commit()
        conn.close()
        page = self.bridge.live_transcript(0, before=1)
        self.assertEqual(page["messages"], [])
        self.assertTrue(page["more"])
        self.assertLess(page["cursor"], 1)  # the next page starts below what was read, not at `before` again

    def test_binding_is_cached_briefly(self):
        fresh = server.BridgeServer(token="t", port=0, session_key_override="", inject=lambda *_: True)
        calls = []
        with patch.object(data, "resolve_session_key", lambda *a, **k: calls.append(1) or {"sessionKey": "session"}):
            fresh.binding()
            fresh.binding()["sessionKey"] = "mutated"  # callers get a copy
            self.assertEqual(fresh.binding()["sessionKey"], "session")
            self.assertEqual(len(calls), 1)
            with patch.object(server, "_BINDING_TTL", 0):
                fresh.binding()
            self.assertEqual(len(calls), 2)

    def test_send_ids_are_remembered_for_a_day(self):
        self.assertGreaterEqual(server._SEND_ID_TTL, 24 * 60 * 60)


if __name__ == "__main__":
    unittest.main()
