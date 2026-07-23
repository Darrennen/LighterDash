"""Background collector task.

Every COLLECT_INTERVAL seconds:
  1. Pull /orderBooks, /exchangeStats, /funding-rates, /recentTrades.
  2. Normalise into a uniform market dict + trade dict.
  3. Update the in-memory store.
  4. Persist a funding + OI history row per market to SQLite.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from app.config import settings
from app.db import (
    fetch_all_lit_account_ids,
    fetch_backfilled_ids,
    fetch_lit_stats,
    mark_backfilled,
    prune_old,
    upsert_account_snapshot,
    write_history,
    write_lit_trades,
)
from app.services.lighter_client import client
from app.services.store import store

LIT_MARKET_IDS = (120, 2049)  # LIT perp + LIT/USDC spot
_TRADES_FETCH_CONCURRENCY = 5  # cap concurrent recentTrades calls per tick

log = logging.getLogger("lighter.collector")


# ─── normalisation helpers ────────────────────────────────────────────
def _num(x: Any, default: float = 0.0) -> float:
    try:
        return float(x) if x is not None else default
    except (TypeError, ValueError):
        return default


def _normalise_markets(
    details: list[dict], fundings: list[dict]
) -> list[dict[str, Any]]:
    fund_by_id: dict[int, float] = {}
    for f in fundings:
        mid = f.get("market_id", f.get("marketId"))
        rate = f.get("rate", f.get("funding_rate"))
        if mid is not None and rate is not None:
            fund_by_id[int(mid)] = _num(rate)

    out: list[dict[str, Any]] = []
    for d in details:
        mid_raw = d.get("market_id", d.get("marketId"))
        if mid_raw is None:
            continue
        mid = int(mid_raw)
        symbol = d.get("symbol") or f"MKT-{mid}"
        last = _num(d.get("last_trade_price"))
        oi_base = _num(d.get("open_interest"))
        oi_usd  = oi_base * last if oi_base and last else 0.0
        out.append(
            {
                "market_id": mid,
                "symbol": symbol,
                "market_type": d.get("market_type", "perp"),
                "status": d.get("status"),
                "last_price": last,
                "price_high_24h": _num(d.get("daily_price_high")),
                "price_low_24h": _num(d.get("daily_price_low")),
                "price_change": _num(d.get("daily_price_change")),
                "volume_24h": _num(d.get("daily_quote_token_volume")),
                "base_volume_24h": _num(d.get("daily_base_token_volume")),
                "trades_24h": int(_num(d.get("daily_trades_count"))),
                "oi_base": oi_base,
                "oi_usd": oi_usd,
                "funding": fund_by_id.get(mid),
            }
        )
    return out


def _normalise_trade(raw: dict, market: dict) -> dict[str, Any] | None:
    price = _num(raw.get("price"))
    size = _num(raw.get("size"))
    if price <= 0 or size <= 0:
        return None

    raw_ts = raw.get("timestamp")
    if raw_ts is None:
        ts_ms = int(time.time() * 1000)
    else:
        ts_num = _num(raw_ts)
        ts_ms = int(ts_num if ts_num > 1e12 else ts_num * 1000)

    # Taker side inference — Lighter returns `is_maker_ask` most commonly.
    # maker_ask=True → maker was the seller → taker bought (aggressive buy)
    if isinstance(raw.get("is_maker_ask"), bool):
        taker_buy = bool(raw["is_maker_ask"])
    elif raw.get("taker_side") in ("buy", "bid"):
        taker_buy = True
    elif raw.get("taker_side") in ("sell", "ask"):
        taker_buy = False
    elif raw.get("side") in ("buy", "bid"):
        taker_buy = True
    elif raw.get("side") in ("sell", "ask"):
        taker_buy = False
    else:
        taker_buy = True  # fallback; rare

    trade_id_raw = raw.get("trade_id") or raw.get("id") or raw.get("tx_hash")
    if trade_id_raw is None:
        trade_id_raw = f"{ts_ms}-{price}-{size}"
    trade_id = f"{market['market_id']}-{trade_id_raw}"

    return {
        "id": trade_id,
        "market_id": market["market_id"],
        "symbol": market["symbol"],
        "price": price,
        "size": size,
        "usd": price * size,
        "ts": ts_ms,
        "side": "buy" if taker_buy else "sell",
    }


# ─── main loop ───────────────────────────────────────────────────────
async def collect_once() -> dict[str, Any]:
    details, fundings = await asyncio.gather(
        client.order_book_details(),
        client.funding_rates(),
    )
    markets = _normalise_markets(details, fundings)
    store.set_markets(markets)

    # Top N by volume → pull trades with capped concurrency (a flat gather of
    # TOP_N_MARKETS requests fires them all in the same instant, which is the
    # kind of burst that trips Lighter's rate limiter/WAF in the first place).
    top = sorted(markets, key=lambda m: m["volume_24h"], reverse=True)[
        : settings.TOP_N_MARKETS
    ]
    sem = asyncio.Semaphore(_TRADES_FETCH_CONCURRENCY)

    async def _fetch(m: dict[str, Any]) -> list[dict]:
        async with sem:
            return await client.recent_trades(m["market_id"], settings.RECENT_TRADES_LIMIT)

    trade_results = await asyncio.gather(
        *(_fetch(m) for m in top),
        return_exceptions=True,
    )

    new_trades: list[dict[str, Any]] = []
    for market, result in zip(top, trade_results):
        if isinstance(result, Exception):
            continue
        for raw in result:
            t = _normalise_trade(raw, market)
            if t:
                new_trades.append(t)

    added = store.add_trades(new_trades)

    # ─── persist funding + OI history only ──
    await write_history(markets)

    store.mark_sync()

    return {
        "markets_count": len(markets),
        "new_trades": len(added),
        "with_funding": sum(1 for m in markets if m["funding"] is not None),
    }


def _norm_lit_trade(raw: dict, market_id: int) -> dict[str, Any] | None:
    price = _num(raw.get("price"))
    size = _num(raw.get("size"))
    trade_id = raw.get("trade_id")
    if price <= 0 or size <= 0 or not trade_id:
        return None
    is_maker_ask = raw.get("is_maker_ask")
    taker_is_buyer = bool(is_maker_ask) if isinstance(is_maker_ask, bool) else True
    ts_raw = raw.get("timestamp", 0)
    ts_ms = int(float(ts_raw)) if ts_raw else int(time.time() * 1000)
    return {
        "trade_id": int(trade_id),
        "market_id": market_id,
        "ts": ts_ms,
        "price": price,
        "size": size,
        "usd": price * size,
        "buyer_id": int(raw.get("bid_account_id") or 0),
        "seller_id": int(raw.get("ask_account_id") or 0),
        "taker_is_buyer": 1 if taker_is_buyer else 0,
    }


async def collect_lit_once() -> int:
    """Fetch up to 100 recent trades for both LIT markets and store new ones."""
    results = await asyncio.gather(
        *(client.recent_trades(mid, 100) for mid in LIT_MARKET_IDS),
        return_exceptions=True,
    )
    trades: list[dict[str, Any]] = []
    for market_id, result in zip(LIT_MARKET_IDS, results):
        if isinstance(result, Exception):
            log.debug("LIT recentTrades(%s) failed: %s", market_id, result)
            continue
        for raw in result:
            t = _norm_lit_trade(raw, market_id)
            if t:
                trades.append(t)
    return await write_lit_trades(trades) if trades else 0


_backfill_running = False


async def backfill_lit_once() -> int:
    """One-shot bulk fetch of the 500 most recent trades per LIT market on startup."""
    global _backfill_running
    if _backfill_running:
        return 0
    _backfill_running = True
    try:
        stats = await fetch_lit_stats()
        if (stats.get("db_trade_count") or 0) >= 500:
            return 0  # already have a meaningful history

        results = await asyncio.gather(
            *(client.recent_trades(mid, 500) for mid in LIT_MARKET_IDS),
            return_exceptions=True,
        )
        trades: list[dict[str, Any]] = []
        for market_id, result in zip(LIT_MARKET_IDS, results):
            if isinstance(result, Exception):
                log.debug("backfill recentTrades(%s) failed: %s", market_id, result)
                continue
            for raw in result:
                t = _norm_lit_trade(raw, market_id)
                if t:
                    trades.append(t)

        n = await write_lit_trades(trades) if trades else 0
        log.info("backfill: stored %d trades across LIT markets", n)
        return n
    finally:
        _backfill_running = False


_LIT_MARKET_SET = set(LIT_MARKET_IDS)
_account_backfill_running = False


def _parse_explorer_lit_trade(entry: dict) -> dict[str, Any] | None:
    """Parse a single explorer log entry into a lit_trade dict, or None if not a LIT trade."""
    pubdata = entry.get("pubdata") or {}
    trade = pubdata.get("trade_pubdata") or pubdata.get("trade_pubdata_with_funding")
    if not trade:
        return None

    market_id = int(trade.get("market_index") or -1)
    if market_id not in _LIT_MARKET_SET:
        return None

    price = _num(trade.get("price"))
    size  = _num(trade.get("size"))
    if price <= 0 or size <= 0:
        return None

    tx_hash = entry.get("hash", "")
    if not tx_hash or len(tx_hash) < 16:
        return None
    # Derive a stable integer trade_id from the first 8 bytes of the tx hash.
    # These are ~5×10^17, well above current sequential Lighter trade IDs (~10^10),
    # so there is no collision risk with recentTrades-sourced rows.
    trade_id = int(tx_hash[:15], 16)

    taker_idx    = int(trade.get("taker_account_index") or 0)
    maker_idx    = int(trade.get("maker_account_index") or 0)
    is_taker_ask = int(trade.get("is_taker_ask") or 0)

    if is_taker_ask:
        buyer_id, seller_id, taker_is_buyer = maker_idx, taker_idx, 0
    else:
        buyer_id, seller_id, taker_is_buyer = taker_idx, maker_idx, 1

    time_str = entry.get("time", "")
    try:
        ts_ms = int(
            datetime.fromisoformat(time_str.replace("Z", "+00:00"))
            .timestamp() * 1000
        )
    except Exception:
        ts_ms = int(time.time() * 1000)

    return {
        "trade_id": trade_id,
        "market_id": market_id,
        "ts": ts_ms,
        "price": price,
        "size": size,
        "usd": price * size,
        "buyer_id": buyer_id,
        "seller_id": seller_id,
        "taker_is_buyer": taker_is_buyer,
    }


async def _backfill_single_account(account_id: int, l1_address: str) -> int:
    """Fetch every LIT trade for one account from the explorer and store new ones."""
    total = 0
    offset = 0
    page_limit = 100

    while True:
        try:
            logs = await client.account_logs(address=l1_address, limit=page_limit, offset=offset)
        except Exception as e:
            log.debug("explorer logs(%s, offset=%d) failed: %s", account_id, offset, e)
            break

        if not logs:
            break

        trades = [t for entry in logs if (t := _parse_explorer_lit_trade(entry))]
        if trades:
            n = await write_lit_trades(trades)
            total += n

        if len(logs) < page_limit:
            break  # last page
        offset += page_limit
        await asyncio.sleep(0.15)

    return total


async def backfill_account_histories() -> dict[str, int]:
    """Background task: deep-fetch full LIT history for all known accounts."""
    global _account_backfill_running
    if _account_backfill_running:
        return {"skipped": True}
    _account_backfill_running = True
    try:
        all_ids   = await fetch_all_lit_account_ids()
        done_ids  = await fetch_backfilled_ids()
        pending   = [aid for aid in all_ids if aid not in done_ids]

        processed = 0
        new_trades = 0
        for account_id in pending[:30]:  # max 30 per run
            try:
                data = await client.account(by="index", value=str(account_id))
                addr = data.get("l1_address", "")
            except Exception:
                data = None
                addr = ""

            if addr:
                n = await _backfill_single_account(account_id, addr)
                new_trades += n
            else:
                n = 0

            # Free enrichment: `data` (the full /account response) is already fetched
            # above for its l1_address — persist it as an account snapshot too so this
            # backfill also feeds LIT-holder coverage, at zero extra API cost.
            if data:
                await upsert_account_snapshot(
                    account_index=account_id,
                    l1_address=addr,
                    ts=int(time.time()),
                    collateral=_num(data.get("collateral")),
                    total_asset_value=_num(data.get("total_asset_value")),
                    payload=json.dumps(data),
                )

            await mark_backfilled(account_id, addr or "unknown", n)
            processed += 1
            log.info("history backfill account #%d → +%d LIT trades", account_id, n)
            await asyncio.sleep(0.3)

        log.info("history backfill done: %d accounts processed, %d new trades", processed, new_trades)
        return {"accounts": processed, "new_trades": new_trades, "remaining": max(0, len(pending) - processed)}
    finally:
        _account_backfill_running = False


async def collector_loop() -> None:
    last_prune = 0
    backoff = settings.COLLECT_INTERVAL
    while True:
        t0 = time.time()
        try:
            summary = await collect_once()
            backoff = settings.COLLECT_INTERVAL

            if time.time() - last_prune > 3600:
                await prune_old()
                last_prune = time.time()

            log.info(
                "tick · %d markets · %d new trades · %d with funding · %.2fs",
                summary["markets_count"],
                summary["new_trades"],
                summary["with_funding"],
                time.time() - t0,
            )
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.error("collector tick failed: %s", e)
            store.mark_sync(err=str(e))
            backoff = min(backoff * 2, 60)

        elapsed = time.time() - t0
        await asyncio.sleep(max(0.1, backoff - elapsed))
