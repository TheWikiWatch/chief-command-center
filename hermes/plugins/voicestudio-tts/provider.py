"""VoiceStudio (OmniVoice) as a Hermes TTS provider, with Edge as the safety net.

VoiceStudio's backend speaks OpenAI's `POST /v1/audio/speech` on 127.0.0.1:3900. Voices:

  default            OmniVoice's own voice
  design:<tags>      designed on the fly from OmniVoice's voice-design tags with a fixed seed
                     (no reference audio, so it is the fast path, ~1s for a first chunk)
  profile:<id>       a voice saved in VoiceStudio, designed or cloned (reference audio;
                     keep clone references short, ~6-10s, or every chunk gets slower)

Config (`tts.voicestudio` in the profile's config.yaml), all optional:

  voice           one of the ids above (default: DEFAULT_VOICE)
  base_url        loopback only (default http://127.0.0.1:3900)
  seed            fixed seed for designed voices, so the voice stays the same (default 7)
  num_step        OmniVoice unmasking steps (VoiceStudio default 16; 8-12 is faster)
  speed           rate multiplier (default 1.0)
  timeout         seconds before giving up on VoiceStudio for one chunk (default 12)
  fallback        speak with Edge when VoiceStudio fails (default true)
  fallback_voice  Edge voice for the fallback (default en-GB-RyanNeural)
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
from collections.abc import Callable

try:
    from agent.tts_provider import TTSProvider
except Exception:

    class TTSProvider:  # type: ignore[no-redef]
        pass


logger = logging.getLogger("voicestudio-tts")

NAME = "voicestudio"
DEFAULT_BASE = "http://127.0.0.1:3900"
DEFAULT_VOICE = "design:male, middle-aged, low pitch, british accent"
DEFAULT_FALLBACK_VOICE = "en-GB-RyanNeural"
MAX_CHARS = 4000  # VoiceStudio rejects input over 4096
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
FORMATS = {"mp3", "wav", "opus", "flac"}

#: Designed voices: fast, stable (fixed seed), no setup. Tags are OmniVoice's voice-design whitelist.
DESIGNED: list[tuple[str, str]] = [
    ("British man, deep", "male, middle-aged, low pitch, british accent"),
    ("British man", "male, young adult, moderate pitch, british accent"),
    ("American man, deep", "male, middle-aged, low pitch, american accent"),
    ("American man", "male, young adult, moderate pitch, american accent"),
    ("Australian man", "male, middle-aged, moderate pitch, australian accent"),
    ("British woman", "female, middle-aged, moderate pitch, british accent"),
    ("American woman", "female, young adult, moderate pitch, american accent"),
    ("American woman, low", "female, middle-aged, low pitch, american accent"),
    ("Canadian woman", "female, young adult, moderate pitch, canadian accent"),
]

Http = Callable[[str, str, bytes | None, float], bytes]


def _http(method: str, url: str, body: bytes | None, timeout: float) -> bytes:
    headers = {"content-type": "application/json"} if body is not None else {}
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _load_config() -> dict[str, Any]:
    try:
        from tools.tts_tool import _load_tts_config

        tts = _load_tts_config()
        section = tts.get(NAME) if isinstance(tts, dict) else None
        return section if isinstance(section, dict) else {}
    except Exception:
        return {}


def loopback_base(raw: Any) -> str:
    """The configured base URL if it is loopback http(s), else the default. Text never leaves the PC."""
    url = str(raw or "").strip().rstrip("/") or DEFAULT_BASE
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return DEFAULT_BASE
    if parsed.scheme not in ("http", "https") or (parsed.hostname or "") not in LOOPBACK:
        logger.warning("voicestudio-tts: base_url %r is not loopback; using %s", url, DEFAULT_BASE)
        return DEFAULT_BASE
    return url


def speech_body(text: str, voice: str, cfg: dict[str, Any], fmt: str, speed: float | None) -> dict[str, Any]:
    """The /v1/audio/speech request for a voice id (see the module docstring)."""
    body: dict[str, Any] = {"model": "omnivoice", "input": text, "response_format": fmt, "voice": "default"}
    rate = speed if speed is not None else cfg.get("speed")
    if isinstance(rate, (int, float)) and rate > 0 and float(rate) != 1.0:
        body["speed"] = max(0.25, min(4.0, float(rate)))
    steps = cfg.get("num_step")
    if isinstance(steps, int) and 1 <= steps <= 128:
        body["num_step"] = steps
    if voice.startswith("design:"):
        body["instruct"] = voice[len("design:") :].strip()
        seed = cfg.get("seed", 7)
        if isinstance(seed, int):
            body["seed"] = seed
    elif voice.startswith("profile:"):
        body["voice"] = voice[len("profile:") :].strip() or "default"
    return body


class VoiceStudioTTS(TTSProvider):
    """`tts.provider: voicestudio`."""

    def __init__(self, http: Http = _http, config: Callable[[], dict[str, Any]] = _load_config, edge: Callable[[str, str, str], None] | None = None):
        self._http = http
        self._config = config
        self._edge = edge or _edge_fallback
        self._profiles: tuple[float, list[dict[str, Any]]] = (0.0, [])
        self._lock = threading.Lock()
        #: When the last reply fell back to Edge (epoch seconds) and why; read by the dashboard bridge.
        self.last_fallback: float = 0.0
        self.last_error: str = ""

    # -- identity / picker -------------------------------------------------
    @property
    def name(self) -> str:
        return NAME

    @property
    def display_name(self) -> str:
        return "VoiceStudio (local)"

    def get_setup_schema(self) -> dict[str, Any]:
        return {"name": "VoiceStudio (local)", "badge": "local", "tag": "Designed and cloned voices on this PC", "env_vars": []}

    def is_available(self) -> bool:
        # No network here (the picker calls it on every paint); the Edge fallback covers a stopped backend.
        return True

    @property
    def voice_compatible(self) -> bool:
        return True

    # -- voices ------------------------------------------------------------
    def _base(self, cfg: dict[str, Any]) -> str:
        return loopback_base(cfg.get("base_url"))

    def _saved_profiles(self, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        at, cached = self._profiles
        if time.time() - at < 30:
            return cached
        try:
            rows = json.loads(self._http("GET", f"{self._base(cfg)}/profiles", None, 2.5))
            profiles = [r for r in rows if isinstance(r, dict) and r.get("id")] if isinstance(rows, list) else []
        except Exception:
            profiles = cached
        self._profiles = (time.time(), profiles)
        return profiles

    def list_voices(self) -> list[dict[str, Any]]:
        cfg = self._config()
        voices: list[dict[str, Any]] = [{"id": f"design:{tags}", "display": label, "group": "Designed · fast"} for label, tags in DESIGNED]
        voices.append({"id": "default", "display": "OmniVoice default", "group": "Designed · fast"})
        for p in self._saved_profiles(cfg):
            kind = "cloned" if str(p.get("kind") or "clone") == "clone" else "designed"
            name = str(p.get("name") or p["id"]).strip()
            voices.append({"id": f"profile:{p['id']}", "display": f"{name} ({kind})", "group": "Your VoiceStudio voices"})
        current = self.current_voice(cfg)
        if current not in {v["id"] for v in voices}:
            voices.append({"id": current, "display": current, "group": "Your VoiceStudio voices"})
        return voices

    def current_voice(self, cfg: dict[str, Any] | None = None) -> str:
        cfg = self._config() if cfg is None else cfg
        voice = str(cfg.get("voice") or "").strip()
        return voice or DEFAULT_VOICE

    def default_voice(self) -> str | None:
        return DEFAULT_VOICE

    # -- speech ------------------------------------------------------------
    def synthesize(
        self, text: str, output_path: str, *, voice: str | None = None, model: str | None = None, speed: float | None = None, format: str = "mp3", **extra: Any
    ) -> str:
        cfg = self._config()
        fmt = format if format in FORMATS else "mp3"
        path = _with_ext(output_path, fmt)
        # Our own `tts.voicestudio.voice` wins: Hermes passes the generic top-level `tts.voice`, which
        # may name another engine's voice. Only a VoiceStudio-shaped id is taken from it.
        passed = (voice or "").strip()
        own = str(cfg.get("voice") or "").strip()
        chosen = own or (passed if passed == "default" or passed.startswith(("design:", "profile:")) else "") or DEFAULT_VOICE
        try:
            if len(text) > MAX_CHARS:
                raise ValueError(f"text is {len(text)} characters; VoiceStudio takes {MAX_CHARS}")
            timeout = float(cfg.get("timeout") or 12)
            # Longer text takes longer; never less than the configured budget.
            budget = max(timeout, len(text) / 40.0)
            body = json.dumps(speech_body(text, chosen, cfg, fmt, speed)).encode("utf-8")
            audio = self._http("POST", f"{self._base(cfg)}/v1/audio/speech", body, budget)
            if len(audio) < 64:
                raise ValueError("VoiceStudio returned no audio")
            with open(path, "wb") as fh:
                fh.write(audio)
            return path
        except Exception as exc:
            reason = _reason(exc)
            if cfg.get("fallback", True) is False:
                raise RuntimeError(f"VoiceStudio: {reason}") from exc
            logger.warning("voicestudio-tts: %s; speaking this reply with Edge", reason)
            mp3 = _with_ext(output_path, "mp3")
            self._edge(text, mp3, str(cfg.get("fallback_voice") or DEFAULT_FALLBACK_VOICE))
            with self._lock:
                self.last_fallback = time.time()
                self.last_error = reason
            return mp3

    def warm(self) -> None:
        """Speech just turned on: load the model in the background so the first reply is hot."""
        cfg = self._config()

        def go() -> None:
            try:
                body = json.dumps(speech_body("Hi.", self.current_voice(cfg), cfg, "mp3", None)).encode("utf-8")
                self._http("POST", f"{self._base(cfg)}/v1/audio/speech", body, 120)
            except Exception:
                logger.debug("voicestudio-tts: warm-up failed", exc_info=True)

        threading.Thread(target=go, name="voicestudio-warm", daemon=True).start()

    def fallback_status(self, within_s: float = 600) -> dict[str, Any] | None:
        """The most recent Edge fallback if it happened within `within_s`, for the dashboard."""
        with self._lock:
            if self.last_fallback and time.time() - self.last_fallback < within_s:
                return {"at": self.last_fallback, "reason": self.last_error, "voice": str(self._config().get("fallback_voice") or DEFAULT_FALLBACK_VOICE)}
        return None


def _with_ext(path: str, fmt: str) -> str:
    root, ext = os.path.splitext(path)
    want = ".ogg" if fmt == "opus" else f".{fmt}"
    return path if ext.lower() == want else root + want


def _reason(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code}"
    if isinstance(exc, urllib.error.URLError):
        return "not running" if isinstance(exc.reason, ConnectionRefusedError) else f"unreachable ({exc.reason})"
    if isinstance(exc, (TimeoutError,)) or "timed out" in str(exc).lower():
        return "timed out"
    return str(exc) or exc.__class__.__name__


def _edge_fallback(text: str, path: str, voice: str) -> None:
    from tools.tts_tool import _run_edge_tts

    _run_edge_tts(text, path, {"edge": {"voice": voice}})
