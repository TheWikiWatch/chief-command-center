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
        exact = [r for r in self.table if r.dashboard and not r.prefix]
        self.assertEqual({r.path[1:] for r in exact if r.method == "GET"}, ts_set("bridgeGet"))
        self.assertEqual({r.path[1:] for r in exact if r.method == "POST"}, ts_set("bridgePost"))
        self.assertEqual({r.path[1:] for r in exact if r.method == "PATCH"}, set(re.findall(r'method === "PATCH" && route === "([^"]+)"', POLICY)))
        prefixes = {r.path[1:] for r in self.table if r.dashboard and r.prefix}
        self.assertEqual(prefixes, set(re.findall(r'"([a-z]+)"', re.search(r"\[(\"profile\", \"avatar\")\]", POLICY).group(1))))

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


if __name__ == "__main__":
    unittest.main()
