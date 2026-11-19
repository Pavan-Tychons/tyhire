from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://hr_tool:hr_tool@localhost:5432/hr_tool"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"

    # Realtime streaming live transcription (api/v1/live_transcribe.py). gpt-live-transcribe
    # streams text word-by-word *during* speech (~1.4s to first word), which is what makes the
    # live transcript feel instant; gpt-4o-transcribe only emits after a turn ends (~7s) and is
    # the model the ~12s chunk-upload fallback path already uses. When the flag is off (or the
    # realtime WS fails to connect) clients transparently fall back to that chunk path, so turning
    # this off is safe. Realtime is billed per minute of audio for BOTH sides of the call.
    openai_realtime_model: str = "gpt-live-transcribe"
    live_realtime_transcription_enabled: bool = True
    storage_root: str = "../storage"
    cors_origins: list[str] = ["http://localhost:3000"]

    # AI Candidate Comparison (api/v1/comparison.py). The max is a hard cap on how many
    # candidates one comparison request may include — bounds both prompt size/token cost and
    # the readability of the resulting table. Default 10 is the tested ceiling for a single
    # bounded request; raise deliberately (and re-test) rather than assuming higher scales.
    # The timeout is the per-request ceiling on the single OpenAI call, after which the
    # comparison degrades gracefully to the factual table with no AI narrative.
    comparison_max_candidates: int = 10
    comparison_ai_timeout_seconds: float = 60.0

    # Signs the HR session cookie — rotating this logs everyone out. Required, with no
    # fallback: a guessable default here would let anyone forge a valid HR session cookie.
    session_secret: str

    # Per-user HR accounts live in the `users` table now, created via POST /auth/users once
    # someone is logged in — but that requires a first account to already exist. If the
    # `users` table is empty at startup and both of these are set, one admin user is
    # auto-created so there's a way in; unset (or leave empty) once real accounts exist.
    initial_admin_email: str | None = None
    initial_admin_password: str | None = None

    # Path to a local MaxMind GeoLite2-City.mmdb file for the IP-based location signal
    # (services/geolocation.py). The signal is skipped entirely if unset or the file is
    # missing — download requires a free MaxMind account + license key.
    geoip_db_path: str | None = None

    # Fernet key (Fernet.generate_key()) for encrypting stored ID photos/selfies/recordings
    # at rest (services/storage.py). Opt-in — storage behaves exactly as before if unset.
    # Losing this key makes every already-encrypted file permanently unreadable, so back it
    # up like any other credential; it is NOT the same thing as SESSION_SECRET.
    storage_encryption_key: str | None = None

    # How long raw ID/selfie images are kept before the retention sweep deletes the image
    # files (keeping only the verdict/confidence, not the images) — similar in spirit to the
    # retention limits biometric-privacy statutes typically require.
    identity_media_retention_days: int = 90

    # The app enforces identity_media_retention_days itself via an in-process daily sweep so
    # retention doesn't silently depend on someone remembering to hit the manual endpoint.
    # Disable it (and drive `python -m app.jobs.run_retention_sweep` from external cron
    # instead) if you run multiple backend workers/replicas, so only one process sweeps.
    retention_sweep_enabled: bool = True
    retention_sweep_interval_hours: int = 24

    # Our own coturn TURN server (docker-compose.yml's coturn service) — a fallback relay
    # for the browser-to-browser call when a direct connection can't be made (strict
    # corporate firewalls, some mobile carriers). turn_secret must match coturn's own
    # TURN_SECRET; used to mint short-lived per-call credentials (services/video_provider.py)
    # rather than one fixed shared password.
    turn_domain: str = "localhost"
    # Required, with no fallback: a guessable default here would let anyone mint valid
    # TURN relay credentials against our coturn instance.
    turn_secret: str

    # Google/Microsoft sign-in for HR (Phase 4) — only usable by emails that already match
    # an existing active user; blank until you create these in each provider's console.
    google_client_id: str | None = None
    google_client_secret: str | None = None
    microsoft_client_id: str | None = None
    microsoft_client_secret: str | None = None
    oauth_redirect_base_url: str = "http://localhost:8000/api/v1"
    frontend_base_url: str = "http://localhost:3000"

    livekit_url: str | None = None
    livekit_api_key: str | None = None
    livekit_api_secret: str | None = None

    # Root logger level (see core/logging.py) — DEBUG is noisy in normal operation but
    # useful when actually chasing something like a background task failure.
    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
