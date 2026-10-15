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
import shutil
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
    ns = argparse.Namespace(out=args.out, ref=args.ref, source=Path(args.hermes_src), tools=None, cache=args.cache, frontends={})
    return native._stage_native(ns)


def main(argv: list[str] | None = None) -> int:
    # Upstream's bytecode check names the expected .pyc files with this interpreter's tag; the payload's Python is
    # 3.14, so an older host reports every module as uncompiled after the whole build.
    if sys.version_info[:2] < (3, 14):
        raise SystemExit(f"stage.py needs Python 3.14 (the payload's own version); this is {sys.version.split()[0]}. Run it with py -3.14 or a 3.14 python.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-src", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--cache", required=True)
    parser.add_argument(
        "--upstream-commit", default="", help="the upstream commit the source must sit on (default: hermes/pin.json's); an upgrade candidate names its own"
    )
    parser.add_argument("--inner", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--finish", action="store_true", help="only assemble an already prepared payload")
    args = parser.parse_args(argv)
    args.out = str(Path(args.out).resolve())
    args.hermes_src = str(Path(args.hermes_src).resolve())
    args.cache = str(Path(args.cache).resolve())
    Path(args.out).mkdir(parents=True, exist_ok=True)
    if args.inner:
        return _inner(args)
    if not args.finish:
        check_source(Path(args.hermes_src), args.upstream_commit)

    # Same isolation as upstream's stage_native: this build never touches the machine's Hermes state.
    work = Path(tempfile.mkdtemp(prefix=".build-", dir=args.out))
    env = {
        **os.environ,
        "HOME": str(work),
        "USERPROFILE": str(work),
        "HERMES_HOME": str(work / ".hermes"),
        "HERMES_RUNTIME_DIR": str(Path(args.out) / "tools"),
        "HERMES_PYTHON_SRC_ROOT": args.hermes_src,
        "XDG_CACHE_HOME": str(work / "cache"),
        "XDG_CONFIG_HOME": str(work / "config"),
        "UV_CACHE_DIR": args.cache,
        "PYTHONPATH": os.pathsep.join([args.hermes_src, *filter(None, sys.path)]),
    }
    for key, directory in (("CARGO_HOME", ".cargo"), ("RUSTUP_HOME", ".rustup")):
        env.setdefault(key, str(Path.home() / directory))
    command = [
        sys.executable,
        "-B",
        str(Path(__file__).resolve()),
        "--inner",
        "--hermes-src",
        args.hermes_src,
        "--out",
        args.out,
        "--ref",
        args.ref,
        "--cache",
        args.cache,
        *(["--finish"] if args.finish else []),
    ]
    code = subprocess.run(command, cwd=args.hermes_src, env=env).returncode
    if code == 0:
        write_install_stamp(Path(args.out), Path(args.hermes_src))
    return code


def check_source(source: Path, expected: str = "") -> None:
    """Build only from what prepare_source.py leaves: the expected upstream commit (the pin's, or an upgrade
    candidate's) with one commit of patches on top and nothing uncommitted. Checked before the build, which writes
    into the checkout."""
    pin = json.loads((HERE.parents[1] / "hermes" / "pin.json").read_text(encoding="utf-8"))
    want = (expected or pin["commit"]).strip().lower()
    upstream = subprocess.run(["git", "rev-parse", "HEAD^"], cwd=source, check=True, capture_output=True, text=True).stdout.strip()
    if upstream != want:
        raise SystemExit(f"{source} sits on {upstream[:10]}, not the expected {want[:10]}: prepare it again (prepare_source.py).")
    if subprocess.run(["git", "status", "--porcelain"], cwd=source, check=True, capture_output=True, text=True).stdout.strip():
        raise SystemExit(f"{source} has uncommitted changes: prepare it again (prepare_source.py) rather than building from it.")


# Portable Git for Windows finishes installing itself the first time its shell starts: post-install.bat runs the
# etc/post-install/*.post scripts (they copy the running PC's hosts, networks, protocols and services files into
# etc, make /dev/shm and /dev/mqueue, a mount link and DLL copies in git-core), then both delete themselves. Left for
# later, that first run happened inside the payload (the compatibility suite, the smoke test): the build PC's hosts
# file (names from its private network) shipped in the package, and the payload changed after its provenance was
# recorded. Running the scripts at build time isn't reliable either (on a PC with Git installed they resolve the
# installed Git as their root). So the build does their parts itself, with fixed contents, and removes them; the DLL
# copies aren't needed (an unrun portable Git works without them).
NEUTRAL_GIT_ETC = {
    "hosts": "# Chief Command Center: the bundled Git's hosts file (fixed at build time).\n127.0.0.1 localhost\n::1 localhost\n",
    "networks": "# Chief Command Center: the bundled Git's networks file (fixed at build time).\nloopback 127\n",
    "protocols": "# Chief Command Center: the bundled Git's protocols file (fixed at build time).\nip 0 IP\nicmp 1 ICMP\ntcp 6 TCP\nudp 17 UDP\nipv6 41 IPv6\n",
    "services": "# Chief Command Center: the bundled Git's services file (fixed at build time).\nssh 22/tcp\nhttp 80/tcp\nhttps 443/tcp\ngit 9418/tcp\n",
}


def neutral_git_etc(out: Path) -> None:
    for git in sorted(p for p in (out / "tools").glob("git-*") if (p / "etc").is_dir()):
        etc = git / "etc"
        for name, text in NEUTRAL_GIT_ETC.items():
            (etc / name).write_text(text, encoding="utf-8", newline="\n")
        for name in ("shm", "mqueue"):
            (git / "dev" / name).mkdir(parents=True, exist_ok=True)
        # The first-run scripts, so they never run later (inside a package, on someone else's PC).
        shutil.rmtree(etc / "post-install", ignore_errors=True)
        (git / "post-install.bat").unlink(missing_ok=True)
        # A link to /proc/mounts a Git run during the build left; Git makes it again wherever it runs.
        (etc / "mtab").unlink(missing_ok=True)
        print(f"OK the bundled Git's first-run setup done with fixed contents in {git.relative_to(out)}")


def write_install_stamp(out: Path, source: Path) -> None:
    """Declare the app as the payload's steward. Hermes reads this stamp: `hermes update` then refuses to
    touch the tree ("managed by chief-command-center"), and version reports show the pinned commit."""
    pin = json.loads((HERE.parents[1] / "hermes" / "pin.json").read_text(encoding="utf-8"))
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source, check=True, capture_output=True, text=True).stdout.strip()
    # What the source says it is (check_source made sure it's the pin), not what pin.json says it should be.
    upstream = subprocess.run(["git", "rev-parse", "HEAD^"], cwd=source, check=True, capture_output=True, text=True).stdout.strip()
    date = subprocess.run(["git", "show", "-s", "--format=%cI", pin["commit"]], cwd=source, check=True, capture_output=True, text=True).stdout.strip()
    stamp = {
        "commit": head,
        "upstreamCommit": upstream,
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
    neutral_git_etc(out)
    # Where it came from: patch and selection digests, this repository's commit, and a digest of every file.
    import provenance

    recorded = provenance.record(out)
    print(f"OK provenance (tree {recorded['tree'][:12]}, builder {recorded['builder']['commit'][:10]})")


if __name__ == "__main__":
    raise SystemExit(main())
