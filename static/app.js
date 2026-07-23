/* ─────────────────────────────────────────────────────────────
   Lighter Analyst Cockpit · polling frontend
   Talks to the local FastAPI backend via REST only.
   ───────────────────────────────────────────────────────────── */

const state = {
  markets: [],
  marketsById: new Map(),
  trades: [],
  whaleTrades: [],
  whaleThreshold: 10000,
  sortKey: 'volume_24h',
  sortDir: -1,
  filter: '',
  refreshMs: 5000,
  pollTimer: null,
  tickCount: 0,
  lastPrices: new Map(),
  drawer: { marketId: null, field: 'candles', hours: 24 },
};

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ── formatters ────────────────────────────────────────────────
const fmtUsd = (n, opts = {}) => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(opts.k1 ? 1 : 2) + 'K';
  return sign + '$' + abs.toFixed(abs < 1 ? 4 : 2);
};
const fmtNum = (n, dp = 2) => {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
const fmtPct = (n, dp = 2) => {
  if (n == null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + Number(n).toFixed(dp) + '%';
};
const fmtTime = ts => {
  const t = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : new Date(ts).getTime();
  return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
};

function setStatus(kind, text) {
  const dot = $('#statusDot'), txt = $('#statusText');
  dot.className = 'dot' + (kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
  txt.textContent = text;
}

async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

// ── rendering ────────────────────────────────────────────────

function renderKpis(summary) {
  if (!summary) return;
  // volume card
  $('#volHero').textContent = fmtUsd(summary.total_volume_24h);
  $('#statTrades').textContent = Number(summary.total_trades_24h).toLocaleString();
  $('#statMkts').textContent = summary.active_markets + ' / ' + summary.listed_markets;
  const avgF = summary.avg_funding_weighted;
  if (avgF != null) {
    $('#statFunding').textContent = (avgF * 100).toFixed(4) + '%';
    $('#statFunding').className = 'v ' + (avgF > 0 ? 'up' : avgF < 0 ? 'down' : '');
    $('#statApr').textContent = (avgF * 3 * 365 * 100).toFixed(1) + '%';
  }
  const g = summary.top_gainer, l = summary.top_loser;
  if (g) $('#statGainer').innerHTML = `<span class="sym">${g.symbol}</span> <span class="up">${fmtPct(g.price_change)}</span>`;
  if (l) $('#statLoser').innerHTML = `<span class="sym">${l.symbol}</span> <span class="down">${fmtPct(l.price_change)}</span>`;

  // open interest hero (live sum across markets)
  const oi = state.markets.reduce((s, m) => s + (m.oi_usd || 0), 0);
  if (oi > 0) $('#oiHero').textContent = fmtUsd(oi);

  // LIT hero price
  const lit = state.markets.find(m => m.symbol === 'LIT' && m.market_type !== 'spot') ||
              state.marketsById.get(120);
  if (lit) {
    $('#litPrice').textContent = '$' + Number(lit.last_price).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    const chip = $('#litChg');
    chip.style.display = '';
    chip.className = 'chg-chip ' + (lit.price_change >= 0 ? 'up' : 'down');
    chip.textContent = fmtPct(lit.price_change) + ' · 24h';
    const spot = state.markets.find(m => m.symbol === 'LIT/USDC');
    $('#litSub').innerHTML =
      `Vol ${fmtUsd(lit.volume_24h)} · ${Number(lit.trades_24h).toLocaleString()} trades` +
      (lit.funding != null ? ` · funding ${(lit.funding * 100).toFixed(4)}%` : '') +
      (spot ? ` · spot ${fmtUsd(spot.last_price)}` : '');
  }
}

function renderMarkets() {
  const tbody = $('#mktBody');
  const rows = state.markets
    .filter(m => !state.filter || m.symbol.toLowerCase().includes(state.filter))
    .slice()
    .sort((a, b) => {
      const va = a[state.sortKey], vb = b[state.sortKey];
      if (va == null) return 1; if (vb == null) return -1;
      if (typeof va === 'string') return state.sortDir * va.localeCompare(vb);
      return state.sortDir * (va - vb);
    });

  $('#mktCount').textContent = rows.length + ' markets';
  const maxVol = Math.max(...rows.map(r => r.volume_24h || 0), 1);

  tbody.innerHTML = rows.map(m => {
    const prev = state.lastPrices.get(m.market_id);
    state.lastPrices.set(m.market_id, m.last_price);
    const flash = prev != null && prev !== m.last_price
      ? (m.last_price > prev ? 'flash-up' : 'flash-dn') : '';
    const chgCls = m.price_change > 0 ? 'up' : m.price_change < 0 ? 'down' : 'neutral';
    const fundCls = (m.funding ?? 0) > 0 ? 'up' : (m.funding ?? 0) < 0 ? 'down' : 'neutral';
    const barPct = (m.volume_24h / maxVol) * 100;
    return `
      <tr data-mid="${m.market_id}">
        <td class="sym">${m.symbol}</td>
        <td class="num ${flash}">${fmtUsd(m.last_price)}</td>
        <td class="num ${chgCls}">${fmtPct(m.price_change)}</td>
        <td class="num bar-cell"><div class="bar pos" style="width:${barPct}%"></div><span>${fmtUsd(m.volume_24h)}</span></td>

        <td class="num ${fundCls}">${m.funding != null ? (m.funding * 100).toFixed(4) + '%' : '—'}</td>
        <td class="num">${Number(m.trades_24h).toLocaleString()}</td>
        <td class="num"><button class="chart-btn" data-mid="${m.market_id}" title="show history">▸</button></td>
      </tr>`;
  }).join('') || `<tr><td colspan="7" class="empty">no markets match</td></tr>`;

  $$('#mktTable thead th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.k === state.sortKey);
    th.classList.toggle('asc', state.sortDir === 1);
  });

  // attach chart buttons (stop propagation so row click doesn't double-fire)
  $$('.chart-btn').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      openDrawer(Number(b.dataset.mid));
    });
  });
}

function renderWhales() {
  const tbody = $('#whaleBody');
  state.whaleTrades = state.trades.filter(t => t.usd >= state.whaleThreshold).slice(0, 100);
  const rows = state.whaleTrades;
  $('#whaleCount').textContent = rows.length + ' trades';
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">no large trades</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(t => {
    const tier = t.usd >= 1e6 ? 't1' : t.usd >= 2.5e5 ? 't2' : 't3';
    return `
      <tr>
        <td style="color:var(--ink-dim)">${fmtTime(t.ts)}</td>
        <td class="sym">${t.symbol}</td>
        <td><span class="pill ${t.side}">${t.side}</span></td>
        <td class="num">${fmtUsd(t.price)}</td>
        <td class="num">${fmtNum(t.size, 3)}</td>
        <td class="num"><span class="whale"><span class="tier ${tier}">${tier.toUpperCase()}</span> ${fmtUsd(t.usd, { k1: true })}</span></td>
      </tr>`;
  }).join('');
}

function renderHeatmap() {
  const container = $('#heatmap');
  const items = state.markets
    .filter(m => m.funding != null)
    .sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))
    .slice(0, 48);

  if (!items.length) {
    container.innerHTML = `<div class="empty" style="grid-column:1/-1">funding data unavailable</div>`;
    return;
  }

  const max = Math.max(...items.map(m => Math.abs(m.funding)), 0.0001);
  container.innerHTML = items.map(m => {
    const r = m.funding;
    const intensity = Math.min(Math.abs(r) / max, 1);
    const bg = r >= 0
      ? `rgba(67,221,140,${0.1 + intensity * 0.5})`
      : `rgba(255,107,129,${0.1 + intensity * 0.5})`;
    const apr = (r * 3 * 365 * 100).toFixed(1);
    return `<div class="hm-cell" style="background:${bg}" title="${m.symbol} · ${apr}% APR · click for history" data-mid="${m.market_id}">
      <div class="s">${m.symbol}</div>
      <div class="r">${(r * 100).toFixed(4)}%</div>
    </div>`;
  }).join('');

  // click → open drawer
  $$('#heatmap .hm-cell').forEach(c => {
    c.addEventListener('click', () => openDrawer(Number(c.dataset.mid)));
  });
}

async function renderFlow() {
  try {
    const f = await apiGet('/api/flow?limit=500');
    $('#buyVol').textContent = fmtUsd(f.buy_usd);
    $('#sellVol').textContent = fmtUsd(f.sell_usd);
    const delta = f.delta_usd;
    $('#deltaVol').textContent = fmtUsd(delta);
    $('#deltaVol').className = 'flow-val ' + (delta >= 0 ? 'up' : 'down');

    const total = f.buy_usd + f.sell_usd || 1;
    const pctBuy = (f.buy_usd / total) * 100;
    $('#bar-buy').style.width = pctBuy + '%';
    $('#bar-sell').style.width = (100 - pctBuy) + '%';
    $('#pctBuy').textContent = pctBuy.toFixed(1) + '% buy';
    $('#pctSell').textContent = (100 - pctBuy).toFixed(1) + '% sell';

    $('#cvdBody').innerHTML = f.cvd.slice(0, 6).map(c => `
      <tr>
        <td class="sym">${c.symbol}</td>
        <td class="num ${c.delta > 0 ? 'up' : 'down'}">${c.delta > 0 ? '+' : ''}${fmtUsd(c.delta)}</td>
        <td class="num" style="color:var(--ink-dim)">${fmtUsd(c.buy + c.sell)}</td>
      </tr>`).join('') || `<tr><td colspan="3" class="empty">—</td></tr>`;
  } catch (e) { console.warn('flow:', e); }
}

function renderMovers() {
  const byChange = state.markets.slice().sort((a, b) => b.price_change - a.price_change);
  const gain = byChange.filter(m => m.price_change > 0).slice(0, 5);
  const lose = byChange.filter(m => m.price_change < 0).slice(-5).reverse();
  const volLead = state.markets.slice().sort((a, b) => b.volume_24h - a.volume_24h).slice(0, 5);

  const row = (m, cls) => `
    <tr>
      <td class="sym">${m.symbol}</td>
      <td class="num">${fmtUsd(m.last_price)}</td>
      <td class="num ${cls}">${fmtPct(m.price_change)}</td>
    </tr>`;
  $('#gainersBody').innerHTML = gain.map(m => row(m, 'up')).join('') || `<tr><td colspan="3" class="empty">—</td></tr>`;
  $('#losersBody').innerHTML = lose.map(m => row(m, 'down')).join('') || `<tr><td colspan="3" class="empty">—</td></tr>`;
  $('#volLeadBody').innerHTML = volLead.map(m => `
    <tr>
      <td class="sym">${m.symbol}</td>
      <td class="num">${fmtUsd(m.volume_24h)}</td>
      <td class="num" style="color:var(--ink-dim)">${Number(m.trades_24h).toLocaleString()}</td>
    </tr>`).join('');
}

function renderLiqs() {
  // Lighter's public trade API carries no liquidation flag (checked 300 real
  // trades across 3 markets — every one is type "trade", no is_liquidation
  // field exists anywhere). This can never be computed from current data;
  // show that honestly instead of a fake "$0 confirmed clean" reading.
  $('#liqHero').textContent = '—';
  $('#liqSub').textContent = "not exposed by Lighter's public API";
  $('#liqFeed').innerHTML = '';
}

// ── chart hover: crosshair + tooltip ─────────────────────────
let chartHover = null; // set by drawChart / drawCandleChart after each render

function setupChartHover() {
  const svg = $('#chart'), tip = $('#chartTip');
  if (!svg || !tip) return;
  const timeLbl = ms => new Date(ms).toLocaleString('en-GB', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  const hide = () => {
    tip.style.display = 'none';
    const g = svg.querySelector('#hoverG');
    if (g) g.style.display = 'none';
  };
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('mousemove', e => {
    const g = svg.querySelector('#hoverG');
    if (!chartHover || !g) return hide();
    const r = svg.getBoundingClientRect();
    const mx = (e.clientX - r.left) * 800 / r.width;
    let cx, html;
    if (chartHover.type === 'line') {
      const { points, X, Y, field } = chartHover;
      let best = 0, bd = Infinity;
      for (let i = 0; i < points.length; i++) {
        const dist = Math.abs(X(points[i].ts) - mx);
        if (dist < bd) { bd = dist; best = i; }
      }
      const p = points[best];
      cx = X(p.ts);
      const dot = svg.querySelector('#hoverDot');
      dot.setAttribute('cx', cx.toFixed(1));
      dot.setAttribute('cy', Y(p.value).toFixed(1));
      const val = field === 'funding'
        ? (p.value * 100).toFixed(4) + '% · ' + (p.value * 3 * 365 * 100).toFixed(1) + '% APR'
        : fmtUsd(p.value);
      html = `<div class="tt">${timeLbl(p.ts * 1000)}</div>${val}`;
    } else {
      const { data, pad, slotW } = chartHover;
      const i = Math.min(data.length - 1, Math.max(0, Math.floor((mx - pad.l) / slotW)));
      const c = data[i];
      cx = pad.l + (i + 0.5) * slotW;
      const ts = c.t > 1e12 ? c.t : c.t * 1000;
      const cls = c.c >= c.o ? 'up' : 'down';
      html = `<div class="tt">${timeLbl(ts)}</div>` +
        `O ${fmtUsd(c.o)} · H <span class="up">${fmtUsd(c.h)}</span> · ` +
        `L <span class="down">${fmtUsd(c.l)}</span> · C <span class="${cls}">${fmtUsd(c.c)}</span>`;
    }
    const line = svg.querySelector('#hoverX');
    line.setAttribute('x1', cx.toFixed(1));
    line.setAttribute('x2', cx.toFixed(1));
    g.style.display = '';
    tip.innerHTML = html;
    tip.style.display = 'block';
    const px = cx / 800 * r.width;
    if (px > r.width * 0.55) {
      tip.style.left = 'auto';
      tip.style.right = (r.width - px + 12) + 'px';
    } else {
      tip.style.right = 'auto';
      tip.style.left = (px + 12) + 'px';
    }
    const py = e.clientY - r.top;
    tip.style.top = Math.max(4, Math.min(py - 14, r.height - 64)) + 'px';
  });
}

// ── history drawer + SVG chart ──────────────────────────────
async function openDrawer(marketId) {
  state.drawer.marketId = marketId;
  const m = state.marketsById.get(marketId);

  // title
  $('#drawerTitle').innerHTML = m
    ? `<span class="sym">${m.symbol}</span>`
    : `MKT-${marketId}`;

  // market stats bar
  if (m) {
    const chgCls = m.price_change > 0 ? 'up' : m.price_change < 0 ? 'down' : '';
    const fCls = (m.funding ?? 0) > 0 ? 'up' : (m.funding ?? 0) < 0 ? 'down' : '';
    $('#drawerMktBar').innerHTML = `
      <span style="font-size:14px;font-weight:700;color:var(--ink)">${fmtUsd(m.last_price)}</span>
      <span class="${chgCls}">${fmtPct(m.price_change)} 24h</span>
      <span style="color:var(--ink-faint)">Vol ${fmtUsd(m.volume_24h)}</span>
      ${m.funding != null ? `<span class="${fCls}">Fund ${(m.funding*100).toFixed(4)}%</span>` : ''}
      <span style="color:var(--ink-faint)">${Number(m.trades_24h).toLocaleString()} trades</span>
    `;
  } else {
    $('#drawerMktBar').innerHTML = '';
  }

  // highlight selected row
  $$('#mktBody tr.selected').forEach(r => r.classList.remove('selected'));
  const row = document.querySelector(`#mktBody tr[data-mid="${marketId}"]`);
  if (row) row.classList.add('selected');

  $('#drawer').classList.add('open');
  await loadDrawerChart();
  renderDrawerTrades(marketId);
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $$('#mktBody tr.selected').forEach(r => r.classList.remove('selected'));
  state.drawer.marketId = null;
}

async function loadDrawerChart() {
  if (state.drawer.marketId == null) return;
  const { marketId, field, hours } = state.drawer;

  if (field === 'candles') {
    // map hours → resolution + count
    const resMap = { 24: ['1h', 24], 72: ['4h', 18], 168: ['1d', 7] };
    const [res, cnt] = resMap[hours] || ['1h', 24];
    try {
      const j = await apiGet(`/api/candles/${marketId}?resolution=${res}&count=${cnt}`);
      drawCandleChart(j.candles || []);
    } catch (e) {
      drawCandleChart([]);
    }
  } else {
    try {
      const j = await apiGet(`/api/history/${marketId}?field=${field}&hours=${hours}`);
      drawChart(j.points, field);
    } catch (e) {
      drawChart([], field);
    }
  }
}

// ── candlestick chart ────────────────────────────────────────
function drawCandleChart(rawCandles) {
  const svg = $('#chart');
  const stats = $('#chartStats');
  const W = 800, H = 260;
  const pad = { t: 16, r: 16, b: 28, l: 64 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;

  svg.innerHTML = '';
  stats.innerHTML = '';
  chartHover = null;

  if (!rawCandles.length) {
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:12px">no candle data available</text>`;
    return;
  }

  const norm = c => ({
    t: c.t || c.time || c.timestamp || c.open_time || 0,
    o: parseFloat(c.o ?? c.open),
    h: parseFloat(c.h ?? c.high),
    l: parseFloat(c.l ?? c.low),
    c: parseFloat(c.c ?? c.close),
    v: parseFloat(c.v ?? c.volume ?? 0),
  });
  const data = rawCandles.map(norm).filter(c => !isNaN(c.o) && !isNaN(c.c));
  if (!data.length) {
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:12px">candle data format unrecognised</text>`;
    return;
  }

  const yMin = Math.min(...data.map(c => c.l));
  const yMax = Math.max(...data.map(c => c.h));
  const yRange = yMax - yMin || 0.001;
  const yPad = yRange * 0.06;
  const y0 = yMin - yPad, y1 = yMax + yPad;
  const sy = v => pad.t + (1 - (v - y0) / (y1 - y0)) * cH;

  const n = data.length;
  const slotW = cW / n;
  const bodyW = Math.max(2, slotW * 0.55);

  let out = '';

  // y-axis grid + labels
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4;
    const y = sy(v).toFixed(1);
    out += `<line x1="${pad.l}" x2="${W-pad.r}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
    out += `<text x="${pad.l-6}" y="${parseFloat(y)+4}" text-anchor="end" fill="var(--ink-faint)" style="font-size:10px;font-family:'JetBrains Mono',monospace">${fmtUsd(v)}</text>`;
  }

  // candles
  data.forEach((c, i) => {
    const cx = (pad.l + (i + 0.5) * slotW).toFixed(1);
    const isUp = c.c >= c.o;
    const col = isUp ? 'var(--green)' : 'var(--red)';
    const bTop = sy(Math.max(c.o, c.c)).toFixed(1);
    const bBot = sy(Math.min(c.o, c.c)).toFixed(1);
    const bH = Math.max(1, parseFloat(bBot) - parseFloat(bTop)).toFixed(1);
    const bX = (parseFloat(cx) - bodyW / 2).toFixed(1);
    const wTop = sy(c.h).toFixed(1);
    const wBot = sy(c.l).toFixed(1);
    out += `<line x1="${cx}" x2="${cx}" y1="${wTop}" y2="${wBot}" stroke="${col}" stroke-width="1" opacity="0.6"/>`;
    out += `<rect x="${bX}" y="${bTop}" width="${bodyW.toFixed(1)}" height="${bH}" fill="${col}" opacity="0.9"/>`;
  });

  // x-axis labels at ~4 points
  const step = Math.max(1, Math.floor(n / 4));
  for (let i = 0; i < n; i += step) {
    const c = data[i];
    const x = (pad.l + (i + 0.5) * slotW).toFixed(1);
    const ts = c.t > 1e12 ? c.t : c.t * 1000;
    const lbl = new Date(ts).toLocaleString('en-GB', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    out += `<text x="${x}" y="${H-8}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:10px;font-family:'JetBrains Mono',monospace">${lbl}</text>`;
  }

  out += `<g id="hoverG" style="display:none"><line id="hoverX" y1="${pad.t}" y2="${H-pad.b}" stroke="var(--ink-faint)" stroke-width="1" stroke-dasharray="2 3"/></g>`;
  svg.innerHTML = out;
  chartHover = { type: 'candles', data, pad, slotW };

  // stats bar (last candle OHLC)
  const last = data[data.length - 1];
  const first = data[0];
  const chg = first.o !== 0 ? ((last.c - first.o) / Math.abs(first.o)) * 100 : 0;
  const chgCls = chg >= 0 ? 'up' : 'down';
  stats.innerHTML = `
    <span><span class="section-lbl" style="display:inline">O</span> ${fmtUsd(last.o)}</span>
    <span><span class="section-lbl" style="display:inline">H</span> <span class="up">${fmtUsd(last.h)}</span></span>
    <span><span class="section-lbl" style="display:inline">L</span> <span class="down">${fmtUsd(last.l)}</span></span>
    <span><span class="section-lbl" style="display:inline">C</span> ${fmtUsd(last.c)}</span>
    <span class="${chgCls}"><span class="section-lbl" style="display:inline">Δ</span> ${fmtPct(chg)}</span>
    <span style="color:var(--ink-faint)"><span class="section-lbl" style="display:inline">Bars</span> ${n}</span>
  `;
}

// ── drawer recent trades ─────────────────────────────────────
function renderDrawerTrades(marketId) {
  const tbody = $('#drawerTradesBody');
  if (!tbody) return;
  const trades = state.trades.filter(t => t.market_id === marketId).slice(0, 25);
  if (!trades.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="5" style="padding:10px">no recent trades in buffer</td></tr>`;
    return;
  }
  tbody.innerHTML = trades.map(t => {
    const isBuy = t.side === 'buy';
    const big = t.usd >= 50000;
    return `<tr style="${big ? 'background:rgba(224,255,107,0.03)' : ''}">
      <td style="padding:4px 6px;color:var(--ink-faint)">${fmtTime(t.ts)}</td>
      <td style="padding:4px 6px"><span class="pill ${t.side}" style="font-size:9px;padding:1px 5px">${t.side}</span></td>
      <td style="padding:4px 6px;text-align:right;font-variant-numeric:tabular-nums">${fmtUsd(t.price)}</td>
      <td style="padding:4px 6px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink-dim)">${fmtNum(t.size, 3)}</td>
      <td style="padding:4px 6px;text-align:right;font-variant-numeric:tabular-nums;font-weight:${big?'700':'400'};color:${isBuy?'var(--green)':'var(--red)'}">${fmtUsd(t.usd)}</td>
    </tr>`;
  }).join('');
}

function drawChart(points, field) {
  const svg = $('#chart');
  svg.innerHTML = '';
  const stats = $('#chartStats');
  const W = 800, H = 260, pad = { t: 12, r: 14, b: 28, l: 60 };

  if (!points.length) {
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:12px">no history yet — let the collector run</text>`;
    stats.textContent = '';
    chartHover = null;
    return;
  }

  const xs = points.map(p => p.ts);
  const ys = points.map(p => p.value);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const yPad = (yMax - yMin) * 0.08 || 0.0001;
  const y0 = yMin - yPad, y1 = yMax + yPad;

  const sx = t => pad.l + ((t - xMin) / ((xMax - xMin) || 1)) * (W - pad.l - pad.r);
  const sy = v => pad.t + (1 - (v - y0) / ((y1 - y0) || 1)) * (H - pad.t - pad.b);

  // grid + y labels
  const gridLines = [];
  const labels = [];
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4;
    const y = sy(v);
    gridLines.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`);
    const lbl = field === 'funding' ? (v * 100).toFixed(4) + '%' : fmtUsd(v);
    labels.push(`<text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" fill="var(--ink-faint)" style="font-size:10px;font-family:'JetBrains Mono',monospace">${lbl}</text>`);
  }

  // x labels (first, mid, last)
  const xLabels = [xMin, (xMin + xMax) / 2, xMax].map(t => {
    const x = sx(t);
    const d = new Date(t * 1000);
    const lbl = d.toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<text x="${x}" y="${H - 8}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:10px;font-family:'JetBrains Mono',monospace">${lbl}</text>`;
  });

  // zero line (for funding)
  let zero = '';
  if (field === 'funding' && y0 < 0 && y1 > 0) {
    const y = sy(0);
    zero = `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="var(--ink-faint)" stroke-dasharray="3 3" stroke-width="1"/>`;
  }

  // path
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.ts).toFixed(1)} ${sy(p.value).toFixed(1)}`).join(' ');

  // area fill
  const areaD = d + ` L ${sx(xMax).toFixed(1)} ${H - pad.b} L ${sx(xMin).toFixed(1)} ${H - pad.b} Z`;

  const lineColor = (ys[ys.length - 1] >= (ys[0] || 0)) ? 'var(--green)' : 'var(--red)';

  svg.innerHTML = `
    ${gridLines.join('')}
    ${zero}
    <path d="${areaD}" fill="${lineColor}" opacity="0.12"/>
    <path d="${d}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linejoin="round"/>
    ${labels.join('')}
    ${xLabels.join('')}
    <g id="hoverG" style="display:none">
      <line id="hoverX" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--ink-faint)" stroke-width="1" stroke-dasharray="2 3"/>
      <circle id="hoverDot" r="3.5" fill="${lineColor}" stroke="var(--bg)" stroke-width="1.5"/>
    </g>
  `;
  chartHover = { type: 'line', points, X: sx, Y: sy, field };

  // stats
  const last = ys[ys.length - 1];
  const first = ys[0];
  const chg = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0;
  const lastFmt = field === 'funding' ? (last * 100).toFixed(4) + '%' : fmtUsd(last);
  const apr = field === 'funding' ? ' · ' + (last * 3 * 365 * 100).toFixed(1) + '% APR' : '';
  stats.innerHTML = `
    <span><span class="section-lbl" style="display:inline">Latest</span> ${lastFmt}${apr}</span>
    <span><span class="section-lbl" style="display:inline">Range</span> ${points.length} points · ${fmtPct(chg)}</span>
    <span><span class="section-lbl" style="display:inline">Min/Max</span> ${field === 'funding' ? (Math.min(...ys)*100).toFixed(4)+'%' : fmtUsd(Math.min(...ys))} / ${field === 'funding' ? (Math.max(...ys)*100).toFixed(4)+'%' : fmtUsd(Math.max(...ys))}</span>
  `;
}

// ── hero cards: LIT candles + protocol history ───────────────
const litState = { res: '1d', cnt: 60, hover: null };

function drawLitCandles(rawCandles) {
  const svg = $('#litChart');
  if (!svg) return;
  const W = 760, H = 240;
  const pad = { t: 10, r: 10, b: 24, l: 58 };
  svg.innerHTML = '';
  litState.hover = null;

  const norm = c => ({
    t: c.t || c.time || c.timestamp || c.open_time || 0,
    o: parseFloat(c.o ?? c.open), h: parseFloat(c.h ?? c.high),
    l: parseFloat(c.l ?? c.low), c: parseFloat(c.c ?? c.close),
  });
  const data = (rawCandles || []).map(norm).filter(c => !isNaN(c.o) && !isNaN(c.c));
  if (!data.length) {
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:12px">no candle data</text>`;
    return;
  }

  const yMin = Math.min(...data.map(c => c.l));
  const yMax = Math.max(...data.map(c => c.h));
  const yPad = (yMax - yMin || 0.001) * 0.07;
  const y0 = yMin - yPad, y1 = yMax + yPad;
  const cH = H - pad.t - pad.b, cW = W - pad.l - pad.r;
  const sy = v => pad.t + (1 - (v - y0) / (y1 - y0)) * cH;
  const n = data.length, slotW = cW / n;
  const bodyW = Math.max(2, slotW * 0.55);

  let out = '';
  for (let i = 0; i <= 3; i++) {
    const v = y0 + ((y1 - y0) * i) / 3;
    const y = sy(v).toFixed(1);
    out += `<line x1="${pad.l}" x2="${W-pad.r}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
    out += `<text x="${pad.l-6}" y="${parseFloat(y)+4}" text-anchor="end" fill="var(--ink-faint)" style="font-size:10px;font-family:var(--mono)">$${v.toFixed(3)}</text>`;
  }
  data.forEach((c, i) => {
    const cx = (pad.l + (i + 0.5) * slotW).toFixed(1);
    const isUp = c.c >= c.o;
    const col = isUp ? 'var(--green)' : 'var(--red)';
    const bTop = sy(Math.max(c.o, c.c)).toFixed(1);
    const bBot = sy(Math.min(c.o, c.c)).toFixed(1);
    const bH = Math.max(1, parseFloat(bBot) - parseFloat(bTop)).toFixed(1);
    out += `<line x1="${cx}" x2="${cx}" y1="${sy(c.h).toFixed(1)}" y2="${sy(c.l).toFixed(1)}" stroke="${col}" stroke-width="1" opacity="0.6"/>`;
    out += `<rect x="${(parseFloat(cx)-bodyW/2).toFixed(1)}" y="${bTop}" width="${bodyW.toFixed(1)}" height="${bH}" rx="1" fill="${col}" opacity="0.9"/>`;
  });
  const step = Math.max(1, Math.floor(n / 5));
  for (let i = 0; i < n; i += step) {
    const ts = data[i].t > 1e12 ? data[i].t : data[i].t * 1000;
    const lbl = new Date(ts).toLocaleString('en-GB', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    out += `<text x="${(pad.l+(i+0.5)*slotW).toFixed(1)}" y="${H-7}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:10px;font-family:var(--mono)">${lbl}</text>`;
  }
  out += `<g id="litHoverG" style="display:none"><line id="litHoverX" y1="${pad.t}" y2="${H-pad.b}" stroke="var(--ink-faint)" stroke-width="1" stroke-dasharray="2 3"/></g>`;
  svg.innerHTML = out;
  litState.hover = { data, pad, slotW, W };
}

function setupLitHover() {
  const svg = $('#litChart'), tip = $('#litTip');
  if (!svg || !tip) return;
  const hide = () => {
    tip.style.display = 'none';
    const g = svg.querySelector('#litHoverG');
    if (g) g.style.display = 'none';
  };
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('mousemove', e => {
    const g = svg.querySelector('#litHoverG');
    if (!litState.hover || !g) return hide();
    const { data, pad, slotW, W } = litState.hover;
    const r = svg.getBoundingClientRect();
    const mx = (e.clientX - r.left) * W / r.width;
    const i = Math.min(data.length - 1, Math.max(0, Math.floor((mx - pad.l) / slotW)));
    const c = data[i];
    const cx = pad.l + (i + 0.5) * slotW;
    const ts = c.t > 1e12 ? c.t : c.t * 1000;
    const cls = c.c >= c.o ? 'up' : 'down';
    const line = svg.querySelector('#litHoverX');
    line.setAttribute('x1', cx.toFixed(1));
    line.setAttribute('x2', cx.toFixed(1));
    g.style.display = '';
    tip.innerHTML = `<div class="tt">${new Date(ts).toLocaleString('en-GB',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>` +
      `O $${c.o.toFixed(4)} · H <span class="up">$${c.h.toFixed(4)}</span> · L <span class="down">$${c.l.toFixed(4)}</span> · C <span class="${cls}">$${c.c.toFixed(4)}</span>`;
    tip.style.display = 'block';
    const px = cx / W * r.width;
    if (px > r.width * 0.55) { tip.style.left = 'auto'; tip.style.right = (r.width - px + 12) + 'px'; }
    else { tip.style.right = 'auto'; tip.style.left = (px + 12) + 'px'; }
    tip.style.top = Math.max(4, Math.min(e.clientY - r.top - 14, r.height - 64)) + 'px';
  });
}

async function loadLitChart() {
  try {
    const j = await apiGet(`/api/candles/120?resolution=${litState.res}&count=${litState.cnt}`);
    drawLitCandles(j.candles || []);
  } catch (e) { drawLitCandles([]); }
}

function drawVolBars(rows) {
  const svg = $('#volBars');
  if (!svg) return;
  const W = 520, H = 90, padB = 14;
  if (!rows || !rows.length) {
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:11px">volume ledger warming up</text>`;
    return;
  }
  const max = Math.max(...rows.map(r => r.usd), 1);
  const slot = W / rows.length;
  const bw = Math.max(2, slot * 0.62);
  let out = '';
  rows.forEach((r, i) => {
    const h = Math.max(1.5, (r.usd / max) * (H - padB - 4));
    const x = (i * slot + (slot - bw) / 2).toFixed(1);
    const t = new Date(r.ts * 1000).toLocaleString('en-GB', { weekday:'short', hour:'2-digit', minute:'2-digit' });
    out += `<rect x="${x}" y="${(H - padB - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="var(--accent)" opacity="0.75"><title>${t} · ${fmtUsd(r.usd)} · ${r.trades.toLocaleString()} trades</title></rect>`;
  });
  const first = new Date(rows[0].ts * 1000).toLocaleString('en-GB', { weekday:'short', hour:'2-digit', minute:'2-digit' });
  const last = new Date(rows[rows.length-1].ts * 1000).toLocaleString('en-GB', { weekday:'short', hour:'2-digit', minute:'2-digit' });
  out += `<text x="0" y="${H-2}" fill="var(--ink-faint)" style="font-size:9px;font-family:var(--mono)">${first}</text>`;
  out += `<text x="${W}" y="${H-2}" text-anchor="end" fill="var(--ink-faint)" style="font-size:9px;font-family:var(--mono)">${last}</text>`;
  svg.innerHTML = out;
}

function drawOiArea(rows) {
  const svg = $('#oiChart');
  if (!svg) return;
  const W = 520, H = 120, padB = 16, padT = 6;
  if (!rows || rows.length < 2) {
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:11px">not enough history yet</text>`;
    return;
  }
  const xs = rows.map(r => new Date(r.day + 'T00:00:00Z').getTime());
  const ys = rows.map(r => r.oi_usd);
  const xMin = xs[0], xMax = xs[xs.length - 1];
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const yPad = (yMax - yMin || 1) * 0.1;
  const sx = t => ((t - xMin) / ((xMax - xMin) || 1)) * W;
  const sy = v => padT + (1 - (v - (yMin - yPad)) / ((yMax + yPad) - (yMin - yPad))) * (H - padT - padB);
  const d = rows.map((r, i) => `${i === 0 ? 'M' : 'L'} ${sx(xs[i]).toFixed(1)} ${sy(ys[i]).toFixed(1)}`).join(' ');
  const area = d + ` L ${W} ${H - padB} L 0 ${H - padB} Z`;
  const firstLbl = new Date(xMin).toLocaleDateString('en-GB', { month:'short', day:'numeric' });
  const lastLbl = new Date(xMax).toLocaleDateString('en-GB', { month:'short', day:'numeric' });
  svg.innerHTML = `
    <defs><linearGradient id="oiGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity="0.28"/>
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#oiGrad)"/>
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="${sx(xMax).toFixed(1)}" cy="${sy(ys[ys.length-1]).toFixed(1)}" r="3" fill="var(--accent)"/>
    <text x="0" y="${H-3}" fill="var(--ink-faint)" style="font-size:9px;font-family:var(--mono)">${firstLbl}</text>
    <text x="${W}" y="${H-3}" text-anchor="end" fill="var(--ink-faint)" style="font-size:9px;font-family:var(--mono)">${lastLbl}</text>
  `;
  // change since first recorded day
  const chg = ys[0] ? ((ys[ys.length-1] - ys[0]) / ys[0]) * 100 : 0;
  const cls = chg >= 0 ? 'up' : 'down';
  $('#oiSub').innerHTML = `<span class="${cls}">${fmtPct(chg)}</span> since ${firstLbl} · all markets, USD`;
}

async function loadProtocolHistory() {
  try {
    const j = await apiGet('/api/protocol-history?days=90');
    drawVolBars((j.vol_hourly || []).slice(-72));
    drawOiArea(j.oi_daily || []);
  } catch (e) { console.warn('protocol-history:', e); }
}

// ── main poll cycle ──────────────────────────────────────────
async function pollOnce() {
  try {
    setStatus('warn', 'syncing…');
    const [mj, tj] = await Promise.all([
      apiGet('/api/markets'),
      apiGet('/api/trades?limit=500'),
    ]);
    state.markets = mj.markets;
    state.marketsById = new Map(mj.markets.map(m => [m.market_id, m]));
    state.trades = tj.trades;

    renderKpis(mj.summary);
    renderMarkets();
    renderWhales();
    renderHeatmap();
    renderFlow();
    renderMovers();
    renderLiqs();

    state.tickCount++;
    $('#tickCount').textContent = state.tickCount + ' polls';
    $('#lastSync').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setStatus('ok', 'connected');
  } catch (e) {
    console.error(e);
    setStatus('err', 'error · ' + e.message);
  }
}

function schedule() {
  clearInterval(state.pollTimer);
  if (state.refreshMs > 0) {
    state.pollTimer = setInterval(pollOnce, state.refreshMs);
  }
}

// ── events ───────────────────────────────────────────────────
$$('#mktTable thead th').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.k; if (!k || k === 'chart') return;
    if (state.sortKey === k) state.sortDir *= -1;
    else { state.sortKey = k; state.sortDir = -1; }
    renderMarkets();
  });
});

$('#mktFilter').addEventListener('input', e => {
  state.filter = e.target.value.trim().toLowerCase();
  renderMarkets();
});

$('#whaleThreshold').addEventListener('change', e => {
  state.whaleThreshold = Number(e.target.value);
  renderWhales();
});

$$('.controls .btn').forEach(b => {
  b.addEventListener('click', () => {
    $$('.controls .btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.refreshMs = Number(b.dataset.refresh) * 1000;
    schedule();
    if (state.refreshMs === 0) setStatus('warn', 'paused');
  });
});

// LIT card timeframe chips
$$('[data-lit-res]').forEach(b => {
  b.addEventListener('click', () => {
    $$('[data-lit-res]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    litState.res = b.dataset.litRes;
    litState.cnt = Number(b.dataset.litCnt);
    loadLitChart();
  });
});

// row click → open drawer
$('#mktBody').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-mid]');
  if (!tr) return;
  openDrawer(Number(tr.dataset.mid));
});

// drawer events
$('#drawerClose').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

function _syncTimeLabels() {
  const isCandles = state.drawer.field === 'candles';
  $$('.drawer-tabs [data-hours]').forEach(b => {
    b.textContent = isCandles ? (b.dataset.lblCandles || b.dataset.hours) : (b.dataset.lblLine || b.dataset.hours);
  });
}

$$('.drawer-tabs .btn-sm').forEach(b => {
  b.addEventListener('click', () => {
    const field = b.dataset.field;
    const hours = b.dataset.hours;
    if (field) {
      state.drawer.field = field;
      $$('.drawer-tabs [data-field]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _syncTimeLabels();
    } else if (hours) {
      state.drawer.hours = Number(hours);
      $$('.drawer-tabs [data-hours]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    }
    loadDrawerChart();
  });
});

// ── boot ─────────────────────────────────────────────────────
_syncTimeLabels();  // set "1H / 4H / 1D" labels for default candles mode
setupChartHover();
setupLitHover();
pollOnce();
schedule();
loadLitChart();
loadProtocolHistory();
setInterval(loadLitChart, 60_000);
setInterval(loadProtocolHistory, 300_000);
