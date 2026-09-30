"""Stage the Hermes runtime payload that ships inside Chief Command Center.

Reuses upstream Hermes's own native bundle builder (scripts/bundles/native.py, PM) so the
interpreter, dependency tree, launchers and manifest follow upstream's tested contract. Two
selections differ from upstream's desktop bundle:

- Tools: only what the app and the agent's core tools need (see TOOLS). Browser automation,
  computer use, local-model runtimes and other optional tools are left out; PM can still
  install them later at the user's request.
- Python extras: the explicit list in EXTRAS instead of --all-extras, so the payload never needs a
  compiler and carries no messaging platforms the app doesn't use.

Usage (host Python 3.14 with PM's runtime deps installed):
    python packaging/payload/stage.py --hermes-src <checkout> --out <dir> [--cache <uv cache>]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SELECTION = json.loads((HERE / "selection.json").read_text(encoding="utf-8"))
TOOLS: list[str] = SELECTION["tools"]
EXTRAS: list[str] = SELECTION["extras"]


def _inner(args: argparse.Namespace) -> int:
    """Runs inside the isolated environment with the Hermes checkout on sys.path."""
    import pm
    from scripts.bundles import native

    native._bundle_package_names = lambda: list(TOOLS)  # type: ignore[attr-defined]
    upstream_build = pm.build_environment

    def build_environment(**kwargs):
        kwargs["all_extras"] = False
        kwargs["extras"] = list(EXTRAS)
        return upstream_build(**kwargs)

    pm.build_environment = build_environment  # type: ignore[assignment]
    # No TUI or browser-dashboard products: the app is the interface. An empty map skips planting them.
    if args.finish:
        prepared = Path(args.out).with_name(Path(args.out).name + ".prepared.json")
        return native.finish_native(prepared, {})
    ns = argparse.Namespace(out=args.out, ref=args.ref, source=Path(args.hermes_src), tools=None,
                            cache=args.cache, frontends={})
    return native._stage_native(ns)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-src", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--cache", required=True)
    parser.add_argument("--inner", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--finish", action="store_true", help="only assemble an already prepared payload")
    args = parser.parse_args(argv)
    args.out = str(Path(args.out).resolve())
    args.hermes_src = str(Path(args.hermes_src).resolve())
    args.cache = str(Path(args.cache).resolve())
    Path(args.out).mkdir(parents=True, exist_ok=True)
    if args.inner:
        return _inner(args)

    # Same isolation as upstream's stage_native: this build never touches the machine's Hermes state.
    work = Path(tempfile.mkdtemp(prefix=".build-", dir=args.out))
    env = {**os.environ, "HOME": str(work), "USERPROFILE": str(work),
           "HERMES_HOME": str(work / ".hermes"),
           "HERMES_RUNTIME_DIR": str(Path(args.out) / "tools"),
           "HERMES_PYTHON_SRC_ROOT": args.hermes_src,
           "XDG_CACHE_HOME": str(work / "cache"), "XDG_CONFIG_HOME": str(work / "config"),
           "UV_CACHE_DIR": args.cache,
           "PYTHONPATH": os.pathsep.join([args.hermes_src, *filter(None, sys.path)])}
    for key, directory in (("CARGO_HOME", ".cargo"), ("RUSTUP_HOME", ".rustup")):
        env.setdefault(key, str(Path.home() / directory))
    command = [sys.executable, "-B", str(Path(__file__).resolve()), "--inner", "--hermes-src", args.hermes_src,
               "--out", args.out, "--ref", args.ref, "--cache", args.cache, *(["--finish"] if args.finish else [])]
    code = subprocess.run(command, cwd=args.hermes_src, env=env).returncode
    if code == 0:
        write_install_stamp(Path(args.out), Path(args.hermes_src))
    return code


def write_install_stamp(out: Path, source: Path) -> None:
    """Declare the app as the payload's steward. Hermes reads this stamp: `hermes update` then refuses to
    touch the tree ("managed by chief-command-center"), and version reports show the pinned commit."""
    pin = json.loads((HERE.parents[1] / "hermes" / "pin.json").read_text(encoding="utf-8"))
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source, check=True, capture_output=True, text=True).stdout.strip()
    date = subprocess.run(["git", "show", "-s", "--format=%cI", pin["commit"]], cwd=source, check=True,
                          capture_output=True, text=True).stdout.strip()
    stamp = {
        "commit": head,
        "upstreamCommit": pin["commit"],
        "commitDate": date,
        "baseVersion": pin["baseVersion"],
        "displayVersion": f"{pin['baseVersion']}+chief",
        "source": "build",
        "distribution": "chief-command-center",
        "updateMechanism": "external",
        "patches": [p["file"] for p in pin["patches"]],
    }
    (out / "hermes-agent" / "install-stamp.json").write_text(json.dumps(stamp, indent=2) + "\n", encoding="utf-8")
    print(f"OK install stamp (steward: chief-command-center, {head[:10]})")


if __name__ == "__main__":
    raise SystemExit(main())
