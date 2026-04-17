/* ─────────────────────────────────────────────────────────────
   Lighter Analyst Cockpit · polling frontend
   Talks to the local FastAPI backend via REST only.
   ───────────────────────────────────────────────────────────── */

const state = {
  markets: [],
  marketsById: new Map(),
  trades: [],
  whaleTrades: [],
  whaleThreshold: 50000,
  sortKey: 'volume_24h',
  sortDir: -1,
  filter: '',
  refreshMs: 5000,
  pollTimer: null,
  tickCount: 0,
  lastPrices: new Map(),
  drawer: { marketId: null, field: 'funding', hours: 24 },
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
  $('#kpi-vol').textContent = fmtUsd(summary.total_volume_24h);
  $('#kpi-vol-sub').textContent = 'quote · all perps';
  $('#kpi-oi').textContent = fmtUsd(summary.total_oi_usd);
  $('#kpi-oi-sub').textContent = 'notional · all perps';
  $('#kpi-mkts').textContent = summary.active_markets + ' / ' + summary.listed_markets;
  $('#kpi-mkts-sub').textContent = 'trading · listed';
  $('#kpi-trades').textContent = Number(summary.total_trades_24h).toLocaleString();
  $('#kpi-trades-sub').textContent = 'executions · 24h';

  const g = summary.top_gainer, l = summary.top_loser;
  if (g) {
    $('#kpi-gainer').innerHTML = `<span class="sym">${g.symbol}</span> <span class="up" style="font-size:14px">${fmtPct(g.price_change)}</span>`;
    $('#kpi-gainer-sub').textContent = fmtUsd(g.last_price);
  }
  if (l) {
    $('#kpi-loser').innerHTML = `<span class="sym">${l.symbol}</span> <span class="down" style="font-size:14px">${fmtPct(l.price_change)}</span>`;
    $('#kpi-loser-sub').textContent = fmtUsd(l.last_price);
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
        <td class="num">${fmtUsd(m.oi_usd)}</td>
        <td class="num ${fundCls}">${m.funding != null ? (m.funding * 100).toFixed(4) + '%' : '—'}</td>
        <td class="num">${Number(m.trades_24h).toLocaleString()}</td>
        <td class="num"><button class="chart-btn" data-mid="${m.market_id}" title="show history">▸</button></td>
      </tr>`;
  }).join('') || `<tr><td colspan="8" class="empty">no markets match</td></tr>`;

  $$('#mktTable thead th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.k === state.sortKey);
    th.classList.toggle('asc', state.sortDir === 1);
  });

  // attach chart buttons
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
      ? `rgba(111,224,137,${0.1 + intensity * 0.5})`
      : `rgba(255,106,119,${0.1 + intensity * 0.5})`;
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
  const gain = byChange.filter(m => m.price_change > 0).slice(0, 6);
  const lose = byChange.filter(m => m.price_change < 0).slice(-6).reverse();
  const volLead = state.markets.slice().sort((a, b) => b.volume_24h - a.volume_24h).slice(0, 6);

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
  const tbody = $('#liqBody');
  const liqs = state.trades.filter(t => t.is_liq).slice(0, 50);
  $('#liqCount').textContent = liqs.length + ' events';
  if (!liqs.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">no liquidations in recent sample</td></tr>`;
    return;
  }
  tbody.innerHTML = liqs.map(t => `
    <tr>
      <td style="color:var(--ink-dim)">${fmtTime(t.ts)}</td>
      <td class="sym">${t.symbol}</td>
      <td><span class="pill ${t.side}">${t.side}</span></td>
      <td class="num">${fmtUsd(t.price)}</td>
      <td class="num down">${fmtUsd(t.usd)}</td>
    </tr>`).join('');
}

// ── history drawer + SVG chart ──────────────────────────────
async function openDrawer(marketId) {
  state.drawer.marketId = marketId;
  const m = state.marketsById.get(marketId);
  $('#drawerTitle').innerHTML = `<span class="sym">${m ? m.symbol : 'MKT-' + marketId}</span> · history`;
  $('#drawer').classList.add('open');
  await loadDrawerChart();
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  state.drawer.marketId = null;
}

async function loadDrawerChart() {
  if (state.drawer.marketId == null) return;
  const { marketId, field, hours } = state.drawer;
  try {
    const j = await apiGet(`/api/history/${marketId}?field=${field}&hours=${hours}`);
    drawChart(j.points, field);
  } catch (e) {
    drawChart([], field);
  }
}

function drawChart(points, field) {
  const svg = $('#chart');
  svg.innerHTML = '';
  const stats = $('#chartStats');
  const W = 800, H = 260, pad = { t: 12, r: 14, b: 28, l: 60 };

  if (!points.length) {
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:12px">no history yet — let the collector run</text>`;
    stats.textContent = '';
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
  `;

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

// drawer events
$('#drawerClose').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

$$('.drawer-tabs .btn-sm').forEach(b => {
  b.addEventListener('click', () => {
    const field = b.dataset.field;
    const hours = b.dataset.hours;
    if (field) {
      state.drawer.field = field;
      $$('.drawer-tabs [data-field]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    } else if (hours) {
      state.drawer.hours = Number(hours);
      $$('.drawer-tabs [data-hours]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    }
    loadDrawerChart();
  });
});

// ── boot ─────────────────────────────────────────────────────
pollOnce();
schedule();
