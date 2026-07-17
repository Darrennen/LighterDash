/* ──────────────────────────────────────────────────────────────
   Lighter Watch — hl.eco "MLM mode" clone
   Chart-first single-trader spectator view.
   ────────────────────────────────────────────────────────────── */

const $ = s => document.querySelector(s);

// ── formatters (match app.js/explorer.js conventions) ──────────
const fmtUsd = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(2) + 'K';
  return sign + '$' + abs.toFixed(abs < 1 ? 4 : 2);
};
const fmtNum = (n, dp = 2) => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtPx  = n => n == null || isNaN(n) || n === 0 ? '—' : '$' + Number(n).toFixed(4);
const truncAddr = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';

async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

function flashEl(el, dir) {
  if (!el) return;
  el.classList.remove('flash-up', 'flash-dn');
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add(dir === 'up' ? 'flash-up' : 'flash-dn');
}

// ── state ───────────────────────────────────────────────────────
const state = {
  query: null,
  positions: [],
  selectedMarketId: null,
  chartRes: '1h',
  chartData: [],
  prev: {},       // previous top-bar values, for flash-on-change
  profileTimer: null,
  candleTimer: null,
};

// ── empty state: no ?q= param ───────────────────────────────────
const urlQ = new URLSearchParams(location.search).get('q');

$('#watchBtn').addEventListener('click', () => {
  const v = $('#watchInput').value.trim();
  if (v) window.location.href = `/watch?q=${encodeURIComponent(v)}`;
});
$('#watchInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#watchBtn').click(); });

if (!urlQ) {
  $('#promptSection').style.display = '';
} else {
  state.query = urlQ;
  $('#explorerLink').href = `/explorer?q=${encodeURIComponent(urlQ)}`;
  startWatching();
}

function showError(msg) {
  const box = $('#errorBox');
  box.textContent = msg;
  box.style.display = '';
  $('#watchView').style.display = 'none';
}

function clearError() {
  $('#errorBox').style.display = 'none';
}

// ── profile polling ──────────────────────────────────────────────
async function startWatching() {
  await pollProfile();
  state.profileTimer = setInterval(pollProfile, 5000);
  state.candleTimer = setInterval(pollCandles, 30000);
}

async function pollProfile() {
  let data;
  try {
    data = await apiGet(`/api/traders/profile?query=${encodeURIComponent(state.query)}`);
  } catch (e) {
    const msg = String(e.message || '');
    showError(msg.includes('404') ? 'Account not found.' : msg.includes('429') ? 'Rate limited — retrying…' : 'Failed to load profile: ' + msg);
    return;
  }
  clearError();
  $('#watchView').style.display = '';
  renderTopBar(data);
  renderPositions(data.positions || []);
}

function renderTopBar(p) {
  $('#wAcct').textContent = p.account_index != null ? '#' + p.account_index : '—';
  $('#wAddr').textContent = truncAddr(p.l1_address);

  const equity = (p.total_asset_value != null && p.total_asset_value > 0) ? p.total_asset_value : (p.collateral ?? 0);
  const upnl = p.unrealized_pnl_total ?? 0;
  const lev = p.leverage_est;

  const eqEl = $('#wEquity'), upnlEl = $('#wUpnl'), levEl = $('#wLev');

  if (state.prev.equity != null && state.prev.equity !== equity) {
    flashEl(eqEl, equity > state.prev.equity ? 'up' : 'dn');
  }
  if (state.prev.upnl != null && state.prev.upnl !== upnl) {
    flashEl(upnlEl, upnl > state.prev.upnl ? 'up' : 'dn');
  }
  if (state.prev.lev != null && lev != null && state.prev.lev !== lev) {
    flashEl(levEl, lev > state.prev.lev ? 'up' : 'dn');
  }

  eqEl.textContent = fmtUsd(equity);
  upnlEl.textContent = (upnl >= 0 ? '+' : '') + fmtUsd(upnl);
  upnlEl.style.color = upnl > 0 ? 'var(--green)' : upnl < 0 ? 'var(--red)' : 'var(--ink)';
  levEl.textContent = lev != null ? lev.toFixed(1) + 'x' : '—';
  $('#wStatus').textContent = 'updated ' + new Date().toLocaleTimeString('en-GB', { hour12: false });

  state.prev = { equity, upnl, lev };
}

// ── position rail ────────────────────────────────────────────────
function renderPositions(rawPositions) {
  const positions = rawPositions.filter(p => parseFloat(p.position || 0) !== 0);
  state.positions = positions;
  const rail = $('#posRail');
  const mainEl = $('.watch-main');

  if (!positions.length) {
    mainEl.innerHTML = '<div class="panel" style="grid-column:1/-1"><div class="empty-big">no open positions — flat</div></div>';
    return;
  }
  // watch-main may have been replaced by the empty state on a previous poll — restore it
  if (!$('#candleChart')) {
    location.reload();
    return;
  }

  positions.sort((a, b) => Math.abs(parseFloat(b.position_value || 0)) - Math.abs(parseFloat(a.position_value || 0)));

  // default selection = largest notional; keep sticky selection if still open
  const stillOpen = state.selectedMarketId != null && positions.some(p => p.market_id === state.selectedMarketId);
  if (!stillOpen) {
    state.selectedMarketId = positions[0].market_id;
    state.chartData = [];
    pollCandles();
  }

  rail.innerHTML = positions.map(p => {
    const isLong = parseInt(p.sign) >= 0;
    const size = parseFloat(p.position);
    const posVal = Math.abs(parseFloat(p.position_value || 0));
    const entry = parseFloat(p.avg_entry_price || 0);
    const mark = posVal > 0 && Math.abs(size) > 0 ? posVal / Math.abs(size) : 0;
    const pnl = parseFloat(p.unrealized_pnl || 0);
    const funding = parseFloat(p.total_funding_paid_out || 0);
    const liqPrice = parseFloat(p.liquidation_price || 0);
    const distPct = liqPrice > 0 && mark > 0 ? Math.abs(mark - liqPrice) / mark * 100 : null;
    const distColor = distPct === null ? 'var(--ink-faint)' : distPct < 8 ? 'var(--red)' : distPct < 18 ? 'var(--amber)' : 'var(--green)';
    const pnlColor = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--ink)';
    const selected = p.market_id === state.selectedMarketId;

    return `<div class="pos-card${selected ? ' selected' : ''}" data-mid="${p.market_id}">
      <div class="pc-top">
        <span class="pc-sym">${p.symbol}</span>
        <span class="pill ${isLong ? 'buy' : 'sell'}">${isLong ? 'long' : 'short'}</span>
        <span style="margin-left:auto;color:${pnlColor};font-weight:600">${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}</span>
      </div>
      <div class="pc-grid">
        <div><div class="pc-lbl">Size</div>${fmtNum(Math.abs(size), 3)}</div>
        <div><div class="pc-lbl">Notional</div>${fmtUsd(posVal)}</div>
        <div><div class="pc-lbl">Entry</div>${fmtPx(entry)}</div>
        <div><div class="pc-lbl">Mark</div>${fmtPx(mark)}</div>
        <div><div class="pc-lbl">Funding Paid</div>${funding !== 0 ? fmtUsd(funding) : '—'}</div>
        <div><div class="pc-lbl">Liq. Price</div><span style="color:var(--red)">${liqPrice > 0 ? fmtPx(liqPrice) : '—'}</span></div>
      </div>
      ${distPct !== null ? `
      <div class="pc-liqbar"><div style="width:${Math.min(distPct, 100).toFixed(1)}%;background:${distColor}"></div></div>
      <div style="font-size:9px;color:${distColor};margin-top:2px">${distPct.toFixed(1)}% from liq</div>` : ''}
    </div>`;
  }).join('');

  rail.querySelectorAll('.pos-card').forEach(card => {
    card.addEventListener('click', () => {
      const mid = parseInt(card.dataset.mid, 10);
      if (mid === state.selectedMarketId) return;
      state.selectedMarketId = mid;
      state.chartData = [];
      rail.querySelectorAll('.pos-card').forEach(c => c.classList.toggle('selected', parseInt(c.dataset.mid, 10) === mid));
      $('#candleChart').innerHTML = '<div style="color:var(--ink-faint);font-size:11px;padding:12px 0">loading…</div>';
      pollCandles();
    });
  });

  // keep chart overlay (entry/liq) fresh against latest position data even between candle refetches
  drawCandleChart(state.chartData);
}

function selectedPosition() {
  return state.positions.find(p => p.market_id === state.selectedMarketId) || null;
}

// ── candle chart ──────────────────────────────────────────────────
document.querySelectorAll('[data-res]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-res]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.chartRes = b.dataset.res;
    state.chartData = [];
    $('#candleChart').innerHTML = '<div style="color:var(--ink-faint);font-size:11px;padding:12px 0">loading…</div>';
    pollCandles();
  });
});

async function pollCandles() {
  if (state.selectedMarketId == null) return;
  const mid = state.selectedMarketId;
  let data;
  try {
    data = await apiGet(`/api/candles/${mid}?resolution=${state.chartRes}&count=180`);
  } catch (e) {
    console.warn('candles fetch failed:', e.message);
    return;
  }
  if (mid !== state.selectedMarketId) return; // selection changed while in flight
  state.chartData = data.candles || [];
  $('#chartSym').textContent = data.symbol || selectedPosition()?.symbol || '—';
  drawCandleChart(state.chartData);
}

function _normCandle(c) {
  const ts = c.open_time || c.time || c.t || c.timestamp || 0;
  const o = parseFloat(c.open || c.o || 0);
  const h = parseFloat(c.high || c.h || 0);
  const l = parseFloat(c.low || c.l || 0);
  const cl = parseFloat(c.close || c.c || 0);
  return { ts: Number(ts), o, h, l, c: cl };
}

function drawCandleChart(candles) {
  const el = $('#candleChart');
  const axisEl = $('#chartAxisLabel');
  const legendEl = $('#chartLegend');
  if (!el) return;

  const pos = selectedPosition();
  const entry = pos ? parseFloat(pos.avg_entry_price || 0) : null;
  const liq = pos ? parseFloat(pos.liquidation_price || 0) : null;
  const hasLiq = liq != null && liq > 0;

  if (!candles || candles.length < 2) {
    el.innerHTML = '<div style="color:var(--ink-faint);font-size:11px;padding:12px 0">not enough candle data yet</div>';
    return;
  }

  const norm = candles.map(_normCandle).filter(c => c.o > 0).sort((a, b) => a.ts - b.ts);
  if (norm.length < 2) {
    el.innerHTML = '<div style="color:var(--ink-faint);font-size:11px;padding:12px 0">waiting for price data…</div>';
    return;
  }

  const W = 900, H = 380;
  const pad = { l: 4, r: 56, t: 8, b: 4 };
  const chartW = W - pad.l - pad.r;
  const chartH = H - pad.t - pad.b;

  const prices = norm.flatMap(c => [c.h, c.l]).filter(p => p > 0);
  let minP = Math.min(...prices);
  let maxP = Math.max(...prices);
  // extend the visible range so the entry/liq lines are always on-chart
  if (entry) { minP = Math.min(minP, entry); maxP = Math.max(maxP, entry); }
  if (hasLiq) { minP = Math.min(minP, liq); maxP = Math.max(maxP, liq); }
  const rangeP = (maxP - minP) || minP * 0.01 || 1;
  const py = p => pad.t + ((maxP - p) / rangeP * chartH);

  const n = norm.length;
  const colW = chartW / n;
  const bodyW = Math.max(1, colW * 0.6);

  const candleSvg = norm.map((c, i) => {
    const x = pad.l + i * colW + colW / 2;
    const isBull = c.c >= c.o;
    const col = isBull ? 'var(--green)' : 'var(--red)';
    const bodyTop = py(Math.max(c.o, c.c));
    const bodyBot = py(Math.min(c.o, c.c));
    const bodyH = Math.max(1, bodyBot - bodyTop);
    const wickTop = py(c.h);
    const wickBot = py(c.l);
    return `
      <line x1="${x}" y1="${wickTop}" x2="${x}" y2="${wickBot}" stroke="${col}" stroke-width="1" opacity="0.7"/>
      <rect x="${(x - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}"
        fill="${col}" opacity="0.85" rx="0.5"/>`;
  }).join('');

  const axisLines = [0, 1, 2, 3, 4].map(i => {
    const price = minP + rangeP * (i / 4);
    const y = py(price);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
      <text x="${W - pad.r + 4}" y="${(y + 3).toFixed(1)}" fill="var(--ink-faint)" font-size="9" font-family="monospace">$${price.toFixed(4)}</text>`;
  }).join('');

  let overlay = '';
  const legendParts = [];
  if (entry) {
    const y = py(entry).toFixed(1);
    overlay += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="5,4"/>
      <text x="${pad.l + 4}" y="${(parseFloat(y) - 4).toFixed(1)}" fill="var(--accent)" font-size="9" font-family="monospace">entry $${entry.toFixed(4)}</text>`;
    legendParts.push(`<span><span class="legend-swatch" style="border-top-color:var(--accent)"></span>entry $${entry.toFixed(4)}</span>`);
  }
  if (hasLiq) {
    const y = py(liq).toFixed(1);
    overlay += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="5,4"/>
      <text x="${pad.l + 4}" y="${(parseFloat(y) - 4).toFixed(1)}" fill="var(--red)" font-size="9" font-family="monospace">liq $${liq.toFixed(4)}</text>`;
    legendParts.push(`<span><span class="legend-swatch" style="border-top-color:var(--red)"></span>liq $${liq.toFixed(4)}</span>`);
  } else if (pos) {
    legendParts.push(`<span style="color:var(--ink-faint)">liq price unavailable</span>`);
  }
  legendEl.innerHTML = legendParts.join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block;overflow:visible">
    ${axisLines}${candleSvg}${overlay}
  </svg>`;

  const fmtLabel = ts => new Date(ts > 1e12 ? ts : ts * 1000).toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const first = norm[0], last = norm[norm.length - 1];
  axisEl.innerHTML = `<span>${fmtLabel(first.ts)}</span><span>${fmtLabel(last.ts)}</span>`;

  const prevC = norm[norm.length - 2];
  const chg = ((last.c - prevC.c) / prevC.c * 100);
  $('#chartPx').innerHTML = `$${last.c.toFixed(4)} <span style="color:${chg >= 0 ? 'var(--green)' : 'var(--red)'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>`;
}
