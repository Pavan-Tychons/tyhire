# How scoring works

Two numbers matter in TyHire: the **fit score** on a resume, and the **integrity score** on
an interview. Both are out of 100, both are explainable, and neither one decides anything on
its own.

---

## The fit score

### 1. Eligibility rules run first

Before any AI is involved, the candidate is checked against the hard rules on the job:
minimum experience, allowed locations, maximum notice period, salary band, and the campus
rules if it's a campus drive. These are plain comparisons, not judgement calls.

Fail any of them and the candidate is marked **not eligible** with the specific reason, and
goes to Declined. A blank rule is skipped entirely, and remote roles skip the location check
by design.

PDF resumes also get a stuffing check: invisible white-on-white text and microscopic fonts
used to game keyword matching. Being caught here is an automatic knockout.

#### Experience is measured, not taken on trust

The minimum-experience rule is checked against the dates on the candidate's listed roles,
not the "X years of experience" line on the resume — that line is a claim, and it is
routinely rounded up, left stale from an older CV, or counted from the start of a degree.

Two things fall out of measuring it properly. Overlapping roles count once, so a
part-time or volunteer position running alongside a full-time job isn't double experience.
And gaps between roles become visible, which is usually something to ask about rather than
have averaged away.

If the dates can't be read — unusual formats, a role with no dates at all — it falls back to
the stated figure rather than failing the candidate. That direction is deliberate: the cost
of under-counting is rejecting someone who qualifies.

### 2. Five categories are scored

The AI scores five things separately, each with written reasons:

- **Skills** — against your required, core, secondary and irrelevant lists
- **Experience** — work history, tenure, progression
- **Education** — relevance, grades, coursework
- **Certifications**
- **Communication** — how clearly the resume itself is written

Entry-level jobs shift the emphasis onto education, projects and internships, so a fresher
isn't marked down for having no career yet.

The AI is given the candidate's profile with **name, email and phone removed**. It cannot
see who the person is while scoring them — a deliberate choice so that if a score is ever
challenged, the model structurally could not have used identity rather than merely being
told not to.

### 3. The categories are combined by your weights

This step is **arithmetic, not AI**: each category score is multiplied by the weight you set
on the job and averaged. The same inputs always give the same total.

That's what makes the number defensible. "Why is this a 72?" traces back to five visible
category scores and the weights you chose — not to a model's opinion of the overall person.

- **Technical score** is the same calculation across skills, experience and certifications.
- **Communication score** is that category on its own.

### 4. The score becomes a bucket

| Score | Label |
|---|---|
| 85–100 | Excellent fit |
| 70–84 | Strong fit |
| 55–69 | Good fit |
| 40–54 | Fair fit |
| below 40 | Weak fit |

Where the bucket lines fall is the **screening strictness** on the job — Balanced, for
example, approves at 75 and declines below 40, putting everything between into Review.

### 5. You can override it

Your **HR score adjustment** (±20) and your **bucket override** both beat the AI, and both
require a reason that stays on the record.

> Re-scoring is not automatic. Editing a job changes how *future* uploads are scored;
> candidates already uploaded keep the scores they have. Entering a notice period or
> expected salary on a candidate **does** re-run their eligibility rules and re-score them.

---

## The integrity score

Starts at 100. Things observed during the interview subtract from it.

### 1. Signals are grouped into moments

Raw signals are grouped by when they happened — anything within five seconds of the last one
joins the same cluster. This is the core idea: a single glance away is noise, but a glance
away *and* a copy/paste *and* a second face within five seconds is a moment worth watching.

### 2. Noise is removed

- **Duplicate observations of one action are collapsed.** Alt-tabbing registers both a tab
  switch and a focus loss; counting both would triple the severity of one ordinary action.
- **Lone low-signal clusters are dropped entirely.** If a cluster contains nothing but a
  glance off-screen, some movement, a focus blip, or a possible devtools reading, it
  produces no flag at all.

### 3. Each moment gets a severity

The weights of the signals in the cluster are added up, then multiplied based on how many
*different kinds* of signal appeared together — two distinct types multiply it by 1.5, three
by 2, and so on.

Clustering is the whole point: several different kinds of signal at the same instant is a
much stronger indication than the same thing happening repeatedly.

### 4. The score is what's left

All severities are added up and subtracted from 100.

A session is sent to the review queue if the score drops **below 85**, *or* if any single
moment is severe enough on its own — a serious standalone event, like screen sharing being
stopped mid-interview, gets attention even when the rest of the session was spotless.

### What it is not

The integrity score is **not a cheating score and not a probability**. It measures how much
happened that a human should look at. A low score with a good explanation is fine — people
have doorbells, flatmates, bad lighting and dual-monitor desks.

This is also why nothing is auto-rejected, and why clearing a flag is a first-class action
rather than an exception.

---

## Where AI is and isn't used

| Step | AI? |
|---|---|
| Reading the resume | Yes |
| Eligibility rules | **No** — plain comparisons |
| Duplicate detection | **No** — email, phone and name matching |
| Keyword-stuffing check | **No** — inspects the PDF itself |
| The five category scores | Yes |
| Combining them into the total | **No** — arithmetic with your weights |
| Which bucket | **No** — your thresholds |
| Identity match | Yes |
| Transcription | Yes |
| Question suggestions, answer evaluation | Yes |
| Proctoring signals | Mostly not — browser events and local face/gaze detection |
| Integrity score | **No** — the clustering rules above |

## Next

- [Reviewing results](reviewing-results.md)
- [HR guide](hr-guide.md)
