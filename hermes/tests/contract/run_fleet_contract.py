"""Contract check for fleet.py (mint, model pin with key grant, retire to archive, restore) against a real Hermes runtime.

    set HERMES_HOME=<temp>\\profiles\\chief
    <payload python> hermes\\tests\\contract\\run_fleet_contract.py <payload dir>

Throwaway home only. Exit 0 = the contract holds.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tarfile
import types
from pathlib import Path

payload = Path(sys.argv[1]).resolve()
sys.path[:0] = [str(payload / "hermes-agent"), str(payload / "venv" / "Lib" / "site-packages")]
home = Path(os.environ["HERMES_HOME"]).resolve()
assert home.parent.name == "profiles" and home.name == "chief", "HERMES_HOME must be <root>/profiles/chief"
root = home.parent.parent
home.mkdir(parents=True, exist_ok=True)

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
data.chief_home = lambda root_=None: home
data.profiles_dir = lambda root_=None: home.parent
data.install_root = lambda: root
data.work_status = lambda: {"jobs": {}, "workers": []}
persona = load("persona")
providers = load("providers")
fleet = load("fleet")

failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({str(detail)[:300]})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def raises(fn) -> str:
    try:
        fn()
    except (fleet.FleetError, persona.PersonaError) as exc:
        return str(exc)
    return ""


# The chief: a local endpoint as its model, plus an OpenRouter key on file.
saved = providers.save_endpoint("Local model", "http://127.0.0.1:9/v1", "tiny-local", "")
check("chief has a model", saved.get("ok") is True, saved)
key = "synthetic-openrouter-value"
check("chief has a key on file", providers.save_key("openrouter", key).get("ok") is True)
check("roster starts empty", fleet.roster()["workers"] == [])

soul = "You are Sam, a researcher.\n\n## Job\nFind and summarize sources.\n"
check("mint refuses without the owner's sign-off", "sign-off" in raises(lambda: fleet.mint("research-desk", "Sam", "Researcher", "Finds sources.", soul, owner_signed=False)))
check("mint refuses a bad id", "lowercase id" in raises(lambda: fleet.mint("Research Desk!", "Sam", "Researcher", "x", soul, owner_signed=True)))
check("mint refuses the chief's id", "lowercase id" in raises(lambda: fleet.mint("chief", "Sam", "Researcher", "x", soul, owner_signed=True)))

from hermes_cli.profiles import _get_wrapper_dir

wrapper = _get_wrapper_dir() / "research-desk"
wrapper_before = wrapper.exists()
made = fleet.mint("research-desk", "Sam", "Researcher", "Finds and summarizes sources.", soul, owner_signed=True)
worker = home.parent / "research-desk"
check("mint creates the profile", made.get("ok") and worker.is_dir(), made)
check("it is titled for the roster", made["worker"]["title"] == "Sam - Researcher", made["worker"])
check("it starts on the chief's model", made["worker"]["model"] == {"provider": "local-model", "model": "tiny-local"}, made["worker"]["model"])
cfg = data.load_yaml(worker / "config.yaml")
check("the custom provider definition came along", "local-model" in (cfg.get("providers") or {}), cfg.get("providers"))
check("it has its own working folder", Path(made["worker"]["cwd"]).is_dir() and "research-desk" in made["worker"]["cwd"], made["worker"]["cwd"])
check("its SOUL is the signed one", (worker / "SOUL.md").read_text(encoding="utf-8").startswith("You are Sam"))
check("no command wrapper was written", wrapper.exists() == wrapper_before)
sections = json.loads((root / "bot-sections.json").read_text(encoding="utf-8"))
check("it is placed on the team", sections["assign"].get("research-desk") == fleet.TEAM_SECTION, sections)
check("a duplicate id is refused", "already exists" in raises(lambda: fleet.mint("research-desk", "Sam", "R", "x", soul, owner_signed=True)))

granted = providers.grant_provider("openrouter", worker)
env_text = (worker / ".env").read_text(encoding="utf-8") if (worker / ".env").exists() else ""
check("a provider key is granted to the worker", granted == {"ok": True, "provider": "openrouter", "keys": 1} and key in env_text, granted)
check("the grant never returns the key", key not in json.dumps(granted))

offered = fleet.models()
check("models are grouped by connected provider", any(g["provider"] == "local-model" and "tiny-local" in g["models"] for g in offered["groups"]), offered)
check("an unknown model is refused", "isn't offered" in raises(lambda: fleet.set_model("research-desk", "local-model", "no-such-model")))
pinned = fleet.set_model("research-desk", "local-model", "tiny-local")
check("a bot can be re-pinned", pinned.get("ok") is True, pinned)
check("an unknown bot is refused", raises(lambda: fleet.set_model("nobody-here", "local-model", "tiny-local")) != "")

# Retire / restore
check("retire needs the owner's yes", "go-ahead" in raises(lambda: fleet.retire("research-desk", owner_confirmed=False)))
check("the chief can't be retired", raises(lambda: fleet.retire("chief", owner_confirmed=True)) != "")
retired = fleet.retire("research-desk", owner_confirmed=True)
check("retire archives and removes the bot", retired.get("ok") and not worker.exists(), retired)
archive = fleet.archives()[0]
check("the archive is listed", archive["id"] == retired["archive"] and archive["title"] == "Sam - Researcher", archive)
with tarfile.open(archive["file"]) as tar:
    names = tar.getnames()
check("the archive holds its SOUL", any(n.endswith("research-desk/SOUL.md") for n in names), names[:20])
check("the archive holds no keys", not any(n.endswith("/.env") or n.endswith("auth.json") for n in names), [n for n in names if ".env" in n])
check("it left the team", "research-desk" not in json.loads((root / "bot-sections.json").read_text(encoding="utf-8"))["assign"])

back = fleet.restore(retired["archive"])
check("restore brings the bot back", back.get("ok") and worker.is_dir() and (worker / "SOUL.md").read_text(encoding="utf-8").startswith("You are Sam"), back)
check("the restored archive is no longer listed", fleet.archives() == [])
check("restore refuses when the id is taken", raises(lambda: fleet.restore(retired["archive"])) != "")

rows = {r["slug"]: r for r in providers.catalog()["providers"]}
check("a key the app saved is marked as saved", rows["openrouter"].get("keySaved") is True, rows["openrouter"])
check("a provider without a stored key isn't", not any(r.get("keySaved") for s, r in rows.items() if s != "openrouter"),
      [s for s, r in rows.items() if r.get("keySaved")])
check("a key the app didn't store can't be removed", providers.remove_key("deepseek").get("code") == "not_saved")
providers.choose_model("openrouter", "openai/gpt-4o-mini", confirm_expensive=True)
check("the provider in use can't lose its key", providers.remove_key("openrouter").get("code") == "in_use")
providers.choose_model("local-model", "tiny-local", confirm_expensive=True)
check("another provider's key can be removed", providers.remove_key("openrouter").get("ok") is True)

again = fleet.retire("research-desk", owner_confirmed=True)
check("an archive can be removed for good", fleet.remove_archive(again["archive"]).get("ok") and fleet.archives() == [])

# The chief's tools
tools = {name: handler for name, _schema, handler, _emoji in fleet.TOOLS}
check("tools return JSON and refuse a mint without sign-off",
      json.loads(tools["fleet_mint"]({"id": "x-bot", "display_name": "X", "role": "R", "description": "d", "soul": "s"}))["ok"] is False)
check("the roster tool works", json.loads(tools["fleet_roster"]({}))["ok"] is True)
check("the retire tool refuses without confirmation", json.loads(tools["fleet_retire"]({"profile": "x"}))["ok"] is False)

print(json.dumps({"failures": failures}))
sys.exit(1 if failures else 0)
