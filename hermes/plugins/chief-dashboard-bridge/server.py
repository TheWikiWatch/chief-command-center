"""Loopback HTTP + SSE for ChiefDashboard. Binds 127.0.0.1 only."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urlparse

from . import data
from . import identity
from . import media
from . import push
from . import vapid
from . import persona
from . import second_brain
from . import providers
from . import settings as hermes_settings
from . import voice

logger = logging.getLogger("chief-dashboard-bridge")

InjectFn = Callable[[str, str], bool]
_BOUND_MARK = "CHIEF_DASHBOARD_BRIDGE_BOUND"
# How long a composer send id is remembered, so a retry after a timeout is not a second message.
# The dashboard's outbox (lib/outbox.ts) retries queued sends for up to 24 hours with the same id.
_SEND_ID_TTL = 24 * 60 * 60
# /transcript?wait=N holds the request until something changes, at most this long.
_LONGPOLL_MAX = 25
_LONGPOLL_STEP = 0.5
# binding() reads sessions.json and scans the sessions table; every poll asks for it.
_BINDING_TTL = 2.0
# Watch loop: approvals every tick, fleet flags every _FLAG_EVERY, the /events signature every _SIG_EVERY.
_WATCH_SECONDS = 2.5
_FLAG_EVERY = 24
_SIG_EVERY = 2


def learning_report_path() -> Optional[Path]:
    """An optional learning ledger's report.json (CHIEF_LEARNING_DIR), or None when none is configured."""
    folder = (os.environ.get("CHIEF_LEARNING_DIR") or "").strip()
    return Path(folder) / "report.json" if folder else None


def _already_bound_here() -> bool:
    return os.environ.get(_BOUND_MARK) == "1"


def _loop_running(adapter: Any) -> bool:
    loop = getattr(adapter, "_loop", None)
    running = getattr(loop, "is_running", None)
    return bool(callable(running) and running())


def _live_command_center_adapter() -> Any:
    """The connected platform adapter, including the sibling plugin's singleton."""
    found: list[Any] = []
    try:
        from .adapter import get_adapter

        ad = get_adapter()
        if ad is not None:
            found.append(ad)
    except Exception:
        pass
    try:
        import sys

        mod = sys.modules.get("cc_shared_singleton")
        if mod is not None:
            ad = mod.get_adapter()
            if ad is not None:
                found.append(ad)
    except Exception:
        pass
    for ad in found:
        if _loop_running(ad):
            return ad
    return found[0] if found else None


def _queue_inbound(adapter: Any, text: str, media: list | None = None, message_type: str = "text") -> bool:
    """Return once the turn is queued. Do not wait for the model."""
    media = media or []
    queue = getattr(adapter, "queue_user_text", None)
    if callable(queue):
        try:
            return bool(queue(text, media, message_type))
        except TypeError:
            if media:
                return False
            return bool(queue(text))
    if not _loop_running(adapter):
        return False
    submit = getattr(adapter, "submit_user_text", None)
    if not callable(submit):
        return False
    if media:
        return False

    def _call() -> None:
        try:
            submit(text)
        except Exception:
            logger.exception("command_center inbound failed")

    threading.Thread(target=_call, name="cc-inbound", daemon=True).start()
    return True


class ExclusiveHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if os.name == "nt":
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            except OSError:
                pass
        super().server_bind()


class BridgeServer:
    def __init__(self, *, token: str, port: int, session_key_override: str, inject: InjectFn):
        self.token = token
        self.port = port
        self.session_key_override = session_key_override
        self.inject = inject
        self.discord_bot = None
        self.discord_adapter = None
        self.command_center_adapter = None
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._subscribers: list[callable] = []
        self._sub_lock = threading.Lock()
        self._watch_stop = threading.Event()
        self._send_lock = threading.Lock()
        self._sent_ids: dict[str, float] = {}
        self._pushed_approvals: dict[str, float] = {}
        self._binding_cache: Optional[tuple[bool, float, dict]] = None
        self._flags_mtime = 0.0

    def set_discord_bot(self, bot) -> None:
        self.discord_bot = bot

    def set_discord_adapter(self, adapter) -> None:
        self.discord_adapter = adapter

    def set_command_center_adapter(self, adapter) -> None:
        self.command_center_adapter = adapter
        try:
            from . import adapter as cc_mod
            # keep module-level ref warm if handler fires after connect
            if adapter is not None:
                cc_mod._set_adapter(adapter)
        except Exception:
            pass

    def _adopt_command_center(self) -> None:
        """Reattach after a platform re-register drops the handler's adapter."""
        live = _live_command_center_adapter()
        if live is not None:
            self.command_center_adapter = live

    def binding(self) -> dict[str, Any]:
        self._adopt_command_center()
        ready = self.command_center_adapter is not None
        now = time.monotonic()
        cached = self._binding_cache
        if cached and cached[0] == ready and now - cached[1] < _BINDING_TTL:
            return dict(cached[2])
        bind = data.resolve_session_key(self.session_key_override, command_center_ready=ready)
        self._binding_cache = (ready, now, bind)
        return dict(bind)

    def live_transcript(self, after: int, wait: float = 0, gen: str = "", approval: str = "", before: int = 0) -> dict[str, Any]:
        """The transcript with the chief's state (generating, pending approval). With `wait` (seconds) and
        `after`, hold until a row lands after it, generating differs from `gen`, or the pending
        approval differs from `approval`: one open request instead of a poll every 0.8s."""
        bind = self.binding()
        sk = bind.get("sessionKey") or ""
        if before:
            payload = data.transcript(sk, before_id=before, limit=60)
        else:
            deadline = time.monotonic() + max(0.0, min(float(wait or 0), _LONGPOLL_MAX))
            # `after` 0 is a conversation with no rows yet (a fresh install): hold until the first one.
            while time.monotonic() < deadline and not self._watch_stop.is_set():
                pending = data.pending_approval(sk)
                if data.head_id(sk) > after:
                    break
                if gen in ("0", "1") and ("1" if self.generating(sk) else "0") != gen:
                    break
                if ((pending or {}).get("requestId") or "") != approval:
                    break
                time.sleep(_LONGPOLL_STEP)
                bind = self.binding()
                if (bind.get("sessionKey") or "") != sk:
                    break
            payload = data.transcript(sk, after_id=after)
        payload["bind"] = bind
        payload["generating"] = self.generating(sk)
        payload["approval"] = data.pending_approval(sk)
        payload["longpoll"] = True
        return payload

    def generating(self, session_key: str) -> bool:
        """True while the owning platform adapter still has this session busy."""
        if not session_key:
            return False
        adapters = []
        if ":command_center:" in session_key:
            adapters = [self.command_center_adapter, self.discord_adapter]
        else:
            adapters = [self.discord_adapter, self.command_center_adapter]
        for ad in adapters:
            if ad is None:
                continue
            active = getattr(ad, "_active_sessions", None)
            try:
                if bool(active) and session_key in active:
                    return True
            except Exception:
                continue
        return False

    def serve_forever(self) -> None:
        if _already_bound_here():
            logger.info("7790 already bound in this process; skip duplicate plugin copy")
            return
        handler = _make_handler(self)
        httpd: Optional[ThreadingHTTPServer] = None
        deadline = time.time() + 90.0
        attempt = 0
        while httpd is None:
            if _already_bound_here():
                logger.info("7790 already bound in this process; skip duplicate plugin copy")
                return
            try:
                httpd = ExclusiveHTTPServer(("127.0.0.1", self.port), handler)
            except OSError as exc:
                attempt += 1
                if time.time() >= deadline:
                    logger.error("could not bind 127.0.0.1:%s after retries: %s", self.port, exc)
                    return
                logger.warning("bind 127.0.0.1:%s failed (%s); retry %s", self.port, exc, attempt)
                time.sleep(0.5)
        os.environ[_BOUND_MARK] = "1"
        httpd.daemon_threads = True
        self._httpd = httpd
        threading.Thread(target=self._watch_loop, name="chief-dashboard-watch", daemon=True).start()
        logger.info("bound 127.0.0.1:%s", self.port)
        try:
            httpd.serve_forever()
        except Exception:
            logger.exception("chief-dashboard-bridge server crashed")

    def _watch_loop(self) -> None:
        last_sig = ""
        tick = 0
        while not self._watch_stop.wait(_WATCH_SECONDS):
            tick += 1
            try:
                self._push_new_approval()
            except Exception:
                logger.debug("approval push check failed", exc_info=True)
            if tick % _FLAG_EVERY == 0:
                try:
                    self._push_new_flags()
                except Exception:
                    logger.debug("fleet flag push check failed", exc_info=True)
            if tick % _SIG_EVERY:
                continue
            # The dashboard polls instead of using /events, so usually nobody listens.
            # Skip the roster/kanban/transcript reads until a subscriber appears.
            with self._sub_lock:
                idle = not self._subscribers
            if idle:
                last_sig = ""
                continue
            try:
                sig = self._snapshot_sig()
                if sig != last_sig and last_sig:
                    self.broadcast({"type": "change", "at": time.time()})
                last_sig = sig
            except Exception:
                logger.debug("watch snapshot failed", exc_info=True)

    def _push_new_approval(self) -> None:
        """Phone alert when the chief blocks on an approval (once per request). Locked phones never saw these."""
        pending = data.pending_approval(self.binding().get("sessionKey") or "")
        rid = (pending or {}).get("requestId") or ""
        if not rid or rid in self._pushed_approvals:
            return
        self._pushed_approvals[rid] = time.time()
        if len(self._pushed_approvals) > 50:
            for old in sorted(self._pushed_approvals, key=self._pushed_approvals.get)[:-50]:
                self._pushed_approvals.pop(old, None)
        push.notify_approval(pending)

    def _push_new_flags(self) -> None:
        """Phone alert for each new fleet oversight flag in the learning report (once per flag id)."""
        report = learning_report_path()
        if report is None:
            return
        try:
            mtime = report.stat().st_mtime
        except OSError:
            return
        if mtime == self._flags_mtime:
            return
        self._flags_mtime = mtime
        try:
            flags = [f for f in (json.loads(report.read_text(encoding="utf-8")).get("flags") or []) if isinstance(f, dict) and f.get("id")]
        except (OSError, ValueError):
            return
        state = data.chief_home() / "chief-dashboard-flags-pushed.json"
        try:
            seen = set(json.loads(state.read_text(encoding="utf-8")))
            first = False
        except (OSError, ValueError):
            seen, first = set(), True
        fresh = [f for f in flags if str(f["id"]) not in seen]
        if not fresh:
            return
        # The first run only records what is already flagged; the Health view shows those.
        if not first:
            push.notify_flags(fresh)
        keep = sorted(seen | {str(f["id"]) for f in flags})[-500:]
        tmp = state.with_name(state.name + ".tmp")
        tmp.write_text(json.dumps(keep), encoding="utf-8")
        os.replace(tmp, state)

    def _snapshot_sig(self) -> str:
        roster = data.list_roster()
        work = data.work_status()
        bind = self.binding()
        tail = data.transcript(bind.get("sessionKey") or "", limit=1)
        last = tail.get("lastId") or 0
        ids = ",".join(p["id"] for p in roster.get("people") or [])
        jobs = json.dumps(work.get("jobs") or {}, sort_keys=True, default=str)
        pending = data.pending_approval(bind.get("sessionKey") or "")
        rid = (pending or {}).get("requestId") or ""
        gen = "1" if self.generating(bind.get("sessionKey") or "") else "0"
        return f"{ids}|{jobs}|{last}|{bind.get('sessionKey')}|{rid}|{gen}"

    def broadcast(self, payload: dict) -> None:
        with self._sub_lock:
            subs = list(self._subscribers)
        dead = []
        for q in subs:
            try:
                q(payload)
            except Exception:
                dead.append(q)
        if dead:
            with self._sub_lock:
                self._subscribers = [s for s in self._subscribers if s not in dead]

    def subscribe(self, fn) -> None:
        with self._sub_lock:
            self._subscribers.append(fn)

    def unsubscribe(self, fn) -> None:
        with self._sub_lock:
            self._subscribers = [s for s in self._subscribers if s is not fn]

    def snapshot(self) -> dict[str, Any]:
        roster = data.list_roster()
        work = data.work_status()
        bind = self.binding()
        people = roster["people"]
        jobs = work.get("jobs") or {}
        for person in people:
            job = data.job_for_person(jobs, person["id"])
            ring = job.get("status") or "idle"
            person["ring"] = ring
            person["jobTitle"] = (job.get("title") or "") if ring in ("working", "failed") else ""
            if ring == "working":
                person["startedAt"] = job.get("startedAt")
        approval = data.pending_approval(bind.get("sessionKey") or "")
        sk = bind.get("sessionKey") or ""
        return {
            "ok": True,
            "gateway": True,
            "bind": bind,
            "roster": people,
            "sections": roster.get("sections") or [],
            "workers": work.get("workers") or [],
            "approval": approval,
            "generating": self.generating(sk),
        }

    def approvals(self) -> dict[str, Any]:
        bind = self.binding()
        item = data.pending_approval(bind.get("sessionKey") or "")
        return {"ok": True, "approval": item, "approvals": [item] if item else []}

    def approve(self, request_id: str, choice: str) -> dict[str, Any]:
        bind = self.binding()
        result = data.resolve_approval(bind.get("sessionKey") or "", request_id, choice)
        if result.get("ok") and int(result.get("resolved") or 0) > 0:
            self.broadcast({"type": "approved", "at": time.time()})
        return result

    def _claim_send(self, client_id: str) -> bool:
        """Reserve a composer send id. False when that send already reached the chief (a retry after a timeout)."""
        if not client_id:
            return True
        now = time.time()
        with self._send_lock:
            self._sent_ids = {k: t for k, t in self._sent_ids.items() if now - t < _SEND_ID_TTL}
            if client_id in self._sent_ids:
                return False
            self._sent_ids[client_id] = now
            return True

    def _release_send(self, client_id: str) -> None:
        if client_id:
            with self._send_lock:
                self._sent_ids.pop(client_id, None)

    def send(self, text: str, attachments: list | None = None, client_id: str = "") -> dict[str, Any]:
        client_id = str(client_id or "")[:64]
        if not self._claim_send(client_id):
            logger.info("duplicate send %s ignored; the chief already has it", client_id)
            return {"ok": True, "accepted": True, "duplicate": True}
        result = self._send_once(text, attachments)
        if not result.get("ok"):
            self._release_send(client_id)
        return result

    def _send_once(self, text: str, attachments: list | None = None) -> dict[str, Any]:
        if not (text or "").strip() and not attachments:
            return {"ok": False, "error": "Message is empty."}
        bind = self.binding()
        sk = bind.get("sessionKey") or ""
        platform = bind.get("platform") or ("command_center" if ":command_center:" in sk else "discord")
        # Command Center is the front door. Never inject into a dead Discord session.
        use_cc = platform == "command_center" or data._command_center_enabled()
        cc = self.command_center_adapter
        # Check the target before writing uploads, so a failed send leaves no files behind.
        if use_cc and (cc is None or not sk):
            return {
                "ok": False,
                "error": "Command Center is not attached. Relaunch Chief Command Center.",
                "platform": "command_center",
            }
        if not use_cc and not sk:
            return {"ok": False, "error": "no session bound"}
        try:
            staged = data.stage_uploads(attachments or [])
        except data.UploadError as exc:
            return {"ok": False, "error": str(exc)}
        composed = data.compose_user_turn(text, staged)
        text = composed["text"]
        if not text:
            return {"ok": False, "error": "Message is empty."}
        if use_cc:
            try:
                accepted = _queue_inbound(cc, text, composed["media"], composed["message_type"])
            except Exception as exc:
                logger.warning("command_center inbound failed: %s", exc)
                data.discard_staged(staged)
                return {"ok": False, "error": "Command Center send failed.", "platform": "command_center"}
            if not accepted:
                data.discard_staged(staged)
                return {
                    "ok": False,
                    "error": f"{identity.assistant_name()} did not accept the message. Command Center is not ready.",
                    "platform": "command_center",
                }
            self.broadcast({"type": "sent", "at": time.time(), "platform": "command_center"})
            return {
                "ok": True,
                "sessionKey": sk,
                "kind": bind.get("kind"),
                "accepted": True,
                "platform": "command_center",
            }
        try:
            accepted = bool(self.inject(text, sk))
        except Exception as exc:
            logger.warning("inject_message failed: %s", exc)
            data.discard_staged(staged)
            return {"ok": False, "error": "inject failed"}
        self._quote_from_pc(text, bind)
        self.broadcast({"type": "sent", "at": time.time(), "platform": "discord"})
        return {"ok": accepted, "sessionKey": sk, "kind": bind.get("kind"), "accepted": accepted, "platform": "discord"}

    def outbox(self, after_id: str = "", limit: int = 50) -> dict[str, Any]:
        from . import adapter as cc_mod
        rows = cc_mod.read_outbox(after_id=after_id, limit=limit)
        return {"ok": True, "items": rows, "path": str(cc_mod._outbox_path())}

    def _quote_from_pc(self, text: str, bind: dict) -> None:
        bot = self.discord_bot
        user_id = str(bind.get("userId") or "")
        if bot is None or not user_id:
            return
        clip = text if len(text) <= 280 else text[:277] + "…"
        quote = f"**From PC**\n{clip}"

        async def _send():
            try:
                user = bot.get_user(int(user_id)) or await bot.fetch_user(int(user_id))
                if user is None:
                    return
                dm = user.dm_channel or await user.create_dm()
                await dm.send(quote)
            except Exception:
                logger.debug("From PC quote failed", exc_info=True)

        loop = getattr(bot, "loop", None)
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(_send(), loop)


def _guarded(fn) -> dict[str, Any]:
    """Run a setup action; a Hermes-side failure becomes a plain error, never a traceback or a key."""
    try:
        return fn()
    except (persona.PersonaError, second_brain.SecondBrainError) as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # the adapter maps expected failures itself
        logger.warning("bridge action failed: %s", type(exc).__name__)
        return {"ok": False, "error": providers._plain(exc)}


def _flag(qs: dict, name: str) -> bool:
    return str((qs.get(name) or [""])[0]).lower() in ("1", "true", "yes")


def _cc_push():
    """Phone-alert keys and subscriptions (vapid.py)."""
    return vapid


def _make_handler(bridge: BridgeServer):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            logger.debug("%s - " + fmt, self.address_string(), *args)

        def _authorized(self) -> bool:
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return False
            # Header only: a token in the URL ends up in logs and history.
            header = self.headers.get("Authorization") or ""
            token = header[7:].strip() if header.lower().startswith("bearer ") else ""
            return bool(token) and secrets.compare_digest(token, bridge.token)

        def _read_json(self, limit: int) -> Optional[dict]:
            """Object body, or None after a 4xx. A cut-off upload must not look like an empty message."""
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0:
                self._reject(400, "invalid Content-Length")
                return None
            if length > limit:
                self._reject(413, "payload too large")
                return None
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                self._reject(400, "Request body was cut off or is not valid JSON")
                return None
            if not isinstance(body, dict):
                self._reject(400, "Request body must be a JSON object")
                return None
            return body

        def _act(self, path: str, started: float, result: Any) -> None:
            self._json(result)
            self._log_action(path, started, result)

        def _log_action(self, path: str, started: float, result: Any) -> None:
            """One line per user action so a failed send or approval is diagnosable. Never log bodies."""
            ok = result.get("ok") if isinstance(result, dict) else None
            err = str(result.get("error") or "")[:120] if isinstance(result, dict) and not ok else ""
            logger.info("bridge %s %s ok=%s %.0fms%s", self.command, path, ok, (time.time() - started) * 1000, f" error={err!r}" if err else "")

        def _int_param(self, qs: dict, name: str, default: int) -> int:
            try:
                return int((qs.get(name) or [str(default)])[0] or default)
            except ValueError:
                return default

        def _reject(self, code: int, msg: str) -> None:
            body = json.dumps({"ok": False, "error": msg}).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, payload: Any, code: int = 200) -> None:
            body = json.dumps(payload, default=str).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.end_headers()

        def do_GET(self):
            if not self._authorized():
                self._reject(401, "unauthorized")
                return
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            qs = parse_qs(parsed.query)
            if path == "/health":
                self._json({"ok": True, "gateway": True, "voice": True, "profile": "chief", "longpoll": True})
                return
            if path == "/snapshot":
                self._json(bridge.snapshot())
                return
            if path == "/approvals":
                self._json(bridge.approvals())
                return
            if path == "/voice-config":
                self._json(voice.voice_config())
                return
            if path == "/persona":
                profile = str((qs.get("profile") or ["chief"])[0])
                self._json(_guarded(lambda: persona.read_all(profile)))
                return
            if path == "/persona/soul/version":
                profile = str((qs.get("profile") or ["chief"])[0])
                version = str((qs.get("id") or [""])[0])
                self._json(_guarded(lambda: {"ok": True, **persona.read_version(profile, version)}))
                return
            if path == "/setup/status":
                self._json({"ok": True, "contract": providers.CONTRACT, **providers.status()})
                return
            if path == "/setup/second-brain":
                self._json(_guarded(second_brain.status))
                return
            if path == "/setup/providers":
                self._json(_guarded(lambda: providers.catalog(refresh=_flag(qs, "refresh"))))
                return
            if path == "/setup/models":
                slug = str((qs.get("provider") or [""])[0])
                self._json(_guarded(lambda: providers.provider_models(slug)))
                return
            if path == "/settings":
                self._json(hermes_settings.get_settings())
                return
            if path == "/transcript":
                self._json(bridge.live_transcript(
                    max(0, self._int_param(qs, "after", 0)),
                    wait=max(0, self._int_param(qs, "wait", 0)),
                    gen=(qs.get("gen") or [""])[0],
                    approval=(qs.get("approval") or [""])[0][:128],
                    before=max(0, self._int_param(qs, "before", 0)),
                ))
                return
            if path == "/outbox":
                after_id = (qs.get("after") or [""])[0] or ""
                limit = min(max(1, self._int_param(qs, "limit", 50)), 500)
                self._json(bridge.outbox(after_id=after_id, limit=limit))
                return
            if path.startswith("/profile/"):
                name = path.split("/")[-1]
                self._json(data.profile_peek(name))
                return
            if path.startswith("/avatar/"):
                name = path.split("/")[-1]
                blob = data.avatar_bytes(name)
                if not blob:
                    self._reject(404, "no avatar")
                    return
                raw, mime = blob
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "private, max-age=60")
                self.end_headers()
                self.wfile.write(raw)
                return
            if path in ("/file", "/preview", "/thumb"):
                raw_path = (qs.get("path") or [""])[0]
                bind = bridge.binding()
                data.warm_media_cache(bind.get("sessionKey") or "")
                allowed = data.file_is_allowed(raw_path)
                if not allowed:
                    self._reject(404, "not found")
                    return
                resolved, mime = allowed
                if path == "/preview":
                    resolved = media.preview_for(resolved)
                    mime = "video/mp4" if resolved.suffix.lower() == ".mp4" else mime
                elif path == "/thumb":
                    thumb = media.thumb_for(resolved) if mime.startswith("video/") else None
                    if not thumb:
                        self._reject(404, "no thumbnail")
                        return
                    resolved, mime = thumb, "image/jpeg"
                size = resolved.stat().st_size
                start, end = 0, max(size - 1, 0)
                status = 200
                range_h = self.headers.get("Range") or ""
                if range_h.startswith("bytes=") and size:
                    spec = range_h[6:].split("-", 1)
                    try:
                        if spec[0]:
                            start = int(spec[0])
                        if len(spec) > 1 and spec[1]:
                            end = int(spec[1])
                    except ValueError:
                        start, end = 0, size - 1
                    end = min(max(end, 0), size - 1)
                    start = min(max(start, 0), end)
                    status = 206
                length = (end - start + 1) if size else 0
                safe_name = resolved.name.replace('"', "")
                self.send_response(status)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                disposition = "attachment" if mime in ("image/svg+xml", "application/octet-stream", "text/html") else "inline"
                self.send_header("Content-Disposition", f'{disposition}; filename="{safe_name}"')
                cache_seconds = 3600 if path == "/thumb" else 60
                self.send_header("Cache-Control", f"private, max-age={cache_seconds}")
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                with resolved.open("rb") as fh:
                    fh.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = fh.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                return
            if path == "/events":
                self._sse()
                return
            if path == "/push/vapidPublicKey":
                try:
                    mod = _cc_push()
                    self._json({"ok": True, "publicKey": mod.public_key()})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)}, 500)
                return
            if path == "/push/subscriptions":
                try:
                    mod = _cc_push()
                    subs = mod.load_subs()
                    self._json({"ok": True, "count": len(subs)})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)}, 500)
                return
            self._reject(404, "not found")

        def do_POST(self):
            if not self._authorized():
                self._reject(401, "unauthorized")
                return
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            started = time.time()
            # Keep in step with lib/upload-limits.ts (55 MB of files is ~73 MB of base64 JSON).
            limit = 80 * 1024 * 1024 if path == "/send" else voice.MAX_UPLOAD_BYTES * 2
            body = self._read_json(limit)
            if body is None:
                logger.info("bridge POST %s rejected before handling", path)
                return
            if path == "/send":
                attachments = body.get("attachments")
                self._act(path, started, bridge.send(
                    str(body.get("text") or ""),
                    attachments if isinstance(attachments, list) else [],
                    str(body.get("client_id") or ""),
                ))
                return
            if path == "/outbox/notify":
                bridge.broadcast({"type": "cc_outbox", "at": time.time(), "id": body.get("id")})
                self._json({"ok": True})
                return
            if path == "/approve":
                request_id = str(body.get("request_id") or body.get("requestId") or "")
                choice = str(body.get("choice") or "").strip().lower()
                self._act(path, started, bridge.approve(request_id, choice))
                return
            if path == "/transcribe":
                self._act(path, started, voice.transcribe(body))
                return
            if path == "/persona/soul":
                self._act(path, started, _guarded(lambda: persona.write_soul(
                    str(body.get("profile") or "chief"), str(body.get("text") or ""), str(body.get("base_hash") or ""))))
                return
            if path == "/persona/soul/restore":
                self._act(path, started, _guarded(lambda: persona.restore_version(
                    str(body.get("profile") or "chief"), str(body.get("id") or ""), str(body.get("base_hash") or ""))))
                return
            if path == "/persona/memory":
                ops = body.get("ops") if isinstance(body.get("ops"), list) else []
                self._act(path, started, _guarded(lambda: persona.edit_memory(
                    str(body.get("profile") or "chief"), str(body.get("target") or ""), ops)))
                return
            if path == "/setup/key":
                self._act(path, started, _guarded(lambda: providers.save_key(str(body.get("provider") or ""), str(body.get("key") or ""))))
                return
            if path == "/setup/model":
                self._act(path, started, _guarded(lambda: providers.choose_model(
                    str(body.get("provider") or ""), str(body.get("model") or ""), confirm_expensive=bool(body.get("confirm")))))
                return
            if path == "/setup/endpoint/check":
                self._act(path, started, _guarded(lambda: providers.check_endpoint(str(body.get("base_url") or ""), str(body.get("api_key") or ""))))
                return
            if path == "/setup/endpoint/save":
                self._act(path, started, _guarded(lambda: providers.save_endpoint(
                    str(body.get("name") or ""), str(body.get("base_url") or ""), str(body.get("model") or ""), str(body.get("api_key") or ""))))
                return
            if path == "/setup/second-brain/inspect":
                self._act(path, started, _guarded(lambda: second_brain.inspect(str(body.get("path") or ""))))
                return
            if path == "/setup/second-brain":
                self._act(path, started, _guarded(lambda: second_brain.setup(str(body.get("path") or ""), str(body.get("mode") or ""))))
                return
            if path == "/setup/soul/seed":
                self._act(path, started, _guarded(second_brain.seed_soul))
                return
            if path == "/setup/test":
                self._act(path, started, _guarded(providers.test_message))
                return
            if path == "/speak":
                self._act(path, started, voice.speak(str(body.get("text") or "")))
                return
            if path == "/settings":
                self._act(path, started, hermes_settings.patch_settings(body))
                return
            if path == "/push/subscribe":
                try:
                    mod = _cc_push()
                    sub = body.get("subscription") if isinstance(body, dict) else None
                    if not isinstance(sub, dict):
                        sub = body if isinstance(body, dict) else {}
                    self._json(mod.upsert_subscription(sub))
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)}, 500)
                return
            if path == "/push/unsubscribe":
                try:
                    mod = _cc_push()
                    endpoint = str((body or {}).get("endpoint") or "")
                    self._json(mod.remove_subscription(endpoint))
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)}, 500)
                return
            if path == "/push/test":
                try:
                    title = str((body or {}).get("title") or identity.assistant_name())
                    body_text = str((body or {}).get("body") or "Test push from Chief")
                    url = str((body or {}).get("url") or "/")
                    self._json(push.send(title, body_text, url=url, tag="test"))
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)}, 500)
                return
            self._reject(404, "not found")

        def do_PATCH(self):
            if not self._authorized():
                self._reject(401, "unauthorized")
                return
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            started = time.time()
            body = self._read_json(65536)
            if body is None:
                return
            if path == "/settings":
                self._act(path, started, hermes_settings.patch_settings(body))
                return
            self._reject(404, "not found")

        def _sse(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            queue: list[dict] = []
            lock = threading.Lock()

            def push(payload: dict) -> None:
                with lock:
                    queue.append(payload)

            bridge.subscribe(push)
            try:
                self.wfile.write(b"data: {\"type\":\"hello\"}\n\n")
                self.wfile.flush()
                while True:
                    item = None
                    with lock:
                        if queue:
                            item = queue.pop(0)
                    if item is None:
                        time.sleep(0.25)
                        try:
                            self.wfile.write(b": keepalive\n\n")
                            self.wfile.flush()
                        except Exception:
                            break
                        continue
                    line = "data: " + json.dumps(item, default=str) + "\n\n"
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()
            except Exception:
                pass
            finally:
                bridge.unsubscribe(push)

    return Handler
