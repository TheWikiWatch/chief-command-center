"""The chat adapter delivers a reply's attachments (Hermes's default for a platform without them is a
"Couldn't deliver the image attachment" warning)."""

import asyncio
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import test_bridge  # noqa: F401  (sets up the plugin package and Hermes stand-ins)

ROOT = Path(__file__).resolve().parents[2]


class _SendResult:
    def __init__(self, success=False, message_id=None, error=None):
        self.success, self.message_id, self.error = success, message_id, error


class _BaseAdapter:
    def __init__(self, config, platform):
        self.config, self.platform = config, platform

    async def send_image_file(self, *args, **kwargs):
        raise AssertionError("the fallback warning must not be reached")

    send_document = send_video = send_voice = send_image_file


def _gateway_stand_ins() -> dict[str, types.ModuleType]:
    """Just enough of Hermes's gateway package for the adapter module to import."""
    mods = {
        name: types.ModuleType(name)
        for name in ("gateway", "gateway.config", "gateway.platforms", "gateway.platforms._shared", "gateway.platforms.base", "gateway.platforms.event")
    }
    mods["gateway.config"].Platform = lambda value: value
    mods["gateway.config"].PlatformConfig = object
    mods["gateway.platforms._shared"].get_scoped_secret = lambda *a, **k: ""
    mods["gateway.platforms._shared"].seed_extra_from_env = lambda *a, **k: {}
    mods["gateway.platforms.base"].BasePlatformAdapter = _BaseAdapter
    mods["gateway.platforms.base"].SendResult = _SendResult
    mods["gateway.platforms.event"].MessageEvent = object
    mods["gateway.platforms.event"].MessageType = object
    return mods


class AdapterMediaTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        modules = patch.dict(sys.modules, _gateway_stand_ins())
        modules.start()
        self.addCleanup(modules.stop)
        sys.modules.pop("test_bridge_plugin.adapter", None)
        self.adapter_mod = importlib.import_module("test_bridge_plugin.adapter")
        self.addCleanup(sys.modules.pop, "test_bridge_plugin.adapter", None)
        outbox = importlib.import_module("test_bridge_plugin.outbox")
        self.outbox_file = Path(self.temp.name) / "outbox.jsonl"
        p = patch.object(outbox, "_outbox_path", return_value=self.outbox_file)
        p.start()
        self.addCleanup(p.stop)
        quiet = patch.object(self.adapter_mod, "_notify_phone")
        quiet.start()
        self.addCleanup(quiet.stop)

    def rows(self):
        return [json.loads(line) for line in self.outbox_file.read_text(encoding="utf-8").splitlines()]

    def test_each_kind_of_attachment_becomes_a_media_line(self):
        adapter = self.adapter_mod.CommandCenterAdapter.__new__(self.adapter_mod.CommandCenterAdapter)
        adapter._broadcast, adapter.chat_id = None, "owner"
        image = str(Path(self.temp.name) / "pic.png")
        results = asyncio.run(self._send_all(adapter, image))
        self.assertTrue(all(r.success for r in results))
        self.assertEqual(
            [r["message"] for r in self.rows()],
            [f"A caption\nMEDIA:{image}", "MEDIA:/x/report.pdf", "MEDIA:/x/clip.mp4", "MEDIA:/x/note.ogg"],
        )

    async def _send_all(self, adapter, image):
        return [
            await adapter.send_image_file("owner", image, caption="A caption"),
            await adapter.send_document("owner", "/x/report.pdf", file_name="report.pdf"),
            await adapter.send_video("owner", "/x/clip.mp4"),
            await adapter.send_voice("owner", "/x/note.ogg", is_voice=True),
        ]

    def test_a_routine_keeps_its_attachments(self):
        with patch.object(self.adapter_mod.threading, "Thread"):
            result = asyncio.run(self.adapter_mod._standalone_send(None, "owner", "Daily sketch", media_files=[("/x/sketch.png", False)]))
        self.assertTrue(result["success"])
        self.assertEqual(self.rows()[0]["message"], "Daily sketch\nMEDIA:/x/sketch.png")


if __name__ == "__main__":
    unittest.main()
