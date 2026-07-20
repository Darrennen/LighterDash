"""LIT holders endpoint — tier breakdown + leaderboard from tracked account snapshots."""
from __future__ import annotations

import time

from fastapi import APIRouter, Query

from app.services import traders_service

router = APIRouter()

_cache: dict = {}
_cache_ts: float = 0.0
_TTL = 60.0


@router.get("/summary")
async def summary(limit: int = Query(100, ge=1, le=200)):
    global _cache_ts
    now = time.time()
    if limit in _cache and now - _cache_ts < _TTL:
        return _cache[limit]
    data = await traders_service.get_holders(limit=limit)
    _cache[limit] = data
    _cache_ts = now
    return data
