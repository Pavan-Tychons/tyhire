import uuid

from rapidfuzz import fuzz
from sqlalchemy.orm import Session

from app.models.candidate import Bucket, Candidate

NAME_MATCH_THRESHOLD = 90


def find_duplicate(db: Session, job_id: uuid.UUID, email: str | None, phone: str | None, full_name: str | None) -> Candidate | None:
    # Only match against primary records, not rows that are themselves already marked as
    # duplicates — otherwise a new upload can end up pointing at a duplicate-of-a-duplicate,
    # and if that original primary is later hard-deleted, these orphaned duplicate rows keep
    # matching future uploads even though the record they actually represent is long gone.
    existing = (
        db.query(Candidate)
        .filter(Candidate.job_id == job_id, Candidate.is_duplicate_of.is_(None))
        .all()
    )

    # Normalized once up front rather than per-candidate inside the loop.
    norm_email = _normalize_email(email)
    norm_phone = _normalize_phone(phone)
    norm_name = _normalize_name(full_name)

    for candidate in existing:
        # A declined candidate re-applying (fixed resume, reconsideration, etc.) must get
        # scored fresh, not silently swallowed as a "duplicate" of their own declined
        # record — duplicates are never scored (see upload_resumes), so matching here would
        # permanently block them from ever being reconsidered for this job.
        if (candidate.override_bucket or candidate.bucket) == Bucket.declined:
            continue

        # Email and phone are the identifying fields: an exact match on either is the same
        # person, regardless of how their name was written on the two resumes.
        if norm_email and norm_email == _normalize_email(candidate.email):
            return candidate
        if norm_phone and norm_phone == _normalize_phone(candidate.phone):
            return candidate

        # Name is the fallback for resumes that list neither, so it is the weakest of the
        # three and is kept last.
        cand_name = _normalize_name(candidate.full_name)
        if norm_name and cand_name and fuzz.ratio(norm_name, cand_name) >= NAME_MATCH_THRESHOLD:
            return candidate

    return None


def _normalize_email(email: str | None) -> str:
    return (email or "").strip().lower()


def _normalize_phone(phone: str | None) -> str:
    """Last 10 digits, or "" when there aren't enough digits to identify anyone.

    Must tolerate None: plenty of resumes list no phone number at all, and parsing doesn't
    always find one that is there. This used to be called before the caller checked for
    None, so a missing phone raised TypeError out of find_duplicate — which upload_resumes
    caught as a processing failure, meaning those candidates were never deduplicated *and*
    never scored. Requiring a full 10 digits also stops a fragment like "123" matching
    another fragment and merging two unrelated people.
    """
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    return digits[-10:] if len(digits) >= 10 else ""


def _normalize_name(full_name: str | None) -> str:
    return " ".join((full_name or "").split()).lower()
