import os
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session, joinedload

from app.api.v1.auth import require_hr_auth
from app.db.session import get_db
from app.models.candidate import AuditLog, Candidate
from app.models.job import Job
from app.models.user import User
from app.schemas.candidate import (
    ArchiveRequest,
    CandidateOut,
    DeleteRequest,
    ManualAdjustmentRequest,
    OverrideRequest,
    ScreeningDetailsRequest,
)
from app.services import dedupe, experience, knockout, scoring, storage, triage
from app.services.fit_report import build_fit_report_pdf
from app.services.resume_parser import parse_resume
from app.services.text_extract import extract_text

router = APIRouter(tags=["candidates"], dependencies=[Depends(require_hr_auth)])

MANUAL_ADJUSTMENT_LIMIT = 20


def _matches_declared_type(filename: str, content: bytes) -> bool:
    """Sniffs magic bytes against the file's own extension — a renamed non-resume file
    (some_photo.jpg saved as resume.pdf, say) would otherwise sail past extract_text's
    extension check straight into real parsing/OCR, burning an actual OpenAI call on
    content that was never a resume. Anything outside pdf/docx falls through to
    extract_text's own plain-text path and isn't sniffed here."""
    lower = filename.lower()
    if lower.endswith(".pdf"):
        return content.startswith(b"%PDF-")
    if lower.endswith(".docx"):
        return content.startswith(b"PK\x03\x04")
    return True


def _apply_bucket_from_score(candidate: Candidate, job: Job) -> None:
    """Bucket is derived from fit_score plus any HR manual adjustment (clamped to 0-100) —
    override_bucket, set separately via /override, always wins over this in the UI and is
    never touched here."""
    effective = (candidate.fit_score or 0) + (candidate.manual_score_adjustment or 0)
    effective = max(0.0, min(100.0, effective))
    candidate.bucket = triage.bucket_for_score(effective, job)


@router.post("/jobs/{job_id}/resumes", response_model=list[CandidateOut])
async def upload_resumes(
    job_id: uuid.UUID,
    files: list[UploadFile],
    source: str | None = Form(default=None),
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.archived:
        raise HTTPException(status_code=400, detail="Job is archived and isn't accepting new resumes.")

    uploader = db.query(User).filter(User.id == current_hr_user["user_id"]).first()

    results: list[Candidate] = []
    saved_paths: list[str] = []
    failed_uploads: list[str] = []

    for file in files:
        content = await file.read()
        try:
            relative_path = storage.save_file(f"resumes/{job_id}", file.filename, content)
        except OSError:
            # A disk-level failure (full disk, permission error, ...) on this one file must
            # not abort the whole request — that would discard every candidate already
            # queued earlier in this same batch (added to the session but not yet
            # committed) while their resume files stay written to disk, orphaned with no
            # matching DB row. Skip just this file and keep going.
            failed_uploads.append(file.filename or "unknown")
            continue
        saved_paths.append(relative_path)

        candidate = Candidate(
            job_id=job_id,
            resume_file_path=relative_path,
            uploaded_by_user_id=uploader.id if uploader else None,
            source=source,
        )

        try:
            if not _matches_declared_type(file.filename, content):
                raise ValueError(
                    f"{file.filename} doesn't look like a real "
                    f"{os.path.splitext(file.filename)[1] or 'file'} — it may have been "
                    "renamed or is corrupted."
                )
            resume_text, ocr_used = extract_text(file.filename, content)
            candidate.ocr_fallback_used = ocr_used
            profile = parse_resume(resume_text)

            candidate.parsed_profile = profile
            candidate.full_name = profile.get("full_name")
            candidate.email = profile.get("email")
            candidate.phone = profile.get("phone")
            candidate.notice_period_days = profile.get("notice_period_days")
            candidate.expected_salary = profile.get("expected_salary")
            candidate.experience_analysis = experience.analyze_experience(profile)

            duplicate = dedupe.find_duplicate(
                db, job_id, candidate.email, candidate.phone, candidate.full_name
            )
            if duplicate:
                candidate.is_duplicate_of = duplicate.id
                db.add(candidate)
                results.append(candidate)
                continue

            failed, reasons = knockout.check_knockout(profile, job)

            if file.filename.lower().endswith(".pdf"):
                from app.services.keyword_stuffing import detect_keyword_stuffing
                stuffing_res = detect_keyword_stuffing(content)
                if stuffing_res["detected"]:
                    failed = True
                    reasons = (reasons or []) + [stuffing_res["reason"]]

            candidate.knockout_failed = failed
            candidate.knockout_reasons = reasons

            if failed:
                candidate.bucket = "declined"
            else:
                (
                    score,
                    tech_score,
                    comm_score,
                    score_reasons,
                    breakdown,
                    skills_breakdown,
                    profession_fit,
                ) = scoring.score_candidate(profile, job)
                candidate.fit_score = score
                candidate.technical_score = tech_score
                candidate.communication_score = comm_score
                candidate.score_reasons = score_reasons
                candidate.score_breakdown = breakdown
                candidate.skills_breakdown = skills_breakdown
                candidate.profession_fit = profession_fit
                _apply_bucket_from_score(candidate, job)

        except Exception as exc:  # noqa: BLE001 - surfaced to HR in the "Needs attention" panel, not dropped
            candidate.processing_failed = True
            candidate.processing_error = str(exc)

        db.add(candidate)
        results.append(candidate)

    if not results and failed_uploads:
        raise HTTPException(
            status_code=502, detail=f"Could not save uploaded file(s): {', '.join(failed_uploads)}"
        )

    try:
        db.commit()
    except Exception:
        db.rollback()
        # Every file in saved_paths already landed on disk on the assumption its Candidate
        # row would be committed alongside it — since the commit failed, none of those rows
        # exist, so leaving the files behind would orphan them permanently.
        for path in saved_paths:
            try:
                os.remove(storage.absolute_path(path))
            except OSError:
                pass
        raise

    for candidate in results:
        db.refresh(candidate)
        candidate.uploaded_by_email = uploader.email if uploader else None
    return results


@router.post("/candidates/{candidate_id}/screening-details", response_model=CandidateOut)
def set_screening_details(
    candidate_id: uuid.UUID,
    payload: ScreeningDetailsRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    """Notice period / expected salary a resume rarely states outright — HR fills these in
    after a screening call, and knockout is re-checked immediately against the job's rules."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    job = db.get(Job, candidate.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    candidate.notice_period_days = payload.notice_period_days
    candidate.expected_salary = payload.expected_salary

    merged_profile = {
        **(candidate.parsed_profile or {}),
        "notice_period_days": payload.notice_period_days,
        "expected_salary": payload.expected_salary,
    }
    failed, reasons = knockout.check_knockout(merged_profile, job)
    candidate.knockout_failed = failed
    candidate.knockout_reasons = reasons

    if failed:
        candidate.bucket = "declined"
    elif candidate.fit_score is None and candidate.parsed_profile:
        # Never scored because knockout blocked it at upload time — score it now that the
        # thing that blocked it has cleared.
        (
            score,
            tech_score,
            comm_score,
            score_reasons,
            breakdown,
            skills_breakdown,
            profession_fit,
        ) = scoring.score_candidate(candidate.parsed_profile, job)
        candidate.fit_score = score
        candidate.technical_score = tech_score
        candidate.communication_score = comm_score
        candidate.score_reasons = score_reasons
        candidate.score_breakdown = breakdown
        candidate.skills_breakdown = skills_breakdown
        candidate.profession_fit = profession_fit
        _apply_bucket_from_score(candidate, job)
    elif candidate.fit_score is not None:
        _apply_bucket_from_score(candidate, job)

    db.add(AuditLog(
        candidate_id=candidate.id,
        actor=f"hr:{current_hr_user['email']}",
        action="set_screening_details",
        detail={
            "notice_period_days": payload.notice_period_days,
            "expected_salary": payload.expected_salary,
        },
    ))

    db.add(candidate)
    db.commit()
    db.refresh(candidate)
    return candidate


@router.post("/candidates/{candidate_id}/manual-adjustment", response_model=CandidateOut)
def set_manual_adjustment(
    candidate_id: uuid.UUID,
    payload: ManualAdjustmentRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    """A small HR-entered nudge on top of the AI sub-scores (e.g. a competing offer, a
    referral) — always shown separately from the AI breakdown, never folded into it."""
    if not -MANUAL_ADJUSTMENT_LIMIT <= payload.adjustment <= MANUAL_ADJUSTMENT_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=f"Adjustment must be between -{MANUAL_ADJUSTMENT_LIMIT} and +{MANUAL_ADJUSTMENT_LIMIT}",
        )

    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    if candidate.fit_score is None:
        raise HTTPException(status_code=400, detail="Candidate has no AI score to adjust yet")
    job = db.get(Job, candidate.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    candidate.manual_score_adjustment = payload.adjustment
    candidate.manual_adjustment_reason = payload.reason
    _apply_bucket_from_score(candidate, job)

    db.add(AuditLog(
        candidate_id=candidate.id,
        actor=f"hr:{current_hr_user['email']}",
        action="manual_score_adjustment",
        detail={"adjustment": payload.adjustment, "reason": payload.reason},
    ))

    db.add(candidate)
    db.commit()
    db.refresh(candidate)
    return candidate


@router.get("/candidates/{candidate_id}", response_model=CandidateOut)
def get_candidate(candidate_id: uuid.UUID, db: Session = Depends(get_db)):
    """Backs the consolidated final-decision view — everything scoring-related in one
    place, distinct from the Kanban card's summary. HR-only, same as every other candidate
    endpoint; nothing here is ever exposed to the candidate themselves."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    candidate.uploaded_by_email = candidate.uploader.email if candidate.uploader else None
    return candidate


@router.get("/candidates/{candidate_id}/fit-report")
def download_fit_report(candidate_id: uuid.UUID, db: Session = Depends(get_db)):
    """A downloadable PDF summary of the AI fit assessment (overall score, sub-scores,
    eligibility, HR decision) — not the resume itself, which HR already has from the
    upload. This is the score/reasoning HR would otherwise have to reconstruct by clicking
    through the candidate page."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    job = db.get(Job, candidate.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    pdf_bytes = build_fit_report_pdf(candidate, job)
    safe_name = (candidate.full_name or "candidate").replace(" ", "_")

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}_fit_report.pdf"'},
    )


@router.get("/jobs/{job_id}/candidates", response_model=list[CandidateOut])
def list_candidates(job_id: uuid.UUID, db: Session = Depends(get_db)):
    candidates = (
        db.query(Candidate)
        .options(joinedload(Candidate.uploader))
        .filter(Candidate.job_id == job_id)
        .order_by(Candidate.fit_score.desc().nullslast())
        .all()
    )
    for candidate in candidates:
        candidate.uploaded_by_email = candidate.uploader.email if candidate.uploader else None
    return candidates


@router.post("/candidates/{candidate_id}/override", response_model=CandidateOut)
def override_candidate(
    candidate_id: uuid.UUID,
    payload: OverrideRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    candidate.override_bucket = payload.bucket
    candidate.override_reason = payload.reason
    db.add(candidate)

    db.add(AuditLog(
        candidate_id=candidate.id,
        actor=f"hr:{current_hr_user['email']}",
        action="override_bucket",
        detail={"bucket": payload.bucket.value, "reason": payload.reason},
    ))

    db.commit()
    db.refresh(candidate)
    return candidate


@router.post("/candidates/{candidate_id}/archive", response_model=CandidateOut)
def archive_candidate(
    candidate_id: uuid.UUID,
    payload: ArchiveRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    candidate.archived = True
    candidate.archived_reason = payload.reason
    db.add(candidate)

    db.add(AuditLog(
        candidate_id=candidate.id,
        actor=f"hr:{current_hr_user['email']}",
        action="archive_candidate",
        detail={"reason": payload.reason},
    ))

    db.commit()
    db.refresh(candidate)
    return candidate


def _collect_duplicate_chain(db: Session, candidate_id: uuid.UUID) -> list[Candidate]:
    """Finds every candidate row marked as a duplicate of candidate_id, transitively.

    Duplicate rows never get scored independently (upload_resumes skips scoring for
    them), so deleting them alongside the primary loses no AI decision history —
    they're pure resume-file records pointing at the primary, and leaving them behind
    is exactly what caused deleted candidates to "come back" as duplicates on re-upload.
    """
    chain: list[Candidate] = []
    frontier = [candidate_id]
    while frontier:
        children = db.query(Candidate).filter(Candidate.is_duplicate_of.in_(frontier)).all()
        if not children:
            break
        chain.extend(children)
        frontier = [c.id for c in children]
    return chain


@router.delete("/candidates/{candidate_id}")
def delete_candidate(
    candidate_id: uuid.UUID,
    payload: DeleteRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    # One HR action, one click — archiving first is still recorded as its own audit-log
    # entry (same reason) rather than skipped, so the trail looks identical to the
    # explicit archive-then-delete flow even though the caller only made one request.
    if not candidate.archived:
        candidate.archived = True
        candidate.archived_reason = payload.reason
        db.add(candidate)
        db.add(AuditLog(
            candidate_id=candidate.id,
            actor=f"hr:{current_hr_user['email']}",
            action="archive_candidate",
            detail={"reason": payload.reason},
        ))

    duplicates = _collect_duplicate_chain(db, candidate_id)

    # Logged before the rows are gone — candidate_id is left null since the row it
    # would reference is about to be deleted (the FK is ON DELETE SET NULL).
    db.add(AuditLog(
        candidate_id=None,
        actor=f"hr:{current_hr_user['email']}",
        action="hard_delete_candidate",
        detail={
            "reason": payload.reason,
            "candidate_name": candidate.full_name,
            "email": candidate.email,
            "duplicates_removed": len(duplicates),
        },
    ))

    resume_paths = [candidate.resume_file_path] + [d.resume_file_path for d in duplicates]
    for dup in duplicates:
        db.delete(dup)
    db.delete(candidate)
    db.commit()

    for path in resume_paths:
        try:
            os.remove(storage.absolute_path(path))
        except OSError:
            pass

    return {"deleted": True, "duplicates_removed": len(duplicates)}


@router.post("/candidates/{candidate_id}/unarchive", response_model=CandidateOut)
def unarchive_candidate(
    candidate_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    candidate.archived = False
    db.add(candidate)

    db.add(AuditLog(
        candidate_id=candidate.id,
        actor=f"hr:{current_hr_user['email']}",
        action="unarchive_candidate",
        detail={},
    ))

    db.commit()
    db.refresh(candidate)
    return candidate


@router.post("/jobs/{job_id}/campus-bulk-zip")
async def upload_campus_bulk_zip(
    job_id: uuid.UUID,
    file: UploadFile,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    """Bulk uploads a ZIP archive containing candidate resumes for campus interview drives."""
    from app.models.bulk_batch import BulkUploadBatch
    from app.services.campus_screening import extract_zip_resumes, run_campus_bulk_processing_task

    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded ZIP file is empty.")

    try:
        extracted = extract_zip_resumes(content)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to extract ZIP archive: {exc}")

    if not extracted:
        raise HTTPException(status_code=400, detail="No valid PDF or DOCX resumes found in ZIP archive.")

    items = [{"filename": fn, "content": b, "campus_metadata": None} for fn, b in extracted]

    batch = BulkUploadBatch(
        job_id=job_id,
        batch_type="zip",
        status="pending",
        total_count=len(items),
        processed_count=0,
        failed_count=0,
        error_log=[],
        uploaded_by_user_id=current_hr_user["user_id"],
    )
    db.add(batch)
    db.commit()
    db.refresh(batch)

    background_tasks.add_task(
        run_campus_bulk_processing_task,
        batch_id=batch.id,
        job_id=job_id,
        items=items,
        uploader_user_id=current_hr_user["user_id"],
    )

    return {
        "batch_id": batch.id,
        "total_count": len(items),
        "status": "pending",
        "message": f"Queued {len(items)} resumes for background campus screening.",
    }


@router.post("/jobs/{job_id}/campus-csv-import")
async def import_campus_csv_roster(
    job_id: uuid.UUID,
    csv_file: UploadFile,
    resumes_zip: UploadFile,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    """Imports a college placement CSV roster along with matching resume files in a ZIP archive."""
    from app.models.bulk_batch import BulkUploadBatch
    from app.services.campus_screening import (
        extract_zip_resumes,
        parse_campus_csv_roster,
        run_campus_bulk_processing_task,
    )

    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    csv_bytes = await csv_file.read()
    zip_bytes = await resumes_zip.read()

    try:
        csv_text = csv_bytes.decode("utf-8-sig", errors="replace")
        roster_rows = parse_campus_csv_roster(csv_text)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse CSV roster: {exc}")

    if not roster_rows:
        raise HTTPException(status_code=400, detail="CSV roster contains no data rows.")

    try:
        extracted = extract_zip_resumes(zip_bytes)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to extract ZIP archive: {exc}")

    # Build filename lookup map
    zip_map: dict[str, tuple[str, bytes]] = {}
    for fn, b in extracted:
        zip_map[fn.lower()] = (fn, b)
        # Also map without extension
        base = os.path.splitext(fn)[0].lower()
        zip_map[base] = (fn, b)

    items: list[dict[str, Any]] = []
    failed_initial = 0
    error_logs: list[dict[str, Any]] = []

    for idx, row in enumerate(roster_rows, 1):
        target_fn = (row.get("resume_filename") or "").lower()
        target_roll = (row.get("roll_number") or "").lower()
        target_name = (row.get("name") or "").lower().replace(" ", "_")

        matched = (
            zip_map.get(target_fn)
            or zip_map.get(f"{target_fn}.pdf")
            or zip_map.get(f"{target_fn}.docx")
            or (zip_map.get(target_roll) if target_roll else None)
            or (zip_map.get(f"{target_roll}.pdf") if target_roll else None)
            or (zip_map.get(target_name) if target_name else None)
        )

        if not matched:
            failed_initial += 1
            error_logs.append({
                "row": idx,
                "identifier": row.get("roll_number") or row.get("name") or f"Row {idx}",
                "error": f"Resume file '{row.get('resume_filename') or row.get('roll_number')}' not found in ZIP archive.",
            })
            continue

        real_fn, file_bytes = matched
        items.append({
            "filename": real_fn,
            "content": file_bytes,
            "campus_metadata": row,
        })

    batch = BulkUploadBatch(
        job_id=job_id,
        batch_type="csv",
        status="pending",
        total_count=len(roster_rows),
        processed_count=0,
        failed_count=failed_initial,
        error_log=error_logs,
        uploaded_by_user_id=current_hr_user["user_id"],
    )
    db.add(batch)
    db.commit()
    db.refresh(batch)

    if items:
        background_tasks.add_task(
            run_campus_bulk_processing_task,
            batch_id=batch.id,
            job_id=job_id,
            items=items,
            uploader_user_id=current_hr_user["user_id"],
        )

    return {
        "batch_id": batch.id,
        "total_count": len(roster_rows),
        "matched_count": len(items),
        "unmatched_count": failed_initial,
        "status": "pending",
        "message": f"Queued {len(items)} matched resumes for campus screening ({failed_initial} unmatched).",
    }


@router.get("/jobs/{job_id}/bulk-batches/{batch_id}")
def get_bulk_batch_status(
    job_id: uuid.UUID,
    batch_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    from app.models.bulk_batch import BulkUploadBatch

    batch = db.get(BulkUploadBatch, batch_id)
    if not batch or batch.job_id != job_id:
        raise HTTPException(status_code=404, detail="Batch not found")

    return {
        "id": batch.id,
        "job_id": batch.job_id,
        "batch_type": batch.batch_type,
        "status": batch.status,
        "total_count": batch.total_count,
        "processed_count": batch.processed_count,
        "failed_count": batch.failed_count,
        "error_log": batch.error_log or [],
        "created_at": batch.created_at,
        "completed_at": batch.completed_at,
    }

