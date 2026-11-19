# TyHire — Project Notes & Change Log

> **Purpose of this file.** A living reference for the TyHire codebase: what it is, how it's
> built, and how to run it locally — **plus an atomic, dated change log** of every change we
> make from here on. Update the [Change Log](#change-log) whenever anything changes (code,
> schema, infra, config, deployment), one entry per change: what, why, files touched, and how
> it was verified.
>
> Maintained with Claude Code. Last full codebase review: **2026-10-21** (branch `beta`, tip
> `a12a54a`).

---

## 1. What TyHire is

TyHire is an **AI-assisted hiring platform** by Tychons Solution Pvt Ltd, in two halves:

1. **Resume screening (ATS)** — upload resumes (single, or campus ZIP/CSV bulk), auto-parse,
   dedupe, apply hard knockout rules, AI-score against a job, and bucket candidates into
   **approved / review / declined**. Includes an **L1 HR phone-screening** flow (upload a
   screening-call recording → transcript + scored evaluation).
2. **Proctored interviews (integrity)** — browser-to-browser video interviews with identity
   verification, screen share, in-browser proctoring signals (tab switches, gaze, second
   face, virtual camera, AI-extension detection, teleprompter reading, etc.), live AI answer
   evaluation for the interviewer, and a post-interview consolidated scorecard.

**Design philosophy (stated throughout the code):** AI "soft" signals (facial affect, voice
tone, integrity flags, identity match, geolocation) are **human-review aids, never automated
pass/fail**. Nothing auto-rejects a candidate; everything is fused server-side and surfaced to
a human reviewer, with strong anti-bias caveats in the prompts.

---

## 2. Architecture & tech stack

```
┌─────────────┐     cookie (HR) / token (candidate+interviewer)     ┌──────────────┐
│  Frontend   │ ───────────────  HTTPS/WS  ──────────────────────▶ │   Backend    │
│ Next.js 16  │                                                     │  FastAPI     │
│ (Turbopack) │ ◀────────── WebRTC signaling (WS) ────────────────  │  (uvicorn)   │
└─────────────┘                                                     └──────┬───────┘
      ▲  browser-to-browser WebRTC media (P2P, coturn TURN fallback)       │
      │                                                             ┌───────┴───────┐
   candidate ◀───────────── coturn (TURN relay) ─────────────▶ interviewer │ PostgreSQL 16 │
                                                                     │  (JSONB)      │
                                                                     └───────────────┘
```

- **Frontend:** Next.js **16.2.12** (App Router, Turbopack), React 19, Tailwind v4,
  `@mediapipe/tasks-vision` (in-browser face/gaze), optional LiveKit client.
- **Backend:** **FastAPI** (Python **3.11** in Docker), SQLAlchemy 2, Pydantic 2. Heavy AI
  use via the **OpenAI** API. Media processing via **ffmpeg/ffprobe**.
- **Database:** **PostgreSQL 16** (JSONB-heavy). SQLite fallback exists in code.
- **Realtime:** hand-rolled **WebRTC** (RTCPeerConnection + WebSocket signaling, perfect
  negotiation) *or* **LiveKit** if the session carries a LiveKit token/URL. **coturn** is the
  TURN relay fallback for non-P2P connections.
- **Infra:** `docker-compose.yml` runs **postgres + coturn + backend + frontend**.

### Repository layout
```
tyhire/
├─ backend/
│  ├─ app/
│  │  ├─ api/v1/        # routers: auth, oauth, jobs, candidates, interviews, signaling, l1_screening
│  │  ├─ core/          # config.py (settings/env), logging.py
│  │  ├─ db/            # session.py (engine, SessionLocal, Base, get_db)
│  │  ├─ models/        # SQLAlchemy models (see §4)
│  │  ├─ schemas/       # Pydantic request/response schemas
│  │  ├─ services/      # business logic (see §5)
│  │  ├─ jobs/          # standalone cron entrypoints (retention sweep, encryption backfill)
│  │  └─ main.py        # app setup, middleware, startup (create_all + ad-hoc migrations + admin), retention sweeper
│  ├─ Dockerfile        # python:3.11-slim + ffmpeg
│  └─ requirements.txt
├─ frontend/            # Next.js app (src/app pages, src/components, src/lib)
├─ desktop-probe/       # probe.js — optional desktop monitor a job can require
├─ docker-compose.yml
├─ .env                 # root — used by docker compose (gitignored)
└─ PROJECT_NOTES.md     # this file
```

---

## 3. Authentication model

Two completely separate auth schemes:

| Who | Mechanism | Detail |
|---|---|---|
| **HR users** | Signed session **cookie** `hr_session` | Stateless HMAC-SHA256 (signed with `SESSION_SECRET`), 7-day TTL, `httponly`, `samesite=lax`, **`secure=False` (dev)**. Re-checked against the DB on every request, so a deactivated/demoted user loses access immediately. Frontend sends `credentials:"include"`; a 401 auto-redirects to `/login`. |
| **Candidate** | Header token `X-Interview-Token` = `session.join_token` | Constant-time compare. Mutating candidate endpoints reject an already-`completed` session with 409. |
| **Interviewer** | Header token `X-Interviewer-Token` = `session.interviewer_join_token` | Separate secret from the candidate's. |

Dependencies: `require_hr_auth` (any active HR user), `require_admin` (is_admin), plus the two
token validators. Login uses bcrypt with a constant-time dummy-hash path (anti-enumeration);
passwords truncated to 72 bytes. **Google/Microsoft OAuth** exists but only logs in an
**already-existing** active HR user (never self-registers).

---

## 4. Data model (PostgreSQL)

All routers are mounted under **`/api/v1`**. Tables (key columns):

- **users** — `id`, `email` (unique), `password_hash` (bcrypt), `display_name`, `is_active`,
  `is_admin`, `created_at`.
- **jobs** — `title`, `jd_text`, `required_skills` (JSON); enums `JobLevel{fresher,experienced}`,
  `WorkMode{remote,hybrid,onsite}`; knockout rules (`min_years_experience`, `allowed_locations`,
  `max_notice_period_days`, `salary_band_min/max`); triage thresholds (`approve_threshold`=75,
  `decline_threshold`=40); scoring weights (`weight_skills/experience/education/certifications`
  =0.20, `weight_communication`); skill relevancy (`core/secondary/irrelevant_skills`); campus
  fields (`is_campus_drive`, `campus_min_cgpa`, `campus_allowed_batches/branches`,
  `campus_max_backlogs`); `require_desktop_probe`; `archived`/`archived_reason`.
- **candidates** — `job_id` (FK, not null), `resume_file_path`, `full_name/email/phone`,
  `parsed_profile` (JSON), `notice_period_days`, `expected_salary`, `ocr_fallback_used`,
  `is_duplicate_of` (self-FK, SET NULL), `knockout_failed`/`knockout_reasons`,
  `processing_failed`/`processing_error`, scores (`fit_score`, `technical_score`,
  `communication_score`, `score_reasons`, `score_breakdown`, `skills_breakdown`,
  `profession_fit`, `campus_metadata`), `manual_score_adjustment`/`manual_adjustment_reason`,
  enum `Bucket{approved,review,declined}` (`bucket` computed, `override_bucket` HR override
  wins), `uploaded_by_user_id`, `source`, `archived`.
- **interview_sessions** — `candidate_id` (SET NULL), `candidate_name`, `job_id`; three
  secrets `join_token`/`interviewer_join_token`/`video_room_token` (all unique); enum
  `SessionStatus{scheduled,identity_pending,in_progress,completed}`; candidate recording
  (`recording_file_path`, `recording_segment_paths` JSON, `transcript`, `transcript_status`,
  `started_recording_at`) and parallel `interviewer_*` set; analyses (`merged_transcript`,
  `qa_analysis`, `voice_tone_analysis`, `facial_affect_analysis`, `sentiment_trend`,
  `qa_evaluations` — all JSON); `integrity_score`, `integrity_needs_review`,
  `probe_last_seen_at`, `candidate_ip`, `interviewer_live_decision`/`interviewer_live_notes`.
- **identity_checks** — `session_id`, `id_document_path`, `selfie_path`,
  `voice_enrollment_path` (cleared on retention), `liveness_prompt/passed`, `match_confidence`
  (0–1), `match_verdict` (match/no_match/uncertain), `needs_human_review`,
  `cleared_by_hr`/`cleared_reason`.
- **signal_events** — `session_id`, enum `SignalType` (~19 kinds, see §7), `session_offset_ms`,
  `weight` (float), `meta` (JSON).
- **integrity_flags** — fused clusters: `session_offset_ms`, `severity`, `summary`,
  `contributing_signal_ids`, `reviewed`/`reviewer_decision`/`reviewer_note`.
- **sentiment_samples** — `session_id`, `session_offset_ms`, `facial_affect`, `voice_tone`.
- **l1_phone_screenings** — `candidate_id` (**ON DELETE CASCADE** — differs from most),
  `job_id`, `audio_file_path` (encrypted), `audio_duration_seconds`, `is_stereo_split`,
  `transcript`/`transcript_segments`, scores (`technical/communication/overall_l1_score`),
  `verdict`, `call_summary`, `extracted_details`, `strengths/red_flags/next_steps`,
  `voice_tone_notes`.
- **bulk_upload_batches** — `job_id` (CASCADE), `batch_type` (zip/csv), `status`,
  `total/processed/failed_count`, `error_log`.
- **audit_logs** — `candidate_id` (SET NULL), `interview_session_id`, `actor`
  ("system" | "hr:<email>"), `action`, `detail` (JSON). Audit trail is detached, never
  destroyed, on hard deletes.

---

## 5. Backend services (`app/services/`)

**AI plumbing:** `openai_client.call_tool(system, user_content, tool)` forces one OpenAI
function-tool call, returns parsed JSON, raises typed `OpenAIToolError` on any failure.

**ATS pipeline:** `text_extract` (PDF/DOCX + OCR fallback via PyMuPDF→OpenAI vision) →
`resume_parser` (structured profile) → `dedupe` (email/phone/rapidfuzz name) → `knockout`
(pure rule filters incl. campus CGPA/batch/branch/backlogs) → `scoring` (OpenAI sub-scores,
**deterministic** weighted total for auditability, **PII redacted before scoring**) →
`triage` (bucket). Plus `keyword_stuffing` (invisible/microscopic resume text detection),
`fit_report` (candidate PDF via fpdf2), `jd_suggestion` (AI JD drafting),
`question_generator` (interview questions, canned fallback).

**Interview media:** `audio_extract` (ffmpeg → 16kHz WAV), `video_extract` (ffmpeg frames),
`transcription` (Whisper, auto-chunks >24MB), `transcript_merge` (candidate+interviewer onto
one timeline), `facial_analysis` (OpenAI vision), `voice_tone` (OpenAI **`gpt-audio`**),
`voice_verification` (OpenAI **`gpt-4o-audio-preview`** speaker match — **⚠️ fails open**),
`identity_check` (OpenAI vision ID-vs-selfie; degrades to uncertain+review).

**Integrity:** `integrity` (rule-based signal fusion + optional scikit-learn IsolationForest
anomaly layer, `HAS_ML` flag), `geolocation` (offline MaxMind GeoLite2), `sentiment_aggregate`.

**Live/call:** `video_provider` (ICE servers: Google STUN + coturn TURN with HMAC creds),
`livekit_service` (optional JWT), `answer_evaluator` (live answer scoring), `qa_verification`
(post-hoc Q&A extraction).

**L1 + campus:** `l1_phone_screener` (ffprobe→Whisper→gpt-audio→structured eval),
`campus_screening` (ZIP/CSV bulk, async orchestrator w/ concurrency semaphore, per-item DB
session, tracks `BulkUploadBatch`).

**Reporting:** `consolidated_report` (scorecard dict + PDF; `send_consolidated_report`
currently **audit-logs "dispatched" but doesn't actually email — stub**).

**Storage/retention:** `storage` (local-disk behind a narrow interface; opt-in Fernet
encryption; segment-aware recording append + ffmpeg concat; decrypt-on-demand temp copies;
path-traversal guard), `storage_backfill` (one-shot encrypt of pre-existing plaintext;
idempotent, crash-safe), `retention` (`purge_expired_identity_media` +
`purge_expired_l1_recordings`), `auth_session` (signed cookie helpers).

**Dependency requirements:**
- **OpenAI key** needed for: resume_parser, OCR, scoring, jd_suggestion, question_generator,
  transcription, facial_analysis, voice_tone (`gpt-audio`), voice_verification
  (`gpt-4o-audio-preview`), identity_check, answer_evaluator, qa_verification,
  l1_phone_screener, campus (indirect).
- **ffmpeg/ffprobe** (on PATH) needed for all audio/video processing + storage concat.
- **Optional:** numpy+scikit-learn (integrity ML), geoip2+`.mmdb` (location), cryptography
  (encryption), authlib (LiveKit/OAuth).

---

## 6. Configuration / env vars (`app/core/config.py`)

Pydantic `BaseSettings`; env var names are the UPPERCASE field names.

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://hr_tool:hr_tool@localhost:5432/hr_tool` | DB connection |
| `OPENAI_API_KEY` | `""` | Empty disables all AI features |
| `OPENAI_MODEL` | `gpt-4o` | Default chat/vision model (voice models are hardcoded separately) |
| `STORAGE_ROOT` | `../storage` | Local file storage root |
| `CORS_ORIGINS` | `["http://localhost:3000"]` | JSON array, not CSV |
| `SESSION_SECRET` | **required, no default** | Signs HR cookie + OAuth state |
| `TURN_SECRET` | **required, no default** | HMAC for coturn creds; must match coturn |
| `TURN_DOMAIN` | `localhost` | coturn domain |
| `INITIAL_ADMIN_EMAIL` / `_PASSWORD` | `None` | Bootstrap first admin iff users table empty |
| `GEOIP_DB_PATH` | `None` | MaxMind `.mmdb`; location signal skipped if unset |
| `STORAGE_ENCRYPTION_KEY` | `None` | Fernet key; opt-in; **loss = permanent data loss** |
| `IDENTITY_MEDIA_RETENTION_DAYS` | `90` | Purge window for ID media + L1 audio |
| `RETENTION_SWEEP_ENABLED` | `True` | In-process daily sweep (disable for multi-worker) |
| `RETENTION_SWEEP_INTERVAL_HOURS` | `24` | Sweep interval |
| `GOOGLE_*` / `MICROSOFT_*` | `None` | OAuth SSO (existing users only) |
| `OAUTH_REDIRECT_BASE_URL` | `http://localhost:8000/api/v1` | OAuth redirect base |
| `FRONTEND_BASE_URL` | `http://localhost:3000` | Frontend base |
| `LIVEKIT_URL` / `_API_KEY` / `_API_SECRET` | `None` | Optional LiveKit transport |
| `LOG_LEVEL` | `INFO` | Root logger level |

**Which `.env` matters:** the **Docker backend** reads the **root `.env`** (via compose's
`environment:` interpolation). `backend/.env` is only used when running uvicorn locally. Both
are gitignored.

### Startup (`app/main.py`)
- `Base.metadata.create_all()` (creates missing **tables** only — never missing columns).
- **Ad-hoc runtime migrations:** raw `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for Postgres
  (+ SQLite fallback), adding newer columns/enum values. **No Alembic.** Failures are
  swallowed (logged at debug). ⚠️ This is why **reusing an old DB volume across schema changes
  can break** — not every new column is covered. See [local-dev DB workflow](#9-infrastructure--local-dev).
- Admin bootstrap from `INITIAL_ADMIN_*` iff users table empty.
- Async retention sweeper loop (if enabled); cancelled on shutdown. **Assumes single worker.**
- `GET /health` (public, unprefixed) → `{"status":"ok"}`.
- **No public static mount** — all media served via authenticated, decrypting, Range-capable
  proxy endpoints.
- `app/jobs/run_retention_sweep.py` and `encrypt_storage_backfill.py` are `python -m`
  entrypoints for external cron (exit non-zero on failure).

---

## 7. Frontend (`frontend/src`)

**API layer (`lib/api.ts`):** `BASE_URL` = `NEXT_PUBLIC_API_BASE_URL` ??
`http://localhost:8000/api/v1`. Thin fetch wrapper, all requests `credentials:"include"`; 401
→ redirect `/login`. Helpers `getJson/postJson/postForm/patchJson/deleteJson`. Candidate/
interviewer calls pass the `X-Interview-Token` / `X-Interviewer-Token` header. `MEDIA_BASE_URL`
= BASE_URL minus `/api/v1`. WS URL derived from BASE_URL.

**Pages (`app/`):** `layout` (DialogProvider + SiteHeader shell) · `/` (landing) · `/login`
(→ redirects to `/dashboard`) · `/dashboard` (recruiter home: KPI cards, needs-attention queue,
pipeline bars, interviews, recent activity/candidates — from `GET /dashboard/summary`) ·
`/jobs` (list; clone/archive/delete) · `/jobs/new` (JobForm) · `/jobs/[jobId]` (candidate
pipeline board — resume upload, campus bulk, buckets) · `/candidates/[candidateId]` (detail:
fit report PDF, manual adjust ±20, screening details, override, schedule interview, L1 audio) ·
`/interviews/new` (standalone scheduler → shareable links) · `/interview/[token]` (candidate
staged flow) · `/interview/interviewer/[token]` (interviewer cockpit) · `/review` (queue) ·
`/review/[sessionId]` (full interview review) · `/settings/users` (HR user admin).

**Components:** `JobForm` (large create/edit, AI JD draft, weights normalized to 1.0,
strictness presets) · `SiteHeader` (HR nav; hidden on `/interview/*` and `/login`) · `Dialog`
(promise-based confirm/prompt/notify) · `WebRTCRoom` (dual-mode LiveKit **or** raw
RTCPeerConnection + WS signaling with perfect negotiation; exposes mic/camera/mute API) ·
`CampusBulkUploader` (ZIP or CSV+ZIP, polls batch progress) · `L1AudioUploader` ·
`EyeTrackingOverlay` · `LiveTranscriptFeed`.

**lib utilities:** `types.ts` (domain types) · `faceDetection.ts` (MediaPipe FaceLandmarker,
self-hosted WASM) · `eyeGazeTracker.ts` (yaw/pitch + teleprompter-reading heuristic) ·
`fullscreen.ts` · `extensionDetection.ts` (AI-helper extension scan) · `integrityLabel.ts` /
`scoreLabel.ts` (bands) · `useLiveSpeech.ts` (6s audio chunks → server STT).

### WebRTC interview flow
- **Candidate** state machine: `loading → consent → identity → screenshare → starting →
  ready → interview → completed`. Identity step captures selfie + liveness (2-frame pixel
  diff) + **5s voice enrollment** + government-ID photo (re-encoded to JPEG for HEIC). Start
  gate enforces desktop probe (if required) + identity check. Interview mounts `WebRTCRoom`,
  records 5s chunks → `recording-chunk`, samples sentiment every 60s, streams live transcript
  (6s chunks), batches integrity signals every 3s.
- **Interviewer cockpit:** joins, records own audio, polls live signals (3s)/sentiment (8s)/
  transcript (2.5s), gets AI-suggested questions, runs debounced live answer evaluation, logs
  a live decision, and on end-call loads the consolidated scorecard (+ email/PDF).

### In-browser integrity signals (`SignalType`, ~19 kinds)
`tab_switch`, `window_blur` (deduped within 500ms), `copy_paste`, `fullscreen_exit`,
`devtools_open` (low-confidence heuristic), `ai_extension_detected`,
`external_display_detected`, `virtual_camera`, `second_face`/`gaze_off_screen`/
`excessive_motion` (MediaPipe, streak-gated so single bad frames don't flag — raw video never
leaves the browser), `screen_share_partial`/`screen_share_stopped`, plus server/probe-side
`second_voice`, `voice_mismatch`, `response_timing_anomaly`, `unauthorized_app_detected`,
`location_mismatch`, `teleprompter_reading`.

---

## 8. Key end-to-end workflows

1. **Resume screening:** HR creates a job → uploads resumes → each is parsed, deduped,
   knockout-checked, AI-scored, bucketed. HR reviews the board, can override buckets, adjust
   scores, add screening details, download a fit-report PDF.
2. **Campus bulk:** upload a ZIP of resumes (or a CSV roster + ZIP) → background batch job
   processes each with a concurrency cap; frontend polls batch progress.
3. **L1 phone screening:** HR uploads a screening-call recording on a candidate → transcript +
   voice tone + structured AI evaluation (scores, verdict, extracted logistics, strengths/red
   flags/next steps).
4. **Proctored interview:** HR schedules an interview (from an approved candidate, or
   standalone) → candidate + interviewer join via token links → live WebRTC call with
   proctoring → candidate recording transcribed/analyzed in the background → session lands in
   the review queue if integrity needs review → HR reviews flags, recordings, transcript, and
   decisions.

---

## 9. Infrastructure & local dev

### Running the stack (all Docker — the working path on this machine)
From `D:\TYHIRE\tyhire`, with **Docker Desktop running**:
```bash
docker compose up -d
```
| Service | Container | Host port |
|---|---|---|
| Frontend | `tyhire-frontend-1` | **3000** |
| Backend | `tyhire-backend-1` (Python 3.11) | **8000** (docs at `/docs`) |
| Postgres | `tyhire-postgres-1` (16-alpine) | **5442** |
| coturn | `tyhire-coturn-1` | 3478 + **40000-40040/udp** |

- **App:** http://localhost:3000 — login **`admin@tyhire.local` / `admin1234`** (seeded).
- Stop: `docker compose down` (keeps DB volume `tyhire_pgdata`). Add `-v` to wipe the DB.
- Logs: `docker compose logs -f backend`.

### Local-dev gotchas (important)
- **Backend cannot run locally on this machine's Python 3.13.** The pinned `numpy==1.26.4` /
  `scikit-learn==1.5.1` have no 3.13 wheels and won't compile without Visual Studio. The
  Docker image uses Python **3.11**, where they install fine. → **Run the backend in Docker.**
- **Windows coturn port fix (local, uncommitted):** Windows reserves UDP `49152-49251`, so
  coturn's default relay range `49160-49200` fails to bind. `docker-compose.yml` is locally
  edited to use **`40000-40040`** instead. Kept **uncommitted** so `beta` stays in sync with
  upstream; it's a reasonable upstream PR candidate (the default range is Windows-unfriendly).
- **OpenAI key precedence:** Docker compose lets a **shell/OS environment variable override
  the `.env` file**. A stale User-level `OPENAI_API_KEY` previously shadowed the `.env` key and
  caused 401s; it was removed. Put the key in the **root `.env`** and recreate the backend
  (`docker compose up -d --force-recreate backend`) — a plain `restart` does **not** re-read
  `.env`.
- **Schema changes require a DB reset.** Because migrations are ad-hoc (no Alembic) and
  `create_all` never adds columns to existing tables, pulling new code that changes models can
  leave the reused volume missing columns → 500s (e.g. `UndefinedColumn`). After such a pull:
  ```bash
  docker compose down -v && docker compose up -d
  ```
  (Wipes local data — fine for dev; rebuilds the full current schema and re-seeds the admin.)

### Git
- Remotes: `origin` = `DineshBastin04/tyhire` (upstream; no write access for `Suriyan12`),
  `fork` = `Suriyan12/tyhire` (our fork, pushable). Working branch: `beta`.
- Our fixes were merged upstream via **PR #1** and are in `origin/beta`.

---

## 10. Known issues / risks (flagged by code analysis — verify before acting)

> These came out of the codebase review. Some are confirmed design facts; a few are
> analysis-flagged and should be verified in code before relying on them.

1. **Unauthenticated interview endpoints (highest concern).** ~9 `/interviews/{session_id}/…`
   endpoints have **no auth dependency** — including `consolidated-report`,
   `consolidated-report/pdf`, `qa-evaluations`, `evaluate-live-answer`,
   `rate-question-answer`, `live-transcript(s)`, `suggested-questions`, and **`POST
   /send-report`** (emails a full-evaluation PDF). Anyone who knows/guesses a session UUID can
   read sensitive data, trigger LLM calls, or fire emails.
2. **`voice_verification` fails open** — returns `match=True` on any error (missing files, API
   failure), silently bypassing the anti-impersonation check. (Contrast `identity_check`, which
   safely degrades to uncertain + human review.)
3. **Login cookie `secure=False`** (hardcoded for localhost) — must be flipped for HTTPS prod.
4. **Ad-hoc DDL migrations in `on_startup`** with swallowed exceptions — schema drift / silent
   migration failures possible; runs every startup; not Alembic.
5. **In-memory, single-process state:** WebRTC signaling room registry, live-transcript
   buffers, suggested-questions cache, and the in-process retention sweeper all assume one
   worker/replica.
6. **`send_consolidated_report`** — audit-logs "dispatched" but may not actually send email
   (appears stubbed). *(Verify — the API report notes a `/send-report` that "sends email".)*
7. **`L1Verdict` enum:** `recommend_l2 = "recommend_l1"` (duplicate value aliases the member).
   Low impact — the DB column is a plain String. *(Flagged; verify.)*
8. **`typing.Any` possibly not imported in `candidates.py`** (`import_campus_csv_roster`) →
   potential `NameError` when that endpoint runs. *(Flagged; verify.)*
9. **Encryption key loss = permanent unrecoverability** of all encrypted media (documented).

---

## Change Log

> **Convention:** newest first. One entry per change. Format:
> `### YYYY-MM-DD — <title>` then what / why / files / verification.
> Keep entries atomic; add one whenever code, schema, infra, config, or deployment changes.

### 2026-11-19 — Fix: Consolidated Scorecard showed template/placeholder values, not real scores
- **What:** The scorecard modal now shows **real** values, adds a genuine **Interview Score**, and
  always loads live data when opened.
- **Why (root cause):** (1) The modal had **hardcoded fake fallbacks** — when a real value was null
  it rendered invented numbers (`85/100` fit, `Clean (100)` proctoring, `Proceed` decision, `?? 85`
  per question), so an unscored candidate looked like 85/100. (2) Two of the three "View
  Consolidated Scorecard" buttons opened the modal with `setShowScorecard(true)` **without fetching**
  the report, so even real data never loaded on those paths (only the auto-open after call-end
  fetched it).
- **How:**
  - **Backend (`services/consolidated_report.py`):** compute `interview_qa_score` = average AI
    accuracy across the questions actually evaluated this interview (+ `evaluated_questions_count`),
    `None` when nothing was evaluated. Added both to the report dict and a new "Interview Q&A Score"
    line to the PDF banner; the PDF's absent-value labels made honest ("Not Scored" / "Pending" /
    "No decision").
  - **Frontend (`interview/interviewer/[token]/page.tsx`):** both "View Consolidated Scorecard"
    buttons now call `loadConsolidatedReport` (fetch then open). Modal metrics rebuilt to 4 tiles —
    **Interview Score** (real, with "N answers scored"), AI Fit (Resume), Proctoring, Interviewer
    Read — each showing an honest state ("—/No answers evaluated", "Not scored", "Pending",
    "Pending") in muted grey instead of a fake number. Per-question accuracy shows "—" when null
    instead of `85`.
  - Note: "30/100 · Strong Pass" seen in the old card is real data — the AI accuracy (30) beside the
    rating the **interviewer** clicked (Strong Pass); not a bug, just interviewer input.
- **Verification:** backend `py_compile` OK; `build_consolidated_report` over real sessions returns
  real `interview_qa_score` (e.g. 55.0 from 2 answers, None when none) + builds the PDF; frontend
  `tsc` 0, eslint clean (pre-existing page errors only); services healthy after restart. **Live
  check pending (manual).**

### 2026-11-19 — Feature: answer-driven follow-up questions (understand the response, suggest 1–3)
- **What:** The live answer evaluator now (a) works with OR without an active question, (b) suggests
  **up to 3 ranked follow-ups** grounded in what the candidate actually said (not just a missing
  keyword), and (c) each follow-up is **clickable → becomes the Active Question**. Builds on the
  instant `candidate_turn` trigger from the streaming-transcription feature.
- **Why:** The old `/evaluate-live-answer` produced a single follow-up and only ran when a suggested
  question was selected — so during open conversation it did nothing. User wanted the system to
  understand the candidate's response and suggest follow-ups from it.
- **How — backend (`services/answer_evaluator.py`):** two modes, still ONE OpenAI call per turn.
  *Question mode* (question present): existing scoring + `suggested_followups` (array 1–3) grounded
  in the answer. *Free-form mode* (no question): new `FREEFORM_FOLLOWUP_TOOL` returns an
  `understanding` (what they claimed) + 1–3 follow-ups; scoring fields come back null/empty. One
  normalized response shape via `_shape(...)` with a `mode` field; `suggested_followup` (singular)
  kept = `followups[0]` for back-compat. Graceful heuristic fallback on API failure, per mode.
  `EvaluateLiveAnswerRequest.question_id/question_text` made Optional (`schemas/interview.py`); the
  route passes them through unchanged.
- **How — frontend (`interview/interviewer/[token]/page.tsx`):** `AnswerEvaluation` gained `mode` +
  `suggested_followups` (accuracy/verdict/depth now nullable). `runAnswerEvaluation` no longer bails
  without an active question — it sends the question fields only when one is selected, else free-form.
  The instant `onCandidateTurn` trigger now skips trivial turns (<6 words) to cap cost. New
  `askFollowup(text)` promotes a follow-up to the Active Question. UI: the Active Question card lists
  up to 3 clickable follow-ups; a new "💡 Live Follow-ups" box (with a "They said:" understanding
  line) shows when no question is active.
- **Verification:** backend `py_compile` OK; functional test of both modes against the real API —
  question mode scored a vague answer 10/superficial with probing follow-ups; free-form produced an
  accurate understanding + 3 sharp follow-ups ("super fast" → "how did you measure performance?").
  Frontend `tsc` 0; eslint clean (pre-existing page errors only); both services healthy after
  restart. **Live call test pending (manual).**

### 2026-11-18 — Feature: instant streaming live transcription (Route A) + instant follow-ups
- **What:** Replaced the ~12s-latency live transcript (12s audio chunks → upload → transcribe →
  2.5s poll) with **sub-second streaming** over a WebSocket, and made the interviewer's suggested
  **follow-up** fire the instant a candidate finishes a turn instead of on a 3.5s debounce. Behind a
  feature flag, with the old chunk pipeline kept as an automatic fallback.
- **Why:** User reported the transcript lagged badly; wanted it instant plus live follow-up
  questions off the candidate's answers.
- **How — architecture (backend relay, API key never leaves the server):** each interview side opens
  `WS /interviews/{id}/ws/transcribe?token=..&role=..`; the backend relays that side's mic (PCM16
  mono 24kHz) to a per-connection OpenAI realtime transcription session and fans transcript events
  to the interviewer's socket. Mirrors `signaling.py` (query-param token auth via the shared
  `_authorize`, in-memory per-session room registry, single-process assumption).
- **OpenAI protocol (verified end-to-end against the account's key, not just docs):** GA shape —
  `wss://api.openai.com/v1/realtime?intent=transcription`, `Authorization` header ONLY (the
  `OpenAI-Beta: realtime=v1` header is rejected as `beta_api_shape_disabled`); configure with
  `session.update` type `transcription`, audio `{type:"audio/pcm",rate:24000}` + transcription
  model. Model **`gpt-live-transcribe`** streams word-by-word *during* speech (~1.4s first word);
  `gpt-4o-transcribe`/`-mini` only emit after the turn ends (~7s). The live model emits ONLY
  `conversation.item.input_audio_transcription.delta` under one constant `item_id` — no completion
  or VAD events — so **turn finalization is ours**: finalize on a ~1.5s gap in the delta stream.
- **Files (backend):** new `services/realtime_transcribe.py` (async `websockets` client; yields
  typed `(delta|final, text)` events; no new deps — `websockets` ships with `uvicorn[standard]`);
  new `api/v1/live_transcribe.py` (WS relay: uplink audio→OpenAI, downlink→interviewer, silence
  finalizer, candidate-turn signal, fallback on flag-off/connect-fail/upstream-drop; reuses
  `interviews._append_live_transcript_item` / `_live_timeline_offset_ms` and
  `transcription._looks_hallucinated`); registered in `api/v1/__init__.py`; two config fields in
  `core/config.py` (`openai_realtime_model="gpt-live-transcribe"`,
  `live_realtime_transcription_enabled=True`).
- **Files (frontend):** new `public/worklets/pcm-downsampler.js` (AudioWorklet: Float32→PCM16,
  downsample to 24kHz, 40ms frames); new `lib/useRealtimeTranscribe.ts` (mic→worklet→WS, renders
  streaming deltas/finals, `onCandidateTurn` trigger, `fellBack` to revert to chunk path);
  `components/LiveTranscriptFeed.tsx` gained an `interims` prop (live "typing" bubble, keeps the
  TYH-017 panel-only scroll); interviewer page uses the realtime hook as the display source + fires
  `runAnswerEvaluation` instantly on `candidate_turn` (poll + chunk `useLiveSpeech` + 3.5s debounce
  now run only when `fellBack`); candidate page streams via the realtime hook, `useLiveSpeech` only
  when `fellBack`.
- **Cost note:** realtime is billed per minute of audio for BOTH sides for the whole call
  (materially more than the chunk path). Flag off → everything falls back to the chunk pipeline.
- **Verification:** backend `py_compile` OK + import check (route registered, 80 api routes); live
  probes confirmed GA shape/model/events; **full backend WS relay integration test** against an
  existing session streamed TTS speech on a candidate socket and the interviewer socket received 18
  streaming deltas → accurate `final` → `candidate_turn` (no DB writes). Frontend `tsc` 0; `eslint`
  clean on both new files (pre-existing page errors unchanged); worklet served 200
  `application/javascript`; both services healthy after restart. **Live 2-browser call test pending
  (manual).**

### 2026-11-18 — TYH-017: Live Transcript scrolled the whole page instead of just the panel
- **What:** In the interviewer Command Center, each new live-transcript line now auto-scrolls
  **only inside the transcript panel**; the rest of the page stays put.
- **Why (root cause):** `LiveTranscriptFeed` auto-scrolled with
  `bottomRef.scrollIntoView({ behavior: "smooth" })`. `scrollIntoView` brings the target into
  view by scrolling *every* scrollable ancestor — including the page/window — so on each
  incoming chunk the whole Command Center jumped upward.
- **How:** Put a ref on the panel's own scroll container (the `overflow-y-auto max-h-[360px]`
  div) and scroll it with `el.scrollTo({ top: el.scrollHeight })` instead of `scrollIntoView`,
  which can only move that one element. Added a "near bottom" guard (within 80px) so scrolling
  up to re-read earlier dialogue isn't yanked back down by the next line. Removed the now-unused
  `bottomRef` sentinel div.
- **Files:** `frontend/src/components/LiveTranscriptFeed.tsx`.
- **Verification:** `tsc --noEmit` exit 0; `eslint` on the file exit 0. Only usage is the
  interviewer page; it was the only `scrollIntoView` in the frontend. Live scroll behavior to be
  confirmed in manual test.

### 2026-11-18 — TYH-018: validate the Identity check (no more false "recorded successfully")
- **What:** The candidate Identity check now validates its fields. The voice recorder only
  reports success when real audio was captured; submission requires a non-empty ID, a liveness
  capture that actually detected motion, and an audible voice sample. Added a non-blocking
  "sounds faint" hint, and a backend guard against empty uploads.
- **Why (root cause):** `recordVoiceSnippet`'s `onstop` unconditionally set the blob and showed
  "Voice sample recorded successfully!" with no check that anything was recorded — a silent/empty
  capture (muted mic, no audio) still passed. The Continue button only checked each field
  *existed*, not that it had content, and never required liveness to pass.
- **How:**
  - New `audioLoudnessRms()` decodes the sample and computes RMS. Below `VOICE_SILENCE_FLOOR`
    (0.005) → rejected as silent ("we couldn't hear anything"); below `VOICE_QUIET_HINT` (0.02)
    → accepted with a faint hint; otherwise success. Floor is deliberately low so a **noisy room
    still passes** — we don't false-reject on ambient noise (voice-match quality stays a
    human-review signal downstream, never an auto-reject). If decode fails, falls back to a size
    check. `voiceBlob` is only set once the sample clears the silence check.
  - `submit()` now validates ID + liveness-passed + audible voice with a clear message; the
    Continue button is gated on all of them (including `livenessPassed`).
  - Backend `/identity-check` rejects empty `id_document` / `selfie` / `voice_enrollment` (422)
    so a direct API call can't store empty files as "verified".
- **Files:** `frontend/src/app/interview/[token]/page.tsx`, `backend/app/api/v1/interviews.py`.
- **Verification:** backend `py_compile` clean; frontend `tsc --noEmit` 0; no new eslint
  (pre-existing impure-render/ref lint untouched). Pending HR manual test.

### 2026-11-18 — TYH-019: remove the misleading "close tab" buttons on interview finish
- **What:** Removed the tab-closing buttons from both interview finish screens — the candidate
  "Close" button, the interviewer in-call "Close this tab" button, and the scorecard
  "Finish & Close Tab" button — replacing each with a static, honest line ("You can close this
  tab when you're done…"). The scorecard's "Close" (dismisses the overlay) and "Download PDF"
  stay. Removed the now-dead `handleClose`/`handleCloseTab`/`closeFailed` code.
- **Why (not fixable):** TYH-019 asked for the tab to close automatically, but a tab opened from
  a pasted interview link is **not script-closable** — Chrome (by security design) refuses
  `window.close()` for any tab a script didn't open via `window.open()`. No code can force it.
  The old buttons therefore promised something the browser forbids and just surfaced a "close it
  yourself" message, which read as broken. Honest static text resolves the confusion.
- **Files:** `frontend/src/app/interview/[token]/page.tsx`,
  `frontend/src/app/interview/interviewer/[token]/page.tsx`.
- **Verification:** `tsc --noEmit` 0; no new eslint (pre-existing call-timer/ref lint untouched).
  Pending HR manual test.

### 2026-11-17 — TYH-020: Job Title on Schedule Interview → AI-suggested Q&A + Refresh
- **What:** The "Schedule an interview" form now captures a **Job Title** (required text field).
  It's stored on the interview session and used to tailor the interviewer panel's AI-suggested
  questions. Added a **Refresh** button in the panel's question bank that re-rolls a fresh set.
- **Why:** TYH-020 — scheduling only captured a candidate name, so with no linked Job the AI
  fell back to a generic "Technical Specialist" and produced generic questions.
- **How:**
  - Backend: new nullable `job_title` column on `interview_sessions` (model + idempotent
    `ADD COLUMN IF NOT EXISTS` in both the Postgres and SQLite startup migrations). `SessionCreate`
    /`SessionOut` carry `job_title`; `create_session` persists it. The suggested-questions route
    now prefers a linked Job's title, else the typed `job_title`, else the fallback, and takes a
    `refresh` query param that bypasses the in-memory cache. `generate_suggested_questions` gained
    a `vary` flag that raises temperature + drops the fixed seed so Refresh returns a genuinely
    different set.
  - Frontend: required "Job title" field on `interviews/new` (sent as `job_title`); interviewer
    panel's question fetch extracted into `loadSuggestedQuestions(refresh)` with a Refresh button
    and a refreshing state.
  - **Report:** the consolidated evaluation report/PDF showed "Role / Job: N/A" because it only
    read a linked Job's title. It now falls back to the typed `session.job_title`, and the
    on-screen scorecard modal header shows "· Role: <title>" too.
- **Files:** `backend/app/models/interview.py`, `backend/app/schemas/interview.py`,
  `backend/app/api/v1/interviews.py`, `backend/app/services/question_generator.py`,
  `backend/app/services/consolidated_report.py`, `backend/app/main.py`;
  `frontend/src/lib/types.ts`, `frontend/src/app/interviews/new/page.tsx`,
  `frontend/src/app/interview/interviewer/[token]/page.tsx`.
- **Verification:** backend `py_compile` clean; `job_title` column confirmed in DB; frontend
  `tsc --noEmit` 0, no new eslint issues; app restarted healthy. Pending HR manual test.

### 2026-11-16 — Ad-hoc: "Finish & Close Tab" showed a failure message on the scorecard
- **What:** On the interviewer Consolidated Evaluation Scorecard, clicking **Finish & Close
  Tab** left a greyed "Can't close this automatically — go ahead and close the tab yourself"
  message that read like an error. Replaced it with a clean success confirmation:
  "✓ All done — this evaluation is saved. You can safely close this tab now."
- **Why (not a code bug):** `window.close()` is only permitted on a *script-opened* tab
  (opened via `window.open()`). The interviewer reaches this page from a **copied link** — a
  directly-navigated tab — which browsers (Chrome especially) refuse to let any site close, by
  security design. So auto-close cannot be forced; the old message framed that normal, expected
  manual step as a failure. The button still attempts the close (works when the tab *was*
  script-opened) and only falls back to the confirmation when it can't.
- **Files:** `frontend/src/app/interview/interviewer/[token]/page.tsx` (`handleCloseTab`
  comment, footer success state). The candidate end screen (`interview/[token]/page.tsx`) has
  the same browser limitation but a non-alarming message; left as-is.
- **Verification:** `tsc --noEmit` 0; no new eslint issues (pre-existing call-timer lint on this
  file untouched); frontend restarted. Pending manual test.

### 2026-11-16 — TYH-007: Drag-and-drop for the resume upload section (enhancement)
- **What:** The resume upload box on the Job-details page (`jobs/[jobId]`) is now a drag-and-drop
  zone. HR can drop PDF/DOCX files onto it or click it to browse; chosen files show as removable
  chips with a "Clear all", and the Upload button shows the count ("Upload 3 resumes").
- **Why:** TYH-007 suggestion — the old bare `<input type="file">` had no drop target.
- **How:** Selected files are held in `selectedFiles` state (fed by both the picker and drop),
  filtered to `.pdf`/`.docx`, de-duped by name+size; a drag-depth ref keeps the highlight stable
  across child elements. `handleUpload` now reads from state and gained proper error handling —
  success/error **toasts** (previously it had none), consistent with the project-wide error
  standard. The hidden file input + backend `/jobs/{id}/resumes` contract are unchanged.
- **Files:** `frontend/src/app/jobs/[jobId]/page.tsx` (DnD state/handlers, drop-zone UI, toasts;
  `ApiError` + `toast` imports).
- **Verification:** `tsc --noEmit` 0, eslint clean on the file; frontend restarted. Pending HR
  manual test: drag resumes onto the box + click-to-browse both populate and upload.

### 2026-11-16 — TYH-004: Score not shown after overriding a rejected candidate to approved
- **What:** When HR overrides a candidate to **approved/review**, the backend now computes the
  AI fit score on the spot if the candidate was never scored.
- **Why (root cause):** Knockout-failed candidates are declined **at upload without ever being
  AI-scored** (`fit_score` stays NULL — `upload_resumes`: `if failed: bucket="declined"`, no
  scoring). The `/override` endpoint only flipped `override_bucket`, so a force-approved
  knockout candidate had no number and the Job-details card showed "—". (Normally-scored
  declined candidates already have a `fit_score`, so they were never affected.)
- **How:** New `_ensure_scored(candidate, db)` helper in `candidates.py` — if `fit_score is
  None` and a `parsed_profile` exists, it runs `scoring.score_candidate` once and stores
  fit/technical/communication/reasons/breakdown/skills/profession_fit. `override_candidate`
  calls it when the target bucket isn't `declined`. The underlying AI `bucket` is left as-is
  (the knockout genuinely failed; HR's decision rides on `override_bucket`); this only fills in
  the missing score. A scoring/AI failure is logged and swallowed so the override itself never
  fails — the score simply stays "—" as before. Audit log records `scored_on_override`.
- **Files:** `backend/app/api/v1/candidates.py` (logger, `_ensure_scored`, override wiring).
  Frontend needs no change — the Job-details card already renders `fit_score`/Tech/Comm once
  non-null, and the override handler `refresh()`es the candidate.
- **Verification:** `py_compile` clean. Backend auto-reloads via WatchFiles. Pending HR manual
  test: override a knockout-declined candidate to approved → score + Tech/Comm now appear.

### 2026-11-16 — TYH-003: Email Dispatched without an address + configurable SMTP/email sending
- **What:** Closed the bug *and* built the real email-sending backend it exposed.
  1. **Validation (the bug).** "Email Dispatched" could fire with no recipient. The interviewer
     report page now blocks Send until the address is a valid email (`isValidEmail` guard +
     disabled button + inline hint), and the backend `POST /interviews/.../send-report`
     rejects a blank/invalid recipient with 422 and no longer falls back to a hardcoded
     `interviewer@company.com`.
  2. **Configurable email sender.** New **Email settings** window (header nav → `/settings/email`,
     HR-auth only) where HR/admin configure **two** sender accounts at once — a **Gmail / SMTP**
     slot (STARTTLS app password) and a **Microsoft 365 / Outlook** slot (Graph API app-only
     client-credentials: tenant id / client id / client secret, Mail.Send app permission) — with
     an **active-sender** toggle picking which one sends.
  3. **Test connection** per account: sends a short "This is a test. Connection successful."
     mail to a prompted recipient (defaults to the sender), with success/error toasters.
  4. **Error handling**: provider failures surface as typed errors → toasts (SMTP auth 401/
     config 409 / send 502), never a crash overlay.
- **Why:** Reports had no working delivery path and could be "dispatched" to nothing. HR needed
  to supply real credentials for their own Gmail + Outlook tenants from inside the app.
- **Storage/security:** Config is a JSON file at `/storage/smtp_config.json` (not `.env` —
  Docker never mounts `.env` writable; the storage volume is bind-mounted and read at send
  time, so changes apply with no restart). Secrets (SMTP password, Graph client secret) are
  **Fernet-encrypted at rest** with `STORAGE_ENCRYPTION_KEY` when set. `get_status` never
  returns secrets (only `has_password` / `has_client_secret` flags). A `_migrate()` upgrades
  the earlier single-slot config to the two-slot shape so saved accounts aren't lost.
- **Files:**
  - Backend (new): `app/services/smtp_settings.py` (two-slot config, Fernet, SMTP + Graph send),
    `app/schemas/settings.py`, `app/api/v1/settings.py` (`GET/PUT /settings/smtp`,
    `POST /settings/smtp/test`); wired in `app/api/v1/__init__.py`.
  - Backend (mod): `app/api/v1/interviews.py` (recipient validation, typed errors, no fallback),
    `app/services/consolidated_report.py` (send PDF via `smtp_settings.send_email`).
  - Frontend (new): `src/app/settings/email/page.tsx`. (mod) `src/lib/types.ts` (SMTP types),
    `src/lib/api.ts` (`ApiError`, `putJson`), `src/components/SiteHeader.tsx` (nav link),
    `src/app/interview/interviewer/[token]/page.tsx` (email validation),
    `next.config.ts` (`allowedDevOrigins` for localhost/127.0.0.1 dev resources).
- **Verification:** backend `py_compile` clean; frontend `tsc --noEmit` 0 errors; eslint clean
  on all changed files (pre-existing call-timer lint on the interviewer page untouched). User
  manually confirmed **both Gmail and Outlook test mails deliver** to a real inbox.

### 2026-11-16 — TYH-002: HR score adjustment not reflected + no error handling
- **What:** Two fixes on the candidate ATS profile (`candidates/[candidateId]`):
  1. **Score now reflects the adjustment.** "Overall Fit" showed the raw AI `fit_score`, so
     applying an HR adjustment left the headline number unchanged (read as "not working"). It
     now shows the **effective score** = `fit_score + manual_score_adjustment` (clamped 0–100,
     the same number the buckets already use), with an `AI 55 · HR +10` sub-line. `fit_score`
     itself is **not** mutated (kept pure for audit + the comparison feature).
  2. **Proper error handling.** An out-of-range adjustment (±20) 400'd and surfaced as a
     Next.js runtime crash overlay (the mutation handlers had no `try/catch`). Added a reusable
     **toast** (`useDialog().toast`), a **client-side range guard** (friendly red toast, no
     round-trip), success feedback, and `try/catch` → error toast on **every** mutation on the
     page (adjustment, override, archive/unarchive, screening details, delete, fit-report,
     schedule interview).
- **Why:** Reported by QA (Subash & Sriram), High/High. Root cause was display-only + missing
  error handling; the backend `set_manual_adjustment` was already correct.
- **Scope note:** Frontend-only. No backend/schema change. The API client now throws a typed
  **`ApiError`** (parses the backend `{"detail": …}` into a clean `message`, keeps `status`), so
  error displays app-wide get the readable reason; updated the one format-dependent consumer
  (interview signals 409 handling) to use `err.status`. Toast renders **top-center**.
- **Files:** `frontend/src/app/candidates/[candidateId]/page.tsx`,
  `frontend/src/components/Dialog.tsx` (toast), `frontend/src/lib/api.ts` (`ApiError`),
  `frontend/src/app/interview/[token]/page.tsx` (409 → `err.status`).
- **Verification:** `tsc --noEmit` clean; `eslint` clean on all 4 changed files (the interview
  page's 8 lint errors are **pre-existing**, on untouched lines). Manually retested & approved
  by the user after `docker compose restart frontend`: out-of-range → red toast (no overlay);
  valid → green toast + headline moves; `0` → reverts to pure AI score.

### 2026-10-30 — Comparison: surface candidate scores prominently
- **What:** In the candidate comparison, the résumé scores are now a **bold headline per
  candidate** instead of mid-table rows. Each candidate column header shows the effective **Fit
  score** large (color-coded by effective stage — approved=green / review=amber / declined=red,
  with a score-band fallback), a thin **progress bar**, and **Tech / Comm / manual-adjustment**
  chips. The same Fit score is echoed on each AI analysis card header. The now-redundant
  Fit/Technical/Communication rows were removed from the table body (data unchanged — just
  relocated to the header).
- **Why:** Requested — the scores existed but read as ordinary rows; recruiters want them at a
  glance when scanning candidates side by side.
- **Scope note:** Frontend-only, display-only. No new scores, no backend/schema change; it uses
  the same persisted `fit_score`/`technical_score`/`communication_score`/`manual_score_adjustment`
  already returned by the compare endpoint.
- **Files:** `frontend/src/app/jobs/[jobId]/compare/page.tsx` (new `ScoreBlock` + `scoreTone`
  helpers; header + analysis-card headline score; removed 3 score rows).
- **Verification:** `eslint` clean; `tsc` clean for app source (the only `tsc` errors were in the
  Next-generated `.next/dev/types/validator.ts`, a transient dev-typegen artifact). Live: compare
  route compiles and renders (guard state verified) after `docker compose restart frontend`. The
  score block itself isn't visually confirmed yet — needs ≥2 **scored** candidates (a real
  comparison = one paid AI call), which is pending candidates existing on a job.

### 2026-10-29 — Fix: resume upload crashed for phone-less resumes ('NoneType' object is not iterable)
- **What:** `dedupe._normalize_phone` iterated over its argument, which is `None` whenever a
  resume has no phone (the parser returns `None`). It's called in `find_duplicate` for both the
  new candidate and every existing one **before** the `if phone and candidate.phone` guard, so
  any upload of a phone-less resume to a job that already had candidates raised
  `TypeError: 'NoneType' object is not iterable`, which `upload_resumes` caught and recorded as a
  per-candidate **processing failure** (resume never scored; shown in "Needs attention").
- **Why it surfaced:** two sample AI resumes with no phone number were uploaded; on re-upload
  (existing rows present) dedupe hit the None and both failed.
- **Fix:** `_normalize_phone` now returns `""` for a falsy/`None` phone (and its type is
  `str | None`). Real phones still normalize to their last 10 digits; the existing
  `phone and candidate.phone` guard then correctly skips phone matching when either side is
  absent. One-function change.
- **Files:** `backend/app/services/dedupe.py`.
- **Verification (actually run):** reproduced the crash against the stored failed candidates
  (`_normalize_phone(None)` → TypeError), applied the fix, re-ran: phone-less `find_duplicate`
  now returns normally, `_normalize_phone('+1 (555) 123-4567') == '5551234567'`,
  `_normalize_phone(None) == ''`. Full backend suite still **15 passed**. Pre-existing bug,
  unrelated to the comparison feature.
- **Note:** the two already-failed rows weren't scored, so they must be **deleted and
  re-uploaded** to get scores. Both sample resumes share the placeholder email `name@gmail.com`,
  so on re-upload one will be flagged a duplicate of the other (correct dedupe behavior for
  identical emails) — a quirk of those test files, not a bug.

### 2026-10-29 — Added AI Candidate Comparison
- **What:** Recruiters can select ≥2 candidates in a job pipeline and compare them side by side,
  with a factual table of their existing (persisted) scores/decisions **plus** an advisory,
  evidence-based AI analysis (per-candidate strengths/gaps/evidence, differentiators, follow-up
  questions, conclusion). Analysis-only: it never approves/rejects/hires, re-scores, or writes
  anything — the endpoint is strictly read-only.
- **Why:** Side-by-side comparison for the same role was a manual, click-through-each-candidate
  task; this surfaces differences and supporting evidence in one view to support (not make) the
  recruiter's decision.
- **API:** `POST /api/v1/jobs/{job_id}/candidates/compare` (HR-auth; new router
  `backend/app/api/v1/comparison.py`). Body `{ "candidate_ids": [uuid, …] }`. Validates job,
  requires ≥2 **distinct** IDs (422 if <2 by schema; 400 on duplicates collapsing to <2),
  enforces a configurable max (**default 10**, `COMPARISON_MAX_CANDIDATES`; 400 above it with a
  "deselect some" message — never silently truncated), and verifies **every candidate belongs to
  the path job** (400 otherwise; the real authz boundary — see security note). One bounded `IN`
  query for candidates + one each for L1/interviews (no N+1).
- **AI design:** single forced tool call via the existing `call_tool` (now with an explicit
  `timeout`, default 60s, **no auto-retry**). Model sees only opaque `c1..cN` ref labels — never
  names/emails/UUIDs (matches `scoring._redact_for_scoring` bias mitigation) — plus bounded,
  truncated evidence; resume data is delimited and marked untrusted (prompt-injection defense).
  Scores are **passed from the DB, never recomputed**. Output is Pydantic-validated; refs are
  re-mapped to real IDs with **model-invented refs dropped and omitted ones backfilled** as
  "insufficient data". On any AI failure/timeout/malformed output it **degrades gracefully** to
  the factual table (`ai_available:false` + safe message), so the comparison is still useful.
  Fairness: affect/voice/sentiment/integrity are **excluded** from competence inputs; integrity
  shows in the table as review-context only.
- **Files (new):** `backend/app/api/v1/comparison.py`, `backend/app/services/candidate_comparison.py`,
  `backend/app/schemas/comparison.py`, `frontend/src/app/jobs/[jobId]/compare/page.tsx`,
  `backend/tests/` (`conftest.py`, `test_candidate_comparison.py`, `__init__.py`),
  `backend/requirements-dev.txt`. **Modified:** `backend/app/core/config.py` (two settings),
  `backend/app/services/openai_client.py` (`call_tool` optional `timeout`),
  `backend/app/api/v1/__init__.py` (register router), `frontend/src/lib/types.ts` (typed
  request/response, no `any`), `frontend/src/app/jobs/[jobId]/page.tsx` (checkbox select mode,
  counter, limit feedback, Compare action; removed a pre-existing dead `getScoreLabel` import).
- **Candidate limit:** default **10** (configurable via `COMPARISON_MAX_CANDIDATES`). Single
  bounded request is the chosen design at this scale; a two-stage/grouped approach is the
  documented path if the limit is raised later. **Not** tested at 20+ — do not claim that scale
  without re-testing.
- **Verification (actually run):** backend suite **15 passed** (`python -m pytest tests -q` in the
  backend container, against a dedicated `tyhire_test` DB — never the live DB — with OpenAI
  mocked): 2-candidate, multi-candidate, at-max, with/without L1+interview, <2 (422), duplicates
  (400), above-max (400), cross-job (400), unknown candidate (400), unknown job (404), unauth
  (401), AI timeout → graceful degrade, malformed AI → degrade, model-invented ref dropped +
  omitted backfilled, and **scores/buckets unchanged after compare**. Frontend: `eslint` clean +
  `tsc --noEmit` clean. Live browser: "⚖️ Compare candidates" button + select-mode bar render and
  behave (counter, "pick at least 2", disabled Compare) after a `docker compose restart frontend`.
- **Not verified:** no live end-to-end comparison was run (both existing jobs have **0 candidates**;
  a real run needs uploaded candidates + one real paid AI call on live data — left for the user to
  trigger). No **frontend unit tests** — the repo has no JS test runner (only eslint + `next build`);
  adding vitest/RTL was out of scope for a minimal change. Follow-up candidates below.
- **Security note (pre-existing, flagged not invented):** TyHire has **no org/owner access-control
  boundary** — every HR user sees every job/candidate (jobs have no owner column). This feature
  enforces the boundary that *is* real (candidate↔job membership) and does **not** invent one; the
  broader gap is a separate security item.
- **Follow-ups:** live end-to-end run once candidates exist; optional frontend test harness;
  optional read-only audit-log entry for "who compared whom" (deliberately omitted to keep the
  endpoint a pure read).

### 2026-10-29 — Added app-wide light/dark theme
- **What:** Full light/dark theme across the app with a header toggle (and one on `/login`),
  system-preference default, and `localStorage` persistence. No flash on load (inline script in
  layout sets `<html data-theme>` before paint).
- **How (low-churn approach):** Tailwind v4 compiles color utilities to `var(--color-<name>-<shade>)`,
  so dark mode is done by **overriding those variables in a `:root[data-theme="dark"]` scope** in
  `globals.css` — reskins ~500 neutral (zinc) usages + every blue/purple/emerald/red/amber tint
  with no per-element `dark:` churn. Shades are remapped by **actual usage** (audited), not blind
  inversion: e.g. `zinc-900` is text-only → goes light, `zinc-950` is bg-only → stays dark.
  `color-scheme` is now per-theme so native controls render correct chrome in each mode (this is
  why the old "forced light" could be dropped). `color-scheme` + tokenized `input/select/textarea`
  styles fix the original dark-controls-unreadable problem rather than avoiding it.
- **The one split:** `bg-white` and `text-white` both compile to `var(--color-white)`, but
  surfaces must darken while white button text must stay light. So all surface `bg-white` → new
  **`bg-surface`** token (via `@theme inline --color-surface: var(--surface)`), and `--color-white`
  is left true white. Video-overlay `bg-white/95` (interview room, over dark video) left as-is.
- **Files:** `frontend/src/app/globals.css` (theme vars, dark scope, `@custom-variant dark`,
  `bg-surface` token, tokenized controls/badges); `frontend/src/components/ThemeToggle.tsx` (new);
  `frontend/src/app/layout.tsx` (no-flash script **inside `<head>`**, `body` → `bg-background`);
  `frontend/src/components/SiteHeader.tsx` + `frontend/src/app/login/page.tsx` (toggle);
  `bg-white` → `bg-surface` across ~13 files (40 usages).
- **Verification:** verified in-browser — login, dashboard, jobs board, empty states all render
  correctly in both themes; computed tokens flip (`--background` `#fff`↔`#0d1117`, native input bg
  `#fff`↔`#161b22` with light text); toggle persists + no-flash script applies saved/system theme.
  (Emerald/purple/red scorecard tints not visually spot-checked — DB had no candidates at the time
  — but their dark vars are defined via the same mechanism.)
- **⚠️ Local-dev gotcha found:** on this Windows host, the frontend container's Turbopack file
  watcher does **not** reliably get change events for `globals.css` over the Windows bind mount
  (`.tsx` still reflect on each request since server components re-read from disk). A CSS edit may
  serve a **stale CSS chunk** with no error. Fix: `docker compose restart frontend`, then hit a
  page to retrigger compile.

### 2026-10-29 — Added recruiter Dashboard (P1 MVP)
- **What:** New recruiter home dashboard. **Backend:** single org-wide aggregation endpoint
  `GET /api/v1/dashboard/summary` (`require_hr_auth`) returning job counts (active/archived),
  candidate counts by effective bucket (`COALESCE(override_bucket, bucket)`) + needs-review /
  processing-failed / duplicates, interview counts (pending / completed / awaiting-review), and
  recent candidates + recent activity. **Frontend:** new `/dashboard` page (KPI cards, "Needs
  your attention" list, pipeline bars, interviews, recent activity + candidates), a `Dashboard`
  nav link, and login now redirects to `/dashboard` (was `/jobs`).
- **Why:** Login previously dumped HR on a flat jobs list with no triage. This surfaces "what
  needs me now" across all jobs in one view. Scoped to **reliably computable data only** — no
  hires/time-to-hire/offer metrics, since the schema has no hire/offer lifecycle (see §10 / the
  dashboard proposal). `awaiting_review` reuses the exact `GET /interviews/review/queue`
  predicate so the count can never disagree with the list it links to.
- **Files:** `backend/app/api/v1/dashboard.py` (new), `backend/app/schemas/dashboard.py` (new),
  `backend/app/api/v1/__init__.py` (register router); `frontend/src/app/dashboard/page.tsx`
  (new), `frontend/src/lib/types.ts` (`DashboardSummary` type), `frontend/src/components/
  SiteHeader.tsx` (nav link), `frontend/src/app/login/page.tsx` (redirect).
- **No schema change** — aggregation only; no DB reset needed.
- **Verification:** backend reloaded clean (no import errors); `POST /auth/login` → 200;
  `GET /dashboard/summary` authed → 200 with correct live data (1 active job, 1 completed
  interview flagged for review, real audit activity); unauthenticated → **401**. UI verified in
  the browser: login redirects to `/dashboard`, all sections render, empty states correct.
- **Infra note:** Docker Desktop had to be relaunched **elevated** (`Start-Process -Verb RunAs`)
  this session — the privileged `com.docker.service` was stopped and a non-elevated launch
  couldn't start it, so the engine never came up until the UAC prompt was approved.

### 2026-10-21 — Created this document
- **What:** Added `PROJECT_NOTES.md` — full codebase understanding (overview, architecture,
  data model, services, config, frontend, workflows, local-dev notes) + this change log.
- **Why:** Maintain a clear, shared record of the project and of every change going forward.
- **How:** Synthesized from a full read of `backend/` and `frontend/` on branch `beta` (tip
  `a12a54a`). Untracked file at the repo root.

### 2026-10-21 — Pulled latest `beta` (no-op) & verified local stack
- **What:** `git fetch` + confirmed local `beta` already at `origin/beta` (`a12a54a`); nothing
  to pull. Brought the full Docker stack up for manual testing.
- **Verification:** backend `/health` ok, frontend HTTP 200, all 4 containers healthy, valid
  OpenAI key present in the backend container.
- **Local uncommitted changes present:** `docker-compose.yml` (Windows coturn port fix),
  `frontend/package-lock.json` (npm install churn).

### (prior sessions) — Environment bring-up, Docker migration, and fixes
- **Recreated the DB** (`down -v` + `up -d`) to fix a schema mismatch after pulling `beta`:
  the reused volume was missing new columns (`recording_segment_paths`,
  `interviewer_recording_segment_paths`), causing a 500 (`UndefinedColumn`) when scheduling an
  interview. Verified create-session returns 200 afterward.
- **Fixed OpenAI 401s:** a stale User-level `OPENAI_API_KEY` env var was overriding `.env`
  (compose precedence). Removed it; standardized on the root `.env`; recreated the backend.
  Validated the key against OpenAI (`models.list`).
- **Migrated to the full Docker stack** (postgres + coturn + backend + frontend). Added the
  **Windows coturn relay-port fix** (`49160-49200 → 40000-40040`) because Windows reserves
  `49152-49251`. Postgres host port set to **5442** to avoid clashing with a native Postgres 18.
- **Build fix:** bumped `psycopg2-binary` (2.9.9→2.9.10) and `pymupdf` (1.24.10→1.24.14) for
  Python 3.13 wheels (committed in PR #1).
- **11 beta-hardening bug fixes (#13–#23)** — merged upstream via **PR #1** into `beta`.
  Highlights: interview Close-button fallback; voice-tone/facial-affect run independently of
  transcription; session advances out of `identity_pending` on start; identity-match failure
  degrades to "uncertain" instead of 500; retry affordance after a hard identity block; review
  pages distinguish loading/empty/error; recording playback states + interviewer-recording
  playback (shared `useAuthedRecording` hook); scheduled retention enforcement (+ cron job
  runner); storage-encryption backfill.
- **Lessons learned / guardrail:** never run mutating tests against the live DB — a backfill
  test once encrypted a real resume with a throwaway key (data lost). Use isolated fixtures.
