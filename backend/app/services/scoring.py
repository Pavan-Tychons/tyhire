import json

from app.models.job import Job, JobLevel
from app.services.openai_client import call_tool

CATEGORIES = ("skills", "experience", "education", "certifications", "communication")


def _subscore_schema(criterion: str) -> dict:
    return {
        "type": "object",
        "description": f"0-100 fit score for {criterion}.",
        "properties": {
            "score": {"type": "number"},
            "reasons": {
                "type": "array",
                "description": (
                    "Short, specific reasons citing the JD's actual criteria, e.g. "
                    "'JD required 3+ yrs cloud, candidate has 0 ✗' or "
                    "'Built a Kafka-based project in final year ✓'."
                ),
                "items": {"type": "string"},
            },
        },
        "required": ["score", "reasons"],
    }


SCORE_TOOL = {
    "type": "function",
    "function": {
        "name": "record_fit_subscores",
        "description": (
            "Records per-category fit sub-scores, skill relevancy categorization, and "
            "profession fit analysis for a candidate against a job — each independently "
            "explainable rather than one opaque overall number."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "skills_score": _subscore_schema("required/preferred technical & role skills match"),
                "experience_score": _subscore_schema("work history, tenure, role progression"),
                "education_score": _subscore_schema("degree relevance, grades, coursework"),
                "certifications_score": _subscore_schema("relevant certifications and credentials"),
                "communication_score": _subscore_schema(
                    "written clarity, structure, conciseness, project impact articulation in resume"
                ),
                "skills_breakdown": {
                    "type": "object",
                    "description": "Granular classification of candidate skills against JD requirements.",
                    "properties": {
                        "relevant_skills": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Skills on candidate resume that directly match and fulfill JD requirements.",
                        },
                        "missing_critical_skills": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Critical/required skills mandated by JD that candidate lacks.",
                        },
                        "irrelevant_skills": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Skills listed on resume that are irrelevant or out-of-scope for this role.",
                        },
                    },
                    "required": ["relevant_skills", "missing_critical_skills", "irrelevant_skills"],
                },
                "profession_fit": {
                    "type": "object",
                    "description": "Assessment of candidate's profession alignment, seniority ladder, and industry domain experience.",
                    "properties": {
                        "seniority_match": {
                            "type": "string",
                            "description": "Evaluation of whether candidate seniority aligns with role (e.g. 'Strong Senior match with 5+ yrs relevant tenure').",
                        },
                        "domain_alignment": {
                            "type": "string",
                            "description": "Relevance of candidate industry/domain background (e.g. 'Direct FinTech / SaaS experience').",
                        },
                        "career_trajectory_score": {
                            "type": "number",
                            "description": "0-100 score on career trajectory, title consistency, and growth.",
                        },
                        "verdict": {
                            "type": "string",
                            "enum": ["aligned", "partial", "misaligned"],
                            "description": "Overall professional trajectory verdict.",
                        },
                        "insights": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "1-3 concise bullet points on profession & career fit.",
                        },
                    },
                    "required": [
                        "seniority_match",
                        "domain_alignment",
                        "career_trajectory_score",
                        "verdict",
                        "insights",
                    ],
                },
            },
            "required": [f"{c}_score" for c in CATEGORIES] + ["skills_breakdown", "profession_fit"],
        },
    },
}

FRESHER_GUIDANCE = (
    "This job is marked FRESHER/entry-level. The candidate has no required prior work history. "
    "Weigh education (degree relevance, grades), academic projects, internships, certifications, "
    "and demonstrated skills from coursework/projects over work tenure. Do not penalize for having "
    "zero years of professional experience if the JD does not require it."
)

EXPERIENCED_GUIDANCE = (
    "This job is marked EXPERIENCED. Weigh work history, tenure, role progression, and demonstrated "
    "on-the-job use of required skills over academic background alone."
)


def _redact_for_scoring(profile: dict) -> dict:
    """Strips identity fields the scoring model never needs. Fit-scoring only ever reasons
    about skills/experience/education, so there's no reason it should see who the candidate
    is — this converts 'the model was told not to use the name' into 'the model structurally
    couldn't,' which matters if a score is ever challenged for bias."""
    return {k: v for k, v in profile.items() if k not in ("full_name", "email", "phone")}


def score_candidate(
    profile: dict, job: Job
) -> tuple[float, float, float, list[str], dict, dict, dict]:
    """Returns (fit_score, technical_score, communication_score, all_reasons, breakdown, skills_breakdown, profession_fit).

    The model produces the five category sub-scores along with skill relevancy and profession fit in
    a single unified tool call. The overall fit_score and technical_score are computed deterministically
    from those sub-scores normalized by the active weights on the Job, preserving full auditability.
    """
    guidance = FRESHER_GUIDANCE if job.level == JobLevel.fresher else EXPERIENCED_GUIDANCE
    system = (
        "You are an explainable resume-screening scorer for an ATS. Score each category "
        "strictly against the JD's stated criteria, not generic 'good candidate' impressions. "
        "Classify skills into relevant, missing critical, and irrelevant/extraneous skills. "
        "Evaluate profession alignment, seniority ladder, and industry domain fit. "
        "Every reason must be traceable to either the JD or the candidate profile provided. "
        + guidance
    )
    user_content = (
        f"Job Description:\n{job.jd_text}\n\n"
        f"Required skills: {', '.join(job.required_skills or [])}\n"
        f"Core skills: {', '.join(getattr(job, 'core_skills', []) or [])}\n"
        f"Secondary skills: {', '.join(getattr(job, 'secondary_skills', []) or [])}\n\n"
        f"Candidate profile (JSON):\n{json.dumps(_redact_for_scoring(profile), indent=2)}"
    )
    result = call_tool(system=system, user_content=user_content, tool=SCORE_TOOL)

    breakdown: dict = {}
    all_reasons: list[str] = []
    weighted_total = 0.0
    active_weight_sum = 0.0

    tech_categories = ("skills", "experience", "certifications")
    tech_weighted_total = 0.0
    tech_weight_sum = 0.0

    for category in CATEGORIES:
        entry = result.get(f"{category}_score") or {"score": 50, "reasons": []}
        score = float(entry["score"])
        reasons = list(entry.get("reasons") or [])
        breakdown[category] = {"score": score, "reasons": reasons}
        all_reasons.extend(f"[{category}] {r}" for r in reasons)
        weight = getattr(job, f"weight_{category}", None)
        if weight is None:
            weight = 0.0 if category == "communication" else 0.25
        weight = float(weight)
        weighted_total += score * weight
        active_weight_sum += weight

        if category in tech_categories:
            tech_weighted_total += score * weight
            tech_weight_sum += weight

    overall_fit = round(weighted_total / active_weight_sum, 1) if active_weight_sum > 0 else 0.0
    tech_score = (
        round(tech_weighted_total / tech_weight_sum, 1)
        if tech_weight_sum > 0
        else float(breakdown.get("skills", {}).get("score", 0))
    )
    comm_score = float(breakdown.get("communication", {}).get("score", 0))

    skills_breakdown = result.get(
        "skills_breakdown",
        {
            "relevant_skills": [],
            "missing_critical_skills": [],
            "irrelevant_skills": [],
        },
    )
    profession_fit = result.get(
        "profession_fit",
        {
            "seniority_match": "Standard match",
            "domain_alignment": "Relevant domain",
            "career_trajectory_score": 75.0,
            "verdict": "aligned",
            "insights": [],
        },
    )

    return (
        overall_fit,
        tech_score,
        comm_score,
        all_reasons,
        breakdown,
        skills_breakdown,
        profession_fit,
    )
