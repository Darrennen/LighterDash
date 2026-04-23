"""Lighter account explorer endpoint."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.services.lighter_client import client

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
    address: str = Query(..., description="0x wallet address"),
    account_index: int = Query(..., description="Numeric account index"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    market_id: int | None = None,
):
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
async def account_lookup(query: str = Query(..., description="Account # or 0x wallet address")):
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")

    by = "l1_address" if query.startswith("0x") else "index"
    data = await client.account(by=by, value=query)

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
