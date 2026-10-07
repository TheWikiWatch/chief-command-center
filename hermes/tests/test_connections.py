"""Connections (connections.py, google_local.py, mail_guard.py): the mail guard's rule, Google on this PC end to end
against a fake Google, the Connect card from tool rows, the page's rows and the bots' tool. Synthetic data only."""

import contextlib
import importlib
import json
import os
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
RUNTIME = ROOT / "hermes/tests/.runtime"
package = types.ModuleType("test_connections_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(RUNTIME / "hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
mail_guard = importlib.import_module("test_connections_plugin.mail_guard")
google_local = importlib.import_module("test_connections_plugin.google_local")
connections = importlib.import_module("test_connections_plugin.connections")
data = importlib.import_module("test_connections_plugin.data")

_MISSING = object()
CLIENT = {"installed": {"client_id": "1234-test.apps.googleusercontent.com", "client_secret": "not-a-real-secret"}}


def fake_module(test: unittest.TestCase, name: str, **attrs) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    old = sys.modules.get(name, _MISSING)
    sys.modules[name] = module

    def restore():
        if old is _MISSING:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = old

    test.addCleanup(restore)
    return module


def gate(tool, args=None):
    out = mail_guard.check(tool, args or {})
    return out and out["rule_key"]


class MailGuardTests(unittest.TestCase):
    def test_reading_never_asks(self):
        for tool in (
            "connectors__gmail__FETCH_EMAILS",
            "connectors__gmail__GMAIL_SEARCH_PEOPLE",
            "connectors__gmail__GET_THREAD",
            "connectors__outlook__OUTLOOK_LIST_MESSAGES",
            "connectors__googlecalendar__EVENTS_LIST",
            "connectors__googledrive__FIND_FILE",
            "web_search",
            "read_file",
        ):
            self.assertIsNone(gate(tool), tool)

    def test_sending_replying_and_forwarding_ask_with_who_and_what(self):
        out = mail_guard.check(
            "connectors__gmail__GMAIL_SEND_EMAIL",
            {"recipient_email": "someone@example.com", "subject": "Thursday's plan", "body": "Hi,\n\nhere is   where we landed."},
        )
        self.assertEqual(out["action"], "approve")
        self.assertEqual(out["rule_key"], mail_guard.RULE_SEND)
        self.assertEqual(
            out["message"].split("\n"),
            ["Send an email", "To: someone@example.com", "Subject: Thursday's plan", "", "Hi, here is where we landed."],
        )
        self.assertEqual(gate("connectors__gmail__REPLY_TO_THREAD"), mail_guard.RULE_SEND)
        self.assertEqual(gate("connectors__outlook__OUTLOOK_FORWARD_MESSAGE"), mail_guard.RULE_SEND)
        self.assertEqual(gate("connectors__gmail__GMAIL_SEND_DRAFT"), mail_guard.RULE_SEND)

    def test_a_draft_is_free_but_sending_it_is_not(self):
        self.assertIsNone(gate("connectors__gmail__GMAIL_CREATE_EMAIL_DRAFT"))
        self.assertEqual(gate("connectors__gmail__SEND_DRAFT"), mail_guard.RULE_SEND)

    def test_deleting_and_moving_ask_but_marking_read_does_not(self):
        self.assertEqual(gate("connectors__gmail__GMAIL_MOVE_TO_TRASH"), mail_guard.RULE_DELETE)
        self.assertEqual(gate("connectors__outlook__OUTLOOK_DELETE_MESSAGE"), mail_guard.RULE_DELETE)
        self.assertEqual(gate("connectors__outlook__OUTLOOK_MOVE_MESSAGE"), mail_guard.RULE_MOVE)
        self.assertEqual(gate("connectors__gmail__GMAIL_ADD_LABEL_TO_EMAIL", {"remove_label_ids": ["INBOX"]}), mail_guard.RULE_MOVE)
        self.assertEqual(gate("connectors__gmail__MODIFY_THREAD_LABELS", {"add_label_ids": "SPAM"}), mail_guard.RULE_MOVE)
        self.assertIsNone(gate("connectors__gmail__GMAIL_ADD_LABEL_TO_EMAIL", {"remove_label_ids": ["UNREAD"]}))

    def test_calendar_asks_only_when_other_people_are_involved_or_an_event_goes(self):
        self.assertIsNone(gate("connectors__googlecalendar__CREATE_EVENT", {"summary": "Focus time"}))
        self.assertEqual(gate("connectors__googlecalendar__CREATE_EVENT", {"summary": "Sync", "attendees": ["a@example.com"]}), mail_guard.RULE_INVITE)
        self.assertEqual(gate("connectors__googlecalendar__DELETE_EVENT", {"event_id": "abc"}), mail_guard.RULE_INVITE)

    def test_sharing_a_document_asks(self):
        self.assertEqual(
            gate("connectors__googledrive__ADD_FILE_SHARING_PREFERENCE", {"file_id": "f1", "email_address": "x@example.com"}), mail_guard.RULE_SHARE
        )

    def test_the_skill_on_this_pc_meets_the_same_rule(self):
        script = "python ~/.hermes/skills/productivity/google-workspace/scripts/google_api.py"
        self.assertIsNone(gate("terminal", {"command": f"{script} gmail search 'is:unread' --max 5"}))
        self.assertIsNone(gate("terminal", {"command": f"{script} calendar list"}))
        out = mail_guard.check("terminal", {"command": f'{script} gmail send --to friend@example.com --subject "Hello there" --body "See you soon"'})
        self.assertEqual(out["rule_key"], mail_guard.RULE_SEND)
        self.assertIn("To: friend@example.com", out["message"])
        self.assertIn("Subject: Hello there", out["message"])
        self.assertEqual(gate("terminal", {"command": f"{script} gmail reply m1 --body ok"}), mail_guard.RULE_SEND)
        self.assertEqual(gate("terminal", {"command": f"{script} gmail modify m1 --remove-labels INBOX"}), mail_guard.RULE_MOVE)
        self.assertIsNone(gate("terminal", {"command": f"{script} gmail modify m1 --remove-labels UNREAD"}))
        self.assertEqual(
            gate("terminal", {"command": f"{script} calendar create --summary S --start a --end b --attendees x@example.com"}), mail_guard.RULE_INVITE
        )
        self.assertEqual(gate("terminal", {"command": f"{script} drive share f1 --email x@example.com"}), mail_guard.RULE_SHARE)
        self.assertEqual(gate("terminal", {"command": f"{script} gmail purge-everything"}), mail_guard.RULE_SEND)  # unknown: ask
        self.assertIsNone(gate("terminal", {"command": "ls -la"}))

    def test_a_call_the_guard_cant_read_still_asks_when_it_touches_mail(self):
        with patch.object(mail_guard, "check", side_effect=RuntimeError("boom")):
            self.assertEqual(mail_guard.pre_tool_call(tool_name="connectors__gmail__ANYTHING", args={})["action"], "approve")
            self.assertIsNone(mail_guard.pre_tool_call(tool_name="web_search", args={}))

    def test_a_long_body_is_shortened_for_the_sheet(self):
        msg = mail_guard.describe(mail_guard.RULE_SEND, {"To": "a@example.com", "Body": "word " * 200})
        self.assertLess(len(msg.split("\n")[-1]), 290)
        self.assertTrue(msg.endswith("…"))


@contextlib.contextmanager
def client_file():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "client.json"
        path.write_text(json.dumps(CLIENT), encoding="utf-8")
        with patch.dict(os.environ, {google_local.CLIENT_ENV: str(path)}):
            yield


def _id_token(email):
    import base64

    def b64(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    return f"{b64({'alg': 'none'})}.{b64({'email': email})}.sig"


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


class GoogleLocalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_unavailable_without_the_apps_client_file(self):
        with patch.dict(os.environ, {google_local.CLIENT_ENV: ""}):
            self.assertIsNone(google_local.client())
            self.assertEqual(google_local.status(self.home)["available"], False)
            with self.assertRaises(google_local.GoogleLocalError):
                google_local.start(self.home, ["gmail"])

    def test_sign_in_writes_the_skills_token_and_names_the_account(self):
        granted = " ".join(["openid", *google_local.IDENTITY_SCOPES, *google_local.SERVICE_SCOPES["gmail"]])
        calls = []

        def fake_post(url, form):
            calls.append((url, form))
            return {
                "access_token": "ya29.test",
                "refresh_token": "1//refresh-test",
                "expires_in": 3599,
                "scope": granted,
                "id_token": _id_token("owner@example.com"),
            }

        with client_file(), patch.object(google_local, "_post", side_effect=fake_post):
            flow = google_local.start(self.home, ["gmail"])
            query = urllib.parse.parse_qs(urllib.parse.urlparse(flow.url).query)
            self.assertEqual(query["redirect_uri"], [flow.redirect_uri])
            self.assertTrue(flow.redirect_uri.startswith("http://127.0.0.1:"))
            self.assertEqual(query["code_challenge_method"], ["S256"])
            self.assertEqual(query["access_type"], ["offline"])
            self.assertIn(google_local.SERVICE_SCOPES["gmail"][1], query["scope"][0].split())
            # Someone else's redirect (wrong state) is ignored; the real one finishes it.
            status, _ = _get(flow.redirect_uri + "?state=forged&code=x")
            self.assertEqual(status, 400)
            self.assertEqual(flow.status, "pending")
            status, page = _get(flow.redirect_uri + "?" + urllib.parse.urlencode({"state": flow.state, "code": "auth-code"}))
            self.assertEqual(status, 200)
            self.assertIn("Connected", page)
            self.assertEqual(flow.status, "connected")
            self.assertEqual(calls[0][1]["code_verifier"], flow.verifier)
            self.assertEqual(calls[0][1]["redirect_uri"], flow.redirect_uri)
            # A replayed redirect changes nothing (the receiver has closed).
            with contextlib.suppress(urllib.error.URLError, ConnectionError):
                _get(flow.redirect_uri + "?" + urllib.parse.urlencode({"state": flow.state, "code": "again"}))
            self.assertEqual(len(calls), 1)

            token = json.loads((self.home / "google_token.json").read_text())
            self.assertEqual(token["type"], "authorized_user")
            self.assertEqual(token["refresh_token"], "1//refresh-test")
            self.assertEqual(token["client_id"], CLIENT["installed"]["client_id"])
            self.assertEqual(token["token_uri"], google_local.TOKEN_URL)
            self.assertEqual(sorted(token["scopes"]), sorted(set(granted.split())))
            self.assertRegex(token["expiry"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
            st = google_local.status(self.home)
            self.assertEqual(st, {"available": True, "connected": True, "account": "owner@example.com", "services": ["gmail"]})
            self.assertNotIn("refresh", json.dumps(st))

    @unittest.skipUnless(importlib.util.find_spec("google.oauth2"), "google-auth isn't installed here")
    def test_the_token_loads_the_way_the_skill_loads_it(self):
        from google.oauth2.credentials import Credentials

        granted = list(google_local.SERVICE_SCOPES["gmail"])
        google_local.write_token(
            self.home, {"access_token": "ya29.x", "refresh_token": "1//r", "expires_in": 3600, "scope": " ".join(granted)}, CLIENT["installed"], None
        )
        path = self.home / "google_token.json"
        stored = json.loads(path.read_text())["scopes"]
        creds = Credentials.from_authorized_user_file(str(path), stored)
        self.assertEqual(creds.refresh_token, "1//r")
        self.assertIsNotNone(creds.expiry)  # without an expiry google-auth would never refresh
        self.assertFalse(creds.expired)
        self.assertTrue(creds.valid)

    def test_unticked_permissions_are_explained(self):
        def fake_post(url, form):
            return {"access_token": "a", "refresh_token": "r", "expires_in": 60, "scope": "openid"}

        with client_file(), patch.object(google_local, "_post", side_effect=fake_post):
            flow = google_local.start(self.home, ["gmail"])
            _get(flow.redirect_uri + "?" + urllib.parse.urlencode({"state": flow.state, "code": "c"}))
        self.assertEqual(flow.status, "error")
        self.assertIn("unticked", flow.error)

    def test_a_cancelled_consent_reads_plainly(self):
        with client_file():
            flow = google_local.start(self.home, ["googlecalendar"])
            _get(flow.redirect_uri + "?" + urllib.parse.urlencode({"state": flow.state, "error": "access_denied"}))
        self.assertEqual((flow.status, flow.error), ("error", "Google sign-in was cancelled."))

    def test_a_second_service_keeps_the_first_refresh_token_and_scopes(self):
        cid = CLIENT["installed"]
        google_local.write_token(self.home, {"access_token": "a", "refresh_token": "r1", "scope": " ".join(google_local.SERVICE_SCOPES["gmail"])}, cid, None)
        prev = google_local.read_token(self.home)
        google_local.write_token(self.home, {"access_token": "b", "scope": " ".join(google_local.SERVICE_SCOPES["googlecalendar"])}, cid, prev)
        token = google_local.read_token(self.home)
        self.assertEqual(token["refresh_token"], "r1")
        self.assertEqual(google_local.services_in(token["scopes"]), ["gmail", "googlecalendar"])

    def test_disconnect_revokes_and_removes(self):
        google_local.write_token(
            self.home, {"access_token": "a", "refresh_token": "r1", "scope": "x", "id_token": _id_token("o@example.com")}, CLIENT["installed"], None
        )
        with patch.object(google_local, "_post", return_value={}) as post:
            google_local.disconnect(self.home)
        post.assert_called_once_with(google_local.REVOKE_URL, {"token": "r1"})
        self.assertFalse((self.home / "google_token.json").exists())
        self.assertFalse((self.home / "google_account.json").exists())


class ConnectCardTests(unittest.TestCase):
    def test_our_request_becomes_a_card(self):
        row = json.dumps({"ok": True, "chief_connect": {"service": "gmail", "label": "Gmail", "why": "to sort your inbox"}})
        self.assertEqual(connections.connect_from_tool_row(row), [{"service": "gmail", "label": "Gmail", "why": "to sort your inbox"}])

    def test_hermes_links_and_connection_required_become_cards_not_raw_links(self):
        manage = {"status": "initiated", "targets": [{"name": "outlook", "kind": "connector", "state": "initiated", "connect_url": "https://example.test/l/1"}]}
        self.assertEqual(connections.connect_from_tool_row(json.dumps(manage))[0]["service"], "outlook")
        mcp = {"targets": [{"name": "notion", "kind": "mcp", "connect_url": "https://example.test/oauth"}]}
        self.assertEqual(connections.connect_from_tool_row(mcp)[0]["service"], "notion")
        required = {"code": "CONNECTION_REQUIRED", "connector": "googlecalendar", "connect_url": "https://example.test/x"}
        self.assertEqual(connections.connect_from_tool_row(required)[0]["service"], "googlecalendar")

    def test_anything_else_is_not_a_card(self):
        for content in ("", "not json", json.dumps([1, 2]), json.dumps({"ok": True}), json.dumps({"targets": [{"name": "x"}]})):
            self.assertEqual(connections.connect_from_tool_row(content), [])


class _Entry:
    def __init__(self, name, auth="oauth", transport="http", install=None, provider=None, slug=None, desc=""):
        self.name = name
        self.auth = types.SimpleNamespace(type=auth, provider=provider, env=[])
        self.transport = types.SimpleNamespace(type=transport)
        self.install = install
        self.connector_slug = slug
        self.description = desc or f"{name} for testing."


class OverviewTests(unittest.TestCase):
    def setUp(self):
        connections._invalidate()
        self.addCleanup(connections._invalidate)
        self.nous = {"signedIn": False, "guest": False, "account": None, "connectors": False}
        self.local = {"available": True, "connected": False, "account": None, "services": []}
        self.installed = {}
        catalog = [
            _Entry("notion", slug="notion"),
            _Entry("linear", slug="linear"),
            _Entry("stripe"),
            _Entry("gitstuff", install=object()),
            _Entry("localthing", transport="stdio"),
            _Entry("deepwiki", auth="none"),
        ]
        fake_module(self, "hermes_cli.mcp_catalog", list_catalog=lambda: catalog, installed_servers=lambda: self.installed)
        for p in (
            patch.object(connections, "chief_scope", _noscope),
            patch.object(connections, "_nous_state", lambda: dict(self.nous)),
            patch.object(connections.google_local, "status", lambda home: dict(self.local)),
        ):
            p.start()
            self.addCleanup(p.stop)

    def rows(self):
        return {r["id"]: r for r in connections.overview(refresh=True)["services"]}

    def test_without_nous_google_is_private_outlook_asks_for_nous_and_work_tools_connect_directly(self):
        rows = self.rows()
        self.assertEqual(rows["gmail"]["backends"], ["local"])
        self.assertEqual(rows["outlook"]["backends"], [])
        self.assertTrue(rows["outlook"]["needsNous"])
        self.assertEqual(rows["notion"]["backends"], ["mcp"])
        self.assertEqual(rows["deepwiki"]["backends"], ["mcp"])
        for hidden in ("stripe", "gitstuff", "localthing"):
            self.assertNotIn(hidden, rows)  # money tools and anything that installs software aren't offered
        self.assertLess(list(rows).index("notion"), list(rows).index("deepwiki"))  # featured first

    def test_with_nous_quick_comes_first_for_google_and_carries_outlook(self):
        self.nous = {"signedIn": True, "guest": False, "account": "o@example.com", "connectors": True}
        idle = {"connected": False, "status": "", "account": None}
        served = {"gmail": {"connected": True, "status": "active", "account": "o@example.com"}, "googlecalendar": idle, "outlook": idle, "notion": idle}
        with patch.object(connections, "_quick_status", return_value=served):
            rows = self.rows()
        self.assertEqual(rows["googlecalendar"]["backends"], ["quick", "local"])
        self.assertEqual(rows["outlook"]["backends"], ["quick"])
        self.assertEqual((rows["gmail"]["state"], rows["gmail"]["via"], rows["gmail"]["account"]), ("connected", "quick", "o@example.com"))
        self.assertEqual(rows["notion"]["backends"], ["mcp", "quick"])  # private by default, Quick as the alternative
        self.assertEqual(rows["googledrive"]["backends"], ["local"])  # the gateway doesn't serve it for this account

    def test_when_the_gateway_list_cant_be_read_quick_is_still_offered(self):
        self.nous = {"signedIn": True, "guest": False, "account": None, "connectors": True}
        with patch.object(connections, "_quick_status", side_effect=RuntimeError("down")):
            view = connections.overview(refresh=True)
        self.assertIn("quick", next(r for r in view["services"] if r["id"] == "outlook")["backends"])
        self.assertIn("out of date", view["warning"])

    def test_connected_states_by_backend(self):
        self.local = {"available": True, "connected": True, "account": "me@example.com", "services": ["gmail", "googledrive"]}
        self.installed = {"notion": {"url": "https://example.test"}}
        rows = self.rows()
        self.assertEqual((rows["gmail"]["via"], rows["googledrive"]["via"], rows["googlecalendar"]["state"]), ("local", "local", "not_connected"))
        self.assertEqual((rows["notion"]["state"], rows["notion"]["via"]), ("connected", "mcp"))

    def test_a_service_this_account_cant_reach_is_left_out(self):
        # Signed in to Nous, but its gateway doesn't serve Outlook, and Outlook has no private path.
        self.nous = {"signedIn": True, "guest": False, "account": None, "connectors": True}
        served = {"gmail": {"connected": False, "status": "", "account": None}}
        with patch.object(connections, "_quick_status", return_value=served):
            rows = self.rows()
            self.assertNotIn("outlook", rows)
            self.assertIn("gmail", rows)
            with self.assertRaisesRegex(connections.ConnectionsError, "can't be connected from this app yet"):
                connections.connect("outlook")
            refused = json.loads(connections.tool_handler({"action": "request", "service": "outlook"}))
            self.assertEqual(refused, {"ok": False, "error": "Outlook can't be connected from this app yet."})
            self.assertNotIn("outlook", [c["id"] for c in json.loads(connections.tool_handler({"action": "status"}))["can_request"]])

    def test_signed_out_a_nous_service_still_shows_with_the_sign_in(self):
        self.assertTrue(self.rows()["outlook"]["needsNous"])

    def test_quick_needs_nous_and_says_so(self):
        with self.assertRaisesRegex(connections.ConnectionsError, "Nous"):
            connections.connect("outlook")
        with self.assertRaisesRegex(connections.ConnectionsError, "isn't a service"):
            connections.connect("myspace")

    def test_the_page_never_carries_a_secret(self):
        self.local = {"available": True, "connected": True, "account": "me@example.com", "services": ["gmail"]}
        text = json.dumps(connections.overview(refresh=True))
        for word in ("refresh_token", "client_secret", "access_token", "ya29", "1//"):
            self.assertNotIn(word, text)

    def test_the_bots_tool_lists_and_requests(self):
        self.local = {"available": True, "connected": True, "account": "me@example.com", "services": ["gmail"]}
        status = json.loads(connections.tool_handler({"action": "status"}))
        self.assertEqual([c["id"] for c in status["connected"]], ["gmail"])
        self.assertIn("google_api.py", status["how"])
        self.assertIn("googlecalendar", [c["id"] for c in status["can_request"]])
        req = json.loads(connections.tool_handler({"action": "request", "service": "googlecalendar", "why": "to plan   your week"}))
        self.assertEqual(req["chief_connect"], {"service": "googlecalendar", "label": "Google Calendar", "why": "to plan your week"})
        self.assertTrue(json.loads(connections.tool_handler({"action": "request", "service": "gmail"}))["already_connected"])
        self.assertFalse(json.loads(connections.tool_handler({"action": "request", "service": "nope"}))["ok"])

    def test_the_prompt_section_steers_away_from_developer_accounts(self):
        self.local = {"available": True, "connected": True, "account": "me@example.com", "services": ["gmail"]}
        text = connections.prompt_section()
        self.assertIn("Gmail", text)
        self.assertIn("Never ask the owner to create a Google Cloud project", text)
        self.assertLessEqual(len(text), connections.PROMPT_MAX)


@contextlib.contextmanager
def _noscope():
    yield Path(tempfile.gettempdir())


class QuickConnectTests(unittest.TestCase):
    """The connect runner says why Nous refused (Hermes's own account runner swallows it) and returns the link."""

    def setUp(self):
        self.opened = []

        class Operation:
            def __init__(self, targets, session_key):
                self.targets = targets
                self.url = ""

            def snapshot(self, with_urls=True):
                return {
                    "targets": [
                        {"name": t.name, "state": "initiated" if self.url else "pending", **({"connect_url": self.url} if self.url else {})}
                        for t in self.targets
                    ]
                }

        self.Operation = Operation
        fake_module(self, "tools.connectors.live", open=lambda op: self.opened.append(op))
        fake_module(self, "tools.connectors.operation", ConnectionOperation=Operation, Target=lambda name, kind, action: types.SimpleNamespace(name=name))
        fake_module(self, "tools.connectors.managed", managed_kind=lambda client, action, force: None, managed_client=lambda: None, WATCH_TICK_SECONDS=1.0)
        if "tools.connectors" not in sys.modules:
            fake_module(self, "tools.connectors")
        p = patch.object(connections, "chief_scope", _noscope)
        p.start()
        self.addCleanup(p.stop)

    def run_with(self, drive):
        fake_module(self, "tools.connectors.run", drive_operation=drive)
        return connections._quick_connect("outlook")

    def test_a_refusal_says_why(self):
        class GatewayUnavailable(RuntimeError):
            code = "connector_not_found"
            status = 404

        def drive(op, kind, **kw):
            raise GatewayUnavailable("not served")

        with (
            self.assertLogs("chief-dashboard-bridge", level="WARNING") as logs,
            self.assertRaisesRegex(connections.ConnectionsError, "doesn't offer that service"),
        ):
            self.run_with(drive)
        self.assertIn("GatewayUnavailable code=connector_not_found", logs.output[0])
        self.assertEqual(len(self.opened), 1)

    def test_an_expired_nous_sign_in_says_sign_in_again(self):
        class GatewayAuthError(RuntimeError):
            code = "NO_TOKEN"
            status = 401

        self.assertIn("Sign out of Nous", connections._gateway_reason(GatewayAuthError()))

    def test_the_link_comes_back_once_the_runner_has_it(self):
        def drive(op, kind, connection_callback, **kw):
            op.url = "https://connect.example.com/link/1"
            connection_callback({})
            threading.Event().wait(0.2)  # the watcher keeps running after the link is out

        operation, url = self.run_with(drive)
        self.assertEqual(url, "https://connect.example.com/link/1")
        self.assertIsInstance(operation, self.Operation)


class FileApiTests(unittest.TestCase):
    def test_connection_secrets_are_never_files_to_serve(self):
        for name in ("google_token.json", "google_client_secret.json", "google_account.json", "nous_auth.json"):
            self.assertTrue(data._denied_file(Path("C:/somewhere") / name), name)
        self.assertTrue(data._denied_file(Path("C:/somewhere/mcp-tokens/notion.json")))


if __name__ == "__main__":
    unittest.main()
