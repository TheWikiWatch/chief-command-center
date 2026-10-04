"""A reply the owner flags as a problem: the facts for a report to the app's developer, and the chief's short
summary of them (contract `chief.report.v1`).

The tester sees everything in the app before their own e-mail app sends anything. Recent errors come from the
chief's own logs, a couple of hours back, with anything that looks like a key, token or password blanked out.
The summary is a small call to the chief's own model; if that fails, the report goes with the facts alone.
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any

from . import data, providers

CONTRACT = "chief.report.v1"
ERRORS_SINCE_S = 2 * 3600
ERRORS_SHOWN = 8
_LOGS = ("errors.log", "chief-bridge.log")
_ERROR = re.compile(r"\b(ERROR|CRITICAL|Traceback|Exception)\b")
_STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
_SECRET = re.compile(
    r"(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|(?i:bearer)\s+[A-Za-z0-9._~+/-]{8,}"
    r"|(?i:api[_-]?key|token|secret|password|passphrase)\s*[=:]\s*\S+)"
)
_SYSTEM = (
    "You write short bug reports for the developer of Chief Command Center, a Windows app around an AI assistant. "
    "From the facts given, write 2 to 4 plain sentences: what the user was doing, what went wrong, and any error "
    "that explains it. No greeting, no advice, nothing beyond the facts. Leave out personal details that aren't "
    "needed to understand the problem."
)


def redact(text: str) -> str:
    return _SECRET.sub("[hidden]", text)


def recent_errors(home: Path | None = None, now: float | None = None) -> list[str]:
    """The last few error lines from the chief's logs in the past couple of hours, secrets blanked."""
    home = Path(home) if home else data.chief_home()
    cutoff = (now or time.time()) - ERRORS_SINCE_S
    found: list[tuple[str, str]] = []
    for name in _LOGS:
        path = home / "logs" / name
        try:
            if path.stat().st_mtime < cutoff:
                continue
            with open(path, "rb") as fh:
                fh.seek(max(0, path.stat().st_size - 256_000))
                lines = fh.read().decode("utf-8", "replace").splitlines()
        except OSError:
            continue
        for line in lines:
            stamp = _STAMP.match(line)
            if not stamp or not _ERROR.search(line):
                continue
            try:
                if time.mktime(time.strptime(stamp.group(1), "%Y-%m-%d %H:%M:%S")) < cutoff:
                    continue
            except ValueError:
                continue
            found.append((stamp.group(1), redact(line.strip())[:240]))
    found.sort(key=lambda item: item[0])
    seen: set[str] = set()
    unique = [line for _, line in found if not (line[20:] in seen or seen.add(line[20:]))]
    return unique[-ERRORS_SHOWN:]


def _facts(message: str, previous: str, note: str, errors: list[str]) -> str:
    parts = []
    if note.strip():
        parts.append(f"The user's note: {redact(note.strip())[:600]}")
    if previous.strip():
        parts.append(f"The user's message before it: {redact(previous.strip())[:800]}")
    parts.append(f"The assistant's reply the user flagged: {redact(message.strip())[:1500] or '(empty)'}")
    parts.append("Recent errors in the app's logs:\n" + ("\n".join(errors) if errors else "(none)"))
    return "\n\n".join(parts)


def draft(message: str, previous: str = "", note: str = "", timeout: float = 30.0) -> dict[str, Any]:
    """The report's facts and the chief's summary of them (empty when the model couldn't be reached)."""
    errors = recent_errors()
    current = providers.status()
    if not current.get("provider") or not current.get("model"):
        return {"ok": True, "summary": "", "errors": errors, "summaryError": "No model is chosen yet."}
    try:
        with data.chief_config_scope():
            from agent.auxiliary_client import call_llm

            reply = call_llm(
                provider=current["provider"],
                model=current["model"],
                messages=[{"role": "system", "content": _SYSTEM}, {"role": "user", "content": _facts(message, previous, note, errors)}],
                max_tokens=260,
                timeout=timeout,
            )
        summary = redact(providers._reply_text(reply))[:900]
    except Exception as exc:
        return {"ok": True, "summary": "", "errors": errors, "summaryError": providers._explain(exc).get("error", "The model didn't answer.")}
    return {"ok": True, "summary": summary, "errors": errors}
