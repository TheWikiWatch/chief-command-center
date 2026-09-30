"""Contract check for providers.py against a real Hermes runtime (not part of the stdlib unit suite).

Run with the payload's Python and the payload on the path, against a throwaway home:

    set HERMES_HOME=<temp>\\profiles\\chief
    <payload>\\tools\\python-...\\python.exe hermes\\tests\\contract\\run_providers_contract.py <payload dir>

It never uses a real key and never calls a model: it checks the imports and shapes Hermes provides
(catalog, key storage, status, the endpoint probe against a closed port). Exit 0 = the contract holds.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import types
from pathlib import Path

payload = Path(sys.argv[1]).resolve()
sys.path[:0] = [str(payload / "hermes-agent"), str(payload / "venv" / "Lib" / "site-packages")]
home = Path(os.environ["HERMES_HOME"]).resolve()
assert home.parent.name == "profiles" and home.name == "chief", "HERMES_HOME must be <root>/profiles/chief"
home.mkdir(parents=True, exist_ok=True)

plugin = Path(__file__).resolve().parents[2] / "plugins" / "chief-dashboard-bridge"
package = types.ModuleType("bridge")
package.__path__ = [str(plugin)]
sys.modules["bridge"] = package
spec = importlib.util.spec_from_file_location("bridge.providers", plugin / "providers.py")
providers = importlib.util.module_from_spec(spec)
sys.modules["bridge.providers"] = providers
spec.loader.exec_module(providers)

failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


cat = providers.catalog()
rows = {r["slug"]: r for r in cat["providers"]}
check("catalog lists Hermes providers", len(rows) > 20, len(rows))
check("key providers carry their key variable", rows.get("openai-api", {}).get("keyEnv") == "OPENAI_API_KEY", rows.get("openai-api"))
check("custom endpoints are offered", rows.get("custom", {}).get("kind") == "custom", rows.get("custom"))
check("OpenRouter takes a key", rows.get("openrouter", {}).get("keyEnv") == "OPENROUTER_API_KEY", rows.get("openrouter"))
check("oauth providers are marked external", rows.get("nous", {}).get("kind") == "external", rows.get("nous"))
check("a fresh home is not ready", cat["status"]["ready"] is False, cat["status"])

check("unknown provider is refused", providers.save_key("no-such-provider", "x")["ok"] is False)
check("oauth provider refuses a key", providers.save_key("nous", "abc")["ok"] is False)
check("spaces are refused", providers.save_key("openai-api", "a b")["ok"] is False)
saved = providers.save_key("deepseek", "contract-test-key-not-real-000000")
check("a key is saved", saved.get("ok") is True, saved)
env_text = (home / ".env").read_text(encoding="utf-8") if (home / ".env").exists() else ""
check("the key lands in the profile .env", "DEEPSEEK_API_KEY=" in env_text)
check("the key is not echoed", "contract-test-key" not in json.dumps(saved))

probe = providers.check_endpoint("http://127.0.0.1:9/v1")
check("a closed endpoint is reported unreachable", probe["ok"] is False and probe["reachable"] is False, probe)
check("a bad address is refused", providers.check_endpoint("ftp:/x")["ok"] is False)

# A keyless local endpoint, end to end: probe, save as the main model, ready, one test reply.
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeOpenAI(BaseHTTPRequestHandler):
    seen_auth: list[str] = []

    def log_message(self, *args):
        pass

    def _send(self, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        FakeOpenAI.seen_auth.append(self.headers.get("Authorization") or "")
        if self.path.rstrip("/").endswith("/models"):
            self._send({"object": "list", "data": [{"id": "tiny-local", "object": "model"}]})
        else:
            self.send_error(404)

    def do_POST(self):
        FakeOpenAI.seen_auth.append(self.headers.get("Authorization") or "")
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        if self.path.rstrip("/").endswith("/chat/completions"):
            self._send({"id": "x", "object": "chat.completion", "created": 0, "model": "tiny-local",
                        "choices": [{"index": 0, "finish_reason": "stop",
                                     "message": {"role": "assistant", "content": "ready"}}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        else:
            self.send_error(404)


server = ThreadingHTTPServer(("127.0.0.1", 0), FakeOpenAI)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_address[1]}/v1"
probe = providers.check_endpoint(base)
check("a keyless local endpoint is reachable and lists its models", probe["ok"] and probe["models"] == ["tiny-local"], probe)
saved = providers.save_endpoint("Test local", probe["baseUrl"], "tiny-local")
check("the endpoint becomes the main model", saved.get("ok") is True, saved)
check("a keyless local endpoint counts as ready", providers.status()["ready"] is True, providers.status())
reply = providers.test_message(timeout=20)
check("the test message gets a reply", reply.get("ok") is True and "ready" in reply.get("reply", ""), reply)
check("no Authorization header is sent without a key", not any(a.startswith("Bearer sk") for a in FakeOpenAI.seen_auth), FakeOpenAI.seen_auth)
server.shutdown()

if os.environ.get("CONTRACT_NETWORK") == "1":
    # A made-up key against a real provider: the explanation must say the key was rejected.
    chosen = providers.choose_model("deepseek", "deepseek-chat")
    check("a key provider's model can be chosen", chosen.get("ok") is True or "confirm" in chosen, chosen)
    rejected = providers.test_message(timeout=30)
    check("a made-up key is reported as rejected", rejected.get("code") == "rejected", rejected)

print(json.dumps({"failures": failures}))
sys.exit(1 if failures else 0)
