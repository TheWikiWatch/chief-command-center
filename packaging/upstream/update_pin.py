"""Point hermes/pin.json at an upgrade candidate that passed the compatibility suite.

python packaging/upstream/update_pin.py --commit <sha> --base-version <tag> [--applied <file.json>]

`--applied` is prepare_source.py's `--applied-out` for that candidate. A patch that applied in one of its `next`
forms is promoted: that form's content replaces the entry's own file (same name, so history follows it), and the
`next` key and every `next` file go away.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def promote(pin: dict, applied: dict[str, str], patch_dir: Path) -> list[str]:
    """Promote every entry whose `next` form applied; returns the entries promoted."""
    promoted = []
    for patch in pin.get("patches", []):
        forms = patch.get("next") or []
        forms = [forms] if isinstance(forms, str) else list(forms)
        used = applied.get(patch["file"])
        if not used or used not in forms:
            continue
        (patch_dir / patch["file"]).write_bytes((patch_dir / used).read_bytes())
        for form in forms:  # the forms that didn't apply are for code upstream has moved past
            (patch_dir / form).unlink(missing_ok=True)
        del patch["next"]
        promoted.append(patch["file"])
    return promoted


def main(argv: list[str] | None = None, repo: Path = REPO) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--commit", required=True)
    parser.add_argument("--base-version", required=True)
    parser.add_argument("--applied", default="")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        raise SystemExit("--commit must be a full 40-character sha")
    pin_path = repo / "hermes" / "pin.json"
    pin = json.loads(pin_path.read_text(encoding="utf-8"))
    pin["commit"] = args.commit
    pin["baseVersion"] = args.base_version.lstrip("v")
    pin["note"] = f"upstream {args.base_version} (candidate from packaging/upstream, compatibility suite passed)"
    applied = json.loads(Path(args.applied).read_text(encoding="utf-8")) if args.applied else {}
    promoted = promote(pin, applied, repo / "hermes" / "patches")
    pin_path.write_text(json.dumps(pin, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"pinned {args.base_version} at {args.commit[:12]}" + (f"; promoted the newer form of {', '.join(promoted)}" if promoted else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
