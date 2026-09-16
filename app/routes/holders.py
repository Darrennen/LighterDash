"""LIT holders endpoint — tier breakdown + leaderboard from tracked account snapshots."""
from __future__ import annotations

import time

from fastapi import APIRouter, Query

from app.db import fetch_lit_l1_holders
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


@router.get("/l1")
async def l1_holders(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """The global LIT holder set — every Ethereum L1 address holding LIT.

    Distinct from /summary, which only sees LIT inside Lighter L2 accounts that
    traded. The two are related by one row here: the L1 bridge, whose balance is
    the entire L2 float.
    """
    return await fetch_lit_l1_holders(limit=limit, offset=offset)
