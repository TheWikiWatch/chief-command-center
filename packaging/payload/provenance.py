"""Where a Hermes payload came from, recorded in its install stamp and checked before a release ships it.

The stamp (hermes-agent/install-stamp.json) gains a `provenance` block:

- `patches`: the SHA-256 of every patch in hermes/pin.json, as applied;
- `selection`: the SHA-256 of packaging/payload/selection.json (which Python extras and tools went in);
- `builder`: this repository's commit when the payload was built, and whether the tree had uncommitted changes;
- `tree`: one SHA-256 over every file in the payload (path, size and content; compiled Python, caches and the
  stamp itself left out), so any change to the payload after it was built shows.

    python packaging/payload/provenance.py --payload <dir> --check     compare with this repository (exit 1 if not)
    python packaging/payload/provenance.py --payload <dir> --write     record it on a payload built before this existed

stage.py writes it at the end of every build; scripts/release.mjs runs --check and puts the tree digest in release.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
STAMP = Path("hermes-agent") / "install-stamp.json"

# Left out of the tree digest: things Python or the builder write after the build, and the stamp itself.
_SKIP_DIRS = {"__pycache__", "uv-cache"}
_SKIP_SUFFIXES = (".pyc", ".pyo")
_SKIP_FILES = {"payload.prepare.lock"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_digest(payload: Path) -> str:
    """One digest over the payload's files, in a stable order; independent of timestamps and of where it lives."""
    digest = hashlib.sha256()
    stamp = (payload / STAMP).resolve()
    files = []
    for path in payload.rglob("*"):
        rel = path.relative_to(payload)
        if any(part in _SKIP_DIRS or part.startswith(".build-") for part in rel.parts[:-1]):
            continue
        if not path.is_file() or path.suffix in _SKIP_SUFFIXES or path.name in _SKIP_FILES or path.resolve() == stamp:
            continue
        files.append(rel)
    for rel in sorted(files, key=lambda p: p.as_posix()):
        full = payload / rel
        digest.update(f"{rel.as_posix()}\0{full.stat().st_size}\0{sha256_file(full)}\n".encode())
    return digest.hexdigest()


def expected(repo: Path = REPO) -> dict:
    """What this repository says the payload should contain (everything but the tree, which only a build makes)."""
    pin = json.loads((repo / "hermes" / "pin.json").read_text(encoding="utf-8"))
    patches = {p["file"]: sha256_file(repo / "hermes" / "patches" / p["file"]) for p in pin.get("patches", [])}
    return {"patches": patches, "selection": sha256_file(repo / "packaging" / "payload" / "selection.json")}


def builder(repo: Path = REPO) -> dict:
    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=False).stdout.strip()

    return {"commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain"))}


def record(payload: Path, repo: Path = REPO, after_the_fact: bool = False) -> dict:
    """Add the provenance block to the payload's stamp (the tree digest computed now). `after_the_fact`: a payload
    built before provenance existed, whose builder commit isn't known (only the patches and selection are checked)."""
    stamp_path = payload / STAMP
    stamp = json.loads(stamp_path.read_text(encoding="utf-8"))
    made_by = {"commit": "", "recorded_after_the_build": True} if after_the_fact else builder(repo)
    stamp["provenance"] = {**expected(repo), "builder": made_by, "tree": tree_digest(payload)}
    stamp_path.write_text(json.dumps(stamp, indent=2) + "\n", encoding="utf-8")
    return stamp["provenance"]


def check(payload: Path, repo: Path = REPO) -> list[str]:
    """Why this payload isn't the one this repository describes ([] when it is)."""
    try:
        stamp = json.loads((payload / STAMP).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [f"no install stamp in {payload}"]
    have = stamp.get("provenance")
    if not isinstance(have, dict):
        return ["the payload has no provenance record (built before it existed): run `python packaging/payload/provenance.py --payload <dir> --write`"]
    want = expected(repo)
    problems = []
    if have.get("patches") != want["patches"]:
        changed = sorted(set(have.get("patches", {}).items()) ^ set(want["patches"].items()))
        problems.append("the payload was built with different patches than hermes/pin.json lists: " + ", ".join(sorted({name for name, _ in changed})))
    if have.get("selection") != want["selection"]:
        problems.append("packaging/payload/selection.json changed since the payload was built")
    if have.get("tree") != tree_digest(payload):
        problems.append("the payload's files changed after it was built (its tree digest doesn't match)")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True, type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    parser.add_argument("--json", action="store_true", help="print the stamp's provenance as JSON")
    args = parser.parse_args(argv)
    if args.write:
        recorded = record(args.payload, after_the_fact=True)
        print(json.dumps(recorded) if args.json else f"OK provenance recorded (tree {recorded['tree'][:12]})")
        return 0
    problems = check(args.payload)
    if problems:
        print("\n".join(f"payload provenance: {p}" for p in problems), file=sys.stderr)
        return 1
    stamp = json.loads((args.payload / STAMP).read_text(encoding="utf-8"))
    print(json.dumps(stamp["provenance"]) if args.json else f"OK payload provenance matches (tree {stamp['provenance']['tree'][:12]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
