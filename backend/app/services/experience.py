"""Derives actual professional experience from employment history dates.

The resume's own `total_years_experience` is whatever the candidate wrote — it is a claim,
not a measurement, and it is routinely rounded up, left stale from an older version of the
CV, or counted from the start of a degree. Screening a candidate in or out on that figure
means screening on a self-reported number.

This computes the figure from the work-history date ranges instead, and surfaces two things
the stated total can't express: time counted once when roles overlap (a volunteer or
part-time role running alongside a full-time one is not double experience), and gaps between
roles, which a recruiter usually wants to ask about rather than have silently averaged away.

Pure date arithmetic — no AI. The same resume always produces the same number, which is what
makes it safe to put behind an eligibility rule.
"""

import re
from datetime import date

# Short breaks between jobs are normal (notice periods, a month off, a delayed start) and
# flagging them would bury the ones worth asking about.
GAP_MIN_MONTHS = 3

_PRESENT_TOKENS = {
    "present", "current", "currently", "now", "to date", "till date", "todate",
    "till now", "ongoing", "date", "present day",
}

_MONTH_NAMES = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}


def _month_index(year: int, month: int) -> int:
    """Calendar position as a single integer, so ranges are plain arithmetic."""
    return year * 12 + (month - 1)


def _label(index: int) -> str:
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


def _parse_month(raw: str | None, *, is_end: bool, today_index: int) -> tuple[int | None, bool]:
    """Parses one end of a date range to a month index.

    Returns (index, approximate). `approximate` marks a year with no month in it: the span
    is then stretched to the widest reading (January for a start, December for an end).
    That direction is deliberate — the alternative is quietly *under*-counting someone's
    experience and failing them an eligibility rule they actually meet.
    """
    if raw is None:
        return (today_index, False) if is_end else (None, False)

    text = str(raw).strip().lower()
    if not text:
        return (today_index, False) if is_end else (None, False)

    if any(token in text for token in _PRESENT_TOKENS):
        return today_index, False

    # YYYY-MM / YYYY/MM (an optional day is ignored)
    match = re.search(r"\b(\d{4})[-/.](\d{1,2})\b", text)
    if match:
        year, month = int(match.group(1)), int(match.group(2))
        if 1 <= month <= 12:
            return _month_index(year, month), False

    # MM-YYYY / MM/YYYY
    match = re.search(r"\b(\d{1,2})[-/.](\d{4})\b", text)
    if match:
        month, year = int(match.group(1)), int(match.group(2))
        if 1 <= month <= 12:
            return _month_index(year, month), False

    # "Jan 2021", "January-2021", "2021 Jan"
    match = re.search(r"\b([a-z]{3,9})\.?\s*[-/,]?\s*(\d{4})\b", text)
    if match and match.group(1) in _MONTH_NAMES:
        return _month_index(int(match.group(2)), _MONTH_NAMES[match.group(1)]), False
    match = re.search(r"\b(\d{4})\s*[-/,]?\s*([a-z]{3,9})\b", text)
    if match and match.group(2) in _MONTH_NAMES:
        return _month_index(int(match.group(1)), _MONTH_NAMES[match.group(2)]), False

    # Year alone — widest reading, flagged as approximate.
    match = re.search(r"\b(\d{4})\b", text)
    if match:
        year = int(match.group(1))
        return (_month_index(year, 12) if is_end else _month_index(year, 1)), True

    return None, False


def analyze_experience(profile: dict, today: date | None = None) -> dict:
    """Measures experience from `profile["work_history"]`.

    Returns a dict carrying both the computed and the claimed figure, which role dates
    couldn't be read, and any gaps worth asking about. Never raises on malformed input —
    an unreadable history yields computed_years=None and the caller falls back to the
    stated figure rather than treating the candidate as having no experience.
    """
    today = today or date.today()
    today_index = _month_index(today.year, today.month)

    claimed = profile.get("total_years_experience")
    try:
        claimed_years = round(float(claimed), 1) if claimed is not None else None
    except (TypeError, ValueError):
        claimed_years = None

    history = profile.get("work_history") or []
    if not isinstance(history, list):
        history = []

    intervals: list[tuple[int, int]] = []
    unparsed: list[str] = []
    approximate = False
    currently_employed = False

    for entry in history:
        if not isinstance(entry, dict):
            continue
        role = " at ".join(
            str(entry.get(k)).strip()
            for k in ("title", "company")
            if entry.get(k) and str(entry.get(k)).strip()
        ) or "Unnamed role"

        start, start_approx = _parse_month(entry.get("start_date"), is_end=False, today_index=today_index)
        end, end_approx = _parse_month(entry.get("end_date"), is_end=True, today_index=today_index)

        if start is None or end is None:
            unparsed.append(role)
            continue

        # A role that hasn't ended yet, and anything dated into the future (a typo, or a
        # start date written as the year ahead), is measured only up to today.
        if end >= today_index:
            currently_employed = True
        end = min(end, today_index)

        if end < start:
            unparsed.append(role)
            continue

        approximate = approximate or start_approx or end_approx
        intervals.append((start, end))

    if not intervals:
        return {
            "computed_years": None,
            "claimed_years": claimed_years,
            "basis": "stated" if claimed_years is not None else "none",
            "approximate": False,
            "unparsed_roles": unparsed,
            "currently_employed": False,
            "gaps": [],
            "total_gap_months": 0,
            "discrepancy_years": None,
        }

    # Overlapping and back-to-back roles are merged so concurrent work counts once. Two
    # simultaneous jobs are not two careers' worth of experience.
    intervals.sort()
    merged: list[list[int]] = [list(intervals[0])]
    for start, end in intervals[1:]:
        if start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    # Inclusive of both endpoints: a role from Jan to Jan is one month worked, not zero.
    total_months = sum(end - start + 1 for start, end in merged)
    computed_years = round(total_months / 12, 1)

    gaps = []
    for earlier, later in zip(merged, merged[1:]):
        gap_months = later[0] - earlier[1] - 1
        if gap_months >= GAP_MIN_MONTHS:
            gaps.append({
                "start": _label(earlier[1] + 1),
                "end": _label(later[0] - 1),
                "months": gap_months,
                "ongoing": False,
            })

    # A still-open gap at the end is the one a recruiter most often wants to raise.
    trailing_gap = today_index - merged[-1][1]
    if trailing_gap >= GAP_MIN_MONTHS:
        gaps.append({
            "start": _label(merged[-1][1] + 1),
            "end": _label(today_index),
            "months": trailing_gap,
            "ongoing": True,
        })

    discrepancy = (
        round(claimed_years - computed_years, 1) if claimed_years is not None else None
    )

    return {
        "computed_years": computed_years,
        "claimed_years": claimed_years,
        # Only "employment_history" when every role was readable — a partially-parsed
        # history would understate the total, and understating it fails people who qualify.
        "basis": "employment_history" if not unparsed else "stated",
        "approximate": approximate,
        "unparsed_roles": unparsed,
        "currently_employed": currently_employed,
        "gaps": gaps,
        "total_gap_months": sum(g["months"] for g in gaps),
        "discrepancy_years": discrepancy,
    }


def effective_years(profile: dict, today: date | None = None) -> float | None:
    """The experience figure eligibility rules should be judged on.

    Prefers the measured value, falls back to the resume's stated one when the history
    couldn't be read in full. Returning None means "unknown" — callers must skip the check
    rather than treat it as zero.
    """
    analysis = analyze_experience(profile, today=today)
    if analysis["basis"] == "employment_history":
        return analysis["computed_years"]
    return analysis["claimed_years"]
