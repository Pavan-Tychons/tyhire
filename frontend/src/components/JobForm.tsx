"use client";

import { useState, type FormEvent } from "react";
import { postJson } from "@/lib/api";
import type { Job, JobLevel, WorkMode } from "@/lib/types";
import { getScoreLabel, STRICTNESS_PRESETS, type StrictnessKey } from "@/lib/scoreLabel";
import { lpaToRupees, rupeesToLpaInput } from "@/lib/salary";

type WeightCategory = "skills" | "experience" | "education" | "certifications" | "communication";

const WEIGHT_CATEGORIES: { key: WeightCategory; label: string }[] = [
  { key: "skills", label: "Skills" },
  { key: "experience", label: "Experience" },
  { key: "education", label: "Education" },
  { key: "certifications", label: "Certifications" },
  { key: "communication", label: "Communication" },
];

export interface JobPayload {
  title: string;
  jd_text: string;
  required_skills: string[];
  level: JobLevel;
  work_mode: WorkMode;
  min_years_experience: number | null;
  allowed_locations: string[];
  max_notice_period_days: number | null;
  salary_band_min: number | null;
  salary_band_max: number | null;
  approve_threshold: number;
  decline_threshold: number;
  weight_skills: number;
  weight_experience: number;
  weight_education: number;
  weight_certifications: number;
  weight_communication: number;
  core_skills: string[];
  secondary_skills: string[];
  irrelevant_skills: string[];
  is_campus_drive: boolean;
  campus_min_cgpa: number | null;
  campus_allowed_batches: number[];
  campus_allowed_branches: string[];
  campus_max_backlogs: number | null;
  require_desktop_probe: boolean;
}

interface SuggestResponse {
  jd_text: string;
  required_skills: string[];
}

function matchingStrictness(approve: number, decline: number): StrictnessKey {
  const match = Object.entries(STRICTNESS_PRESETS).find(
    ([, preset]) => preset.approve === approve && preset.decline === decline
  );
  return (match?.[0] as StrictnessKey) ?? "custom";
}

/** Relative sliders, not percentages HR has to hand-balance — always scaled to sum to 1.0
 * before being sent to the API, so it's never possible to submit an invalid combination. */
function normalizeWeights(
  skills: number,
  experience: number,
  education: number,
  certifications: number,
  communication: number
) {
  const total = skills + experience + education + certifications + communication;
  if (total <= 0) {
    return {
      weight_skills: 0.2,
      weight_experience: 0.2,
      weight_education: 0.2,
      weight_certifications: 0.2,
      weight_communication: 0.2,
    };
  }
  return {
    weight_skills: skills / total,
    weight_experience: experience / total,
    weight_education: education / total,
    weight_certifications: certifications / total,
    weight_communication: communication / total,
  };
}

type Priorities = Record<WeightCategory, boolean>;

const NO_PRIORITIES: Priorities = {
  skills: false,
  experience: false,
  education: false,
  certifications: false,
  communication: false,
};

function rawUnitsFromPriorities(priorities: Priorities): Record<WeightCategory, number> {
  return {
    skills: priorities.skills ? 2 : 1,
    experience: priorities.experience ? 2 : 1,
    education: priorities.education ? 2 : 1,
    certifications: priorities.certifications ? 2 : 1,
    communication: priorities.communication ? 2 : 1,
  };
}

function weightsFromPriorities(priorities: Priorities) {
  const units = rawUnitsFromPriorities(priorities);
  return normalizeWeights(
    units.skills,
    units.experience,
    units.education,
    units.certifications,
    units.communication
  );
}

function matchingPriorities(
  skills: number,
  experience: number,
  education: number,
  certifications: number,
  communication: number
): Priorities | null {
  for (let mask = 0; mask < 32; mask++) {
    const candidate: Priorities = {
      skills: !!(mask & 1),
      experience: !!(mask & 2),
      education: !!(mask & 4),
      certifications: !!(mask & 8),
      communication: !!(mask & 16),
    };
    const w = weightsFromPriorities(candidate);
    if (
      Math.abs(w.weight_skills - skills) < 0.01 &&
      Math.abs(w.weight_experience - experience) < 0.01 &&
      Math.abs(w.weight_education - education) < 0.01 &&
      Math.abs(w.weight_certifications - certifications) < 0.01 &&
      Math.abs(w.weight_communication - communication) < 0.01
    ) {
      return candidate;
    }
  }
  return null;
}

function formatNormalizedWeights(
  skills: number,
  experience: number,
  education: number,
  certifications: number,
  communication: number
): string {
  const w = normalizeWeights(skills, experience, education, certifications, communication);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    `Skills ${pct(w.weight_skills)} · Experience ${pct(w.weight_experience)} · ` +
    `Education ${pct(w.weight_education)} · Certs ${pct(w.weight_certifications)} · ` +
    `Comm ${pct(w.weight_communication)}`
  );
}

export default function JobForm({
  defaultValues,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  defaultValues?: Job;
  onSubmit: (payload: JobPayload) => Promise<void>;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const [title, setTitle] = useState(defaultValues?.title ?? "");
  const [jdText, setJdText] = useState(defaultValues?.jd_text ?? "");
  const [requiredSkills, setRequiredSkills] = useState(
    (defaultValues?.required_skills ?? []).join(", ")
  );
  const [coreSkills, setCoreSkills] = useState(
    (defaultValues?.core_skills ?? []).join(", ")
  );
  const [secondarySkills, setSecondarySkills] = useState(
    (defaultValues?.secondary_skills ?? []).join(", ")
  );
  const [irrelevantSkills, setIrrelevantSkills] = useState(
    (defaultValues?.irrelevant_skills ?? []).join(", ")
  );
  const [level, setLevel] = useState<JobLevel>(defaultValues?.level ?? "experienced");
  const [workMode, setWorkMode] = useState<WorkMode>(defaultValues?.work_mode ?? "onsite");
  const [minYears, setMinYears] = useState(
    defaultValues?.min_years_experience != null ? String(defaultValues.min_years_experience) : ""
  );
  const [allowedLocations, setAllowedLocations] = useState(
    (defaultValues?.allowed_locations ?? []).join(", ")
  );
  const [maxNoticeDays, setMaxNoticeDays] = useState(
    defaultValues?.max_notice_period_days != null ? String(defaultValues.max_notice_period_days) : ""
  );
  // Held as the lakhs figure that is typed and shown; converted to rupees on submit.
  const [salaryMin, setSalaryMin] = useState(rupeesToLpaInput(defaultValues?.salary_band_min));
  const [salaryMax, setSalaryMax] = useState(rupeesToLpaInput(defaultValues?.salary_band_max));

  // Checked live rather than on submit, so a band entered the wrong way round is flagged at
  // the field while the user is still looking at it. lpaToRupees returns null for blank or
  // unparseable input, so this fires only when both ends are real figures — a half-filled
  // band is incomplete, not contradictory, and `required` already covers that case.
  const salaryMinRupees = lpaToRupees(salaryMin);
  const salaryMaxRupees = lpaToRupees(salaryMax);
  const salaryBandInvalid =
    salaryMinRupees !== null && salaryMaxRupees !== null && salaryMinRupees > salaryMaxRupees;

  // Campus fields
  const [isCampusDrive, setIsCampusDrive] = useState(defaultValues?.is_campus_drive ?? false);
  const [campusMinCgpa, setCampusMinCgpa] = useState(
    defaultValues?.campus_min_cgpa != null ? String(defaultValues.campus_min_cgpa) : ""
  );
  const [campusAllowedBatches, setCampusAllowedBatches] = useState(
    (defaultValues?.campus_allowed_batches ?? []).join(", ")
  );
  const [campusAllowedBranches, setCampusAllowedBranches] = useState(
    (defaultValues?.campus_allowed_branches ?? []).join(", ")
  );
  const [campusMaxBacklogs, setCampusMaxBacklogs] = useState(
    defaultValues?.campus_max_backlogs != null ? String(defaultValues.campus_max_backlogs) : ""
  );

  // 5 weights
  const [weightSkills, setWeightSkills] = useState(defaultValues?.weight_skills ?? 0.2);
  const [weightExperience, setWeightExperience] = useState(defaultValues?.weight_experience ?? 0.2);
  const [weightEducation, setWeightEducation] = useState(defaultValues?.weight_education ?? 0.2);
  const [weightCertifications, setWeightCertifications] = useState(
    defaultValues?.weight_certifications ?? 0.2
  );
  const [weightCommunication, setWeightCommunication] = useState(
    defaultValues?.weight_communication ?? 0.2
  );

  const initialPriorities = defaultValues
    ? matchingPriorities(
        defaultValues.weight_skills,
        defaultValues.weight_experience,
        defaultValues.weight_education,
        defaultValues.weight_certifications,
        defaultValues.weight_communication ?? 0.2
      )
    : NO_PRIORITIES;
  const [priorities, setPriorities] = useState<Priorities>(initialPriorities ?? NO_PRIORITIES);
  const [useCustomWeights, setUseCustomWeights] = useState(defaultValues ? initialPriorities === null : false);
  const [requireDesktopProbe, setRequireDesktopProbe] = useState(
    defaultValues?.require_desktop_probe ?? false
  );
  const [strictness, setStrictness] = useState<StrictnessKey>(
    defaultValues
      ? matchingStrictness(defaultValues.approve_threshold, defaultValues.decline_threshold)
      : "balanced"
  );
  const [approveThreshold, setApproveThreshold] = useState<number>(
    defaultValues?.approve_threshold ?? STRICTNESS_PRESETS.balanced.approve
  );
  const [declineThreshold, setDeclineThreshold] = useState<number>(
    defaultValues?.decline_threshold ?? STRICTNESS_PRESETS.balanced.decline
  );

  function handleStrictnessChange(key: StrictnessKey) {
    setStrictness(key);
    if (key !== "custom") {
      setApproveThreshold(STRICTNESS_PRESETS[key].approve);
      setDeclineThreshold(STRICTNESS_PRESETS[key].decline);
    }
  }

  function handleApproveThresholdChange(value: number) {
    setApproveThreshold(Math.max(value, declineThreshold + 1));
  }
  function handleDeclineThresholdChange(value: number) {
    setDeclineThreshold(Math.min(value, approveThreshold - 1));
  }

  function applyWeights(w: ReturnType<typeof weightsFromPriorities>) {
    setWeightSkills(w.weight_skills);
    setWeightExperience(w.weight_experience);
    setWeightEducation(w.weight_education);
    setWeightCertifications(w.weight_certifications);
    setWeightCommunication(w.weight_communication);
  }

  function handlePriorityToggle(category: WeightCategory) {
    const next = { ...priorities, [category]: !priorities[category] };
    setPriorities(next);
    applyWeights(weightsFromPriorities(next));
  }

  function handleCustomWeightsToggle(next: boolean) {
    setUseCustomWeights(next);
    if (!next) {
      applyWeights(weightsFromPriorities(priorities));
    }
  }

  async function handleSuggest() {
    if (!title.trim()) {
      setError("Enter a job title first — the suggestion is built from it.");
      return;
    }
    setError(null);
    setSuggesting(true);
    try {
      const result = await postJson<SuggestResponse>("/jobs/suggest", {
        title,
        draft_jd_text: jdText.trim() || null,
      });
      setJdText(result.jd_text);
      setRequiredSkills(result.required_skills.join(", "));
    } catch {
      setError("Could not generate a suggestion right now — try again in a moment.");
    } finally {
      setSuggesting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // Stopped here as well as flagged inline. The API rejects this too, but its 422 names the
    // raw column (`salary_band_min`) in rupees, which is neither the field label nor the unit
    // on screen — so the request is simply never made.
    if (salaryBandInvalid) {
      setError("Check the salary band below — the maximum must be at least the minimum.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        title,
        jd_text: jdText,
        required_skills: splitList(requiredSkills),
        core_skills: splitList(coreSkills),
        secondary_skills: splitList(secondarySkills),
        irrelevant_skills: splitList(irrelevantSkills),
        level,
        work_mode: workMode,
        min_years_experience: minYears ? Number(minYears) : null,
        allowed_locations: splitList(allowedLocations),
        max_notice_period_days: maxNoticeDays ? Number(maxNoticeDays) : null,
        salary_band_min: lpaToRupees(salaryMin),
        salary_band_max: lpaToRupees(salaryMax),
        approve_threshold: approveThreshold,
        decline_threshold: declineThreshold,
        ...normalizeWeights(
          weightSkills,
          weightExperience,
          weightEducation,
          weightCertifications,
          weightCommunication
        ),
        is_campus_drive: isCampusDrive,
        campus_min_cgpa: campusMinCgpa ? Number(campusMinCgpa) : null,
        campus_allowed_batches: splitList(campusAllowedBatches).map(Number).filter((n) => !isNaN(n)),
        campus_allowed_branches: splitList(campusAllowedBranches),
        campus_max_backlogs: campusMaxBacklogs ? Number(campusMaxBacklogs) : null,
        require_desktop_probe: requireDesktopProbe,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save job");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <p className="text-xs text-zinc-500">
        <span className="text-red-600" aria-hidden="true">
          *
        </span>{" "}
        required. Every other field can be left exactly as it is.
      </p>

      <Field label="Title" required>
        <input required value={title} onChange={(e) => setTitle(e.target.value)} className="input" />
      </Field>

      <Field label="Job description" required>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-zinc-500">
            Paste your own JD, or leave blank and let AI draft one from the title.
          </span>
          <button
            type="button"
            onClick={handleSuggest}
            disabled={suggesting}
            className="btn-outline text-xs px-2 py-1 disabled:opacity-40"
          >
            {suggesting ? "Thinking…" : jdText.trim() ? "Improve with AI" : "Suggest with AI"}
          </button>
        </div>
        <textarea
          required
          rows={6}
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          className="input"
          placeholder="Paste the JD here — this is what candidates are scored against."
        />
      </Field>

      <div className="space-y-3 rounded-md border border-zinc-200 p-3 bg-zinc-50/50">
        <p className="text-xs font-semibold text-zinc-700 uppercase tracking-wide">
          Skill Relevancy & Categorization
        </p>
        <Field label="Required Skills (primary list, comma-separated)" required>
          <input
            required
            value={requiredSkills}
            onChange={(e) => setRequiredSkills(e.target.value)}
            className="input bg-surface"
            placeholder="Python, AWS, PostgreSQL"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Core / Mandatory Skills" required>
            <input
              required
              value={coreSkills}
              onChange={(e) => setCoreSkills(e.target.value)}
              className="input bg-surface text-xs"
              placeholder="FastAPI, Docker, SQL"
            />
          </Field>
          <Field label="Secondary / Good-to-have Skills" required>
            <input
              required
              value={secondarySkills}
              onChange={(e) => setSecondarySkills(e.target.value)}
              className="input bg-surface text-xs"
              placeholder="Redis, Kubernetes, GraphQL"
            />
          </Field>
        </div>
        <Field label="Irrelevant / Out-of-Scope Skills (penalized if stuffed)">
          <input
            value={irrelevantSkills}
            onChange={(e) => setIrrelevantSkills(e.target.value)}
            className="input bg-surface text-xs"
            placeholder="Photoshop, Graphic Design, WordPress"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Level" required>
          <select
            required
            value={level}
            onChange={(e) => setLevel(e.target.value as JobLevel)}
            className="input"
          >
            <option value="experienced">Experienced</option>
            <option value="fresher">Fresher / entry-level</option>
          </select>
          <p className="text-xs text-zinc-500 mt-1">
            Freshers are scored on education, projects and internships instead of work history.
          </p>
        </Field>
        <Field label="Work mode" required>
          <select
            required
            value={workMode}
            onChange={(e) => setWorkMode(e.target.value as WorkMode)}
            className="input"
          >
            <option value="onsite">On-site</option>
            <option value="hybrid">Hybrid</option>
            <option value="remote">Remote</option>
          </select>
          <p className="text-xs text-zinc-500 mt-1">
            Remote roles skip the location eligibility check below entirely.
          </p>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Min years experience (eligibility requirement)" required>
          <input
            required
            type="number"
            min={0}
            value={minYears}
            onChange={(e) => setMinYears(e.target.value)}
            className="input"
            placeholder="0 if there is no minimum"
          />
        </Field>
        <Field label="Allowed locations (eligibility requirement)">
          <input
            value={allowedLocations}
            onChange={(e) => setAllowedLocations(e.target.value)}
            className="input"
            placeholder="Bangalore, Chennai"
          />
        </Field>
        <Field label="Max notice period, days (eligibility requirement)" required>
          <input
            required
            type="number"
            min={0}
            value={maxNoticeDays}
            onChange={(e) => setMaxNoticeDays(e.target.value)}
            className="input"
            placeholder="e.g. 90"
          />
        </Field>
        <Field label="Salary band in LPA (eligibility requirement on max)" required>
          <div className="flex items-center gap-2">
            {/* step="any" rather than a fixed step: with step="0.1" the browser rejects
              * 5.55 outright, and the whole point here is that any decimal is accepted. */}
            <input
              required
              type="number"
              min={0}
              step="any"
              value={salaryMin}
              onChange={(e) => setSalaryMin(e.target.value)}
              aria-invalid={salaryBandInvalid}
              className={`input ${salaryBandInvalid ? "border-red-500" : ""}`}
              placeholder="Min, e.g. 5"
            />
            <span className="shrink-0 text-xs text-zinc-500">to</span>
            <input
              required
              type="number"
              min={0}
              step="any"
              value={salaryMax}
              onChange={(e) => setSalaryMax(e.target.value)}
              aria-invalid={salaryBandInvalid}
              className={`input ${salaryBandInvalid ? "border-red-500" : ""}`}
              placeholder="Max, e.g. 10.5"
            />
            <span className="shrink-0 text-xs font-medium text-zinc-600">LPA</span>
          </div>
          {salaryBandInvalid ? (
            // role="alert" so a screen reader announces it when it appears, rather than
            // leaving the mistake visible only to someone looking at that part of the page.
            <p className="text-sm font-medium text-red-600 mt-1" role="alert">
              Maximum must be at least the minimum — {salaryMin} LPA down to {salaryMax} LPA is
              the wrong way round.
            </p>
          ) : null}
          <p className="text-xs text-zinc-500 mt-1">
            Lakhs per annum, decimals welcome — 5.5 to 11.3 means ₹5,50,000 to ₹11,30,000.
            Candidates whose expected salary is above the max are knocked out.
          </p>
        </Field>
      </div>

      {/* Campus Drive Section */}
      <div className="rounded-md border border-indigo-200 bg-indigo-50/40 p-3 space-y-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-indigo-900 cursor-pointer">
          <input
            type="checkbox"
            checked={isCampusDrive}
            onChange={(e) => setIsCampusDrive(e.target.checked)}
            className="accent-indigo-600 rounded"
          />
          Enable Campus Recruitment / College Hiring Mode
        </label>
        {isCampusDrive && (
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-indigo-100">
            <Field label="Minimum CGPA / Percentage Cutoff">
              <input
                type="number"
                step="0.1"
                min={0}
                max={100}
                value={campusMinCgpa}
                onChange={(e) => setCampusMinCgpa(e.target.value)}
                className="input bg-surface text-xs"
                placeholder="e.g. 7.5 (or 70%)"
              />
            </Field>
            <Field label="Max Allowable Standing Backlogs">
              <input
                type="number"
                min={0}
                value={campusMaxBacklogs}
                onChange={(e) => setCampusMaxBacklogs(e.target.value)}
                className="input bg-surface text-xs"
                placeholder="e.g. 0"
              />
            </Field>
            <Field label="Eligible Passing Batches (comma-separated)">
              <input
                value={campusAllowedBatches}
                onChange={(e) => setCampusAllowedBatches(e.target.value)}
                className="input bg-surface text-xs"
                placeholder="2025, 2026"
              />
            </Field>
            <Field label="Eligible Degrees / Branches (comma-separated)">
              <input
                value={campusAllowedBranches}
                onChange={(e) => setCampusAllowedBranches(e.target.value)}
                className="input bg-surface text-xs"
                placeholder="CSE, IT, ECE, EEE"
              />
            </Field>
          </div>
        )}
      </div>

      <Field label="Fit-score priorities (5 Categories)">
        {!useCustomWeights ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {WEIGHT_CATEGORIES.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={priorities[key]}
                    onChange={() => handlePriorityToggle(key)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="text-xs text-zinc-600 mt-2">
              Check any combination to weight the AI&apos;s fit score toward it — leave all
              unchecked for equal weights. Right now that works out to:{" "}
              {formatNormalizedWeights(
                weightSkills,
                weightExperience,
                weightEducation,
                weightCertifications,
                weightCommunication
              )}.
            </p>
          </>
        ) : (
          <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-3">
            <div className="grid grid-cols-2 gap-3">
              <WeightField label="Skills" value={weightSkills} onChange={setWeightSkills} />
              <WeightField label="Experience" value={weightExperience} onChange={setWeightExperience} />
              <WeightField label="Education" value={weightEducation} onChange={setWeightEducation} />
              <WeightField
                label="Certifications"
                value={weightCertifications}
                onChange={setWeightCertifications}
              />
              <WeightField
                label="Communication"
                value={weightCommunication}
                onChange={setWeightCommunication}
              />
            </div>
            <p className="text-xs text-zinc-600">
              Relative weights scaled automatically to sum to 100%:{" "}
              {formatNormalizedWeights(
                weightSkills,
                weightExperience,
                weightEducation,
                weightCertifications,
                weightCommunication
              )}.
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={() => handleCustomWeightsToggle(!useCustomWeights)}
          className="text-xs text-blue-700 underline mt-2"
        >
          {useCustomWeights ? "Use priority checkboxes instead" : "Fine-tune with custom weights"}
        </button>
      </Field>

      <Field label="Desktop integrity monitor">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={requireDesktopProbe}
            onChange={(e) => setRequireDesktopProbe(e.target.checked)}
          />
          Require the desktop probe (background-app/external-display monitor) before candidate can start
        </label>
      </Field>

      <Field label="Screening strictness">
        <select
          value={strictness}
          onChange={(e) => handleStrictnessChange(e.target.value as StrictnessKey)}
          className="input"
        >
          {Object.entries(STRICTNESS_PRESETS).map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>

        {strictness === "custom" && (
          <div className="mt-3 space-y-4 rounded-md border border-blue-200 bg-blue-50 p-3">
            <SliderField
              label="Auto-approve candidates who are at least a…"
              value={approveThreshold}
              onChange={handleApproveThresholdChange}
            />
            <SliderField
              label="Auto-decline candidates who are below a…"
              value={declineThreshold}
              onChange={handleDeclineThresholdChange}
            />
          </div>
        )}
      </Field>

      {error && <p className="text-sm text-red-600 whitespace-pre-line">{error}</p>}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-outline">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  /** Marks a field the form will not submit without — only title and job description,
   * which are the two the API rejects when blank (schemas/job.py). Everything else
   * defaults to an explicit "(Optional)" rather than to no marker at all: an unmarked
   * field reads as "nobody said", which is the ambiguity this is here to remove. */
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">
        {label}
        {required ? (
          <>
            {/* The asterisk is decorative: colour and a glyph carry no meaning to a
              * screen reader, so the word itself is announced instead. */}
            <span className="text-red-600 ml-0.5" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : (
          <span className="ml-1 text-xs font-normal text-zinc-500">(Optional)</span>
        )}
      </span>
      {children}
    </label>
  );
}

function WeightField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs font-medium mb-1">
        <span>{label}</span>
        <span className="text-blue-800">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-600"
      />
    </div>
  );
}

function SliderField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs font-medium mb-1">
        <span>{label}</span>
        <span className="text-blue-800">
          {getScoreLabel(value)} ({value})
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-600"
      />
    </div>
  );
}
