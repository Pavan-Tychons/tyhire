import uuid
from typing import Optional, Any

from pydantic import BaseModel, Field

from app.models.candidate import Bucket


class CandidateOut(BaseModel):
    id: uuid.UUID
    job_id: uuid.UUID
    full_name: Optional[str]
    email: Optional[str]
    phone: Optional[str]
    parsed_profile: Optional[dict[str, Any]]
    notice_period_days: Optional[int]
    expected_salary: Optional[int]
    ocr_fallback_used: bool
    is_duplicate_of: Optional[uuid.UUID]
    knockout_failed: bool
    knockout_reasons: list[str]
    processing_failed: bool
    processing_error: Optional[str]
    fit_score: Optional[float]
    technical_score: Optional[float] = None
    communication_score: Optional[float] = None
    score_reasons: list[str]
    score_breakdown: Optional[dict[str, Any]]
    skills_breakdown: Optional[dict[str, Any]] = None
    profession_fit: Optional[dict[str, Any]] = None
    campus_metadata: Optional[dict[str, Any]] = None
    experience_analysis: Optional[dict[str, Any]] = None
    manual_score_adjustment: Optional[int]
    manual_adjustment_reason: Optional[str]
    bucket: Optional[Bucket]
    override_bucket: Optional[Bucket]
    override_reason: Optional[str]
    uploaded_by_user_id: Optional[uuid.UUID]
    uploaded_by_email: Optional[str] = None
    source: Optional[str]
    archived: bool
    archived_reason: Optional[str]

    class Config:
        from_attributes = True


class OverrideRequest(BaseModel):
    bucket: Bucket
    reason: str


class ArchiveRequest(BaseModel):
    reason: str


class DeleteRequest(BaseModel):
    reason: str


class ScreeningDetailsRequest(BaseModel):
    notice_period_days: Optional[int] = Field(default=None, ge=0)
    expected_salary: Optional[int] = Field(default=None, ge=0)


class ManualAdjustmentRequest(BaseModel):
    adjustment: int  # e.g. -20..+20 — enforced in the endpoint, not the schema
    reason: str
