"""Phone alerts (Web Push), sent off the gateway's event loop.

Keys and subscriptions live in vapid.py; encryption and VAPID signing in webpush.py (both on the
cryptography package Hermes already ships). What this module adds:

- ``ttl``: how long a push service keeps an alert for a phone that is asleep (0 would mean "only if it
  is reachable this instant", which silently lost replies to phones in Doze).
- ``timeout``: bounded, and sends go through one worker thread, never the gateway's event loop.
- ``Topic``: an undelivered alert with the same topic is replaced, so a phone coming back online gets
  the newest reply, not a stack of them.
- The payload carries a ``tag`` so the service worker replaces the notification on the device too.
"""
from __future__ import annotations

import json
import logging
import queue
import re
import threading
import time
from typing import Any

from . import identity, vapid, webpush

logger = logging.getLogger("chief-dashboard-bridge")

REPLY_TTL = 3600
APPROVAL_TTL = 3600
SEND_TIMEOUT = 10
BODY_MAX = 180
# Notification tags (and push topics) the phone's service worker replaces by. Stable identifiers.
REPLY_TAG = "chief-reply"


# Same rules as the dashboard's chatTone (lib/chat-tone.ts): these are not replies to the owner.
_MACHINE = re.compile(r"^\s*(\[kanban\]|\[system note|\[context compaction|gateway message origin)", re.I)


def is_machine_note(text: str) -> bool:
    return not (text or "").strip() or bool(_MACHINE.match(text))


def plain_text(markdown: str, limit: int = BODY_MAX) -> str:
    """Notification text from a markdown reply: no markup, no file tags, cut at a word."""
    s = str(markdown or "")
    s = re.sub(r"```.*?(```|$)", " (code) ", s, flags=re.S)
    s = re.sub(r"^\s*MEDIA:\s*\S.*$", " ", s, flags=re.M)
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"\[\[([^\]|]+)(\|([^\]]+))?\]\]", lambda m: m.group(3) or m.group(1), s)
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)", "", s, flags=re.M)
    s = re.sub(r"(\*\*|__|~~|\*|(?<!\w)_(?!\s))", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) <= limit:
        return s
    cut = s[: limit - 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit * 0.6 else cut).rstrip(" ,.;:") + "…"


def _topic(tag: str) -> str:
    # RFC 8030: at most 32 characters of the URL-safe base64 alphabet.
    return re.sub(r"[^A-Za-z0-9_-]", "", tag)[:32]


def send(title: str, body: str, *, url: str = "/", tag: str = REPLY_TAG, ttl: int = REPLY_TTL,
         urgency: str = "normal", open_: dict | None = None, session: Any = None) -> dict[str, Any]:
    """Send one alert to every subscribed device now (blocking). Use ``enqueue`` from gateway code."""
    subs = vapid.load_subs()
    if not subs:
        return {"ok": True, "sent": 0, "skipped": "no subscriptions"}
    try:
        key = vapid.private_key()
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": f"vapid not configured: {exc}", "sent": 0}
    headers = {"Urgency": urgency}
    topic = _topic(tag)
    if topic:
        headers["Topic"] = topic
    payload = json.dumps({
        "title": title or identity.assistant_name(),
        "body": body or "",
        "url": url,
        "tag": tag,
        "open": open_ or {"tab": "chat"},
        "at": int(time.time() * 1000),
    }).encode("utf-8")
    sent, gone, errors = 0, [], []
    for sub in subs:
        outcome, detail = webpush.send(sub, payload, private_key=key, subject=identity.push_contact(), ttl=ttl,
                                       timeout=SEND_TIMEOUT, headers=headers, session=session)
        if outcome == "sent":
            sent += 1
        elif outcome == "gone":
            gone.append(sub.get("endpoint") or "")
        else:
            errors.append(detail)
    if gone:
        vapid.save_subs([s for s in vapid.load_subs() if s.get("endpoint") not in gone])
    if errors:
        logger.warning("push %s: %d sent, %d failed: %s", tag, sent, len(errors), errors[0])
    else:
        logger.info("push %s: %d sent", tag, sent)
    return {"ok": True, "sent": sent, "gone": len(gone), "errors": errors[:5]}


_queue: queue.Queue[tuple[tuple, dict]] = queue.Queue(maxsize=50)
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()


def _drain() -> None:
    while True:
        args, kwargs = _queue.get()
        try:
            send(*args, **kwargs)
        except Exception:
            logger.debug("push failed", exc_info=True)
        finally:
            _queue.task_done()


def enqueue(title: str, body: str, **kwargs) -> bool:
    """Send in the background, in order. Never blocks the caller; drops when 50 are waiting."""
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_drain, name="chief-dashboard-push", daemon=True)
            _worker.start()
    try:
        _queue.put_nowait(((title, body), kwargs))
        return True
    except queue.Full:
        logger.warning("push queue full; dropped %s", kwargs.get("tag"))
        return False


def notify_reply(text: str, thread: str = "main") -> bool:
    """A reply from the chief. Machine notes and empty text never reach the phone. Tapping opens its thread."""
    if is_machine_note(text):
        return False
    body = plain_text(text)
    if not body:
        return False
    open_ = {"tab": "chat"} if thread in ("", "main") else {"tab": "chat", "thread": thread}
    return enqueue(identity.assistant_name(), body, tag=REPLY_TAG if thread in ("", "main") else f"{REPLY_TAG}-{thread}", ttl=REPLY_TTL, open_=open_)


def notify_flags(flags: list[dict]) -> bool:
    """New fleet oversight flags from a learning ledger (churn, bloat, full memory, a worse verdict)."""
    if not flags:
        return False
    if len(flags) == 1:
        title = str(flags[0].get("title") or "Fleet flag")
        body = plain_text(flags[0].get("detail") or "Open Fleet Health to look.", 160)
    else:
        title = f"{len(flags)} new fleet flags"
        body = plain_text("; ".join(str(f.get("title") or "") for f in flags[:4]), 160)
    return enqueue(title, body, tag="fleet-flags", ttl=6 * 3600, open_={"tab": "fleet", "view": "health"})


def notify_approval(approval: dict) -> bool:
    """The chief is blocked on an approval. High urgency; tapping opens the approval sheet."""
    rid = str(approval.get("requestId") or "")
    if not rid:
        return False
    command = plain_text(approval.get("command") or approval.get("reason") or "", 160)
    return enqueue(
        f"{identity.assistant_name()} needs your approval",
        command or "Open the app to allow or deny.",
        tag=f"approval-{rid}",
        ttl=APPROVAL_TTL,
        urgency="high",
        open_={"tab": "chat", "approval": rid},
    )


def notify_question(question: str, clarify_id: str) -> bool:
    """The chief asked the owner a question and is waiting. High urgency; tapping opens the chat."""
    if not clarify_id:
        return False
    return enqueue(
        f"{identity.assistant_name()} has a question",
        plain_text(question or "", 160) or "Open the app to answer.",
        tag=f"question-{clarify_id}",
        ttl=APPROVAL_TTL,
        urgency="high",
        open_={"tab": "chat"},
    )


def notify_budget(spent: float, limit: float) -> bool:
    """The month's usage passed the owner's budget (once a month). Nothing is stopped."""
    return enqueue(
        "Monthly budget reached",
        f"${spent:,.2f} of ${limit:,.2f} this month. Nothing has been stopped; see Settings, then Usage.",
        tag="usage-budget",
        open_={"tab": "settings", "settings": "usage"},
    )
