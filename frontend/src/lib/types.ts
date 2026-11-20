export type JobLevel = "fresher" | "experienced";
export type WorkMode = "remote" | "hybrid" | "onsite";
export type Bucket = "approved" | "review" | "declined";

export interface HrUser {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  is_admin: boolean;
}

export interface Job {
  id: string;
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
  core_skills?: string[];
  secondary_skills?: string[];
  irrelevant_skills?: string[];
  is_campus_drive?: boolean;
  campus_min_cgpa?: number | null;
  campus_allowed_batches?: number[];
  campus_allowed_branches?: string[];
  campus_max_backlogs?: number | null;
  require_desktop_probe: boolean;
  archived: boolean;
  archived_reason: string | null;
}

export interface ScoreCategory {
  score: number;
  reasons: string[];
}

export interface ScoreBreakdown {
  skills: ScoreCategory;
  experience: ScoreCategory;
  education: ScoreCategory;
  certifications: ScoreCategory;
  communication?: ScoreCategory;
}

export interface SkillsBreakdown {
  relevant_skills: string[];
  missing_critical_skills: string[];
  irrelevant_skills: string[];
}

export interface ProfessionFit {
  seniority_match: string;
  domain_alignment: string;
  career_trajectory_score: number;
  verdict: "aligned" | "partial" | "misaligned";
  insights: string[];
}

export interface CampusMetadata {
  roll_number?: string;
  cgpa?: number;
  graduation_year?: number;
  degree_branch?: string;
  standing_backlogs?: number;
  college?: string;
}

export interface ExperienceGap {
  start: string;
  end: string;
  months: number;
  ongoing: boolean;
}

export interface ExperienceAnalysis {
  /** Measured from the employment-history dates; null when they couldn't be read. */
  computed_years: number | null;
  /** What the resume itself claimed. */
  claimed_years: number | null;
  basis: "employment_history" | "stated" | "none";
  /** Some roles gave only a year, so the span is approximate. */
  approximate: boolean;
  unparsed_roles: string[];
  currently_employed: boolean;
  gaps: ExperienceGap[];
  total_gap_months: number;
  /** claimed minus computed; positive means the resume overstates it. */
  discrepancy_years: number | null;
}

export interface Candidate {
  id: string;
  job_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  parsed_profile: Record<string, unknown> | null;
  notice_period_days: number | null;
  expected_salary: number | null;
  ocr_fallback_used: boolean;
  is_duplicate_of: string | null;
  knockout_failed: boolean;
  knockout_reasons: string[];
  processing_failed: boolean;
  processing_error: string | null;
  fit_score: number | null;
  technical_score: number | null;
  communication_score: number | null;
  score_reasons: string[];
  score_breakdown: ScoreBreakdown | null;
  skills_breakdown: SkillsBreakdown | null;
  profession_fit: ProfessionFit | null;
  campus_metadata: CampusMetadata | null;
  experience_analysis: ExperienceAnalysis | null;
  manual_score_adjustment: number | null;
  manual_adjustment_reason: string | null;
  bucket: Bucket | null;
  override_bucket: Bucket | null;
  override_reason: string | null;
  uploaded_by_user_id: string | null;
  uploaded_by_email: string | null;
  source: string | null;
  archived: boolean;
  archived_reason: string | null;
}

export type SessionStatus =
  | "scheduled"
  | "identity_pending"
  | "in_progress"
  | "completed";

export interface InterviewSession {
  id: string;
  candidate_name: string;
  job_title: string | null;
  job_id: string | null;
  join_token: string;
  video_room_token: string;
  status: SessionStatus;
  integrity_score: number | null;
  integrity_needs_review: boolean;
  recording_file_path: string | null;
  transcript: string | null;
  transcript_status: "pending" | "done" | "failed" | null;
  interviewer_join_token: string | null;
  interviewer_recording_file_path: string | null;
  interviewer_transcript: string | null;
  interviewer_transcript_status: "pending" | "done" | "failed" | null;
  merged_transcript: string | null;
  qa_analysis: QaAnalysis | null;
  voice_tone_analysis: VoiceToneAnalysis | null;
  facial_affect_analysis: FacialAffectAnalysis | null;
  sentiment_trend: SentimentTrend | null;
  candidate_ip: string | null;
  interviewer_live_decision: "proceed" | "concern" | "reject" | null;
  interviewer_live_notes: string | null;
  ice_servers: IceServer[] | null;
  livekit_token: string | null;
  livekit_url: string | null;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SentimentTrend {
  sample_count: number;
  tension_distribution: Record<"low" | "medium" | "high", number>;
  dominant_tension: "low" | "medium" | "high" | "unknown";
  summary: string;
  error?: string;
}

export interface IdentityCheck {
  id: string;
  session_id: string;
  liveness_prompt: string | null;
  liveness_passed: boolean | null;
  match_confidence: number | null;
  match_verdict: "match" | "no_match" | "uncertain" | null;
  needs_human_review: boolean;
  cleared_by_hr: boolean;
  cleared_reason: string | null;
}

export interface QaExchange {
  question: string;
  answer: string;
  verdict: "relevant" | "partially_relevant" | "off_topic" | "evasive";
  explanation: string;
}

export interface QaAnalysis {
  no_questions_detected: boolean;
  exchanges: QaExchange[];
  error?: string;
}

export interface VoiceToneAnalysis {
  overall_tone: string;
  confidence_level: "low" | "medium" | "high";
  notes: string;
  error?: string;
}

export interface FacialAffectAnalysis {
  face_visible: boolean;
  overall_affect: string;
  tension_level: "low" | "medium" | "high";
  notes: string;
  error?: string;
}

export type SignalType =
  | "tab_switch"
  | "window_blur"
  | "copy_paste"
  | "second_face"
  | "second_voice"
  | "voice_mismatch"
  | "gaze_off_screen"
  | "excessive_motion"
  | "virtual_camera"
  | "response_timing_anomaly"
  | "unauthorized_app_detected"
  | "external_display_detected"
  | "fullscreen_exit"
  | "devtools_open"
  | "screen_share_partial"
  | "screen_share_stopped"
  | "screen_share_never"
  | "location_mismatch"
  | "ai_extension_detected"
  | "teleprompter_reading"
  | "proctoring_tamper_detected"
  | "sustained_downward_gaze";

export interface LiveSignalEvent {
  signal_type: SignalType;
  session_offset_ms: number;
  meta: Record<string, unknown>;
}

export interface IntegrityFlag {
  id: string;
  session_offset_ms: number;
  severity: number;
  summary: string;
  reviewed: boolean;
  reviewer_decision: string | null;
  reviewer_note: string | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface L1PhoneScreening {
  id: string;
  candidate_id: string;
  job_id: string | null;
  audio_file_path: string | null;
  audio_duration_seconds: number | null;
  is_stereo_split: boolean;
  transcript: string | null;
  transcript_segments: TranscriptSegment[];
  technical_score: number | null;
  communication_score: number | null;
  overall_l1_score: number | null;
  verdict: "recommend_l1" | "recommend_l2" | "hold" | "decline" | "senior_review";
  call_summary: string | null;
  extracted_details: Record<string, string>;
  strengths: string[];
  red_flags: string[];
  next_steps: string[];
  voice_tone_notes: Record<string, string>;
  uploaded_by_user_id: string | null;
  uploaded_by_email?: string | null;
  created_at: string;
}

export interface DashboardSummary {
  jobs: { active: number; archived: number };
  candidates: {
    total_active: number;
    approved: number;
    review: number;
    declined: number;
    needs_review: number;
    processing_failed: number;
    duplicates: number;
  };
  interviews: { pending: number; completed: number; awaiting_review: number };
  recent_candidates: Array<{
    id: string;
    full_name: string | null;
    job_id: string;
    job_title: string | null;
    bucket: Bucket | null;
    fit_score: number | null;
    created_at: string | null;
  }>;
  recent_activity: Array<{
    actor: string;
    action: string;
    detail: Record<string, unknown> | null;
    created_at: string | null;
  }>;
}

// ---- AI Candidate Comparison -----------------------------------------------------------
export interface CompareRequest {
  candidate_ids: string[];
}

export interface ComparisonScores {
  fit_score: number | null;
  technical_score: number | null;
  communication_score: number | null;
  manual_score_adjustment: number | null;
  manual_adjustment_reason: string | null;
  effective_fit_score: number | null;
}

export interface ComparisonL1 {
  overall_l1_score: number | null;
  technical_score: number | null;
  communication_score: number | null;
  verdict: string | null;
  strengths: string[];
  red_flags: string[];
  summary: string | null;
}

export interface ComparisonInterview {
  status: string | null;
  interviewer_decision: string | null;
  qa_relevant_count: number | null;
  qa_total_count: number | null;
  /** Review-context only — never a competence/ranking signal. */
  integrity_needs_review: boolean;
  completed_at: string | null;
}

export interface ComparisonTableRow {
  candidate_id: string;
  ref: string;
  full_name: string | null;
  bucket: string | null;
  override_bucket: string | null;
  scores: ComparisonScores;
  relevant_skills: string[];
  missing_critical_skills: string[];
  years_experience: number | string | null;
  education: string[];
  certifications: string[];
  knockout_failed: boolean;
  knockout_reasons: string[];
  l1: ComparisonL1 | null;
  interview: ComparisonInterview | null;
  data_completeness: string[];
}

export interface ComparisonCandidateAnalysis {
  candidate_id: string;
  ref: string;
  strengths: string[];
  gaps: string[];
  evidence: string[];
  insufficient_data: string[];
}

export interface ComparisonDifferentiator {
  criterion: string;
  detail: string;
}

export interface AIComparison {
  overall_summary: string;
  per_candidate: ComparisonCandidateAnalysis[];
  differentiators: ComparisonDifferentiator[];
  follow_up_questions: string[];
  conclusion: string;
}

export interface CandidateComparisonResponse {
  job: { id: string; title: string };
  generated_at: string;
  candidate_count: number;
  max_candidates: number;
  table: ComparisonTableRow[];
  analysis: AIComparison;
  ai_available: boolean;
  ai_error: string | null;
}

// ---- SMTP / email settings -------------------------------------------------------------
export type EmailAccount = "gmail" | "outlook";

export interface GmailSlotStatus {
  configured: boolean;
  sender_email: string | null;
  from_name: string | null;
  host: string | null;
  port: number | null;
  use_tls: boolean;
  has_password: boolean;
}

export interface OutlookSlotStatus {
  configured: boolean;
  sender_email: string | null;
  from_name: string | null;
  tenant_id: string | null;
  client_id: string | null;
  has_client_secret: boolean;
}

export interface SmtpConfigStatus {
  active: EmailAccount | null;
  gmail: GmailSlotStatus;
  outlook: OutlookSlotStatus;
}

export interface GmailSlotIn {
  sender_email: string;
  from_name?: string | null;
  /** Blank keeps the previously saved password. */
  password: string;
  host?: string | null;
  port?: number | null;
  use_tls: boolean;
}

export interface OutlookSlotIn {
  sender_email: string;
  from_name?: string | null;
  tenant_id?: string | null;
  client_id?: string | null;
  /** Blank keeps the previously saved client secret. */
  client_secret: string;
}

export interface SmtpConfigIn {
  active: EmailAccount | null;
  gmail: GmailSlotIn;
  outlook: OutlookSlotIn;
}

export interface BulkUploadBatch {
  id: string;
  job_id: string;
  batch_type: "zip" | "csv";
  status: "pending" | "processing" | "completed" | "failed";
  total_count: number;
  processed_count: number;
  failed_count: number;
  error_log: Array<{ row?: number; identifier?: string; error: string }>;
  created_at: string;
  completed_at: string | null;
}
