"""Async SQLite persistence: market history + LIT trade ledger."""
from __future__ import annotations

import json
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

CREATE TABLE IF NOT EXISTS lit_backfill_log (
    account_id     INTEGER PRIMARY KEY,
    l1_address     TEXT    NOT NULL,
    backfilled_at  INTEGER NOT NULL,
    trades_found   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS all_trades (
    trade_id       TEXT    PRIMARY KEY,
    market_id      INTEGER NOT NULL,
    symbol         TEXT    NOT NULL,
    ts             INTEGER NOT NULL,
    price          REAL    NOT NULL,
    size           REAL    NOT NULL,
    usd            REAL    NOT NULL,
    bid_account    INTEGER NOT NULL,
    ask_account    INTEGER NOT NULL,
    taker_is_buyer INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_all_trades_ts
    ON all_trades (ts DESC);
CREATE INDEX IF NOT EXISTS idx_all_trades_bid
    ON all_trades (bid_account, ts DESC);
CREATE INDEX IF NOT EXISTS idx_all_trades_ask
    ON all_trades (ask_account, ts DESC);

CREATE TABLE IF NOT EXISTS account_snapshots (
    account_index     INTEGER PRIMARY KEY,
    l1_address        TEXT,
    ts                INTEGER NOT NULL,
    collateral        REAL,
    total_asset_value REAL,
    payload           TEXT NOT NULL
);

-- Every LIT holder on Ethereum L1, reconstructed from the full ERC-20 Transfer
-- history (486K events since 2025-10-27) and validated to sum to the whole 1B
-- supply. account_snapshots below is a DIFFERENT, much smaller set: LIT sitting
-- in Lighter L2 accounts that happened to trade.
CREATE TABLE IF NOT EXISTS lit_l1_holders (
    address   TEXT    PRIMARY KEY,
    lit       REAL    NOT NULL,
    rank      INTEGER NOT NULL,
    kind      TEXT    NOT NULL DEFAULT 'wallet',  -- wallet | contract | bridge | burn
    label     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_lit_l1_rank ON lit_l1_holders (rank ASC);

-- Snapshot provenance. A holder table with no as-of date gets trusted after it
-- stops being true.
-- Daily price and protocol revenue on one timeline. Answers "did the business
-- grow with the price?", which nothing in the cockpit could previously address.
CREATE TABLE IF NOT EXISTS lit_fundamentals (
    day         TEXT PRIMARY KEY,   -- UTC YYYY-MM-DD
    price       REAL,
    fees_usd    REAL,
    volume_usd  REAL,               -- from Lighter's own exchangeStats
    trades      INTEGER,
    markets     INTEGER
);

CREATE TABLE IF NOT EXISTS lit_l1_meta (
    k TEXT PRIMARY KEY,
    v TEXT
);

CREATE TABLE IF NOT EXISTS account_pnl_cache (
    account_key TEXT    PRIMARY KEY,
    ts          INTEGER NOT NULL,
    payload     TEXT    NOT NULL
);
"""


# Columns added after the original schema shipped. ALTER TABLE ADD COLUMN is the
# only safe migration against the live 589K-row ledger, and it must stay idempotent.
_MIGRATIONS = [
    ("lit_trades", "trade_type", "TEXT NOT NULL DEFAULT 'trade'"),
    # Position state published on every public trade, for BOTH counterparties.
    # These are stream-only — there is no REST endpoint to backfill them from,
    # so anything not captured as it arrives is gone permanently.
    # position_before is the account's size BEFORE this fill; entry_quote is its
    # cost basis (entry price = entry_quote / |position_before|); imf is the
    # initial margin fraction (leverage = 10000 / imf, verified 2000->5x, 3333->3x).
    ("lit_trades", "buyer_pos_before",   "REAL"),
    ("lit_trades", "buyer_entry_quote",  "REAL"),
    ("lit_trades", "buyer_imf",          "INTEGER"),
    ("lit_trades", "buyer_fee",          "INTEGER"),
    ("lit_trades", "buyer_client_id",    "INTEGER"),
    ("lit_trades", "seller_pos_before",  "REAL"),
    ("lit_trades", "seller_entry_quote", "REAL"),
    ("lit_trades", "seller_imf",         "INTEGER"),
    ("lit_trades", "seller_fee",         "INTEGER"),
    ("lit_trades", "seller_client_id",   "INTEGER"),
    # Volume from Lighter's own exchangeStats. Fees are zero on all 246 markets,
    # so volume — not revenue — is what tracks the exchange.
    ("lit_fundamentals", "volume_usd", "REAL"),
    ("lit_fundamentals", "trades",     "INTEGER"),
    ("lit_fundamentals", "markets",    "INTEGER"),
    # Net LIT flow per holder. A balance says who owns it; flow says who is
    # accumulating or leaving, which is the question a holder list raises.
    ("lit_l1_holders", "net_24h", "REAL"),
    ("lit_l1_holders", "net_7d",  "REAL"),
    ("lit_l1_holders", "net_30d", "REAL"),
]


async def init_db() -> None:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.executescript(SCHEMA)
        for table, column, decl in _MIGRATIONS:
            cur = await db.execute(f"PRAGMA table_info({table})")
            cols = {r[1] for r in await cur.fetchall()}
            if column not in cols:
                await db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
                log.info("migrated: %s.%s added", table, column)
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


async def fetch_candles(
    market_id: int, resolution: str = "1h", count: int = 24
) -> list[dict[str, Any]]:
    """Build OHLC candles from local market_history snapshots."""
    bucket_secs = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
    bucket = bucket_secs.get(resolution, 3600)
    since = int(time.time()) - bucket * (count + 1)  # +1 so first bucket has context

    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """SELECT ts, last_price FROM market_history
               WHERE market_id = ? AND ts >= ? AND last_price IS NOT NULL
               ORDER BY ts ASC""",
            (market_id, since),
        )
        rows = await cur.fetchall()

    if not rows:
        return []

    buckets: dict[int, list[float]] = {}
    for ts, price in rows:
        b = (ts // bucket) * bucket
        buckets.setdefault(b, []).append(float(price))

    candles = []
    for b_ts in sorted(buckets):
        prices = buckets[b_ts]
        candles.append({
            "t": b_ts * 1000,
            "o": prices[0],
            "h": max(prices),
            "l": min(prices),
            "c": prices[-1],
            "v": 0.0,
        })

    return candles[-count:]


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


async def fetch_protocol_history(days: int = 90) -> dict[str, Any]:
    """Protocol-wide daily OI (each market's last snapshot per day, summed)
    and hourly traded volume from the all_trades ledger."""
    since_s = int(time.time()) - days * 86400
    since_ms = (int(time.time()) - 8 * 86400) * 1000  # all_trades retention window
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """SELECT day, SUM(oi_usd) FROM (
                   SELECT date(ts, 'unixepoch') AS day, oi_usd,
                          ROW_NUMBER() OVER (
                              PARTITION BY date(ts, 'unixepoch'), market_id
                              ORDER BY ts DESC
                          ) AS rn
                   FROM market_history
                   WHERE ts >= ? AND oi_usd IS NOT NULL
               ) WHERE rn = 1
               GROUP BY day ORDER BY day ASC""",
            (since_s,),
        )
        oi_rows = await cur.fetchall()
        cur = await db.execute(
            """SELECT (ts / 1000 / 3600) * 3600 AS hr, SUM(usd), COUNT(*)
               FROM all_trades WHERE ts >= ?
               GROUP BY hr ORDER BY hr ASC""",
            (since_ms,),
        )
        vol_rows = await cur.fetchall()
    return {
        "oi_daily": [{"day": r[0], "oi_usd": r[1]} for r in oi_rows],
        "vol_hourly": [{"ts": r[0], "usd": r[1], "trades": r[2]} for r in vol_rows],
    }


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
    cols = ("buyer_pos_before", "buyer_entry_quote", "buyer_imf", "buyer_fee",
            "buyer_client_id", "seller_pos_before", "seller_entry_quote",
            "seller_imf", "seller_fee", "seller_client_id")
    payload = [
        (t["trade_id"], t["market_id"], t["ts"], t["price"],
         t["size"], t["usd"], t["buyer_id"], t["seller_id"], t["taker_is_buyer"],
         t.get("trade_type", "trade"), *(t.get(c) for c in cols))
        for t in trades
    ]
    async with aiosqlite.connect(settings.DB_PATH) as db:
        before = db.total_changes
        await db.executemany(
            """INSERT OR IGNORE INTO lit_trades
               (trade_id, market_id, ts, price, size, usd,
                buyer_id, seller_id, taker_is_buyer, trade_type,
                buyer_pos_before, buyer_entry_quote, buyer_imf, buyer_fee,
                buyer_client_id, seller_pos_before, seller_entry_quote,
                seller_imf, seller_fee, seller_client_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            payload,
        )
        await db.commit()
        # Rows actually inserted, not rows offered — OR IGNORE silently drops
        # duplicates, and the caller needs the real number to report ingest health.
        return db.total_changes - before


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


def _time_where(hours: int) -> tuple[str, list]:
    """Return (WHERE clause, params) handling hours=0 as all-time."""
    if hours > 0:
        since_ms = int((time.time() - hours * 3600) * 1000)
        return "ts >= ?", [since_ms]
    return "1=1", []


async def fetch_lit_flow(hours: int = 24, market_id: int | None = None) -> dict[str, Any]:
    where, params = _time_where(hours)
    if market_id is not None:
        where += " AND market_id = ?"
        params.append(market_id)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"""SELECT
                SUM(CASE WHEN taker_is_buyer=1 THEN usd ELSE 0 END),
                SUM(CASE WHEN taker_is_buyer=0 THEN usd ELSE 0 END),
                COUNT(*),
                MIN(ts),
                MAX(ts),
                SUM(CASE WHEN taker_is_buyer NOT IN (0,1) THEN usd ELSE 0 END)
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
        "newest_ts": row[4],
        "unknown_usd": row[5] or 0.0,
        "hours": hours,
        "market_id": market_id,
    }


async def fetch_lit_leaders(
    hours: int = 24, top_n: int = 15, market_id: int | None = None
) -> dict[str, Any]:
    where, params = _time_where(hours)
    if market_id is not None:
        where += " AND market_id = ?"
        params.append(market_id)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"""SELECT buyer_id, SUM(usd), COUNT(*), MIN(ts), MAX(ts)
               FROM lit_trades WHERE {where}
               GROUP BY buyer_id ORDER BY SUM(usd) DESC LIMIT ?""",
            (*params, top_n),
        )
        buyers = [
            {"account_id": r[0], "total_usd": r[1], "trade_count": r[2],
             "first_ts": r[3], "last_ts": r[4]}
            for r in await cur.fetchall()
        ]
        cur = await db.execute(
            f"""SELECT seller_id, SUM(usd), COUNT(*), MIN(ts), MAX(ts)
               FROM lit_trades WHERE {where}
               GROUP BY seller_id ORDER BY SUM(usd) DESC LIMIT ?""",
            (*params, top_n),
        )
        sellers = [
            {"account_id": r[0], "total_usd": r[1], "trade_count": r[2],
             "first_ts": r[3], "last_ts": r[4]}
            for r in await cur.fetchall()
        ]
    return {"buyers": buyers, "sellers": sellers, "hours": hours, "market_id": market_id}


async def fetch_all_lit_account_ids() -> list[int]:
    """All unique account IDs (buyer or seller) ever seen in lit_trades."""
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """SELECT DISTINCT account_id FROM (
                 SELECT buyer_id  AS account_id FROM lit_trades WHERE buyer_id  > 0
                 UNION
                 SELECT seller_id AS account_id FROM lit_trades WHERE seller_id > 0
               ) ORDER BY account_id"""
        )
        rows = await cur.fetchall()
    return [int(r[0]) for r in rows]


async def fetch_backfilled_ids() -> set[int]:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("SELECT account_id FROM lit_backfill_log")
        rows = await cur.fetchall()
    return {int(r[0]) for r in rows}


async def mark_backfilled(account_id: int, l1_address: str, trades_found: int) -> None:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO lit_backfill_log
               (account_id, l1_address, backfilled_at, trades_found)
               VALUES (?, ?, ?, ?)""",
            (account_id, l1_address, int(time.time()), trades_found),
        )
        await db.commit()


async def fetch_backfill_status() -> dict[str, Any]:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("SELECT COUNT(*), SUM(trades_found) FROM lit_backfill_log")
        row = await cur.fetchone()
        done = row[0] or 0
        total_found = row[1] or 0
        cur2 = await db.execute(
            """SELECT COUNT(DISTINCT account_id) FROM (
                 SELECT buyer_id AS account_id FROM lit_trades WHERE buyer_id > 0
                 UNION SELECT seller_id FROM lit_trades WHERE seller_id > 0
               )"""
        )
        row2 = await cur2.fetchone()
        known = row2[0] or 0
    return {"accounts_known": known, "accounts_backfilled": done, "trades_found": total_found}


async def fetch_lit_account_flow(
    account_id: int, market_id: int | None = None
) -> dict[str, Any]:
    """Buy/sell aggregates for one account across 24h, 7d, 30d windows."""
    now_ms = int(time.time() * 1000)
    windows = {"24h": 24, "7d": 168, "30d": 720}
    mkt_clause = " AND market_id = ?" if market_id is not None else ""

    async with aiosqlite.connect(settings.DB_PATH) as db:
        result: dict[str, Any] = {}
        for label, hours in windows.items():
            since_ms = now_ms - hours * 3_600_000
            params_b = [since_ms, account_id] + ([market_id] if market_id else [])
            params_s = [since_ms, account_id] + ([market_id] if market_id else [])
            cur = await db.execute(
                f"""SELECT
                    COALESCE(SUM(CASE WHEN buyer_id=? THEN usd ELSE 0 END),0),
                    COUNT(CASE WHEN buyer_id=? THEN 1 END),
                    COALESCE(SUM(CASE WHEN seller_id=? THEN usd ELSE 0 END),0),
                    COUNT(CASE WHEN seller_id=? THEN 1 END)
                FROM lit_trades
                WHERE ts >= ?
                  AND (buyer_id=? OR seller_id=?){mkt_clause}""",
                [account_id, account_id, account_id, account_id,
                 since_ms, account_id, account_id]
                + ([market_id] if market_id else []),
            )
            row = await cur.fetchone()
            buy_usd, buy_cnt, sell_usd, sell_cnt = row or (0, 0, 0, 0)
            result[label] = {
                "buy_usd": buy_usd or 0.0,
                "buy_trades": buy_cnt or 0,
                "sell_usd": sell_usd or 0.0,
                "sell_trades": sell_cnt or 0,
                "net_usd": (buy_usd or 0.0) - (sell_usd or 0.0),
            }
    return result


async def fetch_lit_account_trades(
    account_id: int, hours: int = 24, role: str = "buyer",
    market_id: int | None = None,
) -> list[dict[str, Any]]:
    since_ms = int((time.time() - hours * 3600) * 1000)
    id_col = "buyer_id" if role == "buyer" else "seller_id"
    where = f"ts >= ? AND {id_col} = ?"
    params: list = [since_ms, account_id]
    if market_id is not None:
        where += " AND market_id = ?"
        params.append(market_id)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"""SELECT trade_id, market_id, ts, price, size, usd,
                       buyer_id, seller_id, taker_is_buyer
               FROM lit_trades WHERE {where}
               ORDER BY ts DESC LIMIT 200""",
            params,
        )
        rows = await cur.fetchall()
    return [
        {"trade_id": r[0], "market_id": r[1], "ts": r[2], "price": r[3],
         "size": r[4], "usd": r[5], "buyer_id": r[6], "seller_id": r[7],
         "taker_is_buyer": r[8]}
        for r in rows
    ]


async def fetch_lit_top_accounts(hours: int = 168, limit: int = 20) -> list[int]:
    """Return top unique account IDs by USD volume across buying + selling."""
    since_ms = int((time.time() - hours * 3600) * 1000)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """SELECT account_id, SUM(usd) as vol FROM (
                 SELECT buyer_id  AS account_id, usd FROM lit_trades WHERE ts >= ?
                 UNION ALL
                 SELECT seller_id AS account_id, usd FROM lit_trades WHERE ts >= ?
               ) GROUP BY account_id ORDER BY vol DESC LIMIT ?""",
            (since_ms, since_ms, limit),
        )
        rows = await cur.fetchall()
    return [int(r[0]) for r in rows if r[0]]


async def fetch_lit_candles_db(
    market_id: int, minutes: int, count: int
) -> list[dict[str, Any]]:
    """Bucket lit_trades into `minutes`-wide OHLCV candles.

    o = first trade price in bucket, h/l = high/low, c = last trade price,
    v = sum(usd). Returns the newest `count` buckets, ascending by time.
    """
    bucket_ms = minutes * 60_000
    # Bound the query to the range the resolution actually claims. Without this
    # the query returned the last `count` NON-EMPTY buckets from all history, so
    # a "5m" chart silently spanned 56 days of sparse snapshots.
    since_ms = int(time.time() * 1000) - bucket_ms * count
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """
            WITH base AS (
                SELECT ts, price, usd, (ts / ?) AS bucket_idx
                FROM lit_trades
                WHERE market_id = ? AND ts >= ?
            ),
            ranked AS (
                SELECT bucket_idx, price, usd,
                       ROW_NUMBER() OVER (PARTITION BY bucket_idx ORDER BY ts ASC)  AS rn_first,
                       ROW_NUMBER() OVER (PARTITION BY bucket_idx ORDER BY ts DESC) AS rn_last
                FROM base
            ),
            agg AS (
                SELECT bucket_idx,
                       MAX(CASE WHEN rn_first = 1 THEN price END) AS o,
                       MAX(price) AS h,
                       MIN(price) AS l,
                       MAX(CASE WHEN rn_last = 1 THEN price END) AS c,
                       SUM(usd) AS v
                FROM ranked
                GROUP BY bucket_idx
                ORDER BY bucket_idx DESC
                LIMIT ?
            )
            SELECT bucket_idx * ? AS t, o, h, l, c, v FROM agg ORDER BY bucket_idx ASC
            """,
            (bucket_ms, market_id, since_ms, count, bucket_ms),
        )
        rows = await cur.fetchall()
    return [
        {"t": r[0], "o": r[1], "h": r[2], "l": r[3], "c": r[4], "v": r[5]}
        for r in rows
    ]


async def fetch_relative_performance(hours: int) -> dict[str, Any]:
    """LIT (120) vs BTC (1) vs ETH (0) indexed to 100 at the first aligned snapshot."""
    since = int(time.time()) - hours * 3600
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """SELECT l.ts, l.last_price, b.last_price, e.last_price
               FROM market_history l
               JOIN market_history b ON b.ts = l.ts AND b.market_id = 1
               JOIN market_history e ON e.ts = l.ts AND e.market_id = 0
               WHERE l.market_id = 120 AND l.ts >= ?
                 AND l.last_price IS NOT NULL
                 AND b.last_price IS NOT NULL
                 AND e.last_price IS NOT NULL
               ORDER BY l.ts ASC""",
            (since,),
        )
        rows = await cur.fetchall()

    if not rows:
        return {"hours": hours, "base_ts": None, "requested_since": since,
                "covered_hours": 0.0, "series": {"LIT": [], "BTC": [], "ETH": []}}

    lit0, btc0, eth0 = rows[0][1], rows[0][2], rows[0][3]
    # The index bases at the first sample we HAVE, which may be well inside the
    # requested window — the caller has to label the real period, not `hours`.
    return {
        "hours": hours,
        "base_ts": rows[0][0],
        "requested_since": since,
        "covered_hours": round((rows[-1][0] - rows[0][0]) / 3600, 2),
        "series": {
            "LIT": [{"ts": r[0], "value": round(r[1] / lit0 * 100, 4)} for r in rows],
            "BTC": [{"ts": r[0], "value": round(r[2] / btc0 * 100, 4)} for r in rows],
            "ETH": [{"ts": r[0], "value": round(r[3] / eth0 * 100, 4)} for r in rows],
        },
    }


async def fetch_volume_by_venue(hours: int) -> dict[str, Any]:
    """LIT trade volume bucketed by hour (<=168h) or day (>168h), perp vs spot."""
    bucket_ms = 3_600_000 if hours <= 168 else 86_400_000
    since_ms = int((time.time() - hours * 3600) * 1000)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """SELECT (ts / ?) * ? AS bucket,
                      SUM(CASE WHEN market_id = 120  THEN usd ELSE 0 END) AS perp,
                      SUM(CASE WHEN market_id = 2049 THEN usd ELSE 0 END) AS spot
               FROM lit_trades
               WHERE ts >= ?
               GROUP BY bucket
               ORDER BY bucket ASC""",
            (bucket_ms, bucket_ms, since_ms),
        )
        rows = await cur.fetchall()

    # Zero-fill: SQLite only returns buckets that contain trades, so a sparse
    # ledger silently collapsed "24h" into a single bar. Empty hours are data.
    have = {int(r[0]): (r[1] or 0.0, r[2] or 0.0) for r in rows}
    first = (since_ms // bucket_ms) * bucket_ms
    last = (int(time.time() * 1000) // bucket_ms) * bucket_ms
    buckets = []
    b = first
    while b <= last:
        perp, spot = have.get(b, (0.0, 0.0))
        buckets.append({"ts": b // 1000, "perp": perp, "spot": spot})
        b += bucket_ms
    return {
        "hours": hours,
        "bucket": "hour" if hours <= 168 else "day",
        "buckets": buckets,
        "populated": len(have),
    }


async def fetch_lit_coverage(hours: int = 24, gap_threshold_s: int = 300) -> dict[str, Any]:
    """How much of `hours` the ledger actually observed.

    A dashboard built on a sampled tape has to publish its own sampling. This
    reports ledger freshness plus every ingestion gap wider than
    `gap_threshold_s`, so a silent collector reads as a hole rather than as a
    quiet market (the Sep-11→15 blackout rendered as `$0` under a green dot).
    """
    since_ms = int((time.time() - hours * 3600) * 1000)
    gap_ms = gap_threshold_s * 1000
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """SELECT COUNT(*), MIN(ts), MAX(ts), COALESCE(SUM(usd), 0)
               FROM lit_trades WHERE ts >= ?""",
            (since_ms,),
        )
        n, oldest, newest, usd = await cur.fetchone()

        cur = await db.execute(
            """WITH g AS (
                 SELECT ts, ts - LAG(ts) OVER (ORDER BY ts) AS gap
                 FROM lit_trades WHERE ts >= ?
               )
               SELECT ts - gap AS gap_start, ts AS gap_end, gap
               FROM g WHERE gap > ?
               ORDER BY gap DESC LIMIT 20""",
            (since_ms, gap_ms),
        )
        gaps = [
            {"start_ts": r[0], "end_ts": r[1], "seconds": round(r[2] / 1000)}
            for r in await cur.fetchall()
        ]

    window_ms = hours * 3_600_000
    # Time before the first observed trade counts as missing too.
    lead_ms = (oldest - since_ms) if oldest else window_ms
    missing_ms = sum(g["seconds"] * 1000 for g in gaps) + max(0, lead_ms)
    return {
        "hours": hours,
        "trade_count": n or 0,
        "usd": usd or 0.0,
        "oldest_ts": oldest,
        "newest_ts": newest,
        "stale_seconds": round(time.time() - newest / 1000) if newest else None,
        "gaps": gaps,
        "observed_pct": round(max(0.0, 1 - missing_ms / window_ms) * 100, 1),
    }


async def fetch_lit_twap(
    window_ms: int = 600_000,
    min_usd: float = 5_000.0,
    min_trades: int = 3,
    market_id: int | None = None,
) -> dict[str, Any]:
    """Accounts accumulating steadily on one side within a rolling window.

    Computed in SQL over the FULL window. The client used to derive this from
    the last 100 trades returned to the page, which at live ingest rates covers
    about a minute — so a "10 min" pattern could never actually be seen.
    """
    since_ms = int(time.time() * 1000) - window_ms
    extra, params_extra = ("", [])
    if market_id is not None:
        extra, params_extra = (" AND market_id = ?", [market_id])

    out: dict[str, list] = {}
    async with aiosqlite.connect(settings.DB_PATH) as db:
        for side, acct_col, flag in (("buyers", "buyer_id", 1), ("sellers", "seller_id", 0)):
            cur = await db.execute(
                f"""SELECT {acct_col} AS account_id,
                           SUM(usd)   AS total_usd,
                           COUNT(*)   AS trades,
                           MAX(usd)   AS max_usd,
                           MIN(ts)    AS first_ts,
                           MAX(ts)    AS last_ts
                    FROM lit_trades
                    WHERE ts >= ? AND taker_is_buyer = ? AND {acct_col} > 0{extra}
                    GROUP BY {acct_col}
                    HAVING SUM(usd) >= ? AND COUNT(*) >= ?
                    ORDER BY total_usd DESC
                    LIMIT 25""",
                (since_ms, flag, *params_extra, min_usd, min_trades),
            )
            rows = await cur.fetchall()
            out[side] = [
                {
                    "account_id": r[0], "total_usd": r[1], "trades": r[2],
                    "max_usd": r[3], "first_ts": r[4], "last_ts": r[5],
                    "avg_usd": r[1] / r[2] if r[2] else 0,
                    # Mean spacing across the account's own run of fills.
                    "avg_spacing_ms": (r[5] - r[4]) / (r[2] - 1) if r[2] > 1 else 0,
                }
                for r in rows
            ]
    return {
        **out,
        "window_ms": window_ms, "min_usd": min_usd,
        "min_trades": min_trades, "since_ts": since_ms,
    }


async def fetch_lit_positions(
    market_id: int = 120, limit: int = 40, max_age_hours: int = 24
) -> dict[str, Any]:
    """Reconstruct each account's latest known position from the trade stream.

    Every public trade publishes both counterparties' position size, cost basis
    and margin fraction as they stood BEFORE the fill. Taking each account's
    most recent appearance and applying that fill gives its position AFTER —
    with no auth and no account API.

    It is a LAST-SEEN position, not a live one: an account that has not traded
    since is reported at its last observed state, and `as_of` says when that
    was. Accounts whose last fill predates the column migration have no state
    and are excluded rather than shown as flat.
    """
    since_ms = int((time.time() - max_age_hours * 3600) * 1000)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """
            WITH sides AS (
                SELECT buyer_id  AS account_id, ts, price, size AS delta,
                       buyer_pos_before  AS pos_before,
                       buyer_entry_quote AS entry_quote,
                       buyer_imf         AS imf
                FROM lit_trades
                WHERE market_id = ? AND ts >= ? AND buyer_id > 0
                  AND buyer_pos_before IS NOT NULL
                UNION ALL
                SELECT seller_id, ts, price, -size,
                       seller_pos_before, seller_entry_quote, seller_imf
                FROM lit_trades
                WHERE market_id = ? AND ts >= ? AND seller_id > 0
                  AND seller_pos_before IS NOT NULL
            ),
            ranked AS (
                SELECT *, ROW_NUMBER() OVER (
                           PARTITION BY account_id ORDER BY ts DESC) AS rn
                FROM sides
            )
            SELECT account_id, ts, price, pos_before, pos_before + delta AS position,
                   entry_quote, imf
            FROM ranked WHERE rn = 1
            ORDER BY ABS(pos_before + delta) DESC
            LIMIT ?
            """,
            (market_id, since_ms, market_id, since_ms, limit),
        )
        rows = await cur.fetchall()

    out = []
    for acct, ts, price, pos_before, position, entry_quote, imf in rows:
        if not position:
            continue                      # flat after the fill — nothing to show
        # Cost basis is published against the PRE-fill size, so it must be
        # divided by pos_before, NOT by the updated position.
        entry = abs(entry_quote / pos_before) if entry_quote and pos_before else None
        out.append({
            "account_id": acct,
            "as_of": ts,
            "position": position,
            "position_before": pos_before,
            "side": "long" if position > 0 else "short",
            "last_price": price,
            "entry_quote": entry_quote,
            "entry_price": entry,
            # Verified live: imf 2000 -> 5x, 3333 -> 3x.
            "leverage": round(10000 / imf, 2) if imf else None,
            "notional": abs(position) * price,
            # Mark-to-market on the last observed print. Validated against
            # Lighter's own /account for index 100833: entry 1.9480 and
            # 5x leverage matched exactly.
            "unrealized_pnl": (price - entry) * position if entry else None,
        })
    return {"market_id": market_id, "positions": out, "count": len(out),
            "max_age_hours": max_age_hours}


# Bands chosen to fit the real distribution: 17 addresses hold 72% of supply,
# so round decades would put almost everything in one bucket.
_L1_TIERS = [
    ("mega",    "Mega Whale",  10_000_000, None),
    ("whale",   "Whale",        1_000_000, 10_000_000),
    ("shark",   "Shark",          100_000, 1_000_000),
    ("dolphin", "Dolphin",         10_000, 100_000),
    ("fish",    "Fish",             1_000, 10_000),
    ("shrimp",  "Shrimp",               1, 1_000),
    ("dust",    "Dust",                 0, 1),
]


async def fetch_lit_l1_holders(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """The global LIT holder set: every L1 address with a positive balance."""
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("SELECT k, v FROM lit_l1_meta")
        meta = {k: v for k, v in await cur.fetchall()}
        if not meta:
            return {"holders": [], "count": 0, "meta": {}, "tiers": [], "kinds": []}

        cur = await db.execute(
            """SELECT rank, address, lit, kind, label, net_24h, net_7d, net_30d
               FROM lit_l1_holders ORDER BY rank ASC LIMIT ? OFFSET ?""",
            (limit, offset))
        rows = await cur.fetchall()

        cur = await db.execute("SELECT COUNT(*), COALESCE(SUM(lit),0) FROM lit_l1_holders")
        count, total = await cur.fetchone()

        # Bridge / burn / contract are not people. Reported separately so the
        # page never presents the L2 bridge float as somebody's position.
        cur = await db.execute(
            """SELECT kind, COUNT(*), COALESCE(SUM(lit),0) FROM lit_l1_holders
               GROUP BY kind ORDER BY 3 DESC""")
        kinds = [{"kind": k, "holders": n, "lit": v} for k, n, v in await cur.fetchall()]

        tiers = []
        for key, label, lo, hi in _L1_TIERS:
            where = "lit >= ?" + (" AND lit < ?" if hi else "")
            cur = await db.execute(
                f"SELECT COUNT(*), COALESCE(SUM(lit),0) FROM lit_l1_holders WHERE {where}",
                [lo] + ([hi] if hi else []))
            n, held = await cur.fetchone()
            tiers.append({"key": key, "label": label, "min": lo, "max": hi,
                          "holders": n, "lit": held})

    supply = float(meta.get("total_supply") or 0) or None
    return {
        "holders": [
            {"rank": r, "address": a, "lit": l, "kind": k, "label": lb,
             "net_24h": n24, "net_7d": n7, "net_30d": n30,
             "pct_supply": (l / supply * 100) if supply else None}
            for r, a, l, k, lb, n24, n7, n30 in rows
        ],
        "count": count, "total_lit": total,
        "kinds": kinds, "tiers": tiers, "meta": meta,
    }


async def fetch_lit_l1_holder(address: str) -> dict[str, Any] | None:
    """One address's place in the global LIT holder set.

    Lets the explorer answer for an L1 address that holds LIT but has no Lighter
    account — which is most of them, since holding on Ethereum requires no
    Lighter account at all.
    """
    addr = (address or "").strip().lower()
    if not addr:
        return None
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """SELECT rank, address, lit, kind, label, net_24h, net_7d, net_30d
               FROM lit_l1_holders WHERE address = ?""",
            (addr,),
        )
        row = await cur.fetchone()
        if not row:
            return None
        cur = await db.execute("SELECT COUNT(*) FROM lit_l1_holders")
        total_holders = (await cur.fetchone())[0]
        cur = await db.execute("SELECT v FROM lit_l1_meta WHERE k IN ('total_supply','snapshot_ts')")
        meta_rows = await cur.fetchall()
        cur = await db.execute("SELECT k, v FROM lit_l1_meta")
        meta = {k: v for k, v in await cur.fetchall()}

    rank, a, lit, kind, label, n24, n7, n30 = row
    supply = float(meta.get("total_supply") or 0) or None
    return {
        "address": a, "rank": rank, "lit": lit, "kind": kind, "label": label,
        "net_24h": n24, "net_7d": n7, "net_30d": n30,
        "pct_supply": (lit / supply * 100) if supply else None,
        "total_holders": total_holders,
        "snapshot_ts": meta.get("snapshot_ts"),
    }


async def upsert_fundamentals(rows: list[tuple]) -> int:
    """Merge daily price/fees. COALESCE keeps a value when one source lags."""
    if not rows:
        return 0
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.executemany(
            """INSERT INTO lit_fundamentals (day, price, fees_usd) VALUES (?,?,?)
               ON CONFLICT(day) DO UPDATE SET
                   price    = COALESCE(excluded.price,    lit_fundamentals.price),
                   fees_usd = COALESCE(excluded.fees_usd, lit_fundamentals.fees_usd)""",
            rows,
        )
        await db.commit()
    return len(rows)


async def upsert_volume(day: str, volume_usd: float, trades: int, markets: int) -> None:
    """Snapshot Lighter's own reported daily volume. No historical endpoint
    exists, so the series builds forward from first run."""
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.execute(
            """INSERT INTO lit_fundamentals (day, volume_usd, trades, markets)
               VALUES (?,?,?,?)
               ON CONFLICT(day) DO UPDATE SET
                   volume_usd = excluded.volume_usd,
                   trades     = excluded.trades,
                   markets    = excluded.markets""",
            (day, volume_usd, trades, markets))
        await db.commit()


async def fetch_fundamentals_series(days: int = 365) -> list[dict[str, Any]]:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """SELECT day, price, fees_usd, volume_usd, trades, markets
               FROM lit_fundamentals ORDER BY day DESC LIMIT ?""", (days,))
        rows = await cur.fetchall()
    return [{"day": d, "price": p, "fees_usd": f, "volume_usd": v,
             "trades": t, "markets": m} for d, p, f, v, t, m in reversed(rows)]


async def fetch_meta(key: str) -> str | None:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("SELECT v FROM lit_l1_meta WHERE k = ?", (key,))
        row = await cur.fetchone()
    return row[0] if row else None


async def upsert_meta(key: str, value: str) -> None:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.execute("INSERT OR REPLACE INTO lit_l1_meta (k, v) VALUES (?, ?)",
                         (key, value))
        await db.commit()


async def fetch_lit_stats() -> dict[str, Any]:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM lit_trades")
        row = await cur.fetchone()
    return {
        "db_trade_count": row[0] or 0,
        "oldest_trade_ts": row[1],
        "newest_trade_ts": row[2],
    }


# ── Traders feature: all-market trade ledger ─────────────────────────

async def write_all_trades(trades: list[dict[str, Any]]) -> int:
    if not trades:
        return 0
    payload = [
        (t["trade_id"], t["market_id"], t["symbol"], t["ts"], t["price"],
         t["size"], t["usd"], t["bid_account"], t["ask_account"], t["taker_is_buyer"])
        for t in trades
    ]
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.executemany(
            """INSERT OR IGNORE INTO all_trades
               (trade_id, market_id, symbol, ts, price, size, usd,
                bid_account, ask_account, taker_is_buyer)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            payload,
        )
        await db.commit()
    return len(payload)


async def prune_all_trades(max_age_days: int = 8) -> int:
    cutoff = int(time.time() * 1000) - max_age_days * 86400 * 1000
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("DELETE FROM all_trades WHERE ts < ?", (cutoff,))
        await db.commit()
        return cur.rowcount or 0


async def fetch_all_trades_status() -> dict[str, Any]:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM all_trades")
        row = await cur.fetchone()
        cur2 = await db.execute("SELECT COUNT(*) FROM account_snapshots")
        row2 = await cur2.fetchone()
    return {
        "all_trades_count": row[0] or 0,
        "data_since": row[1],
        "newest_trade_ts": row[2],
        "account_snapshots_count": row2[0] or 0,
    }


# Known protocol/pool accounts (e.g. the LIT staking pool) are not traders —
# exclude them from rankings and scans. High indices near 2^48 are otherwise
# legitimate sub-accounts (account_type=1), so no magnitude-based filtering.
SYSTEM_ACCOUNTS = (281_474_976_710_654,)  # LIT staking pool
_SYS_NOT_IN = f"NOT IN ({','.join(str(a) for a in SYSTEM_ACCOUNTS)})"


async def fetch_leaderboard(hours: int, limit: int = 50) -> dict[str, Any]:
    """Aggregate per-account volume/buy/sell/net over all_trades for the given window.

    An account's volume counts once for each side (bid or ask) it participated in
    across distinct trades — a single trade cannot have the same account on both
    sides, so summing the bid-side and ask-side contributions is safe.
    """
    since_ms = int((time.time() - hours * 3600) * 1000)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            """SELECT COALESCE(SUM(usd), 0), COUNT(*) FROM all_trades WHERE ts >= ?""",
            (since_ms,),
        )
        vol_row = await cur.fetchone()

        cur = await db.execute(
            f"""SELECT COUNT(*) FROM (
                 SELECT bid_account AS a FROM all_trades
                 WHERE ts >= ? AND bid_account > 0 AND bid_account {_SYS_NOT_IN}
                 UNION
                 SELECT ask_account AS a FROM all_trades
                 WHERE ts >= ? AND ask_account > 0 AND ask_account {_SYS_NOT_IN}
               )""",
            (since_ms, since_ms),
        )
        uniq_row = await cur.fetchone()

        cur = await db.execute("SELECT MIN(ts) FROM all_trades")
        since_row = await cur.fetchone()
        data_since = since_row[0] if since_row else None

        cur = await db.execute(
            f"""WITH sides AS (
                 SELECT bid_account AS account_index, usd, symbol, 1 AS is_buy
                 FROM all_trades
                 WHERE ts >= ? AND bid_account > 0 AND bid_account {_SYS_NOT_IN}
                 UNION ALL
                 SELECT ask_account AS account_index, usd, symbol, 0 AS is_buy
                 FROM all_trades
                 WHERE ts >= ? AND ask_account > 0 AND ask_account {_SYS_NOT_IN}
               )
               SELECT account_index,
                      SUM(usd) AS volume_usd,
                      COUNT(*) AS trades,
                      SUM(CASE WHEN is_buy=1 THEN usd ELSE 0 END) AS buy_usd,
                      SUM(CASE WHEN is_buy=0 THEN usd ELSE 0 END) AS sell_usd,
                      MAX(usd) AS biggest_trade_usd
               FROM sides
               GROUP BY account_index
               ORDER BY volume_usd DESC
               LIMIT ?""",
            (since_ms, since_ms, limit),
        )
        leader_rows = await cur.fetchall()
        account_ids = [r[0] for r in leader_rows]

        top_symbols: dict[int, list[str]] = {}
        if account_ids:
            placeholders = ",".join("?" for _ in account_ids)
            cur = await db.execute(
                f"""WITH sides AS (
                      SELECT bid_account AS account_index, usd, symbol
                      FROM all_trades WHERE ts >= ? AND bid_account IN ({placeholders})
                      UNION ALL
                      SELECT ask_account AS account_index, usd, symbol
                      FROM all_trades WHERE ts >= ? AND ask_account IN ({placeholders})
                    ),
                    ranked AS (
                      SELECT account_index, symbol, SUM(usd) AS sym_usd,
                             ROW_NUMBER() OVER (
                                 PARTITION BY account_index ORDER BY SUM(usd) DESC
                             ) AS rn
                      FROM sides GROUP BY account_index, symbol
                    )
                    SELECT account_index, symbol FROM ranked WHERE rn <= 2""",
                (since_ms, *account_ids, since_ms, *account_ids),
            )
            for account_index, symbol in await cur.fetchall():
                top_symbols.setdefault(account_index, []).append(symbol)

    leaders = [
        {
            "account_index": r[0],
            "volume_usd": r[1] or 0.0,
            "trades": r[2] or 0,
            "buy_usd": r[3] or 0.0,
            "sell_usd": r[4] or 0.0,
            "net_usd": (r[3] or 0.0) - (r[4] or 0.0),
            "top_symbols": top_symbols.get(r[0], []),
            "biggest_trade_usd": r[5] or 0.0,
        }
        for r in leader_rows
    ]

    return {
        "data_since": data_since,
        "totals": {
            "volume_usd": vol_row[0] or 0.0,
            "trades": vol_row[1] or 0,
            "unique_accounts": uniq_row[0] or 0,
        },
        "leaders": leaders,
    }


async def fetch_top_trade_accounts(hours: int = 24, limit: int = 150) -> list[int]:
    """Top unique account indexes by USD volume (bid + ask side) over the window."""
    since_ms = int((time.time() - hours * 3600) * 1000)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"""SELECT account_index, SUM(usd) AS vol FROM (
                 SELECT bid_account AS account_index, usd FROM all_trades
                 WHERE ts >= ? AND bid_account > 0 AND bid_account {_SYS_NOT_IN}
                 UNION ALL
                 SELECT ask_account AS account_index, usd FROM all_trades
                 WHERE ts >= ? AND ask_account > 0 AND ask_account {_SYS_NOT_IN}
               ) GROUP BY account_index ORDER BY vol DESC LIMIT ?""",
            (since_ms, since_ms, limit),
        )
        rows = await cur.fetchall()
    return [int(r[0]) for r in rows if r[0]]


async def fetch_top_lit_trade_accounts(limit: int = 300) -> list[int]:
    """Top unique account indexes by all-time LIT USD volume (buyer + seller side),
    sourced from the lit_trades ledger — the candidate pool for LIT-holder balance
    scanning (distinct from fetch_top_trade_accounts, which ranks by all-market
    volume over a recent window for the Traders leaderboard)."""
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"""SELECT account_index, SUM(usd) AS vol FROM (
                 SELECT buyer_id AS account_index, usd FROM lit_trades
                 WHERE buyer_id > 0 AND buyer_id {_SYS_NOT_IN}
                 UNION ALL
                 SELECT seller_id AS account_index, usd FROM lit_trades
                 WHERE seller_id > 0 AND seller_id {_SYS_NOT_IN}
               ) GROUP BY account_index ORDER BY vol DESC LIMIT ?""",
            (limit,),
        )
        rows = await cur.fetchall()
    return [int(r[0]) for r in rows if r[0]]


async def upsert_account_snapshot(
    account_index: int, l1_address: str, ts: int,
    collateral: float, total_asset_value: float, payload: str,
) -> None:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.execute(
            """INSERT INTO account_snapshots
               (account_index, l1_address, ts, collateral, total_asset_value, payload)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(account_index) DO UPDATE SET
                 l1_address=excluded.l1_address,
                 ts=excluded.ts,
                 collateral=excluded.collateral,
                 total_asset_value=excluded.total_asset_value,
                 payload=excluded.payload""",
            (account_index, l1_address, ts, collateral, total_asset_value, payload),
        )
        await db.commit()


async def fetch_snapshot_ages(account_indexes: list[int]) -> dict[int, int]:
    """Map account_index -> last snapshot ts, for accounts already in the table."""
    if not account_indexes:
        return {}
    placeholders = ",".join("?" for _ in account_indexes)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"SELECT account_index, ts FROM account_snapshots WHERE account_index IN ({placeholders})",
            account_indexes,
        )
        rows = await cur.fetchall()
    return {int(r[0]): int(r[1]) for r in rows}


async def fetch_lit_balances(account_indexes: list[int]) -> dict[int, float]:
    """Map account_index -> last known LIT balance, for accounts already snapshotted.
    Absent from the result means never scanned (unknown, not zero)."""
    if not account_indexes:
        return {}
    placeholders = ",".join("?" for _ in account_indexes)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"SELECT account_index, payload FROM account_snapshots WHERE account_index IN ({placeholders})",
            account_indexes,
        )
        rows = await cur.fetchall()
    out: dict[int, float] = {}
    for account_index, payload in rows:
        try:
            data = json.loads(payload)
        except (TypeError, json.JSONDecodeError):
            continue
        bal = 0.0
        for a in data.get("assets") or []:
            if a.get("symbol") == "LIT":
                try:
                    bal = float(a.get("balance") or 0)
                except (TypeError, ValueError):
                    bal = 0.0
                break
        out[int(account_index)] = bal
    return out


async def fetch_account_snapshots(limit: int = 500) -> list[dict[str, Any]]:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            f"""SELECT account_index, l1_address, ts, payload
               FROM account_snapshots
               WHERE account_index {_SYS_NOT_IN}
               ORDER BY ts DESC LIMIT ?""",
            (limit,),
        )
        rows = await cur.fetchall()
    return [
        {"account_index": r[0], "l1_address": r[1], "ts": r[2], "payload": r[3]}
        for r in rows
    ]


async def fetch_pnl_cache(account_key: str) -> dict[str, Any] | None:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        cur = await db.execute(
            "SELECT ts, payload FROM account_pnl_cache WHERE account_key = ?",
            (account_key,),
        )
        row = await cur.fetchone()
    if not row:
        return None
    return {"ts": row[0], "payload": row[1]}


async def upsert_pnl_cache(account_key: str, ts: int, payload: str) -> None:
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.execute(
            """INSERT INTO account_pnl_cache (account_key, ts, payload)
               VALUES (?, ?, ?)
               ON CONFLICT(account_key) DO UPDATE SET
                 ts=excluded.ts, payload=excluded.payload""",
            (account_key, ts, payload),
        )
        await db.commit()
