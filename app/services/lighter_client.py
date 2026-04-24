"""Async HTTP client that wraps the upstream Lighter REST API with normalisation.

All payload-shape defences live here so the rest of the app can assume a stable schema.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx
import websockets

from app.config import settings

log = logging.getLogger("lighter.client")


EXPLORER_API = "https://explorer.elliot.ai/api"


class LighterClient:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._explorer: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=settings.LIGHTER_API,
                timeout=settings.HTTP_TIMEOUT,
                headers={"Accept": "application/json", "User-Agent": "lighter-cockpit/0.1"},
            )
        return self._client

    async def _get_explorer(self) -> httpx.AsyncClient:
        if self._explorer is None or self._explorer.is_closed:
            self._explorer = httpx.AsyncClient(
                base_url=EXPLORER_API,
                timeout=settings.HTTP_TIMEOUT,
                headers={"Accept": "application/json", "User-Agent": "lighter-cockpit/0.1"},
            )
        return self._explorer

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        if self._explorer and not self._explorer.is_closed:
            await self._explorer.aclose()

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

    async def funding_rates_raw(self) -> list[dict]:
        """Full funding rate list including per-exchange rates."""
        try:
            j = await self._get("/funding-rates")
        except httpx.HTTPError:
            return []
        return j.get("funding_rates") or j.get("fundingRates") or j.get("data") or []

    async def account_logs(
        self, address: str, limit: int = 100, offset: int = 0
    ) -> list[dict]:
        """Full transaction history from the Lighter explorer index (no auth needed)."""
        try:
            ex = await self._get_explorer()
            r = await ex.get(
                f"/accounts/{address}/logs",
                params={"limit": limit, "offset": offset},
            )
            r.raise_for_status()
            return r.json() or []
        except httpx.HTTPError as e:
            log.debug("account_logs(%s) failed: %s", address, e)
            return []

    async def account(self, by: str = "index", value: str = "") -> dict:
        try:
            j = await self._get("/account", params={"by": by, "value": value})
        except httpx.HTTPError as e:
            log.debug("account(%s=%s) failed: %s", by, value, e)
            return {}
        accounts = j.get("accounts") or []
        return accounts[0] if accounts else {}

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


    _BUYBACKS_WS = "wss://lighterliquidations.store/ws"

    async def buybacks_data(self) -> dict:
        """Fetch buyback daily stats + treasury balances from lighterliquidations.store WS."""
        try:
            async with websockets.connect(
                self._BUYBACKS_WS, open_timeout=8, close_timeout=3
            ) as ws:
                for _ in range(15):
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5)
                        msg = json.loads(raw)
                        if msg.get("type") == "buybacks_update":
                            return msg.get("data", {})
                    except asyncio.TimeoutError:
                        break
        except Exception as e:
            log.debug("buybacks WS failed: %s", e)
        return {}


# Module-level singleton for app usage
client = LighterClient()
