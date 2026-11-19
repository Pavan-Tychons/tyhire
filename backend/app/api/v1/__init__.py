from fastapi import APIRouter

from app.api.v1 import (
    auth,
    candidates,
    comparison,
    dashboard,
    interviews,
    jobs,
    l1_screening,
    live_transcribe,
    oauth,
    settings,
    signaling,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(oauth.router)
api_router.include_router(dashboard.router)
api_router.include_router(jobs.router)
api_router.include_router(candidates.router)
api_router.include_router(comparison.router)
api_router.include_router(interviews.router)
api_router.include_router(signaling.router)
api_router.include_router(live_transcribe.router)
api_router.include_router(l1_screening.router)
api_router.include_router(settings.router)
