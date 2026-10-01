"""Contract check for usage.py against a real Hermes session store: spend follows the model each call used.

    set HERMES_HOME=<temp>\\profiles\\chief
    <payload python> hermes\\tests\\contract\\run_usage_contract.py <payload dir>

The dashboard's model picker switches a live conversation without starting a new session. Hermes keeps the
`sessions` row on the model the session started with and records every call in `session_model_usage` under the
model that call really used; usage.py relies on both. Throwaway home only. Exit 0 = the contract holds.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import sys
import types
from pathlib import Path

payload = Path(sys.argv[1]).resolve()
sys.path[:0] = [str(payload / "hermes-agent"), str(payload / "venv" / "Lib" / "site-packages")]
home = Path(os.environ["HERMES_HOME"]).resolve()
assert home.parent.name == "profiles" and home.name == "chief", "HERMES_HOME must be <root>/profiles/chief"
home.mkdir(parents=True, exist_ok=True)
(home / "config.yaml").write_text("model:\n  default: x\n", encoding="utf-8")

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
load("identity")
usage = load("usage")
failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({str(detail)[:300]})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


from hermes_state import SessionDB  # noqa: E402

db = SessionDB(home / "state.db")
db.create_session("switch", "command_center", model="deepseek-flash")
# Two calls on the first model, then the picker switches the same conversation to another provider.
for _ in range(2):
    db.update_token_counts("switch", input_tokens=1000, output_tokens=100, model="deepseek-flash",
                           billing_provider="deepseek", estimated_cost_usd=0.001, api_call_count=1)
db.update_token_counts("switch", input_tokens=500, output_tokens=50, model="glm-5.3-flash",
                       billing_provider="zai", estimated_cost_usd=0.004, api_call_count=1)
db.close()

conn = sqlite3.connect(home / "state.db")
row = conn.execute("SELECT model, input_tokens, api_call_count FROM sessions WHERE id='switch'").fetchone()
check("sessions keeps the starting model (why usage.py can't bucket by it)", row and row[0] == "deepseek-flash", row)
check("sessions holds the lifetime totals", row and row[1] == 2500 and row[2] == 3, row)
ledger = {(m, p): (i, c) for m, p, i, c in conn.execute(
    "SELECT model, billing_provider, input_tokens, api_call_count FROM session_model_usage "
    "WHERE session_id='switch' AND task=''")}
conn.close()
check("the ledger splits the conversation by model and provider",
      ledger == {("deepseek-flash", "deepseek"): (2000, 2), ("glm-5.3-flash", "zai"): (500, 1)}, ledger)

summary = usage.summary("today")
models = {(m["model"], m["provider"]): m for m in summary["models"]}
check("usage shows both models", set(models) == {("deepseek-flash", "deepseek"), ("glm-5.3-flash", "zai")}, list(models))
glm = models.get(("glm-5.3-flash", "zai")) or {}
check("the new model carries its own spend", glm.get("input") == 500 and glm.get("calls") == 1
      and abs(glm.get("cost", 0) - 0.004) < 1e-9, glm)
check("Hermes names the provider", glm.get("providerName") not in (None, "", "zai"), glm.get("providerName"))
check("totals are not counted twice", summary["totals"]["input"] == 2500 and summary["totals"]["sessions"] == 1,
      summary["totals"])

# The journal: a later call in the same long conversation adds only itself, once.
db = SessionDB(home / "state.db")
db.update_token_counts("switch", input_tokens=300, output_tokens=30, model="glm-5.3-flash",
                       billing_provider="zai", estimated_cost_usd=0.002, api_call_count=1)
db.close()
again = usage.summary("today")
check("a later call adds only itself", again["totals"]["input"] == 2800 and again["totals"]["calls"] == 4, again["totals"])
check("a sync with nothing new adds nothing", usage.summary("today")["totals"]["input"] == 2800)
check("the journal says from when its days are exact", bool(again.get("exactSince")), again.get("exactSince"))

print(f"\n{len(failures)} failure(s)" if failures else "\nusage contract holds")
sys.exit(1 if failures else 0)
