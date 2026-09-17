"""LIT fundamentals: price history, supply, and protocol revenue.

The cockpit could show what LIT traded at in the last few hours, but nothing
about why. Price history came only from the local trade ledger (sparse, days
old at best), there was no circulating-supply or FDV figure anywhere, and no
protocol revenue series at all — so the obvious question about any token move,
"is the business growing?", had no answer on the page.

IMPORTANT — fees are the WRONG fundamental for Lighter. All 246 markets charge
taker_fee 0.0000 and maker_fee 0.0000 (verified via /orderBooks), so trading
generates no fee revenue by design and a price-to-fees multiple is meaningless.
DefiLlama's Lighter series is also unreliable for daily figures: it reports
~$23M/day against $1.73B/day from Lighter's own exchangeStats, a 75x gap, while
its cumulative total does match the protocol's own $10B milestone. Volume, taken
from Lighter directly, is the metric that reflects the business.

Two external sources, both free and keyless:
  - DefiLlama  coins.llama.fi/chart/...  — daily close, full history
  - DefiLlama  /summary/fees/lighter     — daily protocol fees

Price comes from DefiLlama rather than CoinGecko directly: CoinGecko's keyless
endpoint returned an empty price series from the server (0 of 340 days) while
DefiLlama served the identical prices without a key.

Cached in SQLite because both are slow and rate-limited, and neither changes
more than once a day.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

from app.db import (
    fetch_fundamentals_series,
    upsert_volume,
    fetch_meta,
    upsert_fundamentals,
    upsert_meta,
)

log = logging.getLogger("lighter.fundamentals")

COINGECKO = "https://api.coingecko.com/api/v3"
DEFILLAMA = "https://api.llama.fi"
LLAMA_COINS = "https://coins.llama.fi"
COIN_ID = "lighter"

# Both sources publish once a day; refreshing more often just burns rate limit.
_REFRESH_SECS = 6 * 3600
_HEADERS = {"User-Agent": "lighter-cockpit/0.1", "Accept": "application/json"}


async def _get(url: str, params: dict | None = None) -> Any:
    async with httpx.AsyncClient(timeout=30.0, headers=_HEADERS) as c:
        r = await c.get(url, params=params)
        r.raise_for_status()
        return r.json()


async def refresh(force: bool = False) -> dict[str, Any]:
    """Pull price + fees + supply, merge by UTC date, store."""
    last = float(await fetch_meta("fundamentals_refreshed_at") or 0)
    if not force and time.time() - last < _REFRESH_SECS:
        return {"refreshed": False, "reason": "cached"}

    by_day: dict[str, dict[str, Any]] = {}

    try:
        # DefiLlama caps a chart request at 500 data points and 400s a larger
        # span outright, so this asks for exactly the maximum.
        span = 500
        start = int(time.time()) - span * 86400
        chart = await _get(
            f"{LLAMA_COINS}/chart/coingecko:{COIN_ID}",
            {"start": start, "span": span, "period": "1d"},
        )
        series = next(iter((chart.get("coins") or {}).values()), {})
        for pt in series.get("prices") or []:
            day = time.strftime("%Y-%m-%d", time.gmtime(pt["timestamp"]))
            by_day.setdefault(day, {})["price"] = pt["price"]
    except Exception as e:
        log.warning("price history failed: %s", e)

    try:
        fees = await _get(f"{DEFILLAMA}/summary/fees/{COIN_ID}",
                          {"dataType": "dailyFees"})
        for ts, usd in fees.get("totalDataChart") or []:
            day = time.strftime("%Y-%m-%d", time.gmtime(ts))
            by_day.setdefault(day, {})["fees_usd"] = usd
    except Exception as e:
        log.warning("defillama fees failed: %s", e)

    if not by_day:
        return {"refreshed": False, "reason": "both sources unavailable"}

    rows = [
        (day, v.get("price"), v.get("fees_usd"))
        for day, v in sorted(by_day.items())
    ]
    await upsert_fundamentals(rows)

    # Supply figures: the page had no circulating/FDV anywhere, which is what
    # makes a market cap interpretable.
    try:
        info = await _get(
            f"{COINGECKO}/coins/{COIN_ID}",
            {"localization": "false", "tickers": "false", "market_data": "true",
             "community_data": "false", "developer_data": "false"},
        )
        md = info.get("market_data") or {}
        await upsert_meta("lit_supply", json.dumps({
            "circulating": md.get("circulating_supply"),
            "total": md.get("total_supply"),
            "market_cap": (md.get("market_cap") or {}).get("usd"),
            "fdv": (md.get("fully_diluted_valuation") or {}).get("usd"),
            "ath": (md.get("ath") or {}).get("usd"),
            "ath_date": (md.get("ath_date") or {}).get("usd"),
        }))
    except Exception as e:
        log.warning("coingecko supply failed: %s", e)

    # Volume from Lighter itself. There is no historical endpoint, so today's
    # figure is snapshotted daily and the series builds forward from here —
    # honest, and better than importing a number that is 75x wrong.
    try:
        stats = await _get("https://mainnet.zklighter.elliot.ai/api/v1/exchangeStats")
        books = stats.get("order_book_stats") or []
        vol = sum(float(b.get("daily_quote_token_volume") or 0) for b in books)
        trades = sum(int(b.get("daily_trades_count") or 0) for b in books)
        if vol > 0:
            today = time.strftime("%Y-%m-%d", time.gmtime())
            await upsert_volume(today, vol, trades, len(books))
    except Exception as e:
        log.warning("lighter volume snapshot failed: %s", e)

    await upsert_meta("fundamentals_refreshed_at", str(time.time()))
    return {"refreshed": True, "days": len(rows)}


async def get_fundamentals(days: int = 365) -> dict[str, Any]:
    """Price and protocol fees on one timeline, plus supply."""
    await refresh()
    series = await fetch_fundamentals_series(days=days)
    supply = json.loads(await fetch_meta("lit_supply") or "{}")

    priced = [r for r in series if r["price"] is not None]
    fees = [r for r in series if r["fees_usd"] is not None]

    def _window(rows: list[dict], key: str, n: int) -> float | None:
        vals = [r[key] for r in rows[-n:] if r[key] is not None]
        return sum(vals) / len(vals) if vals else None

    # The headline comparison: price direction against revenue direction. A
    # token can rally while the business it is attached to shrinks, and that
    # divergence is the thing worth seeing.
    price_now = priced[-1]["price"] if priced else None
    price_lo = min((r["price"] for r in priced), default=None)
    fees_30 = _window(fees, "fees_usd", 30)
    fees_peak30 = None
    if len(fees) >= 30:
        windows = [
            sum(x["fees_usd"] for x in fees[i:i + 30]) / 30
            for i in range(0, len(fees) - 30)
            if all(x["fees_usd"] is not None for x in fees[i:i + 30])
        ]
        fees_peak30 = max(windows) if windows else None

    annualised = fees_30 * 365 if fees_30 else None
    vols = [r for r in series if r.get("volume_usd")]
    latest_vol = vols[-1]["volume_usd"] if vols else None
    return {
        "series": series,
        "supply": supply,
        "summary": {
            "price": price_now,
            "price_low": price_lo,
            "gain_from_low_pct": ((price_now / price_lo - 1) * 100)
                                 if price_now and price_lo else None,
            "fees_30d_avg": fees_30,
            "fees_peak_30d_avg": fees_peak30,
            "fees_vs_peak_pct": (fees_30 / fees_peak30 * 100)
                                if fees_30 and fees_peak30 else None,
            "annualised_fees": annualised,
            "volume_24h": latest_vol,
            "volume_days": len(vols),
            "markets": vols[-1].get("markets") if vols else None,
            "trades_24h": vols[-1].get("trades") if vols else None,
            # Every market is zero-fee, so a fee multiple describes nothing.
            "zero_fee_exchange": True,
            # Price-to-fees on both market cap and FDV: with a low float these
            # differ by 4x and only quoting one of them flatters the token.
            "mcap_to_fees": (supply.get("market_cap") / annualised)
                            if annualised and supply.get("market_cap") else None,
            "fdv_to_fees": (supply.get("fdv") / annualised)
                           if annualised and supply.get("fdv") else None,
        },
    }
