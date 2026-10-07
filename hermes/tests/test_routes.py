"""The bridge's route table and the dashboard proxy's allow-list (apps/web/lib/proxy-policy.ts) agree."""

import importlib
import json
import re
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
package = types.ModuleType("test_routes_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(ROOT / "hermes/tests/.runtime/hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
try:
    import yaml
except ImportError:
    yaml = types.ModuleType("yaml")
    yaml.load = lambda text, **kwargs: json.loads(text)
    loader = types.ModuleType("yaml.loader")
    loader.SafeLoader = object
    sys.modules["yaml"] = yaml
    sys.modules["yaml.loader"] = loader
server = importlib.import_module("test_routes_plugin.server")
routes = importlib.import_module("test_routes_plugin.routes")

POLICY = (ROOT / "apps/web/lib/proxy-policy.ts").read_text(encoding="utf-8")


def ts_set(name: str) -> set[str]:
    match = re.search(rf"const {name} = new Set\(\[(.*?)\]\);", POLICY, re.S)
    assert match, name
    return set(re.findall(r'"([^"]+)"', match.group(1)))


class RouteTableTests(unittest.TestCase):
    def setUp(self):
        bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
        self.table = routes.build(bridge)

    def test_the_proxy_allows_exactly_the_dashboard_routes(self):
        exact = [r for r in self.table if r.dashboard and not r.prefix and not r.templated]
        self.assertEqual({r.path[1:] for r in exact if r.method == "GET"}, ts_set("bridgeGet"))
        self.assertEqual({r.path[1:] for r in exact if r.method == "POST"}, ts_set("bridgePost"))
        self.assertEqual({r.path[1:] for r in exact if r.method == "PATCH"}, ts_set("bridgePatch"))
        prefixes = {r.path[1:] for r in self.table if r.dashboard and r.prefix}
        self.assertEqual(prefixes, set(re.findall(r'"([a-z]+)"', re.search(r"\[(\"profile\", \"avatar\")\]", POLICY).group(1))))
        templates = {f"{r.method} {r.path[1:].replace('{id}', ':id')}" for r in self.table if r.dashboard and r.templated}
        self.assertEqual(templates, ts_set("bridgeTemplates"))
        self.assertFalse([r.path for r in self.table if r.templated and r.prefix])

    def test_routes_are_unique_and_bodies_are_bounded(self):
        keys = [(r.method, r.path) for r in self.table]
        self.assertEqual(len(keys), len(set(keys)))
        for r in self.table:
            self.assertGreater(r.limit, 0)
            self.assertLessEqual(r.limit, 80 * routes.MB, r.path)
        self.assertEqual(routes.find(self.table, "POST", "/send").limit, 80 * routes.MB)
        self.assertEqual(routes.find(self.table, "POST", "/approve").limit, routes.DEFAULT_BODY)

    def test_matching(self):
        self.assertIsNotNone(routes.find(self.table, "GET", "/avatar/ada"))
        self.assertIsNone(routes.find(self.table, "GET", "/avatar/ada/x"))
        self.assertIsNone(routes.find(self.table, "GET", "/avatar"))
        self.assertIsNone(routes.find(self.table, "POST", "/snapshot"))
        self.assertIsNone(routes.find(self.table, "DELETE", "/threads"))
        self.assertEqual(routes.find(self.table, "GET", "/look/ada").path, "/look/{id}")
        self.assertEqual(routes.find(self.table, "PUT", "/look/ada/avatar").path, "/look/{id}/avatar")
        self.assertTrue(routes.find(self.table, "PUT", "/look/ada/avatar").raw)
        self.assertEqual(routes.find(self.table, "GET", "/pets/catalog").path, "/pets/catalog")
        self.assertEqual(routes.find(self.table, "GET", "/pets/thumb/boba").path, "/pets/thumb/{id}")
        for method, path in (("GET", "/look"), ("GET", "/look/a.b"), ("GET", "/look/ada/x"), ("POST", "/look/ada/avatar"), ("GET", "/pet/ada")):
            self.assertIsNone(routes.find(self.table, method, path), path)

    def test_an_oversized_body_is_refused_before_the_handler(self):
        bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
        called = []
        bridge.approve = lambda *a: called.append(a) or {"ok": True}
        handler_class = server._make_handler(bridge)
        h = object.__new__(handler_class)
        h.path, h.command, h.client_address = "/approve", "POST", ("127.0.0.1", 1)
        h.headers = {"Content-Length": str(routes.DEFAULT_BODY + 1), "Authorization": "Bearer test"}
        h.rfile = types.SimpleNamespace(read=lambda n: b"")
        out = {}
        h._reject = lambda code, msg: out.update(code=code, error=msg)
        h.do_POST()
        self.assertEqual(out["code"], 413)
        self.assertEqual(called, [])

    def test_a_raw_route_gets_its_body_as_bytes(self):
        bridge = server.BridgeServer(token="test", port=0, session_key_override="", inject=lambda *_: False)
        handler_class = server._make_handler(bridge)
        looks = importlib.import_module("test_routes_plugin.looks")
        got = []
        original = looks.save_avatar
        looks.save_avatar = lambda pid, blob, *a: got.append((pid, blob)) or ({"ok": True}, 200)
        self.addCleanup(setattr, looks, "save_avatar", original)
        handler_class = server._make_handler(bridge)
        for body, length, code in ((b"\x89PNG-bytes", None, 200), (b"x" * 10, looks.AVATAR_MAX + 1, 413), (b"short", 99, 400)):
            h = object.__new__(handler_class)
            h.path, h.command, h.client_address = "/look/ada/avatar", "PUT", ("127.0.0.1", 1)
            h.headers = {"Content-Length": str(len(body) if length is None else length), "Authorization": "Bearer test"}
            h.rfile = types.SimpleNamespace(read=lambda n, body=body: body[:n])
            out = {}
            h._reject = lambda code, msg, out=out: out.update(code=code, error=msg)
            h._json = lambda payload, code=200, out=out: out.update(code=code, payload=payload)
            h.do_PUT()
            self.assertEqual(out["code"], code, out)
        self.assertEqual(got, [("ada", b"\x89PNG-bytes")])


if __name__ == "__main__":
    unittest.main()
