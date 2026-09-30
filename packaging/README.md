# Packaging

| Folder | What |
| --- | --- |
| `payload/` | Builds the Hermes payload from `hermes/pin.json` + `hermes/patches/` (`prepare_source.py`, `stage.py`) |
| `msix/` | `make-test-cert.sh`: a self-signed test code-signing certificate (OpenSSL; outside the repo, no certificate store) |
| `release/` | `release-tool.mjs`: Ed25519 release key, signed `release.json` for the updater |
| `upstream/` | Upstream tracking: `candidate.py`, `compat.py` (compatibility suite), `update_pin.py`; run by `.github/workflows/upstream.yml` |

## A test MSIX

The MSIX build needs a built payload, the dashboard's standalone build, and a current `signtool` (see `docs/PROGRESS.md`, Phase 8). Build the dashboard first:

```bash
npm --prefix apps/web run build:standalone
```

Make a test certificate, with a folder outside the repo as its argument:

```bash
packaging/msix/make-test-cert.sh <folder>
```

Then build, with these set:

- `CHIEF_PAYLOAD_DIR`: the built payload
- `CHIEF_RELEASE_DIR`: where the package goes
- `CHIEF_SIGN_PFX` and `CHIEF_SIGN_PASSWORD`: the test certificate and its password

```bash
npm --prefix apps/desktop run dist:msix
```

Only the app's own executable and the package are signed (`apps/desktop/build/sign.cjs`); payload binaries keep their publishers' signatures.

## A release for the updater

`<key>` is the release private key, kept outside the repo:

```bash
node packaging/release/release-tool.mjs make --msix <file> --version 0.2.0 --key <key> --out <release folder>
```

The app offers it when its update source (Settings → Updates) points at that folder, and only if `release.json` verifies against the key pinned in `apps/desktop/src/release-key.ts`.

## Never `hermes gateway stop` on a shared PC

See `docs/FRAGILE_SEAMS.md`: on Windows it can stop another install's gateway. Use Hermes's planned-stop marker for one home and one pid.
