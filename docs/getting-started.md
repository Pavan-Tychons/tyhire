# Getting started

This page is for whoever sets TyHire up. If it's already running and you just want to use
it, go straight to the [HR guide](hr-guide.md).

## What you need

- **Docker Desktop**, running.
- **An OpenAI API key.** TyHire will start without one, but every AI feature fails —
  resume parsing, scoring, transcription, question suggestions, identity matching, reports.
- Ports **3000**, **8000**, **5442** and **3478** free on your machine.

## 1. Create your `.env`

```bash
cp .env.example .env
```

Open `.env` and fill it in. **Five values must be set or the stack refuses to start:**

| Setting | What to put |
|---|---|
| `POSTGRES_USER` | Any username, e.g. `hr_tool` |
| `POSTGRES_PASSWORD` | A long random string |
| `POSTGRES_DB` | Any database name, e.g. `hr_tool` |
| `SESSION_SECRET` | A long random string — signs the HR login cookie |
| `TURN_SECRET` | A long random string — shared with the video relay |

Generate the random ones with:

```bash
openssl rand -hex 32
```

Then set these two, which are what actually make the product work:

| Setting | What to put |
|---|---|
| `OPENAI_API_KEY` | Your key, starting `sk-` |
| `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | The first HR login — see the warning below |

Everything else in `.env.example` is optional and can stay as-is. The ones worth knowing
about later are covered in [troubleshooting](troubleshooting.md#data-retention-and-privacy).

> **Changing `SESSION_SECRET` later logs everyone out.** That's the only consequence — it's
> safe to rotate if you think it has leaked.

## 2. Start it

```bash
docker compose up -d --build
```

The first build takes a few minutes. Four containers start: the frontend, the backend,
PostgreSQL and coturn. The backend waits for the database to be healthy before it starts,
and the frontend waits for the backend, so give it a moment before loading the page.

Check it came up:

```bash
docker compose ps
```

## 3. Log in

Open **http://localhost:3000** and sign in with the `INITIAL_ADMIN_EMAIL` and
`INITIAL_ADMIN_PASSWORD` from your `.env`.

> **The first admin is only created while the user table is empty.** It is created the first
> time the backend starts with both values set. If you change them afterwards, nothing
> happens — the existing account keeps its original password. See
> [troubleshooting](troubleshooting.md#i-cant-log-in-as-the-admin) if you're locked out.

**There is no sign-up page.** This is deliberate — HR accounts are created by an admin, not
self-registered.

## 4. Add your team

Go to **HR Users** in the top nav. Admins can add a user (email, optional display name, and
a temporary password to hand over) and remove users. Non-admins can see the list but not
change it.

Two rules are enforced: you cannot delete your own account, and you cannot delete the last
remaining admin.

### Google / Microsoft sign-in (optional)

If you set the Google or Microsoft client ID and secret in `.env`, those sign-in options
become available. They can only log in **an email that already has a TyHire account** —
signing in with Google never creates one. Anyone else is bounced back to the login page.

## Stopping and starting

```bash
docker compose stop     # stop, keep everything
docker compose up -d    # start again
docker compose down     # stop and remove containers (your data survives)
```

Your database lives in a Docker volume and uploaded files live in `storage/` — neither is
removed by `docker compose down`.

## Where things are

| | |
|---|---|
| The app | http://localhost:3000 |
| Uploaded files | `storage/` in this folder |
| Database | PostgreSQL on host port **5442** |

## Next

- [HR guide](hr-guide.md) — create your first job and screen some resumes.
