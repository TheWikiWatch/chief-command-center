"""Google "on this PC": the Chief Google app's sign-in, kept between this PC and Google.

The private path for Gmail, Google Calendar and Drive (the default is Nous Connectors, connections.py). It writes
the token Hermes's own Google Workspace skill reads (`<profile>/google_token.json`, `authorized_user` shape), so the
skill's `google_api.py` does the actual work and its setup (a Google Cloud project per person) is never needed.

- One Desktop OAuth client for every install: Google treats a desktop client's secret as not secret, but it stays
  out of the public repo (forks would spend the app's 100-user allowance). The app passes its file as
  `CHIEF_GOOGLE_CLIENT_FILE` (the JSON Google's console downloads); without it this path is simply unavailable.
- Authorization code + PKCE with a loopback redirect on an ephemeral port (Google's guidance for desktop apps), so
  the sign-in finishes in a browser on this PC. The receiver serves one request and checks `state`.
- Scopes per service, added incrementally (`include_granted_scopes`); `openid email` names the account.
- The file's `scopes` are exactly the granted ones (google-auth sends them on refresh, and Google refuses any it
  never granted) and `expiry` is written, or google-auth would never refresh the access token.
- Disconnect revokes at Google, then deletes the file.

Nothing here is ever returned to the dashboard but the account's address and which services are on.
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import json
import logging
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import suppress
from datetime import datetime, timedelta, UTC
from pathlib import Path
from typing import Any
from collections.abc import Callable

logger = logging.getLogger("chief-dashboard-bridge")

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
TOKEN_FILE = "google_token.json"
# The account's address, beside the token: the skill rewrites the token file on each refresh and keeps only its own fields.
ACCOUNT_FILE = "google_account.json"
CLIENT_ENV = "CHIEF_GOOGLE_CLIENT_FILE"

_G = "https://www.googleapis.com/auth/"
IDENTITY_SCOPES = ("openid", _G + "userinfo.email")
# What each service asks Google for. gmail.modify covers reading, labels and the bin; gmail.send covers sending.
SERVICE_SCOPES: dict[str, tuple[str, ...]] = {
    "gmail": (_G + "gmail.modify", _G + "gmail.send"),
    "googlecalendar": (_G + "calendar",),
    "googledrive": (_G + "drive", _G + "documents", _G + "spreadsheets"),
}
FLOW_TTL = 10 * 60
_HTTP_TIMEOUT = 20


class GoogleLocalError(RuntimeError):
    pass


def client() -> dict[str, str] | None:
    """{client_id, client_secret} from the app's client file, or None when this build has none."""
    path = os.environ.get(CLIENT_ENV, "").strip()
    if not path:
        return None
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.warning("chief-dashboard-bridge: the Google client file can't be read")
        return None
    block = raw.get("installed") or raw.get("web") or raw if isinstance(raw, dict) else {}
    cid, secret = str(block.get("client_id") or ""), str(block.get("client_secret") or "")
    return {"client_id": cid, "client_secret": secret} if cid.endswith(".apps.googleusercontent.com") else None


def token_path(home: Path) -> Path:
    return Path(home) / TOKEN_FILE


def read_token(home: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(token_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("refresh_token") else None


def _account(home: Path) -> str:
    try:
        return str(json.loads((Path(home) / ACCOUNT_FILE).read_text(encoding="utf-8")).get("account") or "")
    except (OSError, ValueError, AttributeError):
        return ""


def services_in(scopes: list[str] | tuple[str, ...]) -> list[str]:
    """The services a set of granted scopes covers in full."""
    have = set(scopes)
    return [svc for svc, need in SERVICE_SCOPES.items() if set(need) <= have]


def status(home: Path) -> dict[str, Any]:
    """{available, connected, account, services}: no token, secret or scope ever leaves."""
    token = read_token(home)
    return {
        "available": client() is not None,
        "connected": bool(token),
        "account": (_account(home) or None) if token else None,
        "services": services_in(list((token or {}).get("scopes") or [])) if token else [],
    }


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _id_token_email(id_token: str) -> str:
    """The address in Google's id_token (straight from the token endpoint over TLS; only shown, never trusted)."""
    try:
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return str(claims.get("email") or "")
    except Exception:
        return ""


def _post(url: str, form: dict[str, str]) -> dict[str, Any]:
    body = urllib.parse.urlencode(form).encode("ascii")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8") or "{}")
        except Exception:
            detail = {}
        raise GoogleLocalError(str(detail.get("error_description") or detail.get("error") or f"Google answered {exc.code}")) from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise GoogleLocalError("Google couldn't be reached. Check the internet connection and try again.") from exc


def write_token(home: Path, response: dict[str, Any], cid: dict[str, str], previous: dict[str, Any] | None) -> dict[str, Any]:
    """The skill's `authorized_user` file from a token response (keeping an earlier refresh token if Google sent
    none this time)."""
    refresh = str(response.get("refresh_token") or (previous or {}).get("refresh_token") or "")
    if not refresh:
        raise GoogleLocalError("Google didn't grant lasting access. Try connecting again.")
    granted = sorted(set(str(response.get("scope") or "").split()) | set((previous or {}).get("scopes") or []))
    ttl = int(response.get("expires_in") or 3600)
    token = {
        "type": "authorized_user",
        "token": str(response.get("access_token") or ""),
        "refresh_token": refresh,
        "token_uri": TOKEN_URL,
        "client_id": cid["client_id"],
        "client_secret": cid["client_secret"],
        "scopes": granted,
        "expiry": (datetime.now(UTC) + timedelta(seconds=ttl)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    path = token_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    tmp.write_text(json.dumps(token, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    account = _id_token_email(str(response.get("id_token") or ""))
    if account:
        (Path(home) / ACCOUNT_FILE).write_text(json.dumps({"account": account}), encoding="utf-8")
    return token


class Flow:
    """One sign-in in flight: its URL, its one-shot loopback receiver, and how it ended."""

    def __init__(self, home: Path, services: list[str], cid: dict[str, str], login_hint: str = "", on_done: Callable[[], None] | None = None):
        unknown = [s for s in services if s not in SERVICE_SCOPES]
        if unknown or not services:
            raise GoogleLocalError("That isn't a Google service this app connects.")
        self.home = Path(home)
        self.services = services
        self.cid = cid
        self.state = secrets.token_urlsafe(24)
        self.verifier = _b64url(secrets.token_bytes(48))
        self.status = "pending"  # pending | connected | error
        self.error = ""
        self.created = time.time()
        self._on_done = on_done
        self._lock = threading.Lock()
        self._server = self._bind()
        self.redirect_uri = f"http://127.0.0.1:{self._server.server_address[1]}/"
        scopes: list[str] = list(IDENTITY_SCOPES)
        for svc in services:
            scopes.extend(SERVICE_SCOPES[svc])
        query = {
            "client_id": cid["client_id"],
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": " ".join(scopes),
            "state": self.state,
            "code_challenge": _b64url(hashlib.sha256(self.verifier.encode("ascii")).digest()),
            "code_challenge_method": "S256",
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
        }
        if login_hint:
            query["login_hint"] = login_hint
        self.url = AUTH_URL + "?" + urllib.parse.urlencode(query)
        threading.Thread(target=self._serve, name="chief-google-signin", daemon=True).start()

    def _bind(self) -> http.server.HTTPServer:
        flow = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                if parsed.path not in ("/", ""):
                    self.send_response(404)
                    self.end_headers()
                    return
                ok = flow.finish(urllib.parse.parse_qs(parsed.query))
                page = _page(ok, flow.error)
                self.send_response(200 if ok else 400)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with suppress(Exception):
                    self.wfile.write(page)

            def log_message(self, format, *args):
                return

        return http.server.HTTPServer(("127.0.0.1", 0), Handler)

    def _serve(self) -> None:
        self._server.timeout = 1.0
        deadline = self.created + FLOW_TTL
        while self.status == "pending" and time.time() < deadline:
            self._server.handle_request()
        with self._lock:
            if self.status == "pending":
                self.status, self.error = "error", "The sign-in timed out. Try connecting again."
        with suppress(Exception):
            self._server.server_close()

    def finish(self, query: dict[str, list[str]]) -> bool:
        """The browser's redirect: check `state`, trade the code for tokens, write the file. Once only."""
        with self._lock:
            if self.status != "pending":
                return self.status == "connected"
            state = (query.get("state") or [""])[0]
            if not state or not secrets.compare_digest(state, self.state):
                return False  # not ours: keep waiting for the real redirect
            error = (query.get("error") or [""])[0]
            code = (query.get("code") or [""])[0]
            try:
                if error:
                    raise GoogleLocalError("Google sign-in was cancelled." if error == "access_denied" else f"Google said: {error}")
                if not code:
                    raise GoogleLocalError("Google didn't send a sign-in code.")
                response = _post(
                    TOKEN_URL,
                    {
                        "code": code,
                        "client_id": self.cid["client_id"],
                        "client_secret": self.cid["client_secret"],
                        "redirect_uri": self.redirect_uri,
                        "grant_type": "authorization_code",
                        "code_verifier": self.verifier,
                    },
                )
                token = write_token(self.home, response, self.cid, read_token(self.home))
                missing = [s for s in self.services if s not in services_in(token["scopes"])]
                if missing:
                    raise GoogleLocalError("Some permissions were left unticked on Google's page. Connect again and allow them all.")
                self.status = "connected"
            except GoogleLocalError as exc:
                self.status, self.error = "error", str(exc)
            except Exception as exc:
                logger.warning("chief-dashboard-bridge: Google sign-in failed: %s", type(exc).__name__)
                self.status, self.error = "error", "The Google sign-in didn't finish. Try again."
        if self._on_done is not None:
            with suppress(Exception):
                self._on_done()
        return self.status == "connected"

    def cancel(self) -> None:
        with self._lock:
            if self.status == "pending":
                self.status, self.error = "error", "cancelled"


def start(home: Path, services: list[str], login_hint: str = "", on_done: Callable[[], None] | None = None) -> Flow:
    cid = client()
    if cid is None:
        raise GoogleLocalError("This copy of the app can't connect Google privately. Use Quick instead.")
    return Flow(home, services, cid, login_hint=login_hint, on_done=on_done)


def disconnect(home: Path) -> dict[str, Any]:
    """Revoke at Google (best effort: a revoked or expired token is already gone there), then delete the file."""
    token = read_token(home)
    if token:
        with suppress(GoogleLocalError):
            _post(REVOKE_URL, {"token": str(token.get("refresh_token") or "")})
    token_path(home).unlink(missing_ok=True)
    (Path(home) / ACCOUNT_FILE).unlink(missing_ok=True)
    return {"ok": True}


def _page(ok: bool, error: str) -> bytes:
    title = "Connected" if ok else "That didn't work"
    note = "Google is connected to Chief. You can close this tab." if ok else (error or "Go back to Chief and try again.")
    mark = "✓" if ok else "!"
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · Chief</title><style>
:root{{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1d1c1a;--muted:#6b6a65;--accent:{"#2f7d4f" if ok else "#a3402d"}}}
@media (prefers-color-scheme:dark){{:root{{--bg:#151514;--card:#1f1f1d;--fg:#ecebe6;--muted:#a3a29b;--accent:{"#5fbf86" if ok else "#e0806b"}}}}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif}}
main{{background:var(--card);border-radius:16px;padding:32px 36px;max-width:360px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 24px rgba(0,0,0,.06)}}
.mark{{width:44px;height:44px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;font-size:22px;color:#fff;background:var(--accent)}}
h1{{font-size:20px;font-weight:600;margin:0 0 6px}}p{{margin:0;color:var(--muted)}}
</style></head><body><main><div class="mark">{mark}</div><h1>{title}</h1><p>{_escape(note)}</p></main></body></html>"""
    return html.encode("utf-8")


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
