# Distributing to a few testers (closed phase)

The source repository stays private. Releases go to a **second private repository that holds only releases** (the
signed manifest and the package; no code). Each tester gets their own **read-only key** for that one repository.
The app checks it for updates, verifies every release against the pinned Ed25519 key, and installs only when the
tester clicks Install.

A leaked key can't push a fake update: a release must still verify against the release key, and Windows checks the
package's signature. A key only lets someone download the releases.

## Maintainer: once

1. **The releases repository:** `<owner>/chief-command-center-releases`, private, with a README (GitHub needs one commit before it can hold releases).
2. **The signing material** stays outside the repo:
   - the package certificate (`.pfx` and password), for the MSIX;
   - the Ed25519 release key, whose public half is pinned in `apps/desktop/src/release-key.ts`.

## Maintainer: each release

One command, from a clean, pushed `main` (paths for this PC in `release.local.json`, copied from
`release.local.example.json`):

```
npm run release:plan                                   # checks the setup; changes nothing
npm run release -- --notes "What changed, in a sentence or two"
```

`scripts/release.mjs` runs every check, bumps the patch version (`--version X.Y.Z` to choose), builds the dashboard
and the signed MSIX, verifies the signature, checks the password never reached the build log, writes the signed
manifest (`release-tool.mjs make` + `verify`), commits and pushes the bump, and publishes it to the releases
repository (`release-tool.mjs publish`, marked latest; uses the `gh` login). `--no-publish` stops before publishing.
It refuses to ship a payload whose Hermes differs from `hermes/pin.json`.

Testers' apps find it within a day (they check at launch and daily), or at once with **Check now**.

**A newer Hermes ships the same way.** The daily `Upstream Hermes` workflow opens an "Upgrade Hermes to <tag>" PR
(or a "Blocked Hermes upgrade" issue). Merge it, rebuild the payload locally (`prepare_source.py`, `stage.py`), run
`packaging/upstream/compat.py` on it, point `payloadDir` at it, and release. The app backs up testers' data before
the new Hermes first starts. Step by step: `CLAUDE.md`, "Hermes updates".

## Maintainer: a key for each tester

On GitHub: Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.

- **Name:** the tester's name, so you can tell keys apart.
- **Expiration:** up to 366 days (GitHub's limit; there are no non-expiring fine-grained tokens).
- **Repository access:** Only select repositories → `chief-command-center-releases`.
- **Permissions:** Repository permissions → **Contents: Read-only** (Metadata: Read-only is added automatically). Nothing else.

Send the key privately. To cut someone off, delete their token; nobody else is affected. You can have up to 50 fine-grained tokens. When a key expires, the tester's app says so ("the update key was refused: it may have expired"), and you send a new one.

## Tester: once

1. **Trust the publisher certificate** (an admin PowerShell, once per PC). The builds are signed with the publisher's own certificate, and Windows only installs a package it trusts:

   ```
   Import-Certificate -FilePath .\chief-test-signing.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
   ```

2. **Install the first package** the maintainer sent you: double-click it, or `Add-AppxPackage -Path .\ChiefCommandCenter.appx`.
3. In the app: **Settings → Backup & updates**.
   - **Update source:** `github:<owner>/chief-command-center-releases`, then Save.
   - **Update key:** the key you were given, then Save key. Windows keeps it protected for your account; the page never shows it again.

From then on, an "Update available — install?" card appears when a new release is out. Install backs up first, waits until Chief isn't working, and relaunches the app.

## Later

Microsoft's Artifact Signing (from $9.99 a month; individual validation for the US and Canada) would replace the self-signed certificate. Testers would skip step 1, and Windows would show fewer warnings. The update flow stays the same.
