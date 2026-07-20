"""Async HTTP client that wraps the upstream Lighter REST API with normalisation.

All payload-shape defences live here so the rest of the app can assume a stable schema.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import settings

log = logging.getLogger("lighter.client")


EXPLORER_API = "https://explorer.elliot.ai/api"


class UpstreamUnavailable(Exception):
    """Raised when Lighter's own API rate-limits or WAF-blocks a request —
    distinct from a genuine 'account not found', so routes can say so honestly."""


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

    async def order_book_details(self) -> list[dict]:
        """Richer snapshot: includes open_interest, daily_price_high/low, etc."""
        j = await self._get("/orderBookDetails")
        perps = j.get("order_book_details") or []
        spot  = j.get("spot_order_book_details") or []
        return perps + spot

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
        except httpx.HTTPStatusError as e:
            if e.response.status_code in (429, 405, 403):
                raise UpstreamUnavailable(f"Lighter API returned {e.response.status_code}") from e
            log.debug("account(%s=%s) failed: %s", by, value, e)
            return {}
        except httpx.HTTPError as e:
            log.debug("account(%s=%s) failed: %s", by, value, e)
            return {}
        accounts = j.get("accounts") or []
        return accounts[0] if accounts else {}

    async def accounts_by_l1(self, address: str) -> dict:
        """All sub-accounts registered under an L1 wallet address (public, no auth)."""
        try:
            return await self._get("/accountsByL1Address", params={"l1_address": address})
        except httpx.HTTPError as e:
            log.debug("accounts_by_l1(%s) failed: %s", address, e)
            return {}

    async def candles(
        self, market_id: int, resolution: str = "1h", count: int = 24
    ) -> list[dict]:
        import time as _time
        res_secs = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
        bucket = res_secs.get(resolution, 3600)
        end_ms   = int(_time.time() * 1000)
        start_ms = end_ms - bucket * count * 1000
        try:
            j = await self._get(
                "/candles",
                params={
                    "market_id": market_id,
                    "resolution": resolution,
                    "start_timestamp": start_ms,
                    "end_timestamp": end_ms,
                    "count_back": count,
                },
            )
        except httpx.HTTPError:
            return []
        raw = j.get("c") or j.get("candlesticks") or j.get("candles") or j.get("data") or []
        return raw


# Module-level singleton for app usage
client = LighterClient()
