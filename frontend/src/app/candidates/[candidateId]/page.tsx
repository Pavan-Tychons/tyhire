"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { BASE_URL, deleteJson, getJson, postJson } from "@/lib/api";
import { getIntegrityScoreBand } from "@/lib/integrityLabel";
import { getScoreLabel } from "@/lib/scoreLabel";
import { useDialog } from "@/components/Dialog";
import L1AudioUploader from "@/components/L1AudioUploader";
import type { Bucket, Candidate, InterviewSession } from "@/lib/types";

const CATEGORIES = ["skills", "experience", "education", "certifications", "communication"] as const;

export default function CandidateDetailPage() {
  const { prompt } = useDialog();
  const { candidateId } = useParams<{ candidateId: string }>();
  const router = useRouter();
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [sessions, setSessions] = useState<InterviewSession[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [interviewSession, setInterviewSession] = useState<InterviewSession | null>(null);

  const refresh = useCallback(() => {
    getJson<Candidate>(`/candidates/${candidateId}`)
      .then(setCandidate)
      .catch(() => setNotFound(true));
    getJson<InterviewSession[]>(`/interviews/by-candidate/${candidateId}`)
      .then(setSessions)
      .catch(() => {});
  }, [candidateId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleManualAdjustment(adjustment: number, reason: string) {
    await postJson(`/candidates/${candidateId}/manual-adjustment`, { adjustment, reason });
    refresh();
  }

  async function handleScreeningDetails(noticePeriodDays: number | null, expectedSalary: number | null) {
    await postJson(`/candidates/${candidateId}/screening-details`, {
      notice_period_days: noticePeriodDays,
      expected_salary: expectedSalary,
    });
    refresh();
  }

  async function handleOverride(bucket: Bucket, reason: string) {
    await postJson(`/candidates/${candidateId}/override`, { bucket, reason });
    refresh();
  }

  async function handleArchive(reason: string) {
    await postJson(`/candidates/${candidateId}/archive`, { reason });
    refresh();
  }

  async function handleUnarchive() {
    await postJson(`/candidates/${candidateId}/unarchive`, {});
    refresh();
  }

  async function handleHardDelete(name: string) {
    const reason = await prompt({
      title: "Delete permanently",
      description:
        `Permanently delete ${name}? This cannot be undone — the resume, AI score, and ` +
        `history will be gone for good. Enter a reason for the audit log to proceed:`,
      placeholder: "Reason for deletion",
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!reason || !candidate) return;
    await deleteJson(`/candidates/${candidateId}`, { reason });
    router.push(`/jobs/${candidate.job_id}`);
  }

  async function handleDownloadFitReport() {
    // Fetched as a blob (not a plain <a href>) so the HR session cookie is reliably sent —
    // same reasoning as the review page's recording playback.
    const res = await fetch(`${BASE_URL}/candidates/${candidateId}/fit-report`, { credentials: "include" });
    if (!res.ok) return;
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const filename = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? "fit_report.pdf";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleScheduleInterview() {
    if (!candidate) return;
    const session = await postJson<InterviewSession>("/interviews", {
      candidate_name: candidate.full_name ?? candidate.email ?? "Candidate",
      job_id: candidate.job_id,
      candidate_id: candidate.id,
    });
    setInterviewSession(session);
  }

  if (notFound) {
    return (
      <div className="max-w-lg mx-auto w-full px-6 py-8 text-center space-y-3">
        <p className="text-zinc-700">This candidate no longer exists.</p>
        <Link href="/jobs" className="btn-outline inline-flex">
          Back to jobs
        </Link>
      </div>
    );
  }
  if (!candidate) return <p className="p-6 text-zinc-500">Loading…</p>;

  const effectiveBucket = candidate.override_bucket ?? candidate.bucket;
  const latestSession = sessions[0] ?? null;

  return (
    <div className="max-w-3xl mx-auto w-full px-6 py-8 space-y-6">
      <div>
        <Link href={`/jobs/${candidate.job_id}`} className="text-xs text-blue-700 hover:underline">
          ← Back to job
        </Link>
        <div className="flex items-start justify-between">
          <h1 className="text-xl font-semibold mt-1">
            {candidate.full_name ?? candidate.email ?? "Unnamed candidate"}
          </h1>
          <button onClick={handleDownloadFitReport} className="btn-outline text-xs px-2 py-1">
            Download fit report (PDF)
          </button>
        </div>
        <p className="text-sm text-zinc-500">
          {candidate.email} {candidate.phone && `· ${candidate.phone}`}
          {effectiveBucket && ` · ${effectiveBucket}`}
          {candidate.archived && " · archived"}
        </p>
        <p className="text-xs text-zinc-400 mt-1">
          {candidate.source && `Source: ${candidate.source} · `}
          {candidate.uploaded_by_email && `Uploaded by ${candidate.uploaded_by_email} · `}
          {candidate.ocr_fallback_used && "Parsed via OCR fallback"}
        </p>
      </div>

      <Section title="AI Evaluation & Fit Breakdown">
        {candidate.fit_score !== null ? (
          <div className="space-y-4">
            {/* Top Score Summary Cards */}
            <div className="grid grid-cols-3 gap-3">
              <div className="border border-zinc-200 bg-zinc-50/70 rounded-md p-3 text-center">
                <p className="text-xs text-zinc-500 font-medium">Overall Fit</p>
                <p className="text-2xl font-bold text-zinc-900 mt-0.5">
                  {candidate.fit_score.toFixed(0)}
                  <span className="text-xs font-normal text-zinc-400">/100</span>
                </p>
                <p className="text-[11px] text-zinc-600 font-medium mt-0.5">
                  {getScoreLabel(candidate.fit_score)}
                </p>
              </div>

              <div className="border border-blue-200 bg-blue-50/50 rounded-md p-3 text-center">
                <p className="text-xs text-blue-700 font-medium">Technical Score</p>
                <p className="text-2xl font-bold text-blue-950 mt-0.5">
                  {candidate.technical_score !== null ? candidate.technical_score.toFixed(0) : "—"}
                  <span className="text-xs font-normal text-blue-400">/100</span>
                </p>
                <p className="text-[11px] text-blue-700 font-medium mt-0.5">
                  Skills & Tech Depth
                </p>
              </div>

              <div className="border border-purple-200 bg-purple-50/50 rounded-md p-3 text-center">
                <p className="text-xs text-purple-700 font-medium">Communication Score</p>
                <p className="text-2xl font-bold text-purple-950 mt-0.5">
                  {candidate.communication_score !== null ? candidate.communication_score.toFixed(0) : "—"}
                  <span className="text-xs font-normal text-purple-400">/100</span>
                </p>
                <p className="text-[11px] text-purple-700 font-medium mt-0.5">
                  Written Articulation
                </p>
              </div>
            </div>

            {candidate.manual_score_adjustment ? (
              <div className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded p-2">
                <span className="font-semibold">
                  HR Adjustment: {candidate.manual_score_adjustment > 0 ? "+" : ""}
                  {candidate.manual_score_adjustment} points
                </span>
                {candidate.manual_adjustment_reason && (
                  <span className="text-zinc-600"> — {candidate.manual_adjustment_reason}</span>
                )}
              </div>
            ) : null}

            {/* 5-Category Subscores */}
            {candidate.score_breakdown && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 pt-1">
                {CATEGORIES.map((cat) => {
                  const entry = candidate.score_breakdown?.[cat];
                  if (!entry) return null;
                  return (
                    <div key={cat} className="border border-zinc-200 rounded-md p-2.5 text-xs bg-white">
                      <div className="flex justify-between items-center mb-1">
                        <p className="font-semibold capitalize text-zinc-800">{cat}</p>
                        <span className="font-bold text-zinc-900 bg-zinc-100 px-1.5 py-0.2 rounded">
                          {entry.score.toFixed(0)}
                        </span>
                      </div>
                      <ul className="list-disc list-inside text-zinc-600 space-y-0.5 mt-1 text-[11px]">
                        {entry.reasons.map((r, i) => (
                          <li key={i} className="leading-tight">{r}</li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
            <ManualAdjustmentForm candidate={candidate} onSubmit={handleManualAdjustment} />
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Not scored.</p>
        )}
      </Section>

      {/* Skill Relevancy Matrix */}
      {candidate.skills_breakdown && (
        <Section title="Skill Relevancy & Match Matrix">
          <div className="space-y-3 text-xs">
            <div>
              <p className="font-semibold text-emerald-800 mb-1.5 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                Matched / Relevant Skills ({candidate.skills_breakdown.relevant_skills.length})
              </p>
              {candidate.skills_breakdown.relevant_skills.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {candidate.skills_breakdown.relevant_skills.map((skill, idx) => (
                    <span
                      key={idx}
                      className="bg-emerald-50 text-emerald-900 border border-emerald-300 px-2 py-0.5 rounded-full font-medium"
                    >
                      ✓ {skill}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-zinc-400 italic">No direct core skill matches found.</p>
              )}
            </div>

            <div>
              <p className="font-semibold text-amber-800 mb-1.5 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                Missing Critical Skills ({candidate.skills_breakdown.missing_critical_skills.length})
              </p>
              {candidate.skills_breakdown.missing_critical_skills.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {candidate.skills_breakdown.missing_critical_skills.map((skill, idx) => (
                    <span
                      key={idx}
                      className="bg-amber-50 text-amber-900 border border-amber-300 px-2 py-0.5 rounded-full font-medium"
                    >
                      ✗ {skill}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-zinc-400 italic">No missing critical skills.</p>
              )}
            </div>

            <div>
              <p className="font-semibold text-zinc-600 mb-1.5 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-zinc-400"></span>
                Irrelevant / Out-of-Scope Skills ({candidate.skills_breakdown.irrelevant_skills.length})
              </p>
              {candidate.skills_breakdown.irrelevant_skills.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {candidate.skills_breakdown.irrelevant_skills.map((skill, idx) => (
                    <span
                      key={idx}
                      className="bg-zinc-100 text-zinc-600 border border-zinc-200 px-2 py-0.5 rounded-full"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-zinc-400 italic">No irrelevant skills detected.</p>
              )}
            </div>
          </div>
        </Section>
      )}

      {/* Profession Screening */}
      {candidate.profession_fit && (
        <Section title="Profession & Career Trajectory">
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between border-b border-zinc-100 pb-2">
              <span className="text-zinc-500">Role Alignment Verdict:</span>
              <span
                className={`font-semibold capitalize px-2 py-0.5 rounded ${
                  candidate.profession_fit.verdict === "aligned"
                    ? "bg-emerald-100 text-emerald-900"
                    : candidate.profession_fit.verdict === "partial"
                    ? "bg-amber-100 text-amber-900"
                    : "bg-red-100 text-red-900"
                }`}
              >
                {candidate.profession_fit.verdict}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-zinc-700">
              <div>
                <span className="text-zinc-500 block">Seniority Match:</span>
                <span className="font-medium">{candidate.profession_fit.seniority_match}</span>
              </div>
              <div>
                <span className="text-zinc-500 block">Domain Alignment:</span>
                <span className="font-medium">{candidate.profession_fit.domain_alignment}</span>
              </div>
            </div>
            {candidate.profession_fit.insights.length > 0 && (
              <div className="pt-2">
                <span className="text-zinc-500 block mb-1">Key Trajectory Insights:</span>
                <ul className="list-disc list-inside text-zinc-700 space-y-0.5">
                  {candidate.profession_fit.insights.map((insight, i) => (
                    <li key={i}>{insight}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Experience measured from the employment-history dates, rather than the figure the
          resume states for itself. */}
      {candidate.experience_analysis && (
        <Section title="Experience & Employment History">
          {(() => {
            const exp = candidate.experience_analysis!;
            const measured = exp.basis === "employment_history";
            // Only worth drawing attention to when the resume overstates by a meaningful
            // margin — a few months either way is rounding, not a discrepancy.
            const overstated =
              measured && exp.discrepancy_years !== null && exp.discrepancy_years >= 1;
            return (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <span className="text-zinc-500 block">
                      {measured ? "Calculated from employment history" : "Stated on resume"}
                    </span>
                    <span className="text-lg font-bold text-zinc-900">
                      {measured ? exp.computed_years : exp.claimed_years}
                      <span className="text-xs font-medium text-zinc-500"> yrs</span>
                      {measured && exp.approximate && (
                        <span className="text-[11px] font-normal text-zinc-400"> (approx.)</span>
                      )}
                    </span>
                  </div>
                  {measured && exp.claimed_years !== null && (
                    <div>
                      <span className="text-zinc-500 block">Stated on resume</span>
                      <span
                        className={`text-lg font-bold ${overstated ? "text-amber-700" : "text-zinc-900"}`}
                      >
                        {exp.claimed_years}
                        <span className="text-xs font-medium text-zinc-500"> yrs</span>
                      </span>
                    </div>
                  )}
                  <div>
                    <span className="text-zinc-500 block">Currently employed</span>
                    <span className="text-sm font-semibold text-zinc-900">
                      {exp.currently_employed ? "Yes" : "No"}
                    </span>
                  </div>
                </div>

                {overstated && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                    The resume states {exp.claimed_years} yrs, but the dates on the listed
                    roles add up to {exp.computed_years}. Worth confirming with the candidate
                    — overlapping roles are counted once here, and a stated total often
                    includes internships or study.
                  </p>
                )}

                {exp.gaps.length > 0 && (
                  <div>
                    <span className="text-[11px] uppercase font-bold text-zinc-500">
                      Employment gaps
                    </span>
                    <ul className="mt-1 space-y-1">
                      {exp.gaps.map((gap, i) => (
                        <li
                          key={i}
                          className="text-xs text-zinc-700 bg-zinc-50 border border-zinc-200 rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-3"
                        >
                          <span>
                            {gap.start} → {gap.ongoing ? "present" : gap.end}
                            {gap.ongoing && (
                              <span className="text-zinc-500"> (not currently in a listed role)</span>
                            )}
                          </span>
                          <span className="font-semibold shrink-0">
                            {gap.months} {gap.months === 1 ? "month" : "months"}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      Gaps of 3+ months between listed roles. A gap is a question to ask,
                      not a mark against the candidate.
                    </p>
                  </div>
                )}

                {exp.unparsed_roles.length > 0 && (
                  <p className="text-xs text-zinc-500">
                    Couldn&apos;t read dates for {exp.unparsed_roles.join(", ")} — the figure
                    above falls back to what the resume states.
                  </p>
                )}
              </div>
            );
          })()}
        </Section>
      )}

      {/* Campus Metadata if available */}
      {candidate.campus_metadata && (
        <Section title="Campus Interview / College Profile">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs text-zinc-700">
            {candidate.campus_metadata.college && (
              <div>
                <span className="text-zinc-500 block">College:</span>
                <span className="font-medium">{candidate.campus_metadata.college}</span>
              </div>
            )}
            {candidate.campus_metadata.roll_number && (
              <div>
                <span className="text-zinc-500 block">Roll Number:</span>
                <span className="font-medium">{candidate.campus_metadata.roll_number}</span>
              </div>
            )}
            {candidate.campus_metadata.cgpa !== undefined && (
              <div>
                <span className="text-zinc-500 block">CGPA / %:</span>
                <span className="font-medium">{candidate.campus_metadata.cgpa}</span>
              </div>
            )}
            {candidate.campus_metadata.degree_branch && (
              <div>
                <span className="text-zinc-500 block">Branch / Degree:</span>
                <span className="font-medium">{candidate.campus_metadata.degree_branch}</span>
              </div>
            )}
            {candidate.campus_metadata.graduation_year && (
              <div>
                <span className="text-zinc-500 block">Passing Batch:</span>
                <span className="font-medium">{candidate.campus_metadata.graduation_year}</span>
              </div>
            )}
            {candidate.campus_metadata.standing_backlogs !== undefined && (
              <div>
                <span className="text-zinc-500 block">Active Backlogs:</span>
                <span className="font-medium">{candidate.campus_metadata.standing_backlogs}</span>
              </div>
            )}
          </div>
        </Section>
      )}

      {candidate.knockout_failed && (
        <Section title="Not eligible">
          <ul className="list-disc list-inside text-sm text-zinc-700">
            {candidate.knockout_reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Screening details">
        <ScreeningDetailsForm candidate={candidate} onSubmit={handleScreeningDetails} />
      </Section>

      <Section title="HR decision">
        <OverrideForm candidate={candidate} onSubmit={handleOverride} />
        <div className="mt-3 pt-3 border-t border-zinc-100">
          {candidate.archived ? (
            <button onClick={handleUnarchive} className="btn-outline text-xs px-2 py-1">
              Unarchive
            </button>
          ) : (
            <ArchiveForm onSubmit={handleArchive} />
          )}
        </div>
      </Section>

      <Section title="HR Phone Screening Call (Recorded Audio)">
        <L1AudioUploader
          candidateId={candidate.id}
          candidateName={candidate.full_name ?? candidate.email ?? "Candidate"}
        />
      </Section>

      {effectiveBucket === "approved" && !candidate.archived && (
        <Section title="Interview scheduling">
          {interviewSession ? (
            <div className="space-y-2">
              <div>
                <p className="text-xs text-zinc-600 mb-1">
                  Share this link with {candidate.full_name ?? "the candidate"} — no account required:
                </p>
                <input
                  readOnly
                  value={`${window.location.origin}/interview/${interviewSession.join_token}`}
                  className="input text-xs"
                  onFocus={(e) => e.target.select()}
                />
              </div>
              <div>
                <p className="text-xs text-zinc-600 mb-1">
                  Send this to whoever is conducting the interview (for Q&A cross-check):
                </p>
                <input
                  readOnly
                  value={`${window.location.origin}/interview/interviewer/${interviewSession.interviewer_join_token}`}
                  className="input text-xs"
                  onFocus={(e) => e.target.select()}
                />
              </div>
            </div>
          ) : (
            <ScheduleButton onSchedule={handleScheduleInterview} />
          )}
        </Section>
      )}

      <Section title="Interview">
        {!latestSession ? (
          <p className="text-sm text-zinc-500">No interview scheduled yet.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              Status: <span className="font-medium">{latestSession.status}</span>
              {latestSession.integrity_score !== null && (
                <>
                  {" · "}
                  <span
                    className={`text-xs ${getIntegrityScoreBand(latestSession.integrity_score).badgeClass}`}
                  >
                    {getIntegrityScoreBand(latestSession.integrity_score).label}
                  </span>
                </>
              )}
            </p>
            {latestSession.interviewer_live_decision && (
              <p>
                Interviewer&apos;s live read:{" "}
                <span className="font-medium capitalize">{latestSession.interviewer_live_decision}</span>
                {latestSession.interviewer_live_notes && ` — ${latestSession.interviewer_live_notes}`}
              </p>
            )}
            {latestSession.sentiment_trend && (
              <p className="text-xs text-zinc-600">{latestSession.sentiment_trend.summary}</p>
            )}
            <Link href={`/review/${latestSession.id}`} className="btn-outline text-xs px-2 py-1 inline-flex">
              Open full interview review
            </Link>
          </div>
        )}
      </Section>

      <button
        onClick={() => handleHardDelete(candidate.full_name ?? candidate.email ?? "this candidate")}
        className="btn-danger-outline text-xs px-2 py-1"
      >
        Delete permanently
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="font-medium mb-2">{title}</h2>
      <div className="border border-zinc-200 rounded-md p-3">{children}</div>
    </div>
  );
}

function ManualAdjustmentForm({
  candidate,
  onSubmit,
}: {
  candidate: Candidate;
  onSubmit: (adjustment: number, reason: string) => void;
}) {
  const [adjustment, setAdjustment] = useState(
    candidate.manual_score_adjustment != null ? String(candidate.manual_score_adjustment) : "0"
  );
  const [reason, setReason] = useState(candidate.manual_adjustment_reason ?? "");

  return (
    <div className="space-y-1 pt-2 border-t border-zinc-100">
      <p className="font-medium text-xs">HR score adjustment (±20, e.g. competing offer)</p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={-20}
          max={20}
          value={adjustment}
          onChange={(e) => setAdjustment(e.target.value)}
          className="text-xs border border-zinc-300 rounded px-2 py-0.5 w-20"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required)"
          className="text-xs border border-zinc-300 rounded px-2 py-0.5 flex-1"
        />
        <button
          type="button"
          disabled={!reason.trim()}
          onClick={() => onSubmit(Number(adjustment), reason)}
          className="btn-outline text-xs px-2 py-1 disabled:opacity-40"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function ScreeningDetailsForm({
  candidate,
  onSubmit,
}: {
  candidate: Candidate;
  onSubmit: (noticePeriodDays: number | null, expectedSalary: number | null) => void;
}) {
  const [noticePeriod, setNoticePeriod] = useState(
    candidate.notice_period_days != null ? String(candidate.notice_period_days) : ""
  );
  const [expectedSalary, setExpectedSalary] = useState(
    candidate.expected_salary != null ? String(candidate.expected_salary) : ""
  );

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={0}
        value={noticePeriod}
        onChange={(e) => setNoticePeriod(e.target.value)}
        placeholder="Notice (days)"
        className="text-xs border border-zinc-300 rounded px-2 py-0.5 w-28"
      />
      <input
        type="number"
        min={0}
        value={expectedSalary}
        onChange={(e) => setExpectedSalary(e.target.value)}
        placeholder="Expected salary"
        className="text-xs border border-zinc-300 rounded px-2 py-0.5 flex-1"
      />
      <button
        type="button"
        onClick={() =>
          onSubmit(noticePeriod ? Number(noticePeriod) : null, expectedSalary ? Number(expectedSalary) : null)
        }
        className="btn-outline text-xs px-2 py-1"
      >
        Save
      </button>
    </div>
  );
}

function OverrideForm({
  candidate,
  onSubmit,
}: {
  candidate: Candidate;
  onSubmit: (bucket: Bucket, reason: string) => void;
}) {
  const effectiveBucket = candidate.override_bucket ?? candidate.bucket;
  const [selectedBucket, setSelectedBucket] = useState<Bucket>(effectiveBucket ?? "review");
  const [reason, setReason] = useState(candidate.override_reason ?? "");
  const canApply = reason.trim().length > 0 && selectedBucket !== effectiveBucket;

  return (
    <div className="space-y-2">
      {candidate.override_bucket && (
        <p className="text-xs text-zinc-500">
          Currently overridden to {candidate.override_bucket} — {candidate.override_reason}
        </p>
      )}
      <div className="flex items-center gap-2">
        <select
          className="text-xs border border-zinc-300 rounded px-1 py-0.5"
          value={selectedBucket}
          onChange={(e) => setSelectedBucket(e.target.value as Bucket)}
        >
          <option value="approved">Approved</option>
          <option value="review">Review</option>
          <option value="declined">Declined</option>
        </select>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Override reason (required)"
          className="text-xs border border-zinc-300 rounded px-2 py-0.5 flex-1"
        />
        <button
          type="button"
          onClick={() => onSubmit(selectedBucket, reason)}
          disabled={!canApply}
          className="btn-primary text-xs px-2 py-1 disabled:opacity-40"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function ArchiveForm({ onSubmit }: { onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("");

  return (
    <div className="flex items-center gap-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for removing this candidate (required)"
        className="text-xs border border-zinc-300 rounded px-2 py-0.5 flex-1"
      />
      <button
        type="button"
        onClick={() => onSubmit(reason)}
        disabled={reason.trim().length === 0}
        className="btn-danger-outline text-xs px-2 py-1 disabled:opacity-40"
      >
        Remove candidate
      </button>
    </div>
  );
}

function ScheduleButton({ onSchedule }: { onSchedule: () => Promise<void> }) {
  const [scheduling, setScheduling] = useState(false);

  async function handleClick() {
    setScheduling(true);
    try {
      await onSchedule();
    } finally {
      setScheduling(false);
    }
  }

  return (
    <button onClick={handleClick} disabled={scheduling} className="btn-primary text-xs px-2 py-1 disabled:opacity-40">
      {scheduling ? "Creating…" : "Schedule interview"}
    </button>
  );
}
