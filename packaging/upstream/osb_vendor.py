"""Vendor a pinned release of the obsidian-second-brain toolkit (MIT, Eugeniu Ghelbur) for the app.

    python packaging/upstream/osb_vendor.py --tag v0.17.0 [--source <existing checkout>]

Clones (or reuses) the upstream repository at the tag, runs its own Hermes build
(`bash scripts/build.sh --platform hermes`), and copies the result into
`hermes/vendor/obsidian-second-brain/`, unmodified apart from what is left out:

- `skills/research/*`: they need paid API keys (xAI, Perplexity, Gemini) and large downloads
  (Whisper with PyTorch); an owner can add them later on purpose;
- `skills/meta/create-command`: authoring tooling for the toolkit's own repository;
- `skills/meta/obsidian-retrieval-eval`: a benchmark that needs a local Ollama model.

Writes `vendor.json` (version, commit, what was left out) and `NOTICE.md`. Provisioning installs the tree
and points its script calls at the app's own Python (no `uv`, so nothing is downloaded); see
`apps/desktop/python/provision.py`.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
UPSTREAM = "https://github.com/eugeniughelbur/obsidian-second-brain"
DEST = REPO / "hermes" / "vendor" / "obsidian-second-brain"
LEFT_OUT = {
    "skills/research": "needs paid API keys and large downloads (Whisper, PyTorch); opt-in later",
    "skills/meta/create-command": "authoring tooling for the toolkit's own repository",
    "skills/meta/obsidian-retrieval-eval": "benchmark that needs a local Ollama model",
}
KEEP = ("skills", "optional-skills", "references", "scripts", "pyproject.toml", "INSTALL.md", "HOOKS.md")


def bash() -> str:
    """Git Bash on Windows (System32's `bash` is WSL), else the first bash on PATH."""
    for cand in (os.environ.get("OSB_BASH", ""), r"C:\Program Files\Gitinash.exe"):
        if cand and Path(cand).is_file():
            return cand
    return shutil.which("bash") or "bash"


def run(cmd: list[str], cwd: Path) -> str:
    out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise SystemExit(f"{' '.join(cmd)} failed:\n{out.stdout}\n{out.stderr}")
    return out.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--source", default="", help="an existing checkout to build from (else a fresh clone)")
    args = parser.parse_args()

    work = Path(tempfile.mkdtemp(prefix="osb-"))
    try:
        if args.source:
            src = Path(args.source).resolve()
        else:
            src = work / "src"
            run(["git", "clone", "--quiet", UPSTREAM, str(src)], work)
        run(["git", "checkout", "--quiet", args.tag], src)
        commit = run(["git", "rev-parse", "HEAD"], src)
        shutil.rmtree(src / "dist", ignore_errors=True)
        run([bash(), "scripts/build.sh", "--platform", "hermes"], src)
        built = src / "dist" / "hermes"

        shutil.rmtree(DEST, ignore_errors=True)
        DEST.mkdir(parents=True)
        for name in KEEP:
            item = built / name
            if item.is_dir():
                shutil.copytree(item, DEST / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "tests"))
            elif item.is_file():
                shutil.copy2(item, DEST / name)
        for rel in LEFT_OUT:
            shutil.rmtree(DEST / rel, ignore_errors=True)
        shutil.copy2(src / "LICENSE", DEST / "LICENSE")

        version = args.tag.lstrip("v")
        skills = sorted(p.parent.relative_to(DEST / "skills").as_posix() for p in (DEST / "skills").rglob("SKILL.md"))
        routines = sorted(p.parent.name for p in (DEST / "optional-skills").rglob("SKILL.md"))
        (DEST / "vendor.json").write_text(json.dumps({
            "name": "obsidian-second-brain", "version": version, "tag": args.tag, "commit": commit, "source": UPSTREAM,
            "license": "MIT", "author": "Eugeniu Ghelbur", "skills": skills, "routines": routines, "left_out": LEFT_OUT,
        }, indent=2) + "\n", encoding="utf-8")
        (DEST / "NOTICE.md").write_text(
            f"# obsidian-second-brain {version}\n\n"
            f"Vendored from {UPSTREAM} at `{args.tag}` (commit `{commit}`), built with the toolkit's own\n"
            "`bash scripts/build.sh --platform hermes`. MIT licensed, copyright (c) 2026 Eugeniu Ghelbur (see LICENSE).\n\n"
            "Left out of the app's default install:\n\n"
            + "".join(f"- `{rel}`: {why}\n" for rel, why in LEFT_OUT.items())
            + "\nRe-vendor a newer release with `python packaging/upstream/osb_vendor.py --tag <tag>`, then run the\n"
            "compatibility suite. Provisioning points the skills' script calls at the app's own Python.\n",
            encoding="utf-8")
        print(json.dumps({"ok": True, "version": version, "commit": commit, "skills": len(skills), "routines": routines}))
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
