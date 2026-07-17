/* ─────────────────────────────────────────────────────────────
   Traders — hl.eco-style leaderboard for Lighter
   Talks to /api/traders/* (leaderboard, positions, status).
   ───────────────────────────────────────────────────────────── */

const $ = s => document.querySelector(s);

const state = {
  window: '24h',        // most-active-traders window toggle
  posSort: 'notional',  // biggest-open-positions sort toggle
  tick: 0,
};

// ── formatters (match app.js / watchlist.js conventions) ───────
const fmtUsd = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(2) + 'K';
  return sign + '$' + abs.toFixed(2);
};
const fmtSignedUsd = n => (n == null || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + fmtUsd(n);
const fmtNum = n => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtPx = n => (n == null || isNaN(n) || n === 0) ? '—' : '$' + Number(n).toFixed(Math.abs(n) < 10 ? 4 : 2);
const fmtPct1 = n => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(1) + '%';
const fmtLev = n => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(1) + 'x';
const fmtDate = ts => {
  if (ts == null) return null;
  const t = ts > 1e12 ? ts : ts * 1000;
  if (!t) return null;
  return new Date(t).toLocaleString('en-GB', { hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

// distance-to-liquidation color (matches explorer.js thresholds)
const distColor = pct => pct == null ? 'var(--ink-faint)' : pct < 8 ? 'var(--red)' : pct < 18 ? 'var(--amber)' : 'var(--green)';

async function apiGet(path) {
  try {
    const r = await fetch(path);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function setStatus(kind, text) {
  const dot = $('#statusDot'), txt = $('#statusText');
  if (!dot || !txt) return;
  dot.className = 'dot' + (kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
  txt.textContent = text;
}

// account cell: links to /explorer?q= + a small watch affordance to /watch?q=
function acctCell(idx) {
  if (idx == null) return '—';
  return `<a href="/explorer?q=${idx}" class="acct-link">#${idx}</a>` +
         `<a href="/watch?q=${idx}" class="watch-link" title="Watch live">watch</a>`;
}

// ── KPI strip ────────────────────────────────────────────────
function renderKpis(lb24h, positionsByNotional, status) {
  $('#kpi-vol').textContent = lb24h ? fmtUsd(lb24h.totals?.volume_usd) : '—';
  $('#kpi-vol-sub').textContent = lb24h ? 'quote · tracked trades' : 'waiting for ingest';

  $('#kpi-trades').textContent = lb24h ? fmtNum(lb24h.totals?.trades) : '—';
  $('#kpi-trades-sub').textContent = 'executions · 24h';

  $('#kpi-traders').textContent = lb24h ? fmtNum(lb24h.totals?.unique_accounts) : '—';
  $('#kpi-traders-sub').textContent = 'unique accounts';

  const biggestPos = (positionsByNotional?.positions || [])[0];
  $('#kpi-biggest-pos').textContent = biggestPos ? fmtUsd(biggestPos.notional_usd) : '—';
  $('#kpi-biggest-pos-sub').textContent = biggestPos ? `#${biggestPos.account_index} · ${biggestPos.symbol}` : 'no positions scanned yet';

  const leaders = lb24h?.leaders || [];
  const biggestTrade = leaders.length ? Math.max(...leaders.map(l => l.biggest_trade_usd || 0)) : null;
  $('#kpi-biggest-trade').textContent = biggestTrade ? fmtUsd(biggestTrade) : '—';
  $('#kpi-biggest-trade-sub').textContent = 'single fill · 24h';

  const since = fmtDate(lb24h?.data_since);
  $('#kpi-since').textContent = since || '—';
  const scanned = status?.accounts_scanned ?? status?.row_counts?.account_snapshots;
  $('#kpi-since-sub').textContent = scanned != null ? `${fmtNum(scanned)} accounts scanned` : 'ingest building history…';
}

// ── most active traders table ───────────────────────────────
function renderLeaderboard(lb) {
  const tbody = $('#activeBody');
  const since = fmtDate(lb?.data_since);
  $('#activeDataSince').textContent = since ? `tracking since ${since}` : '';

  const leaders = lb?.leaders || [];
  if (!lb) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">leaderboard unavailable — backend not reachable</td></tr>`;
    return;
  }
  if (!leaders.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">no trades tracked yet for this window</td></tr>`;
    return;
  }

  tbody.innerHTML = leaders.map((l, i) => {
    const buy = l.buy_usd || 0, sell = l.sell_usd || 0;
    const total = buy + sell || 1;
    const buyPct = (buy / total * 100).toFixed(1);
    const sellPct = (100 - buyPct).toFixed(1);
    const netCls = (l.net_usd || 0) >= 0 ? 'up' : 'down';
    const markets = (l.top_symbols || []).join(' · ') || '—';
    return `<tr>
      <td class="rank">${i + 1}</td>
      <td>${acctCell(l.account_index)}</td>
      <td class="num">${fmtUsd(l.volume_usd)}</td>
      <td class="num">${fmtNum(l.trades)}</td>
      <td class="num">
        <div class="flow-bar" style="height:6px;width:64px;margin-left:auto">
          <div style="background:var(--green);width:${buyPct}%"></div>
          <div style="background:var(--red);width:${sellPct}%"></div>
        </div>
        <div style="font-size:9px;color:var(--ink-faint);margin-top:2px">${buyPct}% / ${sellPct}%</div>
      </td>
      <td class="num ${netCls}">${fmtSignedUsd(l.net_usd)}</td>
      <td style="color:var(--ink-dim);font-size:11px">${markets}</td>
      <td class="num">${fmtUsd(l.biggest_trade_usd)}</td>
    </tr>`;
  }).join('');
}

// ── biggest open positions table ────────────────────────────
function renderPositions(positions) {
  const tbody = $('#posBody');
  const list = positions?.positions || [];
  if (!positions) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty">positions unavailable — backend not reachable</td></tr>`;
    return;
  }
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty">no open positions scanned yet</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(p => {
    const isLong = p.side === 'long';
    const pnl = p.unrealized_pnl;
    const pnlCls = pnl == null ? '' : pnl >= 0 ? 'up' : 'down';
    const dist = p.liq_distance_pct;
    const liqPx = p.liq_price;
    return `<tr>
      <td>${acctCell(p.account_index)}</td>
      <td class="sym">${p.symbol || '—'}</td>
      <td><span class="pill ${isLong ? 'buy' : 'sell'}">${p.side || '—'}</span></td>
      <td class="num">${fmtNum(p.size)}</td>
      <td class="num">${fmtUsd(p.notional_usd)}</td>
      <td class="num">${fmtPx(p.entry)}</td>
      <td class="num">${fmtPx(p.mark)}</td>
      <td class="num ${pnlCls}">${fmtSignedUsd(pnl)}</td>
      <td class="num">${fmtLev(p.leverage_est)}</td>
      <td class="num">${liqPx ? fmtPx(liqPx) : '—'}</td>
      <td class="num" style="color:${distColor(dist)}">${dist == null ? '—' : fmtPct1(dist)}</td>
    </tr>`;
  }).join('');
}

// ── closest-to-liquidation spotlight ────────────────────────
function renderSpotlight(positionsByLiq) {
  const card = $('#spotlightCard');
  const list = (positionsByLiq?.positions || []).filter(p => p.liq_distance_pct != null);
  if (!list.length) {
    card.innerHTML = `<div class="empty" style="padding:24px 0">no liquidation-risk data yet — positions need a liq_price to rank</div>`;
    return;
  }
  const p = list[0];
  const isLong = p.side === 'long';
  const pnlCls = p.unrealized_pnl == null ? '' : p.unrealized_pnl >= 0 ? 'up' : 'down';
  card.innerHTML = `
    <div style="display:flex;align-items:flex-end;gap:28px;flex-wrap:wrap">
      <div>
        <div class="section-lbl">Distance to Liquidation</div>
        <div class="flow-val" style="font-size:38px;color:${distColor(p.liq_distance_pct)}">${fmtPct1(p.liq_distance_pct)}</div>
      </div>
      <div>
        <div class="section-lbl">Account</div>
        <div style="font-size:15px">${acctCell(p.account_index)}</div>
      </div>
      <div>
        <div class="section-lbl">Market</div>
        <div style="font-size:15px" class="sym">${p.symbol || '—'} <span class="pill ${isLong ? 'buy' : 'sell'}">${p.side || '—'}</span></div>
      </div>
      <div>
        <div class="section-lbl">Notional</div>
        <div style="font-size:15px;font-variant-numeric:tabular-nums">${fmtUsd(p.notional_usd)}</div>
      </div>
      <div>
        <div class="section-lbl">Unrealized PnL</div>
        <div style="font-size:15px;font-variant-numeric:tabular-nums" class="${pnlCls}">${fmtSignedUsd(p.unrealized_pnl)}</div>
      </div>
      <div>
        <div class="section-lbl">Liq Price</div>
        <div style="font-size:15px;font-variant-numeric:tabular-nums">${fmtPx(p.liq_price)}</div>
      </div>
    </div>`;
}

// ── fetch + refresh ──────────────────────────────────────────
async function refreshAll() {
  const [lbSelected, lb24h, posByNotional, posByLiq, status] = await Promise.all([
    apiGet(`/api/traders/leaderboard?window=${state.window}&limit=50`),
    state.window === '24h' ? Promise.resolve(null) : apiGet('/api/traders/leaderboard?window=24h&limit=50'),
    apiGet('/api/traders/positions?sort=notional&limit=50'),
    apiGet('/api/traders/positions?sort=liq&limit=50'),
    apiGet('/api/traders/status'),
  ]);
  const lb24hResolved = state.window === '24h' ? lbSelected : lb24h;

  const anyOk = lbSelected || posByNotional || status;
  setStatus(anyOk ? '' : 'err', anyOk ? 'live' : 'backend unreachable');
  $('#lastSync').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });

  renderKpis(lb24hResolved, posByNotional, status);
  renderLeaderboard(lbSelected);
  renderPositions(state.posSort === 'notional' ? posByNotional : posByLiq);
  renderSpotlight(posByLiq);

  state.tick++;
}

// ── window toggle (most active traders) ─────────────────────
document.querySelectorAll('#windowToggle [data-window]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#windowToggle [data-window]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.window = b.dataset.window;
    refreshAll();
  });
});

// ── sort toggle (biggest open positions) ────────────────────
document.querySelectorAll('#posSortToggle [data-sort]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#posSortToggle [data-sort]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.posSort = b.dataset.sort;
    refreshAll();
  });
});

// ── boot ─────────────────────────────────────────────────────
refreshAll();
setInterval(refreshAll, 30_000);
