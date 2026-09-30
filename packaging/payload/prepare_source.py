"""Check out the pinned upstream Hermes commit and apply the app's patch queue (hermes/pin.json).

    python packaging/payload/prepare_source.py --dest <dir>

Creates <dir> as a git checkout on a local branch `chief/<short sha>` with one commit holding the
patches, so the payload build (stage.py) snapshots exactly the pinned, patched tree. Refuses to touch an
existing directory unless it is already that checkout at the expected commit.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PIN = json.loads((REPO / "hermes" / "pin.json").read_text(encoding="utf-8"))


def git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", required=True)
    args = parser.parse_args(argv)
    dest = Path(args.dest).resolve()
    commit = PIN["commit"]
    branch = f"chief/{commit[:7]}"
    if dest.exists():
        base = git("rev-parse", "HEAD~1", cwd=dest)
        if base != commit or git("rev-parse", "--abbrev-ref", "HEAD", cwd=dest) != branch:
            raise SystemExit(f"{dest} exists and is not the prepared checkout of {commit[:7]}")
        print(f"{dest} is already prepared ({branch})")
        return 0
    git("clone", "--filter=blob:none", "--no-checkout", PIN["upstream"], str(dest))
    git("checkout", "-q", "-b", branch, commit, cwd=dest)
    for patch in PIN["patches"]:
        path = REPO / "hermes" / "patches" / patch["file"]
        git("apply", "--check", str(path), cwd=dest)
        git("apply", str(path), cwd=dest)
        print(f"applied {patch['file']}")
    git("add", "-A", cwd=dest)
    git("-c", "user.name=Chief build", "-c", "user.email=noreply@localhost", "commit", "-q", "-m",
        f"Chief patch queue on {commit[:7]}", cwd=dest)
    print(f"prepared {dest} at {git('rev-parse', 'HEAD', cwd=dest)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
