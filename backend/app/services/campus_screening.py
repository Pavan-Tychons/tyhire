import asyncio
import csv
import io
import logging
import os
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.bulk_batch import BulkUploadBatch
from app.models.candidate import Candidate
from app.models.job import Job
from app.services import dedupe, experience, knockout, scoring, storage, triage
from app.services.keyword_stuffing import detect_keyword_stuffing
from app.services.knockout import check_campus_knockout
from app.services.resume_parser import parse_resume
from app.services.text_extract import extract_text

logger = logging.getLogger(__name__)

ALLOWED_RESUME_EXTS = (".pdf", ".docx")


def extract_zip_resumes(zip_bytes: bytes) -> list[tuple[str, bytes]]:
    """Safely extracts all PDF/DOCX files from a ZIP archive."""
    extracted: list[tuple[str, bytes]] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            # Skip directories, hidden files, and macOS metadata folders
            if info.is_dir() or "__MACOSX" in info.filename or os.path.basename(info.filename).startswith("."):
                continue
            lower_name = info.filename.lower()
            if any(lower_name.endswith(ext) for ext in ALLOWED_RESUME_EXTS):
                clean_filename = os.path.basename(info.filename)
                content = zf.read(info)
                extracted.append((clean_filename, content))
    return extracted


def parse_campus_csv_roster(csv_text: str) -> list[dict[str, Any]]:
    """Parses a campus student roster CSV with flexible header normalization."""
    reader = csv.DictReader(io.StringIO(csv_text))
    rows: list[dict[str, Any]] = []

    for row in reader:
        norm: dict[str, Any] = {}
        for k, v in row.items():
            if not k:
                continue
            key = k.strip().lower().replace(" ", "_").replace("-", "_")
            norm[key] = (v or "").strip()

        # Extract normalized fields
        roll = (
            norm.get("roll_number")
            or norm.get("roll_no")
            or norm.get("reg_no")
            or norm.get("registration_no")
            or norm.get("student_id")
            or ""
        )
        name = norm.get("name") or norm.get("full_name") or norm.get("student_name") or ""
        email = norm.get("email") or norm.get("email_address") or ""
        phone = norm.get("phone") or norm.get("mobile") or norm.get("contact") or ""
        college = norm.get("college") or norm.get("university") or norm.get("institution") or ""
        branch = (
            norm.get("branch")
            or norm.get("degree_branch")
            or norm.get("department")
            or norm.get("stream")
            or norm.get("major")
            or ""
        )

        cgpa_str = norm.get("cgpa") or norm.get("percentage") or norm.get("gpa") or norm.get("marks")
        cgpa = float(cgpa_str) if cgpa_str and _is_float(cgpa_str) else None

        batch_str = norm.get("batch") or norm.get("graduation_year") or norm.get("passing_year") or norm.get("year")
        batch = int(batch_str) if batch_str and batch_str.isdigit() else None

        backlogs_str = norm.get("backlogs") or norm.get("standing_backlogs") or norm.get("arrears")
        backlogs = int(backlogs_str) if backlogs_str and backlogs_str.isdigit() else 0

        resume_fn = (
            norm.get("resume_filename")
            or norm.get("resume_file")
            or norm.get("filename")
            or norm.get("file_name")
            or norm.get("resume")
            or ""
        )

        rows.append({
            "roll_number": roll,
            "name": name,
            "email": email,
            "phone": phone,
            "college": college,
            "degree_branch": branch,
            "cgpa": cgpa,
            "graduation_year": batch,
            "standing_backlogs": backlogs,
            "resume_filename": resume_fn,
        })

    return rows


def _is_float(v: str) -> bool:
    try:
        float(v)
        return True
    except ValueError:
        return False


def _apply_bucket_from_score(candidate: Candidate, job: Job) -> None:
    effective = (candidate.fit_score or 0) + (candidate.manual_score_adjustment or 0)
    effective = max(0.0, min(100.0, effective))
    candidate.bucket = triage.bucket_for_score(effective, job)


async def run_campus_bulk_processing_task(
    batch_id: uuid.UUID,
    job_id: uuid.UUID,
    items: list[dict[str, Any]],  # list of {"filename": str, "content": bytes, "campus_metadata": dict | None}
    uploader_user_id: uuid.UUID | None,
):
    """Asynchronously processes campus bulk upload batches with a concurrency semaphore (N=3)."""
    db = SessionLocal()
    batch = db.get(BulkUploadBatch, batch_id)
    job = db.get(Job, job_id)

    if not batch or not job:
        db.close()
        return

    batch.status = "processing"
    db.commit()

    semaphore = asyncio.Semaphore(3)

    async def _process_single_item(item: dict[str, Any], index: int):
        async with semaphore:
            filename = item["filename"]
            content = item["content"]
            campus_meta = item.get("campus_metadata")

            sub_db = SessionLocal()
            try:
                # Save resume file encrypted at rest
                relative_path = storage.save_file(f"resumes/{job_id}", filename, content)
                candidate = Candidate(
                    job_id=job_id,
                    resume_file_path=relative_path,
                    uploaded_by_user_id=uploader_user_id,
                    source="campus_bulk_drive",
                    campus_metadata=campus_meta,
                )

                resume_text, ocr_used = extract_text(filename, content)
                candidate.ocr_fallback_used = ocr_used
                profile = parse_resume(resume_text)

                candidate.parsed_profile = profile
                candidate.full_name = profile.get("full_name") or (campus_meta.get("name") if campus_meta else None)
                candidate.email = profile.get("email") or (campus_meta.get("email") if campus_meta else None)
                candidate.phone = profile.get("phone") or (campus_meta.get("phone") if campus_meta else None)
                candidate.experience_analysis = experience.analyze_experience(profile)

                # Deduplication check
                duplicate = dedupe.find_duplicate(
                    sub_db, job_id, candidate.email, candidate.phone, candidate.full_name
                )
                if duplicate:
                    candidate.is_duplicate_of = duplicate.id
                    sub_db.add(candidate)
                    sub_db.commit()
                    return {"success": True}

                # Knockout check: standard knockout + campus specific knockout
                failed_std, reasons_std = knockout.check_knockout(profile, job)
                failed_campus, reasons_campus = check_campus_knockout(campus_meta, job)
                all_reasons = (reasons_std or []) + (reasons_campus or [])
                is_failed = failed_std or failed_campus

                # PDF keyword stuffing detection
                if filename.lower().endswith(".pdf"):
                    stuffing_res = detect_keyword_stuffing(content)
                    if stuffing_res["detected"]:
                        is_failed = True
                        all_reasons.append(stuffing_res["reason"])

                candidate.knockout_failed = is_failed
                candidate.knockout_reasons = all_reasons

                if is_failed:
                    candidate.bucket = "declined"
                else:
                    # Scoring (only for candidates passing knockout)
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

                sub_db.add(candidate)
                sub_db.commit()
                return {"success": True}
            except Exception as exc:
                logger.exception("Failed processing campus resume item %s: %s", filename, exc)
                return {"success": False, "error": str(exc), "identifier": filename, "row": index}
            finally:
                sub_db.close()

    tasks = [_process_single_item(item, idx + 1) for idx, item in enumerate(items)]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Summarize batch results
    processed_count = 0
    failed_count = batch.failed_count
    error_logs = list(batch.error_log or [])

    for r in results:
        if isinstance(r, dict):
            if r.get("success"):
                processed_count += 1
            else:
                failed_count += 1
                error_logs.append({
                    "row": r.get("row", 0),
                    "identifier": r.get("identifier", "Unknown"),
                    "error": r.get("error", "Processing error"),
                })
        else:
            failed_count += 1
            error_logs.append({"error": str(r), "identifier": "batch_worker"})

    batch.processed_count = processed_count
    batch.failed_count = failed_count
    batch.error_log = error_logs
    batch.status = "completed"
    batch.completed_at = datetime.now(timezone.utc)
    db.add(batch)
    db.commit()
    db.close()
