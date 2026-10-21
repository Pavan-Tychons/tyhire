import re
from app.models.job import Job, WorkMode
from app.services import experience

BRANCH_ALIASES: dict[str, set[str]] = {
    "cse": {"cse", "cs", "computer science", "computer science and engineering", "comp sci", "computer engineering"},
    "it": {"it", "information technology", "info tech"},
    "ece": {"ece", "electronics and communication", "electronics and communication engineering", "electronics & communication", "electronics"},
    "eee": {"eee", "electrical and electronics", "electrical and electronics engineering", "electrical & electronics", "electrical"},
    "mech": {"mech", "me", "mechanical", "mechanical engineering"},
    "civil": {"civil", "ce", "civil engineering"},
    "aids": {"aids", "ai & ds", "ai and ds", "artificial intelligence and data science", "ai", "data science"},
    "aiml": {"aiml", "ai & ml", "ai and ml", "artificial intelligence and machine learning"},
}


def _match_campus_branch(candidate_branch: str, allowed_branches: list[str]) -> bool:
    """Matches candidate degree/branch against allowed branches using token boundaries
    and common academic branch alias expansions, avoiding false substring positives
    (e.g., 'CE' falsely matching 'ECE' or 'ME' matching 'BME')."""
    if not candidate_branch or not allowed_branches:
        return False

    cand_clean = candidate_branch.strip().lower()
    cand_tokens = set(re.findall(r"\b[a-z0-9]+\b", cand_clean))

    for allowed in allowed_branches:
        allowed_clean = str(allowed).strip().lower()
        if not allowed_clean:
            continue

        # Direct exact match
        if cand_clean == allowed_clean:
            return True

        # Exact word boundary / regex match
        pattern = r"\b" + re.escape(allowed_clean) + r"\b"
        if re.search(pattern, cand_clean):
            return True

        # Alias group check
        for group in BRANCH_ALIASES.values():
            if allowed_clean in group:
                for alias in group:
                    if re.search(r"\b" + re.escape(alias) + r"\b", cand_clean):
                        return True
                    alias_tokens = set(re.findall(r"\b[a-z0-9]+\b", alias))
                    if alias_tokens and alias_tokens.issubset(cand_tokens):
                        return True

    return False


def check_knockout(profile: dict, job: Job) -> tuple[bool, list[str]]:
    reasons: list[str] = []

    # Measured from the employment-history dates rather than taken from the resume's own
    # total, which is a self-reported claim — routinely rounded up, left stale from an
    # older CV, or counted from the start of a degree. analyze_experience falls back to the
    # stated figure when the dates can't be read, so this never fails someone for having an
    # unusually-formatted history (see services/experience.py).
    exp = experience.analyze_experience(profile)
    years = exp["computed_years"] if exp["basis"] == "employment_history" else exp["claimed_years"]
    if job.min_years_experience is not None and years is not None:
        if years < job.min_years_experience:
            measured = exp["basis"] == "employment_history"
            source = "employment history shows" if measured else "resume states"
            qualifier = " (approx.)" if measured and exp["approximate"] else ""
            reasons.append(
                f"Requires {job.min_years_experience}+ yrs experience, "
                f"{source} {years}{qualifier}"
            )

    # A remote role shouldn't knock candidates out for location at all, regardless of
    # allowed_locations — that field only matters for hybrid/onsite roles.
    if job.work_mode != WorkMode.remote and job.allowed_locations:
        location = (profile.get("current_location") or "").strip().lower()
        allowed = [loc.strip().lower() for loc in job.allowed_locations]
        # Substring match, not exact equality — extracted locations often carry extra
        # context (e.g. "Bangalore, India") that would otherwise wrongly knock out a
        # candidate whose city is actually on the allowed list.
        if location and not any(a in location or location in a for a in allowed):
            reasons.append(f"Location '{profile.get('current_location')}' not in allowed list")

    # Resumes rarely state these outright — profile.notice_period_days/expected_salary is
    # populated either from the parser (if actually mentioned) or manually by HR afterwards
    # via POST /candidates/{id}/screening-details. Skipped entirely when either side is
    # unset, same convention as every other knockout check here.
    notice_period_days = profile.get("notice_period_days")
    if job.max_notice_period_days is not None and notice_period_days is not None:
        if notice_period_days > job.max_notice_period_days:
            reasons.append(
                f"Notice period is {notice_period_days} days, role allows up to "
                f"{job.max_notice_period_days}"
            )

    expected_salary = profile.get("expected_salary")
    if job.salary_band_max is not None and expected_salary is not None:
        if expected_salary > job.salary_band_max:
            reasons.append(
                f"Expected salary {expected_salary} exceeds the role's budget of "
                f"{job.salary_band_max}"
            )

    return (len(reasons) > 0, reasons)


def check_campus_knockout(
    campus_metadata: dict | None, job: Job
) -> tuple[bool, list[str]]:
    """Checks campus recruitment specific knockout criteria from structured roster data
    (CGPA, graduation year batch, degree/branch, standing backlogs).
    Guarded with strict None checks and graceful type casting."""
    if not campus_metadata or not getattr(job, "is_campus_drive", False):
        return (False, [])

    reasons: list[str] = []

    # 1. Minimum CGPA / Percentage Cutoff
    min_cgpa = getattr(job, "campus_min_cgpa", None)
    candidate_cgpa = campus_metadata.get("cgpa")
    if min_cgpa is not None and candidate_cgpa is not None:
        try:
            if float(candidate_cgpa) < float(min_cgpa):
                reasons.append(
                    f"Candidate CGPA/score {candidate_cgpa} is below the minimum required {min_cgpa}"
                )
        except (ValueError, TypeError):
            pass

    # 2. Eligible Passing Batch / Graduation Year
    allowed_batches = getattr(job, "campus_allowed_batches", None)
    candidate_batch = campus_metadata.get("graduation_year")
    if allowed_batches and candidate_batch is not None:
        try:
            allowed_set = {int(b) for b in allowed_batches if b is not None}
            if int(candidate_batch) not in allowed_set:
                reasons.append(
                    f"Graduation batch {candidate_batch} is not in eligible batches ({', '.join(map(str, allowed_batches))})"
                )
        except (ValueError, TypeError):
            pass

    # 3. Eligible Degree / Branch
    allowed_branches = getattr(job, "campus_allowed_branches", None)
    candidate_branch = (campus_metadata.get("degree_branch") or "").strip()
    if allowed_branches and candidate_branch:
        if not _match_campus_branch(candidate_branch, allowed_branches):
            reasons.append(
                f"Degree/Branch '{campus_metadata.get('degree_branch')}' is not in eligible campus branches ({', '.join(map(str, allowed_branches))})"
            )

    # 4. Max Allowable Standing Backlogs / Arrears
    max_backlogs = getattr(job, "campus_max_backlogs", None)
    candidate_backlogs = campus_metadata.get("standing_backlogs")
    if max_backlogs is not None and candidate_backlogs is not None:
        try:
            if int(candidate_backlogs) > int(max_backlogs):
                reasons.append(
                    f"Candidate has {candidate_backlogs} standing backlogs, maximum allowed is {max_backlogs}"
                )
        except (ValueError, TypeError):
            pass

    return (len(reasons) > 0, reasons)


