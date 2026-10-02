"""Contract check for speech_model.py (consented download, resume, checksum, cancel, Hermes stt config) and the
no-silent-download guard in voice.py, against a real Hermes runtime. CONTRACT_NETWORK=1 also downloads the real
`tiny` model from Hugging Face and transcribes speech made by Hermes's Edge TTS.

    set HERMES_HOME=<temp>\\profiles\\chief
    <payload>\\tools\\python-...\\python.exe hermes\\tests\\contract\\run_speech_model_contract.py <payload dir>

Uses a throwaway home only. Exit 0 = the contract holds.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import sys
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

payload = Path(sys.argv[1]).resolve()
home_for_cache = Path(os.environ["HERMES_HOME"]).resolve()
# An empty Hugging Face cache, so a model cached by some other install on this PC doesn't count.
os.environ["HF_HOME"] = str(home_for_cache.parent.parent / "hf-cache")
os.environ.pop("HF_HUB_CACHE", None)
sys.path[:0] = [str(payload / "hermes-agent"), str(payload / "venv" / "Lib" / "site-packages")]
home = Path(os.environ["HERMES_HOME"]).resolve()
assert home.parent.name == "profiles" and home.name == "chief", "HERMES_HOME must be <root>/profiles/chief"
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
data.chief_home = lambda root=None: home
data.profiles_dir = lambda root=None: home.parent
speech_model = load("speech_model")
voice = load("voice")

failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({str(detail)[:300]})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


(home / "config.yaml").write_text("model:\n  default: none\n", encoding="utf-8")

# A fake Hub: serves generated files with Range support; can corrupt a file, go slow, or ignore Range.
PAYLOAD = {"config.json": b'{"fake": true}', "model.bin": os.urandom(3 * 1024 * 1024 + 17), "tokenizer.json": b"{}", "vocabulary.txt": b"a\nb\n"}
behaviour: dict = {"corrupt": False, "slow": False, "ranges": [], "ignore_range": False}


class Hub(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        name = self.path.rsplit("/", 1)[-1]
        body = PAYLOAD.get(name)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        if behaviour["corrupt"] and name == "model.bin":
            body = body[:-1] + bytes([body[-1] ^ 1])
        start = 0
        rng = self.headers.get("Range")
        if rng and not behaviour["ignore_range"]:
            behaviour["ranges"].append((name, rng))
            start = int(rng.split("=")[1].split("-")[0])
            self.send_response(206)
        else:
            self.send_response(200)
        chunk = body[start:]
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers()
        step = 64 * 1024
        for i in range(0, len(chunk), step):
            try:
                self.wfile.write(chunk[i : i + step])
            except OSError:
                return
            if behaviour["slow"]:
                time.sleep(0.05)


server = ThreadingHTTPServer(("127.0.0.1", 0), Hub)
threading.Thread(target=server.serve_forever, daemon=True).start()
real_endpoint = os.environ.get("HF_ENDPOINT")
os.environ["HF_ENDPOINT"] = f"http://127.0.0.1:{server.server_address[1]}"
speech_model.MODELS["fake"] = {
    "label": "Fake",
    "repo": "test/fake",
    "revision": "abc123",
    "files": [(n, len(b), hashlib.sha256(b).hexdigest()) for n, b in PAYLOAD.items()],
}


def wait_job(limit: float = 30.0) -> dict:
    end = time.time() + limit
    while time.time() < end:
        job = speech_model.status()["job"]
        if job and job["state"] not in ("downloading", "verifying"):
            return job
        time.sleep(0.05)
    return speech_model.status()["job"]


st = speech_model.status()
check(
    "status lists the real models with sizes",
    {m["id"]: m["bytes"] for m in st["models"] if m["id"] in ("base", "tiny")} == {"base": 147882941, "tiny": 78203619},
    st["models"],
)
check("nothing is installed on a fresh home", not any(m["installed"] for m in st["models"]))

# Silent-download guard: local STT with a model that isn't on disk is refused before Hermes can fetch it.
from cli import save_config_value

with data.chief_config_scope():
    save_config_value("stt.provider", "local")
    save_config_value("stt.local.model", "base")
stt = speech_model.status()["stt"]
check("local STT without a model is reported not ready", stt == {"provider": "local", "enabled": True, "local": True, "ready": False}, stt)
res = voice.transcribe({"data_url": "data:audio/webm;base64," + base64.b64encode(b"\x1a\x45\xdf\xa3fake").decode(), "mime_type": "audio/webm"})
check("transcription is refused, not downloaded silently", res.get("code") == "model_missing" and res.get("ok") is False, res)
check("and no model folder appeared", not speech_model.models_root().exists() or not any(speech_model.models_root().iterdir()))

# Checksum mismatch
behaviour["corrupt"] = True
speech_model.download("fake")
job = wait_job()
check("a corrupted file fails its checksum", job["state"] == "error" and "checksum" in job["error"], job)
folder = speech_model.model_dir("fake")
check("the corrupted part is discarded", not (folder / "model.bin.part").exists() and not (folder / "model.bin").exists())
behaviour["corrupt"] = False

# Cancel, then resume with a Range request
behaviour["slow"] = True
speech_model.download("fake")
deadline = time.time() + 20
while time.time() < deadline and (speech_model.status()["job"] or {}).get("received", 0) < 512 * 1024:
    time.sleep(0.02)
speech_model.cancel()
job = wait_job()
part = folder / "model.bin.part"
check(
    "cancel stops the download and keeps the partial file",
    job["state"] == "cancelled" and part.exists() and 0 < part.stat().st_size < len(PAYLOAD["model.bin"]),
    job,
)
behaviour["slow"] = False
speech_model.download("fake")
job = wait_job()
check("a restarted download resumes with a Range request", any(n == "model.bin" for n, _ in behaviour["ranges"]), behaviour["ranges"])
check("the resumed download completes and verifies", job["state"] == "done" and speech_model.installed("fake"), job)
check("the files match the source byte for byte", (folder / "model.bin").read_bytes() == PAYLOAD["model.bin"])
cfg = speech_model._stt_config()
check("Hermes now points at the downloaded folder", cfg.get("provider") == "local" and cfg["local"]["model"] == str(folder), cfg)
check("and voice typing counts as ready", speech_model.status()["stt"]["ready"] is True)
behaviour["ranges"].clear()
speech_model.download("fake", wait=True)
check("downloading an installed model re-verifies without refetching", wait_job()["state"] == "done" and behaviour["ranges"] == [])

# A server that ignores Range restarts the file cleanly
(folder / "model.bin").unlink()
(folder / "model.bin.part").write_bytes(PAYLOAD["model.bin"][:1000])
behaviour["ignore_range"] = True
speech_model.download("fake", wait=True)
check("a server that ignores Range still yields a verified file", wait_job()["state"] == "done" and (folder / "model.bin").read_bytes() == PAYLOAD["model.bin"])
behaviour["ignore_range"] = False

try:
    speech_model.download("huge")
    check("unknown models are refused", False)
except speech_model.SpeechModelError:
    check("unknown models are refused", True)
check("a model can be deleted", speech_model.delete("fake")["ok"] and not folder.exists())

# Network: the real tiny model, then Edge speech transcribed on this PC
if os.environ.get("CONTRACT_NETWORK") == "1":
    if real_endpoint is None:
        os.environ.pop("HF_ENDPOINT", None)
    else:
        os.environ["HF_ENDPOINT"] = real_endpoint
    del speech_model.MODELS["fake"]
    started = time.time()
    speech_model.download("tiny")
    job = wait_job(600)
    check("the real tiny model downloads and verifies", job["state"] == "done" and speech_model.installed("tiny"), job)
    print(f"      ({job['total'] / 1e6:.1f} MB in {time.time() - started:.0f} s)")
    spoken = voice.speak("Please remind me to call the plumber tomorrow morning.")
    check(
        "Edge speaks a test phrase without a key",
        spoken.get("ok") is True and str(spoken.get("data_url", "")).startswith("data:audio"),
        {k: v for k, v in spoken.items() if k != "data_url"},
    )
    if spoken.get("ok"):
        mime = spoken["data_url"][5:].split(";", 1)[0]
        heard = voice.transcribe({"data_url": spoken["data_url"], "mime_type": mime})
        check("the local model transcribes it offline", bool(heard.get("ok")) and "plumber" in str(heard.get("transcript", "")).lower(), heard)
        print(f"      heard: {heard.get('transcript')!r}")

server.shutdown()
print(json.dumps({"failures": failures}))
sys.exit(1 if failures else 0)
