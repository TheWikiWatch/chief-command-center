# Plan: security review and fixes

Status: **done** (2026-10-13), apart from what is listed under "Not done" below. A deep review of the whole codebase
in five parts: the bridge (two passes), the dashboard, the desktop shell and updates, and the supply chain. The reviews
were read-only; the live install was not touched. The most serious findings were re-checked by hand (marked ✔).

## Where it stands (2026-10-13)

**Shipped to everyone (0.1.39 to 0.1.41):** S1 (both steps: the phone host pin, then phone pairing), S2, S3, S6, S7,
S8 (honest copy, the allow-list and the exact command), S9, S16, S18, and the bridge items of the low list. S4 and S5
are repository changes (the split upstream workflow; the `main` rulesets, secret scanning and push protection).

**Early channel (0.1.42), to promote after a day or two of use:** S10 to S15 and the rest of the low items, except the
nonce CSP.

**Where the fix differs from the plan:**
- S11: downloads stay where they were (beside the backups when the owner moved those off a full system drive). In
  place of a private copy, the helper hashes the package again while holding it open with read sharing only, right
  before Windows reads it, so it can't be swapped in between; downgrades are allowed only when going back. The
  helper copy is compared byte for byte with the one inside the package (which Windows protects) instead of by signer.
- S13: the owner-only permissions go on the one backup that keeps secrets unencrypted (the safety backup before an
  update), not on the backup folder, which the owner may have chosen and may hold other files.
- S14: the bridge's proof covers the app's health checks, which is when a program could hold the port during a
  restart; the dashboard server's own calls to the bridge are unchanged.
- Tester tooling: values reach the administrator step base64-encoded inside the encoded command rather than through
  environment variables (an elevated process doesn't reliably inherit them).

**Regressions this work caused, both fixed:**
- 0.1.39 to 0.1.40: the dashboard chat refused every message. Hermes imports the bridge plugin a second time; that
  copy had read the token from the plain-text file S3 removed. Fixed in 0.1.41 (the token outlives a second copy in
  the gateway's memory; the platform registers without it).
- 0.1.39 to 0.1.41: phone access set up by hand outside the app (no record in the app) was refused by the S1 host pin.
  Fixed in 0.1.42 (the app adopts such a Serve entry).

**Not done, on purpose:**
- A nonce-based CSP to drop `'unsafe-inline'` (needs Next's nonce support across every page).
- S17 is accepted as a risk: a bot with the terminal can rewrite anything Fleet Health could check; the approvals on
  the trusted files are the boundary.
- Limiting the Second Brain routines' tools: their skills need the terminal, and the drop routine fetches links on
  purpose; the S6 protections cover the foothold.
- S8's real fix (Gmail on this PC behind a bridge tool that holds the token) is the next round, as decided.
- Signing keys stay where they are for now (decision below); the version range for keys (S12) is in.

**Dependencies:** sharp, source-map-js and KaTeX updated. Three advisories with no fix yet, in build or development
tools only, are passed over by CI's scan until 2026-11-12 (`apps/*/osv-scanner.toml`).

## How to read this

**The threat model.** One owner, plus 10 to 50 testers, each on a Windows PC.
- **The bot (an LLM with a terminal) reads untrusted text** (email, web pages, documents), so prompt injection is
  expected. The approval sheet is the line it must not cross on its own.
- **Other parties:** other programs and other Windows users on the PC, websites in the owner's browser, devices
  on the tailnet, and whoever controls upstream Hermes, GitHub or the build PC.

**A ground truth that shapes the fixes.** A bot with the terminal tool can run anything the owner can, in the
owner's account. So the aim is not to make the bot powerless. It is:
1. keep the approval gate honest (nothing the bot writes can approve itself or disguise what it runs);
2. keep long-lived secrets out of the bot's plain sight;
3. give a single bad input no lasting foothold;
4. make sure nothing outside the owner's own session can drive Chief.

Severity: **critical** (exploitable now, full control), **high**, **medium**, **low**.

---

## 1. Fix now (critical and high, mostly small changes)

### S1. ✔ Critical: a forged Tailscale header gets past the dashboard's login
`apps/web/proxy.ts:21-44`, `lib/tailnet-guard.ts:33-40,62-66`

**The flaw.** Any request carrying a `Tailscale-User-Login` header skips the session cookie. With no allow-list (phone
access never turned on), any value passes; with one, the owner's login (their e-mail address) passes.

**Who can use it:**
- A bot's `curl` can read the chat and `/approve` its own pending dangerous command, which defeats the approval gate.
- Another Windows user, WSL or a container on the PC gets full control.
- A website using DNS rebinding can read everything (writes are blocked).

**Fix, in two steps:**
1. **Pin the phone path.** It is open only while phone access is on, and only for the PC's own `*.ts.net` host name
   (the desktop passes it as `CHIEF_DASHBOARD_SERVE_HOST`). An empty allow-list means *deny*; "whole tailnet" becomes
   an explicit mode. This closes rebinding and every case where phone access is off.
2. **Pair each phone** (question 1). Every header Serve sends can be forged by a local program, so the phone needs a
   credential of its own:
   - a one-time pairing link shown as a QR code on the PC sets a long-lived HttpOnly, Secure device cookie;
   - devices can be revoked in Settings → Phone;
   - the Tailscale login stays as a second check.

**Tests.** Spoofed requests get 401, whether or not an allow-list is set.

### S2. ✔ High: text a bot writes can draw an "Approve once" button
`components/chat/question.tsx:203-216`

**The flaw.** Any notice containing "reply `/approve`" turns into an Approve button, and that includes the output of
cron jobs and a bot's own messages. One tap sends `/approve` for whatever dangerous command is pending, with no request
ID and without the approval sheet.

**Fix:**
- Drop `/approve`, `/always`, `/deny`, `/yes` and `/no` from quick replies (approvals have their own sheet).
- Offer quick replies only for known gateway prompt templates (the `/new` confirmation), never for scheduled notices.
- Offer none while an approval is pending.

### S3. ✔ High: the bridge token sits in plain text where the bot can read it
`packaging/migrate/adopt.py:153-157`, `apps/desktop/python/provision.py:35,53-56`, `bridge_token.py:20-25`

**The flaw.** On adopted installs (the owner's), the legacy `plugins\chief-dashboard-bridge\.token` still exists, and
Hermes's read guard doesn't cover it. The bot's file tool can read the token (owner authority over the bridge) without
running a command.

**Fix:**
- provision and adopt delete `.token`, and `bridge_token.py` drops the file fallback.
- The app **rotates the token on its first start after the update**, since the old one has existed in plain text and
  in backups.

### S4. ✔ High: an upstream release name can run code in our GitHub workflow
`.github/workflows/upstream.yml:65,76`, `packaging/upstream/candidate.py:74`

**The flaw.** The upstream tag name is interpolated into a shell command, in a job whose token can write to the
repository. `main` has no protection, so injected code could land on `main` and ship in the next signed release.

**Fix:**
- Validate the tag (`^v\d{4}\.\d+\.\d+$`) and pass every value through `env:`, never `${{ }}` inside `run:`.
- Split the workflow into a read-only build job (upstream code runs here, `persist-credentials: false`, no secrets)
  and a fresh publish job that treats the build's output as data.
- Drop the raw tag from the PR's copy-paste command.
- Fence upstream text in PRs as untrusted.

### S5. High: no protection on `main`, the branch that gets signed and shipped
GitHub settings (question 2).

- A ruleset on `main` that blocks force-pushes and deletions and requires the checks to pass.
- Turn on secret scanning and push protection (free for public repositories).
- Make Renovate actually run (`renovate.json` exists, but the app isn't installed).

### S6. High: a foothold in every conversation (`CRITICAL_FACTS.md`, `second_brain.json`)
`second_brain.py:464-475,703-716,960-1032`

**The flaw:**
- `CRITICAL_FACTS.md` is injected into every conversation and every scheduled run as "the owner's facts", with no
  threat scan and no approval to change. The skills even tell the bot to update it.
- `second_brain.json` (writable by the bot) is trusted at every start. It can repoint the vault, even at a network
  share, which leaks the Windows password hash, and it can write text into auto-loaded skills.
- The 30-minute "drop" routine reads untrusted files unattended, with every tool available.

**Fix:**
- Scan the facts with Hermes's strict threat scan and block them on a hit, with an alert.
- Frame them as data.
- Add `critical_facts.md` and `_claude.md` to Hermes's protected-instructions list (always asks, fails closed in cron).
- Validate the vault path at every start: local fixed drives only, matching `.env`.
- Allow-list the rendered `rules`.
- Give the unattended routines file and vision tools only.

### S7. High: the approval sheet can hide what will actually run
`approval-sheet.tsx:37,46-64`, `mail_guard.py:145,167-207`

**The flaw.** The email preview replaces the command. Repeated flags (`--to boss --to attacker`, where the last one
wins), a second chained command, abbreviated flags (`--bo`) and Bcc recipients all mean the sheet can show a harmless
email while something else is sent. Long or bidi-padded commands can push the dangerous part out of view.

**Fix:**
- Always show the exact command under the preview.
- The guard reads the skill's own argument parser, so what it shows and what runs can't disagree.
- Anything ambiguous (repeated or abbreviated flags, more than one call, shell operators) falls back to "Act on your
  mail" plus the full command.
- Show every recipient field, Bcc included.
- Make bidi and zero-width characters visible, and mark long commands.

### S8. High: the email check is only a convenience
`mail_guard.py`, `google_local.py`

**The flaw.** A bot can still send mail around the guard:
- by running the skill under another name;
- with the `gws` command-line tool;
- by calling the Gmail API directly with the refresh token in `google_token.json`, which the bot can read.

The docs promised more than the guard delivers.

**Fix:**
- Say so plainly (docstring, FRAGILE_SEAMS, the page's copy).
- Turn the Quick connectors' check into an allow-list: known read actions run, everything else asks.
- Decide how much further to go (question 3).

### S9. High: the bots' own consent flags for fleet actions
`fleet.py:140-142,278-280,352-433`

**The flaw.** `fleet_mint(owner_signed=true)`, `fleet_retire(owner_confirmed=true)`, `fleet_restore` and costly model
changes rely on a flag the model sets itself. Minting copies the chief's API key to the new bot. A planted archive
sidecar can make Restore use the bot's chosen config, or make the owner's "Remove archive" delete any file.

**Fix:**
- The same `pre_tool_call` hook asks for these on the approval sheet, and the flags go.
- Archive paths must resolve inside `fleet-archive\`.
- A bot's working folder must be a local absolute path (no UNC).

---

## 2. Next (medium)

### Desktop and updates

| ID | Finding | Fix |
|---|---|---|
| S10 | A compromised dashboard (XSS) can call the most dangerous desktop features without asking: install an older version, roll back, change the update source, open phone access to the whole tailnet, apply a restore (`ipc.ts`). | A native confirmation dialog in the main process for each. `skip` only for the version on offer. A signed "minimum version" in the manifest that refuses known-bad downgrades. |
| S11 | The package can be swapped between its hash check and the install, and every install allows downgrades (`ForceUpdateFromAnyVersion`). | The helper re-hashes the file in a private folder right before it installs. Downgrades only in rollback mode. Downloads only under `%LOCALAPPDATA%`, owner-only. The helper's copy is checked by hash and signer, not size. |
| S12 | Release-key expiry is checked against the manifest's own date, and both signing keys sit unencrypted on the build PC with the `gh` login. | Question 4. Key validity by version range, not date. |
| S13 | The pre-update backup writes `.env` (API keys, tokens) in plain text, and on adopted installs into a folder other users can read. | Owner-only permissions on the backup and updates folders, or encrypt local backups with a DPAPI-wrapped key. |
| S14 | The app sends the bridge token to whatever answers its port (a port squatter during a restart gets it), and the session cookie goes to every service on `127.0.0.1`. | Challenge-response health checks (the server proves it knows the token before getting it). Single-use, 15-second open-in-browser tickets. A per-browser cookie derived from the secret, not the secret itself. |
| S15 | Release builds use whatever `node_modules` are on disk, and payload provenance is self-attested. | `npm ci` at the start of a release. Provenance takes the upstream commit from the source itself, refuses a dirty checkout, and checks the builder commit. |

### Bots and data

| ID | Finding | Fix |
|---|---|---|
| S16 | Team & Routines calls a job "silent" when it actually sends to Telegram, Discord or elsewhere, and hides script and monitor fields. A bot can create such jobs without approval. | Show the real destination and the script fields, flag jobs the app didn't create, and alert the owner when a bot creates one. |
| S17 | Fleet Health can be blinded: a bot can write the app's own "write records" for its edits. | Work out the app's own writes from the read-only package sources, not from records in folders the bot can write. |
| S18 | ✔ Rule break: `media.py` hard-codes the live install's cache folder, so a test home writes into the owner's real Chief. | Use `chief_home()/cache`. Also: ffmpeg `-protocol_whitelist file,pipe`, an absolute ffmpeg path, and a cap on parallel thumbnails. |

---

## 3. Hardening (low)

### Dashboard
- Check the scheme of sign-in URLs before opening them: https only.
- Re-check the vault's hidden-file rules after resolving 8.3 short names (`GIT~1`).
- Attachments: pass through only `blob:` links; label external ones.
- Apply the PC-only rule to the vault-path routes, as backups already do.
- Refuse cross-site `Sec-Fetch-Site` on `/api/*`, and add COOP/CORP headers.
- Plan a nonce-based CSP to drop `'unsafe-inline'`.

### Desktop
- Apply the navigation and window-open guards to every web contents, not just the main window.
- Refuse `--remote-debugging-port`.
- Use absolute System32 paths for powershell, taskkill and conhost, and set `cwd` explicitly.
- Run Python with `-P`.
- Phone access: refuse to turn it on without a Tailscale login, warn about whole-tailnet mode, and remove the Serve
  entry on quit.
- Orphan cleanup: check the process's image or start time, not just the pid file.

### Redaction
- Bridge log: Hermes's redacting formatter.
- Diagnostics and problem reports: more key patterns, JSON `"api_key"` pairs, home paths.
- Crash dumps: opt-in only.
- The update key is registered as a secret.

### Bridge
- Add `browser-profile`, `vault` and `checkpoints` to the file-serving deny list.
- Remember MEDIA paths only from real sends.
- Allow-list push endpoints.
- `push_call` errors through `_plain`.
- The ledger's revert writes only skill files.
- The portrait thread stops on timeout.

### Tester tooling
- The install script requires the full 40-character certificate fingerprint.
- The elevated import receives the certificate's bytes and checks them again.
- Quote PowerShell values through environment variables (curly quotes break the current quoting).

### Supply chain
- Narrow the workflows' permissions.
- Separate the cache keys for upstream candidates.
- Pin with hashes: `pip install anthropic`, uv installs, `requirements-dev.txt`.
- Pin the vendored toolkit by commit.
- Privacy scan:
  - add patterns for PEM keys, `github_pat_`, `AIza`, Telegram and Discord tokens, `hf_`, `sk_live_` and JWTs;
  - add file-name rules for `.pfx`, `.pem`, `.key` and `release.local.json`;
  - print matches masked;
  - extend `.gitignore` to match.

---

## Done well (kept as is)
- **The bridge's own checks:**
  - authentication: loopback only, constant-time token check;
  - per-route body limits;
  - strict approval request IDs;
  - uploads sanitised;
  - file serving blocks streams and NUL bytes and sends a sandbox CSP;
  - SafeLoader and parameterised SQL everywhere;
  - verified downloads for the speech model and pets;
  - avatars re-encoded.
- **Electron:** sandbox, context isolation, strict IPC sender and origin checks, fuses, only http(s)/mailto opened
  externally, permissions denied by default.
- **Updates:** an Ed25519-signed manifest, the hash checked after download, no automatic downgrade, UNC feeds refused,
  the key never sent outside api.github.com.
- **Supply chain:** actions pinned by SHA and checked against their tags, no `pull_request_target`, Hermes pinned by
  full SHA, upstream's lock file pins every tool by sha256, `uv sync --frozen`, npm lockfiles with integrity.
- **No secrets in git history** (all 192 commits scanned).

## Order of work
1. **S1 step 1, S2, S3, S7 (the command always shown) and S18.** Small, high-value, one release.
2. **S4, plus S5 once you say yes.** Repository and workflow only, no app release.
3. **S6, S9, S8 (honest copy and the connector allow-list) and S1 step 2 (phone pairing).** One release, early first:
   phones pair again.
4. **S10–S17.** The update path, then the rest.
5. **The low items**, in batches with related work.

Each release: tests for the exploit path first (red), then the fix; the checks and smoke test; early channel, then
everyone.

## Decisions (owner, 2026-10-12)

| Question | Decision |
|---|---|
| Phone pairing (S1 step 2) | **Yes.** Each phone pairs once with a QR code on the PC; devices can be removed in Settings → Phone. |
| Protecting `main` (S5) | **Ruleset, direct pushes kept:** no force-push or deletion, checks must pass; secret scanning and push protection on. |
| The email check (S8) | **Honest now, real fix next:** the sheet shows the exact command, Quick becomes an allow-list, the copy says what it can't stop. Next round: Gmail on this PC behind a bridge tool that holds the token. |
| Signing keys (S12) | **Leave as is for now**; revisit before a public launch. The key validity-by-version change still happens. |

**Disclosure.** This file stayed out of the public repository (`.git/info/exclude`) until the critical and high items
had shipped to testers (0.1.41, 2026-10-13), so it didn't publish working attacks against installed apps. Commit
messages describe fixes plainly, without exploit recipes.
