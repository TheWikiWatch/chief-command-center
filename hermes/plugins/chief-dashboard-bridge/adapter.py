"""Command Center platform adapter — first-class Hermes front door for ChiefDashboard.

Owns session identity, busy/typing (_active_sessions), outbound send (outbox + SSE),
and cron delivery via standalone_sender_fn. Dual-runs beside Discord until Phase 3.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime
from typing import Any
from collections.abc import Callable

from gateway.config import Platform, PlatformConfig
from gateway.platforms._shared import get_scoped_secret, seed_extra_from_env
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType

from . import changes
from . import identity
from .outbox import _outbox_path, append_outbox, read_outbox  # noqa: F401 (re-exported: the bridge reads them here)

logger = logging.getLogger("command-center-platform")

_ADAPTER_REF: CommandCenterAdapter | None = None
_ADAPTER_LOCK = threading.Lock()


def get_adapter() -> CommandCenterAdapter | None:
    return _ADAPTER_REF


def _set_adapter(adapter: CommandCenterAdapter | None) -> None:
    global _ADAPTER_REF
    with _ADAPTER_LOCK:
        _ADAPTER_REF = adapter


def _truthy(val: str | None, default: bool = True) -> bool:
    if val is None or str(val).strip() == "":
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "on")


def _notify_phone(message: str, chat_id: str = "") -> None:
    """Best-effort Web Push of a reply, queued off the event loop (see push.py); it opens the reply's thread."""
    try:
        from . import push
        from .threads import thread_of

        push.notify_reply(message or "", thread=thread_of(chat_id))
    except Exception:
        logger.debug("web push skipped", exc_info=True)


class CommandCenterAdapter(BasePlatformAdapter):
    """Loopback messaging platform for the Chief Command Center PWA."""

    # Hermes then reports each tool as it starts (set_status_text): the chat's live step line.
    supports_status_text = True

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("command_center"))
        self._loop: asyncio.AbstractEventLoop | None = None
        self._broadcast: Callable[[dict], None] | None = None
        self.chat_id = identity.owner_id()
        try:
            from .chat_state import install_status_capture

            install_status_capture()
        except Exception:
            logger.debug("status capture not installed", exc_info=True)

    def set_broadcast(self, fn: Callable[[dict], None]) -> None:
        self._broadcast = fn

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        self._loop = asyncio.get_running_loop()
        _set_adapter(self)
        self._mark_connected()
        logger.info("command_center platform connected (home=%s)", self.chat_id)
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()
        if get_adapter() is self:
            _set_adapter(None)
        logger.info("command_center platform disconnected")

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        mid = append_outbox(chat_id or self.chat_id, content or "", source="send")
        # Hermes's "⏳ Working — N min" busy notices feed the chat's step line; they never ping the phone.
        from .chat_state import busy_line

        if not busy_line(content or ""):
            _notify_phone(content or "", chat_id or self.chat_id)
        if self._broadcast:
            try:
                self._broadcast(
                    {
                        "type": "cc_outbox",
                        "at": time.time(),
                        "id": mid,
                        "chat_id": chat_id or self.chat_id,
                        "preview": (content or "")[:160],
                    }
                )
            except Exception:
                logger.debug("cc broadcast failed", exc_info=True)
        return SendResult(success=True, message_id=mid)

    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: list | None,
        clarify_id: str,
        session_key: str,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        """The chief's question as a card in the chat (the bridge reads it from Hermes's clarify registry
        with the transcript). Typing in the chat answers it too, as with Hermes's text fallback."""
        from tools.clarify_gateway import mark_awaiting_text

        mark_awaiting_text(clarify_id)
        try:
            from . import push

            push.notify_question(question or "", clarify_id)
        except Exception:
            logger.debug("question push skipped", exc_info=True)
        if self._broadcast:
            try:
                self._broadcast({"type": "cc_clarify", "at": time.time(), "id": clarify_id})
            except Exception:
                logger.debug("cc broadcast failed", exc_info=True)
        changes.bump("clarify")
        return SendResult(success=True, message_id=f"clarify-{clarify_id}")

    async def retire_clarify_card(self, clarify_id: str, notice: str = "") -> None:
        """The question ended without an answer (timed out, superseded): the card goes on the next poll."""
        if self._broadcast:
            try:
                self._broadcast({"type": "cc_clarify", "at": time.time(), "id": clarify_id, "retired": True})
            except Exception:
                pass
        changes.bump("clarify")

    def set_status_text(self, chat_id: str, text: str | None) -> None:
        super().set_status_text(chat_id, text)
        try:
            from .chat_state import record_status

            record_status(chat_id, text)
        except Exception:
            logger.debug("live step record failed", exc_info=True)
        changes.bump("status")

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        if self._broadcast:
            try:
                self._broadcast({"type": "cc_typing", "at": time.time(), "chat_id": chat_id})
            except Exception:
                pass

    async def get_chat_info(self, chat_id: str):
        return {"name": chat_id or self.chat_id, "type": "dm"}

    def queue_user_text(self, text: str, media: list | None = None, message_type: str = "text", chat_id: str | None = None) -> bool:
        """Accept a user turn onto the gateway loop and return without waiting for the model. `chat_id` picks the
        thread (each thread is its own chat, so Hermes gives it its own session); default: the main chat."""
        chat = chat_id or self.chat_id
        text = (text or "").strip()
        files = [item for item in (media or []) if isinstance(item, dict) and item.get("path")]
        if not text and not files:
            return False
        loop = self._loop
        if loop is None or not loop.is_running():
            logger.warning("command_center: no running loop for inbound")
            return False
        kind = {
            "photo": MessageType.PHOTO,
            "video": MessageType.VIDEO,
            "audio": MessageType.AUDIO,
            "document": MessageType.DOCUMENT,
        }.get(message_type, MessageType.DOCUMENT if files else MessageType.TEXT)

        async def _run() -> None:
            source = self.build_source(
                chat_id=chat,
                chat_name=identity.owner_label(),
                chat_type="dm",
                user_id=self.chat_id,
                user_name=identity.owner_label(),
            )
            event = MessageEvent(
                text=text,
                message_type=kind,
                source=source,
                user_id=self.chat_id,
                user_name=identity.owner_label(),
                message_id=uuid.uuid4().hex[:16],
                timestamp=datetime.now(),
                media_urls=[str(item["path"]) for item in files],
                media_types=[str(item.get("mime") or "application/octet-stream") for item in files],
                media_text_inlined=[bool(item.get("inlined")) for item in files],
            )
            await self.handle_message(event)

        fut = asyncio.run_coroutine_threadsafe(_run(), loop)

        def _done(done: concurrent.futures.Future[None]) -> None:
            try:
                done.result()
            except Exception:
                logger.exception("command_center inbound failed")

        fut.add_done_callback(_done)
        return True

    def submit_user_text(self, text: str) -> bool:
        """Thread-safe inbound from the HTTP bridge. Does not wait for DeepSeek."""
        return self.queue_user_text(text)

    def session_key_for_home(self) -> str:
        # Matches Hermes build_session_key for dm with chat_id
        return f"agent:main:command_center:dm:{self.chat_id}"


def check_requirements() -> bool:
    return _truthy(get_scoped_secret("COMMAND_CENTER_ENABLED", "1"), default=True)


def validate_config(config) -> bool:
    return check_requirements()


def _env_enablement() -> dict | None:
    if not check_requirements():
        return None
    return {
        "enabled": True,
        # The owner's chat is the home channel (where scheduled jobs and notices go) unless set otherwise.
        **seed_extra_from_env((), home_env="COMMAND_CENTER_HOME_CHANNEL", home_default=identity.owner_id()),
    }


async def _standalone_send(
    pconfig,
    chat_id: str,
    message: str,
    *,
    thread_id: str | None = None,
    media_files: list[str] | None = None,
    force_document: bool = False,
) -> dict[str, Any]:
    mid = append_outbox(chat_id or identity.owner_id(), message or "", source="cron")
    # Best-effort nudge of the live bridge, on its own thread: a blocking request here would stall the event loop.
    threading.Thread(target=_notify_bridge, args=(mid,), name="chief-outbox-notify", daemon=True).start()
    return {"success": True, "message_id": mid}


def _notify_bridge(mid) -> None:
    try:
        import urllib.request

        from . import bridge_token

        token = bridge_token.get()
        port = int(os.environ.get("CHIEF_DASHBOARD_PORT") or 7790)
        if token:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/outbox/notify",
                data=json.dumps({"id": mid}).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass


def register_platform(ctx) -> None:
    """Register command_center as a first-class Hermes messaging platform."""
    ctx.register_platform(
        name="command_center",
        label="Command Center",
        adapter_factory=CommandCenterAdapter,
        check_fn=check_requirements,
        validate_config=validate_config,
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="COMMAND_CENTER_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="COMMAND_CENTER_ALLOWED_USERS",
        allow_all_env="COMMAND_CENTER_ALLOW_ALL_USERS",
        max_message_length=0,
        emoji="🖥️",
        platform_hint=(
            "You are chatting with your owner through the Chief Command Center app (desktop and phone). "
            "Use clear markdown. Prefer concise replies suitable for phone reading."
        ),
    )
