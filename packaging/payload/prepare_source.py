"""Check out the pinned upstream Hermes commit and apply the app's patch queue (hermes/pin.json).

    python packaging/payload/prepare_source.py --dest <dir> [--commit <sha>] [--applied-out <file.json>]

Creates <dir> as a git checkout on a local branch `chief/<short sha>` with one commit holding the
patches, so the payload build (stage.py) snapshots exactly the pinned, patched tree. Refuses to touch an
existing directory unless it is already that checkout at the expected commit. `--commit` prepares another
upstream commit (an upgrade candidate, packaging/upstream/); a patch that no longer applies exits with code 3
and names it.

A patch entry may carry `next`: the same fix rewritten for newer upstream code (one file name, or a list for when
upstream's release candidate and main differ), kept ready before upstream releases that code. When the entry's own
file no longer applies, its `next` forms are tried in order. `--applied-out` writes
which file each entry used, so packaging/upstream/update_pin.py can promote a `next` form when the pin moves.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PATCHES = REPO / "hermes" / "patches"


def git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def load_pin(repo: Path = REPO) -> dict:
    return json.loads((repo / "hermes" / "pin.json").read_text(encoding="utf-8"))


def _applies(path: Path, dest: Path) -> tuple[bool, str]:
    proc = subprocess.run(["git", "apply", "--check", str(path)], cwd=dest, capture_output=True, text=True)
    return proc.returncode == 0, proc.stderr.strip()


def next_forms(patch: dict) -> list[str]:
    """An entry's `next` forms, in the order to try them (`next` is one file name or a list)."""
    nxt = patch.get("next") or []
    return [nxt] if isinstance(nxt, str) else list(nxt)


def apply_queue(dest: Path, patches: list[dict], patch_dir: Path = PATCHES) -> tuple[dict[str, str], str | None]:
    """Apply each patch in order (its `next` form when its own no longer applies).

    Returns ({entry file: file applied}, None) or, at the first patch that applies in no form, (what applied so
    far, a message naming it).
    """
    applied: dict[str, str] = {}
    for patch in patches:
        forms = [patch["file"], *next_forms(patch)]
        errors = []
        for form in forms:
            ok, err = _applies(patch_dir / form, dest)
            if ok:
                git("apply", str(patch_dir / form), cwd=dest)
                applied[patch["file"]] = form
                break
            errors.append(f"{form}: {err[:1500]}")
        else:
            return applied, f"PATCH FAILED {patch['file']}: " + " | ".join(errors)
    return applied, None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", required=True)
    parser.add_argument("--commit", default="")
    parser.add_argument("--applied-out", default="")
    args = parser.parse_args(argv)
    pin = load_pin()
    dest = Path(args.dest).resolve()
    commit = args.commit or pin["commit"]
    branch = f"chief/{commit[:7]}"
    if dest.exists():
        base = git("rev-parse", "HEAD~1", cwd=dest)
        if base != commit or git("rev-parse", "--abbrev-ref", "HEAD", cwd=dest) != branch:
            raise SystemExit(f"{dest} exists and is not the prepared checkout of {commit[:7]}")
        print(f"{dest} is already prepared ({branch})")
        return 0
    # Upstream's files exactly as committed, whatever this machine's core.autocrlf: the patches match those bytes.
    git("clone", "-c", "core.autocrlf=false", "--filter=blob:none", "--no-checkout", pin["upstream"], str(dest))
    git("checkout", "-q", "-b", branch, commit, cwd=dest)
    applied, failure = apply_queue(dest, pin["patches"])
    for entry, form in applied.items():
        print(f"applied {form}" + (f" (the newer form of {entry})" if form != entry else ""))
    if args.applied_out:
        Path(args.applied_out).write_text(json.dumps(applied, indent=2) + "\n", encoding="utf-8", newline="\n")
    if failure:
        print(failure)
        return 3
    git("add", "-A", cwd=dest)
    git("-c", "user.name=Chief build", "-c", "user.email=noreply@localhost", "commit", "-q", "-m", f"Chief patch queue on {commit[:7]}", cwd=dest)
    print(f"prepared {dest} at {git('rev-parse', 'HEAD', cwd=dest)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
