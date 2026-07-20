"""LIT buy/sell tracker endpoints."""
from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, HTTPException, Query

from app.db import (
    fetch_backfill_status,
    fetch_lit_account_flow,
    fetch_lit_account_trades,
    fetch_lit_candles_db,
    fetch_lit_flow,
    fetch_lit_leaders,
    fetch_lit_stats,
    fetch_lit_trades,
    fetch_relative_performance,
    fetch_volume_by_venue,
    init_db,
)
from app.services.collector import (
    _parse_explorer_lit_trade,
    backfill_account_histories,
    backfill_lit_once,
    collect_lit_once,
    collect_once,
)
from app.services.lighter_client import client
from app.services.store import store

router = APIRouter()
log = logging.getLogger("lighter.lit")

_last_market: float = 0.0
_last_lit: float = 0.0
_db_ready: bool = False
_backfill_done: bool = False
_deep_backfill_triggered: bool = False
_TTL = 5.0

_candles_cache: dict = {}
_candles_cache_ts: dict = {}
_CANDLES_TTL = 60.0

_relperf_cache: dict = {}
_relperf_cache_ts: dict = {}
_RELPERF_TTL = 60.0

_volvenue_cache: dict = {}
_volvenue_cache_ts: dict = {}
_VOLVENUE_TTL = 60.0

# market_id sentinel: None = all LIT markets, 120 = perp, 2049 = spot
_VALID_MARKETS = {120, 2049}


async def _maybe_refresh() -> None:
    global _last_market, _last_lit, _db_ready, _backfill_done, _deep_backfill_triggered
    if not _db_ready:
        try:
            await init_db()
            _db_ready = True
        except Exception as e:
            log.error("init_db: %s", e)

    if _db_ready and not _backfill_done:
        _backfill_done = True
        asyncio.create_task(backfill_lit_once())

    if _db_ready and not _deep_backfill_triggered:
        _deep_backfill_triggered = True
        asyncio.create_task(backfill_account_histories())

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


@router.get("/backfill-status")
async def backfill_status():
    """Progress of the deep account-history backfill."""
    await _maybe_refresh()
    return await fetch_backfill_status()


@router.get("/backfill-trigger")
async def backfill_trigger():
    """Manually kick off the next batch of account history backfill."""
    asyncio.create_task(backfill_account_histories())
    return {"started": True}


@router.get("/trades")
async def trades(
    limit: int = Query(100, ge=1, le=500),
    hours: int = Query(24, ge=0, le=87600),   # 0 = all time
    market_id: int | None = None,
):
    await _maybe_refresh()
    data = await fetch_lit_trades(limit=limit, hours=hours, market_id=_market_filter(market_id))
    return {"trades": data, "count": len(data)}


@router.get("/flow")
async def flow(
    hours: int = Query(24, ge=0, le=87600),
    market_id: int | None = None,
):
    await _maybe_refresh()
    return await fetch_lit_flow(hours=hours, market_id=_market_filter(market_id))


@router.get("/account-flow")
async def account_flow(
    account_id: int,
    market_id: int | None = None,
):
    await _maybe_refresh()
    return await fetch_lit_account_flow(
        account_id=account_id, market_id=_market_filter(market_id)
    )


def _log_entry_ts_ms(entry: dict) -> int:
    """Parse explorer log entry time → epoch ms."""
    from datetime import datetime
    try:
        return int(
            datetime.fromisoformat(
                (entry.get("time") or "").replace("Z", "+00:00")
            ).timestamp() * 1000
        )
    except Exception:
        return 0


@router.get("/account-flow-live")
async def account_flow_live(
    account_id: int,
    address: str = Query(""),
    market_id: int | None = None,
):
    """Compute LIT buy/sell flow directly from explorer logs — no local DB needed."""
    if not address:
        try:
            data = await client.account(by="index", value=str(account_id))
            address = data.get("l1_address", "")
        except Exception:
            address = ""
    if not address:
        raise HTTPException(status_code=404, detail="Account address not found")

    mid_filter = _market_filter(market_id)
    now_ms = int(time.time() * 1000)
    cutoff_ms = now_ms - 30 * 24 * 3_600_000

    trades: list[dict] = []
    BATCH = 3   # pages fetched concurrently
    MAX_PAGES = 30

    offset = 0
    done = False
    while not done and offset < MAX_PAGES * 100:
        # fetch BATCH pages in parallel
        page_offsets = list(range(offset, min(offset + BATCH * 100, MAX_PAGES * 100), 100))
        results = await asyncio.gather(
            *(client.account_logs(address=address, limit=100, offset=o) for o in page_offsets),
            return_exceptions=True,
        )
        for logs in results:
            if isinstance(logs, Exception) or not logs:
                done = True
                break
            for entry in logs:
                t = _parse_explorer_lit_trade(entry)
                if t and (mid_filter is None or t["market_id"] == mid_filter):
                    trades.append(t)
            # stop when the oldest log on this page predates our 30d cutoff
            oldest_in_page = min((_log_entry_ts_ms(e) for e in logs), default=0)
            if oldest_in_page < cutoff_ms or len(logs) < 100:
                done = True
                break
        offset += BATCH * 100

    windows = {"24h": 24, "7d": 168, "30d": 720}
    result: dict = {}
    for label, hours in windows.items():
        since_ms = now_ms - hours * 3_600_000
        w = [t for t in trades if t["ts"] >= since_ms]
        buys  = [t for t in w if t["buyer_id"]  == account_id]
        sells = [t for t in w if t["seller_id"] == account_id]
        buy_usd   = sum(t["usd"]  for t in buys)
        buy_size  = sum(t["size"] for t in buys)
        sell_usd  = sum(t["usd"]  for t in sells)
        sell_size = sum(t["size"] for t in sells)
        result[label] = {
            "buy_usd":       buy_usd,
            "buy_size":      buy_size,
            "buy_trades":    len(buys),
            "buy_avg_price": buy_usd  / buy_size  if buy_size  > 0 else None,
            "sell_usd":      sell_usd,
            "sell_size":     sell_size,
            "sell_trades":   len(sells),
            "sell_avg_price":sell_usd / sell_size if sell_size > 0 else None,
            "net_usd":       buy_usd - sell_usd,
            "net_size":      buy_size - sell_size,
        }
    result["_address"] = address  # let frontend cache this for future requests
    return result


@router.get("/account")
async def account_trades(
    account_id: int,
    hours: int = Query(24, ge=0, le=87600),
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


@router.get("/candles")
async def candles(
    resolution: str = Query("1h", pattern="^(5m|15m|1h|4h|1d)$"),
    count: int = Query(72, ge=10, le=200),
    market_id: int = Query(120),
):
    """OHLCV candles for LIT markets — built from the local trade ledger
    (lit_trades), falling back to the upstream API if too little local data."""
    cache_key = f"{market_id}_{resolution}"
    now = time.time()
    if cache_key in _candles_cache and now - _candles_cache_ts.get(cache_key, 0) < _CANDLES_TTL:
        return _candles_cache[cache_key]

    minutes = {"5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440}[resolution]
    db_candles = await fetch_lit_candles_db(market_id=market_id, minutes=minutes, count=count)
    if len(db_candles) >= 2:
        raw = db_candles
    else:
        try:
            raw = await client.candles(market_id=market_id, resolution=resolution, count=count)
        except Exception as e:
            log.warning("candles fetch failed: %s", e)
            raw = []
    result = {"candles": raw, "market_id": market_id, "resolution": resolution, "ts": int(now * 1000)}
    _candles_cache[cache_key] = result
    _candles_cache_ts[cache_key] = now
    return result


@router.get("/leaders")
async def leaders(
    hours: int = Query(24, ge=0, le=87600),
    top_n: int = Query(15, ge=5, le=50),
    market_id: int | None = None,
):
    await _maybe_refresh()
    return await fetch_lit_leaders(
        hours=hours, top_n=top_n, market_id=_market_filter(market_id)
    )


@router.get("/relative-performance")
async def relative_performance(hours: int = Query(168, ge=1, le=8760)):
    await _maybe_refresh()
    now = time.time()
    if hours in _relperf_cache and now - _relperf_cache_ts.get(hours, 0) < _RELPERF_TTL:
        return _relperf_cache[hours]
    result = await fetch_relative_performance(hours)
    _relperf_cache[hours] = result
    _relperf_cache_ts[hours] = now
    return result


@router.get("/volume-by-venue")
async def volume_by_venue(hours: int = Query(24, ge=1, le=8760)):
    await _maybe_refresh()
    now = time.time()
    if hours in _volvenue_cache and now - _volvenue_cache_ts.get(hours, 0) < _VOLVENUE_TTL:
        return _volvenue_cache[hours]
    result = await fetch_volume_by_venue(hours)
    _volvenue_cache[hours] = result
    _volvenue_cache_ts[hours] = now
    return result
