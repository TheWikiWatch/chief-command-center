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
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from collections.abc import Callable
from urllib.parse import parse_qs, urlparse

from . import changes
from . import chat_state
from . import data
from . import routes
from . import identity
from . import learning
from . import push
from . import vapid
from . import persona
from . import second_brain
from . import threads
from . import routines
from . import usage
from . import fleet
from . import speech_model
from . import providers

logger = logging.getLogger("chief-dashboard-bridge")

InjectFn = Callable[[str, str], bool]
_BOUND_MARK = "CHIEF_DASHBOARD_BRIDGE_BOUND"
# How long a composer send id is remembered, so a retry after a timeout is not a second message.
# The dashboard's outbox (lib/outbox.ts) retries queued sends for up to 24 hours with the same id.
_SEND_ID_TTL = 24 * 60 * 60
# /transcript?wait=N holds the request until something changes, at most this long. It wakes on the change
# signal (changes.py) and otherwise re-checks every _LONGPOLL_STEP seconds, in case a change has no signal.
_LONGPOLL_MAX = 25
_LONGPOLL_STEP = 2.0
# binding() reads sessions.json and scans the sessions table; every poll asks for it.
_BINDING_TTL = 2.0
# Watch loop: approvals every tick, fleet flags every _FLAG_EVERY, the /events signature every _SIG_EVERY.
_WATCH_SECONDS = 2.5
_FLAG_EVERY = 24
_SIG_EVERY = 2
# The Second Brain: brought up to date once at start, its critical facts re-checked about once a minute.
_FACTS_EVERY = 24
# The usage budget is checked about every five minutes (one notification a month at most).
_BUDGET_EVERY = 120
# A bot's routine runs are relayed into the chief's chat every few seconds (routines.relay).
_RELAY_EVERY = 4


def learning_report_path() -> Path:
    """Fleet Health's report.json: CHIEF_LEARNING_DIR, else the bundled ledger's <root>/learning."""
    return learning.folder() / "report.json"


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
                note_legacy("cc_shared_singleton adapter")
                found.append(ad)
    except Exception:
        pass
    for ad in found:
        if _loop_running(ad):
            return ad
    return found[0] if found else None


# Legacy paths from before the app had its own chat platform (a Discord DM session, an older shared adapter
# module). They stay until no install uses them: each use is logged once and listed on /health ("legacy"), so the
# diagnostics bundle shows whether an install still depends on one.
_LEGACY: set[str] = set()


def note_legacy(name: str) -> None:
    if name not in _LEGACY:
        _LEGACY.add(name)
        logger.warning("chief-dashboard-bridge: legacy path in use: %s (please mention it when sending diagnostics)", name)


def legacy_in_use() -> list[str]:
    return sorted(_LEGACY)


def _busy_input_mode() -> str:
    """The chief's `display.busy_input_mode` (Hermes's default is "interrupt")."""
    try:
        from hermes_cli.config import load_config

        with data.chief_config_scope():
            display = (load_config() or {}).get("display") or {}
        mode = str(display.get("busy_input_mode") or os.environ.get("HERMES_GATEWAY_BUSY_INPUT_MODE") or "interrupt").lower()
        return mode if mode in ("queue", "steer") else "interrupt"
    except Exception:
        return "interrupt"


def _queue_inbound(adapter: Any, text: str, media: list | None = None, message_type: str = "text", chat_id: str = "") -> bool:
    """Return once the turn is queued. Do not wait for the model. `chat_id` is the thread's chat (default main)."""
    media = media or []
    queue = getattr(adapter, "queue_user_text", None)
    if callable(queue):
        try:
            return bool(queue(text, media, message_type, chat_id=chat_id or None)) if chat_id else bool(queue(text, media, message_type))
        except TypeError:
            if media or chat_id:
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
        self._started = time.monotonic()
        self._httpd: ThreadingHTTPServer | None = None
        self._subscribers: list[Callable[[dict], None]] = []
        self._sub_lock = threading.Lock()
        self._watch_stop = threading.Event()
        self._send_lock = threading.Lock()
        self._sent_ids: dict[str, float] = {}
        self._pushed_approvals: dict[str, float] = {}
        self._binding_cache: tuple[bool, float, dict] | None = None
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

    def thread_bind(self, thread: str = threads.MAIN) -> tuple[dict[str, Any], str]:
        """(binding, chat id) of a thread: the main thread is the app's chat as always (chat id "": the adapter's
        own); any other thread is its own chat, so its own Hermes session."""
        bind = self.binding()
        if not thread or thread == threads.MAIN:
            return bind, ""
        if not threads.valid(thread) or not threads.exists(thread):
            raise threads.ThreadError("Unknown thread.")
        bind = dict(bind)
        bind["sessionKey"] = threads.session_key(thread)
        return bind, threads.chat_id(thread)

    def live_transcript(self, after: int, wait: float = 0, gen: str = "", approval: str = "", before: int = 0,
                        clarify: str | None = None, notice: str | None = None, notice_since: float = 0.0,
                        thread: str = threads.MAIN, session: str = "") -> dict[str, Any]:
        """The transcript with the chief's state: generating, the pending approval, its open question
        (`clarify`), notices that aren't replies, and the current step (`activity`). With `wait` (seconds)
        and `after`, hold until a row lands after it or generating, the approval, the question or the
        newest notice differs from what the caller has: one open request instead of a poll every 0.8s.
        `clarify` / `notice` None means the caller doesn't track them (an older dashboard).
        `thread` picks the conversation; `session` reads one of its earlier conversations (before a fresh start)."""
        bind, chat = self.thread_bind(thread)
        sk = bind.get("sessionKey") or ""
        if session:
            if session not in {p["id"] for p in threads.previous_sessions(thread)}:
                raise threads.ThreadError("That conversation isn't part of this thread.")
            payload = data.transcript(session, limit=400)
            payload.update({"thread": thread, "session": session, "longpoll": False})
            return payload
        if before:
            payload = data.transcript(sk, before_id=before, limit=60)
        else:
            deadline = time.monotonic() + max(0.0, min(float(wait or 0), _LONGPOLL_MAX))
            seen = changes.version()
            # `after` 0 is a conversation with no rows yet (a fresh install): hold until the first one.
            while time.monotonic() < deadline and not self._watch_stop.is_set():
                pending = data.pending_approval(sk)
                if data.head_id(sk) > after:
                    break
                if gen in ("0", "1") and ("1" if self.generating(sk) else "0") != gen:
                    break
                if ((pending or {}).get("requestId") or "") != approval:
                    break
                if clarify is not None and ((chat_state.pending_clarify(sk) or {}).get("id") or "") != clarify:
                    break
                if notice is not None and chat_state.notice_head() != notice:
                    break
                seen = changes.wait(seen, min(_LONGPOLL_STEP, max(0.0, deadline - time.monotonic())))
                if thread in ("", threads.MAIN):
                    bind = self.binding()
                    if (bind.get("sessionKey") or "") != sk:
                        break
            payload = data.transcript(sk, after_id=after)
        payload["bind"] = bind
        payload["generating"] = self.generating(sk)
        payload["approval"] = data.pending_approval(sk)
        payload["clarify"] = chat_state.pending_clarify(sk)
        payload["activity"] = chat_state.activity(sk, payload["generating"], chat_state.vault_path(), chat_id=chat or identity.owner_id())
        if not before:
            since = notice_since
            if not since:
                stamps = [float(m.get("timestamp") or 0) for m in payload.get("messages") or []]
                since = min(stamps) if stamps else time.time() - 86400
            payload["notices"] = chat_state.notices(sk, since=since, chat_id=chat or identity.owner_id())
            payload["noticeHead"] = chat_state.notice_head()
            if not after:
                payload["previous"] = threads.previous_sessions(thread)
                # Whether Load earlier has anything to show (a new thread has nothing before its first rows).
                ids = [int(m["id"]) for m in payload.get("messages") or [] if 0 < int(m.get("id") or 0) < 10**12]
                if ids:
                    probe = data.transcript(sk, before_id=min(ids), limit=1)
                    payload["more"] = bool(probe.get("messages")) or bool(probe.get("more"))
        payload["thread"] = thread or threads.MAIN
        payload["longpoll"] = True
        return payload

    def answer_question(self, clarify_id: str, answer: Any, thread: str = threads.MAIN) -> dict[str, Any]:
        bind, _chat = self.thread_bind(thread)
        return chat_state.resolve_clarify(bind.get("sessionKey") or "", clarify_id, answer)

    def thread_list(self) -> dict[str, Any]:
        return threads.list_threads(
            busy=self.generating,
            question=lambda key: chat_state.pending_clarify(key) is not None,
            approval=lambda key: data.pending_approval(key) is not None,
        )

    def fresh_start(self, thread: str = threads.MAIN) -> dict[str, Any]:
        """A fresh start in a thread: Hermes's `/new` (the earlier conversation is kept as history), its
        confirmation answered for the owner, who already confirmed in the app."""
        bind, chat = self.thread_bind(thread)
        sk = bind.get("sessionKey") or ""
        cc = self._attached_adapter()
        if cc is None or not sk:
            return {"ok": False, "error": "Command Center is not attached. Relaunch Chief Command Center."}
        if self.generating(sk):
            return {"ok": False, "code": "busy", "error": f"{identity.assistant_name()} is working in this thread. Stop it first, or wait."}
        if not _queue_inbound(cc, "/new", chat_id=chat):
            return {"ok": False, "error": "Command Center is not ready."}
        try:
            from tools import slash_confirm
        except Exception:
            slash_confirm = None
        end = time.monotonic() + 8.0
        while slash_confirm is not None and time.monotonic() < end:
            if slash_confirm.get_pending(sk):
                _queue_inbound(cc, "/approve", chat_id=chat)
                break
            time.sleep(0.2)
        self.broadcast({"type": "thread_fresh", "at": time.time(), "thread": thread})
        return {"ok": True, "thread": thread}

    def _change_signature(self) -> tuple:
        """What the change watcher compares every 250 ms: which sessions are working, and the main chat's pending
        approval (both live in Hermes's memory, not in files the watcher can see)."""
        keys: tuple = ()
        for ad in (self.command_center_adapter, self.discord_adapter):
            active = getattr(ad, "_active_sessions", None) if ad is not None else None
            try:
                keys += tuple(sorted(str(k) for k in (active or ())))
            except Exception:
                continue
        sk = self.binding().get("sessionKey") or ""
        pending = data.pending_approval(sk) if sk else None
        return keys, (pending or {}).get("requestId") or ""

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
        httpd: ThreadingHTTPServer | None = None
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
        changes.Watcher(lambda: [data.chief_home() / "state.db", data.install_root() / "kanban.db"], self._change_signature).start()
        logger.info("bound 127.0.0.1:%s", self.port)
        try:
            httpd.serve_forever()
        except Exception:
            logger.exception("chief-dashboard-bridge server crashed")

    def _watch_loop(self) -> None:
        last_sig = ""
        tick = 0
        try:
            second_brain.upgrade()
        except Exception:
            logger.warning("Second Brain upgrade failed", exc_info=True)
        try:
            # Fleet Health: the ledger and its jobs armed, and a first report before the first scheduled run.
            learning.ensure()
            if not learning_report_path().is_file():
                learning.run_now()
        except Exception:
            logger.warning("Fleet Health setup failed", exc_info=True)
        while not self._watch_stop.wait(_WATCH_SECONDS):
            tick += 1
            if tick % _BUDGET_EVERY == 0:
                try:
                    over = usage.check_budget()
                    if over:
                        push.notify_budget(over["spent"], over["limit"])
                except Exception:
                    logger.debug("budget check failed", exc_info=True)
            if tick % _RELAY_EVERY == 0:
                try:
                    routines.relay()
                except Exception:
                    logger.debug("routine relay failed", exc_info=True)
            if tick % _FACTS_EVERY == 0:
                try:
                    second_brain.sync_critical_facts()
                except Exception:
                    logger.debug("critical facts sync failed", exc_info=True)
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
            # Bots appearing or leaving (profile folders) have no database signal: check while someone listens.
            with self._sub_lock:
                idle = not self._subscribers
            if idle:
                last_sig = ""
                continue
            try:
                sig = self._snapshot_sig()
                if sig != last_sig and last_sig:
                    changes.bump("roster")
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
            for old in sorted(self._pushed_approvals, key=lambda k: self._pushed_approvals[k])[:-50]:
                self._pushed_approvals.pop(old, None)
        if pending:
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
        changes.bump(str(payload.get("type") or "event"))
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
            # The chief is thinking when any of its threads is working.
            "generating": self.generating(sk) or threads.any_working(self.generating),
        }

    def approvals(self, thread: str = threads.MAIN) -> dict[str, Any]:
        bind, _chat = self.thread_bind(thread)
        item = data.pending_approval(bind.get("sessionKey") or "")
        return {"ok": True, "approval": item, "approvals": [item] if item else []}

    def approve(self, request_id: str, choice: str, thread: str = threads.MAIN) -> dict[str, Any]:
        bind, _chat = self.thread_bind(thread)
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

    def send(self, text: str, attachments: list | None = None, client_id: str = "", thread: str = threads.MAIN) -> dict[str, Any]:
        client_id = str(client_id or "")[:64]
        if not self._claim_send(client_id):
            logger.info("duplicate send %s ignored; the chief already has it", client_id)
            return {"ok": True, "accepted": True, "duplicate": True}
        try:
            result = self._send_once(text, attachments, thread)
        except threads.ThreadError as exc:
            result = {"ok": False, "error": str(exc)}
        if not result.get("ok"):
            self._release_send(client_id)
        return result

    _STARTUP_GRACE_S = 60.0

    def _attached_adapter(self, wait_s: float = 15.0):
        """The Command Center adapter. Right after the gateway starts, /health answers a few seconds before the
        adapter attaches; a message sent in that window waits for it instead of failing. Later on, a missing
        adapter is a real fault and is reported at once."""
        if time.monotonic() - self._started > self._STARTUP_GRACE_S:
            wait_s = 0.0
        end = time.monotonic() + wait_s
        while self.command_center_adapter is None and time.monotonic() < end and not self._watch_stop.is_set():
            time.sleep(0.25)
        return self.command_center_adapter

    def control(self, action: str, text: str = "", thread: str = threads.MAIN) -> dict[str, Any]:
        """Stop the chief's current turn, add context to it (steer), or queue a message for after it.

        These are Hermes's own chat commands (`/stop`, `/steer <text>`, `/queue <text>`), sent into the chief's
        Command Center chat, so Hermes applies its own rules: a steer lands at the next safe point and falls
        back to the queue when the turn has already ended; nothing is lost.
        """
        action = str(action or "").strip().lower()
        text = " ".join(str(text or "").split())
        if action not in ("stop", "steer", "queue"):
            return {"ok": False, "error": "Unknown control."}
        if action != "stop" and not text:
            return {"ok": False, "error": "Message is empty."}
        if len(text) > 8000:
            return {"ok": False, "error": "That message is too long to add mid-turn; send it as a message instead."}
        try:
            bind, chat = self.thread_bind(thread)
        except threads.ThreadError as exc:
            return {"ok": False, "error": str(exc)}
        cc = self._attached_adapter()
        sk = bind.get("sessionKey") or ""
        if cc is None or not sk:
            return {"ok": False, "error": "Command Center is not attached. Relaunch Chief Command Center."}
        if action == "steer":
            # Hermes steers plain text when the chief's busy_input_mode is "steer"; in "interrupt" mode the same
            # text would STOP the turn, so refuse rather than surprise.
            if _busy_input_mode() != "steer":
                return {"ok": False, "code": "mode", "error": "Adding to running work needs the chief's busy mode set to steer."}
            command = text
        else:
            command = "/stop" if action == "stop" else f"/queue {text}"
        try:
            accepted = _queue_inbound(cc, command, chat_id=chat)
        except Exception as exc:
            logger.warning("command_center control failed: %s", type(exc).__name__)
            return {"ok": False, "error": "Command Center send failed."}
        if not accepted:
            return {"ok": False, "error": f"{identity.assistant_name()} did not accept that. Command Center is not ready."}
        self.broadcast({"type": f"control_{action}", "at": time.time()})
        return {"ok": True, "action": action, "generating": self.generating(sk)}

    def _send_once(self, text: str, attachments: list | None = None, thread: str = threads.MAIN) -> dict[str, Any]:
        if not (text or "").strip() and not attachments:
            return {"ok": False, "error": "Message is empty."}
        bind, chat = self.thread_bind(thread)
        sk = bind.get("sessionKey") or ""
        platform = bind.get("platform") or ("command_center" if ":command_center:" in sk else "discord")
        # Command Center is the front door. Never inject into a dead Discord session.
        use_cc = platform == "command_center" or data._command_center_enabled()
        cc = self._attached_adapter() if use_cc else self.command_center_adapter
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
                accepted = _queue_inbound(cc, text, composed["media"], composed["message_type"], chat_id=chat)
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
        note_legacy("Discord DM session (inject)")
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
    except (persona.PersonaError, second_brain.SecondBrainError, speech_model.SpeechModelError, fleet.FleetError, threads.ThreadError, routines.RoutineError) as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # the adapter maps expected failures itself
        logger.warning("bridge action failed: %s", type(exc).__name__)
        return {"ok": False, "error": providers._plain(exc)}


def hermes_build() -> str:
    """The running Hermes: its version, upstream commit and the app's patches, from the build's install stamp
    ("2026.9.24 · upstream 41cd311 · 3 app patches"); "" when Hermes wasn't built by the app."""
    try:
        import hermes_cli

        stamp = json.loads((Path(hermes_cli.__file__ or "").resolve().parents[1] / "install-stamp.json").read_text(encoding="utf-8"))
    except Exception:
        return ""
    parts = [str(stamp.get("baseVersion") or stamp.get("displayVersion") or "")]
    if stamp.get("upstreamCommit"):
        parts.append(f"upstream {str(stamp['upstreamCommit'])[:7]}")
    patches = len(stamp.get("patches") or [])
    if patches:
        parts.append(f"{patches} app patch{'es' if patches != 1 else ''}")
    return " · ".join(p for p in parts if p)


def _about() -> dict[str, Any]:
    """The running Hermes build and the Second Brain toolkit's version and source (Settings → About)."""
    try:
        meta = json.loads((second_brain.toolkit_dir(data.chief_home()) / "vendor.json").read_text(encoding="utf-8"))
        toolkit = {"version": str(meta.get("version") or ""), "source": str(meta.get("source") or "")}
    except (OSError, ValueError):
        toolkit = None
    return {"ok": True, "toolkit": toolkit, "hermes": hermes_build()}


def _thread_param(qs: dict) -> str:
    return str((qs.get("thread") or [threads.MAIN])[0] or threads.MAIN)[:32]


def _thread_body(body: dict) -> str:
    return str(body.get("thread") or threads.MAIN)[:32]


def _float_param(qs: dict, name: str) -> float:
    try:
        value = float((qs.get(name) or ["0"])[0])
    except ValueError:
        return 0.0
    return value if value == value and 0 <= value < 1e11 else 0.0


def _flag(qs: dict, name: str) -> bool:
    return str((qs.get(name) or [""])[0]).lower() in ("1", "true", "yes")


def _cc_push():
    """Phone-alert keys and subscriptions (vapid.py)."""
    return vapid


def byte_range(header: str, size: int) -> tuple[int, int, bool]:
    """(start, end, partial) for a `Range: bytes=…` header: `a-b`, `a-` and the suffix form `-n` (the last n
    bytes). Anything unparsable is the whole file."""
    if not header.startswith("bytes=") or not size:
        return 0, max(size - 1, 0), False
    first = header[6:].split(",", 1)[0].strip()
    lo, _, hi = first.partition("-")
    try:
        if not lo and hi:
            n = int(hi)
            return max(size - n, 0), size - 1, True
        start = int(lo) if lo else 0
        end = int(hi) if hi else size - 1
    except ValueError:
        return 0, size - 1, False
    end = min(max(end, 0), size - 1)
    start = min(max(start, 0), end)
    return start, end, True


def _make_handler(bridge: BridgeServer):
    table = routes.build(bridge)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        # A client that stops sending mid-request no longer holds a thread forever.
        timeout = 60

        def handle_one_request(self):
            # An unexpected error answers 500 with a reason instead of dropping the connection.
            try:
                super().handle_one_request()
            except (ConnectionError, TimeoutError, OSError):
                self.close_connection = True
            except Exception:
                logger.exception("bridge request failed: %s", getattr(self, "path", ""))
                try:
                    self._json({"ok": False, "error": "The bridge hit an unexpected error."}, 500)
                except Exception:
                    pass
                self.close_connection = True

        def log_message(self, fmt, *args):
            logger.debug("%s - " + fmt, self.address_string(), *args)

        def _authorized(self) -> bool:
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return False
            # Header only: a token in the URL ends up in logs and history.
            header = self.headers.get("Authorization") or ""
            token = header[7:].strip() if header.lower().startswith("bearer ") else ""
            return bool(token) and secrets.compare_digest(token, bridge.token)

        def _read_json(self, limit: int) -> dict | None:
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

        def _dispatch(self, method: str) -> None:
            """Answer from the route table (routes.py): 401 without the token, 404 for anything not in it."""
            if not self._authorized():
                self._reject(401, "unauthorized")
                return
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            route = routes.find(table, method, path)
            if route is None:
                self._reject(404, "not found")
                return
            started = time.time()
            body: dict = {}
            if method in ("POST", "PATCH"):
                read = self._read_json(route.limit)
                if read is None:
                    logger.info("bridge %s %s rejected before handling", method, path)
                    return
                body = read
            result = route.run(routes.Request(self, path, parse_qs(parsed.query), body))
            if result is None:
                return  # the handler wrote the response itself (a file, the event stream)
            code = 200
            if isinstance(result, tuple):
                result, code = result
            if code != 200:
                self._json(result, code)
            elif route.action:
                self._act(path, started, result)
            else:
                self._json(result)

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PATCH(self):
            self._dispatch("PATCH")

        def _sse(self):
            """The dashboard's live channel: a `change` event (coalesced) whenever the change signal moves, the
            bridge's own events as they happen, and a comment every 15 s so proxies and Tailscale Serve keep the
            connection. The page refetches what it shows on `change` instead of polling on a short timer."""
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            pending: deque = deque(maxlen=200)

            def push(payload: dict) -> None:
                pending.append(payload)

            bridge.subscribe(push)
            seen = changes.version()
            try:
                self.wfile.write(b'retry: 3000\ndata: {"type":"hello"}\n\n')
                self.wfile.flush()
                while not bridge._watch_stop.is_set():
                    current = changes.wait(seen, 15.0)
                    if current == seen and not pending:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        continue
                    # A burst of changes (a turn ending writes several rows) becomes one event.
                    time.sleep(0.15)
                    seen = changes.version()
                    out = []
                    while pending:
                        out.append("data: " + json.dumps(pending.popleft(), default=str) + "\n\n")
                    out.append(f"event: change\ndata: {json.dumps({'v': seen})}\n\n")
                    self.wfile.write("".join(out).encode("utf-8"))
                    self.wfile.flush()
            except Exception:
                pass
            finally:
                bridge.unsubscribe(push)

    return Handler
