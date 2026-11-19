"""Realtime streaming live-transcription relay (Route A).

Each interview side opens a WebSocket here and streams its OWN microphone as raw PCM16 mono @
24 kHz. We relay that audio to a per-connection OpenAI realtime transcription session
(``services/realtime_transcribe.py``) and fan the resulting text to the INTERVIEWER's browser as
instant live captions — typically the first words land ~1.4 s after they're spoken, versus the
~12 s of the chunk-upload + 2.5 s poll path in ``interviews.py``.

This path is used only when ``settings.live_realtime_transcription_enabled`` is on and the realtime
session connects; on the flag being off or any connect failure we send the client ``{"type":
"fallback"}`` and close, so the frontend transparently reverts to the chunk pipeline and nothing
regresses.

Design mirrors ``signaling.py``: the join/interviewer token travels as a query param (browsers
can't set headers on a WS handshake) and is checked with the same ``_authorize``; an in-memory
per-session room registry assumes a single backend process (same assumption, and same scaling
caveat, as signaling).

Turn handling: ``gpt-live-transcribe`` streams delta fragments with no end-of-turn event, so we
accumulate the running line and finalize it when no new fragment has arrived for
``_SILENCE_FINALIZE_MS``. A finalized candidate turn also emits ``{"type": "candidate_turn"}`` to
the interviewer, which triggers the existing live answer-evaluation (and its suggested follow-up)
immediately instead of on the poll's debounce.
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.api.v1 import interviews as interviews_api
from app.api.v1.signaling import _authorize, _safe_send
from app.core.config import settings
from app.db.session import get_db
from app.services.realtime_transcribe import RealtimeTranscriber, RealtimeTranscriberError
from app.services.transcription import _looks_hallucinated

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/interviews", tags=["live-transcribe"])

# session_id -> {"interviewer": WebSocket, "candidate": WebSocket}. The interviewer socket is the
# target all transcript events are pushed to (so both speakers' columns show on the interviewer's
# panel); the candidate socket is upload-only.
_rooms: dict[str, dict[str, WebSocket]] = {}

# No new transcript fragment for this long ends the current utterance (gpt-live-transcribe emits no
# turn-boundary event of its own). Low enough to feel responsive, high enough not to split one
# sentence across a natural mid-thought pause.
_SILENCE_FINALIZE_MS = 1500


def _cleanup_room(sid: str, role: str, ws: WebSocket) -> None:
    room = _rooms.get(sid)
    if not room:
        return
    if room.get(role) is ws:
        del room[role]
    if not room:
        _rooms.pop(sid, None)


@router.websocket("/{session_id}/ws/transcribe")
async def transcribe(
    websocket: WebSocket,
    session_id: uuid.UUID,
    token: str = Query(...),
    role: Literal["candidate", "interviewer"] = Query(...),
    db: Session = Depends(get_db),
):
    session = _authorize(db, session_id, token, role)
    if not session:
        await websocket.close(code=4403)
        return

    await websocket.accept()

    # Flag off / no key → tell the client to use the chunk-upload fallback and close cleanly.
    if not settings.live_realtime_transcription_enabled or not settings.openai_api_key:
        await _safe_send(websocket, {"type": "fallback", "reason": "disabled"})
        await websocket.close()
        return

    sid = str(session_id)

    transcriber = RealtimeTranscriber()
    try:
        await transcriber.connect()
    except RealtimeTranscriberError:
        logger.exception("Realtime transcriber connect failed (session %s, role %s)", sid, role)
        await _safe_send(websocket, {"type": "fallback", "reason": "connect_failed"})
        await websocket.close()
        return

    _rooms.setdefault(sid, {})[role] = websocket

    # Running line for the current (not-yet-finalized) utterance + when its last fragment arrived.
    state = {"text": "", "last_fragment_at": time.monotonic()}

    async def push_to_interviewer(message: dict) -> None:
        interviewer_ws = _rooms.get(sid, {}).get("interviewer")
        if interviewer_ws is not None:
            await _safe_send(interviewer_ws, message)

    async def finalize_current(text: str) -> None:
        text = text.strip()
        if not text or _looks_hallucinated(text):
            return
        # Reuse the shared timeline + in-memory buffer so the poll endpoint / reconnects still work.
        offset_ms = interviews_api._live_timeline_offset_ms(sid)
        interviews_api._append_live_transcript_item(sid, role, text, offset_ms)
        await push_to_interviewer({"type": "final", "speaker": role, "text": text})
        if role == "candidate":
            # Instant follow-up: the interviewer client re-runs answer evaluation now instead of
            # waiting for the poll debounce.
            await push_to_interviewer({"type": "candidate_turn", "text": text})

    async def downlink() -> None:
        async for kind, fragment in transcriber.events():
            if kind == "delta":
                state["text"] += fragment
                state["last_fragment_at"] = time.monotonic()
                await push_to_interviewer(
                    {"type": "delta", "speaker": role, "text": state["text"].strip()}
                )
            elif kind == "final":
                # Authoritative full turn (gpt-4o-transcribe path): replace + finalize now.
                final_text = fragment.strip()
                state["text"] = ""
                await finalize_current(final_text)

    async def finalizer() -> None:
        while True:
            await asyncio.sleep(0.4)
            if state["text"] and (time.monotonic() - state["last_fragment_at"]) * 1000 >= _SILENCE_FINALIZE_MS:
                text = state["text"]
                state["text"] = ""
                await finalize_current(text)

    async def uplink() -> None:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            audio = message.get("bytes")
            if audio:
                try:
                    await transcriber.append_pcm(audio)
                except RealtimeTranscriberError:
                    # Upstream dropped — let the client fall back to the chunk path.
                    await _safe_send(websocket, {"type": "fallback", "reason": "upstream_closed"})
                    break
                continue
            text = message.get("text")
            if text:
                try:
                    control = json.loads(text)
                except (json.JSONDecodeError, TypeError):
                    continue
                if control.get("type") == "stop":
                    break

    down_task = asyncio.create_task(downlink())
    fin_task = asyncio.create_task(finalizer())
    try:
        await uplink()
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - never let a relay error escape the socket handler
        logger.exception("Live transcribe relay error (session %s, role %s)", sid, role)
    finally:
        for task in (down_task, fin_task):
            task.cancel()
        for task in (down_task, fin_task):
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown is best-effort
                pass
        # Flush whatever was mid-utterance when the socket closed so the last line isn't lost.
        if state["text"].strip():
            try:
                await finalize_current(state["text"])
            except Exception:  # noqa: BLE001
                pass
        await transcriber.close()
        _cleanup_room(sid, role, websocket)
