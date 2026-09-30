"""Point hermes/pin.json at an upgrade candidate that passed the compatibility suite.

    python packaging/upstream/update_pin.py --commit <sha> --base-version <tag>
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

PIN = Path(__file__).resolve().parents[2] / "hermes" / "pin.json"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--commit", required=True)
    parser.add_argument("--base-version", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        raise SystemExit("--commit must be a full 40-character sha")
    pin = json.loads(PIN.read_text(encoding="utf-8"))
    pin["commit"] = args.commit
    pin["baseVersion"] = args.base_version.lstrip("v")
    pin["note"] = f"upstream {args.base_version} (candidate from packaging/upstream, compatibility suite passed)"
    PIN.write_text(json.dumps(pin, indent=2) + "\n", encoding="utf-8")
    print(f"pinned {args.base_version} at {args.commit[:12]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
