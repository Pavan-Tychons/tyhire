"""Async client for OpenAI's realtime transcription (GA shape).

One instance streams ONE speaker's microphone audio (PCM16 mono @ 24 kHz) up to a dedicated
OpenAI transcription session and yields the transcript back as text fragments as they arrive.
The WebSocket relay in ``api/v1/live_transcribe.py`` owns one of these per connected interview
side, so the browser never holds the OpenAI API key.

Protocol notes (verified end-to-end against the account's own key, not copied from generic docs):

* URL ``wss://api.openai.com/v1/realtime?intent=transcription`` — no ``model`` in the URL.
* Auth header is ``Authorization: Bearer <key>`` ONLY. Sending ``OpenAI-Beta: realtime=v1`` is
  rejected with ``beta_api_shape_disabled`` because this account is on the GA shape.
* Configure by sending one ``session.update`` of ``type: "transcription"`` with the audio input
  format (``audio/pcm`` @ 24000) and the transcription model. Server acks ``session.created`` then
  ``session.updated``.
* With ``gpt-live-transcribe`` the server emits ONLY
  ``conversation.item.input_audio_transcription.delta`` events (``item_id`` + a ``delta`` text
  fragment), streamed word-by-word during speech, under a single constant ``item_id``. It does NOT
  emit ``.completed``, ``speech_started/stopped`` or ``committed`` events, and does NOT segment on
  pauses — so turn finalization (detecting the end of an utterance by a gap in the delta stream)
  is the caller's responsibility, not the model's.
"""

import base64
import json
import logging
from collections.abc import AsyncIterator

import websockets

from app.core.config import settings

logger = logging.getLogger(__name__)

_OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription"


class RealtimeTranscriberError(RuntimeError):
    """Raised when the realtime session can't be established — lets the relay fall back to the
    chunk-upload live-transcript path instead of leaving the client with a dead socket."""


class RealtimeTranscriber:
    """Thin wrapper around one OpenAI realtime transcription WebSocket.

    Usage: ``await connect()``; feed audio with ``append_pcm(bytes)`` from one task while another
    task iterates ``deltas()``; ``await close()`` when done. Concurrent send (append) and receive
    (deltas) from different tasks on the same socket is supported by ``websockets``.
    """

    def __init__(self, *, model: str | None = None, prompt: str | None = None) -> None:
        self._model = model or settings.openai_realtime_model
        self._prompt = prompt
        self._ws: websockets.ClientConnection | None = None

    async def connect(self) -> None:
        if not settings.openai_api_key:
            raise RealtimeTranscriberError("OpenAI API key is not configured")
        try:
            self._ws = await websockets.connect(
                _OPENAI_REALTIME_URL,
                additional_headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                max_size=None,
            )
            transcription: dict = {"model": self._model}
            if self._prompt:
                transcription["prompt"] = self._prompt
            await self._ws.send(
                json.dumps(
                    {
                        "type": "session.update",
                        "session": {
                            "type": "transcription",
                            "audio": {
                                "input": {
                                    "format": {"type": "audio/pcm", "rate": 24000},
                                    "transcription": transcription,
                                }
                            },
                        },
                    }
                )
            )
        except Exception as exc:  # noqa: BLE001 - normalize connect/handshake failures for the relay
            await self.close()
            raise RealtimeTranscriberError(f"realtime connect failed: {exc}") from exc

    async def append_pcm(self, pcm_bytes: bytes) -> None:
        """Send one frame of raw PCM16 mono 24 kHz audio. Raises if the upstream socket is gone,
        so the relay can stop and tell the client to fall back."""
        if self._ws is None:
            raise RealtimeTranscriberError("transcriber is not connected")
        await self._ws.send(
            json.dumps(
                {
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(pcm_bytes).decode(),
                }
            )
        )

    async def events(self) -> AsyncIterator[tuple[str, str]]:
        """Yield ``(kind, text)`` transcript events as they stream in, where kind is:

        * ``"delta"`` — a text fragment to append to the running line (the live model streams
          these word-by-word during speech).
        * ``"final"`` — an authoritative full transcript for the turn; the relay should replace the
          running line with it and finalize immediately. Only ``gpt-4o-transcribe`` /
          ``gpt-4o-mini-transcribe`` emit these; ``gpt-live-transcribe`` never does, which is why
          the relay also finalizes delta-only turns on a silence gap.

        Ends when the upstream socket closes.
        """
        if self._ws is None:
            return
        async for raw in self._ws:
            try:
                event = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            event_type = event.get("type")
            if event_type == "conversation.item.input_audio_transcription.delta":
                fragment = event.get("delta") or ""
                if fragment:
                    yield ("delta", fragment)
            elif event_type == "conversation.item.input_audio_transcription.completed":
                transcript = event.get("transcript") or ""
                if transcript:
                    yield ("final", transcript)
            elif event_type == "error":
                logger.warning("Realtime transcription error event: %s", event.get("error") or event)

    async def close(self) -> None:
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001 - closing is best-effort
                pass
            self._ws = None
