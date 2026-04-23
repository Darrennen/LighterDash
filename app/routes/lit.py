"""LIT buy/sell tracker endpoints."""
from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, Query

from app.db import (
    fetch_lit_account_trades,
    fetch_lit_flow,
    fetch_lit_leaders,
    fetch_lit_stats,
    fetch_lit_trades,
    init_db,
)
from app.services.collector import collect_lit_once, collect_once
from app.services.store import store

router = APIRouter()
log = logging.getLogger("lighter.lit")

_last_market: float = 0.0
_last_lit: float = 0.0
_db_ready: bool = False
_TTL = 5.0

# market_id sentinel: None = all LIT markets, 120 = perp, 2049 = spot
_VALID_MARKETS = {120, 2049}


async def _maybe_refresh() -> None:
    global _last_market, _last_lit, _db_ready
    if not _db_ready:
        try:
            await init_db()
            _db_ready = True
        except Exception as e:
            log.error("init_db: %s", e)

    now = time.time()
    tasks = []
    if now - _last_market >= _TTL:
        _last_market = now
        tasks.append(collect_once())
    if now - _last_lit >= _TTL:
        _last_lit = now
        tasks.append(collect_lit_once())
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def _market_filter(market: int | None) -> int | None:
    return market if market in _VALID_MARKETS else None


@router.get("/summary")
async def summary():
    await _maybe_refresh()
    perp = store.markets_by_id.get(120, {})
    spot = store.markets_by_id.get(2049, {})
    stats = await fetch_lit_stats()
    return {
        "perp": perp,
        "spot": spot,
        **stats,
        "ts": store.last_sync,
    }


@router.get("/trades")
async def trades(
    limit: int = Query(100, ge=1, le=500),
    hours: int = Query(24, ge=1, le=720),
    market_id: int | None = None,
):
    await _maybe_refresh()
    data = await fetch_lit_trades(limit=limit, hours=hours, market_id=_market_filter(market_id))
    return {"trades": data, "count": len(data)}


@router.get("/flow")
async def flow(
    hours: int = Query(24, ge=1, le=720),
    market_id: int | None = None,
):
    await _maybe_refresh()
    return await fetch_lit_flow(hours=hours, market_id=_market_filter(market_id))


@router.get("/account")
async def account_trades(
    account_id: int,
    hours: int = Query(24, ge=1, le=720),
    role: str = Query("buyer"),
    market_id: int | None = None,
):
    await _maybe_refresh()
    safe_role = role if role in ("buyer", "seller") else "buyer"
    data = await fetch_lit_account_trades(
        account_id=account_id, hours=hours,
        role=safe_role, market_id=_market_filter(market_id),
    )
    return {"trades": data, "count": len(data), "account_id": account_id, "role": safe_role}


@router.get("/leaders")
async def leaders(
    hours: int = Query(24, ge=1, le=720),
    top_n: int = Query(15, ge=5, le=50),
    market_id: int | None = None,
):
    await _maybe_refresh()
    return await fetch_lit_leaders(
        hours=hours, top_n=top_n, market_id=_market_filter(market_id)
    )
