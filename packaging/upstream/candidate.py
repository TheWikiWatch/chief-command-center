"""Is there a newer upstream Hermes stable release than the pinned one? (PLAN §8 "Upstream tracking")

    python packaging/upstream/candidate.py [--json-out <file>]

Reads the latest stable release of hermes/pin.json's upstream from the GitHub API (GITHUB_TOKEN is used when
set, for rate limits), resolves its commit, and prints JSON: current pin, candidate tag and commit, and
`newer`. Exit code 0 either way; the workflow branches on `newer`.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def api(url: str) -> dict:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "chief-upstream-check"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as res:
        return json.loads(res.read())


def version_tuple(tag: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", tag)[:4])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-out", default="")
    args = parser.parse_args()
    pin = json.loads((REPO / "hermes" / "pin.json").read_text(encoding="utf-8"))
    owner_repo = re.sub(r"^https://github\.com/|\.git$", "", pin["upstream"])
    release = api(f"https://api.github.com/repos/{owner_repo}/releases/latest")
    tag = release["tag_name"]
    ref = api(f"https://api.github.com/repos/{owner_repo}/commits/{tag}")
    result = {
        "current": {"base_version": pin.get("baseVersion", ""), "commit": pin["commit"]},
        "candidate": {"tag": tag, "commit": ref["sha"], "published": release.get("published_at", ""), "url": release.get("html_url", "")},
        "newer": version_tuple(tag) > version_tuple(pin.get("baseVersion", "0")),
    }
    text = json.dumps(result, indent=2)
    print(text)
    if args.json_out:
        Path(args.json_out).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
