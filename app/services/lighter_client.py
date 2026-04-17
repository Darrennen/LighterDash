"""Async HTTP client that wraps the upstream Lighter REST API with normalisation.

All payload-shape defences live here so the rest of the app can assume a stable schema.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import settings

log = logging.getLogger("lighter.client")


class LighterClient:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=settings.LIGHTER_API,
                timeout=settings.HTTP_TIMEOUT,
                headers={"Accept": "application/json", "User-Agent": "lighter-cockpit/0.1"},
            )
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        client = await self._get_client()
        r = await client.get(path, params=params)
        r.raise_for_status()
        return r.json()

    # ─── normalised endpoints ──────────────────────────────────────────
    async def order_books(self) -> list[dict]:
        j = await self._get("/orderBooks")
        return j.get("order_books") or j.get("orderBooks") or j.get("data") or []

    async def exchange_stats(self) -> list[dict]:
        j = await self._get("/exchangeStats")
        return (
            j.get("order_book_stats")
            or j.get("exchange_stats")
            or j.get("data")
            or []
        )

    async def funding_rates(self) -> list[dict]:
        try:
            j = await self._get("/funding-rates")
        except httpx.HTTPError:
            return []
        return j.get("funding_rates") or j.get("fundingRates") or j.get("data") or []

    async def recent_trades(self, market_id: int, limit: int = 50) -> list[dict]:
        try:
            j = await self._get(
                "/recentTrades", params={"market_id": market_id, "limit": limit}
            )
        except httpx.HTTPError as e:
            log.debug("recentTrades(%s) failed: %s", market_id, e)
            return []
        return j.get("trades") or j.get("recent_trades") or j.get("data") or []

    async def candles(
        self, market_id: int, resolution: str = "1h", count: int = 24
    ) -> list[dict]:
        try:
            j = await self._get(
                "/candles",
                params={
                    "market_id": market_id,
                    "resolution": resolution,
                    "count_back": count,
                },
            )
        except httpx.HTTPError:
            return []
        return j.get("candlesticks") or j.get("candles") or j.get("data") or []


# Module-level singleton for app usage
client = LighterClient()
