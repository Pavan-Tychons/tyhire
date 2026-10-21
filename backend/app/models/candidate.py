import enum
import uuid

from sqlalchemy import Column, String, Text, Enum, JSON, DateTime, Float, ForeignKey, Boolean, Integer, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class Bucket(str, enum.Enum):
    approved = "approved"
    review = "review"
    declined = "declined"


class Candidate(Base):
    __tablename__ = "candidates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id = Column(UUID(as_uuid=True), ForeignKey("jobs.id"), nullable=False)

    resume_file_path = Column(String, nullable=False)
    full_name = Column(String, nullable=True)
    email = Column(String, nullable=True)
    phone = Column(String, nullable=True)

    # Structured resume profile extracted by the parser
    parsed_profile = Column(JSON, nullable=True)

    # Screening-call knockout inputs a resume rarely states outright — populated either from
    # the parser (if the resume happens to mention them) or manually by HR afterwards via
    # POST /candidates/{id}/screening-details, then re-checked against the job's knockout rules.
    notice_period_days = Column(Integer, nullable=True)
    expected_salary = Column(Integer, nullable=True)

    # True if text extraction came back empty and the resume was OCR'd from page images
    # instead — flagged because OCR is less reliable than native text extraction.
    ocr_fallback_used = Column(Boolean, default=False)

    is_duplicate_of = Column(
        UUID(as_uuid=True), ForeignKey("candidates.id", ondelete="SET NULL"), nullable=True
    )

    # Knockout outcome
    knockout_failed = Column(Boolean, default=False)
    knockout_reasons = Column(JSON, default=list)

    # Set when parsing/scoring throws (bad file, API error, etc.) — kept distinct from
    # knockout_failed so a processing failure never gets mistaken for "candidate doesn't fit"
    # and, critically, never just silently has no bucket and vanishes from every view.
    processing_failed = Column(Boolean, default=False)
    processing_error = Column(Text, nullable=True)

    # AI fit score — score_breakdown holds the per-category sub-scores/reasons the
    # deterministic `fit_score` is computed from (see services/scoring.py); score_reasons
    # is kept as a flattened view across all categories for backward-compatible display.
    fit_score = Column(Float, nullable=True)
    technical_score = Column(Float, nullable=True)
    communication_score = Column(Float, nullable=True)
    score_reasons = Column(JSON, default=list)
    score_breakdown = Column(JSON, nullable=True)
    skills_breakdown = Column(JSON, nullable=True)
    profession_fit = Column(JSON, nullable=True)
    campus_metadata = Column(JSON, nullable=True)
    # Experience measured from the work-history dates, plus any employment gaps — see
    # services/experience.py. Stored rather than recomputed on read so the figure HR saw
    # when they made a decision is the figure on the record.
    experience_analysis = Column(JSON, nullable=True)

    # HR-entered adjustment on top of the AI score (e.g. a competing offer, a referral signal)
    # — always shown separately from the AI sub-scores, never silently folded into them.
    manual_score_adjustment = Column(Integer, nullable=True)
    manual_adjustment_reason = Column(Text, nullable=True)

    bucket = Column(Enum(Bucket), nullable=True)

    # HR override
    override_bucket = Column(Enum(Bucket), nullable=True)
    override_reason = Column(Text, nullable=True)

    # Who uploaded this candidate and from where — for traceability across HR users/sources.
    uploaded_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    source = Column(String, nullable=True)

    # HR archive — removes the candidate from the active board without deleting the
    # record, so the AI score/decision stays available for audit even if it was wrong.
    archived = Column(Boolean, default=False)
    archived_reason = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    job = relationship("Job")
    uploader = relationship("User")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    candidate_id = Column(
        UUID(as_uuid=True), ForeignKey("candidates.id", ondelete="SET NULL"), nullable=True
    )
    interview_session_id = Column(UUID(as_uuid=True), ForeignKey("interview_sessions.id"), nullable=True)
    actor = Column(String, nullable=False)  # "system" | "hr:<user>"
    action = Column(String, nullable=False)
    detail = Column(JSON, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
