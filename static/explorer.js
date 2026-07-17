/* ──────────────────────────────────────────────────────────────
   Lighter Account Explorer
   ────────────────────────────────────────────────────────────── */

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ── tracked wallets (shared localStorage key with lit.js) ─────
const TW_KEY = 'lit_tracked_v1';
function twExplorerGet() {
  try { return JSON.parse(localStorage.getItem(TW_KEY) || '[]'); } catch { return []; }
}
function twExplorerToggle(account_id) {
  const list = twExplorerGet();
  const idx  = list.findIndex(w => w.account_id === account_id);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push({ account_id, label: '', added_at: Date.now() });
  }
  localStorage.setItem(TW_KEY, JSON.stringify(list));
  // re-render button
  const isNow = list.some(w => w.account_id === account_id);
  const btn = document.getElementById('explorerTrackBtn');
  if (btn) {
    btn.textContent = isNow ? '★ Tracked' : '☆ Track';
    btn.style.border = `1px solid ${isNow ? 'var(--accent)' : 'var(--line-2)'}`;
    btn.style.background = isNow ? 'rgba(242,193,78,0.12)' : 'transparent';
    btn.style.color = isNow ? 'var(--accent)' : 'var(--ink-dim)';
  }
}

const fmtUsd = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(2) + 'K';
  return sign + '$' + abs.toFixed(2);
};
const fmtNum = (n, dp = 4) => n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtLit = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(2) + 'K';
  return sign + abs.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const fmtMYT = ts => {
  const d = typeof ts === 'string' ? new Date(ts) : new Date(ts > 1e12 ? ts : ts * 1000);
  return d.toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur', hour12: false,
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
};
const truncAddr = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';

let _currentAccountIndex = null;
let _portfolioValue = 0;  // used by renderPositions for allocation bars

// ── tab switching ─────────────────────────────────────────────

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'lit-history' && _histAddress) {
      loadHistory(_histOffset);
    }
    if (tab.dataset.tab === 'lit-flow' && _currentAccountIndex) {
      loadLitFlow(_currentAccountIndex);
    }
  });
});

// ── portfolio summary ─────────────────────────────────────────

function renderPortfolioSummary(data, priceMap = {}) {
  const positions = data.positions || [];
  const assets    = data.assets || [];
  const staking   = data.lit_staking || {};
  const collateral = parseFloat(data.collateral || 0);
  const avail      = parseFloat(data.available_balance || 0);

  const apiVal    = parseFloat(data.total_asset_value || 0);
  const spotEst   = assets.reduce((s, a) => s + parseFloat(a.balance || 0) * (priceMap[a.symbol] ?? 0), 0);
  const portfolio = apiVal > 0 ? apiVal : collateral + spotEst;
  _portfolioValue = portfolio;

  const totalPosVal  = positions.reduce((s, p) => s + Math.abs(parseFloat(p.position_value || 0)), 0);
  const stakingVal   = parseFloat(staking.staked_usdc_value || 0);
  const unrealPnl    = positions.reduce((s, p) => s + parseFloat(p.unrealized_pnl || 0), 0);
  const leverage     = collateral > 0 ? totalPosVal / collateral : 0;

  // bias
  let longVal = 0, shortVal = 0;
  positions.forEach(p => {
    const v = Math.abs(parseFloat(p.position_value || 0));
    if (parseInt(p.sign || 0) >= 0) longVal += v; else shortVal += v;
  });
  const biasTotal = longVal + shortVal;
  const longPct   = biasTotal > 0 ? longVal / biasTotal * 100 : 50;
  let biasLabel, biasColor;
  if (biasTotal === 0)     { biasLabel = 'No Positions'; biasColor = 'var(--ink-faint)'; }
  else if (longPct > 75)   { biasLabel = '▲ Strong Long';   biasColor = 'var(--green)'; }
  else if (longPct > 55)   { biasLabel = '↑ Slightly Long'; biasColor = 'var(--green)'; }
  else if (longPct > 45)   { biasLabel = '→ Balanced';      biasColor = 'var(--ink-dim)'; }
  else if (longPct > 25)   { biasLabel = '↓ Slightly Short';biasColor = 'var(--red)'; }
  else                      { biasLabel = '▼ Strong Short';  biasColor = 'var(--red)'; }

  // equity
  $('#cardPortfolio').textContent = fmtUsd(portfolio);
  $('#cardCollateral').textContent = fmtUsd(collateral);
  $('#cardAvail').textContent = fmtUsd(avail);
  $('#cardOrders').textContent = data.pending_order_count ?? '—';

  // allocation bar
  const tot = portfolio || 1;
  const perpPct  = Math.min((totalPosVal / tot * 100), 100).toFixed(1);
  const stakePct = Math.min((stakingVal  / tot * 100), 100).toFixed(1);
  const freePct  = Math.max(0, 100 - parseFloat(perpPct) - parseFloat(stakePct)).toFixed(1);
  const dot = color => `<span style="display:inline-block;width:8px;height:8px;background:${color};border-radius:1px;margin-right:4px;vertical-align:middle"></span>`;
  $('#pAllocBar').innerHTML = `
    <div style="width:${perpPct}%;background:var(--blue);transition:width .4s"></div>
    <div style="width:${stakePct}%;background:var(--amber);transition:width .4s"></div>
    <div style="flex:1;background:var(--green);opacity:.5"></div>`;
  $('#pAllocLabels').innerHTML =
    `<span>${dot('var(--blue)')}Perps ${perpPct}%</span>` +
    (stakingVal > 0 ? `<span>${dot('var(--amber)')}Staking ${stakePct}%</span>` : '') +
    `<span>${dot('var(--green)')}Free ${freePct}%</span>`;

  // bias
  const biasEl = $('#pBias');
  biasEl.textContent = biasLabel;
  biasEl.style.color = biasColor;
  $('#pBiasFill').style.width = longPct + '%';
  $('#pBiasFill').style.background = longPct > 50 ? 'var(--green)' : 'var(--red)';

  // leverage arc gauge
  updateLevGauge(leverage);

  // unrealized pnl
  const pnlEl = $('#pUnrealPnl');
  pnlEl.textContent = unrealPnl !== 0 ? (unrealPnl >= 0 ? '+' : '') + fmtUsd(unrealPnl) : '—';
  pnlEl.style.color = unrealPnl > 0 ? 'var(--green)' : unrealPnl < 0 ? 'var(--red)' : '';
}

// ── leverage arc gauge ────────────────────────────────────────

function _polar(cx, cy, r, deg) {
  const rad = deg * Math.PI / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}
function _arc(cx, cy, r, startDeg, sweepDeg) {
  const [sx, sy] = _polar(cx, cy, r, startDeg);
  const endDeg = startDeg + sweepDeg;
  const [ex, ey] = _polar(cx, cy, r, endDeg);
  const large = Math.abs(sweepDeg) > 180 ? 1 : 0;
  const sweep = sweepDeg >= 0 ? 1 : 0;
  return `M ${sx.toFixed(2)},${sy.toFixed(2)} A ${r},${r} 0 ${large},${sweep} ${ex.toFixed(2)},${ey.toFixed(2)}`;
}

function updateLevGauge(leverage) {
  const track = $('#levTrack');
  const fill  = $('#levFillArc');
  const dot   = $('#levDot');
  const txt   = $('#levText');
  if (!track) return;

  const CX = 60, CY = 50, R = 37;
  const START = 150, TOTAL = 240, MAX_LEV = 20;

  const color = leverage > 10 ? '#ff6a77' : leverage > 5 ? '#f2c14e' : '#6fe089';
  const fraction = leverage > 0 ? Math.min(leverage / MAX_LEV, 1) : 0;
  const sweep = fraction * TOTAL;
  const dotAngle = START + sweep;
  const [dx, dy] = _polar(CX, CY, R, dotAngle);

  track.setAttribute('d', _arc(CX, CY, R, START, TOTAL));
  track.setAttribute('stroke', '#1d2124');

  if (leverage > 0) {
    fill.setAttribute('d', _arc(CX, CY, R, START, Math.max(sweep, 1)));
    fill.setAttribute('stroke', color);
    fill.style.display = '';
    dot.setAttribute('cx', dx.toFixed(2));
    dot.setAttribute('cy', dy.toFixed(2));
    dot.setAttribute('fill', color);
    dot.style.display = '';
  } else {
    fill.style.display = 'none';
    dot.style.display = 'none';
  }

  txt.textContent = leverage > 0 ? leverage.toFixed(1) + 'x' : '—';
  txt.setAttribute('fill', leverage > 0 ? color : 'var(--ink-faint)');
}

// ── trade flow chart ──────────────────────────────────────────

let _fillSeries = [];
let _flowPeriod = 'all';

async function fetchFillsBackground(address, accountIndex) {
  const empty = $('#flowChartEmpty');
  const svg   = $('#flowChart');
  const total = $('#flowPnlTotal');
  if (empty) { empty.style.display = ''; empty.textContent = 'loading trade history…'; }
  if (svg) svg.style.display = 'none';
  if (total) { total.textContent = '—'; total.style.color = ''; }
  _fillSeries = [];

  try {
    const allFills = [];
    for (let page = 0; page < 4; page++) {
      const res = await fetch(
        `/api/explorer/history?address=${encodeURIComponent(address)}&account_index=${accountIndex}&limit=100&offset=${page * 100}`
      ).then(r => r.json());
      const trades = res.trades || [];
      allFills.push(...trades);
      if (trades.length < 100) break;
    }
    _fillSeries = computeFlowSeries(allFills);
    renderFlowChart(_flowPeriod);
  } catch {
    if (empty) { empty.style.display = ''; empty.textContent = 'could not load trade history'; }
  }
}

function computeFlowSeries(fills) {
  const sorted = [...fills].sort((a, b) => new Date(a.time) - new Date(b.time));
  let cum = 0;
  return sorted.map(f => {
    const isBuy = (f.role === 'taker' && f.taker_is_buyer === 1) || (f.role === 'maker' && f.taker_is_buyer === 0);
    const usd = parseFloat(f.price) * parseFloat(f.size);
    cum += isBuy ? -usd : usd;
    return { t: new Date(f.time).getTime(), v: cum };
  });
}

function filterSeriesByPeriod(series, period) {
  if (period === 'all' || !series.length) return series;
  const ms = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[period];
  if (!ms) return series;
  const cutoff = Date.now() - ms;
  const after  = series.filter(p => p.t >= cutoff);
  const before = series.filter(p => p.t < cutoff);
  if (before.length && after.length) {
    return [{ t: cutoff, v: before[before.length - 1].v }, ...after];
  }
  return after.length ? after : series;
}

function renderFlowChart(period) {
  _flowPeriod = period;
  const series = filterSeriesByPeriod(_fillSeries, period);
  const total  = $('#flowPnlTotal');
  if (!series.length) {
    const empty = $('#flowChartEmpty');
    const svg   = $('#flowChart');
    if (svg) svg.style.display = 'none';
    if (empty) { empty.style.display = ''; empty.textContent = 'no trade history in this window'; }
    if (total) { total.textContent = '—'; total.style.color = ''; }
    return;
  }
  const lastVal = series[series.length - 1].v;
  const color = lastVal >= 0 ? 'var(--green)' : 'var(--red)';
  if (total) {
    total.style.color = color;
    total.textContent = (lastVal >= 0 ? '+' : '') + fmtUsd(lastVal);
  }
  drawFlowChart(series);
}

function drawFlowChart(series) {
  const svg   = $('#flowChart');
  const empty = $('#flowChartEmpty');
  if (!svg || !series.length) return;
  svg.style.display = 'block';
  if (empty) empty.style.display = 'none';

  const W = 400, H = 100, P = 3;
  const times = series.map(p => p.t);
  const vals  = series.map(p => p.v);
  const minT  = Math.min(...times), maxT = Math.max(...times);
  const minV  = Math.min(...vals, 0), maxV = Math.max(...vals, 0);
  const rangeT = (maxT - minT) || 1;
  const rangeV = (maxV - minV) || 1;

  const toX = t => P + (t - minT) / rangeT * (W - P * 2);
  const toY = v => H - P - (v - minV) / rangeV * (H - P * 2);
  const z   = toY(0);

  const pts = series.map(p => `${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`).join(' ');
  const firstX = toX(times[0]).toFixed(1);
  const lastX  = toX(times[times.length - 1]).toFixed(1);
  const area   = `M ${firstX},${z.toFixed(1)} ` +
    series.map(p => `L ${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`).join(' ') +
    ` L ${lastX},${z.toFixed(1)} Z`;

  const lastVal = vals[vals.length - 1];
  const col = lastVal >= 0 ? '#6fe089' : '#ff6a77';

  svg.innerHTML = `
    <defs>
      <linearGradient id="fgUp" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#6fe089" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#6fe089" stop-opacity="0.03"/>
      </linearGradient>
      <linearGradient id="fgDn" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#ff6a77" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#ff6a77" stop-opacity="0.03"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${z.toFixed(1)}" x2="${W}" y2="${z.toFixed(1)}" stroke="#1d2124" stroke-width="1"/>
    <path d="${area}" fill="url(#${lastVal >= 0 ? 'fgUp' : 'fgDn'})" stroke="none"/>
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  `;
}

// ── trader PnL (hero stats + PnL tab, from /api/traders/pnl) ──

const PNL_POLL_MAX_ATTEMPTS = 6;
const PNL_POLL_INTERVAL_MS = 3000;

let _pnlData = null;
let _pnlPollTimer = null;
let _pnlAccountIndex = null;

function resetPnlUI() {
  clearTimeout(_pnlPollTimer);
  _pnlPollTimer = null;
  _pnlData = null;
  const heroPnl = $('#heroPnl');
  heroPnl.textContent = '—';
  heroPnl.style.color = '';
  $('#heroWinRate').textContent = '—';
  $('#heroStreak').innerHTML = '—';
  $('#heroVolume').textContent = '—';
  $('#heroLongShort').innerHTML = '—';
  $('#pnlHeroCaveat').textContent = 'building trader stats…';
  $('#pnlChartEmpty').style.display = '';
  $('#pnlChartEmpty').textContent = 'building…';
  $('#pnlChart').style.display = 'none';
  $('#pnlClosedBody').innerHTML = `<tr><td colspan="6" class="empty">building…</td></tr>`;
}

async function loadTradersPnl(accountIndex, attempt = 0) {
  _pnlAccountIndex = accountIndex;
  try {
    const res = await fetch(`/api/traders/pnl?query=${accountIndex}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (_pnlAccountIndex !== accountIndex) return; // account changed since request fired

    if (data.status && data.status !== 'ready') {
      if (attempt < PNL_POLL_MAX_ATTEMPTS) {
        _pnlPollTimer = setTimeout(() => loadTradersPnl(accountIndex, attempt + 1), PNL_POLL_INTERVAL_MS);
      } else {
        $('#pnlHeroCaveat').textContent = 'still building — check back shortly';
        $('#pnlChartEmpty').textContent = 'still building — check back shortly';
      }
      return;
    }

    _pnlData = data;
    renderPnlHero(data);
    renderPnlTab(data);
  } catch {
    if (attempt < PNL_POLL_MAX_ATTEMPTS) {
      _pnlPollTimer = setTimeout(() => loadTradersPnl(accountIndex, attempt + 1), PNL_POLL_INTERVAL_MS);
    } else {
      $('#pnlHeroCaveat').textContent = 'PnL data unavailable right now';
      $('#pnlChartEmpty').textContent = 'PnL data unavailable right now';
    }
  }
}

function renderPnlHero(data) {
  const pnl = parseFloat(data.realized_pnl_est || 0);
  const pnlEl = $('#heroPnl');
  pnlEl.textContent = (pnl >= 0 ? '+' : '') + fmtUsd(pnl);
  pnlEl.style.color = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : '';

  const wins = data.wins || 0, losses = data.losses || 0;
  $('#heroWinRate').textContent = data.win_rate != null
    ? `${(data.win_rate * 100).toFixed(1)}% (${wins}W/${losses}L)`
    : (wins + losses > 0 ? `${wins}W/${losses}L` : '—');

  const best = data.best_streak, worst = data.worst_streak;
  $('#heroStreak').innerHTML = (best != null || worst != null)
    ? `<span style="color:var(--green)">${best ?? '—'}W</span> / <span style="color:var(--red)">${worst ?? '—'}L</span>`
    : '—';

  $('#heroVolume').textContent = data.volume_usd != null ? fmtUsd(data.volume_usd) : '—';

  const lp = data.long_pnl, sp = data.short_pnl;
  $('#heroLongShort').innerHTML = (lp != null || sp != null)
    ? `<span style="color:${(lp ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtUsd(lp ?? 0)}</span> / <span style="color:${(sp ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtUsd(sp ?? 0)}</span>`
    : '—';

  const cov = data.coverage || {};
  $('#pnlHeroCaveat').textContent = cov.fills != null
    ? `est. from ${cov.fills} fill${cov.fills !== 1 ? 's' : ''}${cov.since_ts ? ' since ' + fmtMYT(cov.since_ts) : ''}, fees excl.${cov.complete === false ? ' · partial coverage' : ''}`
    : 'estimates reconstructed from on-chain fills, fees excl.';
}

function renderPnlTab(data) {
  const series = (data.pnl_timeseries || []).map(([t, v]) => ({
    t: t > 1e12 ? t : t * 1000,
    v: parseFloat(v),
  }));
  drawPnlChart(series);

  const rows = data.recent_closed || [];
  const tbody = $('#pnlClosedBody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">no closed round-trips yet</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const pnl = parseFloat(r.pnl || 0);
    const pnlCls = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
    const isLong = (r.side || '').toLowerCase() === 'long';
    return `<tr>
      <td style="font-weight:600">${r.symbol || '—'}</td>
      <td><span class="pill ${isLong ? 'buy' : 'sell'}">${r.side || '—'}</span></td>
      <td class="num">$${fmtNum(parseFloat(r.entry), 4)} → $${fmtNum(parseFloat(r.exit), 4)}</td>
      <td class="num">${fmtNum(parseFloat(r.size), 2)}</td>
      <td class="num ${pnlCls}" style="font-weight:600">${(pnl >= 0 ? '+' : '') + fmtUsd(pnl)}</td>
      <td class="num" style="color:var(--ink-faint);font-size:11px">${r.closed_ts ? fmtMYT(r.closed_ts) : '—'}</td>
    </tr>`;
  }).join('');
}

function drawPnlChart(series) {
  const svg = $('#pnlChart');
  const empty = $('#pnlChartEmpty');
  if (!svg) return;
  if (!series.length) {
    svg.style.display = 'none';
    if (empty) { empty.style.display = ''; empty.textContent = 'no closed trades yet'; }
    return;
  }
  svg.style.display = 'block';
  if (empty) empty.style.display = 'none';

  const W = 400, H = 120, P = 3;
  const times = series.map(p => p.t);
  const vals  = series.map(p => p.v);
  const minT  = Math.min(...times), maxT = Math.max(...times);
  const minV  = Math.min(...vals, 0), maxV = Math.max(...vals, 0);
  const rangeT = (maxT - minT) || 1;
  const rangeV = (maxV - minV) || 1;

  const toX = t => P + (t - minT) / rangeT * (W - P * 2);
  const toY = v => H - P - (v - minV) / rangeV * (H - P * 2);
  const z   = toY(0);

  const pts = series.map(p => `${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`).join(' ');
  const firstX = toX(times[0]).toFixed(1);
  const lastX  = toX(times[times.length - 1]).toFixed(1);
  const area   = `M ${firstX},${z.toFixed(1)} ` +
    series.map(p => `L ${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`).join(' ') +
    ` L ${lastX},${z.toFixed(1)} Z`;

  const lastVal = vals[vals.length - 1];
  const col = lastVal >= 0 ? '#6fe089' : '#ff6a77';

  svg.innerHTML = `
    <defs>
      <linearGradient id="pgUp" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#6fe089" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#6fe089" stop-opacity="0.03"/>
      </linearGradient>
      <linearGradient id="pgDn" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#ff6a77" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#ff6a77" stop-opacity="0.03"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${z.toFixed(1)}" x2="${W}" y2="${z.toFixed(1)}" stroke="#1d2124" stroke-width="1"/>
    <path d="${area}" fill="url(#${lastVal >= 0 ? 'pgUp' : 'pgDn'})" stroke="none"/>
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  `;
}

// ── render functions ──────────────────────────────────────────

function renderAccount(data, priceMap = {}) {
  $('#results').style.display = '';
  const idx = data.account_index;
  _currentAccountIndex = idx;

  $('#acctTitle').textContent = `Account #${idx}`;
  const addr = data.l1_address || '';
  $('#acctAddr').childNodes[0].textContent = addr || 'no address on file';
  const extLink = $('#acctExtLink');
  if (addr) {
    extLink.href = `https://app.lighter.xyz/explorer/accounts/${addr}`;
    extLink.style.display = '';
  } else {
    extLink.style.display = 'none';
  }

  const statusLabel = data.status === 1 ? '● Active' : '○ Inactive';
  const statusColor = data.status === 1 ? 'var(--green)' : 'var(--ink-faint)';
  const staking = data.lit_staking || {};
  const stakingBadge = staking.is_staking
    ? `<span style="margin-left:10px;padding:2px 8px;border:1px solid var(--accent);border-radius:2px;font-size:10px;letter-spacing:.1em;color:var(--accent)">LIT STAKING</span>`
    : '';
  $('#acctStatus').innerHTML = `<span style="color:${statusColor};font-size:12px">${statusLabel}</span>${stakingBadge}`;
  // track button — attach listener directly (module scope, can't use inline onclick)
  const trackBtn = document.createElement('button');
  trackBtn.id = 'explorerTrackBtn';
  Object.assign(trackBtn.style, {
    marginLeft: '12px', padding: '3px 12px', fontFamily: 'var(--font-mono)',
    fontSize: '10px', letterSpacing: '.1em', textTransform: 'uppercase',
    cursor: 'pointer', borderRadius: '3px', transition: 'all .15s',
  });
  const applyTrackState = tracked => {
    trackBtn.textContent = tracked ? '★ Tracked' : '☆ Track';
    trackBtn.style.border = `1px solid ${tracked ? 'var(--accent)' : 'var(--line-2)'}`;
    trackBtn.style.background = tracked ? 'rgba(242,193,78,0.12)' : 'transparent';
    trackBtn.style.color = tracked ? 'var(--accent)' : 'var(--ink-dim)';
  };
  applyTrackState(twExplorerGet().some(w => w.account_id === idx));
  trackBtn.addEventListener('click', () => {
    twExplorerToggle(idx);
    applyTrackState(twExplorerGet().some(w => w.account_id === idx));
  });
  $('#acctStatus').appendChild(trackBtn);

  const watchLink = document.createElement('a');
  watchLink.className = 'ext-link';
  watchLink.style.marginLeft = '10px';
  watchLink.href = `/watch?q=${idx}`;
  watchLink.target = '_blank';
  watchLink.textContent = 'watch live ↗';
  $('#acctStatus').appendChild(watchLink);

  renderPortfolioSummary(data, priceMap);

  // tab counts
  const positions = data.positions || [];
  const assets    = data.assets    || [];
  $('[data-tab="positions"]').textContent  = `Positions${positions.length ? ' (' + positions.length + ')' : ''}`;
  $('[data-tab="assets"]').textContent     = `Assets${assets.length ? ' (' + assets.length + ')' : ''}`;

  renderPositions(positions, _portfolioValue);
  renderAssets(assets, priceMap, _portfolioValue);
  renderLitStaking(data.lit_staking || {});

  // prime history state — loads on tab click
  _histAddress      = data.l1_address || '';
  _histAccountIndex = idx;

  // background fetch for flow chart
  _flowPeriod = 'all';
  $$('[data-flow-period]').forEach(b => b.classList.toggle('active', b.dataset.flowPeriod === 'all'));
  fetchFillsBackground(_histAddress, idx);

  // background fetch for trader PnL hero + PnL tab (may not be live yet — polls/retries quietly)
  resetPnlUI();
  loadTradersPnl(idx);

  _histOffset = 0;
  $('#litHistBody').innerHTML = `<tr><td colspan="7" class="empty">click the "Trade History" tab to load</td></tr>`;
  $('#histPrevBtn').style.display = 'none';
  $('#histNextBtn').style.display = 'none';
  $('#histPageInfo').textContent = '';
}

function renderPositions(positions, totalPortfolio = 0) {
  const tbody = $('#posBody');
  if (!positions.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty">no open positions</td></tr>`;
    return;
  }

  positions.sort((a, b) => Math.abs(parseFloat(b.position_value)) - Math.abs(parseFloat(a.position_value)));

  let totalLong = 0, totalShort = 0, totalPnl = 0, totalFunding = 0;
  positions.forEach(p => {
    const isLong = parseInt(p.sign) >= 0;
    const v = Math.abs(parseFloat(p.position_value || 0));
    if (isLong) totalLong += v; else totalShort += v;
    totalPnl     += parseFloat(p.unrealized_pnl || 0);
    totalFunding += parseFloat(p.total_funding_paid_out || 0);
  });

  tbody.innerHTML = positions.map(p => {
    const isLong   = parseInt(p.sign) >= 0;
    const size     = parseFloat(p.position);
    const pnl      = parseFloat(p.unrealized_pnl || 0);
    const funding  = parseFloat(p.total_funding_paid_out || 0);
    const posVal   = Math.abs(parseFloat(p.position_value || 0));
    const pnlCls   = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
    const sideCls  = isLong ? 'pos-long' : 'pos-short';
    const roe      = posVal > 0 ? pnl / posVal * 100 : 0;
    const roeSign  = roe >= 0 ? '+' : '';

    const liqPrice  = parseFloat(p.liquidation_price);
    const markPrice = posVal > 0 && Math.abs(size) > 0 ? posVal / Math.abs(size) : 0;
    const distPct   = liqPrice > 0 && markPrice > 0
      ? Math.abs(markPrice - liqPrice) / markPrice * 100
      : null;
    const distColor = distPct === null ? '' : distPct < 8 ? '#ff6a77' : distPct < 18 ? '#f2c14e' : '#6fe089';
    const liqDisplay = liqPrice > 0 ? `$${liqPrice.toFixed(4)}` : '—';

    const allocPct = totalPortfolio > 0 ? (posVal / totalPortfolio * 100) : 0;
    const allocBar = `<div style="display:flex;align-items:center;gap:6px;justify-content:flex-end">
      <div style="width:50px;height:4px;background:var(--line);border-radius:2px">
        <div style="height:100%;width:${Math.min(allocPct,100).toFixed(1)}%;background:var(--blue);border-radius:2px"></div>
      </div>
      <span style="min-width:32px;text-align:right;color:var(--ink-dim)">${allocPct.toFixed(1)}%</span>
    </div>`;

    return `<tr>
      <td style="font-weight:600">${p.symbol}</td>
      <td><span class="pill ${isLong ? 'buy' : 'sell'}">${isLong ? 'long' : 'short'}</span></td>
      <td class="num ${sideCls}">${fmtNum(size, 2)}</td>
      <td class="num">$${fmtNum(parseFloat(p.avg_entry_price), 4)}</td>
      <td class="num">${fmtUsd(posVal)}</td>
      <td class="num ${pnlCls}" style="font-weight:600">
        <div>${fmtUsd(pnl)}</div>
        ${posVal > 0 ? `<div style="font-size:10px;margin-top:1px;opacity:.8">${roeSign}${roe.toFixed(1)}%</div>` : ''}
      </td>
      <td class="num">
        <div style="color:var(--red)">${liqDisplay}</div>
        ${distPct !== null ? `
        <div style="margin-top:3px">
          <div style="width:54px;height:3px;background:var(--line);border-radius:2px;margin-left:auto">
            <div style="height:100%;width:${Math.min(distPct,100).toFixed(1)}%;background:${distColor};border-radius:2px"></div>
          </div>
          <div style="font-size:9px;color:${distColor};margin-top:1px">${distPct.toFixed(1)}% away</div>
        </div>` : ''}
      </td>
      <td class="num" style="color:var(--ink-dim)">${funding !== 0 ? fmtUsd(funding) : '—'}</td>
      <td class="num">${allocBar}</td>
    </tr>`;
  }).join('');

  const sumPnlColor = totalPnl >= 0 ? 'var(--green)' : 'var(--red)';
  tbody.innerHTML += `<tr style="border-top:1px solid var(--line-2);background:rgba(224,255,107,0.02)">
    <td colspan="9" style="padding:9px 8px">
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px;align-items:baseline">
        <span style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)">Summary</span>
        <span><span style="font-size:9px;color:var(--ink-faint)">Long </span><span style="color:var(--green);font-weight:600">${fmtUsd(totalLong)}</span></span>
        <span><span style="font-size:9px;color:var(--ink-faint)">Short </span><span style="color:var(--red);font-weight:600">${fmtUsd(totalShort)}</span></span>
        <span style="color:var(--line-2)">·</span>
        <span><span style="font-size:9px;color:var(--ink-faint)">Unrealized PnL </span><span style="font-weight:700;color:${sumPnlColor}">${(totalPnl >= 0 ? '+' : '') + fmtUsd(totalPnl)}</span></span>
        <span><span style="font-size:9px;color:var(--ink-faint)">Funding </span><span style="color:var(--ink-dim)">${totalFunding !== 0 ? fmtUsd(totalFunding) : '—'}</span></span>
      </div>
    </td>
  </tr>`;
}

function renderAssets(assets, priceMap = {}, totalPortfolio = 0) {
  const tbody = $('#assetBody');
  if (!assets.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">no spot assets held</td></tr>`;
    return;
  }

  let totalUsd = 0;
  const computed = assets.map(a => {
    const bal    = parseFloat(a.balance);
    const locked = parseFloat(a.locked_balance || 0);
    const price  = priceMap[a.symbol];
    const usdVal = price != null ? bal * price : null;
    if (usdVal != null) totalUsd += usdVal;
    return { a, bal, locked, usdVal };
  });

  const port = totalPortfolio || totalUsd || 1;

  const rows = computed.map(({ a, bal, locked, usdVal }) => {
    const usdDisplay = usdVal != null
      ? `<span style="font-weight:${usdVal >= 1000 ? '600' : '400'}">${fmtUsd(usdVal)}</span>`
      : `<span style="color:var(--ink-faint)">—</span>`;
    const allocPct = usdVal != null ? Math.min(usdVal / port * 100, 100) : 0;
    const allocBar = `<div style="display:flex;align-items:center;gap:6px;justify-content:flex-end">
      <div style="width:50px;height:4px;background:var(--line);border-radius:2px">
        <div style="height:100%;width:${allocPct.toFixed(1)}%;background:var(--green);border-radius:2px"></div>
      </div>
      <span style="min-width:32px;text-align:right;color:var(--ink-dim)">${allocPct.toFixed(1)}%</span>
    </div>`;

    return `<tr>
      <td style="font-weight:600">${a.symbol}</td>
      <td class="num">${fmtNum(bal, 6)}</td>
      <td class="num">${usdDisplay}</td>
      <td class="num">${allocBar}</td>
      <td class="num" style="color:${locked > 0 ? 'var(--amber)' : 'var(--ink-faint)'}" title="${locked > 0 ? 'Reserved for pending limit orders' : ''}">${locked > 0 ? fmtNum(locked, 6) : '—'}</td>
    </tr>`;
  }).join('');

  const totalRow = totalUsd > 0
    ? `<tr style="border-top:1px solid var(--line);font-weight:600">
        <td style="color:var(--ink-faint);font-size:10px;letter-spacing:.1em;text-transform:uppercase">Total</td>
        <td></td>
        <td class="num">${fmtUsd(totalUsd)}</td>
        <td></td><td></td>
       </tr>`
    : '';

  tbody.innerHTML = rows + totalRow;
}

function renderLitStaking(s) {
  const el = $('#litStakingPanel');

  const freeBalance = s.lit_free_balance || 0;
  const isStaking   = s.is_staking || false;
  const stakedUsd   = s.staked_usdc_value || 0;
  const shares      = s.shares_amount || 0;
  const entryUsdc   = s.entry_usdc || 0;
  const unlocks     = s.pending_unlocks || [];

  const pnl = stakedUsd - entryUsdc;
  const pnlCls  = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
  const pnlSign = pnl >= 0 ? '+' : '';

  const stakingStatus = isStaking
    ? `<span style="color:var(--green);font-size:20px;font-weight:700">● Staking</span>`
    : `<span style="color:var(--ink-faint);font-size:20px">○ Not staking</span>`;

  const stakedBlock = isStaking ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin-top:14px">
      <div style="background:var(--bg);padding:14px 18px">
        <div class="card-lbl">Staked Value (USDC)</div>
        <div class="card-val" style="color:var(--green)">${fmtUsd(stakedUsd)}</div>
      </div>
      <div style="background:var(--bg);padding:14px 18px">
        <div class="card-lbl">Entry Value (USDC)</div>
        <div class="card-val">${entryUsdc > 0 ? fmtUsd(entryUsdc) : '—'}</div>
      </div>
      <div style="background:var(--bg);padding:14px 18px">
        <div class="card-lbl">Staking PnL</div>
        <div class="card-val ${pnlCls}">${entryUsdc > 0 ? pnlSign + fmtUsd(pnl) : '—'}</div>
      </div>
      <div style="background:var(--bg);padding:14px 18px">
        <div class="card-lbl">Shares Held</div>
        <div class="card-val">${Number(shares).toLocaleString()}</div>
      </div>
    </div>` : '';

  const unlocksBlock = unlocks.length ? `
    <div style="margin-top:14px">
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--amber);margin-bottom:6px">
        ⚠ Pending Unstake Requests
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left;font-size:10px;color:var(--ink-faint);padding:4px 8px">Amount</th>
          <th style="text-align:right;font-size:10px;color:var(--ink-faint);padding:4px 8px">Unlock Time</th>
        </tr></thead>
        <tbody>${unlocks.map(u => `<tr>
          <td style="padding:4px 8px;font-variant-numeric:tabular-nums">${fmtUsd(parseFloat(u.usdc_amount || u.amount || 0))}</td>
          <td style="padding:4px 8px;text-align:right;color:var(--amber);font-size:11px">${u.unlock_time ? fmtMYT(u.unlock_time) + ' MYT' : '—'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>` : '';

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-bottom:4px">
      <div>${stakingStatus}</div>
      <div style="margin-left:auto">
        <div class="card-lbl">LIT Spot (free / unstaked)</div>
        <div style="font-size:18px;font-variant-numeric:tabular-nums;font-weight:500">
          ${freeBalance > 0 ? Number(freeBalance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' LIT' : '—'}
        </div>
      </div>
    </div>
    ${stakedBlock}
    ${unlocksBlock}
    ${!isStaking && freeBalance === 0 ? `<div style="margin-top:14px;color:var(--ink-faint);font-size:12px">This account holds no LIT tokens and is not staking.</div>` : ''}
  `;
}

const HIST_PAGE = 100;
let _histOffset = 0;
let _histMarket = '';
let _histAddress = '';
let _histAccountIndex = null;

async function loadHistory(offset = 0) {
  _histOffset = offset;
  const tbody = $('#litHistBody');
  tbody.innerHTML = `<tr><td colspan="7" class="empty">loading…</td></tr>`;
  $('#histPrevBtn').style.display = 'none';
  $('#histNextBtn').style.display = 'none';
  $('#histPageInfo').textContent = '';

  if (!_histAddress) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">search an account to see their trade history</td></tr>`;
    return;
  }

  try {
    const mq = _histMarket ? `&market_id=${_histMarket}` : '';
    const res = await fetch(
      `/api/explorer/history?address=${encodeURIComponent(_histAddress)}&account_index=${_histAccountIndex}&limit=${HIST_PAGE}&offset=${offset}${mq}`
    ).then(r => r.json());

    const trades = res.trades || [];
    // explorer API caps at 100 per page — if we got a full page, assume there's more
    const hasNext = trades.length === HIST_PAGE;

    if (!trades.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">no trades found${_histMarket ? ' for this market filter' : ''}${offset > 0 ? ' — you may have reached the end' : ''}</td></tr>`;
      if (offset > 0) {
        $('#histPrevBtn').style.display = '';
      }
      return;
    }

    const mktName = id => id === 120 ? 'LIT PERP' : id === 2049 ? 'LIT SPOT' : `#${id}`;

    tbody.innerHTML = trades.map(t => {
      const isBuy = t.taker_is_buyer === 1;
      const counterparty = t.role === 'taker' ? t.maker_account_index : t.taker_account_index;
      const price = parseFloat(t.price || 0);
      const size  = parseFloat(t.size  || 0);
      const usd   = price * size;
      const bigFlag = usd >= 100000
        ? `<span style="color:${isBuy ? 'var(--green)' : 'var(--red)'};margin-left:4px;font-size:9px">●</span>`
        : '';
      const rolePill = t.role === 'maker'
        ? `<span style="font-size:9px;padding:1px 5px;border:1px solid var(--line-2);border-radius:2px;color:var(--ink-faint)">maker</span>`
        : `<span style="font-size:9px;padding:1px 5px;border:1px solid var(--accent);border-radius:2px;color:var(--accent)">taker</span>`;
      return `<tr>
        <td style="color:var(--ink-faint);font-size:11px">${fmtMYT(t.time)}</td>
        <td style="color:var(--ink-faint);font-size:10px">${mktName(t.market_id)}</td>
        <td><span class="pill ${isBuy ? 'buy' : 'sell'}">${isBuy ? 'buy' : 'sell'}</span>${bigFlag}</td>
        <td>${rolePill}</td>
        <td class="num">$${price.toFixed(4)}</td>
        <td class="num">${size.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="num" style="color:var(--ink-faint);font-size:11px">
          <a href="/explorer?q=${counterparty}" target="_blank"
             style="color:var(--ink-faint);text-decoration:none" title="Open in explorer">#${counterparty} ↗</a>
        </td>
      </tr>`;
    }).join('');

    const page = Math.floor(offset / HIST_PAGE) + 1;
    $('#histPageInfo').textContent = `page ${page} · showing ${offset + 1}–${offset + trades.length}`;
    if (offset > 0) $('#histPrevBtn').style.display = '';
    if (hasNext)    $('#histNextBtn').style.display = '';
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty" style="color:var(--red)">error: ${e.message}</td></tr>`;
  }
}

// ── flow period buttons ───────────────────────────────────────

$$('[data-flow-period]').forEach(b => {
  b.addEventListener('click', () => {
    $$('[data-flow-period]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    renderFlowChart(b.dataset.flowPeriod);
  });
});

// ── history market filter buttons ─────────────────────────────
$$('[data-hist-market]').forEach(b => {
  b.addEventListener('click', () => {
    $$('[data-hist-market]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    _histMarket = b.dataset.histMarket;
    loadHistory(0);
  });
});

$('#histPrevBtn').addEventListener('click', () => loadHistory(Math.max(0, _histOffset - HIST_PAGE)));
$('#histNextBtn').addEventListener('click', () => loadHistory(_histOffset + HIST_PAGE));

// ── LIT flow overview ─────────────────────────────────────────

let _flowMarket = '';
let _flowData = null;

$$('[data-flow-market]').forEach(b => {
  b.addEventListener('click', () => {
    $$('[data-flow-market]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    _flowMarket = b.dataset.flowMarket;
    if (_currentAccountIndex) loadLitFlow(_currentAccountIndex);
  });
});

async function loadLitFlow(accountId) {
  const grid = $('#litFlowGrid');
  const msg = $('#flowLoadingMsg');
  if (!grid) return;
  grid.innerHTML = `<div style="background:var(--bg);padding:20px;color:var(--ink-faint);font-size:11px;grid-column:1/-1">loading from explorer…</div>`;
  if (msg) msg.textContent = 'fetching…';

  try {
    const mq = _flowMarket ? `&market_id=${_flowMarket}` : '';
    const addrQ = _histAddress ? `&address=${encodeURIComponent(_histAddress)}` : '';
    _flowData = await fetch(`/api/lit/account-flow-live?account_id=${accountId}${addrQ}${mq}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status));
    renderLitFlow(_flowData);
    if (msg) msg.textContent = '';
  } catch (e) {
    grid.innerHTML = `<div style="background:var(--bg);padding:20px;color:var(--red);font-size:11px;grid-column:1/-1">failed to load: ${e.message}</div>`;
    if (msg) msg.textContent = '';
  }
}

function renderLitFlow(data) {
  const grid = $('#litFlowGrid');
  if (!grid || !data) return;

  const periods = ['24h', '7d', '30d'];
  const labels = { '24h': '24 Hours', '7d': '7 Days', '30d': '30 Days' };

  grid.innerHTML = periods.map(p => {
    const d = data[p] || {};
    const buy = d.buy_usd || 0;
    const sell = d.sell_usd || 0;
    const net = d.net_usd || 0;
    const buyT = d.buy_trades || 0;
    const sellT = d.sell_trades || 0;
    const total = buy + sell || 1;
    const buyPct = (buy / total * 100).toFixed(1);
    const sellPct = (100 - buyPct).toFixed(1);
    const netCls = net >= 0 ? 'color:var(--green)' : 'color:var(--red)';
    const noData = buy === 0 && sell === 0;

    return `<div style="background:var(--bg);padding:18px">
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:12px">${labels[p]}</div>
      ${noData ? `<div style="color:var(--ink-faint);font-size:11px">no LIT trades found in this window</div>` : `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--green);margin-bottom:3px">Buy</div>
          <div style="font-size:16px;font-weight:600;color:var(--green);font-variant-numeric:tabular-nums">${fmtUsd(buy)}</div>
          ${d.buy_size ? `<div style="font-size:11px;color:var(--green);opacity:0.75;font-variant-numeric:tabular-nums;margin-top:1px">${fmtLit(d.buy_size)} LIT</div>` : ''}
          <div style="font-size:10px;color:var(--ink-faint);margin-top:2px">${buyT} trade${buyT !== 1 ? 's' : ''}</div>
          ${d.buy_avg_price != null ? `<div style="font-size:10px;color:var(--ink-dim);margin-top:3px">avg $${Number(d.buy_avg_price).toFixed(4)}</div>` : ''}
        </div>
        <div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--red);margin-bottom:3px">Sell</div>
          <div style="font-size:16px;font-weight:600;color:var(--red);font-variant-numeric:tabular-nums">${fmtUsd(sell)}</div>
          ${d.sell_size ? `<div style="font-size:11px;color:var(--red);opacity:0.75;font-variant-numeric:tabular-nums;margin-top:1px">${fmtLit(d.sell_size)} LIT</div>` : ''}
          <div style="font-size:10px;color:var(--ink-faint);margin-top:2px">${sellT} trade${sellT !== 1 ? 's' : ''}</div>
          ${d.sell_avg_price != null ? `<div style="font-size:10px;color:var(--ink-dim);margin-top:3px">avg $${Number(d.sell_avg_price).toFixed(4)}</div>` : ''}
        </div>
      </div>
      <div style="height:4px;background:var(--line);border-radius:2px;overflow:hidden;margin-bottom:8px">
        <div style="height:100%;width:${buyPct}%;background:var(--green);border-radius:2px;display:inline-block"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--ink-faint);margin-bottom:10px">
        <span>${buyPct}% buy</span><span>${sellPct}% sell</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-faint)">Net</span>
        <div style="text-align:right">
          <div style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;${netCls}">${net >= 0 ? '+' : ''}${fmtUsd(net)}</div>
          ${d.net_size != null ? `<div style="font-size:10px;font-variant-numeric:tabular-nums;${netCls};opacity:0.75">${d.net_size >= 0 ? '+' : ''}${fmtLit(d.net_size)} LIT</div>` : ''}
        </div>
      </div>`}
    </div>`;
  }).join('');
}

// ── search ────────────────────────────────────────────────────

async function doSearch() {
  const query = $('#searchInput').value.trim();
  if (!query) return;

  $('#errorBox').style.display = 'none';
  $('#results').style.display = 'none';
  $('#loadingBox').style.display = '';
  $('#searchBtn').disabled = true;

  try {
    const [r, litRes] = await Promise.all([
      fetch(`/api/explorer/account?query=${encodeURIComponent(query)}`),
      fetch('/api/lit/summary').catch(() => null),
    ]);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${r.status}`);
    }
    const data = await r.json();

    // build price map: LIT price from the spot market, USDC always $1
    const priceMap = { USDC: 1.0 };
    if (litRes?.ok) {
      const lit = await litRes.json();
      const litPrice = lit?.spot?.last_price ?? lit?.perp?.last_price;
      if (litPrice) priceMap['LIT'] = parseFloat(litPrice);
    }

    renderAccount(data, priceMap);

    // switch to positions tab by default
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    $('[data-tab="positions"]').classList.add('active');
    $('#tab-positions').classList.add('active');
  } catch (e) {
    $('#errorBox').textContent = 'Account not found: ' + e.message;
    $('#errorBox').style.display = '';
  } finally {
    $('#loadingBox').style.display = 'none';
    $('#searchBtn').disabled = false;
  }
}

$('#searchBtn').addEventListener('click', doSearch);
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// pre-fill from URL param ?q=
const urlQ = new URLSearchParams(location.search).get('q');
if (urlQ) {
  $('#searchInput').value = urlQ;
  doSearch();
}
