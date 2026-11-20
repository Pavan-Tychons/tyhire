import enum
import uuid

from sqlalchemy import (
    Column, String, Text, Enum, JSON, DateTime, Float, Integer, ForeignKey, Boolean, func
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class SessionStatus(str, enum.Enum):
    scheduled = "scheduled"
    identity_pending = "identity_pending"
    in_progress = "in_progress"
    completed = "completed"


class InterviewSession(Base):
    __tablename__ = "interview_sessions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    candidate_id = Column(
        UUID(as_uuid=True), ForeignKey("candidates.id", ondelete="SET NULL"), nullable=True
    )
    candidate_name = Column(String, nullable=False)
    job_id = Column(UUID(as_uuid=True), ForeignKey("jobs.id"), nullable=True)
    # Free-text role title captured at scheduling (TYH-020). Used to tailor AI-suggested
    # interview questions when the session isn't linked to a full Job record.
    job_title = Column(String, nullable=True)

    join_token = Column(String, unique=True, nullable=False)
    status = Column(Enum(SessionStatus), nullable=False, default=SessionStatus.scheduled)

    # A THIRD secret, deliberately shared identically to both candidate and interviewer (via
    # SessionOut, returned regardless of which token was used to fetch it) — used only to
    # name the live-video room. join_token/interviewer_join_token are role-specific and must
    # never overlap, so neither can double as this; using the raw session id instead would
    # let anyone who ever saw that id (visible in API responses/network tabs) join the video
    # call with no token at all, undoing the access-control work done on the API side.
    video_room_token = Column(String, unique=True, nullable=False)

    recording_file_path = Column(String, nullable=True)
    # Completed segments left behind when the candidate's browser starts a brand new
    # MediaRecorder mid-session (reload/reconnect after a drop) — a fresh recorder's first
    # chunk carries its own WebM header, so blindly appending it onto recording_file_path
    # would embed a second independent container inside one file, unreadable past the
    # first by ffmpeg/Whisper/a <video> tag. append_recording_chunk (storage.py) detects
    # that and rolls the current file in here instead; /complete's handler stitches
    # everything back into one file via storage.concat_segments before encrypting it.
    recording_segment_paths = Column(JSON, nullable=False, default=list)
    transcript = Column(Text, nullable=True)
    transcript_status = Column(String, nullable=True)  # "pending" | "done" | "failed"
    started_recording_at = Column(DateTime(timezone=True), nullable=True)

    # Companion capture: the interviewer gets a second, separate link/token so their side
    # of the conversation can be recorded too — without it, only the candidate's mic is
    # ever captured, which makes real Q&A cross-verification unreliable (see qa_analysis).
    interviewer_join_token = Column(String, unique=True, nullable=True)
    interviewer_recording_file_path = Column(String, nullable=True)
    # Same segment-rollover tracking as recording_segment_paths, for the interviewer's own
    # (audio-only) recording.
    interviewer_recording_segment_paths = Column(JSON, nullable=False, default=list)
    interviewer_transcript = Column(Text, nullable=True)
    interviewer_transcript_status = Column(String, nullable=True)
    interviewer_started_recording_at = Column(DateTime(timezone=True), nullable=True)

    merged_transcript = Column(Text, nullable=True)
    qa_analysis = Column(JSON, nullable=True)
    voice_tone_analysis = Column(JSON, nullable=True)
    facial_affect_analysis = Column(JSON, nullable=True)

    # Aggregate across every periodic SentimentSample taken during the live call — a trend,
    # not a single post-hoc snapshot. Computed at /complete (see api/v1/interviews.py).
    sentiment_trend = Column(JSON, nullable=True)

    integrity_score = Column(Float, nullable=True)
    integrity_needs_review = Column(Boolean, default=False)

    # Updated whenever the desktop probe checks in — lets the candidate page confirm the
    # background-app/display monitor is actually running before the interview can start.
    probe_last_seen_at = Column(DateTime(timezone=True), nullable=True)

    # Captured once at identity-check time (not per-request — location shouldn't change
    # mid-call) and compared against the candidate's stated resume location for a soft
    # location_mismatch signal. Approximate by nature (VPNs/mobile carriers/NAT) — never a
    # hard rule, same as every other fused signal.
    candidate_ip = Column(String, nullable=True)

    # The interviewer's own in-call read, logged live rather than only reconstructed after
    # the fact from post-hoc flag reviews.
    interviewer_live_decision = Column(String, nullable=True)  # "proceed" | "concern" | "reject"
    interviewer_live_notes = Column(Text, nullable=True)

    # Per-question GPT evaluations, accuracy scores, and interviewer "then & there" ratings
    qa_evaluations = Column(JSON, nullable=False, default=list)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)


class IdentityCheck(Base):
    __tablename__ = "identity_checks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("interview_sessions.id"), nullable=False)

    # Nullable despite always being set initially — POST /interviews/cleanup-expired-media
    # clears these to None past the retention window while keeping the verdict/confidence.
    id_document_path = Column(String, nullable=True)
    selfie_path = Column(String, nullable=True)
    voice_enrollment_path = Column(String, nullable=True)
    liveness_prompt = Column(String, nullable=True)  # e.g. "blink" | "turn_head"
    liveness_passed = Column(Boolean, nullable=True)

    match_confidence = Column(Float, nullable=True)  # 0-1
    match_verdict = Column(String, nullable=True)  # "match" | "no_match" | "uncertain"
    needs_human_review = Column(Boolean, default=True)

    # A "no_match" verdict hard-blocks POST /interviews/{id}/start (see api/v1/interviews.py)
    # unless an HR reviewer clears it here as a false positive (bad lighting/angle, not fraud).
    cleared_by_hr = Column(Boolean, default=False)
    cleared_reason = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SignalType(str, enum.Enum):
    tab_switch = "tab_switch"
    window_blur = "window_blur"
    copy_paste = "copy_paste"
    second_face = "second_face"
    second_voice = "second_voice"
    voice_mismatch = "voice_mismatch"
    gaze_off_screen = "gaze_off_screen"
    excessive_motion = "excessive_motion"
    virtual_camera = "virtual_camera"
    response_timing_anomaly = "response_timing_anomaly"
    unauthorized_app_detected = "unauthorized_app_detected"
    external_display_detected = "external_display_detected"
    fullscreen_exit = "fullscreen_exit"
    devtools_open = "devtools_open"
    screen_share_partial = "screen_share_partial"
    screen_share_stopped = "screen_share_stopped"
    # Recorded once, at the end, when the candidate never shared their screen at all.
    # Screen sharing used to be mandatory before joining, so a reviewer could assume every
    # interview had one; now that it is optional and requested on demand, its absence is
    # worth showing on the timeline as context. Deliberately low-weight and listed in
    # LOW_SIGNAL_ALONE (services/integrity.py) — not sharing is a normal choice, and this
    # must never flag a session on its own.
    screen_share_never = "screen_share_never"
    location_mismatch = "location_mismatch"
    # DOM-signature heuristic (lib/extensionDetection.ts) for AI answer-helper browser
    # extensions (Monica AI, Sider, Merlin, and similar ChatGPT-sidebar-style tools)
    # injecting their own elements into the page during the interview.
    ai_extension_detected = "ai_extension_detected"
    # Teleprompter / script-reading saccade eye scanning detection
    teleprompter_reading = "teleprompter_reading"
    # The page's own visibility/focus reporting has been replaced (lib/extensionDetection.ts
    # detectProctoringTamper) — how anti-blur and "tab focus faker" extensions suppress the
    # tab_switch / window_blur / fullscreen_exit signals. Weighted heavily: unlike a glance
    # off-screen this has no innocent explanation, and its purpose is to blind the other
    # checks, so the absence of those signals afterwards means nothing.
    proctoring_tamper_detected = "proctoring_tamper_detected"
    # Iris-level gaze (frontend lib/gazeEstimation.ts): the eyes held below the screen line
    # for several seconds at a stretch, which is the posture of reading something on the
    # desk, in the lap, or on a phone. Distinct from gaze_off_screen, which now covers any
    # direction and fires on brief glances too.
    #
    # Listed in LOW_SIGNAL_ALONE (services/integrity.py): reading paper notes looks exactly
    # the same to a camera, so this must never flag a session by itself. It earns its place
    # by being surfaced live to the interviewer, who can see the context the model cannot
    # and simply ask what the candidate is looking at.
    sustained_downward_gaze = "sustained_downward_gaze"


class SignalEvent(Base):
    __tablename__ = "signal_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("interview_sessions.id"), nullable=False)

    signal_type = Column(Enum(SignalType), nullable=False)
    session_offset_ms = Column(Integer, nullable=False)  # ms since session start, for timeline linking
    weight = Column(Float, default=1.0)
    meta = Column(JSON, default=dict)

    created_at = Column(DateTime(timezone=True), server_default=func.now())


class IntegrityFlag(Base):
    """A fused, human-reviewable moment derived from clustered signal events."""

    __tablename__ = "integrity_flags"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("interview_sessions.id"), nullable=False)

    session_offset_ms = Column(Integer, nullable=False)
    severity = Column(Float, nullable=False)  # contribution to integrity score
    summary = Column(String, nullable=False)  # e.g. "Second face + gaze-off-screen for 8s"
    contributing_signal_ids = Column(JSON, default=list)

    reviewed = Column(Boolean, default=False)
    reviewer_decision = Column(String, nullable=True)  # "cleared" | "confirmed_issue"
    reviewer_note = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SentimentSample(Base):
    """One periodic facial/voice reading from a short, independent, fully-closed clip
    uploaded during the live call — see POST /interviews/{id}/sentiment-sample. Deliberately
    never sampled from the continuously-appended main recording file, which isn't safe to
    read with ffmpeg mid-write (see plan doc, Phase 3.1)."""

    __tablename__ = "sentiment_samples"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("interview_sessions.id"), nullable=False)

    session_offset_ms = Column(Integer, nullable=False)
    facial_affect = Column(JSON, nullable=True)
    voice_tone = Column(JSON, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
