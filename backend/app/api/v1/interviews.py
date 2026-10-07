import contextlib
import logging
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
import shutil
import subprocess
import tempfile

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.v1.auth import require_admin, require_hr_auth
from app.core.config import settings
from app.db.session import SessionLocal, get_db
from app.models.candidate import AuditLog, Candidate
from app.models.job import Job
from app.models.user import User
from app.models.interview import (
    IdentityCheck,
    IntegrityFlag,
    InterviewSession,
    SentimentSample,
    SessionStatus,
    SignalEvent,
    SignalType,
)
from app.schemas.interview import (
    CandidateJoinSessionOut,
    IdentityCheckOut,
    IdentityCheckOverrideRequest,
    IntegrityFlagOut,
    InterviewerDecisionRequest,
    InterviewerJoinSessionOut,
    ReviewDecision,
    SentimentSampleOut,
    SessionCreate,
    SessionOut,
    SignalEventIn,
    SignalEventOut,
    StartSessionResponse,
    LiveTranscriptIn,
    LiveTranscriptOut,
    SendConsolidatedReportRequest,
    EvaluateLiveAnswerRequest,
    RateQuestionAnswerRequest,
)
import io
from app.models.candidate import Candidate
from app.models.job import Job
from app.services import geolocation, integrity, sentiment_aggregate, storage, video_provider
from app.services.retention import purge_expired_identity_media, purge_expired_l1_recordings
from app.services.audio_extract import extract_audio_wav
from app.services.facial_analysis import analyze_facial_affect
from app.services.identity_check import check_identity_match
from app.services.qa_verification import analyze_qa
from app.services.transcript_merge import merge_transcripts
from app.services.transcription import transcribe_short_clip, transcribe_with_segments
from app.services.video_extract import extract_frames
from app.services.voice_tone import analyze_voice_tone
from app.services.livekit_service import generate_livekit_token
from app.services.question_generator import generate_suggested_questions
from app.services.answer_evaluator import evaluate_live_answer
from app.services.consolidated_report import (
    build_consolidated_report,
    build_consolidated_report_pdf,
    send_consolidated_report,
)

logger = logging.getLogger(__name__)

# In-memory buffer for real-time live transcription stream during active calls
_live_transcripts: dict[str, list[dict]] = {}
# Monotonic clock reading for the first live chunk of each session, so both sides' lines can
# be placed on ONE timeline. The offset each browser reports can't do that job: the candidate
# measures from their own "Join Meet" click and the interviewer from theirs, on two different
# machines, so the two sets of offsets are minutes apart in the same conversation and
# interleave nonsensically when merged.
_live_transcript_epoch: dict[str, float] = {}
_session_questions_cache: dict[str, list[dict]] = {}

router = APIRouter(prefix="/interviews", tags=["interviews"])


def require_session_token(
    session_id: uuid.UUID,
    x_interview_token: str = Header(...),
    db: Session = Depends(get_db),
) -> InterviewSession:
    """Candidate-facing endpoints are authorized by the join token, not just session_id —
    session_id is a UUID visible in every response and browser network tab, so it's not a
    secret. Without this check, anyone who saw any session's id could tamper with it."""
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not secrets.compare_digest(session.join_token, x_interview_token):
        raise HTTPException(status_code=403, detail="Invalid interview token")
    # Blocks replaying a finished interview on the same link — this guard sits on every
    # candidate-facing *mutating* endpoint (identity-check, signals, recording-chunk,
    # start, sentiment-sample, complete) since they all depend on this function. The
    # read-only GET /interviews/join/{token} doesn't use this dependency, so revisiting a
    # finished link can still render a friendly "already completed" message instead of a
    # raw 409 — the frontend checks session.status itself for that. /complete is unaffected
    # here: status is still in_progress/identity_pending at the moment it's called, only
    # flipping to completed once that handler finishes.
    if session.status == SessionStatus.completed:
        raise HTTPException(status_code=409, detail="This interview has already been completed.")
    return session


def require_interviewer_token(
    session_id: uuid.UUID,
    x_interviewer_token: str = Header(...),
    db: Session = Depends(get_db),
) -> InterviewSession:
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not session.interviewer_join_token or not secrets.compare_digest(
        session.interviewer_join_token, x_interviewer_token
    ):
        raise HTTPException(status_code=403, detail="Invalid interviewer token")
    return session


# --- HR-facing (require login) ---------------------------------------------------------


@router.post("", response_model=SessionOut, dependencies=[Depends(require_hr_auth)])
def create_session(payload: SessionCreate, db: Session = Depends(get_db)):
    session = InterviewSession(
        candidate_name=payload.candidate_name,
        job_id=payload.job_id,
        candidate_id=payload.candidate_id,
        join_token=secrets.token_urlsafe(16),
        interviewer_join_token=secrets.token_urlsafe(16),
        video_room_token=secrets.token_urlsafe(16),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.get("/{session_id}", response_model=SessionOut, dependencies=[Depends(require_hr_auth)])
def get_session(session_id: uuid.UUID, db: Session = Depends(get_db)):
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.get(
    "/by-candidate/{candidate_id}",
    response_model=list[SessionOut],
    dependencies=[Depends(require_hr_auth)],
)
def list_sessions_for_candidate(candidate_id: uuid.UUID, db: Session = Depends(get_db)):
    """Backs the consolidated candidate final-decision view — a candidate usually has one
    session, but nothing stops re-interviewing, so this returns all of them, newest first."""
    return (
        db.query(InterviewSession)
        .filter(InterviewSession.candidate_id == candidate_id)
        .order_by(InterviewSession.created_at.desc())
        .all()
    )


RANGE_HEADER_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
RECORDING_CHUNK_SIZE = 1024 * 1024  # 1MB


def _iter_file_range(path: str, start: int, end: int):
    """Yields the [start, end] byte range (inclusive) from path in fixed-size chunks —
    never holds more than one chunk in memory, unlike reading the whole file up front."""
    with open(path, "rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            data = f.read(min(RECORDING_CHUNK_SIZE, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _serve_recording(relative_path: str, media_type: str, request: Request) -> StreamingResponse:
    """Streams a (possibly encrypted-at-rest) recording through an authenticated route
    instead of the public static /media mount, with Range support so a <video>/<audio>
    element can seek and start playing before the whole file (up to several hundred MB)
    has downloaded, rather than requiring it in full first.

    decrypted_temp_copy's context manager can't be used with a plain `with` here — the
    StreamingResponse generator below runs *after* this function returns, once Starlette
    is actually sending the body, so the temp file it creates for an encrypted recording
    must outlive this function. Driving it manually and handing its __exit__ to the
    response's background task defers cleanup until the whole response has been sent."""
    ctx = storage.decrypted_temp_copy(relative_path)
    real_path = ctx.__enter__()
    cleanup = BackgroundTask(ctx.__exit__, None, None, None)

    try:
        file_size = os.path.getsize(real_path)
        range_header = request.headers.get("range")

        if range_header:
            match = RANGE_HEADER_RE.match(range_header.strip())
            if not match:
                raise HTTPException(status_code=416, detail="Invalid Range header")
            start = int(match.group(1)) if match.group(1) else 0
            end = int(match.group(2)) if match.group(2) else file_size - 1
            end = min(end, file_size - 1)
            if start > end or start >= file_size:
                raise HTTPException(
                    status_code=416,
                    detail="Range not satisfiable",
                    headers={"Content-Range": f"bytes */{file_size}"},
                )
            return StreamingResponse(
                _iter_file_range(real_path, start, end),
                status_code=206,
                media_type=media_type,
                headers={
                    "Accept-Ranges": "bytes",
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Content-Length": str(end - start + 1),
                },
                background=cleanup,
            )

        return StreamingResponse(
            _iter_file_range(real_path, 0, file_size - 1),
            media_type=media_type,
            headers={"Accept-Ranges": "bytes", "Content-Length": str(file_size)},
            background=cleanup,
        )
    except Exception:
        cleanup.func(*cleanup.args)
        raise


@router.get(
    "/{session_id}/media/recording",
    dependencies=[Depends(require_hr_auth)],
)
def get_candidate_recording(session_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    session = db.get(InterviewSession, session_id)
    if not session or not session.recording_file_path:
        raise HTTPException(status_code=404, detail="No recording available")
    return _serve_recording(session.recording_file_path, "video/webm", request)


@router.get(
    "/{session_id}/media/interviewer-recording",
    dependencies=[Depends(require_hr_auth)],
)
def get_interviewer_recording(session_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    session = db.get(InterviewSession, session_id)
    if not session or not session.interviewer_recording_file_path:
        raise HTTPException(status_code=404, detail="No interviewer recording available")
    return _serve_recording(session.interviewer_recording_file_path, "audio/webm", request)


@router.post("/cleanup-expired-media", dependencies=[Depends(require_hr_auth)])
def cleanup_expired_media(db: Session = Depends(get_db)):
    """Manually clears raw ID/selfie image files and L1 phone recordings past the retention window,
    keeping verdicts, confidence, transcripts, and evaluation notes for audit purposes. Retention is also
    enforced automatically by the in-process daily sweep (see app.main) and can be driven by
    external cron (python -m app.jobs.run_retention_sweep); all three share the same logic."""
    cleared_id = purge_expired_identity_media(db)
    cleared_l1 = purge_expired_l1_recordings(db)
    return {"identity_checks_cleaned": cleared_id, "l1_recordings_cleaned": cleared_l1}


@router.get(
    "/review/queue", response_model=list[SessionOut], dependencies=[Depends(require_hr_auth)]
)
def review_queue(db: Session = Depends(get_db)):
    """Surfaces both integrity-score-flagged sessions (set at /complete) and sessions with an
    unresolved identity mismatch that was hard-passed through /start — since a mismatch no
    longer blocks the interview (see start_session), this is the only place it still reaches
    HR. Clearing it via POST .../identity-check/override removes it from here."""
    unresolved_identity_mismatch = db.query(IdentityCheck.session_id).filter(
        IdentityCheck.needs_human_review == True,  # noqa: E712
        IdentityCheck.cleared_by_hr == False,  # noqa: E712
    )
    return (
        db.query(InterviewSession)
        .filter(
            or_(
                InterviewSession.integrity_needs_review == True,  # noqa: E712
                InterviewSession.id.in_(unresolved_identity_mismatch),
            )
        )
        .order_by(InterviewSession.completed_at.desc())
        .all()
    )


@router.delete("/{session_id}")
def delete_session(
    session_id: uuid.UUID,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Permanently removes an interview session once it's been reviewed and is no longer
    needed — admin-only, since this deletes the recording, transcripts, and every fused
    integrity flag with no way back. None of the child tables here cascade at the DB level
    (signals/flags/identity-checks/sentiment-samples all reference session_id with no
    ON DELETE), so they're removed explicitly first; the audit trail is kept, just
    detached, same as everywhere else a hard delete happens in this app."""
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    db.query(SignalEvent).filter(SignalEvent.session_id == session_id).delete()
    db.query(IntegrityFlag).filter(IntegrityFlag.session_id == session_id).delete()
    db.query(SentimentSample).filter(SentimentSample.session_id == session_id).delete()
    db.query(IdentityCheck).filter(IdentityCheck.session_id == session_id).delete()
    db.query(AuditLog).filter(AuditLog.interview_session_id == session_id).update(
        {"interview_session_id": None}
    )

    db.add(AuditLog(
        actor=f"hr:{admin.email}",
        action="hard_delete_interview_session",
        detail={"session_id": str(session_id), "candidate_name": session.candidate_name},
    ))

    db.delete(session)
    db.commit()

    # Recording, identity photos, and sentiment clips all live under this one prefix —
    # removed after the commit succeeds, mirroring the candidate/job delete file-cleanup
    # pattern elsewhere in this app.
    storage.remove_directory(f"interviews/{session_id}")

    return {"deleted": True}


@router.get(
    "/{session_id}/flags",
    response_model=list[IntegrityFlagOut],
    dependencies=[Depends(require_hr_auth)],
)
def get_flags(session_id: uuid.UUID, db: Session = Depends(get_db)):
    return (
        db.query(IntegrityFlag)
        .filter(IntegrityFlag.session_id == session_id)
        .order_by(IntegrityFlag.session_offset_ms)
        .all()
    )


@router.post(
    "/flags/{flag_id}/decision",
    response_model=IntegrityFlagOut,
    dependencies=[Depends(require_hr_auth)],
)
def decide_flag(
    flag_id: uuid.UUID,
    payload: ReviewDecision,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    flag = db.get(IntegrityFlag, flag_id)
    if not flag:
        raise HTTPException(status_code=404, detail="Flag not found")

    flag.reviewed = True
    flag.reviewer_decision = payload.decision
    flag.reviewer_note = payload.note
    db.add(flag)

    db.add(AuditLog(
        interview_session_id=flag.session_id,
        actor=f"hr:{current_hr_user['email']}",
        action="review_flag",
        detail={"decision": payload.decision, "note": payload.note},
    ))

    db.commit()
    db.refresh(flag)
    return flag


# --- Candidate-facing (authorized by join token, no login) -----------------------------


@router.get("/join/{join_token}", response_model=CandidateJoinSessionOut)
def get_session_by_token(join_token: str, db: Session = Depends(get_db)):
    session = db.query(InterviewSession).filter(InterviewSession.join_token == join_token).first()
    if not session:
        raise HTTPException(status_code=404, detail="Invalid or expired interview link")
    session.ice_servers = video_provider.get_ice_servers()

    # Generate LiveKit token if configured
    room_id = video_provider.get_room_id(session)
    lk_token = generate_livekit_token(room_name=room_id, identity="candidate", name=session.candidate_name)
    if lk_token:
        session.livekit_token = lk_token
        session.livekit_url = settings.livekit_url

    return session


@router.post("/{session_id}/identity-check", response_model=IdentityCheckOut)
async def submit_identity_check(
    request: Request,
    id_document: UploadFile,
    selfie: UploadFile,
    liveness_prompt: str = Form(...),
    liveness_passed: bool = Form(...),
    voice_enrollment: Optional[UploadFile] = None,
    session: InterviewSession = Depends(require_session_token),
    db: Session = Depends(get_db),
):
    id_bytes = await id_document.read()
    selfie_bytes = await selfie.read()

    id_path = storage.save_file(f"interviews/{session.id}", id_document.filename, id_bytes)
    selfie_path = storage.save_file(f"interviews/{session.id}", selfie.filename, selfie_bytes)

    voice_path = None
    if voice_enrollment:
        voice_bytes = await voice_enrollment.read()
        voice_path = storage.save_file(f"interviews/{session.id}", voice_enrollment.filename, voice_bytes)

    match = check_identity_match(
        id_bytes, id_document.content_type or "image/jpeg",
        selfie_bytes, selfie.content_type or "image/jpeg",
    )

    check = IdentityCheck(
        session_id=session.id,
        id_document_path=id_path,
        selfie_path=selfie_path,
        voice_enrollment_path=voice_path,
        liveness_prompt=liveness_prompt,
        liveness_passed=liveness_passed,
        match_confidence=match["confidence"],
        match_verdict=match["verdict"],
        needs_human_review=match["needs_human_review"] or not liveness_passed,
    )
    db.add(check)

    session.status = SessionStatus.identity_pending if check.needs_human_review else SessionStatus.in_progress
    session.started_at = datetime.now(timezone.utc)

    # Captured once, here, rather than per-request — location shouldn't change mid-call, and
    # this is the first candidate-facing endpoint of the session.
    session.candidate_ip = request.client.host if request.client else None
    _maybe_flag_location_mismatch(db, session)

    db.add(session)

    db.add(AuditLog(
        interview_session_id=session.id,
        actor="system",
        action="identity_check",
        detail={"verdict": match["verdict"], "confidence": match["confidence"]},
    ))

    db.commit()
    db.refresh(check)
    return check


def _maybe_flag_location_mismatch(db: Session, session: InterviewSession) -> None:
    if not session.candidate_id or not session.candidate_ip:
        return
    candidate = db.get(Candidate, session.candidate_id)
    stated_location = (candidate.parsed_profile or {}).get("current_location") if candidate else None
    if not stated_location:
        return

    resolved_region = geolocation.resolve_region(session.candidate_ip)
    if geolocation.is_location_mismatch(resolved_region, stated_location):
        db.add(SignalEvent(
            session_id=session.id,
            signal_type=SignalType.location_mismatch,
            session_offset_ms=0,
            weight=5,
            meta={"resolved_region": resolved_region, "stated_location": stated_location},
        ))


@router.post("/{session_id}/start", response_model=StartSessionResponse)
def start_session(
    session: InterviewSession = Depends(require_session_token), db: Session = Depends(get_db)
):
    """The real gate behind the candidate's "Join interview" button — client-side-only
    checks can be bypassed by hitting the API directly, so both the probe and identity
    checks are enforced here, not just in the UI."""
    job = db.get(Job, session.job_id) if session.job_id else None

    if job and job.require_desktop_probe and not _probe_connected(session):
        raise HTTPException(
            status_code=409,
            detail="Desktop monitor not detected. Install and run the probe, then try again.",
        )

    latest_check = (
        db.query(IdentityCheck)
        .filter(IdentityCheck.session_id == session.id)
        .order_by(IdentityCheck.created_at.desc())
        .first()
    )
    if not latest_check:
        raise HTTPException(
            status_code=409,
            detail="Identity verification has not been completed for this interview.",
        )
    # A no_match/uncertain/failed-liveness verdict is a soft pass, not a hard block: the
    # candidate proceeds into the interview, but the session lands in HR's review queue (see
    # review_queue below) and this decision is audit-logged here, so HR has something to act
    # on afterward instead of the candidate being stuck until someone clears cleared_by_hr.
    if latest_check.needs_human_review and not latest_check.cleared_by_hr:
        db.add(AuditLog(
            interview_session_id=session.id,
            actor="system",
            action="identity_check_hard_pass",
            detail={
                "verdict": latest_check.match_verdict,
                "confidence": latest_check.match_confidence,
            },
        ))
        db.commit()

    # Both gates passed — the interview is actually beginning now, so advance the session out
    # of any pre-start state. Without this a session that required HR identity review stayed
    # stuck at identity_pending: for a no_match verdict, right through the live interview once
    # HR cleared it; for verdicts that don't hard-block start (uncertain / liveness fail), all
    # the way to /complete. Either way HR saw a stale identity_pending status the whole time.
    # Idempotent — /start is retried on reload — and can't clobber `completed`, which
    # require_session_token already rejects before this handler runs.
    if session.status in (SessionStatus.scheduled, SessionStatus.identity_pending):
        session.status = SessionStatus.in_progress
        db.add(session)
        db.commit()

    return StartSessionResponse(started=True)


@router.get(
    "/{session_id}/identity-check",
    response_model=IdentityCheckOut,
    dependencies=[Depends(require_hr_auth)],
)
def get_identity_check(session_id: uuid.UUID, db: Session = Depends(get_db)):
    check = (
        db.query(IdentityCheck)
        .filter(IdentityCheck.session_id == session_id)
        .order_by(IdentityCheck.created_at.desc())
        .first()
    )
    if not check:
        raise HTTPException(status_code=404, detail="No identity check found for this session")
    return check


@router.post(
    "/{session_id}/identity-check/override",
    response_model=IdentityCheckOut,
    dependencies=[Depends(require_hr_auth)],
)
def override_identity_check(
    session_id: uuid.UUID,
    payload: IdentityCheckOverrideRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    """Marks a no_match verdict as reviewed (false positive or otherwise handled), removing
    it from the review queue — never auto-clears; only human review of the actual images
    does. /start no longer blocks on this either way (see start_session), so this is now
    about closing out the review queue entry, not unblocking the candidate."""
    check = (
        db.query(IdentityCheck)
        .filter(IdentityCheck.session_id == session_id)
        .order_by(IdentityCheck.created_at.desc())
        .first()
    )
    if not check:
        raise HTTPException(status_code=404, detail="No identity check found for this session")

    check.cleared_by_hr = True
    check.cleared_reason = payload.reason
    db.add(check)

    # Advance the session status to in_progress to clear the stale status in the UI
    session = db.get(InterviewSession, session_id)
    if session and session.status == SessionStatus.identity_pending:
        session.status = SessionStatus.in_progress
        db.add(session)

    db.add(AuditLog(
        interview_session_id=session_id,
        actor=f"hr:{current_hr_user['email']}",
        action="override_identity_check",
        detail={"reason": payload.reason},
    ))

    db.commit()
    db.refresh(check)
    return check


@router.post("/{session_id}/signals")
def ingest_signals(
    events: list[SignalEventIn],
    session: InterviewSession = Depends(require_session_token),
    db: Session = Depends(get_db),
):
    for event in events:
        db.add(SignalEvent(session_id=session.id, **event.model_dump()))
    db.commit()
    return {"ingested": len(events)}


PROBE_TIMEOUT_SECONDS = 15


@router.post("/{session_id}/probe-heartbeat")
def probe_heartbeat(
    session: InterviewSession = Depends(require_session_token), db: Session = Depends(get_db)
):
    session.probe_last_seen_at = datetime.now(timezone.utc)
    db.add(session)
    db.commit()
    return {"ok": True}


def _probe_connected(session: InterviewSession) -> bool:
    return (
        session.probe_last_seen_at is not None
        and (datetime.now(timezone.utc) - session.probe_last_seen_at).total_seconds()
        < PROBE_TIMEOUT_SECONDS
    )


@router.get("/{session_id}/probe-status")
def probe_status(session: InterviewSession = Depends(require_session_token)):
    return {"connected": _probe_connected(session), "last_seen_at": session.probe_last_seen_at}


@router.post("/{session_id}/recording-chunk")
async def upload_recording_chunk(
    chunk: UploadFile,
    session: InterviewSession = Depends(require_session_token),
    db: Session = Depends(get_db),
):
    if session.started_recording_at is None:
        session.started_recording_at = datetime.now(timezone.utc)
    content = await chunk.read()
    relative_path, is_new_segment = storage.append_recording_chunk(
        f"interviews/{session.id}", session.recording_file_path, content
    )
    if is_new_segment and session.recording_file_path:
        session.recording_segment_paths = [
            *(session.recording_segment_paths or []),
            session.recording_file_path,
        ]
    session.recording_file_path = relative_path
    db.add(session)
    db.commit()
    return {"bytes_received": len(content)}


# --- Interviewer-facing (authorized by a separate interviewer token, no login) ---------


@router.get("/interviewer-join/{interviewer_token}", response_model=InterviewerJoinSessionOut)
def get_session_by_interviewer_token(interviewer_token: str, db: Session = Depends(get_db)):
    session = (
        db.query(InterviewSession)
        .filter(InterviewSession.interviewer_join_token == interviewer_token)
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Invalid or expired interviewer link")
    session.ice_servers = video_provider.get_ice_servers()

    # Generate LiveKit token if configured
    room_id = video_provider.get_room_id(session)
    lk_token = generate_livekit_token(room_name=room_id, identity="interviewer", name="Interviewer")
    if lk_token:
        session.livekit_token = lk_token
        session.livekit_url = settings.livekit_url

    return session


@router.post("/{session_id}/interviewer-recording-chunk")
async def upload_interviewer_recording_chunk(
    chunk: UploadFile,
    session: InterviewSession = Depends(require_interviewer_token),
    db: Session = Depends(get_db),
):
    if session.interviewer_started_recording_at is None:
        session.interviewer_started_recording_at = datetime.now(timezone.utc)
    content = await chunk.read()
    relative_path, is_new_segment = storage.append_recording_chunk(
        f"interviews/{session.id}", session.interviewer_recording_file_path, content
    )
    if is_new_segment and session.interviewer_recording_file_path:
        session.interviewer_recording_segment_paths = [
            *(session.interviewer_recording_segment_paths or []),
            session.interviewer_recording_file_path,
        ]
    session.interviewer_recording_file_path = relative_path
    db.add(session)
    db.commit()
    return {"bytes_received": len(content)}


@router.get("/{session_id}/live-signals", response_model=list[SignalEventOut])
def live_signals(
    session: InterviewSession = Depends(require_interviewer_token), db: Session = Depends(get_db)
):
    """Lets the interviewer's page show integrity signals as they happen, not just after the
    fact — polled during the live session. Raw events, not fused flags: fusion only runs once
    at /complete, and the interviewer benefits more from seeing everything as it comes in."""
    return (
        db.query(SignalEvent)
        .filter(SignalEvent.session_id == session.id)
        .order_by(SignalEvent.session_offset_ms)
        .all()
    )


@router.post("/{session_id}/interviewer-decision", response_model=SessionOut)
def submit_interviewer_decision(
    payload: InterviewerDecisionRequest,
    session: InterviewSession = Depends(require_interviewer_token),
    db: Session = Depends(get_db),
):
    """Logs the interviewer's own read of the candidate live, during the call — distinct
    from post-hoc flag review, which only ever reconstructs a session after it's over."""
    session.interviewer_live_decision = payload.decision
    session.interviewer_live_notes = payload.notes
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.post("/{session_id}/sentiment-sample")
async def upload_sentiment_sample(
    background_tasks: BackgroundTasks,
    clip: UploadFile,
    session_offset_ms: int = Form(...),
    session: InterviewSession = Depends(require_session_token),
    db: Session = Depends(get_db),
):
    """A short, independent, fully-closed clip — deliberately NOT a slice of the
    continuously-appended main recording, which isn't safe to read with ffmpeg mid-write
    (unfinalized WebM container). Powers the interviewer's live-sentiment panel and the
    post-call aggregate trend (see sentiment_aggregate.py)."""
    content = await clip.read()
    relative_path = storage.save_file(f"interviews/{session.id}/sentiment", "sample.webm", content)

    sample = SentimentSample(session_id=session.id, session_offset_ms=session_offset_ms)
    db.add(sample)
    db.commit()
    db.refresh(sample)

    background_tasks.add_task(_process_sentiment_sample, sample.id, relative_path)
    return {"accepted": True}


def _process_sentiment_sample(sample_id: uuid.UUID, relative_path: str):
    db = SessionLocal()
    try:
        sample = db.get(SentimentSample, sample_id)
        if not sample:
            return

        try:
            with storage.decrypted_temp_copy(relative_path) as path:
                frame_paths = extract_frames(path, count=1)
                sample.facial_affect = analyze_facial_affect(frame_paths)
        except Exception as exc:  # noqa: BLE001 - best-effort, same pattern as post-call analysis
            logger.warning("Facial affect analysis failed for sample %s: %s", sample_id, exc)
            sample.facial_affect = {"error": str(exc)}

        try:
            with storage.decrypted_temp_copy(relative_path) as path:
                wav_path = extract_audio_wav(path)
                sample.voice_tone = analyze_voice_tone(wav_path)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Voice tone analysis failed for sample %s: %s", sample_id, exc)
            sample.voice_tone = {"error": str(exc)}

        db.add(sample)
        db.commit()
    except Exception:  # noqa: BLE001 - backstop: without this, e.g. db.get() itself
        # throwing left this task dying silently with nothing in server logs at all.
        # There's no status field on SentimentSample to fix up here (unlike
        # InterviewSession.transcript_status below) — a missed sample just stays missing,
        # which the live-sentiment/review UI already tolerates.
        logger.exception("Sentiment sample processing failed for sample %s", sample_id)
    finally:
        db.close()


@router.get("/{session_id}/live-sentiment", response_model=list[SentimentSampleOut])
def live_sentiment(
    session: InterviewSession = Depends(require_interviewer_token), db: Session = Depends(get_db)
):
    return (
        db.query(SentimentSample)
        .filter(SentimentSample.session_id == session.id)
        .order_by(SentimentSample.session_offset_ms.desc())
        .limit(5)
        .all()
    )


@router.post("/{session_id}/live-transcript-chunk")
async def upload_live_transcript_chunk(
    background_tasks: BackgroundTasks,
    clip: UploadFile,
    session_offset_ms: int = Form(...),
    session: InterviewSession = Depends(require_session_token),
):
    """Candidate-side browser-agnostic live transcript: a short, independent clip (a few
    seconds, same "fully-closed clip" shape as sentiment-sample, not a slice of the
    continuously-appended recording) transcribed server-side and appended to the live feed.
    Replaces relying on the browser's own SpeechRecognition API, which only exists in
    Chromium browsers and is known to silently drop results even there — this works
    identically on every browser since it only needs MediaRecorder + fetch."""
    content = await clip.read()
    # Stamped on arrival, not when transcription finishes — see _append_live_transcript_item.
    captured_at = time.monotonic()
    timeline_offset_ms = _live_timeline_offset_ms(str(session.id), captured_at)
    # Keeps whatever container the browser actually produced (Safari records mp4, not webm);
    # mislabelling it .webm leaves the transcription API guessing at the format.
    relative_path = storage.save_file(
        f"interviews/{session.id}/live-transcript", clip.filename or "chunk.webm", content
    )
    background_tasks.add_task(
        _process_live_transcript_chunk,
        str(session.id),
        "candidate",
        relative_path,
        timeline_offset_ms,
        captured_at,
    )
    return {"accepted": True}


@router.post("/{session_id}/interviewer-live-transcript-chunk")
async def upload_interviewer_live_transcript_chunk(
    background_tasks: BackgroundTasks,
    clip: UploadFile,
    session_offset_ms: int = Form(...),
    session: InterviewSession = Depends(require_interviewer_token),
):
    """Interviewer-side counterpart of live-transcript-chunk above."""
    content = await clip.read()
    captured_at = time.monotonic()
    timeline_offset_ms = _live_timeline_offset_ms(str(session.id), captured_at)
    relative_path = storage.save_file(
        f"interviews/{session.id}/live-transcript", clip.filename or "chunk.webm", content
    )
    background_tasks.add_task(
        _process_live_transcript_chunk,
        str(session.id),
        "interviewer",
        relative_path,
        timeline_offset_ms,
        captured_at,
    )
    return {"accepted": True}


def _recent_speaker_context(sid: str, speaker: str, max_chars: int = 400) -> str | None:
    """The tail of what this same speaker last said, to prime the next clip's transcription.

    Same-speaker only: priming with the other participant's words biases the model toward
    putting their phrasing in this speaker's mouth, which is the opposite of what a
    two-column transcript needs.
    """
    previous = [item["text"] for item in _live_transcripts.get(sid, []) if item["speaker"] == speaker]
    if not previous:
        return None
    return " ".join(previous[-2:])[-max_chars:]


def _process_live_transcript_chunk(
    sid: str, speaker: str, relative_path: str, offset_ms: int, sort_key: float | None = None
) -> None:
    """Transcribes one live-transcript clip and appends it to the buffer if it actually
    contains speech, then always deletes the clip itself — unlike sentiment-sample clips
    (kept for facial/voice analysis), only this clip's text has any lasting value, and these
    arrive every few seconds for the whole call, so leaving them on disk isn't free."""
    try:
        with storage.decrypted_temp_copy(relative_path) as path:
            text = transcribe_short_clip(path, prompt=_recent_speaker_context(sid, speaker))
        if text:
            _append_live_transcript_item(sid, speaker, text, offset_ms, sort_key=sort_key)
    except Exception:  # noqa: BLE001 - best-effort; a missed chunk just doesn't appear live,
        # same as a dropped browser SpeechRecognition result would have.
        logger.exception("Live transcript chunk transcription failed for session %s", sid)
    finally:
        with contextlib.suppress(OSError):
            os.remove(storage.absolute_path(relative_path))


# --- Post-interview processing (background) ---------------------------------------------


def _process_recordings_and_save(session_id: uuid.UUID):
    """Runs after the HTTP response is sent — needs its own DB session since the
    request-scoped one is already closed by then. Transcribes both sides (if the
    interviewer recorded), merges them onto one timeline, then runs Q&A verification and
    voice-tone analysis. Best-effort at each step — failing one shouldn't block the rest.

    Transcription runs against the extracted audio-only WAV, not the raw video+audio
    recording — Whisper hard-rejects anything over 25MB (413), and a video+audio webm
    hits that ceiling on any interview of real length; audio alone buys a lot more
    headroom (transcription.py chunks further if even that still exceeds the limit). The
    same extracted WAV is reused for voice-tone analysis below rather than re-extracted."""
    db = SessionLocal()
    candidate_wav_path: str | None = None
    interviewer_wav_path: str | None = None
    session: InterviewSession | None = None
    try:
        session = db.get(InterviewSession, session_id)
        if not session:
            return

        # Both moved here from POST /complete's request handler — confirmed ~5s of blocking
        # time for two 300MB recordings when done synchronously there, which bought nothing
        # (HR never opens the review page within seconds of the call ending) while making
        # the candidate's browser sit on the "Finish interview" click for it.
        #
        # If the candidate's browser reconnected mid-call, append_recording_chunk (see
        # storage.py) will have rolled the file at that point into *_segment_paths rather
        # than corrupting it, leaving several valid-on-their-own segments instead of one
        # complete recording. Stitch them back into a single file now, before encrypting —
        # best-effort: on failure, fall back to just the last segment (still a real,
        # playable file, just missing the earlier part of the call) rather than aborting
        # the rest of this task, and leave a record of it for HR/support.
        for path_attr, segments_attr in (
            ("recording_file_path", "recording_segment_paths"),
            ("interviewer_recording_file_path", "interviewer_recording_segment_paths"),
        ):
            segments = getattr(session, segments_attr) or []
            current_path = getattr(session, path_attr)
            if not (segments and current_path):
                continue
            try:
                merged_path = storage.concat_segments(
                    [*segments, current_path], f"interviews/{session.id}"
                )
                setattr(session, path_attr, merged_path)
                setattr(session, segments_attr, [])
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Recording segment merge failed for session %s (%s): %s",
                    session.id, path_attr, exc,
                )
                db.add(AuditLog(
                    interview_session_id=session.id,
                    actor="system",
                    action="recording_segments_merge_failed",
                    detail={"path_attr": path_attr, "segments": segments, "error": str(exc)},
                ))

        # Repair unfinalized/corrupted WebM chunks using ffmpeg prior to encryption
        _repair_webm_container(session.recording_file_path)
        if session.interviewer_recording_file_path:
            _repair_webm_container(session.interviewer_recording_file_path)

        # Encrypted here, once, now that the file is finished growing — append_file_chunk
        # can't encrypt incrementally (see storage.py). decrypted_temp_copy below decrypts
        # to a temp copy on demand for ffmpeg/whisper.
        session.recording_file_path = storage.finalize_encrypt(session.recording_file_path)
        session.interviewer_recording_file_path = storage.finalize_encrypt(
            session.interviewer_recording_file_path
        )
        db.add(session)
        db.commit()

        candidate_segments: list[dict] = []
        try:
            with storage.decrypted_temp_copy(session.recording_file_path) as path:
                candidate_wav_path = extract_audio_wav(path)
            text, segments = transcribe_with_segments(candidate_wav_path)
            session.transcript = text
            session.transcript_status = "done"
            candidate_segments = segments

            # Voiceprint Match Check
            identity_check = (
                db.query(IdentityCheck)
                .filter(IdentityCheck.session_id == session.id)
                .order_by(IdentityCheck.created_at.desc())
                .first()
            )
            if identity_check and identity_check.voice_enrollment_path and candidate_wav_path:
                try:
                    from app.services.voice_verification import verify_voice_match
                    voice_result = verify_voice_match(identity_check.voice_enrollment_path, candidate_wav_path)
                    if not voice_result.get("match", True):
                        db.add(SignalEvent(
                            session_id=session.id,
                            signal_type=SignalType.voice_mismatch,
                            session_offset_ms=10000,
                            weight=9,
                            meta={"confidence": voice_result.get("confidence"), "reason": voice_result.get("reason")}
                        ))
                        db.commit()

                        # Recompute integrity scores and flags
                        events = db.query(SignalEvent).filter(SignalEvent.session_id == session.id).all()
                        db.query(IntegrityFlag).filter(IntegrityFlag.session_id == session.id).delete()
                        flags = integrity.fuse_signals(events)
                        for flag in flags:
                            db.add(IntegrityFlag(session_id=session.id, **flag))
                        score, needs_review = integrity.compute_integrity_score(flags)
                        session.integrity_score = score
                        session.integrity_needs_review = needs_review
                except Exception as exc:
                    print(f"[post-processing] Voice verification failed: {exc}")
        except Exception as exc:  # noqa: BLE001 - surfaced on the review page, not silently dropped
            logger.warning("Candidate transcription failed for session %s: %s", session.id, exc)
            session.transcript = f"Transcription failed: {exc}"
            session.transcript_status = "failed"

        interviewer_segments: list[dict] = []
        if session.interviewer_recording_file_path:
            try:
                with storage.decrypted_temp_copy(session.interviewer_recording_file_path) as path:
                    interviewer_wav_path = extract_audio_wav(path)
                text, segments = transcribe_with_segments(interviewer_wav_path)
                session.interviewer_transcript = text
                session.interviewer_transcript_status = "done"
                interviewer_segments = segments
            except Exception as exc:  # noqa: BLE001
                logger.warning("Interviewer transcription failed for session %s: %s", session.id, exc)
                session.interviewer_transcript = f"Transcription failed: {exc}"
                session.interviewer_transcript_status = "failed"

        # Q&A verification is the one post-processing step that genuinely needs the transcript
        # TEXT, so it stays gated on a successful transcription.
        if session.transcript_status == "done":
            try:
                session.merged_transcript = merge_transcripts(
                    candidate_segments,
                    session.started_recording_at,
                    interviewer_segments,
                    session.interviewer_started_recording_at,
                )
                session.qa_analysis = analyze_qa(session.merged_transcript or session.transcript)
            except Exception as exc:  # noqa: BLE001 - best-effort, not core status
                logger.warning("Q&A analysis failed for session %s: %s", session.id, exc)
                session.qa_analysis = {"error": str(exc)}

        # Voice-tone and facial-affect analysis do NOT depend on the transcript text — voice
        # tone reads only the extracted audio WAV, and facial affect reads video frames
        # straight from the recording. They used to run inside the transcript-done branch
        # above, so any transcription failure (e.g. Whisper rejecting an oversized file)
        # silently discarded two unrelated signals the reviewer relies on. Run them
        # independently so each degrades on its own actual failure, not on transcription's.
        try:
            if not candidate_wav_path:
                raise RuntimeError("No extracted audio available (audio extraction failed earlier)")
            session.voice_tone_analysis = analyze_voice_tone(candidate_wav_path)
        except Exception as exc:  # noqa: BLE001 - best-effort, not core status
            logger.warning("Voice tone analysis failed for session %s: %s", session.id, exc)
            session.voice_tone_analysis = {"error": str(exc)}

        try:
            with storage.decrypted_temp_copy(session.recording_file_path) as path:
                frame_paths = extract_frames(path)
                session.facial_affect_analysis = analyze_facial_affect(frame_paths)
        except Exception as exc:  # noqa: BLE001 - best-effort, not core status
            logger.warning("Facial affect analysis failed for session %s: %s", session.id, exc)
            session.facial_affect_analysis = {"error": str(exc)}

        db.add(session)
        db.commit()
    except Exception as exc:  # noqa: BLE001 - last-resort backstop: without this, anything
        # not already caught above (finalize_encrypt itself throwing, db.commit() failing,
        # db.get() throwing before `session` is even assigned, ...) left transcript_status
        # stuck at "pending" forever with nothing in server logs to explain why — the
        # review page polls every 4s while it's "pending" with no timeout, so HR would
        # just see it hang indefinitely. This turns that into a visible, terminal
        # "failed" instead, logged here (see core/logging.py) rather than only ever
        # existing as whatever happened to be in a developer's terminal at the time.
        logger.exception("Post-interview processing failed for session %s", session_id)
        if session is not None and session.transcript_status == "pending":
            try:
                session.transcript = f"Processing failed: {exc}"
                session.transcript_status = "failed"
                db.add(session)
                db.commit()
            except Exception:  # noqa: BLE001 - the DB itself may be what's actually down
                logger.exception(
                    "Also failed to record the processing failure for session %s", session_id
                )
    finally:
        for wav_path in (candidate_wav_path, interviewer_wav_path):
            if wav_path:
                with contextlib.suppress(OSError):
                    os.remove(wav_path)
        db.close()


def _repair_webm_container(relative_path: str) -> None:
    """Invokes ffmpeg with -c copy to re-index the WebM container and repair missing cues
    or metadata headers caused by abrupt stream terminations / interrupted recordings."""
    full_path = storage.absolute_path(relative_path)
    if not os.path.exists(full_path):
        return

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        temp_out = tmp.name

    try:
        subprocess.run(
            ["ffmpeg", "-y", "-err_detect", "ignore_err", "-i", full_path, "-c", "copy", temp_out],
            check=True,
            capture_output=True,
        )
        shutil.move(temp_out, full_path)
    except Exception as exc:
        print(f"[storage] could not repair WebM container {relative_path}: {exc}")
        if os.path.exists(temp_out):
            with contextlib.suppress(OSError):
                os.remove(temp_out)


@router.post("/{session_id}/complete", response_model=SessionOut)
def complete_session(
    background_tasks: BackgroundTasks,
    session: InterviewSession = Depends(require_session_token),
    db: Session = Depends(get_db),
):
    events = db.query(SignalEvent).filter(SignalEvent.session_id == session.id).all()
    flags = integrity.fuse_signals(events)

    for flag in flags:
        db.add(IntegrityFlag(session_id=session.id, **flag))

    score, needs_review = integrity.compute_integrity_score(flags)
    session.integrity_score = score
    session.integrity_needs_review = needs_review
    session.status = SessionStatus.completed
    session.completed_at = datetime.now(timezone.utc)

    samples = db.query(SentimentSample).filter(SentimentSample.session_id == session.id).all()
    if samples:
        session.sentiment_trend = sentiment_aggregate.aggregate_sentiment(samples)

    if session.recording_file_path:
        session.transcript_status = "pending"
        # Segment merging, WebM repair, and at-rest encryption all happen inside the
        # background task now, not here — encrypting two 300MB recordings synchronously
        # in this handler measured at ~5s of dead time the candidate's browser sat
        # waiting on for the "Finish interview" click to resolve.
        background_tasks.add_task(_process_recordings_and_save, session.id)

    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def _live_timeline_offset_ms(sid: str, captured_at: float | None = None) -> int:
    """Position on this session's single shared live-transcript timeline, in ms.

    Anchored to the first live chunk seen for the session and measured server-side, so the
    candidate's and interviewer's lines are directly comparable — unlike the per-browser
    offsets the clients report, which are measured from each participant's own join click.
    """
    epoch = _live_transcript_epoch.setdefault(sid, time.monotonic())
    return max(0, int(((captured_at if captured_at is not None else time.monotonic()) - epoch) * 1000))


def _append_live_transcript_item(
    sid: str, speaker: str, text: str, offset_ms: int, sort_key: float | None = None
) -> dict:
    """Shared by the manual-entry endpoint below and the chunked-transcription background
    task further down — one place owns the in-memory buffer's shape and trim policy.

    Kept sorted by when the audio was *captured*, not when its transcription happened to
    come back: the two speakers are transcribed by concurrent background tasks whose
    round-trips differ by seconds, so appending in completion order visibly scrambles the
    conversation (a reply showing up above the question it answers).
    """
    if sid not in _live_transcripts:
        _live_transcripts[sid] = []

    item = {
        "id": f"{uuid.uuid4().hex[:8]}",
        "speaker": speaker,
        "text": text.strip(),
        "offset_ms": offset_ms,
        "timestamp": datetime.now(timezone.utc).strftime("%H:%M:%S"),
        "_sort_key": sort_key if sort_key is not None else float(offset_ms),
    }
    items = _live_transcripts[sid]
    items.append(item)
    items.sort(key=lambda entry: entry["_sort_key"])
    if len(items) > 250:
        del items[: len(items) - 250]
    return item


@router.post("/{session_id}/live-transcript")
def push_live_transcript(
    session_id: uuid.UUID,
    payload: LiveTranscriptIn,
    db: Session = Depends(get_db),
):
    """Buffers live streaming speech utterances in real time for interviewer display."""
    sid = str(session_id)
    now = time.monotonic()
    # Placed on the same server-side timeline as transcribed chunks rather than trusting the
    # caller's own offset, so a typed utterance slots into the conversation in the right
    # place instead of jumping to the top or bottom of the feed.
    item = _append_live_transcript_item(
        sid, payload.speaker, payload.text, _live_timeline_offset_ms(sid, now), sort_key=now
    )
    return {"status": "ok", "item": item}


@router.get("/{session_id}/live-transcripts", response_model=list[LiveTranscriptOut])
def get_live_transcripts(
    session_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    """Returns recent live real-time transcript utterances for the interviewer panel."""
    sid = str(session_id)
    return _live_transcripts.get(sid, [])


@router.get("/{session_id}/consolidated-report")
def get_consolidated_report(
    session_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    """Returns the consolidated scorecard and evaluation report."""
    try:
        return build_consolidated_report(db, session_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{session_id}/send-report")
def trigger_send_consolidated_report(
    session_id: uuid.UUID,
    payload: SendConsolidatedReportRequest,
    db: Session = Depends(get_db),
):
    """Dispatches the consolidated scorecard and PDF report to the interviewer."""
    recipient = payload.recipient_email or "interviewer@company.com"
    try:
        return send_consolidated_report(db, session_id, recipient)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{session_id}/consolidated-report/pdf")
def download_consolidated_report_pdf(
    session_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    """Downloads the consolidated interview evaluation PDF."""
    try:
        report = build_consolidated_report(db, session_id)
        pdf_bytes = build_consolidated_report_pdf(report)
        return StreamingResponse(
            io.BytesIO(pdf_bytes),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="evaluation_{session_id}.pdf"'},
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{session_id}/suggested-questions")
def get_suggested_interview_questions(
    session_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    """Generates or returns cached AI-suggested questions tailored to the candidate and job."""
    sid = str(session_id)
    if sid in _session_questions_cache and _session_questions_cache[sid]:
        return _session_questions_cache[sid]

    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found")

    job = db.get(Job, session.job_id) if session.job_id else None
    candidate = db.get(Candidate, session.candidate_id) if session.candidate_id else None

    job_title = job.title if job else "Technical Specialist"
    jd_text = job.jd_text if job else "Standard technical requirements"
    skills = job.required_skills if job else []
    profile = candidate.parsed_profile if candidate else None

    questions = generate_suggested_questions(
        job_title=job_title,
        jd_text=jd_text,
        required_skills=skills,
        candidate_profile=profile,
        candidate_name=session.candidate_name,
    )
    _session_questions_cache[sid] = questions
    return questions


@router.post("/{session_id}/evaluate-live-answer")
def evaluate_candidate_live_answer(
    session_id: uuid.UUID,
    payload: EvaluateLiveAnswerRequest,
    db: Session = Depends(get_db),
):
    """Evaluates candidate spoken answer against the active question in real time."""
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found")

    job = db.get(Job, session.job_id) if session.job_id else None
    job_context = f"{job.title} ({', '.join(job.required_skills)})" if job else "Technical Role"

    evaluation = evaluate_live_answer(
        question_text=payload.question_text,
        expected_concepts=payload.expected_concepts,
        candidate_transcript=payload.candidate_transcript,
        job_context=job_context,
    )
    return evaluation


@router.post("/{session_id}/rate-question-answer")
def rate_question_answer(
    session_id: uuid.UUID,
    payload: RateQuestionAnswerRequest,
    db: Session = Depends(get_db),
):
    """Stores the interviewer's then-and-there rating and accuracy assessment for an individual question."""
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found")

    existing_evals = list(session.qa_evaluations or [])
    # Check if this question was already rated, update or append
    updated = False
    record = {
        "question_id": payload.question_id,
        "question_text": payload.question_text,
        "rating": payload.rating,
        "accuracy_score": payload.accuracy_score,
        "notes": payload.notes,
        "concepts_covered": payload.concepts_covered,
        "concepts_missing": payload.concepts_missing,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    for idx, item in enumerate(existing_evals):
        if item.get("question_id") == payload.question_id:
            existing_evals[idx] = record
            updated = True
            break
    if not updated:
        existing_evals.append(record)

    session.qa_evaluations = existing_evals
    db.add(session)
    db.commit()
    db.refresh(session)
    return {"status": "ok", "qa_evaluations": session.qa_evaluations}


@router.get("/{session_id}/qa-evaluations")
def get_qa_evaluations(
    session_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    """Returns recorded question evaluations and accuracy scores."""
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found")
    return session.qa_evaluations or []
