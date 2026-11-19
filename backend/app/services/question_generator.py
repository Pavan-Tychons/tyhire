import logging
from typing import Any
from app.services.openai_client import call_tool

logger = logging.getLogger(__name__)

QUESTION_GEN_TOOL = {
    "type": "function",
    "function": {
        "name": "generate_tailored_interview_questions",
        "description": "Generates a curated set of structured interview questions comparing candidate resume against job requirements.",
        "parameters": {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "List of 6-8 tailored interview questions.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Unique short slug e.g. q1_indexing"},
                            "category": {
                                "type": "string",
                                "enum": ["Technical Core", "Architecture & Design", "Problem Solving", "Experience Deep-Dive"],
                            },
                            "question": {"type": "string", "description": "The exact question text for HR/interviewer to speak."},
                            "context_reason": {"type": "string", "description": "Brief explanation of why this question is valuable for this candidate."},
                            "expected_concepts": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "3-5 essential keywords/concepts expected in an accurate answer.",
                            },
                            "difficulty": {"type": "string", "enum": ["foundational", "intermediate", "advanced"]},
                        },
                        "required": ["id", "category", "question", "context_reason", "expected_concepts", "difficulty"],
                    },
                }
            },
            "required": ["questions"],
        },
    },
}

SYSTEM_PROMPT = """You are an expert technical interviewer assistant.
Your job is to generate 6-8 insightful, high-signal interview questions tailored specifically to the candidate's resume and the job requirements.
Focus on:
1. Verifying deep technical competencies required by the JD.
2. Probing claims in the candidate's resume where depth needs validation.
3. Providing clear, objective 'expected_concepts' (3-5 items) that represent an accurate answer.
"""


def generate_suggested_questions(
    job_title: str,
    jd_text: str,
    required_skills: list[str],
    candidate_profile: dict[str, Any] | None = None,
    candidate_name: str = "Candidate",
    vary: bool = False,
) -> list[dict[str, Any]]:
    profile_summary = ""
    if candidate_profile:
        skills = candidate_profile.get("skills", [])
        experience = candidate_profile.get("experience", [])
        profile_summary = f"Candidate Profile:\n- Stated Skills: {skills}\n- Experience: {experience}"

    user_content = f"""Role Title: {job_title}
Job Description & Requirements:
{jd_text[:2500]}
Required Skills: {', '.join(required_skills) if required_skills else 'Standard for role'}

Candidate Name: {candidate_name}
{profile_summary}

Please generate 6 to 8 structured interview questions with expected key concepts for each."""

    try:
        # When the interviewer asks to refresh (vary=True), raise the temperature and drop the
        # fixed seed so the model returns a genuinely different set rather than the same one.
        result = call_tool(
            system=SYSTEM_PROMPT,
            user_content=user_content,
            tool=QUESTION_GEN_TOOL,
            **({"temperature": 0.9, "seed": None} if vary else {}),
        )
        return result.get("questions", [])
    except Exception as exc:
        logger.warning("AI question generation failed: %s. Falling back to default questions.", exc)
        # Resilient fallback questions if OpenAI call is throttled or fails
        return [
            {
                "id": "q1_core_tech",
                "category": "Technical Core",
                "question": f"Can you explain your experience and architecture approach with the core tech stack for {job_title}?",
                "context_reason": "Core foundational check against job requirements.",
                "expected_concepts": ["Framework fundamentals", "Design patterns", "Performance trade-offs"],
                "difficulty": "intermediate",
            },
            {
                "id": "q2_system_design",
                "category": "Architecture & Design",
                "question": "How do you handle scalability, caching, and error resilience in high-traffic applications?",
                "context_reason": "Evaluates architectural depth and production readiness.",
                "expected_concepts": ["Caching strategy", "Failover resilience", "Database optimization"],
                "difficulty": "advanced",
            },
            {
                "id": "q3_debugging",
                "category": "Problem Solving",
                "question": "Describe a complex production incident or bug you diagnosed and how you resolved it.",
                "context_reason": "Tests real-world troubleshooting ability.",
                "expected_concepts": ["Root cause analysis", "Monitoring/telemetry", "Preventative measures"],
                "difficulty": "intermediate",
            },
            {
                "id": "q4_project_impact",
                "category": "Experience Deep-Dive",
                "question": "Walk us through the most impactful project on your resume and your specific contributions.",
                "context_reason": "Validates actual hands-on role vs resume claims.",
                "expected_concepts": ["Specific deliverables", "Technical decisions", "Quantifiable outcomes"],
                "difficulty": "foundational",
            },
        ]
