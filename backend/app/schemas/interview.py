import uuid
from typing import Optional, Any

from pydantic import BaseModel, Field

from app.models.interview import SessionStatus, SignalType


class SessionCreate(BaseModel):
    candidate_name: str
    job_title: Optional[str] = None
    job_id: Optional[uuid.UUID] = None
    candidate_id: Optional[uuid.UUID] = None


class SessionOut(BaseModel):
    id: uuid.UUID
    candidate_name: str
    job_title: Optional[str] = None
    job_id: Optional[uuid.UUID]
    join_token: str
    video_room_token: str
    status: SessionStatus
    integrity_score: Optional[float]
    integrity_needs_review: bool
    recording_file_path: Optional[str] = None
    transcript: Optional[str] = None
    transcript_status: Optional[str] = None
    interviewer_join_token: Optional[str] = None
    interviewer_recording_file_path: Optional[str] = None
    interviewer_transcript: Optional[str] = None
    interviewer_transcript_status: Optional[str] = None
    merged_transcript: Optional[str] = None
    qa_analysis: Optional[dict[str, Any]] = None
    voice_tone_analysis: Optional[dict[str, Any]] = None
    facial_affect_analysis: Optional[dict[str, Any]] = None
    sentiment_trend: Optional[dict[str, Any]] = None
    candidate_ip: Optional[str] = None
    interviewer_live_decision: Optional[str] = None
    interviewer_live_notes: Optional[str] = None
    # Populated only by the candidate/interviewer token-lookup endpoints (freshly minted
    # per fetch, never stored) — absent everywhere else, including every HR-facing
    # endpoint, since HR never joins the call itself. See services/video_provider.py.
    ice_servers: Optional[list[dict]] = None
    livekit_token: Optional[str] = None
    livekit_url: Optional[str] = None

    class Config:
        from_attributes = True


class CandidateJoinSessionOut(BaseModel):
    """Response for GET /join/{token} — deliberately excludes interviewer_join_token
    (the other role's secret), video_room_token (server-internal only, never read by the
    frontend), and every transcript/analysis/recording/PII field that SessionOut carries
    for HR views. A candidate holding only their own join_token must not be able to see
    or derive any of that."""

    id: uuid.UUID
    job_id: Optional[uuid.UUID]
    candidate_name: str
    status: SessionStatus
    join_token: str
    ice_servers: Optional[list[dict]] = None
    livekit_token: Optional[str] = None
    livekit_url: Optional[str] = None

    class Config:
        from_attributes = True


class InterviewerJoinSessionOut(BaseModel):
    """Response for GET /interviewer-join/{token} — mirrors CandidateJoinSessionOut's
    restriction in the other direction: excludes join_token (the candidate's secret) and
    all transcript/analysis/recording/PII fields."""

    id: uuid.UUID
    job_id: Optional[uuid.UUID]
    candidate_name: str
    status: SessionStatus
    interviewer_join_token: str
    ice_servers: Optional[list[dict]] = None
    livekit_token: Optional[str] = None
    livekit_url: Optional[str] = None

    class Config:
        from_attributes = True


class IdentityCheckOut(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID
    liveness_prompt: Optional[str]
    liveness_passed: Optional[bool]
    match_confidence: Optional[float]
    match_verdict: Optional[str]
    needs_human_review: bool
    cleared_by_hr: bool
    cleared_reason: Optional[str]
    voice_enrollment_path: Optional[str] = None

    class Config:
        from_attributes = True


class IdentityCheckOverrideRequest(BaseModel):
    reason: str


class InterviewerDecisionRequest(BaseModel):
    decision: str  # "proceed" | "concern" | "reject"
    notes: Optional[str] = None


class StartSessionResponse(BaseModel):
    started: bool


class SentimentSampleOut(BaseModel):
    session_offset_ms: int
    facial_affect: Optional[dict[str, Any]] = None
    voice_tone: Optional[dict[str, Any]] = None

    class Config:
        from_attributes = True


class SignalEventIn(BaseModel):
    signal_type: SignalType
    session_offset_ms: int
    # Client-supplied (candidate-facing POST /signals) and fed straight into
    # integrity.fuse_signals' severity sum with no other gate in between — without a
    # bound here, a crafted request (e.g. weight=-99999) could swing the integrity score
    # wildly in either direction. 10.0 gives headroom above the highest weight the backend
    # itself ever assigns (5, for location_mismatch — see api/v1/interviews.py) without
    # letting a single event dominate a cluster's severity outright.
    weight: float = Field(default=1.0, ge=0.0, le=10.0)
    meta: dict[str, Any] = {}


class SignalEventOut(BaseModel):
    signal_type: SignalType
    session_offset_ms: int
    meta: dict[str, Any]

    class Config:
        from_attributes = True


class IntegrityFlagOut(BaseModel):
    id: uuid.UUID
    session_offset_ms: int
    severity: float
    summary: str
    reviewed: bool
    reviewer_decision: Optional[str]
    reviewer_note: Optional[str]

    class Config:
        from_attributes = True


class ReviewDecision(BaseModel):
    decision: str  # "cleared" | "confirmed_issue"
    note: Optional[str] = None


class LiveTranscriptIn(BaseModel):
    speaker: str  # "candidate" | "interviewer"
    text: str
    offset_ms: int = 0


class LiveTranscriptOut(BaseModel):
    id: str
    speaker: str
    text: str
    offset_ms: int
    timestamp: str


class SendConsolidatedReportRequest(BaseModel):
    recipient_email: Optional[str] = None


class EvaluateLiveAnswerRequest(BaseModel):
    question_id: str
    question_text: str
    expected_concepts: list[str] = []
    candidate_transcript: str


class RateQuestionAnswerRequest(BaseModel):
    question_id: str
    question_text: str
    rating: str  # "strong_pass" | "needs_followup" | "inaccurate_scripted"
    accuracy_score: Optional[float] = None
    notes: Optional[str] = None
    concepts_covered: list[str] = []
    concepts_missing: list[str] = []


