# Lighter Analyst Cockpit

A real-time analytics dashboard for [Lighter.xyz](https://lighter.xyz) — a ZK-rollup perpetual DEX. Tracks live market data, LIT token flows, whale activity, and individual wallet behaviour across all trading pairs.

**Live demo:** [146.190.91.223](http://146.190.91.223) &nbsp;·&nbsp; **Built by:** [@Darrenyap488378](https://x.com/Darrenyap488378)

> No API keys required — uses only Lighter's public mainnet endpoints.

---

## Features

### Overview Dashboard (`/`)
- **KPI strip** — 24h volume, total open interest, active markets, trade count, top gainer/loser
- **Markets table** — real-time price, 24h change %, volume, OI, funding rate, trade count; sortable and filterable with live price flash
- **Whale feed** — large-trade alerts with configurable size threshold ($10K → $1M+)
- **Funding heatmap** — colour-coded across all markets, hover for annualised APR
- **Buy/sell flow** — aggressor imbalance bars + per-market cumulative volume delta (CVD) leaderboard
- **Liquidation feed** — real-time detection from trade flags
- **Historical charts** — click any market to open a drawer with funding / OI / price timeseries (24h / 3d / 7d)

### LIT Token Tracker (`/lit`)
- Real-time LIT perp (#120) and spot (#2049) prices with 24h change
- Flow analysis windows — 24h, 7d, 30d, all-time; switch without re-fetching
- Live trades feed with buyer/seller account IDs, sizes in USD and LIT tokens
- **Tracked wallets panel** — follow any account's buy/sell metrics by number
- Candle chart (5m / 15m / 1h / 4h / 1d) using the Lighter candles API
- Order book depth heatmap (2-second refresh)
- TWAP alert detection for sustained aggressive order patterns
- Cross-exchange funding rate comparison for LIT-PERP
- Top buyers / sellers ranked by USD volume over configurable periods
- Protocol buyback statistics and treasury balance data
- Staking pool activity and aggregate stats

### Account Explorer (`/explorer`)
- Lookup by account number or 0x Ethereum address
- Current positions, asset balances, and collateral breakdown
- LIT staking details — shares held, staked USDC value, pending unlock schedule
- Full personal trade history with market, side, price, size, and counterparty

### Watchlist (`/watchlist`)
- Track and label any number of accounts without connecting a wallet
- Aggregate summary bar — total buy, sell, net flow, and net LIT across all tracked accounts
- Per-account cards with unrealised PnL vs current LIT price (avg buy price vs live price)
- Resolved wallet addresses cached in localStorage — skips address lookup on future refreshes
- Auto-refreshes every 2 minutes; period toggle (24h / 7d / 30d) switches all cards instantly

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Python 3.11+, FastAPI, Uvicorn |
| **Persistence** | SQLite via aiosqlite — 30-day retention, auto-pruned |
| **HTTP client** | httpx — async, connection-pooled |
| **Frontend** | Vanilla JS (ES modules) — zero build step, no framework |
| **Charting** | SVG + Canvas API — hand-rolled, no chart library dependency |
| **Styling** | CSS custom properties, responsive grid layout |
| **Deployment** | DigitalOcean VPS · nginx reverse proxy · systemd service |
| **Alt deploy** | Vercel serverless via `api/index.py` |

---

## Architecture

```
Lighter.xyz public API  ←── background collector (5s poll)
         │
  lighter_client.py          normalises varied API response shapes
         │
    ┌────┴────┐
  store.py  db.py            in-memory cache  +  SQLite history
         │
  FastAPI routes             /api/*   /api/lit/*   /api/explorer/*
         │
  Vanilla JS frontend        polls backend, renders live dashboards
```

**Design decisions:**
- **Single collector, shared state** — one async task polls Lighter; all browser tabs share the cache. One upstream request regardless of client count.
- **SQLite persists only what's useful** — funding rates and OI are written to history. Trade data is in-memory only (it's lossy by nature).
- **Normalisation in one place** — `lighter_client.py` handles all API shape variants so the rest of the codebase sees a consistent schema.
- **Zero-build frontend** — plain ES modules, edit and refresh. No bundler, no Node dependency.

---

## Getting Started

### Prerequisites
- Python 3.11+

### Quick start

```bash
git clone https://github.com/Darrennen/LighterDash.git
cd LighterDash
./scripts/run.sh
```

Opens at `http://127.0.0.1:8000`. The script creates a virtualenv and installs dependencies automatically.

### Manual setup

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # edit if needed
uvicorn app.main:app --reload
```

### Configuration

| Variable | Default | Description |
|---|---|---|
| `LIGHTER_API` | `https://mainnet.zklighter.elliot.ai/api/v1` | Upstream API base |
| `COLLECT_INTERVAL` | `5` | Seconds between collector ticks |
| `TOP_N_MARKETS` | `15` | Markets included in the trade feed |
| `HISTORY_RETENTION_DAYS` | `30` | SQLite history window |
| `DB_PATH` | `./data/cockpit.db` | SQLite file path |
| `ENABLE_DOCS` | `0` | Set to `1` to expose `/docs` (Swagger UI) |

---

## API Reference

All endpoints are **read-only** (`GET` only). CORS is open. Per-IP rate limiting applies to expensive routes.

### Core

| Endpoint | Description |
|---|---|
| `GET /api/status` | Collector and DB health |
| `GET /api/markets` | All markets snapshot + summary |
| `GET /api/trades` | Recent trade buffer (`limit`, `min_usd`, `market_id`) |
| `GET /api/flow` | Aggressor buy/sell totals and per-market CVD |
| `GET /api/candles/{market_id}` | OHLCV candles (`resolution`, `count`) |
| `GET /api/history/{market_id}` | Field timeseries (`field=funding\|oi_usd\|last_price`, `hours`) |
| `GET /health` | Health check |

### LIT Tracker

| Endpoint | Description |
|---|---|
| `GET /api/lit/summary` | LIT perp + spot prices and stats |
| `GET /api/lit/trades` | Recent LIT trades |
| `GET /api/lit/flow` | Buy/sell flow totals by window |
| `GET /api/lit/account-flow-live` | Live account flow from explorer (no DB required) |
| `GET /api/lit/leaders` | Top buyers/sellers by volume (`hours`, `top_n`) |
| `GET /api/lit/funding` | Cross-exchange LIT-PERP funding rate comparison |
| `GET /api/lit/orderbook` | Live order book snapshot |
| `GET /api/lit/candles` | LIT OHLCV candles |
| `GET /api/lit/staking-stats` | Pool-wide staking statistics |
| `GET /api/lit/buybacks` | Protocol buyback data |

### Explorer

| Endpoint | Description |
|---|---|
| `GET /api/explorer/account` | Lookup by account number or 0x address |
| `GET /api/explorer/history` | Full personal trade history |

---

## Deployment

### VPS (recommended — persistent SQLite history)

```bash
# On a fresh Ubuntu 24.04 server
bash scripts/setup_vps.sh
```

One command sets up the Python venv, systemd service, and nginx reverse proxy.

To deploy new code after pushing:

```bash
bash scripts/update.sh   # git pull + pip install + systemctl restart
```

### Vercel (serverless)

`vercel.json` and `api/index.py` are included. Connect the repo to Vercel — it auto-deploys on push. SQLite history is ephemeral on Vercel (resets on cold starts); use VPS for persistent data.

---

## Project Structure

```
lighter-cockpit/
├── app/
│   ├── main.py               # FastAPI app, lifespan, route registration
│   ├── config.py             # Environment-based settings
│   ├── db.py                 # SQLite schema, writes, queries
│   └── routes/
│       ├── api.py            # Core market endpoints
│       ├── lit.py            # LIT token tracker endpoints
│       └── explorer.py       # Account explorer endpoints
│   └── services/
│       ├── lighter_client.py # Async Lighter API wrapper + normalisation
│       ├── collector.py      # Background polling loop + backfill logic
│       ├── store.py          # In-memory data cache
│       └── ratelimit.py      # Per-IP rate limiter
├── static/
│   ├── app.js                # Overview dashboard controller
│   ├── lit.js                # LIT tracker UI logic
│   ├── explorer.js           # Account explorer logic
│   ├── watchlist.js          # Watchlist manager
│   └── styles.css            # Dark theme, responsive layout
├── templates/
│   ├── index.html            # Overview dashboard
│   ├── lit.html              # LIT tracker
│   ├── explorer.html         # Account explorer
│   └── watchlist.html        # Watchlist
├── scripts/
│   ├── run.sh                # Local dev launcher
│   ├── setup_vps.sh          # One-command VPS provisioning
│   └── update.sh             # Pull and restart on VPS
├── api/
│   └── index.py              # Vercel serverless entry point
├── requirements.txt
├── vercel.json
└── .env.example
```

---

## Data Source

All data is fetched from Lighter's public REST API and explorer index. No API key is required. This project is independent and not affiliated with Lighter.xyz.

---

## License

MIT — see [LICENSE](LICENSE).

---

*Built by [Darren](https://x.com/Darrenyap488378)*
