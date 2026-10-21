# Running an interview

Two people join from two different links: the candidate and the interviewer. Neither needs
an account.

Both should use **Chrome or Edge on a laptop or desktop**, and the interviewer should wear
**headphones** — without them the candidate's voice comes out of the speakers, back into the
microphone, and ends up attributed to the wrong person in the live transcript.

---

## What the candidate goes through

Useful to know even if you never see it, because you'll be the one they call when something
sticks. They work through these stages in order.

### 1. Consent

A plain-language screen explaining that the interview is recorded and monitored: identity
check, screen sharing, monitoring for tab switching, copy/paste and fullscreen exits, and
face/gaze tracking that runs **locally in their browser**. It states explicitly that nothing
auto-rejects them and that a person reviews every flag. They can withdraw by closing the
window.

### 2. Identity check

Three things, all required:

- **A photo of their government ID**, uploaded.
- **A selfie with a liveness check** — they press a button and turn their head; TyHire
  compares two frames a second and a half apart to confirm there's a live person there
  rather than a held-up photo.
- **A 5-second voice sample**, reading a sentence shown on screen. This is later compared
  against the voice in the interview itself.

The ID and selfie are compared by AI. The result is **match**, **no match**, or
**uncertain** — and the interview is *not* blocked on it. A questionable result sends the
session to your review queue instead of stranding the candidate.

### 3. Screen share

They're asked to share their screen. Sharing the **entire screen** is preferred; sharing a
single tab or window is allowed but noted for you. Stopping the share mid-interview is also
recorded.

### 4. Starting

A check runs before they can begin. Normally it passes straight through. It can hold them if
the desktop monitor is required (below) or if the identity step wasn't completed.

### 5. Join Meet

Nothing is live until they press this. It turns on their camera and microphone and connects
them to the interviewer — the interview clock starts here.

### 6. The call

They see the interviewer, with their own camera in the corner, and four controls: mute,
camera off, share screen, and fullscreen. When they're done they press **Finish interview**,
which stops everything and uploads the recording.

### If the desktop monitor is required

Only when you ticked that box on the job. The candidate sees a waiting screen with a
download link and a command to run. Once it connects, the page continues on its own. It
reports whether blocked applications are running and whether more than one display is
connected.

This needs **Node.js installed on the candidate's machine**, which most candidates won't
have. Use it only where that's reasonable to ask.

---

## The Interviewer Command Center

Open the interviewer link and press **Join Meet & Start AI Telemetry**. That connects you
and starts recording your side of the conversation.

### The layout

The left side is the call. The **candidate's shared screen** gets the large panel; their
**camera** sits in a narrower panel beside it, ringed in colour, with your own camera inset.

Along the top you'll see the call timer, a live gaze indicator (*Focused on camera* /
*Looking away*), a warning if teleprompter-style reading is detected, and **End Interview**.

### The toolbar

| Control | What it does |
|---|---|
| **Mute Mic** / **Turn Camera Off** | Your own microphone and camera |
| **Ask Candidate to Mute** | Sends them a polite prompt — it does not mute them for them |
| **⛶ Fullscreen** | Expands just the video and screenshare, leaving your tabs reachable on exit (press again or Esc) |
| **Start Audio Record** | Your side of the audio, if it isn't already running |
| **End Call** | Ends it for both of you |

### The five tabs

**🤖 AI Questions** — questions generated from this candidate's resume and the job
description, each with its category, difficulty, why it was suggested, and the key concepts
a good answer should cover. Press **Ask Question** to make one active.

**🎙️ Live Transcript** — both sides of the conversation as it happens, colour-coded and
timestamped. Expect a few seconds of delay: speech is transcribed in short chunks, not word
by word.

**🧠 Sentiment** — a tension meter, observable facial affect, voice tone, and gaze state.
Updates roughly once a minute. **Supplementary only — none of it is scored**, and it is easy
to misread: nerves, cultural differences, neurodivergence and simple camera-unfamiliarity
all look like "tension".

**🛡️ Signals** — proctoring events as they're detected, newest first. A clean session says
so. These are raw observations, not conclusions — they're combined into an integrity score
after the call. See [reviewing results](reviewing-results.md#what-the-signals-mean).

**📝 Notes** — your live read: **Proceed**, **Some concern** or **Reject**, plus free-text
notes. Saved as you go, so it survives the call ending.

### Rating answers as you go

With a question active, the panel under the video shows the concepts a strong answer should
hit, ticking them off as the candidate covers them, and an accuracy score. It evaluates
automatically a few seconds after they stop speaking, or press **⚡ Evaluate Answer**.

Then rate it in one click: **🟢 Strong Pass**, **🟡 Needs Follow-up**, or **🔴 Inaccurate /
Scripted**. Doing this during the call is far more accurate than reconstructing it later,
and it all lands in the final scorecard.

### Ending

**End Interview** stops recording, releases the camera and microphone, and closes the call
for the candidate too. The consolidated scorecard opens after a moment: fit score,
proctoring rating, your live decision, every question you rated, and your notes.

From there, **📄 Download PDF Evaluation Report** gives you the file.

> **Two cautions on the scorecard.**
>
> 1. **"Send Scorecard" does not currently email anything.** The button reports success and
>    the action is logged, but no email is sent — there is no mail server configured in the
>    product. Use **Download PDF** and send it yourself.
> 2. **If a value is missing, the tiles show placeholder numbers** rather than blanks — a
>    fit score of `85/100`, a proctoring rating of `Clean (100)`, a decision of `Proceed`,
>    or `85` on a question. If the interview has only just ended and processing hasn't
>    finished, check the figures against the full review page before trusting them.

## Next

- [Reviewing results](reviewing-results.md) — what to do with the session afterwards.
- [Troubleshooting](troubleshooting.md) — if something went wrong during the call.
