/* ──────────────────────────────────────────────────────────────
   Lighter Account Explorer
   ────────────────────────────────────────────────────────────── */

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const fmtUsd = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(2) + 'K';
  return sign + '$' + abs.toFixed(2);
};
const fmtNum = (n, dp = 4) => n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtMYT = ts => {
  const d = typeof ts === 'string' ? new Date(ts) : new Date(ts > 1e12 ? ts : ts * 1000);
  return d.toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur', hour12: false,
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
};
const truncAddr = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';

let _currentAccountIndex = null;

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

  // Portfolio value: API may return 0 for spot-only accounts that haven't
  // deposited USDC collateral. Fall back to estimating from spot asset values.
  const apiPortfolio = parseFloat(data.total_asset_value || 0);
  const spotEstimate = (data.assets || []).reduce((sum, a) => {
    const price = priceMap[a.symbol] ?? 0;
    return sum + parseFloat(a.balance || 0) * price;
  }, 0);
  const collateral = parseFloat(data.collateral || 0);
  const portfolioValue = apiPortfolio > 0 ? apiPortfolio : collateral + spotEstimate;
  $('#cardPortfolio').textContent = fmtUsd(portfolioValue);
  if (apiPortfolio === 0 && spotEstimate > 0) {
    // show that this is an estimate
    $('#cardPortfolio').title = 'Estimated from spot token balances × current prices';
    $('#cardPortfolio').style.opacity = '0.85';
  }
  $('#cardCollateral').textContent = fmtUsd(collateral);
  $('#cardAvail').textContent = fmtUsd(parseFloat(data.available_balance || 0));
  $('#cardOrders').textContent = data.pending_order_count ?? '—';

  renderPositions(data.positions || []);
  renderAssets(data.assets || [], priceMap);
  renderLitStaking(data.lit_staking || {});

  // prime history state — loads on tab click
  _histAddress = data.l1_address || '';
  _histAccountIndex = idx;
  _histOffset = 0;
  $('#litHistBody').innerHTML = `<tr><td colspan="7" class="empty">click the "Trade History" tab to load</td></tr>`;
  $('#histPrevBtn').style.display = 'none';
  $('#histNextBtn').style.display = 'none';
  $('#histPageInfo').textContent = '';
}

function renderPositions(positions) {
  const tbody = $('#posBody');
  if (!positions.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">no open positions</td></tr>`;
    return;
  }

  // sort by abs position value desc
  positions.sort((a, b) => Math.abs(parseFloat(b.position_value)) - Math.abs(parseFloat(a.position_value)));

  tbody.innerHTML = positions.map(p => {
    const isLong = parseInt(p.sign) >= 0;
    const size = parseFloat(p.position);
    const pnl = parseFloat(p.unrealized_pnl || 0);
    const funding = parseFloat(p.total_funding_paid_out || 0);
    const pnlCls = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
    const sideCls = isLong ? 'pos-long' : 'pos-short';
    const liqPrice = parseFloat(p.liquidation_price);
    const liqDisplay = liqPrice > 0 ? '$' + liqPrice.toFixed(4) : '—';

    return `<tr>
      <td style="font-weight:600">${p.symbol}</td>
      <td><span class="pill ${isLong ? 'buy' : 'sell'}">${isLong ? 'long' : 'short'}</span></td>
      <td class="num ${sideCls}">${fmtNum(size, 2)}</td>
      <td class="num">$${fmtNum(parseFloat(p.avg_entry_price), 4)}</td>
      <td class="num">${fmtUsd(parseFloat(p.position_value))}</td>
      <td class="num ${pnlCls}" style="font-weight:600">${fmtUsd(pnl)}</td>
      <td class="num" style="color:var(--red)">${liqDisplay}</td>
      <td class="num" style="color:var(--ink-dim)">${funding !== 0 ? fmtUsd(funding) : '—'}</td>
    </tr>`;
  }).join('');
}

function renderAssets(assets, priceMap = {}) {
  const tbody = $('#assetBody');
  if (!assets.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">no spot assets held</td></tr>`;
    return;
  }

  let totalUsd = 0;
  const rows = assets.map(a => {
    const bal = parseFloat(a.balance);
    const locked = parseFloat(a.locked_balance || 0);
    const price = priceMap[a.symbol];
    const usdVal = price != null ? bal * price : null;
    if (usdVal != null) totalUsd += usdVal;
    const usdDisplay = usdVal != null
      ? `<span style="font-weight:${usdVal >= 1000 ? '600' : '400'}">${fmtUsd(usdVal)}</span>`
      : `<span style="color:var(--ink-faint)">—</span>`;
    return `<tr>
      <td style="font-weight:600">${a.symbol}</td>
      <td class="num">${fmtNum(bal, 6)}</td>
      <td class="num">${usdDisplay}</td>
      <td class="num" style="color:${locked > 0 ? 'var(--amber)' : 'var(--ink-faint)'}" title="${locked > 0 ? 'Reserved for pending limit orders' : ''}">${locked > 0 ? fmtNum(locked, 6) : '—'}</td>
    </tr>`;
  }).join('');

  const totalRow = totalUsd > 0
    ? `<tr style="border-top:1px solid var(--line);font-weight:600">
        <td style="color:var(--ink-faint);font-size:10px;letter-spacing:.1em;text-transform:uppercase">Total</td>
        <td></td>
        <td class="num">${fmtUsd(totalUsd)}</td>
        <td></td>
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

// wire history market filter buttons
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
          <div style="font-size:10px;color:var(--ink-faint);margin-top:2px">${buyT} trade${buyT !== 1 ? 's' : ''}</div>
          ${d.buy_avg_price != null ? `<div style="font-size:10px;color:var(--ink-dim);margin-top:3px">avg $${Number(d.buy_avg_price).toFixed(4)}</div>` : ''}
        </div>
        <div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--red);margin-bottom:3px">Sell</div>
          <div style="font-size:16px;font-weight:600;color:var(--red);font-variant-numeric:tabular-nums">${fmtUsd(sell)}</div>
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
        <span style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;${netCls}">${net >= 0 ? '+' : ''}${fmtUsd(net)}</span>
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
