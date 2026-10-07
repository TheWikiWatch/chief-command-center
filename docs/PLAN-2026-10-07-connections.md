# Plan: connections that take one click

Status: **built, first part** (2026-10-07, branch `feat/connections`). The owner's ask: let the bots use email and
other services without testers making developer accounts and pasting keys. Researched against the pinned Hermes
(`41cd311`), this app, and Google's and Microsoft's current rules.

Built: the bridge (§2.2), the bots' tool and prompt (§2.3), the Connect card (§2.4), the mail guard and its sheet
(§2.6), privacy (§2.7) and the release plumbing for the Chief Google app (§3). Where the build differs or stops:

- **Chief only.** Sharing with worker bots (§2.5) waits: workers run without the bridge plugin, so the mail guard
  wouldn't ask for them. First the guard has to run in worker profiles.
- **Direct work tools finish on the PC**, like Google on this PC; the phone's tailnet callback (§2.4) is later.
- **Plugin tools are deferred** behind Hermes's tool search, so a model reaches `connections` through `tool_call`
  (FRAGILE_SEAMS, "Connections").
- **Not yet:** taking back an "Always allow" from Settings (`PATCH /connections/policy`), and Nous as a choosable model
  in Models & keys after the Nous sign-in.
- **Waiting on the owner:** a Nous account (does a free one carry connectors?) and the Chief Google app
  (DISTRIBUTION.md, "the Chief Google app").

## 0. Decisions (interview, 2026-10-07)

| Topic | Decision |
|---|---|
| Google path | **Both, Nous first.** One-click *Nous Connectors* is the default; *Keep it on this PC* (our own Chief Google app) is the private option. |
| Services | Gmail and Google Calendar/Drive; Outlook / Microsoft 365; work tools (Hermes's MCP catalog: Notion, Linear, Asana, Todoist, Atlassian, Dropbox…). Slack and GitHub come free with Nous Connectors but aren't a focus. |
| Asking | **A card in chat** ("Connect Gmail" with a button; the chat carries on once it's connected), plus **Settings → Connections**. |
| Email safety | **Read freely, ask before sending.** Searching and reading need no approval; send, reply, forward, delete and moving mail ask first, like commands do today. |

---

## 1. What exists today

### 1.1 In the app: nothing

There is no connections page, no OAuth anywhere in the app, and no tool a bot can use to ask for a connection. Outside
services are limited to pasted API keys (models, images, web search, voice). Sign-in model providers are listed with
"Signing in from the app is coming soon." (`connect-model.tsx`).

### 1.2 In Hermes: five mechanisms, and the bots reach for the worst one

| Mechanism | What the user must do | Covers | Verdict |
|---|---|---|---|
| **Google Workspace skill** (`skills/productivity/google-workspace`) | Create a Google Cloud project, enable 6 APIs, set up a consent screen, add themselves as a test user, create a Desktop OAuth client, download the JSON, then copy a code out of a broken `http://localhost:1` page into chat. Its SKILL.md tells the bot to use flags (`--services`, `--format`) that `setup.py` doesn't have, so the bot gets it wrong. | Gmail, Calendar, Drive, Docs, Sheets, Contacts | **This is what testers hit today.** Keep the skill (it does the actual work) but never its setup. |
| **Nous Connectors** (`tools/connectors/`, tool `manage_connections`) | Sign in to the Nous Portal once; then each service is an ordinary "Sign in with Google/Microsoft" page. Composio runs the sign-ins behind Nous with Google-verified apps: no warning screen, no developer account. | Gmail, Google Calendar, Drive, Docs, Outlook, Slack, GitHub, Notion, Linear, Jira, Todoist, Figma, Discord… | **The one-click path.** Hidden from the bot unless signed in to Nous with `managed_tools` on. |
| **MCP catalog** (`optional-mcps/`, 64 "Nous-approved" entries) | Click; the service's own sign-in opens (OAuth 2.1 with dynamic client registration). Nothing to register. | Notion, Linear, Atlassian, Asana, Dropbox, Todoist, Airtable, Canva, Figma, Calendly, Zapier… **No Google or Microsoft.** | **The private path for work tools.** Tokens stay on the PC (`<profile>/mcp-tokens/`). |
| **Email by app password** (`himalaya` skill; the `email` gateway platform) | Turn on 2-Step Verification, make an app password, type IMAP/SMTP settings. | Mail only | **Not offered.** Outlook.com stopped accepting app passwords in Sept 2024, Google discourages them, and they give full mailbox access with no undo. |
| **Microsoft Graph** (`tools/microsoft_graph_*`) | An Entra app with a client secret (app-only). | Teams meetings | Not for personal mail. Outlook comes through Nous Connectors. |

### 1.3 Google's rules decide the private path

- An app that **reads Gmail** uses *restricted* scopes: Google's verification plus a yearly paid security assessment
  (CASA, about $500–$6,000) once data reaches any server beyond Google's (our cloud model counts).
- **Unverified, "In production":** works for up to **100 users over the project's lifetime**, with a one-time
  "Google hasn't verified this app" screen (Advanced → Continue). Refresh tokens don't expire weekly.
- **Do not use "Testing" status:** refresh tokens die after 7 days, so the bot would lose Gmail every week.
- A Desktop OAuth client's secret is *not* secret by Google's own definition, so one client ID ships in the app. It still
  stays out of the public repo (forks would spend our 100-user cap); the build injects it.
- The Calendar and `drive.file` scopes are only *sensitive*; reading Drive broadly is *restricted*.

So: **Nous Connectors is the default** (no warning, no cap), and **the private Chief Google app is for the testers who'd
rather keep mail between their PC and Google**, within the 100-user allowance. A public release later either goes through
Google's verification or keeps Nous as the only Google path; §8.

---

## 2. Design

### 2.1 One page, three ways in

```
Settings → Connections

  ┌ How connections work ────────────────────────────────────────────────────────────┐
  │ (N) Nous account   Signed in as …  · Quick connections on              [Sign out]│
  └──────────────────────────────────────────────────────────────────────────────────┘

  EMAIL & CALENDAR
  [G] Gmail             ● Connected · quick         Mail for every bot      [ ⋯ ]
  [G] Google Calendar   ○ Not connected             [ Connect ▾ ]  Quick (recommended) · On this PC
  [G] Google Drive      ○ Not connected             [ Connect ▾ ]
  [O] Outlook           ○ Not connected             [ Connect ]

  WORK TOOLS
  [N] Notion            ● Connected · on this PC    [ ⋯ ]
  [L] Linear            ○                           [ Connect ]
  …  Show all 60 ▾      (search)

  What bots may do: reading is free; sending, deleting and moving mail ask you first.  [Change]
```

Each row is a **service**, whatever carries it. Its backend is one of:

| Backend | Who holds the sign-in | Where the sign-in page can open |
|---|---|---|
| `quick`: Nous Connectors | Nous and Composio (server side) | anywhere: PC or phone |
| `local-google`: our Chief Google app | this PC (`<profile>/google_token.json`) | the PC (loopback redirect) |
| `mcp`: Hermes's catalog server | this PC (`<profile>/mcp-tokens/`) | the PC (loopback); the phone via the tailnet callback (§2.4) |

**Google rows** offer both (*Quick* first, labelled "recommended"; *On this PC* with a one-line "Google shows an
'unverified app' screen once; your mail never passes through anyone but Google"). **Outlook** is Quick only (a private
Microsoft path needs an Entra tenant and publisher verification: §8). **Work tools** come from the catalog. Where Nous
also carries the tool (Notion, Linear, Todoist…), the row connects through the catalog by default (private, no account
needed) and offers *Quick* as an alternative.

Without a Nous account the page still works. Google offers *On this PC*, work tools connect privately, and Outlook
says "Needs a free Nous account" with a Sign in button.

### 2.2 Bridge: `connections.py`, one contract

New module in `hermes/plugins/chief-dashboard-bridge/`, contract `chief.connections.v1`:

```
GET    /connections                      services + state + backend + account label (never a token)
POST   /connections/nous/start           device-code sign-in → {session, code, url, expires}
GET    /connections/nous/poll/:session   pending | approved | denied | expired
POST   /connections/nous/signout
POST   /connections/connect              {service, backend} → {op, url?, needs?: [env names]}
GET    /connections/op/:op               pending | connected | failed (+ detail)
POST   /connections/disconnect           {service}
GET    /connections/oauth/callback       loopback + tailnet redirect target for mcp / local-google (state-checked)
PATCH  /connections/policy               the email approval policy (§2.6)
```

Every call runs inside the chief profile's scope (`set_hermes_home_override` plus `set_secret_scope`, the pattern
`tools/connectors/mcp_oauth.py:159-179` uses), so nothing touches the gateway process's default home.

- **Nous sign-in.** Uses the two halves Hermes's own dashboard uses: `auth_device_flow._request_device_code`, then
  `_poll_for_token` in a worker thread, then `refresh_nous_oauth_from_state` and `persist_nous_credentials`
  (`web_routers/oauth.py:388`, `web_server_oauth.py:302`). The same sign-in also lights up **Nous as a model
  provider**, replacing "coming soon" in Models & keys.
- **Quick connect.** `tools.connectors.account.find_or_start_operation([slug], "connect", profile_home)`, then
  `wait_for_prepare`, then the snapshot's `connect_url`. Hermes's own watcher thread settles it. Status comes from
  `managed_client().list_connectors()`; disconnect is `PortalClient.delete_account(connection_id)`.
- **MCP connect.** `mcp_catalog.get_entry` → `install_entry(entry, enable=True)` → a `DashboardOAuthFlow` whose
  `redirect_uri` is our callback, run by `tools.connectors.mcp_oauth.run_worker`. Then
  `register_mcp_servers({name: cfg})` so the running gateway sees the tools without a restart. Entries that need a key
  instead of OAuth show a key field (saved with `save_env_value`, never echoed). Remove is `uninstall_entry` plus
  `remove_oauth_tokens`.
- **Local Google.** Authorization-code + PKCE with a loopback redirect on `127.0.0.1:<ephemeral>` (Google's current
  guidance for desktop apps). It writes `google_token.json` in the exact `authorized_user` shape the skill expects:
  - `type`, `token`, `refresh_token`, `token_uri`, `client_id`, `client_secret`;
  - `scopes` = exactly the granted scopes;
  - `expiry` as `YYYY-MM-DDTHH:MM:SSZ` (without `expiry` google-auth never refreshes).

  Scopes are per service:
  - Mail: `gmail.modify` + `gmail.send`;
  - Calendar: `calendar`;
  - Drive: `drive`.

  Connecting another Google service adds its scopes with incremental authorization (`include_granted_scopes`).
  Disconnect revokes at Google, then deletes the file.

### 2.3 The bots: one tool, no setup chores

- **A `connections` tool** registered by the plugin (always available, unlike `manage_connections`):
  - `status` lists the services and whether each is connected;
  - `request {service, why}` puts a *Connect* card in the chat (§2.4) and tells the bot "The owner has been asked;
    carry on with what you can, and pick this up when they say it's connected."
- **A system-prompt section** (alongside "chief-critical-facts"):
  - Use the `connections` tool to check what's connected and to ask for anything that isn't.
  - Never ask anyone to create a Google Cloud project, an OAuth client, an app password or an API key for a service on
    the Connections list.
  - When Gmail is connected *on this PC*, call the skill's `google_api.py` directly and never its `setup.py`.
- The `platform_hint` (adapter) gains "Settings → Connections".
- When Nous is signed in, Hermes's own `manage_connections` and connector tools also appear. A `connect_url` in their
  results, or a `CONNECTION_REQUIRED` error, renders as the same card (§2.4), so the bot can't paste a raw link.

### 2.4 The Connect card

```
 ┌─────────────────────────────────────────────────────┐
 │ [G]  Connect Gmail                                  │
 │      Chief wants to read and draft your email.      │
 │      Sending always asks you first.                 │
 │  [ Connect ]  Quick ▾          Not now              │
 └─────────────────────────────────────────────────────┘
          ↓ after sign-in
 ┌─────────────────────────────────────────────────────┐
 │ [G]  Gmail connected ✓   (you@…)          [Continue]│
 └─────────────────────────────────────────────────────┘
```

- **Where it comes from.**
  - The bridge reads open requests from the `connections` tool, and connect links from Nous tool rows in the
    session's SQLite, the way `chat_state.asked_from_tool_row` turns a finished clarify call into a card.
  - It returns them on `/transcript` as `connect: [...]`, so the card survives a reload and appears on the phone too.
- **Opening the sign-in.**
  - A *quick* sign-in opens wherever the person is.
  - On the PC, links already open in the system browser (`setWindowOpenHandler` → `shell.openExternal`), so no new
    IPC is needed.
  - The URL is fetched when the card renders (Composio links are single-use, so it's refetched on each click), so the
    button is a real `<a target="_blank">` and a phone's popup blocker never eats it.
- **On the phone, per backend.**
  - A *local-google* sign-in must finish on the PC: the card says "Finish on your PC" and the PC's chat shows the same
    card.
  - An *mcp* sign-in on the phone redirects to the phone's own tailnet address,
    `https://<pc>.<tailnet>.ts.net/api/connections/callback`. Dynamic client registration accepts any redirect, and
    the dashboard proxies that to the bridge's state-checked callback.
- **After.** The card flips to *Connected ✓* (live, from `/connections/op/:op`). **Continue** sends "Gmail is
  connected. Go ahead." as the owner, so the bot picks up where it stopped. *Not now* dismisses it and tells the bot.

### 2.5 Sharing with worker bots

Connections belong to the chief. A bot gets a service when the owner says so: **"Bots that can use this"** in the
service's ⋯ menu, all on by default for mail, off for work tools. Granting a service to a worker works per backend:

- *quick*: copy the Nous identity into the worker's `auth.json`. Connections live on the Nous account, so they come
  along.
- *local-google*: copy `google_token.json`. Google refresh tokens don't rotate, so each copy refreshes on its own.
- *mcp*: copy the server's config entry and `mcp-tokens/<server>*`.

Granting follows `providers.grant_provider` and runs at mint and restore too. Revoking removes the copy.

### 2.6 Approvals: read freely, ask before sending

A `pre_tool_call` hook in the plugin returns `{"action": "approve", "message": …, "rule_key": …}` for mail actions
that send, reply, forward, delete, trash or move. That puts them on Hermes's own approval gate, which already reaches
our approval sheet through the gateway notify path:

| Tool | Gated when |
|---|---|
| `connectors__gmail__*`, `connectors__outlook__*` | the action name contains SEND, REPLY, FORWARD, DELETE, TRASH, MOVE, or a label change |
| `terminal` running the skill's `google_api.py` | `gmail send`, `reply`, `forward`, `modify`, `trash` |
| `mcp__<server>__*` | per server: installed with `trust: untrusted`, so Hermes gates every tool not marked read-only |
| Calendar | creating or deleting an event that invites other people |

- **What the sheet shows.** A gated mail action shows **who it goes to, the subject and the first lines**, not a
  command line.
- **The choices.** *Allow once*, *Allow for this chat*, and *Always allow sending mail* (`rule_key`
  `chief:mail-send`). Settings → Connections shows that choice and can take it back.
- **Fail closed.** With nobody to ask (cron, unattended runs), Hermes blocks, and the hook leaves that as is.
- **Untrusted mail.** Email text is untrusted input; this gate is the protection against a message telling the bot to
  forward the inbox.

### 2.7 Privacy and safety

- Tokens never reach the renderer, logs or URLs. Connect links are short-lived, single-use URLs to Google, Microsoft,
  Composio or the service, and nothing more.
- The bridge file API's deny list (`data.py:_DENIED_NAMES`) gains `google_token.json`, `google_client_secret.json`,
  `nous_auth.json` and the `mcp-tokens` folder. A test proves the file API can't read any of them.
- The Chief Google client ID is injected at build time from `release.local.json` (`googleClient`: a path outside the
  repo). A dev build without it simply doesn't offer *On this PC*. `npm run privacy` is taught the
  `apps.googleusercontent.com` pattern.
- Copy says plainly where each sign-in lives: "Quick connections go through Nous Research and Composio, which keep the
  sign-in and pass your mail to the bot when it asks. *On this PC* keeps it between this PC and Google."
- The payload keeps Hermes's `google` extra (google-api-python-client), now no longer a removal candidate
  (`docs/PAYLOAD.md`).

---

## 3. What the owner does (one-time, about 15 minutes, guided)

1. **A free Nous account** (portal.nousresearch.com), for the quick path and the spike.
2. **The Chief Google app:**
   - a new Google Cloud project, "Chief Command Center";
   - enable the Gmail, Calendar and Drive APIs;
   - an External consent screen with the app name and logo, published **In production** (not Testing);
   - an OAuth client of type **Desktop app**; save its JSON under `E:\ChiefBuild\signing\`.

   A step-by-step page with screenshots goes in `docs/DISTRIBUTION.md`.

Neither is needed to start building. The spike (§4, phase 0) needs the first; *On this PC* needs the second before its
end-to-end test.

## 4. Phases

0. **Spike on the throwaway home (7795).** Prove the four unknowns before building UI:
   - Does a free Nous account carry `managed_tools`?
   - Does a quick Gmail connect work from a bridge-started operation?
   - Does a catalog server (Notion) authorize with our callback URL?
   - Does a `pre_tool_call` "approve" reach our approval sheet?

   Any no changes the plan here, not after the UI exists.
1. **Bridge.**
   - `connections.py` and its routes; the proxy allow-list (`proxy-policy.ts`, kept in step by `test_routes.py`).
   - Nous sign-in, quick, mcp, local-google; the deny list; the approval hook; the `connections` tool and prompt
     section; per-profile scope.
   - Python tests with fake clients for each backend, plus a contract test like `run_looks_contract.py`.
2. **Dashboard.**
   - Settings → Connections; the Connect card in chat; the mail approval sheet.
   - Nous as a model provider in Models & keys.
   - Vitest for each; screenshots on PC and phone widths, light and dark.
3. **Sharing and polish.** Worker grants; the tailnet callback for phone sign-ins; reconnect states (`expired` /
   `revoked` → "Reconnect"); the owner's guide.
4. **Ship early.** PROGRESS and FRAGILE_SEAMS entries, `npm run check`, a release with `--channel early` (new sign-in
   surface, new approval path). Promote after the owner has connected Gmail both ways and used it for a day.

## 5. Tests that matter

- **Contract:**
  - `/connections` never contains a token or secret, checked against fixtures shaped like real tokens;
  - every route is in the proxy allow-list.
- **Local Google:** the token file round-trips through the skill's own `get_credentials()` (a real google-auth load,
  with expiry and refresh against a fake token endpoint). The callback rejects a wrong `state` and a reused code.
- **Approvals:** for each mail action name, the hook gates or passes as the table says. Read actions are never gated.
  The unattended path stays blocked.
- **Card:** a `CONNECTION_REQUIRED` tool row and a `connections.request` row both render a card. The card survives a
  reload, flips on connect, and *Continue* sends exactly one message.
- **Phone:** a phone-width card for local-google says "Finish on your PC" and has no dead button.

## 6. New fragile seams (to record)

- **Composio connect links are single-use:** fetch on click, never cache.
- **The unverified Google app has 100 users for its whole life.** Don't spend them on test runs: use one test account,
  and keep testers on Quick unless they ask for private.
- **A Google project left in *Testing*** silently breaks every bot's Gmail after 7 days.
- **`manage_connections` only shows a card for clients that set `agent.connection_callback`.** The messaging gateway
  doesn't, so we render its link results instead of patching Hermes.
- **Nous auth falls back to the root profile, not the chief's.** Workers need an explicit grant (§2.5).
- **The google-workspace SKILL.md documents flags `setup.py` doesn't have.** Our prompt section steers the bot away
  from setup. Worth an upstream fix (`docs/UPSTREAM-PATCHES.md`).

## 7. Not doing (and why)

- **App passwords / IMAP:** dead on Outlook.com, discouraged by Google, mail only, full access.
- **Our own Microsoft app:** needs an Entra tenant, a custom domain and publisher verification; Outlook comes through
  Quick for now.
- **Patching Hermes for the native card:** a fire-and-forget callback on a private agent attribute plus a global
  `on_change` slot. Rendering link results is patch-free.
- **Google's official Workspace MCP servers:** developer preview, still need our own client and the same restricted
  scopes, and reportedly can't send.

## 8. Later: a public release

- **Google.** Either verify the Chief Google app (restricted scopes, CASA yearly), or keep *On this PC* as "bring your own
  client" (the settings field exists for forks) and Quick as the default.
- **Microsoft.** Register a publisher-verified multi-tenant app for a private Outlook path.

## Sources

- Hermes (pinned `41cd311`):
  - `tools/connectors/**`, `tools/mcp_oauth.py`, `tools/approval.py`, `hermes_cli/auth_nous.py`,
    `hermes_cli/web_routers/{oauth,mcp}.py`, `hermes_cli/mcp_catalog.py`;
  - `skills/productivity/google-workspace/scripts/{setup,google_api}.py`, `optional-mcps/`.
- Google:
  - [native-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
  - [publishing status](https://support.google.com/cloud/answer/15549945)
  - [unverified apps](https://support.google.com/cloud/answer/7454865)
  - [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
  - [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
  - [token expiry](https://developers.google.com/identity/protocols/oauth2#expiration)
  - [verification exceptions](https://support.google.com/cloud/answer/13464323)
- Microsoft: [Outlook.com basic-auth end](https://support.microsoft.com/office/outlook-and-other-apps-are-unable-to-connect-to-outlook-com-f4202ebf-89c6-4a8a-bec3-3d60cf7deaef), [publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview).
- Brokers: [Composio managed apps](https://docs.composio.dev/docs/custom-app-vs-managed-app), [Nous Portal plans](https://portal.nousresearch.com/manage-subscription).
