"""Persistent WebSocket ingestion for the LIT trade ledger.

Replaces the request-driven `collect_lit_once()` sampler, which had two defects
measured live on 2026-09-15:

1. It only ran when an HTTP request arrived (`_maybe_refresh`, 5s TTL), so the
   ledger stopped filling whenever nobody had the page open — a 98.8h hole
   opened between Sep 11 and Sep 15 and rendered as `$0`, not as an outage.
2. Even while warm, `recentTrades` polling captured ~78% of prints but only
   ~32% of notional: it misses large fills that land between polls.

The `trade/{market_id}` stream delivers every fill as it happens (measured ~96%
of prints / ~82% of perp notional against the exchange's own 24h counters),
carries the exchange's `usd_amount`, and tags liquidations via `type`.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Any

import websockets

from app.db import write_lit_trades

log = logging.getLogger("lighter.ws")

WS_URL = "wss://mainnet.zklighter.elliot.ai/stream"
LIT_MARKETS = (120, 2049)

# Flush cadence: batch writes so a busy tape doesn't mean one SQLite commit per
# message, while a quiet tape still lands within a few seconds.
_FLUSH_SECONDS = 3.0
_FLUSH_COUNT = 200

# Health, read by /api/lit/coverage. The page's status light is derived from
# this plus ledger age — never from "the last HTTP call returned 200".
state: dict[str, Any] = {
    "connected": False,
    "connected_since": None,
    "last_msg_ts": None,
    "last_trade_ts": None,
    "trades_written": 0,
    "trades_seen": 0,
    "unknown_side": 0,
    "reconnects": 0,
    "last_error": None,
}


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _norm_ws_trade(raw: dict) -> dict[str, Any] | None:
    """Normalise one stream trade. Returns None only for structurally unusable rows."""
    trade_id = raw.get("trade_id")
    price = _num(raw.get("price"))
    size = _num(raw.get("size"))
    if not trade_id or price <= 0 or size <= 0:
        return None

    market_id = raw.get("market_id")
    if market_id is None:
        return None

    # Spot (2049) reports usd_amount as 0 — verified live — so fall back to
    # price*size rather than recording a real trade as zero volume.
    usd = _num(raw.get("usd_amount")) or (price * size)

    # is_maker_ask is a real bool on every streamed trade (183/183 observed).
    # If it is ever absent, the side is UNKNOWN (2) — never silently "buy",
    # which is what the old REST normaliser did with `else True`.
    mk = raw.get("is_maker_ask")
    taker_is_buyer = (1 if mk else 0) if isinstance(mk, bool) else 2

    ts = raw.get("timestamp")
    return {
        "trade_id": int(trade_id),
        "market_id": int(market_id),
        "ts": int(ts) if ts else int(time.time() * 1000),
        "price": price,
        "size": size,
        "usd": usd,
        "buyer_id": int(raw.get("bid_account_id") or 0),
        "seller_id": int(raw.get("ask_account_id") or 0),
        "taker_is_buyer": taker_is_buyer,
        # "trade" | "liquidation" | "deleverage" | "market-settlement"
        "trade_type": str(raw.get("type") or "trade"),
    }


async def _flush(buf: list[dict[str, Any]]) -> None:
    if not buf:
        return
    try:
        written = await write_lit_trades(buf)
        state["trades_written"] += written
    except Exception as e:
        log.warning("flush failed (%d trades dropped): %s", len(buf), e)
    finally:
        buf.clear()


async def _session() -> None:
    """One connection: subscribe, drain, batch-write until it drops."""
    async with websockets.connect(WS_URL, ping_interval=20, max_size=8_000_000) as ws:
        await ws.recv()  # server hello
        for mid in LIT_MARKETS:
            await ws.send(json.dumps({"type": "subscribe", "channel": f"trade/{mid}"}))

        state.update(connected=True, connected_since=time.time(), last_error=None)
        log.info("LIT trade stream connected: markets %s", list(LIT_MARKETS))

        buf: list[dict[str, Any]] = []
        last_flush = time.monotonic()
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=_FLUSH_SECONDS)
                    state["last_msg_ts"] = time.time()
                    data = json.loads(msg)
                    # Subscription snapshots carry `trades` too — keep them:
                    # INSERT OR IGNORE dedupes, and they heal a short gap after
                    # a reconnect at no cost.
                    if str(data.get("channel", "")).startswith("trade"):
                        for raw in data.get("trades") or []:
                            state["trades_seen"] += 1
                            t = _norm_ws_trade(raw)
                            if t is None:
                                continue
                            if t["taker_is_buyer"] == 2:
                                state["unknown_side"] += 1
                            state["last_trade_ts"] = t["ts"]
                            buf.append(t)
                except asyncio.TimeoutError:
                    pass  # quiet tape — fall through and flush

                if buf and (
                    len(buf) >= _FLUSH_COUNT
                    or time.monotonic() - last_flush >= _FLUSH_SECONDS
                ):
                    await _flush(buf)
                    last_flush = time.monotonic()
        finally:
            await _flush(buf)


async def run_lit_stream() -> None:
    """Reconnect forever with capped exponential backoff."""
    backoff = 1.0
    while True:
        try:
            await _session()
            backoff = 1.0  # clean close — treat the next attempt as fresh
        except asyncio.CancelledError:
            raise
        except Exception as e:
            state["last_error"] = f"{type(e).__name__}: {e}"
            log.warning("LIT stream dropped (%s) — retry in %.0fs", e, backoff)
        finally:
            state["connected"] = False
            state["connected_since"] = None
        state["reconnects"] += 1
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60.0)


def health() -> dict[str, Any]:
    now = time.time()
    last_msg = state["last_msg_ts"]
    return {
        **state,
        "msg_age_seconds": round(now - last_msg, 1) if last_msg else None,
        "uptime_seconds": (
            round(now - state["connected_since"]) if state["connected_since"] else 0
        ),
    }
