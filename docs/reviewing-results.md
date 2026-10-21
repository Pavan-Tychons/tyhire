# Reviewing results

After an interview finishes, TyHire combines what it observed into an integrity score and,
if anything stands out, puts the session in the **Review Queue**.

**Nothing has been auto-rejected.** The queue is a list of sessions a person should look at,
not a list of people who cheated.

## The review queue

Each row shows the candidate, the session status, and an integrity band:

| Band | Score | What it means |
|---|---|---|
| **No concerns** | 90–100 | Nothing worth your time |
| **Minor concerns** | 75–89 | A couple of small things, usually innocent |
| **Moderate concerns — review recommended** | 50–74 | Worth watching the flagged moments |
| **Significant concerns — review required** | below 50 | Several signals, or something serious |

A session also lands here if the identity check came back as a mismatch that nobody has
cleared yet — even when the integrity score itself is fine.

## The session page

Sections appear only when there's something to show.

### Identity check

The verdict and confidence, and the candidate's IP address. If it came back **no match**,
you get a **Clear as false positive** button that asks for a reason.

Clear it when the explanation is mundane — poor lighting, an old ID photo, a heavy beard
since the photo was taken. That's common and expected. What matters is that a person made
the call and said why.

### Interviewer's live read

Whatever the interviewer selected during the call (proceed / concern / reject) and their
notes.

### Recordings

The candidate's video, and the interviewer's audio if they recorded. If the video says it's
still finalising, give it a minute — merging and processing happen after the call.

### Transcript

Both sides merged onto one timeline and labelled. While it still says *Transcribing…* the
page refreshes itself every few seconds; you don't need to reload.

### Question / answer check

Each exchange with a verdict: **relevant** (green), **partially relevant** (amber), or
**off topic** / **evasive** (red), with an explanation. If the interviewer's microphone
wasn't recorded there may be no questions to pair answers with, and it says so.

### Voice tone and facial affect

Both are labelled **supplementary — not scored**, and the page repeats the warning for good
reason: anxiety, cultural differences in expressiveness, neurodivergence and plain
unfamiliarity with being on camera all read as "tension" to a model. Use it as context for
something you already noticed, never as evidence on its own.

### Flagged moments

The heart of the review. Each flag is a point in time where signals clustered together,
with a severity band:

| Band | Severity | Typical cause |
|---|---|---|
| **High** | 6+ | Several signals at once, or one serious one |
| **Moderate** | 3–6 | A couple of signals together |
| **Low** | under 3 | One minor thing |

Each flag tells you when it happened and what contributed. Use the timestamp to jump to that
moment in the recording and watch what actually occurred.

Then decide: **Clear** (innocent) or **Confirm issue** (genuinely a problem). Both take an
optional note, and both are recorded against your name. A clean session shows *No flagged
moments*.

---

## What the signals mean

Signals are raw observations. On their own most are meaningless — people look away, people
alt-tab out of nervous habit. They only become a flag when several cluster together.

| Signal | What was observed |
|---|---|
| Tab switch | Switched away from the interview tab |
| Window lost focus | Clicked into another window |
| Copy/paste | Copied or pasted during the interview |
| Second face detected | More than one face visible on camera |
| Second voice detected | Another voice in the room |
| Voice mismatch detected | The voice doesn't match their enrolment sample |
| Gaze off-screen | Looking away from the screen, repeatedly |
| Excessive motion | Unusual movement |
| Virtual camera signature | A virtual camera (OBS, ManyCam…) instead of a real one |
| Response timing anomaly | Answer timing patterns that look rehearsed or assisted |
| Unauthorized app running | A blocked application detected by the desktop monitor |
| External display connected | A second monitor |
| Exited fullscreen | Left fullscreen during the interview |
| Browser DevTools possibly open | Developer tools may be open — unreliable on its own |
| Shared a tab/window, not full screen | Shared something narrower than the whole screen |
| Stopped screen sharing | Ended the share mid-interview |
| IP location doesn't match stated location | Their network location differs from the location on their resume |
| AI answer-helper browser extension detected | An AI assistant extension (Monica, Sider…) present in the page |
| Teleprompter / Script-reading eye motion pattern | Eye movement consistent with reading from another screen |

Two deliberate pieces of restraint are built in: a single alt-tab is **not** counted twice
just because it triggers both a tab switch and a focus loss, and a cluster made only of
low-signal events on their own (a glance away, some movement, a focus blip) is **not**
flagged at all.

How these turn into a number is in [how scoring works](how-scoring-works.md#the-integrity-score).

## A sensible way to review

1. Read the integrity band — if it says *No concerns*, you're probably done.
2. Check the identity verdict.
3. Open each flagged moment and watch the recording around that timestamp.
4. Read the Q&A check for anything evasive or off-topic.
5. Read the interviewer's live notes — they were in the room.
6. Clear or confirm each flag with a note.

Treat the transcript and recording as the evidence, and everything else as a pointer telling
you where to look.

## Next

- [How scoring works](how-scoring-works.md)
- [Troubleshooting](troubleshooting.md)
