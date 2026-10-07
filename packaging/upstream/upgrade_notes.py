"""The body of an "Upgrade Hermes to <tag>" PR: what changed upstream, what touches us, what's worth surfacing.

    python packaging/upstream/upgrade_notes.py --candidate <tag> --commit <sha> [--base <pinned sha>] [--src <prepared checkout>]
        [--compat compat.md] [--pin-log pin.log] [--out body.md] [--radar-json radar.json]

Sections:
- the release, its link and the compare range from the pin;
- "Touches our seams": upstream commits in that range that change a file our patches touch or a module the bridge
  imports (hermes_api.CAPABILITIES), from the prepared checkout's history;
- "Feature radar": the release's user-facing changes, each marked "arrives automatically" (inside Hermes, works the
  moment the pin moves), "needs dashboard work" (it has a face; our dashboard is the face) or "not relevant", plus a
  two-line note for testers. With ANTHROPIC_API_KEY set, Claude drafts it; without, the release's own bullet points
  are listed for the owner to sort;
- the compatibility report, and how to ship it.

`--radar-json` also writes the radar on its own, for the release notes and the app's "New in Hermes" card.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PLUGIN = REPO / "hermes" / "plugins" / "chief-dashboard-bridge"
MODEL = "claude-opus-5-5"

# What the dashboard shows of Hermes, so the radar can tell "arrives automatically" from "needs dashboard work".
DASHBOARD_SURFACES = """\
Chief Command Center is a Windows app whose dashboard is the only interface to a bundled Hermes Agent:
- Chat with the chief agent: streaming replies, tool steps, approvals (allow once/session/always, deny), questions,
  stop/steer/queue, threads, background tasks, attachments, voice in (speech-to-text) and out (text-to-speech).
- Fleet: the chief's bots (Hermes profiles) with faces, roles, SOUL and memory editing, models per bot, hiring.
- Routines (Hermes cron jobs), Fleet Health (a learning ledger), Usage (tokens and cost), Second Brain (a vault).
- Settings: model providers and keys, tool backends (image generation, web search), voice providers.
Hermes features used only through its own CLI, TUI, desktop app or messaging platforms are not visible here unless the
dashboard adds them. Agent-side behaviour (tools, models, memory, cron engine, reliability) arrives with the upgrade."""


def api(url: str) -> dict:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "chief-upstream-notes"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as res:
        return json.loads(res.read())


def load_pin() -> dict:
    return json.loads((REPO / "hermes" / "pin.json").read_text(encoding="utf-8"))


def seam_paths(pin: dict) -> dict[str, list[str]]:
    """{group: [paths]} of the upstream files whose changes touch us."""
    patched: set[str] = set()
    for patch in pin.get("patches", []):
        text = (REPO / "hermes" / "patches" / patch["file"]).read_text(encoding="utf-8", errors="replace")
        patched.update(re.findall(r"^diff --git a/(\S+) b/", text, flags=re.M))
    spec = importlib.util.spec_from_file_location("notes_hermes_api", PLUGIN / "hermes_api.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    modules = sorted({module for feature in mod.CAPABILITIES.values() for module in feature})
    bridged = [m.replace(".", "/") + suffix for m in modules for suffix in (".py", "/__init__.py")]
    return {"files our patches touch": sorted(patched), "modules the bridge imports": bridged}


def seam_commits(src: Path, base: str, head: str, paths: list[str], limit: int = 40) -> tuple[int, list[str]]:
    """(how many commits in base..head touch `paths`, the newest `limit` of them as one-liners)."""
    if not (src / ".git").exists() or not paths:
        return 0, []
    proc = subprocess.run(
        ["git", "log", "--no-merges", "--format=%h %s", f"{base}..{head}", "--", *paths],
        cwd=src,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    return len(lines), lines[:limit]


def bullet_points(notes: str, limit: int = 30) -> list[str]:
    """The release notes' own bullets (the deterministic radar when no model is available)."""
    out = []
    for line in notes.splitlines():
        m = re.match(r"\s*[-*]\s+(.*\S)", line)
        if m and len(m.group(1)) > 12:
            out.append(m.group(1)[:300])
        if len(out) >= limit:
            break
    return out


RADAR_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "feature": {"type": "string"},
                    "verdict": {"type": "string", "enum": ["arrives automatically", "needs dashboard work", "not relevant"]},
                    "why": {"type": "string"},
                },
                "required": ["feature", "verdict", "why"],
                "additionalProperties": False,
            },
        },
        "tester_note": {"type": "string"},
        "highlights": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["items", "tester_note", "highlights"],
    "additionalProperties": False,
}


def claude_radar(tag: str, notes: str) -> dict | None:
    """Claude's sorting of the release's user-facing changes, or None (no key, no SDK, a refusal, an error)."""
    if not os.environ.get("ANTHROPIC_API_KEY") or not notes.strip():
        return None
    try:
        import anthropic  # pyright: ignore[reportMissingImports]
    except ImportError:
        return None
    prompt = (
        f"{DASHBOARD_SURFACES}\n\nUpstream Hermes Agent released {tag}. Its release notes follow. List its user-facing "
        "changes (skip internal refactors and test-only changes; merge duplicates; at most 25 items), and mark each:\n"
        '- "arrives automatically": agent-side, so it works in the app as soon as the bundled Hermes moves;\n'
        '- "needs dashboard work": a person would only see or use it if the dashboard adds UI for it;\n'
        "- \"not relevant\": only affects surfaces this app doesn't use (other platforms, the Hermes desktop app's own UI).\n"
        "Then write `tester_note`: two plain sentences for non-technical testers on what improves for them, and "
        "`highlights`: two or three short phrases (under 60 characters each) for an in-app 'New in Hermes' card.\n\n"
        f"<release_notes>\n{notes[:60000]}\n</release_notes>"
    )
    client = anthropic.Anthropic()
    try:
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": RADAR_SCHEMA}},
            messages=[{"role": "user", "content": prompt}],
        )
    except anthropic.APIError as exc:
        print(f"feature radar: the Claude API call failed ({type(exc).__name__}); falling back to the release's bullets")
        return None
    if response.stop_reason in ("refusal", "max_tokens"):
        print(f"feature radar: no answer (stop reason {response.stop_reason}); falling back to the release's bullets")
        return None
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except ValueError:
        return None


def body(args, pin: dict, release: dict, radar: dict | None, notes: str) -> str:
    owner = re.sub(r"^https://github\.com/|\.git$", "", pin["upstream"])
    base = args.base or pin["commit"]
    lines = [
        f"Upstream released **{args.candidate}** ([release]({release.get('html_url', '')}), published {release.get('published_at', '?')[:10]}). "
        "The patch queue applied and the compatibility suite passed on a freshly built payload.",
        "",
        f"- Range: [`{base[:10]}...{args.commit[:10]}`](https://github.com/{owner}/compare/{base}...{args.commit})",
    ]
    if args.pin_log and Path(args.pin_log).is_file():
        lines.append(f"- Pin: {Path(args.pin_log).read_text(encoding='utf-8').strip()}")
    lines += ["", "### Touches our seams", ""]
    src = Path(args.src) if args.src else Path()
    for group, paths in seam_paths(pin).items():
        count, commits = seam_commits(src, base, args.commit, paths)
        lines.append(f"<details><summary>{count} commits change {group}</summary>\n")
        lines += [f"- {c}" for c in commits] or ["- none"]
        if count > len(commits):
            lines.append(f"- … and {count - len(commits)} more")
        lines += ["", "</details>", ""]
    lines += ["### Feature radar", ""]
    if radar:
        for verdict in ("needs dashboard work", "arrives automatically", "not relevant"):
            items = [i for i in radar.get("items", []) if i.get("verdict") == verdict]
            if items:
                lines += [f"**{verdict.capitalize()}**", ""] + [f"- {i['feature']}: {i['why']}" for i in items] + [""]
        lines += [f"**For testers:** {radar.get('tester_note', '').strip()}", ""]
        lines += ["Open an issue for each *needs dashboard work* item worth having, so features with a face aren't missed.", ""]
    else:
        points = bullet_points(notes)
        lines += ["No model was available to sort these (set the `ANTHROPIC_API_KEY` secret); the release's own points:", ""]
        lines += [f"- [ ] {p}" for p in points] or ["- (the release notes have no bullet points)"]
        lines.append("")
    if notes.strip():
        lines += ["<details><summary>Upstream release notes</summary>", "", notes[:20000], "", "</details>", ""]
    if args.compat and Path(args.compat).is_file():
        lines += [Path(args.compat).read_text(encoding="utf-8"), ""]
    lines += [
        "### Shipping it",
        "",
        f"Merge, `git pull`, then `npm run hermes:upgrade -- {args.candidate}` (builds and checks the payload on the release PC), "
        'then `npm run release -- --channel early --notes "…"` for the owner\'s soak, and `npm run release:promote -- <version>` for testers.',
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--base", default="", help="the pinned commit before the upgrade (default: hermes/pin.json's)")
    parser.add_argument("--src", default=os.environ.get("RUNNER_TEMP", "") and str(Path(os.environ["RUNNER_TEMP"]) / "hermes-src"))
    parser.add_argument("--compat", default="")
    parser.add_argument("--pin-log", default="")
    parser.add_argument("--out", default="")
    parser.add_argument("--radar-json", default="")
    args = parser.parse_args(argv)
    pin = load_pin()
    owner = re.sub(r"^https://github\.com/|\.git$", "", pin["upstream"])
    try:
        release = api(f"https://api.github.com/repos/{owner}/releases/tags/{args.candidate}")
    except Exception:
        release = {}
    notes = str(release.get("body") or "")
    radar = claude_radar(args.candidate, notes)
    text = body(args, pin, release, radar, notes)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8", newline="\n")
    else:
        print(text)
    if args.radar_json:
        Path(args.radar_json).write_text(
            json.dumps(radar or {"items": [], "tester_note": "", "highlights": []}, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
