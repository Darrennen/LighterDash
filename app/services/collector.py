"""Background collector task.

Every COLLECT_INTERVAL seconds:
  1. Pull /orderBooks, /exchangeStats, /funding-rates, /recentTrades.
  2. Normalise into a uniform market dict + trade dict.
  3. Update the in-memory store.
  4. Persist a funding + OI history row per market to SQLite.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from app.config import settings
from app.db import prune_old, write_history, write_lit_trades
from app.services.lighter_client import client
from app.services.store import store

LIT_MARKET_IDS = (120, 2049)  # LIT perp + LIT/USDC spot

log = logging.getLogger("lighter.collector")


# ─── normalisation helpers ────────────────────────────────────────────
def _num(x: Any, default: float = 0.0) -> float:
    try:
        return float(x) if x is not None else default
    except (TypeError, ValueError):
        return default


def _normalise_markets(
    books: list[dict], stats: list[dict], fundings: list[dict]
) -> list[dict[str, Any]]:
    # exchangeStats has no market_id — join by symbol
    stat_by_symbol: dict[str, dict] = {
        s["symbol"]: s for s in stats if s.get("symbol")
    }

    fund_by_id: dict[int, float] = {}
    for f in fundings:
        mid = f.get("market_id", f.get("marketId"))
        rate = f.get("rate", f.get("funding_rate"))
        if mid is not None and rate is not None:
            fund_by_id[int(mid)] = _num(rate)

    out: list[dict[str, Any]] = []
    for b in books:
        mid_raw = b.get("market_id", b.get("marketId"))
        if mid_raw is None:
            continue
        mid = int(mid_raw)
        symbol = b.get("symbol") or f"MKT-{mid}"
        s = stat_by_symbol.get(symbol, {})
        last = _num(s.get("last_trade_price") or b.get("last_trade_price"))
        out.append(
            {
                "market_id": mid,
                "symbol": symbol,
                "status": b.get("status"),
                "last_price": last,
                "price_high_24h": _num(s.get("daily_price_high")),
                "price_low_24h": _num(s.get("daily_price_low")),
                "price_change": _num(s.get("daily_price_change")),
                "volume_24h": _num(s.get("daily_quote_token_volume")),
                "base_volume_24h": _num(s.get("daily_base_token_volume")),
                "trades_24h": int(_num(s.get("daily_trades_count"))),
                "oi_base": 0.0,
                "oi_usd": 0.0,
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
        "is_liq": bool(raw.get("is_liquidation") or raw.get("liquidation")),
    }


# ─── main loop ───────────────────────────────────────────────────────
async def collect_once() -> dict[str, Any]:
    books, stats, fundings = await asyncio.gather(
        client.order_books(),
        client.exchange_stats(),
        client.funding_rates(),
    )
    markets = _normalise_markets(books, stats, fundings)
    store.set_markets(markets)

    # Top N by volume → pull trades concurrently
    top = sorted(markets, key=lambda m: m["volume_24h"], reverse=True)[
        : settings.TOP_N_MARKETS
    ]
    trade_results = await asyncio.gather(
        *(client.recent_trades(m["market_id"], settings.RECENT_TRADES_LIMIT) for m in top),
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
            price = _num(raw.get("price"))
            size = _num(raw.get("size"))
            trade_id = raw.get("trade_id")
            if price <= 0 or size <= 0 or not trade_id:
                continue
            is_maker_ask = raw.get("is_maker_ask")
            taker_is_buyer = bool(is_maker_ask) if isinstance(is_maker_ask, bool) else True
            ts_raw = raw.get("timestamp", 0)
            ts_ms = int(float(ts_raw)) if ts_raw else int(time.time() * 1000)
            trades.append({
                "trade_id": int(trade_id),
                "market_id": market_id,
                "ts": ts_ms,
                "price": price,
                "size": size,
                "usd": price * size,
                "buyer_id": int(raw.get("bid_account_id") or 0),
                "seller_id": int(raw.get("ask_account_id") or 0),
                "taker_is_buyer": 1 if taker_is_buyer else 0,
            })
    return await write_lit_trades(trades) if trades else 0


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
