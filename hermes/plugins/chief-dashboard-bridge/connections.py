"""Connections: email, calendars, documents and work tools a bot can use, in one click (contract
`chief.connections.v1`).

Each service is a row; whatever carries it is its *backend*, one of three Hermes mechanisms:

- `quick`: **Nous Connectors** (`tools/connectors/`). One Nous sign-in, then the service's own sign-in page; Nous
  and Composio keep the sign-in (Google-verified, no warning screen, no developer account). Gmail, Calendar, Drive,
  Outlook and more. Needs a Nous account whose portal has connectors on (`connectors_available()`).
- `local`: **Google on this PC** (google_local.py): the Chief Google app's sign-in, written where Hermes's own Google
  Workspace skill reads it. Mail stays between this PC and Google.
- `mcp`: **Hermes's MCP catalog** (`optional-mcps/`, "Nous-approved"): the service's own OAuth 2.1 with dynamic
  client registration, tokens in the chief's `mcp-tokens/`. Nothing to register, nobody in the middle.

Everything runs in the chief profile's scope (`chief_scope()`: its home and its secret scope), the same pattern
Hermes's own MCP worker uses. Sign-ins that use a loopback redirect (local, mcp) finish in a browser on this PC;
Quick links work anywhere. Nothing secret is ever returned: connect links are short-lived single-use URLs to the
service, and the rest is labels and states.

The bots get one tool, `connections` (status / request): a request becomes a *Connect* card in the chat
(`connect_from_tool_row`, read from the transcript like a finished `clarify`), and a prompt section tells them what's
connected and never to send anyone off to make a developer account.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import threading
import time
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from collections.abc import Iterator

from . import google_local
from .data import chief_home

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.connections.v1"
_OP_TTL = 15 * 60
_CACHE_S = 20.0
_PREPARE_S = 31.0


class ConnectionsError(ValueError):
    pass


@dataclass(frozen=True)
class Service:
    id: str
    label: str
    group: str  # "mail" | "work"
    blurb: str
    quick: str = ""  # Nous Connectors slug
    local: bool = False  # Google on this PC
    mcp: str = ""  # MCP catalog entry


# Email and calendar first, always shown. Work tools come from the catalog (below).
MAIL_SERVICES: tuple[Service, ...] = (
    Service("gmail", "Gmail", "mail", "Read, search, draft and send email.", quick="gmail", local=True),
    Service("googlecalendar", "Google Calendar", "mail", "See and plan your events.", quick="googlecalendar", local=True),
    Service("googledrive", "Google Drive", "mail", "Find and work with your documents and sheets.", quick="googledrive", local=True),
    Service("outlook", "Outlook", "mail", "Mail and calendar for Microsoft accounts.", quick="outlook"),
)
# Shown before "Show all": the work tools people ask for most. The rest of the catalog follows alphabetically.
FEATURED_WORK = ("notion", "linear", "asana", "todoist", "atlassian", "dropbox", "clickup", "monday", "miro", "airtable", "calendly", "canva", "figma")
# Catalog entries the app doesn't offer: tools that move money. Hermes itself still can.
_NOT_OFFERED = {"paypal", "plaid", "robinhood", "square", "stripe"}


# ----------------------------------------------------------------------------- scope


@contextmanager
def chief_scope() -> Iterator[Path]:
    """The chief profile's home and secret scope for this thread (and threads started from it)."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    home = chief_home()
    home_token = set_hermes_home_override(home)
    secret_token = None
    reset_secret = None
    try:
        try:
            from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope

            secret_token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
            reset_secret = reset_secret_scope
        except Exception:
            logger.debug("chief-dashboard-bridge: no secret scope for connections", exc_info=True)
        yield home
    finally:
        if secret_token is not None and reset_secret is not None:
            with suppress(Exception):
                reset_secret(secret_token)
        reset_hermes_home_override(home_token)


# ----------------------------------------------------------------------------- Nous


def _nous_state() -> dict[str, Any]:
    """{signedIn, account, connectors}: the chief's Nous sign-in and whether its portal serves connectors."""
    try:
        from hermes_cli.nous_account import get_nous_portal_account_info
        from tools.connectors.gateway.config import connectors_available

        info = get_nous_portal_account_info()
        signed = bool(getattr(info, "logged_in", False))
        guest = bool(getattr(info, "is_anonymous_tier", False))
        return {
            "signedIn": signed and not guest,
            "guest": signed and guest,
            "account": (str(getattr(info, "email", "") or "") or None) if signed and not guest else None,
            "connectors": bool(connectors_available()),
        }
    except Exception as exc:
        logger.debug("chief-dashboard-bridge: Nous status unavailable: %s", exc)
        return {"signedIn": False, "guest": False, "account": None, "connectors": False}


_nous_lock = threading.Lock()
_nous_sessions: dict[str, str] = {}  # our session id -> Hermes's dashboard OAuth session id


def nous_start() -> dict[str, Any]:
    """Start a Nous sign-in (device code): the code and the page to enter it on. Hermes's own dashboard flow,
    so a free-tier identity's connectors carry over and the credentials land where Hermes expects them."""
    from hermes_cli.web_routers.oauth import _start_nous_device_code

    with chief_scope():
        started = asyncio.run(_start_nous_device_code("chief"))
    sid = secrets.token_urlsafe(12)
    with _nous_lock:
        _nous_sessions[sid] = str(started["session_id"])
    _invalidate()
    return {
        "ok": True,
        "session": sid,
        "code": str(started.get("user_code") or ""),
        "url": str(started.get("verification_url") or ""),
        "expiresIn": int(started.get("expires_in") or 0),
    }


def _hermes_session(sid: str) -> tuple[str, dict[str, Any] | None]:
    from hermes_cli.web_routers.oauth import _oauth_sessions, _oauth_sessions_lock

    with _nous_lock:
        hid = _nous_sessions.get(sid, "")
    with _oauth_sessions_lock:
        return hid, dict(_oauth_sessions.get(hid) or {}) if hid else None


def nous_poll(sid: str) -> dict[str, Any]:
    hid, sess = _hermes_session(sid)
    if not hid:
        raise ConnectionsError("That sign-in has ended. Start again.")
    if sess is None:
        return {"ok": True, "status": "expired"}
    status = str(sess.get("status") or "pending")
    if status != "pending":
        _invalidate()
    out: dict[str, Any] = {"ok": True, "status": status}
    if status == "error":
        out["error"] = _plain(str(sess.get("error_message") or ""), "The Nous sign-in didn't finish.")
    return out


def nous_cancel(sid: str) -> dict[str, Any]:
    from hermes_cli.web_routers.oauth import _oauth_sessions, _oauth_sessions_lock

    with _nous_lock:
        hid = _nous_sessions.pop(sid, "")
    if hid:
        with _oauth_sessions_lock:
            sess = _oauth_sessions.pop(hid, None)
            if sess is not None:
                sess["cancelled"] = True
                sess["status"] = "cancelled"
    return {"ok": True}


def nous_sign_out() -> dict[str, Any]:
    from hermes_cli.auth import clear_provider_auth, invalidate_nous_auth_status_cache

    with chief_scope():
        clear_provider_auth("nous")
        invalidate_nous_auth_status_cache()
    _invalidate()
    return {"ok": True}


# ----------------------------------------------------------------------------- quick (Nous Connectors)


def _quick_status() -> dict[str, dict[str, Any]]:
    """slug -> {connected, status, account}, from the connector gateway and the portal's accounts."""
    from tools.connectors.managed import managed_client

    out: dict[str, dict[str, Any]] = {}
    for item in managed_client().list_connectors():
        if not isinstance(item, dict):
            continue
        slug = str(item.get("connector") or "").lower()
        out[slug] = {"connected": bool(item.get("connected")), "status": str(item.get("connectionStatus") or ""), "account": None}
    with suppress(Exception):
        from tools.connectors.portal.client import PortalConnectorClient

        for acct in PortalConnectorClient().list_accounts():
            slug = str(acct.get("connector") or "").lower()
            if slug in out and acct.get("active"):
                out[slug]["account"] = str(acct.get("alias") or acct.get("label") or "") or None
    return out


def _gateway_reason(exc: BaseException) -> str:
    """Why the connector gateway refused, in a sentence, from Hermes's own error types (never its raw text)."""
    name = type(exc).__name__
    code = str(getattr(exc, "code", "") or "")
    if name == "GatewayAuthError" or code in ("NO_TOKEN", "UNAUTHORIZED") or getattr(exc, "status", 0) in (401, 403):
        return "Nous didn't accept this app's sign-in. Sign out of Nous above and sign in again."
    if name == "RateLimited" or getattr(exc, "status", 0) == 429:
        return "Nous is busy. Try again in a minute."
    if name == "GatewayUnavailable" and "not_found" in code.lower():
        return "Nous doesn't offer that service for this account yet."
    if name == "GatewayUnavailable":
        return f"Nous's connection service isn't available right now{f' ({code})' if code else ''}. Try again later."
    return f"Nous couldn't start that sign-in ({code or name})."


def _quick_connect(slug: str) -> tuple[Any, str]:
    """A connect operation driven by Hermes's own runner and watcher (the same calls as its account-owned
    `tools.connectors.account`, which swallows errors): the service's sign-in link, or the gateway's reason."""
    import contextvars
    import uuid

    from tools.connectors import live, managed
    from tools.connectors.operation import ConnectionOperation, Target
    from tools.connectors.run import drive_operation

    operation = ConnectionOperation([Target(slug, "connector", "connect")], session_key=f"account:{uuid.uuid4().hex}")
    ready = threading.Event()
    failure: list[BaseException] = []

    def run() -> None:
        try:
            drive_operation(
                operation,
                managed.managed_kind(managed.managed_client(), "connect", force=False),
                connection_callback=lambda _payload: ready.set(),
                tick_seconds=managed.WATCH_TICK_SECONDS,
                with_urls_in_result=False,
            )
        except Exception as exc:
            failure.append(exc)
            logger.warning(
                "chief-dashboard-bridge: quick connect %s failed: %s code=%s status=%s",
                slug,
                type(exc).__name__,
                getattr(exc, "code", ""),
                getattr(exc, "status", ""),
            )
        finally:
            ready.set()

    with chief_scope():
        context = contextvars.copy_context()  # the chief's home and secrets, for the runner's whole life
        live.open(operation)
    threading.Thread(target=lambda: context.run(run), name=f"chief-connect-{slug}", daemon=True).start()
    if not ready.wait(_PREPARE_S):
        raise ConnectionsError("Nous didn't answer. Try again in a moment.")
    if failure:
        raise ConnectionsError(_gateway_reason(failure[0]))
    snap = operation.snapshot()
    target = next((t for t in snap.get("targets") or [] if t.get("name") == slug), {})
    url = str(target.get("connect_url") or "")
    state = str(target.get("state") or "")
    if not url and state != "connected":
        logger.warning("chief-dashboard-bridge: quick connect %s ended %s", slug, state or "without a link")
        raise ConnectionsError(_plain(str(target.get("detail") or ""), f"Nous couldn't start that sign-in ({state or 'no link'})."))
    return operation, url


def _quick_disconnect(slug: str) -> None:
    from tools.connectors.portal.client import PortalConnectorClient

    with chief_scope():
        client = PortalConnectorClient()
        for acct in client.list_accounts():
            if str(acct.get("connector") or "").lower() == slug and acct.get("connectionId"):
                client.delete_account(str(acct["connectionId"]))


# ----------------------------------------------------------------------------- mcp (the catalog)


def _offered(entry: Any) -> bool:
    auth = getattr(entry, "auth", None)
    transport = getattr(entry, "transport", None)
    return (
        getattr(entry, "name", "") not in _NOT_OFFERED
        and getattr(transport, "type", "") == "http"
        and getattr(entry, "install", None) is None
        and getattr(auth, "type", "") in ("oauth", "none", "api_key")
        and not getattr(auth, "provider", None)
    )


def _catalog() -> list[Any]:
    from hermes_cli.mcp_catalog import list_catalog

    return [e for e in list_catalog() if _offered(e)]


def _title(name: str) -> str:
    special = {"hugging_face": "Hugging Face", "wordpress-com": "WordPress.com", "n8n-official": "n8n", "clickup": "ClickUp", "monday": "monday.com"}
    return special.get(name, name.replace("-", " ").replace("_", " ").title())


# Catalog descriptions written for developers, said plainly.
_BLURBS = {
    "figma": "Design files, components and comments in Figma.",
    "n8n-official": "Workflows in your n8n.",
    "unreal-engine": "The Unreal Engine editor on this PC.",
    "cloudflare": "Your Cloudflare sites, DNS and settings.",
}
_JARGON = (
    re.compile(r"\s+(?:via|through|over)\s+[^.]*?\bMCP\b(?:\s+server)?", re.IGNORECASE),
    re.compile(r"\s*\([^)]*\b(?:MCP|OAuth)\b[^)]*\)?", re.IGNORECASE),
    re.compile(r"\s+with browser OAuth", re.IGNORECASE),
    re.compile(r"https?://\S+"),
)


def _blurb(entry: Any) -> str:
    name = str(getattr(entry, "name", "") or "")
    if name in _BLURBS:
        return _BLURBS[name]
    text = " ".join(str(getattr(entry, "description", "") or "").split())
    for pattern in _JARGON:
        text = pattern.sub("", text)
    text = text.strip(" ,;—-")
    if text and not text.endswith((".", "!", "?", ")")):
        text += "."
    return text[:140]


def _mcp_installed() -> dict[str, dict]:
    from hermes_cli.mcp_catalog import installed_servers

    with chief_scope():
        return dict(installed_servers() or {})


def _mcp_needs(name: str) -> list[dict[str, Any]]:
    from tools.connectors.mcp import _CatalogBackend

    with chief_scope():
        return [
            {"name": n["name"], "prompt": n.get("prompt") or n["name"], "secret": bool(n.get("secret", True))} for n in _CatalogBackend().required_env(name)
        ]


def _mcp_connect(name: str, env: dict[str, str]) -> tuple[Any, str]:
    """(attempt or None, sign-in URL): an OAuth entry starts Hermes's card flow (the configuration lands only once
    the service accepts the token); a keyed or open entry is probed and saved now."""
    from tools.connectors.mcp import _CatalogBackend

    backend = _CatalogBackend()
    with chief_scope():
        if backend.installs_with_oauth(name):
            attempt = backend.start_install_oauth(name, env)
            return attempt, str(getattr(attempt, "auth_url", "") or "")
        backend.install(name, env)
    _mcp_register(name)
    return None, ""


def _mcp_register(name: str) -> None:
    """Load a newly connected server's tools in the running gateway (best effort: a restart loads them anyway)."""
    try:
        from tools.mcp_tool_discovery import register_mcp_servers

        cfg = _mcp_installed().get(name)
        if cfg:
            with chief_scope():
                register_mcp_servers({name: cfg})
    except Exception:
        logger.debug("chief-dashboard-bridge: live MCP registration skipped for %s", name, exc_info=True)


def _mcp_disconnect(name: str) -> None:
    from hermes_cli.mcp_catalog import uninstall_entry
    from tools.mcp_oauth import remove_oauth_tokens

    with chief_scope() as home:
        uninstall_entry(name, purge_install_dir=False)
        with suppress(Exception):
            remove_oauth_tokens(name, hermes_home=str(home))


# ----------------------------------------------------------------------------- operations in flight


@dataclass
class Op:
    id: str
    service: str
    backend: str
    handle: Any
    url: str
    created: float
    status: str = "pending"  # pending | connected | failed
    error: str = ""


_ops: dict[str, Op] = {}
_ops_lock = threading.Lock()


def _keep(op: Op) -> Op:
    now = time.time()
    with _ops_lock:
        for key in [k for k, o in _ops.items() if now - o.created > _OP_TTL]:
            _ops.pop(key, None)
        _ops[op.id] = op
    return op


def _settle(op: Op) -> Op:
    if op.status != "pending":
        return op
    try:
        if op.backend == "local":
            flow = op.handle
            if flow.status == "connected":
                op.status = "connected"
            elif flow.status == "error":
                op.status, op.error = "failed", flow.error
        elif op.backend == "mcp":
            res = op.handle.poll()
            if res.get("status") == "approved":
                op.status = "connected"
                _mcp_register(op.service)
            elif res.get("status") == "error":
                op.status, op.error = "failed", _plain(str(res.get("error") or ""), "The sign-in didn't finish.")
        elif op.backend == "quick":
            snap = op.handle.snapshot(with_urls=False)
            target = next((t for t in snap.get("targets") or []), {})
            state = str(target.get("state") or "")
            if state == "connected":
                op.status = "connected"
            elif state in ("failed", "expired", "skipped", "not_connected"):
                op.status, op.error = "failed", _plain(str(target.get("detail") or ""), "The sign-in didn't finish.")
    except Exception as exc:
        logger.debug("chief-dashboard-bridge: connection status read failed: %s", exc)
    if op.status != "pending":
        _invalidate()
    elif time.time() - op.created > _OP_TTL:
        op.status, op.error = "failed", "The sign-in timed out. Try again."
    return op


# ----------------------------------------------------------------------------- the page


_cache_lock = threading.Lock()
_cache: tuple[float, dict[str, Any]] | None = None


def _invalidate() -> None:
    global _cache
    with _cache_lock:
        _cache = None


def _plain(text: str, fallback: str) -> str:
    """A short human reason, never a traceback or a URL with a token in it."""
    text = " ".join(str(text or "").split())
    if not text or "Traceback" in text or "http" in text.lower() or len(text) > 200:
        return fallback
    return text


def _row(svc: Service, *, nous: dict[str, Any], quick: dict[str, dict[str, Any]], local: dict[str, Any], installed: dict[str, dict]) -> dict[str, Any]:
    backends: list[str] = []
    if svc.mcp:
        backends.append("mcp")
    # Quick only for what the gateway serves this account (when its list could be read at all).
    if svc.quick and nous.get("connectors") and (not quick or svc.quick in quick):
        backends.append("quick")
    if svc.local and local.get("available"):
        backends.append("local")
    via = None
    account = None
    state = "not_connected"
    if svc.local and svc.id in (local.get("services") or []):
        via, account, state = "local", local.get("account"), "connected"
    elif svc.mcp and svc.mcp in installed:
        via, state = "mcp", "connected"
    elif svc.quick and quick.get(svc.quick, {}).get("connected"):
        via, account, state = "quick", quick[svc.quick].get("account"), "connected"
    elif svc.quick and quick.get(svc.quick, {}).get("status") in ("expired", "revoked", "failed"):
        via, state = "quick", "reconnect"
    row = {
        "id": svc.id,
        "label": svc.label,
        "group": svc.group,
        "blurb": svc.blurb,
        "state": state,
        "via": via,
        "account": account,
        "backends": backends,
        # A service Nous carries that this account can't use yet: the page offers the sign-in.
        "needsNous": bool(svc.quick) and not nous.get("connectors") and not backends,
    }
    return row


def _work_services() -> list[Service]:
    entries = {e.name: e for e in _catalog()}
    order = [n for n in FEATURED_WORK if n in entries] + sorted(n for n in entries if n not in FEATURED_WORK)
    return [
        Service(n, _title(n), "work", _blurb(entries[n]) or f"{_title(n)} for the chief.", quick=str(getattr(entries[n], "connector_slug", "") or ""), mcp=n)
        for n in order
    ]


def services() -> list[Service]:
    try:
        work = _work_services()
    except Exception as exc:
        logger.warning("chief-dashboard-bridge: MCP catalog unavailable: %s", exc)
        work = []
    return [*MAIL_SERVICES, *work]


def _find(service_id: str) -> Service:
    for svc in services():
        if svc.id == service_id:
            return svc
    raise ConnectionsError("That isn't a service this app connects.")


def overview(refresh: bool = False) -> dict[str, Any]:
    """Every service, its state and how it's connected; the Nous sign-in; whether Google on this PC is offered."""
    global _cache
    with _cache_lock:
        if not refresh and _cache and time.time() - _cache[0] < _CACHE_S:
            return _cache[1]
    with chief_scope() as home:
        nous = _nous_state()
        local = google_local.status(home)
    quick: dict[str, dict[str, Any]] = {}
    quick_error = ""
    if nous.get("connectors"):
        try:
            with chief_scope():
                quick = _quick_status()
        except Exception as exc:
            logger.debug("chief-dashboard-bridge: connector status unavailable: %s", exc)
            quick_error = "Nous didn't answer, so quick connections may be out of date."
    try:
        installed = _mcp_installed()
    except Exception:
        installed = {}
    rows = [_row(s, nous=nous, quick=quick, local=local, installed=installed) for s in services()]
    # A service shows when it's connected, can be connected, or would be with a Nous sign-in; one this account can't
    # reach at all (Nous doesn't serve it, no private path) is left out rather than shown with nothing to press.
    rows = [r for r in rows if r["state"] != "not_connected" or r["backends"] or r["needsNous"]]
    result = {
        "ok": True,
        "contract": CONTRACT,
        "nous": nous,
        "local": {"available": bool(local.get("available")), "account": local.get("account")},
        "services": rows,
        "featured": [s.id for s in MAIL_SERVICES] + [n for n in FEATURED_WORK if any(r["id"] == n for r in rows)],
        **({"warning": quick_error} if quick_error else {}),
    }
    with _cache_lock:
        _cache = (time.time(), result)
    return result


def _listed(view: dict[str, Any], svc: Service) -> dict[str, Any]:
    """The service's row, or a plain refusal when this account can't connect it (it isn't on the page)."""
    row = next((r for r in view["services"] if r["id"] == svc.id), None)
    if row is None:
        raise ConnectionsError(f"{svc.label} can't be connected from this app yet.")
    return row


def connect(service_id: str, backend: str = "", env: dict[str, Any] | None = None) -> dict[str, Any]:
    """Start connecting a service: {op, url} to open (or {needs} for keys, or {state: connected} at once)."""
    svc = _find(service_id)
    view = overview()
    row = _listed(view, svc)
    allowed = row["backends"]
    backend = backend or (allowed[0] if allowed else "")
    if backend not in allowed:
        if svc.quick and not view["nous"].get("connectors"):
            raise ConnectionsError(f"{svc.label} needs a free Nous account. Sign in to Nous first.")
        raise ConnectionsError(f"{svc.label} can't be connected that way.")
    op_id = secrets.token_urlsafe(12)
    if backend == "local":
        login = str(view["local"].get("account") or "")
        with chief_scope() as home:
            flow = google_local.start(home, _google_wanted(svc.id), login_hint=login, on_done=_invalidate)
        op = _keep(Op(op_id, svc.id, "local", flow, flow.url, time.time()))
    elif backend == "mcp":
        values = {str(k): str(v) for k, v in (env or {}).items() if isinstance(k, str) and str(v or "").strip()}
        needs = [n for n in _mcp_needs(svc.mcp) if n["name"] not in values]
        if needs:
            return {"ok": True, "needs": needs}
        attempt, url = _mcp_connect(svc.mcp, values)
        if attempt is None or not url:
            _invalidate()
            return {"ok": True, "state": "connected"}
        op = _keep(Op(op_id, svc.id, "mcp", attempt, url, time.time()))
    else:
        operation, url = _quick_connect(svc.quick)
        if not url:
            _invalidate()
            return {"ok": True, "state": "connected"}
        op = _keep(Op(op_id, svc.id, "quick", operation, url, time.time()))
    return {"ok": True, "op": op.id, "url": op.url, "backend": op.backend, "finishOnPc": op.backend in ("local", "mcp")}


def _google_wanted(service_id: str) -> list[str]:
    """This service plus the Google services already connected on this PC (one consent covers them all)."""
    with chief_scope() as home:
        have = google_local.status(home).get("services") or []
    return [service_id, *[s for s in have if s != service_id]]


def op_status(op_id: str) -> dict[str, Any]:
    with _ops_lock:
        op = _ops.get(op_id)
    if op is None:
        raise ConnectionsError("That sign-in has ended. Start again.")
    op = _settle(op)
    out: dict[str, Any] = {"ok": True, "status": op.status, "service": op.service, "backend": op.backend}
    if op.error and op.error != "cancelled":
        out["error"] = op.error
    return out


def op_cancel(op_id: str) -> dict[str, Any]:
    with _ops_lock:
        op = _ops.pop(op_id, None)
    if op is not None and op.status == "pending":
        with suppress(Exception):
            if op.backend == "local":
                op.handle.cancel()
            elif op.backend == "mcp":
                from tools.connectors.mcp_oauth import cancel_attempt

                cancel_attempt(op.handle.flow)
    return {"ok": True}


def disconnect(service_id: str) -> dict[str, Any]:
    svc = _find(service_id)
    row = _listed(overview(refresh=True), svc)
    via = row.get("via")
    if via == "local":
        with chief_scope() as home:
            google_local.disconnect(home)
    elif via == "mcp":
        _mcp_disconnect(svc.mcp)
    elif via == "quick":
        _quick_disconnect(svc.quick)
    _invalidate()
    return {"ok": True, "also": [s.id for s in MAIL_SERVICES if s.local and s.id != svc.id] if via == "local" else []}


# ----------------------------------------------------------------------------- the bots


TOOL_SCHEMA = {
    "name": "connections",
    "description": (
        "See which outside services (email, calendar, documents, work tools) are connected for you, and ask the "
        "owner to connect one. action=status lists them. action=request shows the owner a Connect card in the chat "
        "for one service; after asking, carry on with what you can and pick the task up when they say it's "
        "connected. Never ask anyone to create a Google Cloud project, an OAuth client, an app password or an API "
        "key for a service on this list."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["status", "request"]},
            "service": {"type": "string", "description": "for request: a service id from status, e.g. gmail, googlecalendar, outlook, notion"},
            "why": {"type": "string", "description": "for request: one short line the owner sees, e.g. 'to sort your inbox'"},
        },
        "required": ["action"],
    },
}


def tool_status() -> dict[str, Any]:
    view = overview()
    connected = [{"id": r["id"], "label": r["label"], "via": r["via"]} for r in view["services"] if r["state"] == "connected"]
    offered = [
        {"id": r["id"], "label": r["label"]} for r in view["services"] if r["state"] != "connected" and (r["group"] == "mail" or r["id"] in view["featured"])
    ]
    return {
        "ok": True,
        "connected": connected,
        "can_request": offered,
        "more": "Any tool from Hermes's MCP catalog can be requested by its id too.",
        "how": _how(connected),
    }


def _how(connected: list[dict[str, Any]]) -> str:
    vias = {c["via"] for c in connected}
    tips = []
    if "local" in vias:
        tips.append(
            "Google on this PC: run the google-workspace skill's scripts/google_api.py (gmail/calendar/drive); never its setup.py, it is already set up."
        )
    if "quick" in vias:
        tips.append("Quick connections: find the service's tools with tool_search, then tool_describe / tool_call.")
    if "mcp" in vias:
        tips.append("Work tools: their mcp__<service>__* tools are available directly.")
    tips.append("Sending, replying, forwarding, deleting or moving mail asks the owner first; that is expected, not an error.")
    return " ".join(tips)


def tool_request(service_id: str, why: str) -> dict[str, Any]:
    svc = _find(str(service_id or "").strip().lower())
    row = _listed(overview(), svc)
    if row["state"] == "connected":
        return {"ok": True, "already_connected": True, "service": svc.id, "how": _how([{"via": row["via"]}])}
    return {
        "ok": True,
        "chief_connect": {"service": svc.id, "label": svc.label, "why": " ".join(str(why or "").split())[:160]},
        "note": f"The owner now sees a Connect {svc.label} card. Carry on with what you can; continue when they say it's connected.",
    }


def tool_handler(args: dict, **_kw) -> str:
    try:
        action = str((args or {}).get("action") or "status")
        if action == "request":
            result = tool_request(str(args.get("service") or ""), str(args.get("why") or ""))
        else:
            result = tool_status()
    except ConnectionsError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception as exc:
        logger.warning("connections tool failed: %s", type(exc).__name__)
        result = {"ok": False, "error": f"That didn't work ({type(exc).__name__})."}
    return json.dumps(result)


PROMPT_MAX = 900


def prompt_section(_info: Any = None) -> str:
    """What's connected, for each conversation of the chief (cheap: files only, no network)."""
    try:
        with chief_scope() as home:
            local = google_local.status(home)
            installed = sorted(_mcp_installed())
    except Exception:
        local, installed = {"services": []}, []
    lines = ["## Connections", "Outside services reach you through the `connections` tool (status / request)."]
    if local.get("services"):
        labels = ", ".join(s.label for s in MAIL_SERVICES if s.id in local["services"])
        lines.append(f"Connected on this PC: {labels} (use the google-workspace skill's google_api.py; its setup is already done).")
    if installed:
        lines.append(f"Work tools connected: {', '.join(_title(n) for n in installed[:12])}.")
    lines.append(
        "If a task needs a service that isn't connected, call connections with action=request instead of explaining "
        "setup steps. Never ask the owner to create a Google Cloud project, OAuth client, app password or API key "
        "for email, calendar, documents or a catalog work tool. Sending, deleting or moving mail asks the owner first."
    )
    return "\n".join(lines)[:PROMPT_MAX]


# ----------------------------------------------------------------------------- the chat card


def connect_from_tool_row(content: Any) -> list[dict[str, Any]]:
    """Connect cards from one tool result row: our `connections` request, or Hermes's own `manage_connections`
    links and CONNECTION_REQUIRED errors (rendered here so a bot never pastes a raw sign-in link)."""
    try:
        data = json.loads(content) if isinstance(content, str) else content
    except (TypeError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    req = data.get("chief_connect")
    if isinstance(req, dict) and req.get("service"):
        return [{"service": str(req["service"]), "label": str(req.get("label") or req["service"]), "why": str(req.get("why") or "")}]
    out = []
    if str(data.get("code") or "") == "CONNECTION_REQUIRED" and data.get("connector"):
        out.append({"service": _service_for_slug(str(data["connector"])), "label": "", "why": ""})
    for target in data.get("targets") or []:
        if isinstance(target, dict) and target.get("connect_url") and target.get("name"):
            name = str(target["name"])
            out.append({"service": name if target.get("kind") == "mcp" else _service_for_slug(name), "label": "", "why": ""})
    return out


def _service_for_slug(slug: str) -> str:
    slug = slug.lower()
    for svc in MAIL_SERVICES:
        if svc.quick == slug:
            return svc.id
    return slug


def call(fn: Any) -> Any:
    """Run a connections action for a route: a plain message, never a traceback, a token or a URL."""
    try:
        return fn()
    except ConnectionsError as exc:
        return {"ok": False, "error": str(exc)}, 400
    except google_local.GoogleLocalError as exc:
        return {"ok": False, "error": str(exc)}, 400
    except ImportError:
        return {"ok": False, "error": "This Hermes can't connect services from the app (see Status)."}, 501
    except Exception as exc:
        logger.warning("connections action failed: %s", type(exc).__name__, exc_info=True)
        return {"ok": False, "error": _plain(str(exc), "That didn't work. Try again.")}, 500
