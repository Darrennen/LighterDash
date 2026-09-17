#!/usr/bin/env python3
"""Load the global LIT L1 holder set into cockpit.db.

Source is a Dune reconstruction of every ERC-20 Transfer for
0x232CE3bd40fCd6f80f3d55A522d03f25Df784Ee2 (486K events since 2025-10-27),
which validates by summing to the whole 1,000,000,000 supply.

    python3 scripts/load_lit_holders.py LIT_holders_L1_2026-09-17.csv

CSV columns: rank,address,lit,kind,entity,category,net_24h,net_7d,net_30d

Refresh: re-run Dune query 8749098, export CSV, re-run this. The loader
replaces the table wholesale — a holder set merged from two dates would mix
balances from different blocks.

Balances come from the query in exact wei, not doubles: summing doubles made
the dust boundary non-deterministic and moved the holder count by +/-2 between
identical runs.
"""
from __future__ import annotations

import csv
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import settings  # noqa: E402

# Addresses that hold LIT but are not holders in any meaningful sense.
BURN = "0x000000000000000000000000000000000000dead"
# Verified via Lighter's own layer1BasicInfo: this is ZkLighterContract, the L1
# bridge. Its balance IS the L2 float — every LIT deposited into Lighter sits
# here. Showing it as the #2 whale would be wrong.
BRIDGE = "0x3b4d794a66304f130a4db8f2551b0070dfcf5ca7"
BRIDGE_LABEL = "Lighter L1 bridge (ZkLighterContract) — this is the L2 float"

TOTAL_SUPPLY = 1_000_000_000


def classify(address: str) -> tuple[str, str]:
    a = address.lower()
    if a == BURN:
        return "burn", "burned"
    if a == BRIDGE:
        return "bridge", BRIDGE_LABEL
    return "wallet", ""


def main(csv_path: str) -> None:
    rows = []
    with open(csv_path, newline="") as f:
        for r in csv.DictReader(f):
            addr = r["address"].strip().lower()
            kind, label = classify(addr)
            # Dune's own classification wins unless this is the bridge or burn
            # address, which we name explicitly.
            if kind == "wallet":
                kind = (r.get("kind") or "wallet").strip() or "wallet"
                entity, cat = (r.get("entity") or "").strip(), (r.get("category") or "").strip()
                label = f"{entity} · {cat}" if entity and cat else entity
            rows.append((addr, float(r["lit"]), int(r["rank"]), kind, label,
                         float(r.get("net_24h") or 0), float(r.get("net_7d") or 0),
                         float(r.get("net_30d") or 0)))

    if not rows:
        raise SystemExit("no rows parsed — wrong CSV?")

    total = sum(r[1] for r in rows)
    pct = total / TOTAL_SUPPLY * 100
    print(f"parsed {len(rows):,} holders, {total:,.0f} LIT ({pct:.4f}% of supply)")
    # The reconstruction is only trustworthy if it accounts for the whole
    # supply. A partial scan is exactly how the first attempt at this went
    # wrong (it covered 0.32% and looked fine).
    if not 99.9 <= pct <= 100.1:
        raise SystemExit(f"REFUSING TO LOAD: balances sum to {pct:.4f}% of supply, not ~100%")

    db = sqlite3.connect(settings.DB_PATH)
    db.executescript(
        """CREATE TABLE IF NOT EXISTS lit_l1_holders (
               address TEXT PRIMARY KEY, lit REAL NOT NULL, rank INTEGER NOT NULL,
               kind TEXT NOT NULL DEFAULT 'wallet', label TEXT NOT NULL DEFAULT '');
           CREATE INDEX IF NOT EXISTS idx_lit_l1_rank ON lit_l1_holders (rank ASC);
           CREATE TABLE IF NOT EXISTS lit_l1_meta (k TEXT PRIMARY KEY, v TEXT);"""
    )
    for col in ("net_24h", "net_7d", "net_30d"):
        try:
            db.execute(f"ALTER TABLE lit_l1_holders ADD COLUMN {col} REAL")
        except sqlite3.OperationalError:
            pass  # already present
    db.execute("DELETE FROM lit_l1_holders")
    db.executemany(
        """INSERT INTO lit_l1_holders
           (address, lit, rank, kind, label, net_24h, net_7d, net_30d)
           VALUES (?,?,?,?,?,?,?,?)""",
        rows,
    )
    for k, v in {
        "snapshot_ts": str(int(time.time())),
        "source": "dune query 8748815 (erc20_ethereum.evt_transfer, full history)",
        "contract": "0x232CE3bd40fCd6f80f3d55A522d03f25Df784Ee2",
        "total_supply": str(TOTAL_SUPPLY),
        "accounted_pct": f"{pct:.6f}",
        "holders": str(len(rows)),
    }.items():
        db.execute("INSERT OR REPLACE INTO lit_l1_meta (k, v) VALUES (?, ?)", (k, v))
    db.commit()
    db.close()
    print(f"loaded into {settings.DB_PATH}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
