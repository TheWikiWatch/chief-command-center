"""VoiceStudio TTS provider for Hermes: `tts.provider: voicestudio`.

Registers one text-to-speech provider next to Edge, ElevenLabs and the rest. Nothing else in the
profile changes, and every other provider keeps working. See README.md.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("voicestudio-tts")


def register(ctx):
    from .provider import VoiceStudioTTS

    try:
        ctx.register_tts_provider(VoiceStudioTTS())
    except Exception:
        logger.warning("voicestudio-tts: registration failed", exc_info=True)
