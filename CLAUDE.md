# lighter-cockpit

FastAPI analytics site for the **Lighter** exchange / LIT token — hl.eco-parity dashboard.
Repo `Darrennen/LighterDash`, deployed on a droplet at `/opt/lighter-cockpit`.

- Canonical shareable URL: **https://146-190-91-223.sslip.io** — always give Darren this,
  not the bare IP. The bare-IP form silently fails for recipients (link-preview bots try
  HTTPS first; port 443 originally had nothing listening). Cert auto-renews via
  `certbot.timer`; nginx config at `/etc/nginx/sites-enabled/lighter-cockpit`.
- Deploy: git push, then on the VPS run `scripts/update.sh` (git pull + pip install +
  `systemctl restart lighter-cockpit`).
- **Live DB is `data/cockpit.db`** — NOT the `lighter.db` sitting in the repo root.

## Lighter API walls (verified live)

`/api/v1/pnl` returns "account not found" anonymously; `/trades`, `/accountOrders*`,
`/positionFunding` are auth-gated. `/liquidations` needs an `account_index` — it is a
per-account lookup, not a global feed (the WS `trade` channel's `type` field is the only
global liquidation source).

**CORRECTION 2026-09-15: `/pnlLeaderboard` IS public and unauthenticated.** It returns
rank, l1_address, account_value, pnl, roi, volume. The older "no public leaderboard or
PnL endpoint" note here was wrong and is what drove the self-computed leaderboard and the
FIFO explorer-log reconstruction. Re-test that assumption before building around it.

- Legacy leaderboards are **self-computed** from `recentTrades` polling (hard cap 100/call, no cursor).
- Per-account PnL / win-rate is **FIFO-reconstructed** from
  `explorer.elliot.ai/api/accounts/{addr}/logs` (offset-paginated, 100/page, no auth).
- Lighter's WAF blocks request bursts (Cloudflare "Human Verification" 405s, then a temp
  IP block). Cap concurrency ~8 and stagger startup sweeps. **The Mac's IP gets
  temp-blocked** — verify locally via a scratchpad proxy (VPS `/api` + local static).
- `/account`, `/accountsByL1Address`, `/orderBookDetails`, `/funding-rates` are
  intermittently 429/405/403 even from the VPS. `lighter_client.py` raises
  `UpstreamUnavailable` so pages show an honest 503 rather than a misleading
  "account not found".
- `account_type`: 0 = standard, 1 = sub-account. **Sub-accounts get indices near 2^48 and
  are REAL traders — never filter by index magnitude.** Only exclude known pool accounts
  (`SYSTEM_ACCOUNTS` in `app/db.py`; LIT staking pool = 281474976710654).

## Trade ingestion — WebSocket, not polling (2026-09-15)

`lit_trades` is filled by `app/services/ws_collector.py`, a lifespan task on
`wss://mainnet.zklighter.elliot.ai/stream`, channel `trade/{market_id}`.

- **Never move LIT ingestion back onto request-driven polling.** It used to run inside
  `_maybe_refresh()` on each API hit, so the ledger only filled while somebody had the page
  open — a 98.8h hole opened Sep 11→15 and the page rendered it as `$0` under a green light.
- **`recentTrades` polling is size-biased.** Measured against the exchange's own 24h
  counters it captured 78% of prints but only **32% of notional** — it misses large fills
  between polls. The stream gets ~96% / ~82%. REST is now a fallback used only while the
  socket is down.
- **Spot (2049) reports `usd_amount: 0`** — compute price×size for spot, or you record real
  trades as zero volume. Perp populates it.
- `is_maker_ask` is a real bool on the stream (183/183 observed). If it is ever missing the
  side is UNKNOWN (`taker_is_buyer = 2`), surfaced as `unknown_usd` — the old REST
  normaliser defaulted it to `True`, silently classifying unknown volume as buys.
- `trade.type` is `trade | liquidation | deleverage | market-settlement`, stored in
  `lit_trades.trade_type`. This is the **only** global liquidation feed.
- `/api/lit/coverage` is the honesty gate: observed %, ledger age, gaps >5min, stream
  health. The page's status light derives from it. **Never set the light from HTTP 200.**

## Sampling is a published number, not a footnote

Any card built on `lit_trades` is a sample of the tape, not the tape. Cards that mix it
with exchange-reported figures must label provenance (`prov-x` = exchange, `prov-o` =
observed) — the KPI row used to show ~$59K of buy+sell volume beside the exchange's own
$28.2M 24h volume with identical styling.

Thresholds must be scaled to what the ledger can actually produce. The old single
`whaleMin` gated both a single print and a 10-min cumulative at $50K–$1M, while the largest
observed print was $2.5K and the busiest 10-min account-side total was $10.4K — the TWAP
card could not fire at any setting. Same class of bug as the Liquidations card.

## Data shape gotchas

- **`market_history` has NO volume column** (only funding / oi / price). Volume history
  must come from `all_trades`, which has ~8d retention.
- **Candle queries must be bounded to the range their resolution claims.**
  `fetch_lit_candles_db` used to return the last `count` NON-EMPTY buckets from all
  history, so a "5m" chart silently spanned 56 days. It now filters `ts >= now - bucket*count`
  and the route publishes `range_start`/`range_end` so the client scales x by TIME.
- **Chart x-axes are time-scaled, never array-index-scaled.** With a sparse ledger,
  index spacing gave the last 5 days two-thirds of a "30d" chart with no axis to reveal it.
- `/api/candles` 1h data for LIT is sparse snapshot-fallback (13 bars, v=0) while 1d
  returns ~35 real bars — the hero chart defaults to 1D. LIT candles are built server-side
  from the local `lit_trades` ledger (`fetch_lit_candles_db` in `db.py`) because upstream
  `/api/lit/candles` returns `[]`.
- `account_snapshots` is a point-in-time UPSERT keyed on `account_index` with **no history
  table** — trend-over-time charts need a new daily-logging cron + table first. Don't ship
  a trend chart without building that.
- `/holders` tracks **whale + mega only (≥100K LIT)**, in both the scan *and* the display.
  Coverage is inherently partial (only accounts observed trading) and every stat is
  labelled "tracked accounts" / "N scanned" — never implying completeness.

## UI

Design system lives in `static/styles.css`: blue-black canvas `#060a12`, ice-blue prism
accent `#6fb9ff`, bento cards, floating pill header, Instrument Sans (UI) + JetBrains Mono
(numerals). All pages inherit via shared CSS var names.

- **Static assets are version-stamped** (`/static/*.css?v=YYYYMMDDx`) — BUMP the version in
  all templates on every static-file change or browsers serve a stale mixed UI.
- `el.style.display = ''` only "shows" an element if no stylesheet rule also sets
  `display:none`. With `<style>#errorBox{display:none}</style>` on the page, clearing the
  inline override falls back to that rule and the element stays hidden forever — silent
  failure. Grep for `style.display = ''` when refactoring show/hide logic.
- An uncaught `ReferenceError` in a top-level `<script type="module">` halts **all**
  subsequent boot code, not just that call. After any interrupted multi-agent edit, grep
  for dangling function calls and DOM-id references and re-syntax-check every touched file
  before trusting a worker's self-report.
