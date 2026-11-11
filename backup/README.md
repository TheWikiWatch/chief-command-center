# Backup and restore engine

`chief_backup` makes and restores `.chiefbackup` files. It runs on the app's bundled Python. The web server calls it for backups and for staging restores, and the desktop app calls it to apply a restore, because that step needs Chief stopped. Every command prints one JSON object on stdout; see `chief_backup/__main__.py` for the full list. Passphrases are read from stdin only.

## What goes in

| Part | Contents |
| --- | --- |
| `setup` | The Hermes root: every profile's SOUL, memory, skills, routines, chat history, kanban, config and installed plugins. Also the app's shared settings. |
| `second-brain` | The Second Brain folder, as it is |

Never included: caches, logs, locks, the speech model, and this PC's launchers and install records. Those stay on the PC, and a same-PC restore carries them across.

Secrets (key-like `.env` values, `auth.json`, phone-alert keys, tokens, key files) are included only in a passphrase-encrypted backup. Otherwise they are left out, and their names are listed in the manifest. A restore then keeps the matching values already on this PC and names the rest.

## Format

- A zip with `manifest.json`: format version, app and Hermes versions, parts, and a SHA-256 for every file.
- SQLite databases are copied with the online backup API.
- Encrypted backups wrap that zip. Key derivation is scrypt (N=2^17, r=8, p=1), with a passphrase check value in the header. Content is AES-256-GCM in 1 MiB chunks, and each chunk's associated data carries its index and a final-chunk flag (`crypto.py`).
- The zip is written straight to the destination under a temporary name (encrypted on the way when there is a passphrase), read back and checked (the same bytes as written, every entry against the manifest), and renamed when complete. An encrypted backup's plaintext is never a file anywhere; `inspect` and `stage` read it in place.
- Database copies are made beside the Hermes root, in a folder only the signed-in user can open. A run killed part-way leaves its folder and its temporary file behind; the next backup removes them.
- Symbolic links and junctions are skipped: what they point at can be anywhere on the PC.
- A backup that keeps keys unencrypted (before an update, before a restore) is refused if its file can't be made private to the signed-in user.

## Restore

1. `inspect` shows what a backup holds and refuses one from a newer app.
2. `stage` extracts next to each target. It refuses unsafe paths and verifies every hash; nothing live changes.
3. `apply` refuses while a gateway is running, takes a local safety backup, then does a journaled swap (`<folder>.before-restore-<time>`). Each rename is in the journal, on the drive, before it happens. It then carries machine-local pieces across and remaps the Second Brain paths. Other old paths are listed for review.
4. `finish` runs after Chief starts healthy; `rollback` undoes the restore; `recover` runs at start-up and rolls back an interrupted swap or rollback, deciding from what is on disk. A rollback renames the restored folders aside (`<folder>.rolled-back-<time>`) and deletes them only once the old ones are back; if it can't finish, it says so (`ok: false`) and keeps the journal for the next start.

The Second Brain is restored only into an empty or new folder, or over the current one after it has been backed up.

## Tests

```bash
python -B -m unittest discover -s backup/tests
```
