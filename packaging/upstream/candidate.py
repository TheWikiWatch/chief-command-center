"""Is there a newer upstream Hermes stable release than the pinned one? (PLAN §8 "Upstream tracking")

    python packaging/upstream/candidate.py [--json-out <file>]

Reads the latest stable release of hermes/pin.json's upstream from the GitHub API (GITHUB_TOKEN is used when
set, for rate limits), resolves its commit, and prints JSON: current pin, candidate tag and commit, and
`newer`. Exit code 0 either way; the workflow branches on `newer`.

Also printed:
- `contains_pin`: whether the candidate commit has the pinned commit in its history. The pin can sit on upstream
  main past its base tag, so a candidate that isn't a descendant would drop commits the app already ships; the
  workflow never opens a PR for one unless its version is strictly newer, and then says how many it drops.
- `attempt_key`: a digest of everything on our side that decides whether an upgrade passes (the patches, the
  bridge plugin, the contract runners, the suite). A blocked upgrade is retried once this changes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
# What a fix to a blocked upgrade touches. Changing any of these makes the daily poll try the same tag again.
ATTEMPT_INPUTS = ("hermes/patches", "hermes/plugins", "hermes/tests/contract", "packaging/upstream/compat.py", "packaging/payload")


def api(url: str) -> dict:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "chief-upstream-check"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as res:
        return json.loads(res.read())


def version_tuple(tag: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", tag)[:4])


def attempt_key(repo: Path = REPO) -> str:
    """One short digest over the files that decide whether an upgrade passes (contents and paths, LF-normalized)."""
    digest = hashlib.sha256()
    files = []
    for rel in ATTEMPT_INPUTS:
        root = repo / rel
        found = [root] if root.is_file() else sorted(p for p in root.rglob("*") if p.is_file())
        files += [p for p in found if "__pycache__" not in p.parts and p.suffix not in (".pyc", ".pyo")]
    for path in sorted(files, key=lambda p: p.relative_to(repo).as_posix()):
        digest.update(path.relative_to(repo).as_posix().encode() + b"\0" + path.read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return digest.hexdigest()[:16]


def owner_repo(pin: dict) -> str:
    return re.sub(r"^https://github\.com/|\.git$", "", pin["upstream"])


def ancestry(owner: str, base: str, head: str) -> dict:
    """GitHub's compare of base...head: whether head contains base, and how many commits each side has."""
    cmp = api(f"https://api.github.com/repos/{owner}/compare/{base}...{head}")
    return {"contains": cmp.get("behind_by", 1) == 0, "ahead_by": cmp.get("ahead_by", 0), "behind_by": cmp.get("behind_by", 0)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-out", default="")
    args = parser.parse_args()
    pin = json.loads((REPO / "hermes" / "pin.json").read_text(encoding="utf-8"))
    owner = owner_repo(pin)
    release = api(f"https://api.github.com/repos/{owner}/releases/latest")
    tag = release["tag_name"]
    ref = api(f"https://api.github.com/repos/{owner}/commits/{tag}")
    rel = ancestry(owner, pin["commit"], ref["sha"])
    result = {
        "current": {"base_version": pin.get("baseVersion", ""), "commit": pin["commit"]},
        "candidate": {"tag": tag, "commit": ref["sha"], "published": release.get("published_at", ""), "url": release.get("html_url", "")},
        "newer": version_tuple(tag) > version_tuple(pin.get("baseVersion", "0")),
        "contains_pin": rel["contains"],
        "drops_commits": rel["behind_by"],
        "new_commits": rel["ahead_by"],
        "attempt_key": attempt_key(),
    }
    text = json.dumps(result, indent=2)
    print(text)
    if args.json_out:
        Path(args.json_out).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
