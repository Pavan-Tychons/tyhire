import logging
import math
import os
import re
import subprocess

from app.services.openai_client import client

logger = logging.getLogger(__name__)

# whisper-1 is kept for the full-recording path specifically because it is the only
# transcription model that supports response_format="verbose_json", and therefore the only
# one that returns per-segment start/end timestamps — which two-track alignment (candidate
# mic + interviewer mic onto one timeline) depends on entirely.
TRANSCRIBE_MODEL = "whisper-1"

# The live panel only needs text, never segment timestamps, so it isn't held back by that
# constraint — and gpt-4o-transcribe is materially more accurate than whisper-1 on exactly
# the audio this feature deals with: short clips, accented English, conversational speech
# over an open laptop mic.
LIVE_TRANSCRIBE_MODEL = "gpt-4o-transcribe"

# Whisper hard-rejects anything over 26,214,400 bytes (25 MiB) with a 413. Stay comfortably
# under that — a WAV header and rounding add a little overhead to every chunk we cut.
MAX_UPLOAD_BYTES = 24 * 1024 * 1024

# Below this, a clip is treated as silence and never sent for transcription. Measured with
# ffmpeg's volumedetect rather than inferred from the model's output, because the model is
# exactly what can't be trusted here: on a silent clip it doesn't return empty text, it
# invents a plausible short phrase (see _HALLUCINATED_ON_SILENCE).
SILENCE_MEAN_DBFS = -45.0
# A clip shorter than this can't hold a useful utterance, and partial words at a chunk
# boundary are a common source of confidently-wrong output.
MIN_LIVE_CLIP_SECONDS = 0.7

# What speech-to-text models emit when handed silence or noise instead of returning nothing —
# largely artifacts of being trained on subtitle data. Only used as a backstop for clips that
# got past the volume gate above; matched against the whole (normalized) transcript, never as
# a substring, so a real sentence that happens to contain "thank you" is unaffected.
_HALLUCINATED_ON_SILENCE = {
    "you",
    "thank you",
    "thanks",
    "thank you very much",
    "thanks for watching",
    "thanks for watching!",
    "please subscribe",
    "subscribe to my channel",
    "bye",
    "bye bye",
    "goodbye",
    "subtitles by the amara.org community",
    "amara.org",
    "music",
    "silence",
    "applause",
}


def transcribe_recording(absolute_path: str) -> str:
    text, _ = transcribe_with_segments(absolute_path)
    return text


def _normalize_for_comparison(text: str) -> str:
    return re.sub(r"[^a-z0-9. ]", "", text.lower()).strip(" .")


def _looks_hallucinated(text: str) -> bool:
    """True for the canned phrases models fall back to on silence. Deliberately strict about
    length: a long transcript that merely opens with "Thank you" is real speech."""
    normalized = _normalize_for_comparison(text)
    if not normalized:
        return True
    if len(normalized) > 40:
        return False
    return normalized in _HALLUCINATED_ON_SILENCE


def _mean_volume_dbfs(path: str) -> float | None:
    """Mean volume of the clip via ffmpeg's volumedetect filter, or None if it can't be
    determined (unparseable/oddly-muxed clip) — in which case the caller should transcribe
    rather than silently discard possibly-real speech."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?) dB", result.stderr or "")
    return float(match.group(1)) if match else None


def _clip_duration_seconds(path: str) -> float | None:
    try:
        return _probe_duration_seconds(path)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def transcribe_short_clip(absolute_path: str, prompt: str | None = None) -> str:
    """Transcribes one short, independent audio clip (a few seconds) with no segment
    timestamps — the caller already knows this clip's own offset, so there's nothing to
    align. Backs the live, browser-agnostic transcript panel (see the live-transcript-chunk
    endpoints in interviews.py): short clips recorded and uploaded every few seconds, as a
    chunked alternative to the browser's own SpeechRecognition API, which only exists in
    Chromium browsers and is known to silently drop results even there.

    `prompt` should be what this same speaker said in the preceding chunk. Each clip is
    transcribed in isolation, so without it the model has no way to resolve a word cut in
    half at the chunk boundary, or to stay consistent on names and technical terms it has
    already heard — passing the previous text is the documented way to carry that context
    across independent requests.
    """
    duration = _clip_duration_seconds(absolute_path)
    if duration is not None and duration < MIN_LIVE_CLIP_SECONDS:
        return ""

    mean_dbfs = _mean_volume_dbfs(absolute_path)
    if mean_dbfs is not None and mean_dbfs < SILENCE_MEAN_DBFS:
        return ""

    with open(absolute_path, "rb") as f:
        result = client.audio.transcriptions.create(
            model=LIVE_TRANSCRIBE_MODEL,
            file=f,
            # gpt-4o-transcribe supports only json/text, not verbose_json — no segments and
            # no no_speech_prob, which is why silence is screened out by volume above
            # instead of by the model's own confidence.
            response_format="json",
            language="en",
            **({"prompt": prompt} if prompt else {}),
        )

    text = (result.text or "").strip()
    if _looks_hallucinated(text):
        logger.debug("Discarded likely-hallucinated live transcript chunk: %r", text)
        return ""
    return text


def transcribe_with_segments(absolute_path: str) -> tuple[str, list[dict]]:
    """Returns (full_text, segments) where each segment has start/end seconds relative to
    the start of this specific audio file — needed to align two separately-recorded tracks
    (candidate mic, interviewer mic) onto one shared timeline.

    Files over Whisper's 25MB limit are split into time-based chunks first (long interviews
    routinely exceed it), transcribed separately, and the segment timestamps re-offset onto
    the original file's timeline before being combined.
    """
    size = os.path.getsize(absolute_path)
    if size <= MAX_UPLOAD_BYTES:
        return _transcribe_chunk(absolute_path, offset_seconds=0.0)

    chunks = _split_into_chunks(absolute_path, size)
    try:
        text_parts: list[str] = []
        all_segments: list[dict] = []
        offset = 0.0
        for chunk_path, chunk_duration in chunks:
            text, segments = _transcribe_chunk(chunk_path, offset_seconds=offset)
            text_parts.append(text)
            all_segments.extend(segments)
            offset += chunk_duration
        return " ".join(p for p in text_parts if p), all_segments
    finally:
        for chunk_path, _ in chunks:
            try:
                os.remove(chunk_path)
            except OSError:
                pass


def _transcribe_chunk(path: str, offset_seconds: float) -> tuple[str, list[dict]]:
    with open(path, "rb") as f:
        result = client.audio.transcriptions.create(
            model=TRANSCRIBE_MODEL,
            file=f,
            response_format="verbose_json",
            # Without this, Whisper auto-detects the spoken language per chunk — and on
            # quiet/accented/noisy audio it sometimes misdetects English as Tamil, Hindi, or
            # another language entirely, transcribing real English speech into that
            # language's script instead of just getting the words wrong. Pinning it here is
            # the documented fix; only safe because every interview on this platform is
            # conducted in English — revisit if that ever stops being true.
            language="en",
        )
    segments = [
        {"start": seg.start + offset_seconds, "end": seg.end + offset_seconds, "text": seg.text.strip()}
        for seg in (result.segments or [])
    ]
    return result.text, segments


def _split_into_chunks(absolute_path: str, total_bytes: int) -> list[tuple[str, float]]:
    """Splits into N equal-duration chunks sized to land under MAX_UPLOAD_BYTES, using the
    file's own total duration/size ratio — works regardless of the exact sample rate the
    audio was extracted at."""
    duration = _probe_duration_seconds(absolute_path)
    num_chunks = max(1, math.ceil(total_bytes / MAX_UPLOAD_BYTES))
    chunk_duration = duration / num_chunks

    base, ext = absolute_path.rsplit(".", 1)
    chunks: list[tuple[str, float]] = []
    for i in range(num_chunks):
        start = i * chunk_duration
        # Last chunk runs to the true end rather than the computed duration, so trailing
        # audio never gets silently dropped to rounding.
        length = chunk_duration if i < num_chunks - 1 else max(chunk_duration, duration - start)
        chunk_path = f"{base}_chunk{i}.{ext}"
        subprocess.run(
            ["ffmpeg", "-y", "-ss", str(start), "-t", str(length), "-i", absolute_path, "-c", "copy", chunk_path],
            check=True,
            capture_output=True,
        )
        chunks.append((chunk_path, length))
    return chunks


def _probe_duration_seconds(path: str) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())
