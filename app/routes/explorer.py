"""Lighter account explorer endpoint."""
from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, HTTPException, Query, Request

from app.services.lighter_client import client, UpstreamUnavailable
from app.services.ratelimit import explorer_limiter

_ETH_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

router = APIRouter()

_LIT_MARKETS = {120, 2049}


def _parse_log(entry: dict, account_index: int) -> dict | None:
    """Normalise a raw explorer log entry into a flat trade dict."""
    pubdata = entry.get("pubdata") or {}
    trade = pubdata.get("trade_pubdata") or pubdata.get("trade_pubdata_with_funding")
    if not trade:
        return None
    mkt = trade.get("market_index")
    taker_idx = int(trade.get("taker_account_index") or 0)
    maker_idx  = int(trade.get("maker_account_index") or 0)
    is_taker_ask = int(trade.get("is_taker_ask") or 0)

    # Determine this account's side
    if taker_idx == account_index:
        # account is taker: taker_ask=1 means sold, taker_ask=0 means bought
        taker_is_buyer = 0 if is_taker_ask else 1
        role = "taker"
    elif maker_idx == account_index:
        # account is maker (passive): opposite of taker
        taker_is_buyer = 1 if is_taker_ask else 0
        role = "maker"
    else:
        return None

    return {
        "hash": entry.get("hash", ""),
        "time": entry.get("time", ""),
        "market_id": mkt,
        "price": trade.get("price"),
        "size": trade.get("size"),
        "taker_is_buyer": taker_is_buyer,
        "taker_account_index": taker_idx,
        "maker_account_index": maker_idx,
        "role": role,
    }

# System-reserved pool index for the LIT staking pool
_LIT_STAKING_POOL = 281_474_976_710_654


@router.get("/history")
async def account_history(
    request: Request,
    address: str = Query(..., description="0x wallet address"),
    account_index: int = Query(..., description="Numeric account index"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    market_id: int | None = None,
):
    client_ip = request.client.host if request.client else "unknown"
    if not explorer_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=429, detail="Too many requests — please slow down")
    if not _ETH_ADDR_RE.match(address):
        raise HTTPException(status_code=400, detail="Invalid Ethereum address format")
    """Full trade history from explorer.elliot.ai (months of data, no auth)."""
    logs = await client.account_logs(address=address, limit=limit, offset=offset)
    trades = []
    for entry in logs:
        t = _parse_log(entry, account_index)
        if t is None:
            continue
        if market_id is not None and t["market_id"] != market_id:
            continue
        trades.append(t)
    return {"trades": trades, "count": len(trades), "offset": offset, "limit": limit}


@router.get("/account")
async def account_lookup(
    request: Request,
    query: str = Query(..., description="Account # or 0x wallet address"),
):
    client_ip = request.client.host if request.client else "unknown"
    if not explorer_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=429, detail="Too many requests — please slow down")

    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")

    if query.startswith("0x"):
        if not _ETH_ADDR_RE.match(query):
            raise HTTPException(status_code=400, detail="Invalid Ethereum address format (expected 0x + 40 hex chars)")
        by = "l1_address"
    else:
        if not query.isdigit():
            raise HTTPException(status_code=400, detail="Account index must be a number")
        by = "index"

    try:
        data = await client.account(by=by, value=query)
    except UpstreamUnavailable:
        raise HTTPException(
            status_code=503,
            detail="Lighter's account API is rate-limited right now — wait a minute and try again",
        )

    if not data:
        raise HTTPException(status_code=404, detail="account not found")

    # filter positions to only those with a non-zero position
    positions = [
        p for p in (data.get("positions") or [])
        if float(p.get("position") or 0) != 0
    ]
    # filter assets to non-zero balances
    assets = [
        a for a in (data.get("assets") or [])
        if float(a.get("balance") or 0) > 0
    ]

    # LIT spot: free (unstaked) balance
    lit_asset = next((a for a in (data.get("assets") or []) if a.get("symbol") == "LIT"), None)
    lit_free = float(lit_asset["balance"]) if lit_asset else 0.0

    # LIT staking: look for shares in the known staking pool
    staking_share = next(
        (s for s in (data.get("shares") or []) if s.get("public_pool_index") == _LIT_STAKING_POOL),
        None,
    )
    lit_staking = {
        "is_staking": staking_share is not None,
        "staked_usdc_value": float(staking_share["principal_amount"]) if staking_share else 0.0,
        "shares_amount": staking_share["shares_amount"] if staking_share else 0,
        "entry_usdc": float(staking_share.get("entry_usdc") or 0) if staking_share else 0.0,
        "pending_unlocks": data.get("pending_unlocks") or [],
        "lit_free_balance": lit_free,
    }

    return {
        "account_index": data.get("account_index") or data.get("index"),
        "l1_address": data.get("l1_address", ""),
        "collateral": data.get("collateral", "0"),
        "available_balance": data.get("available_balance", "0"),
        "total_asset_value": data.get("total_asset_value", "0"),
        "cross_asset_value": data.get("cross_asset_value", "0"),
        "status": data.get("status", 0),
        "pending_order_count": data.get("pending_order_count", 0),
        "total_order_count": data.get("total_order_count", 0),
        "name": data.get("name", ""),
        "positions": positions,
        "assets": assets,
        "lit_staking": lit_staking,
    }


# ── counterparty profile ──────────────────────────────────────────────
# Two public signals the page never showed: how the account signs its
# transactions, and where the exchange itself ranks its PnL.

# A nonce this close to its own last-transaction clock is a millisecond
# timestamp, not a counter — some clients set it that way to avoid nonce
# collisions across parallel workers. Summing those as "transactions" is
# meaningless, so they must be detected before any count is reported.
_TS_NONCE_DRIFT_SECS = 600


def _classify_keys(keys: list[dict]) -> dict:
    """Fingerprint an account's signing setup from its API keys.

    Measured on live accounts 2026-09-15: a retail account runs 1 key with a
    small counter nonce; a market maker runs 200+ keys firing within the same
    second (726722 had 254 of the 255 available slots in use).
    """
    active = [k for k in keys if (k.get("nonce") or 0) > 0]
    if not active:
        return {"label": "unused", "active_keys": 0, "total_keys": len(keys),
                "counter_tx": 0, "timestamp_keys": 0, "last_active_ts": None,
                "oldest_key_last_tx": None, "keys": []}

    detail, counter_tx, ts_keys = [], 0, 0
    for k in active:
        nonce = k.get("nonce") or 0
        tx_us = k.get("transaction_time") or 0
        is_ts = tx_us > 0 and abs(nonce / 1000 - tx_us / 1e6) < _TS_NONCE_DRIFT_SECS
        if is_ts:
            ts_keys += 1
        else:
            counter_tx += nonce
        detail.append({
            "index": k.get("api_key_index"),
            "nonce": nonce,
            "nonce_kind": "timestamp" if is_ts else "counter",
            # transaction_time is microseconds; the rest of the app uses ms
            "last_tx_ms": int(tx_us / 1000) if tx_us else None,
        })

    times = [d["last_tx_ms"] for d in detail if d["last_tx_ms"]]
    max_counter = max((d["nonce"] for d in detail if d["nonce_kind"] == "counter"), default=0)

    if len(active) >= 50:
        label = "market maker"        # parallel signer fleet
    elif len(active) >= 2 or ts_keys or max_counter >= 10_000:
        label = "algo"
    else:
        label = "manual"

    detail.sort(key=lambda d: d["last_tx_ms"] or 0, reverse=True)
    return {
        "label": label,
        "active_keys": len(active),
        "total_keys": len(keys),
        "counter_tx": counter_tx,        # only counter-style keys, never timestamps
        "timestamp_keys": ts_keys,
        "last_active_ts": max(times) if times else None,
        # The OLDEST key's most recent transaction — a floor on how long the
        # account has been operating, NOT the date it started.
        "oldest_key_last_tx": min(times) if times else None,
        "keys": detail[:8],
    }


@router.get("/profile")
async def account_profile(
    request: Request,
    account_index: int = Query(..., ge=0),
    address: str = Query("", description="L1 address, for the PnL rank lookup"),
):
    """Signing fingerprint + exchange-reported PnL rank for one account."""
    client_ip = request.client.host if request.client else "unknown"
    if not explorer_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=429, detail="Too many requests — please slow down")
    if address and not _ETH_ADDR_RE.match(address):
        raise HTTPException(status_code=400, detail="Invalid Ethereum address format")

    keys, board = await asyncio.gather(
        client.api_keys(account_index),
        client.pnl_leaderboard(search=address, limit=1) if address else _empty(),
        return_exceptions=True,
    )
    if isinstance(keys, Exception):
        keys = []
    if isinstance(board, Exception):
        board = {}

    entry = (board.get("entries") or [{}])[0] if board else {}
    total = board.get("total") if board else None
    rank = entry.get("rank")
    return {
        "account_index": account_index,
        "signing": _classify_keys(keys),
        "leaderboard": {
            "rank": rank,
            "total": total,
            # Where they sit in the whole field — a rank with no denominator
            # says nothing.
            "percentile": round((1 - rank / total) * 100, 2) if rank and total else None,
            "pnl": entry.get("pnl"),
            "roi": entry.get("roi"),
            "volume": entry.get("volume"),
            "account_value": entry.get("account_value"),
        } if entry else None,
    }


async def _empty() -> dict:
    return {}
