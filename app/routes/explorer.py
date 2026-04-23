"""Lighter account explorer endpoint."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from app.services.lighter_client import client

router = APIRouter()


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
    }
