import os
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.v1.auth import require_hr_auth
from app.db.session import get_db
from app.models.candidate import AuditLog, Candidate
from app.models.job import Job
from app.schemas.job import (
    JobArchiveRequest,
    JobCreate,
    JobOut,
    JobSuggestRequest,
    JobSuggestResponse,
    JobUpdate,
)
from app.models.interview import InterviewSession
from app.services import storage
from app.services.jd_suggestion import suggest_job_description

router = APIRouter(prefix="/jobs", tags=["jobs"], dependencies=[Depends(require_hr_auth)])


@router.post("", response_model=JobOut)
def create_job(
    payload: JobCreate,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    job = Job(**payload.model_dump())
    db.add(job)
    db.flush()  # assigns job.id, so the audit log below can reference it

    db.add(AuditLog(
        actor=f"hr:{current_hr_user['email']}",
        action="create_job",
        detail={"job_id": str(job.id), "title": job.title},
    ))

    db.commit()
    db.refresh(job)
    return job


@router.post("/suggest", response_model=JobSuggestResponse)
def suggest_job(payload: JobSuggestRequest):
    try:
        return suggest_job_description(payload.title, payload.draft_jd_text)
    except Exception as exc:  # noqa: BLE001 - OpenAI errors, a missing tool call, bad JSON, etc.
        raise HTTPException(
            status_code=502,
            detail="Could not generate a job description suggestion right now — try again in a moment.",
        ) from exc


@router.get("", response_model=list[JobOut])
def list_jobs(db: Session = Depends(get_db)):
    return db.query(Job).order_by(Job.created_at.desc()).all()


@router.get("/{job_id}", response_model=JobOut)
def get_job(job_id: uuid.UUID, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.patch("/{job_id}", response_model=JobOut)
def update_job(
    job_id: uuid.UUID,
    payload: JobUpdate,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.archived:
        raise HTTPException(status_code=400, detail="Job is archived and can't be edited — unarchive it first.")

    changed_fields = payload.model_dump(exclude_unset=True)
    for field, value in changed_fields.items():
        setattr(job, field, value)

    # Checked against the merged result rather than in JobUpdate itself — its fields are
    # all optional (partial updates), so only the final approve/decline pair together (one
    # possibly just-changed, the other carried over from the existing job) tells us whether
    # the review bucket in triage.bucket_for_score is still reachable.
    if job.approve_threshold <= job.decline_threshold:
        raise HTTPException(
            status_code=400, detail="approve_threshold must be greater than decline_threshold"
        )

    # Same reasoning, mirroring JobCreate's _salary_band_ordered.
    if (
        job.salary_band_min is not None
        and job.salary_band_max is not None
        and job.salary_band_min > job.salary_band_max
    ):
        raise HTTPException(status_code=400, detail="salary_band_min must not exceed salary_band_max")

    # Same reasoning as above, mirroring JobCreate's _weights_sum_to_one — a partial update
    # touching only one weight field would otherwise leave the others (carried over from the
    # existing job) summing to something scoring.score_candidate never expected.
    #
    # All five categories are counted. Communication was added as a fifth weighted category
    # after this check was written and never added here, so the total always came up short
    # by exactly that weight and every save was rejected — a job created through the current
    # form (which spreads weight across all five) could never be edited again. Legacy jobs
    # are unaffected: their communication weight is 0.0 and the other four already sum to 1.
    weight_total = (
        job.weight_skills
        + job.weight_experience
        + job.weight_education
        + job.weight_certifications
        + (job.weight_communication or 0.0)
    )
    if abs(weight_total - 1.0) > 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Sub-score weights must sum to 1.0 (got {weight_total:.2f})",
        )

    db.add(job)

    db.add(AuditLog(
        actor=f"hr:{current_hr_user['email']}",
        action="update_job",
        detail={"job_id": str(job_id), "changed_fields": changed_fields},
    ))

    db.commit()
    db.refresh(job)
    return job


@router.post("/{job_id}/clone", response_model=JobOut)
def clone_job(
    job_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    """Copies every configuration field into a brand-new job with zero candidates attached
    — never copies candidates/scoring history, only the reusable setup."""
    original = db.get(Job, job_id)
    if not original:
        raise HTTPException(status_code=404, detail="Job not found")

    payload = JobCreate.model_validate(original, from_attributes=True).model_dump()
    payload["title"] = f"{original.title} (Copy)"
    clone = Job(**payload)
    db.add(clone)

    db.add(AuditLog(
        actor=f"hr:{current_hr_user['email']}",
        action="clone_job",
        detail={"source_job_id": str(job_id), "new_title": clone.title},
    ))

    db.commit()
    db.refresh(clone)
    return clone


@router.post("/{job_id}/archive", response_model=JobOut)
def archive_job(
    job_id: uuid.UUID,
    payload: JobArchiveRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    job.archived = True
    job.archived_reason = payload.reason
    db.add(job)

    db.add(AuditLog(
        actor=f"hr:{current_hr_user['email']}",
        action="archive_job",
        detail={"job_id": str(job_id), "reason": payload.reason},
    ))

    db.commit()
    db.refresh(job)
    return job


@router.post("/{job_id}/unarchive", response_model=JobOut)
def unarchive_job(
    job_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    job.archived = False
    db.add(job)

    db.add(AuditLog(
        actor=f"hr:{current_hr_user['email']}",
        action="unarchive_job",
        detail={"job_id": str(job_id)},
    ))

    db.commit()
    db.refresh(job)
    return job


@router.delete("/{job_id}")
def delete_job(
    job_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    """Permanently removes a job AND every candidate attached to it — a deliberate cascade,
    unlike the single-candidate delete flow (which requires archiving each one first).
    Deleting a job's posting without its applicant pipeline would just leave those
    candidates orphaned with a dangling job reference and nothing meaningful to attach them
    to, so this is treated as removing one unit (job + its pipeline), not two."""
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job.archived:
        raise HTTPException(
            status_code=400, detail="Job must be archived before it can be permanently deleted."
        )

    candidates = db.query(Candidate).filter(Candidate.job_id == job_id).all()
    resume_paths = [c.resume_file_path for c in candidates]
    candidates_removed = len(candidates)

    # Interview sessions aren't candidate data — recordings/transcripts/integrity flags all
    # live keyed by session id, not on the Job or Candidate row — so these are detached
    # from the job being removed rather than deleted. Nothing about the session record
    # itself is touched or lost.
    db.query(InterviewSession).filter(InterviewSession.job_id == job_id).update({"job_id": None})

    for candidate in candidates:
        db.delete(candidate)

    db.add(AuditLog(
        actor=f"hr:{current_hr_user['email']}",
        action="hard_delete_job",
        detail={"job_id": str(job_id), "title": job.title, "candidates_removed": candidates_removed},
    ))

    db.delete(job)
    db.commit()

    for path in resume_paths:
        try:
            os.remove(storage.absolute_path(path))
        except OSError:
            pass

    return {"deleted": True, "candidates_removed": candidates_removed}
