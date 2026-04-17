"""Async SQLite persistence: funding rate + open interest history only.

Trades stay in memory (volatile buffer in Store). This keeps the DB small
and the schema focused on the two metrics useful for time-series analysis.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Iterable

import aiosqlite

from app.config import settings

log = logging.getLogger("lighter.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS market_history (
    ts         INTEGER NOT NULL,
    market_id  INTEGER NOT NULL,
    symbol     TEXT    NOT NULL,
    funding    REAL,
    oi_base    REAL,
    oi_usd     REAL,
    last_price REAL,
    PRIMARY KEY (ts, market_id)
);
CREATE INDEX IF NOT EXISTS idx_hist_market_ts
    ON market_history (market_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_hist_ts
    ON market_history (ts DESC);
"""


async def init_db() -> None:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.executescript(SCHEMA)
        await db.commit()


async def write_history(rows: Iterable[dict[str, Any]]) -> None:
    """Write a snapshot of funding + OI for every market with data."""
    ts = int(time.time())
    payload = [
        (
            ts,
            r["market_id"],
            r["symbol"],
            r.get("funding"),
            r.get("oi_base"),
            r.get("oi_usd"),
            r.get("last_price"),
        )
        for r in rows
        if r.get("funding") is not None or r.get("oi_usd")
    ]
    if not payload:
        return
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.executemany(
            """INSERT OR REPLACE INTO market_history
               (ts, market_id, symbol, funding, oi_base, oi_usd, last_price)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            payload,
        )
        await db.commit()


async def fetch_history(
    market_id: int, hours: int = 24, field: str = "funding"
) -> list[dict[str, Any]]:
    """Return time-series of one metric for one market.

    field ∈ {funding, oi_usd, oi_base, last_price}
    """
    allowed = {"funding", "oi_usd", "oi_base", "last_price"}
    if field not in allowed:
        raise ValueError(f"field must be one of {allowed}")

    since = int(time.time()) - hours * 3600
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"""SELECT ts, {field} FROM market_history
                WHERE market_id = ? AND ts >= ? AND {field} IS NOT NULL
                ORDER BY ts ASC""",
            (market_id, since),
        )
        rows = await cur.fetchall()
    return [{"ts": r[0], "value": r[1]} for r in rows]


async def db_stats() -> dict[str, Any]:
    """Summary counters for the /status endpoint."""
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("SELECT COUNT(*) FROM market_history")
        row = await cur.fetchone()
        total = row[0] if row else 0
        cur = await db.execute("SELECT MIN(ts), MAX(ts) FROM market_history")
        row = await cur.fetchone()
        oldest, newest = (row[0], row[1]) if row else (None, None)
    return {"snapshots": total, "oldest_ts": oldest, "newest_ts": newest}


async def prune_old() -> None:
    """Delete snapshots older than retention window."""
    cutoff = int(time.time()) - settings.HISTORY_RETENTION_DAYS * 86400
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("DELETE FROM market_history WHERE ts < ?", (cutoff,))
        await db.commit()
        if cur.rowcount:
            log.info("pruned %d old history rows", cur.rowcount)
