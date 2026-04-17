# Lighter Analyst Cockpit

A local monitoring dashboard for the [Lighter.xyz](https://lighter.xyz) perpetual DEX. FastAPI backend polls the public Lighter REST API on a configurable interval, normalises the data, caches it in memory, and persists funding-rate + open-interest history to SQLite. A single-page HTML frontend polls the backend and renders everything.

> Runs entirely on your machine. No API keys required — uses only Lighter's public mainnet endpoints.

## What you get

**Live panels** (refreshed on poll)
- KPI strip — total 24h volume, total OI, active/listed markets, 24h trades, top gainer/loser
- All markets table — price, 24h %, volume, OI, funding, trades; sortable, filterable, price flashes
- Large Trades feed — configurable threshold ($10k → $1M) with whale tier badges
- Funding heatmap — color-coded by magnitude, hover for annualised APR
- Buy/Sell aggressor flow — delta bar plus per-market CVD leaderboard
- Liquidations — trades flagged with the liquidation bit
- Movers — gainers, losers, volume leaders

**Historical** (from SQLite)
- Click any market row (or any heatmap cell) → drawer opens with a timeseries chart
- Toggle between funding / OI / price · 24h / 3d / 7d windows
- Default retention: 30 days (configurable)

## Quick start

```bash
git clone https://github.com/<you>/lighter-cockpit.git
cd lighter-cockpit
./scripts/run.sh
```

That script creates a `.venv`, installs deps, and launches uvicorn on http://127.0.0.1:8000.

Or manually:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000 in your browser. API docs are at http://127.0.0.1:8000/docs.

## Configuration

Copy `.env.example` to `.env` and tweak:

| Variable | Default | Meaning |
|---|---|---|
| `COLLECT_INTERVAL` | `5` | Seconds between collector ticks |
| `TOP_N_MARKETS` | `15` | Only the top-N volume markets get their trade feed pulled |
| `RECENT_TRADES_LIMIT` | `50` | Trades per market per tick |
| `HISTORY_RETENTION_DAYS` | `30` | SQLite rows older than this are pruned hourly |
| `DB_PATH` | `data/cockpit.db` | SQLite file location |
| `WHALE_DEFAULT_USD` | `50000` | Trade size threshold for tagging; frontend threshold is adjustable live |

## Architecture

```
┌────────────────┐   poll 5s    ┌──────────────────┐
│  Lighter API   │ ◄─────────── │  collector task  │
└────────────────┘              │  (asyncio loop)  │
                                └────────┬─────────┘
                                         │ normalise
                                         ▼
                     ┌───────────────────────────────┐
                     │  in-memory Store              │
                     │  (markets, trade ring-buffer) │
                     └───────┬───────────────┬───────┘
                             │               │
                             ▼               ▼
                     ┌──────────────┐  ┌──────────────┐
                     │  SQLite      │  │  REST API    │
                     │  (funding +  │  │  /api/*      │
                     │   OI history)│  └──────┬───────┘
                     └──────┬───────┘         │
                            │                 │ poll 5s/15s/60s
                            └──── /history ───┤
                                              ▼
                                      ┌──────────────┐
                                      │  HTML / JS   │
                                      │  dashboard   │
                                      └──────────────┘
```

### Design decisions

- **Single collector, shared state** — one async task polls Lighter, everything else reads the in-memory cache. Means one request to Lighter regardless of how many browser tabs you have open.
- **SQLite only persists what's useful for analysis** — funding rates and OI are the two metrics that benefit from a timeseries view. Trade history is volatile (in-memory only) because it's lossy to begin with.
- **Normalisation lives in `lighter_client.py`** — Lighter's response shape varies by endpoint and sometimes has multiple key aliases (`market_id` vs `marketId`, etc.). All defensive parsing is isolated to one module.
- **Frontend is zero-build** — vanilla JS module, no bundler, no React. You can edit `static/app.js` and refresh.

## Project layout

```
lighter-cockpit/
├── app/
│   ├── main.py              # FastAPI app + lifespan + static mounts
│   ├── config.py            # env-driven settings
│   ├── db.py                # SQLite schema, writes, queries
│   ├── routes/
│   │   └── api.py           # /api/status, /markets, /trades, /flow, /history/{id}
│   └── services/
│       ├── lighter_client.py # async HTTP wrapper + normalisation
│       ├── store.py          # in-memory cache
│       └── collector.py      # background tick loop
├── static/
│   ├── app.js               # frontend controller
│   └── styles.css
├── templates/
│   └── index.html
├── scripts/
│   └── run.sh
├── requirements.txt
├── .env.example
└── .gitignore
```

## API reference

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Collector + DB status |
| `GET /api/markets` | All markets (latest snapshot) + summary |
| `GET /api/trades?limit=200&min_usd=0&market_id=…` | Trade buffer |
| `GET /api/flow?limit=500` | Aggressor buy/sell totals + per-market CVD |
| `GET /api/history/{market_id}?field=funding&hours=24` | Timeseries for one market |

Interactive docs: http://127.0.0.1:8000/docs

## Extension ideas

- **Alerts** — cron a small script that hits `/api/markets`, checks thresholds (e.g. funding > 0.1% or OI delta > X), fires a Telegram/Discord webhook.
- **Additional history fields** — add `volume_24h` or `price_change` columns to `market_history` and expand the `field` enum in `db.py:fetch_history`.
- **Account tracking** — call `/api/v1/accountsByL1Address` to track a specific wallet's positions and PnL alongside market data.
- **WebSocket push** — swap polling for Lighter's WS feed if you want true real-time tick data (Lighter publishes a WS gateway; you'd plug it into `collector.py` and add a broadcaster to `store.py`).

## Caveats

- Lighter's REST schema isn't fully spelled out in their public docs page. The normaliser has fallback logic for the common field shapes (`is_maker_ask`, `taker_side`, `side`); if you hit one that doesn't parse, check browser devtools → Network and add the variant in `app/services/collector.py:_normalise_trade`.
- Liquidations are derived from trade flags. For account-level liquidation history you need the `/liquidations` endpoint with an address.
- The funding heatmap assumes 8-hour funding epochs when computing the annualised APR (rate × 3 × 365). Adjust if Lighter changes cadence.

## License

MIT — do whatever you want with it.
