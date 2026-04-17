"""REST endpoints — each request triggers an on-demand refresh if data is stale."""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException, Query

from app.db import db_stats, fetch_history, init_db
from app.services.collector import collect_once
from app.services.store import store

router = APIRouter()
log = logging.getLogger("lighter.api")

_last_collect: float = 0.0
_db_ready: bool = False
_CACHE_TTL: float = 5.0


async def _maybe_refresh() -> None:
    global _last_collect, _db_ready
    if not _db_ready:
        try:
            await init_db()
            _db_ready = True
        except Exception as e:
            log.error("init_db failed: %s", e)
    if time.time() - _last_collect < _CACHE_TTL:
        return
    _last_collect = time.time()
    try:
        await collect_once()
    except Exception as e:
        log.error("on-demand collect failed: %s", e)


@router.get("/status")
async def status():
    await _maybe_refresh()
    db = await db_stats()
    return {
        "last_sync": store.last_sync,
        "sync_count": store.sync_count,
        "markets_loaded": len(store.markets),
        "trades_buffered": len(store.trades),
        "last_error": store.last_error,
        "db": db,
    }


@router.get("/markets")
async def markets():
    await _maybe_refresh()
    if not store.markets:
        return {"markets": [], "summary": None, "ts": store.last_sync}

    total_vol = sum(m["volume_24h"] for m in store.markets)
    total_oi = sum(m["oi_usd"] for m in store.markets)
    total_trades = sum(m["trades_24h"] for m in store.markets)
    active = sum(1 for m in store.markets if m["volume_24h"] > 0)

    by_change = sorted(store.markets, key=lambda m: m["price_change"], reverse=True)
    top_gainer = by_change[0] if by_change else None
    top_loser = by_change[-1] if by_change else None

    return {
        "markets": store.markets,
        "summary": {
            "total_volume_24h": total_vol,
            "total_oi_usd": total_oi,
            "total_trades_24h": total_trades,
            "active_markets": active,
            "listed_markets": len(store.markets),
            "top_gainer": top_gainer,
            "top_loser": top_loser,
        },
        "ts": store.last_sync,
    }


@router.get("/trades")
async def trades(
    limit: int = Query(200, ge=1, le=1000),
    min_usd: float = Query(0, ge=0),
    market_id: int | None = None,
):
    await _maybe_refresh()
    out = []
    for t in store.trades:
        if t["usd"] < min_usd:
            continue
        if market_id is not None and t["market_id"] != market_id:
            continue
        out.append(t)
        if len(out) >= limit:
            break
    return {"trades": out, "count": len(out)}


@router.get("/flow")
async def flow(limit: int = Query(500, ge=10, le=1000)):
    await _maybe_refresh()
    buy_usd = sell_usd = 0.0
    per_market: dict[str, dict[str, float]] = {}
    for i, t in enumerate(store.trades):
        if i >= limit:
            break
        if t["side"] == "buy":
            buy_usd += t["usd"]
        else:
            sell_usd += t["usd"]
        pm = per_market.setdefault(t["symbol"], {"buy": 0.0, "sell": 0.0})
        pm[t["side"]] += t["usd"]

    cvd = sorted(
        (
            {
                "symbol": s,
                "delta": v["buy"] - v["sell"],
                "buy": v["buy"],
                "sell": v["sell"],
            }
            for s, v in per_market.items()
        ),
        key=lambda x: abs(x["delta"]),
        reverse=True,
    )

    return {
        "buy_usd": buy_usd,
        "sell_usd": sell_usd,
        "delta_usd": buy_usd - sell_usd,
        "sample_size": min(limit, len(store.trades)),
        "cvd": cvd[:10],
    }


@router.get("/history/{market_id}")
async def history(
    market_id: int,
    hours: int = Query(24, ge=1, le=720),
    field: str = Query(
        "funding", pattern="^(funding|oi_usd|oi_base|last_price)$"
    ),
):
    await _maybe_refresh()
    if market_id not in store.markets_by_id:
        raise HTTPException(404, "unknown market_id")
    data = await fetch_history(market_id, hours=hours, field=field)
    return {
        "market_id": market_id,
        "symbol": store.markets_by_id[market_id]["symbol"],
        "field": field,
        "hours": hours,
        "points": data,
    }
