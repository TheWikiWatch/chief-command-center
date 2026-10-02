"""Contract check for tools_settings.py (Settings → Tools: image generation and web search) against a real Hermes
runtime: Hermes's own provider rows and readiness, keys saved to the chief's profile, picks written the way
`hermes tools` writes them, the image model list, and the test results the dashboard shows. Offline: the tool
runs themselves are stood in for, so no service is called and nothing is spent.

    set HERMES_HOME=<temp>\\profiles\\chief
    <payload>\\tools\\python-...\\python.exe hermes\\tests\\contract\\run_tools_contract.py <payload dir>

Uses a throwaway home only. Exit 0 = the contract holds.
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
# Keys from this PC's environment must not make a service look ready.
for name in list(os.environ):
    if name.endswith(("_API_KEY", "_KEY", "_URL")) and name not in ("HERMES_HOME",):
        os.environ.pop(name, None)

plugin = Path(__file__).resolve().parents[2] / "plugins" / "chief-dashboard-bridge"
package = types.ModuleType("bridge")
package.__path__ = [str(plugin)]
sys.modules["bridge"] = package


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"bridge.{name}", plugin / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"bridge.{name}"] = module
    spec.loader.exec_module(module)
    return module


data = load("data")
data.chief_home = lambda root=None: home
data.profiles_dir = lambda root=None: home.parent
load("settings")
tools = load("tools_settings")
tools.chief_home = lambda: home

from hermes_cli.plugins import discover_plugins

discover_plugins()

failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({str(detail)[:300]})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def config_text() -> str:
    path = home / "config.yaml"
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def row(state: dict, tool: str, name: str) -> dict:
    return next((r for r in state[tool]["providers"] if r["name"] == name), {})


state = tools.get_tools()
check("the tools read", state.get("ok") is True, state)
image_names = {r["name"] for r in state["image"]["providers"]}
web_names = {r["name"] for r in state["web"]["providers"]}
check("image services come from Hermes's plugins", {"OpenAI", "FAL.ai", "OpenAI (Codex auth)"} <= image_names, sorted(image_names))
check("web services come from Hermes's plugins", {"Exa · Free (keyless)", "Tavily", "Brave Search (Free)"} <= web_names, sorted(web_names))
check("nothing is chosen for images on a fresh profile", state["image"]["active"] is None and state["image"]["model"] is None, state["image"]["active"])
openai = row(state, "image", "OpenAI")
check("OpenAI needs a key, and names it", openai.get("status") == "needs_keys" and [k["key"] for k in openai.get("keys", [])] == ["OPENAI_API_KEY"], openai)
check(
    "the ChatGPT sign-in has a plain label and hint",
    row(state, "image", "OpenAI (Codex auth)").get("label") == "ChatGPT sign-in"
    and "ChatGPT sign-in" in row(state, "image", "OpenAI (Codex auth)").get("hint", ""),
)
check("recommended services come first", [r["recommended"] for r in state["image"]["providers"][:3]] == [True, True, True])
check("a keyless web service is ready", row(state, "web", "Exa · Free (keyless)").get("status") == "ready")
check(
    "tiered names are short",
    row(state, "web", "Exa · Free (keyless)").get("label") == "Exa" and row(state, "web", "Exa · Paid (API key)").get("label") == "Exa (with a key)",
)
check("Brave Free is marked search-only", row(state, "web", "Brave Search (Free)").get("searchOnly") is True)

refused = tools.patch_tools({"tool": "image", "provider": "OpenAI"})
check("a service that isn't ready is refused, in plain words", refused == {"ok": False, "error": "Needs an API key"}, refused)
check("an unknown key name is refused", tools.patch_tools({"tool": "image", "keys": {"PATH": "x"}}).get("error") == "Unknown key name")
check("an unknown tool is refused", tools.patch_tools({"tool": "video"}).get("error") == "Unknown tool")

picked = tools.patch_tools({"tool": "image", "keys": {"OPENAI_API_KEY": "sk-contract-not-real"}, "provider": "OpenAI"})
check("a key and a pick in one step", picked.get("ok") is True and picked["image"]["active"] == "OpenAI", picked.get("error") or picked["image"]["active"])
env = (home / ".env").read_text(encoding="utf-8") if (home / ".env").is_file() else ""
check("the key went to the chief's profile", "OPENAI_API_KEY=sk-contract-not-real" in env)
check("the response never carries the key", "sk-contract-not-real" not in json.dumps(picked))
check("the pick is written as `hermes tools` writes it", "provider: openai" in config_text(), config_text()[-400:])
model = picked["image"]["model"] or {}
check(
    "OpenAI's models are listed with a current one", bool(model.get("options")) and model.get("current") in {o["id"] for o in model.get("options", [])}, model
)
other = next((o["id"] for o in model.get("options", []) if o["id"] != model.get("current")), "")
chosen = tools.patch_tools({"tool": "image", "model": other})
check("a model choice is saved", chosen.get("ok") is True and chosen["image"]["model"]["current"] == other, chosen.get("error"))
check("an unknown model is refused", tools.patch_tools({"tool": "image", "model": "not-a-model"}).get("error") == "Unknown model for this service")

web = tools.patch_tools({"tool": "web", "provider": "Exa · Free (keyless)"})
check(
    "a keyless web service is chosen",
    web.get("ok") is True and web["web"]["active"] == "Exa · Free (keyless)" and web["web"]["backends"]["search"] == "exa",
    web.get("error") or web["web"]["backends"],
)
brave = tools.patch_tools({"tool": "web", "keys": {"BRAVE_SEARCH_API_KEY": "brave-contract-not-real"}, "provider": "Brave Search (Free)"})
check(
    "a search-only service takes searches and leaves reading pages where it was",
    brave.get("ok") is True and brave["web"]["backends"] == {"search": "brave-free", "extract": "exa"},
    brave.get("error") or brave["web"]["backends"],
)
back = tools.patch_tools({"tool": "web", "provider": "Exa · Free (keyless)"})
check("a whole pick replaces the search-only override", back["web"]["backends"] == {"search": "exa", "extract": "exa"}, back["web"]["backends"])

# The test buttons run the real tools; here the tool run itself is stood in for.
from tools.registry import registry

picture = home / "made.png"
picture.write_bytes(b"\x89PNG\r\n\x1a\n")
real_dispatch = registry.dispatch
registry.dispatch = (
    lambda name, args, **kw: json.dumps({"success": True, "image": str(picture)}) if name == "image_generate" else real_dispatch(name, args, **kw)
)
made = tools.test_tool({"tool": "image"})
check(
    "a test image comes back as an attachment the chat can show",
    made.get("ok") is True and made["image"]["name"] == "made.png" and made["image"]["kind"] == "image",
    made,
)
registry.dispatch = lambda name, args, **kw: json.dumps({"success": False, "error": "Incorrect API key provided: sk-…\nTraceback (most recent call last): …"})
failed = tools.test_tool({"tool": "image"})
check("a failed test says what happened in one line", failed == {"ok": False, "error": "Incorrect API key provided: sk-…"}, failed)
registry.dispatch = lambda name, args, **kw: json.dumps(
    {
        "success": False,
        "error": "OpenAI image generation failed: Error code: 401 - {'error': {'message': 'Incorrect API key provided: sk-…0000.', 'type': 'invalid_request_error'}}",
    }
)
check(
    "a provider's error body is put plainly",
    tools.test_tool({"tool": "image"}) == {"ok": False, "error": "The service turned down the key. Incorrect API key provided: sk-…0000."},
    tools.test_tool({"tool": "image"}),
)
registry.dispatch = lambda name, args, **kw: json.dumps(
    {"success": True, "data": {"web": [{"title": "One", "url": "https://example.com/1"}, {"title": "Two", "url": "https://example.com/2"}]}}
)
found = tools.test_tool({"tool": "web"})
check(
    "a test search lists what it found",
    found == {"ok": True, "results": [{"title": "One", "url": "https://example.com/1"}, {"title": "Two", "url": "https://example.com/2"}]},
    found,
)
registry.dispatch = real_dispatch

print(json.dumps({"failures": failures}))
sys.exit(1 if failures else 0)
