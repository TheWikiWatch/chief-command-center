"""Upstream drift: would our patches and the bridge still fit the Hermes that upstream is about to release?

    python packaging/upstream/drift.py --src <checkout dir> [--refs main,rc,release] [--report drift.md] [--json-out drift.json]

The daily upgrade poll (candidate.py) only looks at stable releases, so a patch that upstream's newer code no
longer fits used to show up on release day as a blocked upgrade. This looks ahead, in seconds and with no build:

1. For each ref (upstream `main`, the newest release candidate tag, the newest stable tag): apply the patch queue
   to a clean checkout, each patch in its own or its `next` form (prepare_source.apply_queue).
2. Check, statically, that every Hermes module and name the bridge relies on (hermes_api.CAPABILITIES) is still
   defined there. It reads the source with `ast` and imports nothing, so it needs none of Hermes's dependencies.
   A module that defines `__getattr__`, star-imports or fills `globals()` is taken on trust; a "new|old" name is
   found under either.
3. Note which files our patches touch have changed upstream since the pin (where the next refresh will be).

<checkout dir> is created (a partial clone) when missing and reused after that. Exit 0 always; `ok` in the JSON
says whether every ref is clean. The upstream-drift workflow keeps one issue up to date with the report.
"""

from __future__ import annotations

import argparse
import ast
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PLUGIN = REPO / "hermes" / "plugins" / "chief-dashboard-bridge"

spec = importlib.util.spec_from_file_location("prepare_source", REPO / "packaging" / "payload" / "prepare_source.py")
assert spec and spec.loader
prepare_source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_source)


def git(*args: str, cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()


def capabilities() -> dict[str, dict[str, tuple[str, ...]]]:
    """hermes_api.CAPABILITIES, loaded on its own (the module imports Hermes only lazily, inside get())."""
    s = importlib.util.spec_from_file_location("chief_hermes_api", PLUGIN / "hermes_api.py")
    assert s and s.loader
    mod = importlib.util.module_from_spec(s)
    s.loader.exec_module(mod)
    return mod.CAPABILITIES


def module_file(src: Path, module: str) -> Path | None:
    base = src.joinpath(*module.split("."))
    for path in (base.with_suffix(".py"), base / "__init__.py"):
        if path.is_file():
            return path
    return None


def top_level_names(path: Path) -> tuple[set[str], bool]:
    """Names a module defines at its top level, and whether it can provide others dynamically."""
    tree = ast.parse(path.read_text(encoding="utf-8-sig", errors="replace"))
    names: set[str] = set()
    dynamic = False

    def collect(nodes):
        nonlocal dynamic
        for node in nodes:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(node.name)
                dynamic |= node.name == "__getattr__"
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    names.update(n.id for n in ast.walk(target) if isinstance(n, ast.Name))
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign)) and isinstance(node.target, ast.Name):
                names.add(node.target.id)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    if alias.name == "*":
                        dynamic = True
                    else:
                        names.add(alias.asname or alias.name.split(".")[0])
            elif (
                isinstance(node, ast.Expr)
                and isinstance(node.value, ast.Call)
                and any(isinstance(arg, ast.Call) and isinstance(arg.func, ast.Name) and arg.func.id == "globals" for arg in node.value.args)
            ):
                dynamic = True  # e.g. `_registry.export(globals())`: the names are made at import time
            elif isinstance(node, (ast.If, ast.Try, ast.With)):
                # Definitions inside top-level guards (try/except ImportError, if TYPE_CHECKING...) still count.
                for field in ("body", "orelse", "finalbody"):
                    collect(getattr(node, field, []) or [])
                for handler in getattr(node, "handlers", []) or []:
                    collect(handler.body)

    collect(tree.body)
    return names, dynamic


def missing_names(src: Path, caps: dict[str, dict[str, tuple[str, ...]]]) -> list[str]:
    missing = []
    for feature, modules in caps.items():
        for module, wanted in modules.items():
            path = module_file(src, module)
            if path is None:
                missing.append(f"{module} ({feature}): module gone")
                continue
            if not wanted:
                continue
            names, dynamic = top_level_names(path)
            if dynamic:
                continue
            missing += [f"{module}.{name} ({feature})" for name in wanted if not set(name.split("|")) & names]
    return missing


def patched_files(patches: list[dict], patch_dir: Path) -> list[str]:
    files: set[str] = set()
    for patch in patches:
        for line in (patch_dir / patch["file"]).read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"diff --git a/(\S+) b/", line)
            if m:
                files.add(m.group(1))
    return sorted(files)


def ensure_checkout(src: Path, upstream: str) -> None:
    if not (src / ".git").exists():
        subprocess.run(
            ["git", "clone", "-c", "core.autocrlf=false", "--filter=blob:none", "--no-checkout", upstream, str(src)], check=True, capture_output=True
        )
    git("fetch", "-q", "--tags", "--force", "origin", "+refs/heads/main:refs/remotes/origin/main", cwd=src)


def version(tag: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", tag)[:4])


def resolve_refs(src: Path, wanted: list[str], base_version: str = "0") -> list[tuple[str, str, str]]:
    """[(label, ref name, sha)] for the refs asked for that exist."""
    out = []
    for label in wanted:
        if label == "main":
            out.append(("main", "origin/main", git("rev-parse", "origin/main", cwd=src)))
        elif label == "rc":
            tags = [t for t in git("tag", "--list", "rc.*", "--sort=-creatordate", cwd=src).splitlines() if re.fullmatch(r"rc\.\d+-v[\d.]+", t)]
            if tags:
                out.append(("release candidate", tags[0], git("rev-list", "-n1", tags[0], cwd=src)))
        elif label == "release":
            tags = [t for t in git("tag", "--list", "v*", cwd=src).splitlines() if re.fullmatch(r"v\d{4}\.\d+\.\d+", t)]
            newest = max(tags, key=version, default="")
            # Only a stable release newer than the pin's base is a place we might move to.
            if newest and version(newest) > version(base_version):
                out.append(("stable release", newest, git("rev-list", "-n1", newest, cwd=src)))
    return out


def check_ref(src: Path, sha: str, pin: dict, caps: dict) -> dict:
    git("checkout", "-q", "--detach", "-f", sha, cwd=src)
    git("clean", "-fdq", cwd=src)
    applied, failure = prepare_source.apply_queue(src, pin["patches"])
    missing = missing_names(src, caps)
    pinned = pin["commit"]
    try:
        contains = subprocess.run(["git", "merge-base", "--is-ancestor", pinned, sha], cwd=src).returncode == 0
        since = int(git("rev-list", "--count", f"{pinned}..{sha}", cwd=src))
        moved = [f for f in patched_files(pin["patches"], prepare_source.PATCHES) if git("diff", "--name-only", pinned, sha, "--", f, cwd=src)]
    except subprocess.CalledProcessError:
        contains, since, moved = False, -1, []
    git("checkout", "-q", "-f", sha, cwd=src)
    git("clean", "-fdq", cwd=src)
    return {
        "sha": sha,
        "patches": {p["file"]: applied.get(p["file"], "FAILED" if failure and p["file"] in failure else "not tried") for p in pin["patches"]},
        "patch_failure": failure,
        "missing": missing,
        "contains_pin": contains,
        "commits_since_pin": since,
        "patched_files_changed": moved,
        "ok": failure is None and not missing,
    }


def report(results: list[dict], pin: dict) -> str:
    ok = all(r["ok"] for r in results)
    lines = [
        f"## Upstream drift: {'all clear' if ok else 'ACTION NEEDED'}",
        "",
        f"Pinned: `{pin['commit'][:10]}` (base {pin.get('baseVersion', '?')}). Each ref below got our patch queue and a static check of every Hermes name the bridge uses.",
        "",
        "| Ref | Commit | Since pin | Patches | Bridge names | Result |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in results:
        forms = {name: ("ok" if form == name else form if form in ("FAILED", "not tried") else f"next form `{form}`") for name, form in r["patches"].items()}
        patch_cell = (
            "all apply" if all(f == "ok" for f in forms.values()) else ", ".join(f"{name.split('-')[0]}: {f}" for name, f in forms.items() if f != "ok")
        )
        names_cell = "all present" if not r["missing"] else f"{len(r['missing'])} missing"
        result_cell = "ok" if r["ok"] else "**needs work**"
        lines.append(f"| {r['label']} `{r['ref']}` | `{r['sha'][:10]}` | {r['commits_since_pin']} | {patch_cell} | {names_cell} | {result_cell} |")
    for r in results:
        if r["patch_failure"] or r["missing"] or r["patched_files_changed"] or not r["contains_pin"]:
            lines += ["", f"### {r['label']} `{r['ref']}`", ""]
            if not r["contains_pin"]:
                lines.append("- It does **not** contain the pinned commit (moving to it would drop commits the app ships).")
            if r["patch_failure"]:
                lines += ["- Patch queue:", "", "```", r["patch_failure"][:3000], "```"]
            if r["missing"]:
                lines += ["- Hermes names the bridge uses that are gone:", *[f"  - `{m}`" for m in r["missing"]]]
            if r["patched_files_changed"]:
                lines.append("- Files our patches touch that changed upstream since the pin: " + ", ".join(f"`{f}`" for f in r["patched_files_changed"]))
    lines += [
        "",
        'When a patch needs refreshing: write its new form as `hermes/patches/<name>.next.patch` and add `"next"` to its entry in `hermes/pin.json` (see prepare_source.py).',
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True)
    parser.add_argument("--refs", default="main,rc,release")
    parser.add_argument("--report", default="")
    parser.add_argument("--json-out", default="")
    args = parser.parse_args(argv)
    pin = prepare_source.load_pin()
    src = Path(args.src).resolve()
    ensure_checkout(src, pin["upstream"])
    caps = capabilities()
    results = []
    for label, ref, sha in resolve_refs(src, [r.strip() for r in args.refs.split(",") if r.strip()], pin.get("baseVersion", "0")):
        results.append({"label": label, "ref": ref, **check_ref(src, sha, pin, caps)})
        print(f"{'OK  ' if results[-1]['ok'] else 'WORK'} {label} {ref} {sha[:10]}", flush=True)
    text = report(results, pin)
    if args.report:
        Path(args.report).write_text(text + "\n", encoding="utf-8", newline="\n")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps({"ok": all(r["ok"] for r in results), "refs": results}, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
