# Distributing to testers

Releases go to a **second repository that holds only releases** (the signed manifest, the package and its bill of
materials; no code). It is **public**: the app reads it without a key, verifies every release against the pinned
Ed25519 key, and installs only when the tester clicks Install. Anyone can download a release, nobody can forge one:
a release must verify against the release key, and Windows checks the package's signature (and still asks a new
tester to trust the publisher certificate by hand).

Until 0.1.21 the releases repository was private and each tester had a read-only key. Versions before 0.1.21
still send that key, so keep the keys until everyone is on 0.1.21 or later; then they can be deleted. The app
still accepts a key, for a private releases repository.

## Maintainer: once

1. **The releases repository:** `<owner>/chief-command-center-releases`, public, with a README (GitHub needs one commit before it can hold releases).
2. **The signing material** stays outside the repo:
   - the package certificate (`.pfx` and password), for the MSIX;
   - the Ed25519 release key, whose public half is pinned in `apps/desktop/src/release-key.ts`.
3. **Optional, so Hermes upgrade PRs run CI:** a GitHub App (repository permissions: Contents and Pull requests,
   read and write) installed on this repository. Save its app ID as the Actions variable `UPSTREAM_APP_ID` and a private
   key as the secret `UPSTREAM_APP_KEY`. Without it, `.github/workflows/upstream.yml` still opens the PR, but GitHub
   doesn't run CI on PRs opened with the workflow's own token: run the checks locally before merging.

## Maintainer: each release

One command, from a clean, pushed `main` (paths for this PC in `release.local.json`, copied from
`release.local.example.json`):

```
npm run release:plan                                   # checks the setup; changes nothing
npm run release -- --notes "What changed, in a sentence or two"
```

In PowerShell, npm's wrapper drops the flags after `--`; run `node scripts/release.mjs --notes "…"` instead (and
`node scripts/tester-kit.mjs --version X.Y.Z`).

`scripts/release.mjs` runs every check, bumps the patch version (`--version X.Y.Z` to choose), builds the dashboard
and the signed MSIX, verifies the signature, checks the password never reached the build log, writes the signed
manifest (`release-tool.mjs make` + `verify`), commits and pushes the bump, and publishes it to the releases
repository (`release-tool.mjs publish`, marked latest; uses the `gh` login). `--no-publish` stops before publishing.
It refuses to ship a payload whose Hermes differs from `hermes/pin.json`.

Testers' apps find it within a day (they check at launch and daily), or at once with **Check now**.

**Early updates: try it before the testers.** `npm run release -- --channel early --notes "…"` publishes the release as
a GitHub prerelease. Testers' apps read the repository's latest release, which is never a prerelease, so they don't
see it; an app with **Settings → Backup & updates → Early updates** on (the maintainer's own) is offered it at once.
After a day or two of use, `npm run release:promote -- X.Y.Z` makes the same signed release the latest for everyone
(nothing is rebuilt) and attaches the tester kit. A Hermes upgrade always goes out this way first.

**A newer Hermes ships the same way.** The daily `Upstream Hermes` workflow opens an "Upgrade Hermes to <tag>" PR
(or a "Blocked Hermes upgrade" issue). Merge it, rebuild the payload locally (`prepare_source.py`, `stage.py`), run
`packaging/upstream/compat.py` on it, point `payloadDir` at it, and release. The app backs up testers' data before
the new Hermes first starts. Step by step: `CLAUDE.md`, "Hermes updates".

## Maintainer: a tester stuck on an old version

An app updates with its own code, so an old version's update problems can't be fixed from here; these get a tester
onto a current version, which fixes them for good (from 0.1.32 the app goes straight to the newest release, retries
without a refused key, and stays within GitHub's limits).

- **"The update key was refused"** (a key kept from when the releases repository was private, since expired or
  revoked): make a fresh fine-grained token on github.com (Public repositories, read-only; no or a long expiry) and
  have them paste it in Settings → Backup & updates → Update key. It works on every version from 0.1.10, and lifts
  them to GitHub's 5,000 calls an hour; then Check now offers the newest release directly. From 0.1.32 they can remove
  it.
- **"GitHub's limit for checks without a key was reached"**: wait an hour and Check now once (not repeatedly), or the
  token above.
- **Anything else, or 0.1.9 / 0.1.10** (their installer could be stopped half-way): install the newest package over
  the top from the tester kit (the setup zip on the latest release, or the thumb drive). Data is kept.

Once on 0.1.32 or later, any published version can be installed from Settings → Backup & updates → History →
**Install this version**, newer or older.

## Maintainer: a key for each tester (only for a private releases repository)

Not needed while the releases repository is public. For a private one, on GitHub: Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.

- **Name:** the tester's name, so you can tell keys apart.
- **Expiration:** up to 366 days (GitHub's limit; there are no non-expiring fine-grained tokens).
- **Repository access:** Only select repositories → `chief-command-center-releases`.
- **Permissions:** Repository permissions → **Contents: Read-only** (Metadata: Read-only is added automatically). Nothing else.

Send the key privately. To cut someone off, delete their token; nobody else is affected. You can have up to 50 fine-grained tokens. When a key expires, the tester's app says so ("the update key was refused: it may have expired"), and you send a new one.

## Maintainer: sharing with a new tester

1. **The setup zip.** Every release also writes `<releasesDir>\Chief-Command-Center-setup-<version>.zip` (needs `testerCert` in `release.local.json`: the public `.cer`). To make one for an existing build: `npm run tester-kit` (newest) or `npm run tester-kit -- --version X.Y.Z`. It holds `Install Chief.cmd`, `install-chief.ps1`, a README, the certificate and the signed package (about 850 MB).
2. **Check it before sending** (changes nothing): unzip it and run `powershell -ExecutionPolicy Bypass -File install-chief.ps1 -CheckOnly` in the folder.
3. **Send the link** to the [latest release](https://github.com/TheWikiWatch/chief-command-center-releases/releases/latest) (every published release carries the setup zip; the READMEs of both repositories have the install steps), or the zip by a OneDrive or Google Drive link, and **the certificate fingerprint separately** (a message, not next to the zip: the installer asks for it, so a tampered folder can't vouch for itself).

Later versions reach them through the app's update card; the zip is only for the first install (or a reinstall).

**After each release, on this PC only:** `afterRelease` in `release.local.json` (optional) is a command the release
script runs once the release is live, with `{version}` filled in; a failure there never undoes the release. Use it
for anything kept outside the repository, such as refreshing a personal installer kit.

## Tester: once

1. **Unzip** the setup folder you were sent and double-click **Install Chief.cmd**. It:
   - checks that the package is signed by the certificate in the folder (and stops if not);
   - asks Windows for administrator permission once, to trust that certificate for app packages (the builds are signed with the publisher's own certificate, and Windows only installs packages it trusts);
   - installs Chief, or updates it in place, and opens it.

   If SmartScreen says it protected your PC, click **More info**, then **Run anyway**. Running it again later is safe.
From then on (nothing to set up: the update source is built in), a new release gets ready by itself in the background while Chief keeps working (it downloads, backs up when it brings a new Hermes, and Windows unpacks it), then a "Version X is ready" card offers **Restart to update**. The restart waits until Chief isn't working (or "Restart now"); a small window with Chief's face and a progress bar covers the 10–20 seconds it takes, and the app reopens by itself. Settings → Backup & updates can turn the background preparing off ("Get update" then starts it). After an update, a small "What's new" note shows that version's notes once; **History** (Settings → Backup & updates, or About) lists every published version.

2. Optional, **the phone:** Settings → Phone sets up private access through Tailscale step by step (the tester README has the short version).

By hand, without the script: in an administrator PowerShell, `Import-Certificate -FilePath .\chief-test-signing.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople`, then `Add-AppxPackage -Path .\ChiefCommandCenter-<version>.appx`.

## Later

Microsoft's Artifact Signing (from $9.99 a month; individual validation for the US and Canada) would replace the self-signed certificate. Testers would skip step 1, and Windows would show fewer warnings. The update flow stays the same.
