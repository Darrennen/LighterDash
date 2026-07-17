"""Traders analytics endpoints — leaderboard, open positions, profile, pnl reconstruction."""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Query, Request

from app.services import traders_service
from app.services.ratelimit import traders_pnl_limiter

router = APIRouter()

_ETH_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _validate_query(query: str) -> str:
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    if query.startswith("0x"):
        if not _ETH_ADDR_RE.match(query):
            raise HTTPException(status_code=400, detail="Invalid Ethereum address format")
    elif not query.isdigit():
        raise HTTPException(status_code=400, detail="Account index must be a number")
    return query


@router.get("/status")
async def status():
    return await traders_service.get_status()


@router.get("/leaderboard")
async def leaderboard(
    window: str = Query("24h", pattern="^(1h|24h|7d)$"),
    limit: int = Query(50, ge=1, le=200),
):
    return await traders_service.get_leaderboard(window=window, limit=limit)


@router.get("/positions")
async def positions(
    sort: str = Query("notional", pattern="^(notional|liq)$"),
    limit: int = Query(50, ge=1, le=200),
):
    return await traders_service.get_positions(sort=sort, limit=limit)


@router.get("/profile")
async def profile(query: str = Query(..., description="Account # or 0x wallet address")):
    query = _validate_query(query)
    data = await traders_service.get_profile(query)
    if data is None:
        raise HTTPException(status_code=404, detail="account not found")
    return data


@router.get("/pnl")
async def pnl(
    request: Request,
    query: str = Query(..., description="Account # or 0x wallet address"),
    max_pages: int = Query(30, ge=1, le=60),
    refresh: int = Query(0, ge=0, le=1),
):
    query = _validate_query(query)
    client_ip = request.client.host if request.client else "unknown"
    if not traders_pnl_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=429, detail="Too many requests — please slow down")
    data = await traders_service.get_pnl(query, max_pages=max_pages, refresh=bool(refresh))
    if data is None:
        raise HTTPException(status_code=404, detail="account not found")
    return data
