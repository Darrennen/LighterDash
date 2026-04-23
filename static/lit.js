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
const fmtMYT  = ts => {
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  return d.toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur', hour12: false,
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};
const fmtTimeMYT = ts => new Date(ts > 1e12 ? ts : ts * 1000).toLocaleTimeString('en-MY', {
  timeZone: 'Asia/Kuala_Lumpur', hour12: false,
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
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
    const bigBuy   = isBuy  && t.usd >= state.whaleMin;
    const bigSell  = !isBuy && t.usd >= state.whaleMin;
    const mega     = isBuy  && t.usd >= 1_000_000;
    const tier1    = isBuy  && t.usd >= 500_000;
    const megaSell = !isBuy && t.usd >= 1_000_000;
    const bigSellT2 = !isBuy && t.usd >= 500_000;
    const isTwap     = isBuy  && (state._twapBuyers  || new Set()).has(t.buyer_id);
    const isTwapSell = !isBuy && (state._twapSellers || new Set()).has(t.seller_id);

    const rowStyle = isTwap
      ? 'background:rgba(242,193,78,0.06);box-shadow:inset 3px 0 0 var(--amber)'
      : bigBuy
      ? 'background:rgba(111,224,137,0.07);box-shadow:inset 3px 0 0 var(--green)'
      : isTwapSell
      ? 'background:rgba(255,90,90,0.06);box-shadow:inset 3px 0 0 var(--red)'
      : bigSell
      ? 'background:rgba(255,90,90,0.05);box-shadow:inset 3px 0 0 var(--red)'
      : '';
    const usdCls = bigBuy ? 'up' : bigSell ? 'down' : t.usd >= 10000 ? '' : 'neutral';
    const badge = mega
      ? `<span class="tier t1" style="margin-left:4px">MEGA</span>`
      : tier1
      ? `<span class="tier t2" style="margin-left:4px">BIG</span>`
      : bigBuy
      ? `<span class="tier t3" style="margin-left:4px">BIG BUY</span>`
      : isTwap
      ? `<span class="tier t3" style="margin-left:4px;background:rgba(242,193,78,0.2);color:var(--amber)">TWAP</span>`
      : megaSell
      ? `<span class="tier t1" style="margin-left:4px;background:rgba(255,90,90,0.2);color:var(--red)">MEGA SELL</span>`
      : bigSellT2
      ? `<span class="tier t2" style="margin-left:4px;background:rgba(255,90,90,0.2);color:var(--red)">BIG SELL</span>`
      : bigSell
      ? `<span class="tier t3" style="margin-left:4px;background:rgba(255,90,90,0.15);color:var(--red)">BIG SELL</span>`
      : isTwapSell
      ? `<span class="tier t3" style="margin-left:4px;background:rgba(255,90,90,0.2);color:var(--red)">TWAP SELL</span>`
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
  $('#buyersPeriod').innerHTML  = lbl + ' · by USD bought' + coverageSuffix;
  $('#sellersPeriod').innerHTML = lbl + ' · by USD sold'   + coverageSuffix;

  const leaderRow = (item, rank, role) => {
    const avg = item.trade_count > 0 ? item.total_usd / item.trade_count : 0;
    const firstMYT = item.first_ts ? fmtMYT(item.first_ts) : '—';
    const lastMYT  = item.last_ts  ? fmtMYT(item.last_ts)  : '—';
    return `<tr class="leader-row" data-id="${item.account_id}" data-role="${role}"
               style="cursor:pointer" title="Click to see trade timeline">
      <td class="rank">${rank}</td>
      <td class="acct" style="font-size:12px">
        ${fmtAcct(item.account_id)}
        <a href="/explorer?q=${item.account_id}" target="_blank"
           style="color:var(--accent);font-size:9px;margin-left:4px;text-decoration:none"
           onclick="event.stopPropagation()" title="Open in Explorer">↗</a>
      </td>
      <td class="num">${fmtUsd(item.total_usd)}</td>
      <td class="num">${Number(item.trade_count).toLocaleString()}</td>
      <td class="num" style="color:var(--ink-dim)">${fmtUsd(avg)}</td>
      <td class="num" style="color:var(--ink-faint);font-size:10px">${firstMYT}</td>
      <td class="num" style="color:var(--ink-faint);font-size:10px">${lastMYT}</td>
    </tr>
    <tr class="expand-row" id="expand-${role}-${item.account_id}" style="display:none">
      <td colspan="7" style="padding:0"></td>
    </tr>`;
  };

  const buyers  = data.buyers  || [];
  const sellers = data.sellers || [];

  $('#buyersBody').innerHTML = buyers.length
    ? buyers.map((b, i) => leaderRow(b, i + 1, 'buyer')).join('')
    : `<tr><td colspan="7" class="empty">no data yet — history builds over time</td></tr>`;

  $('#sellersBody').innerHTML = sellers.length
    ? sellers.map((s, i) => leaderRow(s, i + 1, 'seller')).join('')
    : `<tr><td colspan="7" class="empty">no data yet — history builds over time</td></tr>`;

  // wire click-to-expand
  $$('.leader-row').forEach(row => {
    row.addEventListener('click', () => toggleLeaderExpand(
      row.dataset.id, row.dataset.role
    ));
  });
}

async function toggleLeaderExpand(accountId, role) {
  const expandRow = $(`#expand-${role}-${accountId}`);
  if (!expandRow) return;

  if (expandRow.style.display !== 'none') {
    expandRow.style.display = 'none';
    return;
  }

  const cell = expandRow.querySelector('td');
  cell.innerHTML = `<div style="padding:10px;color:var(--ink-faint);font-size:11px">loading timeline…</div>`;
  expandRow.style.display = '';

  try {
    const mq = state.market ? `&market_id=${state.market}` : '';
    const data = await apiGet(`/api/lit/account?account_id=${accountId}&hours=${state.hours}&role=${role}${mq}`);
    const trades = data.trades || [];

    if (!trades.length) {
      cell.innerHTML = `<div style="padding:10px;color:var(--ink-faint);font-size:11px">no trades found in this window</div>`;
      return;
    }

    const isBuyer = role === 'buyer';
    const rows = trades.map(t => {
      const mkt = t.market_id === 120 ? 'PERP' : 'SPOT';
      const side = t.taker_is_buyer === 1 ? 'buy' : 'sell';
      const bigFlag = t.usd >= state.whaleMin
        ? `<span style="color:${isBuyer ? 'var(--green)' : 'var(--red)'};font-size:9px;margin-left:4px">●</span>`
        : '';
      return `<tr style="font-size:11px;border-bottom:1px solid var(--line)">
        <td style="padding:4px 8px;color:var(--ink-faint)">${fmtTimeMYT(t.ts)} MYT</td>
        <td style="padding:4px 8px;color:var(--ink-faint);font-size:10px">${mkt}</td>
        <td style="padding:4px 8px"><span class="pill ${side}">${side}</span></td>
        <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">$${Number(t.price).toFixed(4)}</td>
        <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">${fmtNum(t.size, 2)}</td>
        <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;font-weight:${t.usd >= state.whaleMin ? '700' : '400'}">${fmtUsd(t.usd)}${bigFlag}</td>
      </tr>`;
    }).join('');

    cell.innerHTML = `
      <div style="padding:8px 12px;background:var(--bg);border-top:1px solid var(--line-2)">
        <div style="font-size:10px;color:var(--ink-faint);letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px">
          Timeline · Account ${fmtAcct(accountId)} · ${trades.length} trades · MYT (UTC+8)
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="font-size:10px;color:var(--ink-faint)">
                <th style="padding:2px 8px;text-align:left;font-weight:500">Time (MYT)</th>
                <th style="padding:2px 8px;text-align:left;font-weight:500">Mkt</th>
                <th style="padding:2px 8px;text-align:left;font-weight:500">Side</th>
                <th style="padding:2px 8px;text-align:right;font-weight:500">Price</th>
                <th style="padding:2px 8px;text-align:right;font-weight:500">Size</th>
                <th style="padding:2px 8px;text-align:right;font-weight:500">USD</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  } catch (e) {
    cell.innerHTML = `<div style="padding:10px;color:var(--red);font-size:11px">error loading timeline: ${e.message}</div>`;
  }
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

function detectTwapSells(trades) {
  const cutoff = Date.now() - state.twapWindowMs;
  const bySeller = new Map();

  for (const t of trades) {
    if (t.taker_is_buyer !== 0) continue;
    if (t.ts < cutoff) continue;
    if (!bySeller.has(t.seller_id)) {
      bySeller.set(t.seller_id, { total_usd: 0, count: 0, max_usd: 0, first_ts: t.ts, last_ts: t.ts, tsList: [] });
    }
    const acc = bySeller.get(t.seller_id);
    acc.total_usd += t.usd;
    acc.count++;
    acc.max_usd = Math.max(acc.max_usd, t.usd);
    acc.first_ts = Math.min(acc.first_ts, t.ts);
    acc.last_ts  = Math.max(acc.last_ts,  t.ts);
    acc.tsList.push(t.ts);
  }

  const alerts = [];
  for (const [seller_id, acc] of bySeller) {
    if (acc.total_usd < state.whaleMin) continue;
    if (acc.count < state.twapMinTrades) continue;
    acc.tsList.sort((a, b) => a - b);
    const gaps = acc.tsList.slice(1).map((ts, i) => ts - acc.tsList[i]);
    const avgSpacingMs = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
    alerts.push({ seller_id, ...acc, avgSpacingMs });
  }

  return alerts.sort((a, b) => b.total_usd - a.total_usd);
}

function renderTwap(buyAlerts, sellAlerts) {
  const tbody = $('#twapBody');
  const total = buyAlerts.length + sellAlerts.length;
  $('#twapCount').textContent = total
    ? total + ' active · ' + fmtDuration(state.twapWindowMs / 3600000) + ' window'
    : '';

  if (!total) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty">no accounts accumulating ≥ ${fmtUsd(state.whaleMin)} in ${fmtDuration(state.twapWindowMs/3600000)} with ${state.twapMinTrades}+ trades</td></tr>`;
    return;
  }

  const makeRow = (a, side) => {
    const isBuySide = side === 'BUY';
    const avg = a.total_usd / a.count;
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
    const acctId = isBuySide ? a.buyer_id : a.seller_id;
    const sideStyle = isBuySide
      ? 'background:rgba(111,224,137,0.05);box-shadow:inset 3px 0 0 var(--green)'
      : 'background:rgba(255,90,90,0.05);box-shadow:inset 3px 0 0 var(--red)';
    const sideLabel = isBuySide
      ? `<span class="pill buy" style="font-size:9px;padding:1px 6px">BUY</span>`
      : `<span class="pill sell" style="font-size:9px;padding:1px 6px">SELL</span>`;
    const amtCls = isBuySide ? 'up' : 'down';
    return `<tr style="${sideStyle}">
      <td>${sideLabel}</td>
      <td class="acct" style="font-size:12px">${badge}${fmtAcct(acctId)}</td>
      <td class="num ${amtCls}" style="font-weight:700">${fmtUsd(a.total_usd)}</td>
      <td class="num">${a.count}</td>
      <td class="num" style="color:var(--ink-dim)">${fmtUsd(avg)}</td>
      <td class="num" style="color:var(--ink-dim)">${fmtUsd(a.max_usd)}</td>
      <td class="num" style="color:var(--ink-dim)">${fmtTime(a.first_ts)}</td>
      <td class="num" style="color:var(--ink-dim)">${fmtTime(a.last_ts)}</td>
      <td class="num" style="color:var(--amber)">${spacingLbl} avg</td>
    </tr>`;
  };

  // interleave buy + sell sorted by total_usd desc
  const combined = [
    ...buyAlerts.map(a => ({ ...a, side: 'BUY' })),
    ...sellAlerts.map(a => ({ ...a, side: 'SELL' })),
  ].sort((a, b) => b.total_usd - a.total_usd);

  tbody.innerHTML = combined.map(a => makeRow(a, a.side)).join('');
}

function renderCvd(trades) {
  const el = $('#cvdChart');
  if (!el) return;
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  if (sorted.length < 2) {
    el.innerHTML = `<div style="color:var(--ink-faint);font-size:11px;padding:12px 0">collecting trades for CVD chart…</div>`;
    return;
  }

  let cvd = 0;
  const series = sorted.map(t => {
    cvd += t.taker_is_buyer === 1 ? t.usd : -t.usd;
    return { ts: t.ts, cvd };
  });

  const W = 600, H = 72;
  const minCvd = Math.min(...series.map(p => p.cvd));
  const maxCvd = Math.max(...series.map(p => p.cvd));
  const range = maxCvd - minCvd || 1;
  const minTs = series[0].ts;
  const spanMs = (series[series.length - 1].ts - minTs) || 1;

  const px = ts => ((ts - minTs) / spanMs * W).toFixed(1);
  const py = v  => (H - ((v - minCvd) / range * H)).toFixed(1);
  const zeroY = py(Math.max(minCvd, Math.min(maxCvd, 0)));

  const pts = series.map(p => `${px(p.ts)},${py(p.cvd)}`).join(' ');
  const lastCvd = series[series.length - 1].cvd;
  const lineColor = lastCvd >= 0 ? 'var(--green)' : 'var(--red)';

  // shaded fill from zero line
  const fillPts = `0,${zeroY} ${pts} ${px(series[series.length-1].ts)},${zeroY}`;
  const fillColor = lastCvd >= 0 ? 'rgba(111,224,137,0.08)' : 'rgba(255,90,90,0.08)';

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">
      <polygon points="${fillPts}" fill="${fillColor}" />
      <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="var(--line-2)" stroke-width="1" stroke-dasharray="3,3" />
      <polyline points="${pts}" fill="none" stroke="${lineColor}" stroke-width="1.5" />
    </svg>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--ink-faint);margin-top:4px">
      <span>${fmtUsd(minCvd)}</span>
      <span style="color:${lineColor};font-weight:700">${fmtUsd(lastCvd)} CVD · ${trades.length} trades</span>
      <span>${fmtUsd(maxCvd)}</span>
    </div>`;
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
    const twapAlerts     = detectTwap(state._lastTrades);
    const twapSellAlerts = detectTwapSells(state._lastTrades);
    state._twapBuyers  = new Set(twapAlerts.map(a => a.buyer_id));
    state._twapSellers = new Set(twapSellAlerts.map(a => a.seller_id));
    renderSummary(summary);
    renderTrades(state._lastTrades);
    renderFlow(flow, actualHours);
    renderLeaders(leaders, actualHours);
    renderTwap(twapAlerts, twapSellAlerts);
    renderCvd(state._lastTrades);

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

function recomputePressure() {
  if (!state._lastTrades) return;
  const buyAlerts  = detectTwap(state._lastTrades);
  const sellAlerts = detectTwapSells(state._lastTrades);
  state._twapBuyers  = new Set(buyAlerts.map(a => a.buyer_id));
  state._twapSellers = new Set(sellAlerts.map(a => a.seller_id));
  renderTrades(state._lastTrades);
  renderTwap(buyAlerts, sellAlerts);
}

$('#whaleSelect').addEventListener('change', e => {
  state.whaleMin = Number(e.target.value);
  recomputePressure();
});

$('#twapWindowSelect').addEventListener('change', e => {
  state.twapWindowMs = Number(e.target.value);
  recomputePressure();
});

$('#twapMinTrades').addEventListener('change', e => {
  state.twapMinTrades = Number(e.target.value);
  recomputePressure();
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
