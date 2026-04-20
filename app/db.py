"""Async SQLite persistence: market history + LIT trade ledger."""
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

CREATE TABLE IF NOT EXISTS lit_trades (
    trade_id       INTEGER PRIMARY KEY,
    market_id      INTEGER NOT NULL,
    ts             INTEGER NOT NULL,
    price          REAL    NOT NULL,
    size           REAL    NOT NULL,
    usd            REAL    NOT NULL,
    buyer_id       INTEGER NOT NULL,
    seller_id      INTEGER NOT NULL,
    taker_is_buyer INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lit_ts
    ON lit_trades (ts DESC);
CREATE INDEX IF NOT EXISTS idx_lit_buyer
    ON lit_trades (buyer_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_lit_seller
    ON lit_trades (seller_id, ts DESC);
"""


async def init_db() -> None:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.executescript(SCHEMA)
        await db.commit()


# ── market history ────────────────────────────────────────────────────

async def write_history(rows: Iterable[dict[str, Any]]) -> None:
    ts = int(time.time())
    payload = [
        (ts, r["market_id"], r["symbol"], r.get("funding"),
         r.get("oi_base"), r.get("oi_usd"), r.get("last_price"))
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
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("SELECT COUNT(*) FROM market_history")
        row = await cur.fetchone()
        total = row[0] if row else 0
        cur = await db.execute("SELECT MIN(ts), MAX(ts) FROM market_history")
        row = await cur.fetchone()
        oldest, newest = (row[0], row[1]) if row else (None, None)
    return {"snapshots": total, "oldest_ts": oldest, "newest_ts": newest}


async def prune_old() -> None:
    cutoff = int(time.time()) - settings.HISTORY_RETENTION_DAYS * 86400
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("DELETE FROM market_history WHERE ts < ?", (cutoff,))
        await db.commit()
        if cur.rowcount:
            log.info("pruned %d old history rows", cur.rowcount)


# ── LIT trade ledger ─────────────────────────────────────────────────

async def write_lit_trades(trades: list[dict[str, Any]]) -> int:
    if not trades:
        return 0
    payload = [
        (t["trade_id"], t["market_id"], t["ts"], t["price"],
         t["size"], t["usd"], t["buyer_id"], t["seller_id"], t["taker_is_buyer"])
        for t in trades
    ]
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.executemany(
            """INSERT OR IGNORE INTO lit_trades
               (trade_id, market_id, ts, price, size, usd,
                buyer_id, seller_id, taker_is_buyer)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            payload,
        )
        await db.commit()
    return len(payload)


async def fetch_lit_trades(
    limit: int = 100, hours: int = 24, market_id: int | None = None
) -> list[dict[str, Any]]:
    since_ms = int((time.time() - hours * 3600) * 1000)
    where = "ts >= ?"
    params: list = [since_ms]
    if market_id is not None:
        where += " AND market_id = ?"
        params.append(market_id)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"""SELECT trade_id, market_id, ts, price, size, usd,
                      buyer_id, seller_id, taker_is_buyer
               FROM lit_trades WHERE {where}
               ORDER BY ts DESC LIMIT ?""",
            (*params, limit),
        )
        rows = await cur.fetchall()
    return [
        {
            "trade_id": r[0], "market_id": r[1], "ts": r[2],
            "price": r[3], "size": r[4], "usd": r[5],
            "buyer_id": r[6], "seller_id": r[7], "taker_is_buyer": r[8],
        }
        for r in rows
    ]


async def fetch_lit_flow(hours: int = 24, market_id: int | None = None) -> dict[str, Any]:
    since_ms = int((time.time() - hours * 3600) * 1000)
    where = "ts >= ?"
    params: list = [since_ms]
    if market_id is not None:
        where += " AND market_id = ?"
        params.append(market_id)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"""SELECT
                SUM(CASE WHEN taker_is_buyer=1 THEN usd ELSE 0 END),
                SUM(CASE WHEN taker_is_buyer=0 THEN usd ELSE 0 END),
                COUNT(*),
                MIN(ts)
               FROM lit_trades WHERE {where}""",
            params,
        )
        row = await cur.fetchone()
    buy_usd = row[0] or 0.0
    sell_usd = row[1] or 0.0
    return {
        "buy_usd": buy_usd,
        "sell_usd": sell_usd,
        "delta_usd": buy_usd - sell_usd,
        "trade_count": row[2] or 0,
        "oldest_ts": row[3],
        "hours": hours,
        "market_id": market_id,
    }


async def fetch_lit_leaders(
    hours: int = 24, top_n: int = 15, market_id: int | None = None
) -> dict[str, Any]:
    since_ms = int((time.time() - hours * 3600) * 1000)
    where = "ts >= ?"
    params: list = [since_ms]
    if market_id is not None:
        where += " AND market_id = ?"
        params.append(market_id)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"""SELECT buyer_id, SUM(usd), COUNT(*)
               FROM lit_trades WHERE {where}
               GROUP BY buyer_id ORDER BY SUM(usd) DESC LIMIT ?""",
            (*params, top_n),
        )
        buyers = [
            {"account_id": r[0], "total_usd": r[1], "trade_count": r[2]}
            for r in await cur.fetchall()
        ]
        cur = await db.execute(
            f"""SELECT seller_id, SUM(usd), COUNT(*)
               FROM lit_trades WHERE {where}
               GROUP BY seller_id ORDER BY SUM(usd) DESC LIMIT ?""",
            (*params, top_n),
        )
        sellers = [
            {"account_id": r[0], "total_usd": r[1], "trade_count": r[2]}
            for r in await cur.fetchall()
        ]
    return {"buyers": buyers, "sellers": sellers, "hours": hours, "market_id": market_id}


async def fetch_lit_stats() -> dict[str, Any]:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM lit_trades")
        row = await cur.fetchone()
    return {
        "db_trade_count": row[0] or 0,
        "oldest_trade_ts": row[1],
        "newest_trade_ts": row[2],
    }
