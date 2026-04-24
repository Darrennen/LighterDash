"""Runtime configuration, loaded from environment variables with sensible defaults."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Settings:
    # Upstream Lighter REST API (mainnet)
    LIGHTER_API: str = os.getenv(
        "LIGHTER_API", "https://mainnet.zklighter.elliot.ai/api/v1"
    )

    # How often the collector polls Lighter (seconds)
    COLLECT_INTERVAL: int = int(os.getenv("COLLECT_INTERVAL", "5"))

    # Number of trades per top-volume market to fetch each cycle
    RECENT_TRADES_LIMIT: int = int(os.getenv("RECENT_TRADES_LIMIT", "50"))

    # How many top-volume markets to pull trades for (rest ignored for trade stream)
    TOP_N_MARKETS: int = int(os.getenv("TOP_N_MARKETS", "15"))

    # Whale default threshold (USD)
    WHALE_DEFAULT_USD: float = float(os.getenv("WHALE_DEFAULT_USD", "50000"))

    # Trade buffer size (kept in memory by the collector)
    TRADE_BUFFER: int = int(os.getenv("TRADE_BUFFER", "1000"))

    # Historical snapshot retention (days)
    HISTORY_RETENTION_DAYS: int = int(os.getenv("HISTORY_RETENTION_DAYS", "30"))

    # SQLite path — use /tmp on Vercel (read-only fs), persistent data/ dir elsewhere
    DB_PATH: str = os.getenv(
        "DB_PATH",
        "/tmp/cockpit.db" if os.getenv("VERCEL") else str(ROOT / "data" / "cockpit.db"),
    )

    # HTTP client timeout (seconds)
    HTTP_TIMEOUT: float = float(os.getenv("HTTP_TIMEOUT", "10"))


settings = Settings()

# Ensure data dir exists
Path(settings.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
