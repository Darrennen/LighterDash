"""LIT buy/sell tracker endpoints."""
from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, HTTPException, Query, Request

from app.db import (
    fetch_all_lit_account_ids,
    fetch_backfill_status,
    fetch_backfilled_ids,
    fetch_lit_account_flow,
    fetch_lit_account_trades,
    fetch_lit_flow,
    fetch_lit_leaders,
    fetch_lit_stats,
    fetch_lit_top_accounts,
    fetch_lit_trades,
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
from app.services.ratelimit import staking_limiter
from app.services.store import store

router = APIRouter()
log = logging.getLogger("lighter.lit")

_last_market: float = 0.0
_last_lit: float = 0.0
_db_ready: bool = False
_backfill_done: bool = False
_deep_backfill_triggered: bool = False
_TTL = 5.0

_LIT_STAKING_POOL = 281_474_976_710_654

_staking_cache: dict | None = None
_staking_cache_ts: float = 0.0
_STAKING_TTL = 60.0

_buybacks_cache: dict | None = None
_buybacks_cache_ts: float = 0.0
_BUYBACKS_TTL = 300.0  # 5 min

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
    cutoff_ms = now_ms - 30 * 24 * 3_600_000  # only need 30d

    trades: list[dict] = []
    offset = 0
    while True:
        logs = await client.account_logs(address=address, limit=100, offset=offset)
        if not logs:
            break
        for entry in logs:
            t = _parse_explorer_lit_trade(entry)
            if t and (mid_filter is None or t["market_id"] == mid_filter):
                trades.append(t)
        # logs are newest-first; stop once we're past 30 days
        oldest_ts = trades[-1]["ts"] if trades else cutoff_ms - 1
        if oldest_ts < cutoff_ms or len(logs) < 100:
            break
        offset += 100
        await asyncio.sleep(0.08)

    windows = {"24h": 24, "7d": 168, "30d": 720}
    result: dict = {}
    for label, hours in windows.items():
        since_ms = now_ms - hours * 3_600_000
        w = [t for t in trades if t["ts"] >= since_ms]
        buy_usd  = sum(t["usd"] for t in w if t["buyer_id"]  == account_id)
        sell_usd = sum(t["usd"] for t in w if t["seller_id"] == account_id)
        result[label] = {
            "buy_usd":    buy_usd,
            "buy_trades": sum(1 for t in w if t["buyer_id"]  == account_id),
            "sell_usd":   sell_usd,
            "sell_trades":sum(1 for t in w if t["seller_id"] == account_id),
            "net_usd":    buy_usd - sell_usd,
        }
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


@router.get("/funding")
async def lit_funding():
    """Cross-exchange funding rates for LIT-PERP (market_id=120)."""
    rates = await client.funding_rates_raw()
    lit_rows = [
        f for f in rates
        if int(f.get("market_id") or f.get("marketId") or -1) == 120
    ]
    # Build a dict keyed by exchange name for easy frontend consumption
    by_exchange: dict = {}
    for row in lit_rows:
        exch = (row.get("exchange") or "lighter").lower()
        by_exchange[exch] = row.get("rate") or row.get("funding_rate")
    return {"market_id": 120, "by_exchange": by_exchange, "rows": lit_rows}


@router.get("/staking-activity")
async def staking_activity(request: Request):
    """Recent LIT stake/unstake events from top traders' on-chain logs."""
    global _staking_cache, _staking_cache_ts
    now = time.time()
    if _staking_cache and now - _staking_cache_ts < _STAKING_TTL:
        return _staking_cache

    client_ip = request.client.host if request.client else "unknown"
    if not staking_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=429, detail="Too many requests — please slow down")

    await _maybe_refresh()
    account_ids = await fetch_lit_top_accounts(hours=168, limit=20)
    if not account_ids:
        return {"events": [], "accounts_scanned": 0}

    async def get_address(acct_id: int) -> dict:
        try:
            data = await client.account(by="index", value=str(acct_id))
            return {"id": acct_id, "address": data.get("l1_address", "")}
        except Exception:
            return {"id": acct_id, "address": ""}

    acct_list = await asyncio.gather(*[get_address(aid) for aid in account_ids])

    async def get_staking_events(acct: dict) -> list[dict]:
        addr = acct.get("address", "")
        if not addr:
            return []
        try:
            logs = await client.account_logs(address=addr, limit=50)
        except Exception:
            return []
        events = []
        for entry in logs:
            log_type = entry.get("type", "")
            pubdata = entry.get("pubdata") or {}
            if log_type == "L2MintShares":
                ms = pubdata.get("mint_shares_pubdata") or {}
                if int(ms.get("public_pool_index") or 0) == _LIT_STAKING_POOL:
                    events.append({
                        "type": "stake",
                        "account_id": acct["id"],
                        "time": entry.get("time"),
                        "amount": float(ms.get("principal_amount") or 0),
                        "hash": entry.get("hash"),
                    })
            elif log_type in ("BurnedShares", "BurnShares"):
                bs = (pubdata.get("burn_shares_pubdata")
                      or pubdata.get("burned_shares_pubdata") or {})
                if int(bs.get("public_pool_index") or 0) == _LIT_STAKING_POOL:
                    events.append({
                        "type": "unstake",
                        "account_id": acct["id"],
                        "time": entry.get("time"),
                        "amount": float(bs.get("principal_amount") or 0),
                        "hash": entry.get("hash"),
                    })
        return events

    results = await asyncio.gather(*[get_staking_events(a) for a in acct_list])
    all_events: list[dict] = []
    for r in results:
        all_events.extend(r)
    all_events.sort(key=lambda x: x.get("time") or "", reverse=True)

    result = {
        "events": all_events[:50],
        "accounts_scanned": len(account_ids),
        "ts": now,
    }
    _staking_cache = result
    _staking_cache_ts = now
    return result


@router.get("/buybacks")
async def buybacks():
    """Protocol LIT buyback daily stats + treasury balances."""
    global _buybacks_cache, _buybacks_cache_ts
    now = time.time()
    if _buybacks_cache and now - _buybacks_cache_ts < _BUYBACKS_TTL:
        return _buybacks_cache
    data = await client.buybacks_data()
    if data:
        _buybacks_cache = data
        _buybacks_cache_ts = now
    return _buybacks_cache or {}


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
