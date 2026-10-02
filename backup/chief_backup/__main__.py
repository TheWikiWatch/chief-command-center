"""Command line for the app: one JSON object on stdout, progress as JSON lines on stderr.

A passphrase is read from stdin (`--passphrase-stdin`), never from the command line.

    python -m chief_backup backup  --dest D --parts setup,second-brain [--hermes-root R] [--app-dir A] [--second-brain S]
                                   [--kind manual|auto] [--keep N] [--app-version V] [--hermes-version H] [--passphrase-stdin]
    python -m chief_backup list    --dest D
    python -m chief_backup inspect --file F [--app-version V] [--passphrase-stdin]
    python -m chief_backup stage   --file F --parts ... --state-dir D [--hermes-root R] [--app-dir A]
                                   [--second-brain TARGET] [--current-second-brain CUR] [--app-version V] [--passphrase-stdin]
    python -m chief_backup apply   --state-dir D --safety-dir S [--app-version V]
    python -m chief_backup finish | rollback | recover --state-dir D
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from . import archive, crypto, restore


def _path(value: str | None) -> Path | None:
    return Path(value) if value else None


def _passphrase(args) -> str:
    return sys.stdin.readline().rstrip("\r\n") if args.passphrase_stdin else ""


def _progress(done: int, total: int, _last=[0.0]) -> None:  # noqa: B006 (the list is the throttle's memory)
    now = time.monotonic()
    if now - _last[0] >= 0.25 or done >= total:
        _last[0] = now
        sys.stderr.write(json.dumps({"progress": [done, total]}) + "\n")
        sys.stderr.flush()


def _list(dest: Path) -> dict:
    items = []
    for path in sorted(dest.glob(f"*{archive.SUFFIX}"), key=lambda p: p.stat().st_mtime, reverse=True):
        items.append({"name": path.name, "path": str(path), "bytes": path.stat().st_size, "mtime": path.stat().st_mtime,
                      "auto": path.name.startswith("Chief backup (auto)"), "encrypted": crypto.is_encrypted(path)})
    return {"ok": True, "backups": items}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="chief_backup")
    parser.add_argument("command", choices=["backup", "list", "inspect", "stage", "apply", "finish", "rollback", "recover"])
    for name in ("--dest", "--parts", "--hermes-root", "--app-dir", "--second-brain", "--current-second-brain", "--file",
                 "--state-dir", "--safety-dir", "--kind", "--app-version", "--hermes-version"):
        parser.add_argument(name)
    parser.add_argument("--keep", type=int, default=0)
    parser.add_argument("--passphrase-stdin", action="store_true")
    # Only for backups the app keeps next to the live data (before an update): like the live files, they
    # hold secrets unencrypted. Backups a person carries elsewhere never use this.
    parser.add_argument("--local", action="store_true")
    args = parser.parse_args(argv)
    parts = [p.strip() for p in (args.parts or "").split(",") if p.strip()]
    version = args.app_version or "0.0.0"
    try:
        if args.command == "backup":
            dest = Path(args.dest)
            result = archive.create(dest, parts=parts, hermes_root=_path(args.hermes_root), app_dir=_path(args.app_dir),
                                    second_brain=_path(args.second_brain), passphrase=_passphrase(args), app_version=version,
                                    hermes_version=args.hermes_version or "", kind=args.kind or "manual", progress=_progress,
                                    secrets_plain=args.local)
            if args.kind in ("auto", "pre-update") and args.keep:
                result["pruned"] = archive.prune(dest, args.keep, args.kind)
        elif args.command == "list":
            result = _list(Path(args.dest))
        elif args.command == "inspect":
            result = restore.inspect(Path(args.file), _passphrase(args), app_version=version)
        elif args.command == "stage":
            result = restore.stage(Path(args.file), _passphrase(args), parts=parts, hermes_root=_path(args.hermes_root),
                                   app_dir=_path(args.app_dir), second_brain=_path(args.second_brain),
                                   current_second_brain=_path(args.current_second_brain), state_dir=Path(args.state_dir), app_version=version)
        elif args.command == "apply":
            result = restore.apply(Path(args.state_dir), safety_dir=Path(args.safety_dir), app_version=version)
        elif args.command == "finish":
            result = restore.finish(Path(args.state_dir))
        elif args.command == "rollback":
            result = restore.rollback(Path(args.state_dir))
        else:
            result = restore.recover(Path(args.state_dir))
    except (archive.BackupError, restore.RestoreError, crypto.CorruptBackup) as exc:
        result = {"ok": False, "error": str(exc)}
    except crypto.BadPassphrase as exc:
        result = {"ok": False, "error": str(exc), "code": "passphrase"}
    except Exception as exc:  # a plain message, never a traceback with paths or data
        result = {"ok": False, "error": f"Something went wrong ({type(exc).__name__})."}
    sys.stdout.write(json.dumps(result) + "\n")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
