import logging
import uuid
from typing import Any
from fpdf import FPDF
from sqlalchemy.orm import Session

from app.models.candidate import AuditLog, Candidate
from app.models.job import Job
from app.models.interview import IdentityCheck, IntegrityFlag, InterviewSession
from app.services import smtp_settings

logger = logging.getLogger(__name__)

_CHAR_REPLACEMENTS = {
    "✓": "[Yes]", "✔": "[Yes]",
    "✗": "[No]", "✘": "[No]",
    "—": "-", "–": "-",
    "‘": "'", "’": "'",
    "“": '"', "”": '"',
    "…": "...",
}


def _sanitize(text: str) -> str:
    for orig, rep in _CHAR_REPLACEMENTS.items():
        text = text.replace(orig, rep)
    if any(ord(ch) > 255 for ch in text):
        text = text.encode("latin-1", "replace").decode("latin-1")
    return text


def build_consolidated_report(db: Session, session_id: uuid.UUID) -> dict[str, Any]:
    session = db.get(InterviewSession, session_id)
    if not session:
        raise ValueError(f"Interview session {session_id} not found")

    candidate = db.get(Candidate, session.candidate_id) if session.candidate_id else None
    job = db.get(Job, session.job_id) if session.job_id else None
    flags = db.query(IntegrityFlag).filter(IntegrityFlag.session_id == session.id).all()
    identity_check = (
        db.query(IdentityCheck)
        .filter(IdentityCheck.session_id == session.id)
        .order_by(IdentityCheck.created_at.desc())
        .first()
    )

    # Consolidated scorecard metrics
    fit_score = candidate.fit_score if candidate else None
    effective_fit_score = fit_score
    if candidate and candidate.manual_score_adjustment:
        effective_fit_score = max(0.0, min(100.0, (fit_score or 0) + candidate.manual_score_adjustment))

    # Real interview score = the average AI accuracy across the questions actually evaluated this
    # interview. Unlike fit_score (resume screening, often absent for interview-only candidates),
    # this reflects how the candidate performed in THIS interview. None when nothing was evaluated.
    qa_evals_list = session.qa_evaluations or []
    scored_accuracies = [
        e["accuracy_score"]
        for e in qa_evals_list
        if isinstance(e, dict) and isinstance(e.get("accuracy_score"), (int, float))
    ]
    interview_qa_score = round(sum(scored_accuracies) / len(scored_accuracies), 1) if scored_accuracies else None

    return {
        "session_id": str(session.id),
        "candidate_name": session.candidate_name,
        "candidate_email": candidate.email if candidate else None,
        # Prefer a linked Job's title; else the title typed at scheduling (TYH-020); else N/A.
        "job_title": (job.title if job else None) or session.job_title or "N/A",
        "interview_date": session.started_at.strftime("%Y-%m-%d %H:%M UTC") if session.started_at else "N/A",
        "status": session.status.value,
        "fit_score": effective_fit_score,
        "fit_score_breakdown": candidate.score_breakdown if candidate else None,
        "interview_qa_score": interview_qa_score,
        "evaluated_questions_count": len(scored_accuracies),
        "integrity_score": session.integrity_score,
        "integrity_needs_review": session.integrity_needs_review,
        "flagged_moments_count": len(flags),
        "flagged_moments": [
            {
                "session_offset_ms": f.session_offset_ms,
                "severity": f.severity,
                "summary": f.summary,
                "reviewed": f.reviewed,
                "reviewer_decision": f.reviewer_decision,
            }
            for f in flags
        ],
        "identity_verification": {
            "verdict": identity_check.match_verdict if identity_check else "not_performed",
            "confidence": identity_check.match_confidence if identity_check else None,
            "cleared_by_hr": identity_check.cleared_by_hr if identity_check else False,
        },
        "sentiment_trend": session.sentiment_trend,
        "voice_tone_analysis": session.voice_tone_analysis,
        "facial_affect_analysis": session.facial_affect_analysis,
        "qa_analysis": session.qa_analysis,
        "qa_evaluations": session.qa_evaluations or [],
        "interviewer_decision": session.interviewer_live_decision,
        "interviewer_notes": session.interviewer_live_notes,
        "transcript_preview": (session.merged_transcript or session.transcript or "")[:2000],
    }


def build_consolidated_report_pdf(report: dict[str, Any]) -> bytes:
    pdf = FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)

    # Title
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 10, "Consolidated Interview Evaluation Scorecard", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    # Candidate & Job Info
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(35, 6, "Candidate:", 0, 0)
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 6, _sanitize(report.get("candidate_name") or "Unnamed"), new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(35, 6, "Role / Job:", 0, 0)
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 6, _sanitize(report.get("job_title") or "N/A"), new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(35, 6, "Date & Time:", 0, 0)
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 6, _sanitize(str(report.get("interview_date"))), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    # Executive Score Banner
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 8, "Overall Consolidated Ratings", new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "", 10)
    iv = report.get("interview_qa_score")
    n_eval = report.get("evaluated_questions_count") or 0
    iv_str = f"{iv:.0f}/100 ({n_eval} Q)" if iv is not None else "No answers evaluated"
    fit = report.get("fit_score")
    fit_str = f"{fit:.0f}/100" if fit is not None else "Not Scored"
    integ = report.get("integrity_score")
    integ_str = f"{integ:.1f}/100" if integ is not None else "Pending"
    decision = report.get("interviewer_decision") or "No decision"

    pdf.cell(0, 7, f"Interview Q&A Score: {iv_str}", 1, 1, "C")
    pdf.cell(60, 7, f"AI Fit (Resume): {fit_str}", 1, 0, "C")
    pdf.cell(65, 7, f"Proctoring Integrity: {integ_str}", 1, 0, "C")
    pdf.cell(65, 7, f"Interviewer Decision: {decision.capitalize()}", 1, 1, "C")
    pdf.ln(4)

    # Interviewer Notes
    if report.get("interviewer_notes"):
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 6, "Interviewer Notes:", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 10)
        pdf.multi_cell(0, 5, _sanitize(report["interviewer_notes"]), new_x="LMARGIN", new_y="NEXT")
        pdf.ln(2)

    # Proctoring & Integrity Flags
    flags = report.get("flagged_moments") or []
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 7, f"Proctoring Analysis ({len(flags)} flagged moments)", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    if not flags:
        pdf.cell(0, 6, "- Clean session: No proctoring anomalies or gaze violations detected.", new_x="LMARGIN", new_y="NEXT")
    else:
        for f in flags[:8]:
            sec = int(f.get("session_offset_ms", 0) / 1000)
            mins = sec // 60
            secs = sec % 60
            pdf.multi_cell(
                0, 5,
                f"- [{mins:02d}:{secs:02d}] { _sanitize(f.get('summary', '')) } (Severity: {f.get('severity', 0)})",
                new_x="LMARGIN", new_y="NEXT",
            )
    pdf.ln(3)

    # Sentiment & Voice/Facial Affect
    sentiment = report.get("sentiment_trend")
    voice = report.get("voice_tone_analysis")
    facial = report.get("facial_affect_analysis")

    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 7, "Sentiment, Voice & Facial Engagement", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)

    if sentiment and isinstance(sentiment, dict):
        summary = _sanitize(sentiment.get("summary", "N/A"))
        pdf.multi_cell(0, 5, f"Sentiment Trend: {summary}", new_x="LMARGIN", new_y="NEXT")

    if voice and isinstance(voice, dict) and not voice.get("error"):
        tone = _sanitize(str(voice.get("overall_tone", "N/A")))
        conf = _sanitize(str(voice.get("confidence_level", "N/A")))
        pdf.cell(0, 5, f"Voice Tone: {tone.capitalize()} (Confidence: {conf})", new_x="LMARGIN", new_y="NEXT")

    if facial and isinstance(facial, dict) and not facial.get("error") and facial.get("face_visible"):
        affect = _sanitize(str(facial.get("overall_affect", "N/A")))
        tension = _sanitize(str(facial.get("tension_level", "N/A")))
        pdf.cell(0, 5, f"Facial Affect: {affect.capitalize()} (Tension Level: {tension})", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    # Q&A Exchanges & Evaluated Question Accuracy Breakdown
    qa_evals = report.get("qa_evaluations") or []
    if qa_evals:
        pdf.set_font("Helvetica", "B", 12)
        pdf.cell(0, 7, f"AI-Evaluated Question Scorecard ({len(qa_evals)} questions)", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 9)
        for ev in qa_evals[:6]:
            q_txt = _sanitize(ev.get("question_text", "Question"))
            score = ev.get("accuracy_score")
            score_str = f"Accuracy: {score:.0f}/100" if score is not None else "Accuracy: Pending"
            rating = _sanitize(str(ev.get("rating", "")).replace("_", " ").capitalize())
            notes = _sanitize(ev.get("notes", "") or "")

            pdf.set_font("Helvetica", "B", 9)
            pdf.multi_cell(0, 5, f"Q: {q_txt} [{score_str} | Rating: {rating}]", new_x="LMARGIN", new_y="NEXT")
            if notes:
                pdf.set_font("Helvetica", "I", 8)
                pdf.multi_cell(0, 4, f"  Notes: {notes}", new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1)
        pdf.ln(2)

    qa = report.get("qa_analysis")
    if qa and isinstance(qa, dict) and qa.get("exchanges"):
        pdf.set_font("Helvetica", "B", 12)
        pdf.cell(0, 7, "Q&A Assessment Summary", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 9)
        for ex in qa["exchanges"][:4]:
            q = _sanitize(ex.get("question", ""))
            a = _sanitize(ex.get("answer", ""))
            v = _sanitize(ex.get("verdict", "").replace("_", " ").capitalize())
            pdf.set_font("Helvetica", "B", 9)
            pdf.multi_cell(0, 5, f"Q: {q}", new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Helvetica", "", 9)
            pdf.multi_cell(0, 5, f"A: {a} [{v}]", new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1)

    return bytes(pdf.output())


def send_consolidated_report(db: Session, session_id: uuid.UUID, recipient_email: str) -> dict[str, Any]:
    report = build_consolidated_report(db, session_id)
    pdf_bytes = build_consolidated_report_pdf(report)

    candidate_name = report.get("candidate_name") or "the candidate"
    body = (
        f"Consolidated interview evaluation for {candidate_name}.\n\n"
        f"Overall fit score: {report.get('fit_score')}\n"
        f"Integrity score: {report.get('integrity_score')}\n\n"
        f"The full evaluation scorecard is attached as a PDF.\n\n"
        f"— TyHire"
    )

    # Actually email the report (TYH-003). Raises SmtpNotConfiguredError / SmtpSendError, which
    # the API layer turns into a clear 409/502 — the audit row is written only after a real send
    # succeeds, so "report sent" in the log/audit trail never overstates what happened.
    smtp_settings.send_email(
        to_email=recipient_email,
        subject=f"Interview Evaluation — {candidate_name}",
        body_text=body,
        attachments=[(f"evaluation_{session_id}.pdf", pdf_bytes, "application", "pdf")],
    )

    db.add(
        AuditLog(
            interview_session_id=session_id,
            actor="system",
            action="consolidated_report_sent",
            detail={
                "recipient": recipient_email,
                "candidate_name": report.get("candidate_name"),
                "fit_score": report.get("fit_score"),
                "integrity_score": report.get("integrity_score"),
                "pdf_size_bytes": len(pdf_bytes),
            },
        )
    )
    db.commit()

    logger.info("Consolidated report emailed to %s for session %s", recipient_email, session_id)

    return {
        "status": "sent",
        "recipient": recipient_email,
        "session_id": str(session_id),
        "report": report,
    }
