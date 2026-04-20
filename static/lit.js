/* ──────────────────────────────────────────────────────────────
   LIT Flow Tracker · polling frontend
   ────────────────────────────────────────────────────────────── */

const state = {
  hours: 24,
  market: '',        // '' = all, '120' = perp, '2049' = spot
  whaleMin: 100000,
  twapWindowMs: 600000,   // 10 min rolling window
  twapMinTrades: 3,
  refreshMs: 10000,
  pollTimer: null,
  tickCount: 0,
};

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ── formatters ────────────────────────────────────────────────
const fmtDuration = h => {
  if (!h) return '0m';
  if (h < 1) return Math.round(h * 60) + 'm';
  if (h < 48) return h.toFixed(1) + 'h';
  return (h / 24).toFixed(1) + 'd';
};

const fmtUsd = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(2) + 'K';
  return sign + '$' + abs.toFixed(2);
};
const fmtPrice = n => n == null ? '—' : '$' + Number(n).toFixed(4);
const fmtNum = (n, dp = 2) => n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtPct = (n, dp = 2) => n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(dp) + '%';
const fmtTime = ts => new Date(ts > 1e12 ? ts : ts * 1000).toLocaleTimeString('en-GB', { hour12: false });
const fmtAcct = id => id ? '#' + id : '—';
const periodLabel = h => h === 24 ? '24h' : h === 168 ? '7d' : h === 720 ? '30d' : h + 'h';

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

// ── render functions ──────────────────────────────────────────

function renderSummary(data) {
  const perp = data.perp || {};
  const spot = data.spot || {};

  $('#kpi-perp').textContent = fmtPrice(perp.last_price);
  const perpChg = perp.price_change;
  $('#kpi-perp-sub').textContent = perpChg != null
    ? fmtPct(perpChg) + ' 24h'
    : '\u00a0';
  $('#kpi-perp-sub').className = 'sub ' + (perpChg > 0 ? 'up' : perpChg < 0 ? 'down' : '');

  $('#kpi-spot').textContent = fmtPrice(spot.last_price);
  const spotChg = spot.price_change;
  $('#kpi-spot-sub').textContent = spotChg != null
    ? fmtPct(spotChg) + ' 24h'
    : '\u00a0';
  $('#kpi-spot-sub').className = 'sub ' + (spotChg > 0 ? 'up' : spotChg < 0 ? 'down' : '');

  // funding
  const funding = perp.funding;
  if (funding != null) {
    const cls = funding >= 0 ? 'up' : 'down';
    $('#fundingRate').textContent = (funding * 100).toFixed(4) + '%';
    $('#fundingRate').className = 'flow-val ' + cls;
    const apr = funding * 3 * 365 * 100;
    $('#fundingApr').textContent = apr.toFixed(1) + '%';
    $('#fundingApr').className = 'flow-val ' + cls;
  }

  $('#perpVol').textContent = fmtUsd(perp.volume_24h);
  $('#perpTrades').textContent = perp.trades_24h != null
    ? Number(perp.trades_24h).toLocaleString()
    : '—';
  $('#perpHigh').textContent = fmtPrice(perp.price_high_24h || null);
  $('#perpLow').textContent = fmtPrice(perp.price_low_24h || null);

  // stored trades counter
  const count = data.db_trade_count || 0;
  $('#kpi-stored').textContent = Number(count).toLocaleString();
  if (data.oldest_trade_ts) {
    const ageH = ((Date.now() - data.oldest_trade_ts) / 3600000).toFixed(1);
    $('#kpi-stored-sub').textContent = ageH + 'h of history';
  } else {
    $('#kpi-stored-sub').textContent = count > 0 ? 'in DB' : 'building…';
  }
}

function renderFlow(data, actualHours) {
  const mktLbl = state.market === '120' ? ' · perp' : state.market === '2049' ? ' · spot' : '';
  const lbl = periodLabel(state.hours) + mktLbl;
  $('#flowPeriod').textContent = lbl;

  const buy = data.buy_usd || 0;
  const sell = data.sell_usd || 0;
  const delta = data.delta_usd || 0;

  $('#flowBuy').textContent = fmtUsd(buy);
  $('#flowSell').textContent = fmtUsd(sell);
  $('#flowDelta').textContent = fmtUsd(delta);
  $('#flowDelta').className = 'flow-val ' + (delta >= 0 ? 'up' : 'down');

  const total = buy + sell || 1;
  const pctBuy = (buy / total) * 100;
  $('#barBuy').style.width = pctBuy + '%';
  $('#barSell').style.width = (100 - pctBuy) + '%';
  $('#pctBuy').textContent = pctBuy.toFixed(1) + '% buy';
  $('#pctSell').textContent = (100 - pctBuy).toFixed(1) + '% sell';

  $('#flowTrades').textContent = Number(data.trade_count || 0).toLocaleString() + ' trades';

  const insufficient = actualHours > 0 && actualHours < state.hours * 0.95;
  if (actualHours > 0) {
    $('#flowCoverage').innerHTML = insufficient
      ? `<span style="color:var(--amber)">⚠ only ${fmtDuration(actualHours)} collected</span>`
      : fmtDuration(actualHours) + ' of data';
  } else {
    $('#flowCoverage').textContent = 'building…';
  }

  // KPI cells — show actual window in sub-label
  const dataLbl = actualHours > 0 ? fmtDuration(actualHours) : lbl;
  $('#kpi-buy').textContent = fmtUsd(buy);
  $('#kpi-buy-sub').textContent = dataLbl + ' · aggressive buys';
  $('#kpi-sell').textContent = fmtUsd(sell);
  $('#kpi-sell-sub').textContent = dataLbl + ' · aggressive sells';
  $('#kpi-delta').textContent = fmtUsd(delta);
  $('#kpi-delta').className = 'val ' + (delta >= 0 ? 'up' : 'down');
  $('#kpi-delta-sub').textContent = dataLbl + ' · net flow';
}

function renderTrades(trades) {
  const tbody = $('#litTradesBody');
  const mktLbl = state.market === '120' ? ' · perp' : state.market === '2049' ? ' · spot' : '';
  $('#tradeCount').textContent = trades.length + ' in DB' + mktLbl;

  if (!trades.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">no trades stored yet — the DB fills as you browse</td></tr>`;
    return;
  }

  tbody.innerHTML = trades.map(t => {
    const isBuy = t.taker_is_buyer === 1;
    const mkt = t.market_id === 120 ? 'PERP' : 'SPOT';
    const bigBuy  = isBuy && t.usd >= state.whaleMin;
    const mega    = isBuy && t.usd >= 1_000_000;
    const tier1   = isBuy && t.usd >= 500_000;
    const isTwap  = isBuy && (state._twapBuyers || new Set()).has(t.buyer_id);

    const rowStyle = isTwap
      ? 'background:rgba(242,193,78,0.06);box-shadow:inset 3px 0 0 var(--amber)'
      : bigBuy
      ? 'background:rgba(111,224,137,0.07);box-shadow:inset 3px 0 0 var(--green)'
      : '';
    const usdCls = bigBuy ? 'up' : t.usd >= 10000 ? '' : 'neutral';
    const badge = mega
      ? `<span class="tier t1" style="margin-left:4px">MEGA</span>`
      : tier1
      ? `<span class="tier t2" style="margin-left:4px">BIG</span>`
      : bigBuy
      ? `<span class="tier t3" style="margin-left:4px">BIG</span>`
      : isTwap
      ? `<span class="tier t3" style="margin-left:4px;background:rgba(242,193,78,0.2);color:var(--amber)">TWAP</span>`
      : '';

    return `<tr style="${rowStyle}">
      <td style="color:var(--ink-dim)">${fmtTime(t.ts)}</td>
      <td style="color:var(--ink-faint);font-size:10px;letter-spacing:.06em">${mkt}</td>
      <td><span class="pill ${isBuy ? 'buy' : 'sell'}">${isBuy ? 'buy' : 'sell'}</span>${badge}</td>
      <td class="num">$${Number(t.price).toFixed(4)}</td>
      <td class="num">${fmtNum(t.size, 2)}</td>
      <td class="num ${usdCls}" style="${bigBuy ? 'font-weight:700' : ''}">${fmtUsd(t.usd)}</td>
      <td class="num acct">${fmtAcct(t.buyer_id)}</td>
      <td class="num acct">${fmtAcct(t.seller_id)}</td>
    </tr>`;
  }).join('');
}

function renderLeaders(data, actualHours) {
  const lbl = periodLabel(state.hours);
  const insufficient = actualHours > 0 && actualHours < state.hours * 0.95;
  const coverageSuffix = insufficient
    ? ` · <span style="color:var(--amber)">⚠ ${fmtDuration(actualHours)} of data</span>`
    : '';
  $('#buyersPeriod').innerHTML = lbl + ' · by USD bought' + coverageSuffix;
  $('#sellersPeriod').innerHTML = lbl + ' · by USD sold' + coverageSuffix;

  const leaderRow = (item, rank) => {
    const avg = item.trade_count > 0 ? item.total_usd / item.trade_count : 0;
    return `<tr>
      <td class="rank">${rank}</td>
      <td class="acct" style="font-size:12px">${fmtAcct(item.account_id)}</td>
      <td class="num">${fmtUsd(item.total_usd)}</td>
      <td class="num">${Number(item.trade_count).toLocaleString()}</td>
      <td class="num" style="color:var(--ink-dim)">${fmtUsd(avg)}</td>
    </tr>`;
  };

  const buyers = data.buyers || [];
  const sellers = data.sellers || [];

  $('#buyersBody').innerHTML = buyers.length
    ? buyers.map((b, i) => leaderRow(b, i + 1)).join('')
    : `<tr><td colspan="5" class="empty">no data yet — history builds over time</td></tr>`;

  $('#sellersBody').innerHTML = sellers.length
    ? sellers.map((s, i) => leaderRow(s, i + 1)).join('')
    : `<tr><td colspan="5" class="empty">no data yet — history builds over time</td></tr>`;
}

// ── TWAP detection ────────────────────────────────────────────

function detectTwap(trades) {
  const cutoff = Date.now() - state.twapWindowMs;
  const byBuyer = new Map();

  for (const t of trades) {
    if (t.taker_is_buyer !== 1) continue;
    if (t.ts < cutoff) continue;
    if (!byBuyer.has(t.buyer_id)) {
      byBuyer.set(t.buyer_id, { total_usd: 0, count: 0, max_usd: 0, first_ts: t.ts, last_ts: t.ts, tsList: [] });
    }
    const acc = byBuyer.get(t.buyer_id);
    acc.total_usd += t.usd;
    acc.count++;
    acc.max_usd = Math.max(acc.max_usd, t.usd);
    acc.first_ts = Math.min(acc.first_ts, t.ts);
    acc.last_ts  = Math.max(acc.last_ts,  t.ts);
    acc.tsList.push(t.ts);
  }

  const alerts = [];
  for (const [buyer_id, acc] of byBuyer) {
    if (acc.total_usd < state.whaleMin) continue;
    if (acc.count < state.twapMinTrades) continue;
    // Avg spacing between consecutive trades (ms)
    acc.tsList.sort((a, b) => a - b);
    const gaps = acc.tsList.slice(1).map((ts, i) => ts - acc.tsList[i]);
    const avgSpacingMs = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
    alerts.push({ buyer_id, ...acc, avgSpacingMs });
  }

  return alerts.sort((a, b) => b.total_usd - a.total_usd);
}

function renderTwap(alerts) {
  const tbody = $('#twapBody');
  $('#twapCount').textContent = alerts.length
    ? alerts.length + ' active · ' + fmtDuration(state.twapWindowMs / 3600000) + ' window'
    : '';

  if (!alerts.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">no accounts accumulating ≥ ${fmtUsd(state.whaleMin)} in ${fmtDuration(state.twapWindowMs/3600000)} with ${state.twapMinTrades}+ trades</td></tr>`;
    return;
  }

  tbody.innerHTML = alerts.map(a => {
    const avg = a.total_usd / a.count;
    const spannedMs = a.last_ts - a.first_ts;
    const spacingLbl = a.avgSpacingMs >= 60000
      ? (a.avgSpacingMs / 60000).toFixed(1) + 'min'
      : Math.round(a.avgSpacingMs / 1000) + 's';
    const mega = a.total_usd >= 1_000_000;
    const big  = a.total_usd >= 500_000;
    const badge = mega
      ? `<span class="tier t1" style="margin-right:6px">MEGA</span>`
      : big
      ? `<span class="tier t2" style="margin-right:6px">BIG</span>`
      : `<span class="tier t3" style="margin-right:6px">TWAP</span>`;
    return `<tr style="background:rgba(111,224,137,0.05);box-shadow:inset 3px 0 0 var(--amber)">
      <td class="acct" style="font-size:12px">${badge}${fmtAcct(a.buyer_id)}</td>
      <td class="num up" style="font-weight:700">${fmtUsd(a.total_usd)}</td>
      <td class="num">${a.count}</td>
      <td class="num" style="color:var(--ink-dim)">${fmtUsd(avg)}</td>
      <td class="num" style="color:var(--ink-dim)">${fmtUsd(a.max_usd)}</td>
      <td class="num" style="color:var(--ink-dim)">${fmtTime(a.first_ts)}</td>
      <td class="num" style="color:var(--ink-dim)">${fmtTime(a.last_ts)}</td>
      <td class="num" style="color:var(--amber)">${spacingLbl} avg</td>
    </tr>`;
  }).join('');
}

// ── main poll ─────────────────────────────────────────────────

async function pollOnce() {
  try {
    setStatus('warn', 'syncing…');
    const h = state.hours;
    const mq = state.market ? `&market_id=${state.market}` : '';
    const [summary, tradesRes, flow, leaders] = await Promise.all([
      apiGet('/api/lit/summary'),
      apiGet(`/api/lit/trades?limit=100&hours=24${mq}`),
      apiGet(`/api/lit/flow?hours=${h}${mq}`),
      apiGet(`/api/lit/leaders?hours=${h}&top_n=15${mq}`),
    ]);

    const actualHours = flow.oldest_ts
      ? (Date.now() - flow.oldest_ts) / 3600000
      : 0;

    // Update period button labels to reflect actual data age
    $$('.controls .btn[data-hours]').forEach(b => {
      const bh = Number(b.dataset.hours);
      const orig = b.dataset.label || (b.dataset.label = b.textContent);
      if (actualHours > 0 && actualHours < bh * 0.95) {
        b.textContent = orig + ' (' + fmtDuration(actualHours) + ')';
        if (!b.classList.contains('active')) b.style.color = 'var(--amber)';
      } else {
        b.textContent = orig;
        b.style.color = '';
      }
    });

    state._lastTrades = tradesRes.trades || [];
    const twapAlerts = detectTwap(state._lastTrades);
    state._twapBuyers = new Set(twapAlerts.map(a => a.buyer_id));
    renderSummary(summary);
    renderTrades(state._lastTrades);
    renderFlow(flow, actualHours);
    renderLeaders(leaders, actualHours);
    renderTwap(twapAlerts);

    state.tickCount++;
    $('#tickCount').textContent = state.tickCount + ' polls';
    $('#lastSync').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setStatus('ok', 'live');
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

// ── event wiring ──────────────────────────────────────────────

$('#whaleSelect').addEventListener('change', e => {
  state.whaleMin = Number(e.target.value);
  if (state._lastTrades) {
    state._twapBuyers = new Set(detectTwap(state._lastTrades).map(a => a.buyer_id));
    renderTrades(state._lastTrades);
    renderTwap(detectTwap(state._lastTrades));
  }
});

$('#twapWindowSelect').addEventListener('change', e => {
  state.twapWindowMs = Number(e.target.value);
  if (state._lastTrades) {
    const alerts = detectTwap(state._lastTrades);
    state._twapBuyers = new Set(alerts.map(a => a.buyer_id));
    renderTrades(state._lastTrades);
    renderTwap(alerts);
  }
});

$('#twapMinTrades').addEventListener('change', e => {
  state.twapMinTrades = Number(e.target.value);
  if (state._lastTrades) {
    const alerts = detectTwap(state._lastTrades);
    state._twapBuyers = new Set(alerts.map(a => a.buyer_id));
    renderTrades(state._lastTrades);
    renderTwap(alerts);
  }
});

$$('.controls .btn[data-market]').forEach(b => {
  b.addEventListener('click', () => {
    $$('.controls .btn[data-market]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.market = b.dataset.market;
    pollOnce();
  });
});

$$('.controls .btn[data-hours]').forEach(b => {
  b.addEventListener('click', () => {
    $$('.controls .btn[data-hours]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.hours = Number(b.dataset.hours);
    pollOnce();
  });
});

$$('.controls .btn[data-refresh]').forEach(b => {
  b.addEventListener('click', () => {
    $$('.controls .btn[data-refresh]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.refreshMs = Number(b.dataset.refresh) * 1000;
    schedule();
    if (state.refreshMs === 0) setStatus('warn', 'paused');
  });
});

// ── boot ──────────────────────────────────────────────────────
pollOnce();
schedule();
