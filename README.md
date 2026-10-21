# TyHire

TyHire is an AI-assisted hiring tool that covers two stages of the process:

1. **Resume screening** — upload resumes against a job, and each one is parsed, checked
   against your eligibility rules, scored out of 100, and sorted into Approved / Review /
   Declined.
2. **Interview integrity** — run the interview as a video call inside TyHire, with identity
   verification, screen sharing, live transcription, AI-suggested questions, and proctoring
   signals that are summarised into an integrity score for a human to review afterwards.

Nothing in TyHire auto-rejects a candidate. Every score, flag and signal is a prompt for a
person to make the decision.

## Quick start

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) and an OpenAI
API key.

```bash
cp .env.example .env        # then edit it — see the setup guide
docker compose up -d --build
```

Open **http://localhost:3000** and sign in with the `INITIAL_ADMIN_EMAIL` and
`INITIAL_ADMIN_PASSWORD` you put in `.env`.

Full instructions, including the values you must set before the stack will start, are in
**[docs/getting-started.md](docs/getting-started.md)**.

> Without a working `OPENAI_API_KEY`, TyHire still runs but every AI feature fails — resume
> parsing and scoring, transcription, question suggestions, identity matching and reports.

## Documentation

| Guide | What it covers |
|---|---|
| [Getting started](docs/getting-started.md) | Setting up `.env`, starting the stack, first login, adding HR users |
| [HR guide](docs/hr-guide.md) | The day-to-day: creating jobs, screening resumes, reading scores, deciding on candidates, scheduling interviews |
| [Running an interview](docs/running-an-interview.md) | What the candidate goes through, and how to use the Interviewer Command Center |
| [Reviewing results](docs/reviewing-results.md) | The review queue, integrity scores, proctoring signals, flags and transcripts |
| [How scoring works](docs/how-scoring-works.md) | Where the fit score and integrity score come from, in plain terms |
| [Troubleshooting](docs/troubleshooting.md) | Common problems, plus what data is stored and for how long |

## How it fits together

| Part | What it is |
|---|---|
| Frontend | Next.js app on port **3000** — everything you interact with |
| Backend | FastAPI service on port **8000** — scoring, interviews, AI calls |
| Database | PostgreSQL (published on host port **5442**) |
| coturn | Relay that keeps video calls connected through strict firewalls |

Candidates and interviewers never need an account — they join through single-use links you
generate. Only HR staff log in.
