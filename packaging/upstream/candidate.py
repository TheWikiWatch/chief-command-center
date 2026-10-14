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


# Upstream's release tags: dates until 2026-09-24 (v2026.9.24, which was v0.21.5), version numbers since (v0.22.0).
# Anything else is refused before it reaches a workflow, a branch name or a PR: a tag is upstream-controlled text, and
# git allows quotes, `$(...)` and `;` in tag names.
TAG_RE = re.compile(r"^v?(?:\d{4}\.\d{1,2}\.\d{1,3}|\d{1,3}\.\d{1,3}\.\d{1,3})$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def checked(tag: str, sha: str) -> tuple[str, str]:
    """The tag and commit when both have the expected shape; SystemExit otherwise."""
    if not TAG_RE.fullmatch(str(tag)):
        raise SystemExit(f"upstream's latest release tag isn't a version this tool accepts: {tag!r}")
    if not SHA_RE.fullmatch(str(sha)):
        raise SystemExit(f"upstream's tag {tag} doesn't resolve to a full commit id")
    return str(tag), str(sha)


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
    tag = str(release["tag_name"])
    if not TAG_RE.fullmatch(tag):
        checked(tag, "")
    ref = api(f"https://api.github.com/repos/{owner}/commits/{tag}")
    tag, _ = checked(tag, str(ref.get("sha") or ""))
    rel = ancestry(owner, pin["commit"], ref["sha"])
    result = {
        "current": {"base_version": pin.get("baseVersion", ""), "commit": pin["commit"]},
        "candidate": {"tag": tag, "commit": ref["sha"], "published": release.get("published_at", ""), "url": release.get("html_url", "")},
        # By history, not by number: the tags changed scheme (2026.9.24, then 0.21.6), so comparing numbers called every
        # release since then older. Newer means it builds on the commit we ship and adds to it.
        "newer": rel["contains"] and rel["ahead_by"] > 0,
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
