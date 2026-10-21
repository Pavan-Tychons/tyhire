# Troubleshooting

## Resumes

### Resumes land in "Needs attention — failed to process"

They hit an error and were **never scored** — this says nothing about the candidates. By far
the most common cause is a missing, invalid or out-of-credit `OPENAI_API_KEY`. The panel
shows the underlying error. Fix it and upload the files again.

### Uploading a large batch seems to hang

Each resume takes roughly 10–12 seconds — reading the document plus an AI call — and they
are processed one after another. Ten resumes is a couple of minutes. Leave the tab open.

### A candidate shows no score at all

Either they failed an eligibility rule (look for **Not eligible** and the reason), or they
were detected as a duplicate of someone already on this job. Duplicates are deliberately not
scored.

### Someone is in the wrong bucket

Use **HR decision** on their page to move them, with a reason. Your override always wins. If
the whole job is sorting badly, the screening strictness or the fit-score weights are
probably wrong — but remember that changing them only affects future uploads.

---

## Interviews

### The candidate can't get past "Checking…"

Two causes:

- **The desktop monitor is required** on this job and isn't running. They need to download
  and run it as shown on screen, which requires Node.js on their machine. If that's not
  realistic for them, turn the requirement off on the job.
- **The identity step wasn't completed.** They should go back and finish the ID photo,
  selfie and voice sample.

### The candidate's camera or microphone is blocked

The browser prompt is only half of it — the operating system blocks it separately. On
Windows: *Settings → Privacy & security → Camera / Microphone*. On macOS: *System Settings →
Privacy & Security*. They need to allow it there, then reload the page.

### The interviewer can't see the candidate's shared screen

Have the candidate check they actually picked a screen in the browser's share dialog
(cancelling it is easy to miss), and that the share hasn't been stopped. Sharing the entire
screen rather than a single window is both preferred and more reliable. Failing that, both
sides rejoin from their links — the call reconnects without losing the session.

### The transcript is stuck on "Transcribing…"

Processing happens after the call: recordings are stitched, repaired, transcribed, merged
and analysed. For a long interview this takes several minutes, and the page refreshes
itself. If it eventually says **failed**, the recording is still there to watch — only the
text failed.

### The live transcript mixes the two speakers up

Almost always audio bleed: the candidate's voice comes out of the interviewer's speakers and
back into their microphone. **Headphones on the interviewer's side fix this.**

### The video call won't connect at all

Most calls go directly between the two browsers. On restrictive corporate networks they fall
back to the relay, so check the `coturn` container is running (`docker compose ps`) and that
`TURN_SECRET` is identical for it and the backend — they're read from the same `.env`, so
this only breaks if it was changed for one and not the other.

### "Send Scorecard" says it sent an email but nothing arrives

It doesn't send email. The button reports success and the action is logged, but there is no
mail server configured in the product. Use **Download PDF Evaluation Report** and send it
yourself. (See [running an interview](running-an-interview.md#ending).)

### The scorecard shows 85/100 and "Clean (100)" for everyone

Those are placeholder values shown when the real figures aren't available yet — usually
because processing hasn't finished. Open the full session page under **Review Queue** for
the actual numbers.

---

## Access

### I can't log in as the admin

The first admin is only created **while the user table is empty**. Changing
`INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` afterwards does nothing — the original
account keeps its original password.

If you're locked out entirely, ask another admin to create you an account. If there are no
admins left, the account has to be reset directly in the database.

### A colleague's Google sign-in is rejected

Google and Microsoft sign-in only work for an email that **already has a TyHire account**.
They are a way to log in, never a way to sign up. Create the account under **HR Users**
first, using the same email address.

### Everyone was logged out at once

`SESSION_SECRET` changed. Logins are signed with it, so changing it invalidates every
existing session. Signing in again is all that's needed.

---

## Data retention and privacy

Worth knowing, since you'll be asked.

**What's stored**, under `storage/` on the server: resumes, ID photos, selfies, voice
samples, interview recordings and short clips used for analysis. Transcripts, scores and
flags live in the database.

**ID photos and selfies are deleted automatically** after `IDENTITY_MEDIA_RETENTION_DAYS`
(90 by default). The verdict and confidence are kept — the images are not. The clean-up runs
daily on its own; there's also a manual trigger.

**Face and gaze detection runs in the candidate's browser.** Video is not streamed out for
that analysis; only the resulting signal (e.g. "gaze off-screen") reaches the server.

**Recordings and resumes can be encrypted at rest** by setting `STORAGE_ENCRYPTION_KEY`.
It's off by default. If you turn it on, **back the key up** — losing it makes every
already-encrypted file permanently unreadable. Files written before you set it stay
unencrypted unless you run the one-off backfill.

**Everything consequential is audit-logged** — overrides, score adjustments, archiving,
deletions, flag decisions, identity clearances — with the email of whoever did it.

**The candidate is told all of this up front**, on the consent screen, before anything is
recorded.

### One thing to be careful about

Interview links are the only thing protecting a session. Anyone with the link can join the
call, and some interview data can be reached by anyone who knows the session's internal ID.
Share links with the intended person directly, and don't post them in shared channels or
ticket systems.

---

## Checking the system

```bash
docker compose ps        # are all four containers up?
docker compose logs -f backend
docker compose logs -f frontend
docker compose restart backend
```

The backend answers on `http://localhost:8000/health` when it's healthy.
