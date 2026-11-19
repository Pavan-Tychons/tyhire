import logging
from typing import Any

from app.services.openai_client import call_tool

logger = logging.getLogger(__name__)

# How many follow-up questions to surface to the interviewer at once.
MAX_FOLLOWUPS = 3

# --- Question mode: score the answer against a specific question + its expected concepts, and
# propose follow-ups grounded in what the candidate actually said. -----------------------------
ANSWER_EVAL_TOOL = {
    "type": "function",
    "function": {
        "name": "evaluate_interview_answer",
        "description": "Evaluates candidate answer accuracy, depth, concept coverage, whether it sounds scripted, and proposes sharp follow-up questions grounded in what the candidate actually said.",
        "parameters": {
            "type": "object",
            "properties": {
                "accuracy_score": {
                    "type": "number",
                    "description": "Overall technical accuracy and correctness score from 0 to 100.",
                },
                "verdict": {
                    "type": "string",
                    "enum": ["strong", "partially_correct", "superficial", "inaccurate", "scripted_delivery"],
                    "description": "Quick categorical verdict for HR decision making.",
                },
                "concepts_covered": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Expected concepts accurately addressed by candidate.",
                },
                "concepts_missing": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Important concepts or trade-offs that the candidate failed to mention.",
                },
                "depth_rating": {
                    "type": "string",
                    "enum": ["deep", "adequate", "surface"],
                    "description": "Level of technical depth exhibited.",
                },
                "fluff_detected": {
                    "type": "boolean",
                    "description": "True if the candidate used generic buzzwords without substantive technical depth.",
                },
                "teleprompter_speech_flag": {
                    "type": "boolean",
                    "description": "True if the response structure strongly resembles reading from an AI prompt/teleprompter (e.g. rigid bulleted list phrasing, unnatural robotic structure).",
                },
                "hr_summary": {
                    "type": "string",
                    "description": "1-2 sentence executive takeaway for the HR interviewer.",
                },
                "suggested_followups": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "1 to 3 immediate drill-down follow-up questions for HR to ask next, best first. Ground them in what the candidate actually said (probe a vague claim, verify a stated result, explore a project they mentioned) — not just a missing keyword.",
                },
            },
            "required": [
                "accuracy_score",
                "verdict",
                "concepts_covered",
                "concepts_missing",
                "depth_rating",
                "fluff_detected",
                "teleprompter_speech_flag",
                "hr_summary",
                "suggested_followups",
            ],
        },
    },
}

SYSTEM_PROMPT = """You are an expert technical evaluator assisting an interviewer in real time.
Analyze the candidate's spoken response against the question and the expected concepts.
Evaluate:
1. Technical Accuracy (0-100%): Are the principles, terminology, and mechanisms correct?
2. Concept Coverage: Which expected key concepts were covered vs missing?
3. Delivery Authenticity: Does the answer sound like an authentic explanation, or does it sound like reading from a ChatGPT prompt/teleprompter?
4. Provide a punchy 1-2 sentence HR summary and up to 3 sharp follow-up questions (best first) that
   drill into what the candidate ACTUALLY said — probe a vague claim, verify a stated outcome, or
   go deeper on a concept they touched — rather than merely naming a missing keyword.
"""

# --- Free-form mode: no specific question is active. Understand what the candidate just said and
# propose follow-ups from that alone. ----------------------------------------------------------
FREEFORM_FOLLOWUP_TOOL = {
    "type": "function",
    "function": {
        "name": "suggest_followups_from_answer",
        "description": "Understand what the candidate just said in a live interview and propose sharp drill-down follow-up questions, with no preset question to score against.",
        "parameters": {
            "type": "object",
            "properties": {
                "understanding": {
                    "type": "string",
                    "description": "1-2 sentence plain-language summary of what the candidate actually claimed, described, or implied.",
                },
                "suggested_followups": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "1 to 3 specific follow-up questions (best first) that probe a vague or unproven claim, verify depth/ownership, surface a trade-off, or explore an interesting thread the candidate opened. Ground each one in their actual words.",
                },
            },
            "required": ["understanding", "suggested_followups"],
        },
    },
}

FREEFORM_SYSTEM_PROMPT = """You assist an interviewer in real time. There is no preset question to
grade against — just the candidate's own words. Do two things:
1. Summarize, in 1-2 sentences, what the candidate actually claimed or described.
2. Propose up to 3 follow-up questions (best first) that a sharp interviewer would ask next —
   probe vague or unproven claims, verify real ownership and depth, surface trade-offs they
   skipped, or pull on an interesting thread they opened. Keep each question specific and grounded
   in what they said; avoid generic filler.
"""


def _clean_followups(raw: Any) -> list[str]:
    """Normalize the model's follow-up list: strings only, trimmed, de-duplicated, capped."""
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        text = str(item).strip()
        key = text.lower()
        if text and key not in seen:
            seen.add(key)
            out.append(text)
        if len(out) >= MAX_FOLLOWUPS:
            break
    return out


def _shape(
    *,
    mode: str,
    accuracy_score: float | None,
    verdict: str | None,
    concepts_covered: list[str],
    concepts_missing: list[str],
    depth_rating: str | None,
    fluff_detected: bool,
    teleprompter_speech_flag: bool,
    hr_summary: str,
    followups: list[str],
) -> dict[str, Any]:
    """One consistent response shape for both modes. `suggested_followup` (singular) is kept as the
    first follow-up for backward compatibility with any existing consumer."""
    followups = followups or ["Could you walk me through a specific example of that?"]
    return {
        "mode": mode,
        "accuracy_score": accuracy_score,
        "verdict": verdict,
        "concepts_covered": concepts_covered,
        "concepts_missing": concepts_missing,
        "depth_rating": depth_rating,
        "fluff_detected": fluff_detected,
        "teleprompter_speech_flag": teleprompter_speech_flag,
        "hr_summary": hr_summary,
        "suggested_followups": followups,
        "suggested_followup": followups[0],
    }


def _freeform_followups(candidate_transcript: str, job_context: str) -> dict[str, Any]:
    user_content = f"""Role Context: {job_context}

The candidate just said (live interview transcript):
"{candidate_transcript}"

Summarize what they actually claimed, then suggest up to 3 follow-up questions that probe or verify it."""
    try:
        result = call_tool(
            system=FREEFORM_SYSTEM_PROMPT,
            user_content=user_content,
            tool=FREEFORM_FOLLOWUP_TOOL,
        )
        understanding = (result.get("understanding") or "").strip() or "Candidate response noted."
        followups = _clean_followups(result.get("suggested_followups"))
    except Exception as exc:  # noqa: BLE001 - normalize every OpenAI failure to a graceful fallback
        logger.warning("Free-form follow-up suggestion failed: %s. Returning heuristic fallback.", exc)
        understanding = "The candidate gave a response; AI follow-up suggestions are momentarily unavailable."
        followups = ["Could you give me a concrete example of that from your own experience?"]
    return _shape(
        mode="freeform",
        accuracy_score=None,
        verdict=None,
        concepts_covered=[],
        concepts_missing=[],
        depth_rating=None,
        fluff_detected=False,
        teleprompter_speech_flag=False,
        hr_summary=understanding,
        followups=followups,
    )


def evaluate_live_answer(
    question_text: str | None = None,
    expected_concepts: list[str] | None = None,
    candidate_transcript: str = "",
    job_context: str = "Software Engineering",
) -> dict[str, Any]:
    """Evaluate a candidate's live answer and suggest follow-up questions.

    Two modes, one OpenAI call:
    * Question mode (``question_text`` given) — score the answer against the question + expected
      concepts AND suggest follow-ups grounded in what they said.
    * Free-form mode (no ``question_text``) — no scoring; understand what the candidate said and
      suggest follow-ups from that alone. This is what lets follow-ups work during open
      conversation, not only when a suggested question is selected.
    """
    expected_concepts = expected_concepts or []
    candidate_transcript = (candidate_transcript or "").strip()
    freeform = not (question_text and question_text.strip())

    if len(candidate_transcript) < 10:
        if freeform:
            return _shape(
                mode="freeform",
                accuracy_score=None,
                verdict=None,
                concepts_covered=[],
                concepts_missing=[],
                depth_rating=None,
                fluff_detected=False,
                teleprompter_speech_flag=False,
                hr_summary="Candidate has not said enough yet to suggest a follow-up.",
                followups=["Could you tell me a bit more about that?"],
            )
        return _shape(
            mode="question",
            accuracy_score=0.0,
            verdict="inaccurate",
            concepts_covered=[],
            concepts_missing=expected_concepts,
            depth_rating="surface",
            fluff_detected=False,
            teleprompter_speech_flag=False,
            hr_summary="Candidate has not provided a substantive answer yet.",
            followups=["Could you provide a detailed technical walkthrough of this?"],
        )

    if freeform:
        return _freeform_followups(candidate_transcript, job_context)

    user_content = f"""Role Context: {job_context}
Question Asked: {question_text}
Expected Key Concepts: {', '.join(expected_concepts) if expected_concepts else 'Domain standard concepts'}

Candidate's Spoken Answer Transcript:
"{candidate_transcript}"

Evaluate the accuracy, key concepts covered vs missing, authenticity, and suggest up to 3 follow-up questions grounded in what they said."""

    try:
        result = call_tool(
            system=SYSTEM_PROMPT,
            user_content=user_content,
            tool=ANSWER_EVAL_TOOL,
        )
        return _shape(
            mode="question",
            accuracy_score=result.get("accuracy_score"),
            verdict=result.get("verdict"),
            concepts_covered=result.get("concepts_covered") or [],
            concepts_missing=result.get("concepts_missing") or [],
            depth_rating=result.get("depth_rating"),
            fluff_detected=bool(result.get("fluff_detected")),
            teleprompter_speech_flag=bool(result.get("teleprompter_speech_flag")),
            hr_summary=(result.get("hr_summary") or "").strip() or "Evaluation complete.",
            followups=_clean_followups(result.get("suggested_followups")),
        )
    except Exception as exc:  # noqa: BLE001 - graceful heuristic fallback on any OpenAI failure
        logger.warning("AI answer evaluation failed: %s. Returning heuristic fallback.", exc)
        word_count = len(candidate_transcript.split())
        matched = [c for c in expected_concepts if c.lower() in candidate_transcript.lower()]
        missing = [c for c in expected_concepts if c not in matched]
        score = min(90.0, max(20.0, (len(matched) / max(1, len(expected_concepts))) * 80.0 + (10 if word_count > 30 else 0)))
        return _shape(
            mode="question",
            accuracy_score=round(score, 1),
            verdict="partially_correct" if score >= 50 else "superficial",
            concepts_covered=matched,
            concepts_missing=missing,
            depth_rating="adequate" if word_count > 40 else "surface",
            fluff_detected=False,
            teleprompter_speech_flag=False,
            hr_summary=f"Candidate addressed {len(matched)} of {len(expected_concepts)} key concepts.",
            followups=[f"Can you elaborate on how you implement {missing[0] if missing else 'the edge cases'}?"],
        )
