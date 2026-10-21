# HR guide

Everything you do day to day: create a job, screen resumes, decide on candidates, and get
an interview scheduled.

## Finding your way around

After logging in there are four items in the top bar:

| Menu item | What it's for |
|---|---|
| **Jobs** | Your roles, and the screening board for each one |
| **Schedule Interview** | Generate interview links without going through a candidate record |
| **Review Queue** | Completed interviews that need a human look |
| **HR Users** | Add or remove HR accounts (admins only) |

---

## Creating a job

**Jobs → + New job.** The job is where you define what "a good candidate" means — every
resume is scored against it, so it's worth getting right.

### Title and description

Enter the **title**, then write the **job description**. If you'd rather not start from
scratch, click **Suggest with AI** and it drafts one from the title (the button says
**Improve with AI** once there's text, and rewrites what you have). Either way it also
fills in the required skills list for you, which you can then edit.

### Skills

Four separate lists, all comma-separated:

| List | Effect |
|---|---|
| **Required Skills** | The primary skills the candidate is matched against |
| **Core / Mandatory** | Weighted most heavily in the match |
| **Secondary / Good-to-have** | Counts for less |
| **Irrelevant / Out-of-Scope** | Penalised — this is what catches resumes padded with unrelated keywords |

### Level and work mode

- **Level** — *Experienced* or *Fresher / entry-level*. Freshers are scored on education,
  projects and internships rather than work history, so an entry-level candidate isn't
  punished for having no career behind them.
- **Work mode** — *On-site*, *Hybrid* or *Remote*. Choosing **Remote skips the location
  check entirely**.

### Eligibility rules (knockouts)

These are hard rules, not AI judgement. A candidate who fails any of them is marked **not
eligible** and goes straight to Declined with the reason recorded.

- Minimum years of experience — measured from the dates on the candidate's listed roles,
  not the total they state on the resume (see [how scoring works](how-scoring-works.md#experience-is-measured-not-taken-on-trust))
- Allowed locations (e.g. `Bangalore, Chennai`)
- Maximum notice period, in days
- Salary band — anyone expecting above the maximum is knocked out

**Leave a field blank to skip that check.** Blank is not "zero" — it means "don't test this".

### Campus mode

Tick **Campus Recruitment / College Hiring Mode** for college drives. It adds four more
eligibility rules: minimum CGPA, maximum active backlogs, eligible passing batches, and
eligible degrees/branches.

### What the score should reward

**Fit-score priorities** has five checkboxes: Skills, Experience, Education, Certifications
and Communication. Ticking one **doubles its weight** relative to the others. The live
preview shows where that lands, e.g. *Skills 33% · Experience 17% · …*.

If you want finer control, **Fine-tune with custom weights** swaps the checkboxes for five
sliders.

### Screening strictness

This decides where the Approved / Review / Declined lines fall:

| Preset | Auto-approve at | Auto-decline below |
|---|---|---|
| **Strict** — only strong matches | 85 | 50 |
| **Balanced** *(recommended)* | 75 | 40 |
| **Lenient** — cast a wider net | 60 | 30 |
| **Custom** | your choice | your choice |

Anything between the two numbers lands in **Review**.

### Desktop monitor

**Require the desktop probe** means the candidate must run a small background-monitor
program before they can start their interview. It detects things the browser can't see, like
other applications running or a second monitor connected. Leave it off unless you need that
level of scrutiny — it's an extra hurdle for the candidate. See
[running an interview](running-an-interview.md#if-the-desktop-monitor-is-required).

### Editing later

You can edit a job from its own page. Note the warning shown there: **changes only apply to
future scoring.** Candidates already uploaded keep the scores they got and are not
re-evaluated.

---

## Screening resumes

Open the job and use the upload bar at the top. Select one or more **PDF or DOCX** files,
optionally tag where they came from in the **Source** box (`referral`, `LinkedIn`…), and
click **Upload resumes**.

Each resume goes through the same pipeline:

1. **Text extraction** — if the PDF has no selectable text (a scan or photo), it falls back
   to reading the image. Candidates processed this way are marked *Parsed via OCR fallback*.
2. **Parsing** — name, contact details, education, work history, projects, skills,
   certifications, total experience, location, notice period, expected salary.
3. **Duplicate check** — against other candidates on the same job, by email, phone, or a
   close name match.
4. **Eligibility rules** — your knockouts.
5. **Keyword-stuffing check** (PDFs) — looks for invisible white-on-white or microscopic
   text used to game keyword matching. Being caught here is an automatic knockout.
6. **Scoring** — see [how scoring works](how-scoring-works.md).

Larger batches take a while — roughly 10–12 seconds per resume, because each one involves
reading the document and an AI call. A batch of ten is a couple of minutes.

## Reading the board

Three columns: **Approved**, **Review**, **Declined**.

Each card shows the candidate's name, their overall score out of 100, a blue **Tech** and
purple **Comm** badge, how many required skills matched and how many are missing, and how
well their background aligns with the role.

Four things sit outside the columns:

- **Needs attention — failed to process** (amber). These resumes hit an error and were
  **never scored** — they are not "bad candidates". Fix the cause (usually a missing or
  invalid OpenAI key) and upload them again.
- **Duplicates.** Someone already in the list for this job. Not scored, not bucketed.
- **Archived.** Removed from the board with a reason, restorable.
- **🎓 Campus Bulk Drive Screening** — see below.

---

## Deciding on a candidate

Click any card to open their page.

**AI Evaluation & Fit Breakdown** gives the overall fit score with a plain-English label, a
technical score, a communication score, and then the five category sub-scores each with the
reasons behind them.

**Skill Relevancy & Match Matrix** splits their skills into matched (green), missing and
critical (amber), and irrelevant (grey).

**Profession & Career Trajectory** covers whether the role is a sensible next step for them:
seniority match, industry/domain alignment, and a verdict of aligned / partial / misaligned.

**Experience & Employment History** shows how many years their listed roles actually add up
to, alongside the figure stated on the resume. If the resume claims materially more than the
dates support, that's called out — worth confirming, since a stated total often includes
internships or study. Any gaps of three months or more between roles are listed, including
an open one if they aren't currently in a listed role. A gap is a question to ask, not a
mark against the candidate.

**Not eligible** lists which of your knockout rules they failed, if any.

### Things you can change

- **Screening details** — if you learn their notice period or expected salary during a call,
  enter it here. This re-runs the eligibility rules and can move them between buckets.
- **HR score adjustment** — nudge the score by up to ±20 (say, for a competing offer).
  **A reason is required** and is kept on the record.
- **HR decision** — move them to a different bucket outright. **A reason is required**, and
  your override always beats the AI's bucket.
- **Download fit report (PDF)** — the full assessment as a shareable file.
- **Remove candidate** archives them with a reason; **Delete permanently** removes them and
  their resume for good.

Every one of these is written to an audit trail with your name against it.

---

## Phone screening (optional)

If you do a phone screen before the formal interview, record it and upload it under **HR
Phone Screening Call** on the candidate's page (mp3, wav, m4a, webm, ogg or aac).

TyHire transcribes it and comes back with a verdict — **Recommend L1 Technical**, **On
Hold**, **Decline Candidate**, or **Needs Senior HR Review** — along with screening-fit,
technical-clarity and verbal-fluency scores, a summary, the facts it picked out of the call,
strengths, red flags, and suggested next steps for whoever runs the technical round.

The transcript is clickable: select any line to jump the audio player to that moment. Note
that who-said-what is **inferred by the AI from context**, so treat speaker labels as a
guide rather than a record.

You can upload several calls; they appear as *Call #1*, *Call #2* and so on.

---

## Campus bulk screening

For college drives, **🎓 Campus Bulk Drive Screening** on the job page handles hundreds of
resumes at once. Two options:

- **Direct Resumes ZIP** — a `.zip` of PDFs/DOCXs. Everything is unpacked, checked against
  your job and campus rules, and scored.
- **College CSV Roster + ZIP** — the placement cell's spreadsheet plus the matching resume
  ZIP. Supported columns: Roll No, Name, Email, Phone, CGPA, Branch, Batch Year, Backlogs,
  Resume Filename. Files are matched to rows by filename, roll number or name.

Either way you get a live progress bar, a count of successes and issues, and a log of any
files that failed or couldn't be matched to a student. When it finishes, **View Results on
Board** drops you back on the buckets.

---

## Scheduling an interview

Once a candidate is **Approved**, a **Schedule interview** button appears on their page.
Click it and you get two links:

| Link | Give it to |
|---|---|
| **Candidate link** | The candidate |
| **Interviewer link** | Whoever is conducting the interview |

**Treat both as secrets.** Anyone holding a link can join that interview — there's no
password on top. Send them to the right person and don't post them anywhere shared.

Neither person needs a TyHire account.

> **Schedule Interview** in the top nav does the same thing but takes just a name, for when
> you want a session that isn't tied to a candidate record.

## Next

- [Running an interview](running-an-interview.md)
- [Reviewing results](reviewing-results.md)
