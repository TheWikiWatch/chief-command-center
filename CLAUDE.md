# Chief Command Center: working notes for Claude

A Windows desktop app (Electron + MSIX) that bundles a patched Hermes Agent and a Next.js dashboard. Start with
`README.md`, `docs/ARCHITECTURE.md` and `docs/FRAGILE_SEAMS.md`; `docs/PROGRESS.md` is the running log.
This PC's paths and the owner's live install are in `CLAUDE.local.md` (git-ignored); read it too.

## Layout

| Path | What |
|---|---|
| `apps/web` | the dashboard (Next.js); `npm --prefix apps/web run dev` serves it on 3100 |
| `apps/desktop` | the Electron shell: first run, Hermes supervision, backups, updater, MSIX packaging |
| `hermes/` | `pin.json` (the upstream Hermes commit the app ships), `patches/`, the bridge plugin, Python tests |
| `packaging/` | payload builder, upstream compatibility tooling, release manifests, migration |
| `backup/` | the backup and restore tool |
| `docs/` | plans, progress, distribution, fragile seams |

## Rules

- **Privacy:** this repo will be public. Never commit people's names, e-mail addresses, home-folder paths, tokens,
  conversations, vault contents or private fleet profiles, in code, tests, fixtures or docs. Tests use synthetic
  data. `npm run privacy` runs before every commit (it is part of `npm run check`).
- **Never touch the live install** while developing (see `CLAUDE.local.md`). Test against a throwaway home on its
  own ports. Never run `hermes gateway stop`: it stops every gateway on the machine.
- **Secrets** stay out of the renderer, logs and URLs. The signing password must never appear in a log.
- **Checks:** `npm run check` (web typecheck + tests, desktop tests, Python tests, privacy) before every commit.
- **Write it down:** a user-visible change gets a `docs/PROGRESS.md` entry; a new trap gets a line in
  `docs/FRAGILE_SEAMS.md`.

## Shipping an update to everyone who has the app

People install the app once. After that, every update reaches them through a **private GitHub releases
repository** (no code in it, only signed releases). Their app checks it at launch and daily, with a personal
read-only key, gets the update ready in the background (download, backup, Windows stages it) and shows "Version X is
ready · Restart to update"; the restart is a small window (`ChiefUpdater.exe`) with Chief's face and a progress bar.
Details: `docs/DISTRIBUTION.md`; the flow's traps: `docs/FRAGILE_SEAMS.md`, "Installing an update".

When the owner says "ship it" / "release this" / "push this out":

1. Commit the work on `main` and push (the release is built from what's committed).
2. `npm run release:plan` checks the setup without changing anything.
3. `npm run release -- --notes "One or two plain sentences on what changed"` (from cmd or Git Bash; in
   PowerShell npm's wrapper drops the flags, so run `node scripts/release.mjs --notes "…"` there)

**Early first, when it's risky** (always for a Hermes upgrade): add `--channel early`. It publishes a GitHub
prerelease that only an app with Settings → Backup & updates → **Early updates** on sees (the owner's). After a day or
two of use, `npm run release:promote -- X.Y.Z` makes the same signed release the latest for everyone and attaches the
tester kit (and runs `afterRelease`); nothing is rebuilt.

`scripts/release.mjs` then runs every check, bumps the patch version (`--version X.Y.Z` to choose), builds the
dashboard, runs the Electron smoke test on a throwaway data folder (`npm run smoke`: boot, a chat, an approval, quit),
builds and self-tests the update helper and builds the signed package (about 5 minutes), verifies the signature, checks that the password didn't reach
the log, writes the signed release manifest, uploads it as a draft release, commits, tags and pushes the version, then
makes the draft live. A failure before the push puts the version files back and deletes the draft. `--no-publish`
builds everything without publishing or moving the committed version (`--skip-checks` works only with it). It reads this PC's paths from `release.local.json` (git-ignored; see
`release.local.example.json`).

Testers see the notes on the update card. The app backs up their data before the first start on a new Hermes.

## Hermes updates

Hermes is **built into the app** and never updates itself on a tester's PC. A newer Hermes reaches them only as an
ordinary app release, made the same way as above, after it passes the compatibility suite.

1. **Finding one (automatic):** `.github/workflows/upstream.yml` runs daily on GitHub. When upstream Hermes has a
   newer stable release, it applies our patches, builds the payload, runs the compatibility suite, and opens either
   a PR **"Upgrade Hermes to <tag>"** (moving `hermes/pin.json`) or an issue **"Blocked Hermes upgrade: <tag>"**
   (a patch no longer applies or a check failed; the old pin stays; it retries by itself once a fix lands). Check by
   hand with `python packaging/upstream/candidate.py`.
   **Looking ahead:** `.github/workflows/upstream-drift.yml` runs nightly against upstream main and its newest release
   candidate and keeps one issue, **"Upstream drift"**, up to date. When it says a patch no longer fits, write the
   new form as `hermes/patches/<name>.next.patch` and list it under `"next"` in the entry (never edit the current
   file: it still builds the current pin). By hand: `python packaging/upstream/drift.py --src <build>\drift-src`.
2. **Accepting it:** read the PR's "Touches our seams" and "Feature radar" (each *needs dashboard work* item worth
   having becomes an issue), merge it, then `git pull` on `main`.
3. **Rebuilding the payload locally** (the PR only changes the pin; the package carries a payload built on this PC):
   **`npm run hermes:upgrade`** does all of this step and step 4 (prepares the source, builds the payload with a 3.14
   it finds or makes, runs the compatibility suite, points `release.local.json` at the new payload and keeps the old
   one as the fallback). By hand, into new folders so the current payload stays as a fallback:

   ```
   python packaging/payload/prepare_source.py --dest <build>\hermes-src-<tag>
   python packaging/payload/stage.py --hermes-src <build>\hermes-src-<tag> --out <build>\payload-<tag> --cache <build>\uv-cache
   python packaging/upstream/compat.py --payload <build>\payload-<tag> --work <build>\compat-<tag> --report <build>\compat-<tag>.md
   ```

   `prepare_source.py` reads `hermes/pin.json` and applies `hermes/patches/` (a failing patch exits 3 and is named:
   refresh that patch). `stage.py` takes a while and downloads Python, Node, Git and packages; it needs Python 3.14 (the
   payload's own version) with pyyaml, cryptography and requests, and refuses an older one. Without a 3.14 installed, an
   existing payload's own interpreter makes that venv: `uv venv --python <payload>\tools\python-3.14…\python.exe <venv>`.
   `compat.py` must pass.
4. Point `payloadDir` in `release.local.json` at the new payload, then **release as above with `--channel early`**,
   notes that say Hermes moved to <tag>, and `--hermes-highlights "One thing; another"` (two or three short lines from
   the PR's radar: testers see them as "New in Hermes" after the update). The release script refuses to ship if the
   payload and `hermes/pin.json` disagree.
5. The owner's install takes it first (Early updates on); after a day or two, `npm run release:promote -- X.Y.Z`.

To change a patch or add one: edit `hermes/patches/` and its entry in `hermes/pin.json`, rebuild the payload (step 3),
and release.
