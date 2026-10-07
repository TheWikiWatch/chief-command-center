"""Every route the bridge serves, in one table: method, path, body limit, whether the dashboard's proxy may
reach it, and the function that answers.

The dashboard proxy keeps its own allow-list (apps/web/lib/proxy-policy.ts); `hermes/tests/test_routes.py` fails
when the two disagree, so a route is never reachable by accident or missing by mistake. A handler returns a
JSON-able result (a dict, or `(dict, status)`), or None after writing the response itself (files, the event
stream). Routes marked `action` are logged as one line per user action (never with their bodies).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any
from collections.abc import Callable

KB = 1024
MB = 1024 * KB
DEFAULT_BODY = 1 * MB


@dataclass
class Request:
    handler: Any  # the BaseHTTPRequestHandler answering this request
    path: str
    qs: dict
    body: dict = field(default_factory=dict)

    def q(self, name: str, default: str = "") -> str:
        return str((self.qs.get(name) or [default])[0])

    def b(self, name: str, default: str = "") -> str:
        return str(self.body.get(name) or default)


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    run: Callable[[Request], Any]
    limit: int = DEFAULT_BODY
    dashboard: bool = True
    action: bool = False
    prefix: bool = False

    def matches(self, method: str, path: str) -> bool:
        if method != self.method:
            return False
        return path.startswith(self.path + "/") and path.count("/") == self.path.count("/") + 1 if self.prefix else path == self.path


def find(routes: list[Route], method: str, path: str) -> Route | None:
    for route in routes:
        if route.matches(method, path):
            return route
    return None


def build(bridge) -> list[Route]:
    """The table, bound to one BridgeServer."""
    from . import data, fleet, hermes_api, identity, media, persona, providers, push, report, routines, second_brain, speech_model, threads, usage, voice
    from . import settings as hermes_settings
    from . import tools_settings
    from .server import _about, _cc_push, _flag, _float_param, _guarded, _thread_body, _thread_param, byte_range, legacy_in_use

    def int_q(req: Request, name: str, default: int) -> int:
        try:
            return int(req.q(name, str(default)) or default)
        except ValueError:
            return default

    def profile(req: Request) -> str:
        return req.b("profile", "chief")

    # ------------------------------------------------------------------ raw responses

    def avatar(req: Request):
        blob = data.avatar_bytes(req.path.split("/")[-1])
        h = req.handler
        if not blob:
            h._reject(404, "no avatar")
            return None
        raw, mime = blob
        h.send_response(200)
        h.send_header("Content-Type", mime)
        h.send_header("Content-Length", str(len(raw)))
        h.send_header("Cache-Control", "private, max-age=60")
        h.end_headers()
        h.wfile.write(raw)
        return None

    def file(req: Request):
        h = req.handler
        raw_path = req.q("path")
        bind = bridge.binding()
        data.warm_media_cache(bind.get("sessionKey") or "")
        allowed = data.file_is_allowed(raw_path)
        if not allowed:
            h._reject(404, "not found")
            return None
        resolved, mime = allowed
        if req.path == "/preview":
            resolved = media.preview_for(resolved)
            mime = "video/mp4" if resolved.suffix.lower() == ".mp4" else mime
        elif req.path == "/thumb":
            thumb = media.thumb_for(resolved) if mime.startswith("video/") else None
            if not thumb:
                h._reject(404, "no thumbnail")
                return None
            resolved, mime = thumb, "image/jpeg"
        size = resolved.stat().st_size
        start, end, partial = byte_range(h.headers.get("Range") or "", size)
        status = 206 if partial else 200
        length = (end - start + 1) if size else 0
        safe_name = resolved.name.replace('"', "")
        h.send_response(status)
        h.send_header("Content-Type", mime)
        h.send_header("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'")
        h.send_header("X-Content-Type-Options", "nosniff")
        h.send_header("Content-Length", str(length))
        h.send_header("Accept-Ranges", "bytes")
        disposition = "attachment" if mime in ("image/svg+xml", "application/octet-stream", "text/html") else "inline"
        h.send_header("Content-Disposition", f'{disposition}; filename="{safe_name}"')
        h.send_header("Cache-Control", f"private, max-age={3600 if req.path == '/thumb' else 60}")
        if status == 206:
            h.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        h.end_headers()
        with resolved.open("rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(65536, remaining))
                if not chunk:
                    break
                h.wfile.write(chunk)
                remaining -= len(chunk)
        return None

    def events(req: Request):
        req.handler._sse()
        return None

    def push_call(fn):
        def run(req: Request):
            try:
                return fn(req)
            except Exception as exc:
                return {"ok": False, "error": str(exc)}, 500

        return run

    # ------------------------------------------------------------------ JSON routes

    def transcript(req: Request):
        return _guarded(
            lambda: bridge.live_transcript(
                max(0, int_q(req, "after", 0)),
                wait=max(0, int_q(req, "wait", 0)),
                gen=req.q("gen"),
                approval=req.q("approval")[:128],
                before=max(0, int_q(req, "before", 0)),
                clarify=(req.qs.get("clarify") or [None])[0],
                notice=(req.qs.get("notice") or [None])[0],
                notice_since=_float_param(req.qs, "nsince"),
                thread=_thread_param(req.qs),
                session=req.q("session")[:64],
                background=(req.qs.get("bg") or [None])[0],
                draft=(req.qs.get("draft") or [None])[0],
            )
        )

    def clarify(req: Request):
        answer = req.body.get("answer")
        if not isinstance(answer, (str, list)):
            return {"ok": False, "error": "answer must be text or a list"}, 400
        return _guarded(lambda: bridge.answer_question(req.b("id")[:128], answer, _thread_body(req.body)))

    def routine_update(req: Request):
        b = req.body
        schedule, enabled = b.get("schedule"), b.get("enabled")
        return _guarded(
            lambda: routines.update(
                profile(req),
                req.b("id"),
                name=b.get("name") if isinstance(b.get("name"), str) else None,
                prompt=b.get("prompt") if isinstance(b.get("prompt"), str) else None,
                schedule=schedule if isinstance(schedule, dict) else None,
                thread=b.get("thread") if isinstance(b.get("thread"), str) else None,
                enabled=enabled if isinstance(enabled, bool) else None,
            )
        )

    def second_brain_routine(req: Request):
        enabled, at = req.body.get("enabled"), req.body.get("time")
        return _guarded(
            lambda: second_brain.set_routine(req.b("id"), enabled=enabled if isinstance(enabled, bool) else None, at=str(at) if isinstance(at, str) else None)
        )

    def voice_model_use(req: Request):
        err = speech_model.use(req.b("id"))
        return {"ok": False, "error": err} if err else {"ok": True}

    def push_subscribe(req: Request):
        sub = req.body.get("subscription")
        return _cc_push().upsert_subscription(sub if isinstance(sub, dict) else req.body)

    def push_test(req: Request):
        return push.send(req.b("title", identity.assistant_name()), req.b("body", "Test push from Chief"), url=req.b("url", "/"), tag="test")

    def outbox_notify(req: Request):
        bridge.broadcast({"type": "cc_outbox", "at": time.time(), "id": req.body.get("id")})
        return {"ok": True}

    G, P = "GET", "POST"
    A = {"action": True}
    return [
        # Status and the chat
        Route(
            G,
            "/health",
            lambda r: {
                "ok": True,
                "gateway": True,
                "voice": True,
                "profile": "chief",
                "longpoll": True,
                "hermes": hermes_api.check(),
                "legacy": legacy_in_use(),
            },
        ),
        Route(G, "/snapshot", lambda r: bridge.snapshot()),
        Route(G, "/events", events),
        Route(G, "/transcript", transcript),
        Route(G, "/approvals", lambda r: _guarded(lambda: bridge.approvals(_thread_param(r.qs)))),
        Route(
            P,
            "/send",
            lambda r: bridge.send(
                r.b("text"), r.body["attachments"] if isinstance(r.body.get("attachments"), list) else [], r.b("client_id"), _thread_body(r.body)
            ),
            limit=80 * MB,
            **A,
        ),  # in step with lib/upload-limits.ts (55 MB of files is ~73 MB of base64 JSON)
        Route(P, "/stop", lambda r: bridge.control("stop", r.b("text"), _thread_body(r.body)), **A),
        Route(P, "/steer", lambda r: bridge.control("steer", r.b("text"), _thread_body(r.body)), **A),
        Route(P, "/queue", lambda r: bridge.control("queue", r.b("text"), _thread_body(r.body)), **A),
        Route(P, "/clarify", clarify, **A),
        Route(
            P,
            "/approve",
            lambda r: _guarded(
                lambda: bridge.approve(str(r.body.get("request_id") or r.body.get("requestId") or ""), r.b("choice").strip().lower(), _thread_body(r.body))
            ),
            **A,
        ),
        Route(G, "/outbox", lambda r: bridge.outbox(after_id=r.q("after"), limit=min(max(1, int_q(r, "limit", 50)), 500)), dashboard=False),
        Route(P, "/outbox/notify", outbox_notify, dashboard=False),
        # Threads and routines
        Route(G, "/threads", lambda r: _guarded(bridge.thread_list)),
        Route(P, "/threads", lambda r: _guarded(lambda: threads.create(r.b("title"))), **A),
        Route(P, "/threads/rename", lambda r: _guarded(lambda: threads.rename(_thread_body(r.body), r.b("title"))), **A),
        Route(P, "/threads/archive", lambda r: _guarded(lambda: threads.archive(_thread_body(r.body), r.body.get("archived") is not False)), **A),
        Route(P, "/threads/fresh", lambda r: _guarded(lambda: bridge.fresh_start(_thread_body(r.body))), **A),
        Route(G, "/routines", lambda r: _guarded(routines.list_routines)),
        Route(
            P,
            "/routines",
            lambda r: _guarded(
                lambda: routines.create(
                    profile(r), r.b("name"), r.b("prompt"), r.body["schedule"] if isinstance(r.body.get("schedule"), dict) else {}, _thread_body(r.body)
                )
            ),
            **A,
        ),
        Route(P, "/routines/update", routine_update, **A),
        Route(P, "/routines/run", lambda r: _guarded(lambda: routines.run_now(profile(r), r.b("id"))), **A),
        Route(P, "/routines/delete", lambda r: _guarded(lambda: routines.delete(profile(r), r.b("id"))), **A),
        # Files and pictures
        Route(G, "/file", file),
        Route(G, "/preview", file),
        Route(G, "/thumb", file),
        Route(G, "/profile", lambda r: data.profile_peek(r.path.split("/")[-1]), prefix=True),
        Route(G, "/avatar", avatar, prefix=True),
        # Voice
        Route(G, "/voice-config", lambda r: voice.voice_config()),
        Route(P, "/transcribe", lambda r: voice.transcribe(r.body), limit=voice.MAX_UPLOAD_BYTES * 2, **A),
        Route(P, "/speak", lambda r: voice.speak(r.b("text")), **A),
        Route(G, "/voice/model", lambda r: _guarded(speech_model.status)),
        Route(P, "/voice/model/download", lambda r: _guarded(lambda: speech_model.download(r.b("id", speech_model.DEFAULT_MODEL))), **A),
        Route(P, "/voice/model/cancel", lambda r: _guarded(speech_model.cancel), **A),
        Route(P, "/voice/model/delete", lambda r: _guarded(lambda: speech_model.delete(r.b("id"))), **A),
        Route(P, "/voice/model/use", lambda r: _guarded(lambda: voice_model_use(r)), dashboard=False, **A),
        # Setup: models, keys, the Second Brain
        Route(G, "/setup/status", lambda r: {"ok": True, "contract": providers.CONTRACT, **providers.status()}),
        Route(G, "/setup/providers", lambda r: _guarded(lambda: providers.catalog(refresh=_flag(r.qs, "refresh")))),
        Route(G, "/setup/models", lambda r: _guarded(lambda: providers.provider_models(r.q("provider")))),
        Route(P, "/setup/key", lambda r: _guarded(lambda: providers.save_key(r.b("provider"), r.b("key"))), **A),
        Route(P, "/setup/key/remove", lambda r: _guarded(lambda: providers.remove_key(r.b("provider"))), **A),
        Route(
            P,
            "/setup/model",
            lambda r: _guarded(lambda: providers.choose_model(r.b("provider"), r.b("model"), confirm_expensive=bool(r.body.get("confirm")))),
            **A,
        ),
        Route(P, "/setup/endpoint/check", lambda r: _guarded(lambda: providers.check_endpoint(r.b("base_url"), r.b("api_key"))), **A),
        Route(
            P,
            "/setup/endpoint/save",
            lambda r: _guarded(
                lambda: providers.save_endpoint(
                    r.b("name"), r.b("base_url"), r.b("model"), r.b("api_key"), make_default=r.body.get("make_default") is not False
                )
            ),
            **A,
        ),
        Route(P, "/setup/test", lambda r: _guarded(providers.test_message), **A),
        Route(P, "/report/draft", lambda r: _guarded(lambda: report.draft(r.b("message"), r.b("previous"), r.b("note"))), **A),
        Route(G, "/setup/second-brain", lambda r: _guarded(second_brain.status)),
        Route(
            P,
            "/setup/second-brain",
            lambda r: _guarded(
                lambda: second_brain.setup(
                    r.b("path"),
                    r.b("mode"),
                    fmt=r.body.get("format") or None,
                    routines_on=r.body.get("routines") if isinstance(r.body.get("routines"), bool) else None,
                )
            ),
            **A,
        ),
        Route(P, "/setup/second-brain/inspect", lambda r: _guarded(lambda: second_brain.inspect(r.b("path"), r.body.get("format") or None)), **A),
        Route(P, "/setup/soul/seed", lambda r: _guarded(second_brain.seed_soul), **A),
        Route(G, "/second-brain/routines", lambda r: _guarded(second_brain.routines)),
        Route(P, "/second-brain/routines", second_brain_routine, **A),
        # Identity, memory and the fleet
        Route(G, "/persona", lambda r: _guarded(lambda: persona.read_all(r.q("profile", "chief")))),
        Route(G, "/persona/soul/version", lambda r: _guarded(lambda: {"ok": True, **persona.read_version(r.q("profile", "chief"), r.q("id"))})),
        Route(P, "/persona/soul", lambda r: _guarded(lambda: persona.write_soul(profile(r), r.b("text"), r.b("base_hash"))), **A),
        Route(P, "/persona/soul/restore", lambda r: _guarded(lambda: persona.restore_version(profile(r), r.b("id"), r.b("base_hash"))), **A),
        Route(
            P,
            "/persona/memory",
            lambda r: _guarded(lambda: persona.edit_memory(profile(r), r.b("target"), r.body["ops"] if isinstance(r.body.get("ops"), list) else [])),
            **A,
        ),
        Route(
            P,
            "/profile/rename",
            lambda r: _guarded(lambda: persona.rename(profile(r), r.b("name"), r.b("role"), update_soul=r.body.get("update_soul") is not False)),
            **A,
        ),
        Route(G, "/fleet", lambda r: _guarded(fleet.roster)),
        Route(G, "/fleet/models", lambda r: _guarded(lambda: fleet.models(refresh=_flag(r.qs, "refresh")))),
        Route(
            P,
            "/fleet/model",
            lambda r: _guarded(lambda: fleet.set_model(profile(r), r.b("provider"), r.b("model"), confirm_expensive=bool(r.body.get("confirm")))),
            **A,
        ),
        # The dashboard asks the owner before calling this; the request itself is the go-ahead.
        Route(P, "/fleet/retire", lambda r: _guarded(lambda: fleet.retire(r.b("profile"), owner_confirmed=True)), **A),
        Route(P, "/fleet/restore", lambda r: _guarded(lambda: fleet.restore(r.b("archive_id"))), **A),
        Route(P, "/fleet/archive/remove", lambda r: _guarded(lambda: fleet.remove_archive(r.b("archive_id"))), **A),
        # Usage, settings, about
        Route(G, "/usage", lambda r: _guarded(lambda: usage.summary(r.q("period", "month")))),
        Route(P, "/usage/budget", lambda r: _guarded(lambda: usage.set_budget(r.body.get("monthly"))), **A),
        Route(G, "/settings", lambda r: hermes_settings.get_settings()),
        Route("PATCH", "/settings", lambda r: hermes_settings.patch_settings(r.body), limit=64 * KB, **A),
        Route(G, "/tools", lambda r: tools_settings.get_tools()),
        Route("PATCH", "/tools", lambda r: tools_settings.patch_tools(r.body), limit=64 * KB, **A),
        Route(P, "/tools/test", lambda r: tools_settings.test_tool(r.body), limit=4 * KB, **A),
        Route(G, "/about", lambda r: _about()),
        # Phone alerts
        Route(G, "/push/vapidPublicKey", push_call(lambda r: {"ok": True, "publicKey": _cc_push().public_key()})),
        Route(G, "/push/subscriptions", push_call(lambda r: {"ok": True, "count": len(_cc_push().load_subs())})),
        Route(P, "/push/subscribe", push_call(push_subscribe)),
        Route(P, "/push/unsubscribe", push_call(lambda r: _cc_push().remove_subscription(r.b("endpoint")))),
        Route(P, "/push/test", push_call(push_test)),
    ]
