"""Traders feature: background ingest loop (all_trades + account_snapshots) plus
reconstruction logic for the leaderboard / positions / profile / pnl endpoints.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from typing import Any

from app.db import (
    fetch_account_snapshots,
    fetch_all_trades_status,
    fetch_leaderboard,
    fetch_pnl_cache,
    fetch_snapshot_ages,
    fetch_top_trade_accounts,
    prune_all_trades,
    upsert_account_snapshot,
    upsert_pnl_cache,
    write_all_trades,
)
from app.services.lighter_client import client

log = logging.getLogger("lighter.traders")


def _num(x: Any, default: float = 0.0) -> float:
    try:
        return float(x) if x not in (None, "") else default
    except (TypeError, ValueError):
        return default


# ── ingest loop tuning ────────────────────────────────────────────────
_TOP_N_TRADE_MARKETS = 25
_TOP_N_ACCOUNTS = 150
_ACCOUNT_STALE_SECS = 240
_POSITION_CONCURRENCY = 4
_TRADES_CONCURRENCY = 8  # cap concurrent recentTrades calls — the upstream WAF
                         # blocks bursts above ~30 simultaneous requests

_TICK_SECS = 10
_TRADES_SWEEP_SECS = 60
_POSITIONS_SCAN_SECS = 240
_MARKET_META_TTL = 300
_PRUNE_SECS = 86400

_market_meta: dict[int, dict[str, Any]] = {}  # market_id -> {symbol, last_price, volume_24h}
_last_market_meta_refresh = 0.0
_last_trades_top = 0.0
_last_trades_sweep = 0.0
_last_positions_scan = 0.0
_last_prune = 0.0

status: dict[str, Any] = {
    "last_tick": 0,
    "trades_ingested": 0,
    "accounts_scanned": 0,
    "last_error": None,
    "started_at": 0,
}


async def _refresh_market_meta() -> None:
    global _last_market_meta_refresh
    details = await client.order_book_details()
    meta: dict[int, dict[str, Any]] = {}
    for d in details:
        mid_raw = d.get("market_id", d.get("marketId"))
        if mid_raw is None:
            continue
        mid = int(mid_raw)
        meta[mid] = {
            "symbol": d.get("symbol") or f"MKT-{mid}",
            "last_price": _num(d.get("last_trade_price")),
            "volume_24h": _num(d.get("daily_quote_token_volume")),
        }
    if meta:
        _market_meta.clear()
        _market_meta.update(meta)
    _last_market_meta_refresh = time.time()


def _top_market_ids(n: int) -> list[int]:
    ranked = sorted(_market_meta.items(), key=lambda kv: kv[1]["volume_24h"], reverse=True)
    return [mid for mid, _ in ranked[:n]]


def _normalize_trade(raw: dict, market_id: int, symbol: str) -> dict[str, Any] | None:
    price = _num(raw.get("price"))
    size = _num(raw.get("size"))
    trade_id_raw = raw.get("trade_id")
    if price <= 0 or size <= 0 or trade_id_raw is None:
        return None
    is_maker_ask = raw.get("is_maker_ask")
    taker_is_buyer = bool(is_maker_ask) if isinstance(is_maker_ask, bool) else True
    ts_raw = raw.get("timestamp", 0)
    ts_ms = int(float(ts_raw)) if ts_raw else int(time.time() * 1000)
    usd = _num(raw.get("usd_amount")) or price * size
    return {
        "trade_id": f"{market_id}-{trade_id_raw}",
        "market_id": market_id,
        "symbol": symbol,
        "ts": ts_ms,
        "price": price,
        "size": size,
        "usd": usd,
        "bid_account": int(raw.get("bid_account_id") or 0),
        "ask_account": int(raw.get("ask_account_id") or 0),
        "taker_is_buyer": 1 if taker_is_buyer else 0,
    }


async def _poll_trades(market_ids: list[int]) -> int:
    if not market_ids:
        return 0
    sem = asyncio.Semaphore(_TRADES_CONCURRENCY)

    async def _fetch(mid: int):
        async with sem:
            return await client.recent_trades(mid, 100)

    results = await asyncio.gather(*(_fetch(mid) for mid in market_ids), return_exceptions=True)
    trades: list[dict[str, Any]] = []
    for mid, result in zip(market_ids, results):
        if isinstance(result, Exception):
            continue
        symbol = _market_meta.get(mid, {}).get("symbol", f"MKT-{mid}")
        for raw in result:
            t = _normalize_trade(raw, mid, symbol)
            if t:
                trades.append(t)
    return await write_all_trades(trades) if trades else 0


async def _scan_positions() -> int:
    top_accounts = await fetch_top_trade_accounts(hours=24, limit=_TOP_N_ACCOUNTS)
    if not top_accounts:
        return 0
    ages = await fetch_snapshot_ages(top_accounts)
    now = time.time()
    pending = [aid for aid in top_accounts if now - ages.get(aid, 0) >= _ACCOUNT_STALE_SECS]
    if not pending:
        return 0

    sem = asyncio.Semaphore(_POSITION_CONCURRENCY)
    scanned = 0

    async def _scan_one(account_index: int) -> None:
        nonlocal scanned
        async with sem:
            try:
                data = await client.account(by="index", value=str(account_index))
            except Exception:
                return
            await asyncio.sleep(0.05)
            if not data:
                return
            await upsert_account_snapshot(
                account_index=account_index,
                l1_address=data.get("l1_address", ""),
                ts=int(time.time()),
                collateral=_num(data.get("collateral")),
                total_asset_value=_num(data.get("total_asset_value")),
                payload=json.dumps(data),
            )
            scanned += 1

    await asyncio.gather(*(_scan_one(aid) for aid in pending))
    return scanned


async def ingest_loop() -> None:
    """Continuously runs off the FastAPI lifespan (VPS deploy only). Never raises."""
    global _last_trades_top, _last_trades_sweep, _last_positions_scan, _last_prune
    status["started_at"] = int(time.time())
    # Stagger the first tick so the top-market poll, the remaining-market sweep, and
    # the position scan don't all fire concurrently on startup (upstream WAF blocks bursts).
    now0 = time.time()
    _last_trades_sweep = now0
    _last_positions_scan = now0
    _last_prune = now0
    while True:
        try:
            now = time.time()
            if not _market_meta or now - _last_market_meta_refresh >= _MARKET_META_TTL:
                await _refresh_market_meta()

            top_ids = _top_market_ids(_TOP_N_TRADE_MARKETS)

            if now - _last_trades_top >= _TICK_SECS:
                _last_trades_top = now
                n = await _poll_trades(top_ids)
                status["trades_ingested"] += n

            if now - _last_trades_sweep >= _TRADES_SWEEP_SECS:
                _last_trades_sweep = now
                rest_ids = [mid for mid in _market_meta if mid not in top_ids]
                n = await _poll_trades(rest_ids)
                status["trades_ingested"] += n

            if now - _last_positions_scan >= _POSITIONS_SCAN_SECS:
                _last_positions_scan = now
                n = await _scan_positions()
                status["accounts_scanned"] += n

            if now - _last_prune >= _PRUNE_SECS:
                _last_prune = now
                await prune_all_trades(max_age_days=8)

            status["last_tick"] = int(time.time())
            status["last_error"] = None
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.error("traders ingest tick failed: %s", e)
            status["last_error"] = str(e)

        await asyncio.sleep(_TICK_SECS)


# ── /status ────────────────────────────────────────────────────────────

async def get_status() -> dict[str, Any]:
    db_stats = await fetch_all_trades_status()
    return {
        "last_tick": status.get("last_tick", 0),
        "trades_ingested": status.get("trades_ingested", 0),
        "accounts_scanned": status.get("accounts_scanned", 0),
        "last_error": status.get("last_error"),
        "all_trades_count": db_stats["all_trades_count"],
        "account_snapshots_count": db_stats["account_snapshots_count"],
        "data_since": db_stats["data_since"],
    }


# ── /leaderboard ─────────────────────────────────────────────────────

_WINDOW_HOURS = {"1h": 1, "24h": 24, "7d": 168}


async def get_leaderboard(window: str = "24h", limit: int = 50) -> dict[str, Any]:
    hours = _WINDOW_HOURS.get(window, 24)
    data = await fetch_leaderboard(hours=hours, limit=limit)
    return {
        "window": window,
        "updated_at": int(time.time()),
        "data_since": data["data_since"],
        "totals": data["totals"],
        "leaders": data["leaders"],
    }


# ── /positions ───────────────────────────────────────────────────────

async def get_positions(sort: str = "notional", limit: int = 50) -> dict[str, Any]:
    rows = await fetch_account_snapshots(limit=500)
    all_positions: list[dict[str, Any]] = []

    for row in rows:
        try:
            payload = json.loads(row["payload"])
        except (TypeError, json.JSONDecodeError):
            continue

        account_index = row["account_index"]
        collateral = _num(payload.get("collateral"))
        equity = _num(payload.get("total_asset_value")) or collateral
        raw_positions = [p for p in (payload.get("positions") or []) if _num(p.get("position")) != 0]
        total_notional = sum(abs(_num(p.get("position_value"))) for p in raw_positions)
        leverage_est = round(total_notional / collateral, 1) if collateral > 0 else None

        for p in raw_positions:
            market_id = int(p.get("market_id") or 0)
            sign = int(p.get("sign") or 0)
            entry = _num(p.get("avg_entry_price"))
            mark = _market_meta.get(market_id, {}).get("last_price") or entry or None
            liq_price = _num(p.get("liquidation_price"))
            liq_distance_pct = (
                abs(mark - liq_price) / mark * 100 if liq_price and mark else None
            )
            all_positions.append({
                "account_index": account_index,
                "symbol": p.get("symbol", ""),
                "market_id": market_id,
                "side": "long" if sign >= 0 else "short",
                "size": _num(p.get("position")),
                "notional_usd": abs(_num(p.get("position_value"))),
                "entry": entry,
                "mark": mark,
                "liq_price": liq_price if liq_price else None,
                "liq_distance_pct": liq_distance_pct,
                "unrealized_pnl": _num(p.get("unrealized_pnl")),
                "account_equity": equity,
                "leverage_est": leverage_est,
            })

    if sort == "liq":
        all_positions = [p for p in all_positions if p["liq_distance_pct"] is not None]
        all_positions.sort(key=lambda p: p["liq_distance_pct"])
    else:
        all_positions.sort(key=lambda p: p["notional_usd"], reverse=True)

    return {
        "updated_at": int(time.time()),
        "accounts_scanned": len(rows),
        "positions": all_positions[:limit],
    }


# ── /profile ─────────────────────────────────────────────────────────

async def get_profile(query: str) -> dict[str, Any] | None:
    by = "l1_address" if query.startswith("0x") else "index"
    data = await client.account(by=by, value=query)
    if not data:
        return None

    positions = [p for p in (data.get("positions") or []) if _num(p.get("position")) != 0]
    assets = [a for a in (data.get("assets") or []) if _num(a.get("balance")) > 0]

    long_notional = sum(
        abs(_num(p.get("position_value"))) for p in positions if int(p.get("sign") or 0) >= 0
    )
    short_notional = sum(
        abs(_num(p.get("position_value"))) for p in positions if int(p.get("sign") or 0) < 0
    )
    collateral = _num(data.get("collateral"))
    leverage_est = round((long_notional + short_notional) / collateral, 1) if collateral > 0 else None
    unrealized_pnl_total = sum(_num(p.get("unrealized_pnl")) for p in positions)

    sub_accounts: list[dict] = []
    if by == "l1_address":
        try:
            sub = await client.accounts_by_l1(query)
            sub_accounts = sub.get("sub_accounts") or []
        except Exception:
            sub_accounts = []

    return {
        "account_index": data.get("account_index") or data.get("index"),
        "l1_address": data.get("l1_address", ""),
        "collateral": collateral,
        "available_balance": _num(data.get("available_balance")),
        "total_asset_value": _num(data.get("total_asset_value")),
        "long_notional": long_notional,
        "short_notional": short_notional,
        "leverage_est": leverage_est,
        "unrealized_pnl_total": unrealized_pnl_total,
        "positions": positions,
        "assets": assets,
        "sub_accounts": sub_accounts,
    }


# ── /pnl ─────────────────────────────────────────────────────────────

_PNL_CACHE_TTL = 1800  # 30 min
_pnl_inflight: set[str] = set()


async def _resolve_account(query: str) -> tuple[int | None, str]:
    by = "l1_address" if query.startswith("0x") else "index"
    data = await client.account(by=by, value=query)
    if not data:
        return None, ""
    idx = data.get("account_index")
    if idx is None:
        idx = data.get("index")
    return idx, data.get("l1_address", "")


def _parse_fill(entry: dict, account_index: int) -> dict[str, Any] | None:
    """Mirror app/routes/explorer.py's _parse_log, but shaped for FIFO pnl reconstruction."""
    pubdata = entry.get("pubdata") or {}
    trade = pubdata.get("trade_pubdata") or pubdata.get("trade_pubdata_with_funding")
    if not trade:
        return None

    taker_idx = int(trade.get("taker_account_index") or 0)
    maker_idx = int(trade.get("maker_account_index") or 0)
    is_taker_ask = int(trade.get("is_taker_ask") or 0)

    if taker_idx == account_index:
        is_buyer = 0 if is_taker_ask else 1
    elif maker_idx == account_index:
        is_buyer = 1 if is_taker_ask else 0
    else:
        return None

    price = _num(trade.get("price"))
    size = _num(trade.get("size"))
    if price <= 0 or size <= 0:
        return None

    time_str = entry.get("time", "")
    try:
        ts_ms = int(datetime.fromisoformat(time_str.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, TypeError):
        ts_ms = 0

    return {
        "ts": ts_ms,
        "market_id": int(trade.get("market_index") or -1),
        "side": "buy" if is_buyer else "sell",
        "price": price,
        "size": size,
        "usd": price * size,
    }


async def _fetch_fills(l1_address: str, account_index: int, max_pages: int) -> tuple[list[dict], int, bool]:
    fills: list[dict] = []
    offset = 0
    complete = False
    pages = 0
    for _ in range(max_pages):
        logs = await client.account_logs(address=l1_address, limit=100, offset=offset)
        pages += 1
        if not logs:
            complete = True
            break
        for entry in logs:
            f = _parse_fill(entry, account_index)
            if f:
                fills.append(f)
        if len(logs) < 100:
            complete = True
            break
        offset += 100
        await asyncio.sleep(0.15)
    return fills, pages, complete


def _reconstruct_pnl(fills: list[dict]) -> dict[str, Any]:
    """FIFO per-market round-trip reconstruction. Sign-aware (handles shorts)."""
    fills_sorted = sorted(fills, key=lambda f: f["ts"])
    lots: dict[int, list[dict]] = {}
    closed: list[dict] = []
    pnl_timeseries: list[list[float]] = []
    volume_usd = 0.0
    long_pnl = 0.0
    short_pnl = 0.0
    cum = 0.0

    for f in fills_sorted:
        mkt = f["market_id"]
        side = f["side"]
        price = f["price"]
        remaining = f["size"]
        volume_usd += f["usd"]
        market_lots = lots.setdefault(mkt, [])
        opp_side = "sell" if side == "buy" else "buy"

        while remaining > 1e-9 and market_lots and market_lots[0]["side"] == opp_side:
            lot = market_lots[0]
            matched = min(lot["size"], remaining)
            if opp_side == "sell":
                # existing lot is a short (opened by selling); closing it by buying back
                pnl = (lot["price"] - price) * matched
                trip_side = "short"
            else:
                # existing lot is a long (opened by buying); closing it by selling
                pnl = (price - lot["price"]) * matched
                trip_side = "long"
            cum += pnl
            if trip_side == "long":
                long_pnl += pnl
            else:
                short_pnl += pnl
            closed.append({
                "symbol": _market_meta.get(mkt, {}).get("symbol", f"MKT-{mkt}"),
                "side": trip_side,
                "entry": lot["price"],
                "exit": price,
                "size": matched,
                "pnl": pnl,
                "closed_ts": f["ts"],
            })
            pnl_timeseries.append([f["ts"], round(cum, 6)])
            lot["size"] -= matched
            remaining -= matched
            if lot["size"] <= 1e-9:
                market_lots.pop(0)

        if remaining > 1e-9:
            market_lots.append({"side": side, "size": remaining, "price": price})

    wins = sum(1 for c in closed if c["pnl"] > 0)
    losses = sum(1 for c in closed if c["pnl"] < 0)

    best_streak = worst_streak = cur_win = cur_loss = 0
    for c in closed:
        if c["pnl"] > 0:
            cur_win += 1
            cur_loss = 0
            best_streak = max(best_streak, cur_win)
        elif c["pnl"] < 0:
            cur_loss += 1
            cur_win = 0
            worst_streak = max(worst_streak, cur_loss)
        else:
            cur_win = cur_loss = 0

    win_rate = wins / (wins + losses) if (wins + losses) > 0 else None

    return {
        "realized_pnl_est": round(cum, 2),
        "volume_usd": round(volume_usd, 2),
        "win_rate": round(win_rate, 4) if win_rate is not None else None,
        "wins": wins,
        "losses": losses,
        "best_streak": best_streak,
        "worst_streak": worst_streak,
        "long_pnl": round(long_pnl, 2),
        "short_pnl": round(short_pnl, 2),
        "pnl_timeseries": pnl_timeseries,
        "recent_closed": list(reversed(closed[-20:])),
    }


def _pnl_skeleton(status_label: str = "building") -> dict[str, Any]:
    return {
        "status": status_label,
        "coverage": {"fills": 0, "pages": 0, "since_ts": 0, "complete": False},
        "realized_pnl_est": None, "volume_usd": None, "win_rate": None,
        "wins": 0, "losses": 0, "best_streak": 0, "worst_streak": 0,
        "long_pnl": None, "short_pnl": None,
        "pnl_timeseries": [], "recent_closed": [],
    }


async def _compute_pnl(key: str, l1_address: str, account_index: int, max_pages: int) -> None:
    try:
        fills, pages, complete = await _fetch_fills(l1_address, account_index, max_pages)
        result = _reconstruct_pnl(fills)
        since_ts = min((f["ts"] for f in fills), default=0)
        result["status"] = "ready"
        result["coverage"] = {
            "fills": len(fills), "pages": pages, "since_ts": since_ts, "complete": complete,
        }
        await upsert_pnl_cache(key, int(time.time()), json.dumps(result))
    except Exception as e:  # noqa: BLE001
        log.error("pnl compute failed for %s: %s", key, e)
    finally:
        _pnl_inflight.discard(key)


async def get_pnl(query: str, max_pages: int = 30, refresh: bool = False) -> dict[str, Any] | None:
    # A numeric query IS the account_index — check the cache before paying for an
    # upstream /account round-trip. A transient 429/blip on that unrelated resolve
    # call must never invalidate an already-cached ready result.
    fast_key = query if query.isdigit() else None
    if fast_key and not refresh:
        cached = await fetch_pnl_cache(fast_key)
        if cached and time.time() - cached["ts"] < _PNL_CACHE_TTL:
            return json.loads(cached["payload"])
    if fast_key and fast_key in _pnl_inflight:
        return _pnl_skeleton()

    account_index, l1_address = await _resolve_account(query)
    if account_index is None:
        return None
    key = str(account_index)

    if not refresh:
        cached = await fetch_pnl_cache(key)
        if cached and time.time() - cached["ts"] < _PNL_CACHE_TTL:
            return json.loads(cached["payload"])
    if key in _pnl_inflight:
        return _pnl_skeleton()

    if not l1_address:
        # No L1 address on file — nothing to reconstruct from the explorer logs.
        empty = _pnl_skeleton("ready")
        empty["coverage"]["complete"] = True
        return empty

    _pnl_inflight.add(key)
    asyncio.create_task(_compute_pnl(key, l1_address, account_index, max_pages))
    return _pnl_skeleton()
