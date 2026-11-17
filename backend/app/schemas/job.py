import uuid
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.job import JobLevel, WorkMode


class JobCreate(BaseModel):
    title: str
    jd_text: str
    required_skills: list[str] = []
    level: JobLevel = JobLevel.experienced
    work_mode: WorkMode = WorkMode.onsite

    min_years_experience: Optional[int] = Field(default=None, ge=0)
    allowed_locations: list[str] = []
    max_notice_period_days: Optional[int] = Field(default=None, ge=0)
    salary_band_min: Optional[int] = Field(default=None, ge=0)
    salary_band_max: Optional[int] = Field(default=None, ge=0)

    approve_threshold: int = 75
    decline_threshold: int = 40

    weight_skills: float = 0.20
    weight_experience: float = 0.20
    weight_education: float = 0.20
    weight_certifications: float = 0.20
    weight_communication: float = 0.20

    core_skills: list[str] = []
    secondary_skills: list[str] = []
    irrelevant_skills: list[str] = []

    is_campus_drive: bool = False
    campus_min_cgpa: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    campus_allowed_batches: list[int] = []
    campus_allowed_branches: list[str] = []
    campus_max_backlogs: Optional[int] = Field(default=None, ge=0)

    require_desktop_probe: bool = False

    @field_validator("title", "jd_text")
    @classmethod
    def _reject_blank(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("must not be empty or whitespace-only")
        return stripped

    @model_validator(mode="after")
    def _salary_band_ordered(self) -> "JobCreate":
        if (
            self.salary_band_min is not None
            and self.salary_band_max is not None
            and self.salary_band_min > self.salary_band_max
        ):
            raise ValueError("Minimum salary must not be greater than the maximum")
        return self

    @model_validator(mode="after")
    def _weights_sum_to_one(self) -> "JobCreate":
        total = (
            self.weight_skills
            + self.weight_experience
            + self.weight_education
            + self.weight_certifications
            + self.weight_communication
        )
        if abs(total - 1.0) > 0.01:
            raise ValueError(f"Sub-score weights must sum to 1.0 (got {total:.2f})")
        return self

    @model_validator(mode="after")
    def _approve_above_decline(self) -> "JobCreate":
        # triage.bucket_for_score checks approve_threshold before decline_threshold, so if
        # approve_threshold <= decline_threshold the review bucket is unreachable — every
        # score lands in approved or declined and no candidate ever reaches human review.
        if self.approve_threshold <= self.decline_threshold:
            raise ValueError("approve_threshold must be greater than decline_threshold")
        return self


class JobOut(JobCreate):
    id: uuid.UUID
    archived: bool = False
    archived_reason: Optional[str] = None

    class Config:
        from_attributes = True


class JobUpdate(BaseModel):
    title: Optional[str] = None
    jd_text: Optional[str] = None
    required_skills: Optional[list[str]] = None
    level: Optional[JobLevel] = None
    work_mode: Optional[WorkMode] = None

    min_years_experience: Optional[int] = Field(default=None, ge=0)
    allowed_locations: Optional[list[str]] = None
    max_notice_period_days: Optional[int] = Field(default=None, ge=0)
    salary_band_min: Optional[int] = Field(default=None, ge=0)
    salary_band_max: Optional[int] = Field(default=None, ge=0)

    approve_threshold: Optional[int] = None
    decline_threshold: Optional[int] = None

    weight_skills: Optional[float] = None
    weight_experience: Optional[float] = None
    weight_education: Optional[float] = None
    weight_certifications: Optional[float] = None
    weight_communication: Optional[float] = None

    core_skills: Optional[list[str]] = None
    secondary_skills: Optional[list[str]] = None
    irrelevant_skills: Optional[list[str]] = None

    is_campus_drive: Optional[bool] = None
    campus_min_cgpa: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    campus_allowed_batches: Optional[list[int]] = None
    campus_allowed_branches: Optional[list[str]] = None
    campus_max_backlogs: Optional[int] = Field(default=None, ge=0)

    require_desktop_probe: Optional[bool] = None

    # salary_band_min/salary_band_max ordering isn't checked here — JobUpdate's fields are
    # all optional (partial updates), so only the final pair together (one possibly
    # just-changed, the other carried over from the existing job) can actually be judged;
    # see the merged-state check in jobs.py's update_job.
    @field_validator("title", "jd_text")
    @classmethod
    def _reject_blank(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        stripped = v.strip()
        if not stripped:
            raise ValueError("must not be empty or whitespace-only")
        return stripped


class JobArchiveRequest(BaseModel):
    reason: str


class JobDeleteRequest(BaseModel):
    # Optional: a job that is already archived carries an archive reason of its own, and
    # the delete is confirmed in the UI either way. Only used when the delete has to
    # archive the job on the caller's behalf first.
    reason: Optional[str] = None


class JobSuggestRequest(BaseModel):
    title: str
    draft_jd_text: Optional[str] = None


class JobSuggestResponse(BaseModel):
    jd_text: str
    required_skills: list[str]
