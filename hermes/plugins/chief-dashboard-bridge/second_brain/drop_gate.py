"""Wake gate for the Second Brain's drop-folder routine (Chief Command Center).

Hermes runs this before the routine (`script` on the cron job) from the Second Brain folder. When there is
nothing to file, it prints `{"wakeAgent": false}` and the model is never called. Otherwise it lists what is
waiting, which Hermes adds to the routine's prompt. Standard library only.
"""
import json
import os
import sys
from pathlib import Path

IGNORE = {"readme.md", "desktop.ini", "thumbs.db"}


def waiting(folder: Path) -> list[Path]:
    return sorted((p for p in folder.iterdir() if p.is_file() and not p.name.startswith(".") and p.name.lower() not in IGNORE),
                  key=lambda p: p.stat().st_mtime)


def main() -> int:
    vault = Path(os.environ.get("CHIEF_DROP_VAULT") or os.getcwd())
    drop = vault / "drop"
    if not drop.is_dir():
        print(json.dumps({"wakeAgent": False}))
        return 0
    claimed = waiting(drop / "_processing") if (drop / "_processing").is_dir() else []
    pending = waiting(drop)
    if not claimed and not pending:
        print(json.dumps({"wakeAgent": False}))
        return 0
    lines = ["Second Brain drop folder:"]
    if claimed:
        lines.append("Left in drop/_processing/ by an interrupted run (finish this one first): " + ", ".join(p.name for p in claimed))
    if pending:
        lines.append(f"Waiting in drop/ ({len(pending)}, oldest first): " + ", ".join(p.name for p in pending[:20]))
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
