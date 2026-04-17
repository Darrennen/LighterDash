"""In-memory state cache, updated by the collector and read by REST endpoints."""
from __future__ import annotations

import time
from collections import deque
from typing import Any


class Store:
    """Latest-snapshot state. Trades live here (volatile); history goes to SQLite."""

    def __init__(self, trade_buf_size: int = 1000) -> None:
        self.markets: list[dict[str, Any]] = []
        self.markets_by_id: dict[int, dict[str, Any]] = {}
        self.trades: deque[dict[str, Any]] = deque(maxlen=trade_buf_size)
        self._seen: set[str] = set()
        self.last_sync: int = 0
        self.sync_count: int = 0
        self.last_error: str | None = None

    def set_markets(self, markets: list[dict[str, Any]]) -> None:
        self.markets = markets
        self.markets_by_id = {m["market_id"]: m for m in markets}

    def add_trades(self, new_trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Add trades not already seen. Returns actually-new ones."""
        added: list[dict[str, Any]] = []
        for t in new_trades:
            if t["id"] in self._seen:
                continue
            self._seen.add(t["id"])
            self.trades.appendleft(t)
            added.append(t)
        if len(self._seen) > 10_000:
            self._seen = {t["id"] for t in self.trades}
        return added

    def mark_sync(self, err: str | None = None) -> None:
        self.last_sync = int(time.time())
        self.sync_count += 1
        self.last_error = err


store = Store()
