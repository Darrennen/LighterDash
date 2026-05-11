/* ─────────────────────────────────────────────────────────────
   Watchlist — tracked wallet summary page
   ───────────────────────────────────────────────────────────── */

const TW_KEY = 'lit_tracked_v1';
let _period  = '24h';
let _data    = {};   // account_id → full API response (all periods)
let _litPrice = null;

// ── localStorage helpers ──────────────────────────────────────
function twGet()      { try { return JSON.parse(localStorage.getItem(TW_KEY) || '[]'); } catch { return []; } }
function twSet(list)  { try { localStorage.setItem(TW_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ } }
function twAdd(id)    { const l = twGet(); if (!l.find(w => w.account_id===id)) { l.push({account_id:id,label:'',added_at:Date.now()}); twSet(l); return true; } return false; }
function twRemove(id) { twSet(twGet().filter(w => w.account_id !== id)); }
function twSetLabel(id, label) { const l = twGet(); const w = l.find(w=>w.account_id===id); if(w){w.label=label;twSet(l);} }

// ── formatters ────────────────────────────────────────────────
const fmtUsd = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e6) return sign + '$' + (abs/1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs/1e3).toFixed(2) + 'K';
  return sign + '$' + abs.toFixed(2);
};
const fmtLit = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e6) return sign + (abs/1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + (abs/1e3).toFixed(2) + 'K';
  return sign + abs.toLocaleString('en-US', {maximumFractionDigits:2});
};
const fmtSign = n => n >= 0 ? '+' : '';

// ── render ────────────────────────────────────────────────────
function render() {
  const list = twGet();
  const empty = document.getElementById('emptyState');
  const grid  = document.getElementById('cardsGrid');
  const agg   = document.getElementById('aggBar');

  if (!list.length) {
    empty.style.display = '';
    grid.style.display  = 'none';
    agg.style.display   = 'none';
    document.getElementById('statusMsg').textContent = 'No tracked wallets.';
    return;
  }
  empty.style.display = 'none';
  grid.style.display  = '';
  agg.style.display   = '';

  // aggregate totals across all loaded accounts
  let totBuy = 0, totSell = 0, totNetLit = 0, loaded = 0;
  list.forEach(w => {
    const d = (_data[w.account_id] || {})[_period] || {};
    if (d.buy_usd != null) {
      totBuy    += d.buy_usd  || 0;
      totSell   += d.sell_usd || 0;
      totNetLit += d.net_size || 0;
      loaded++;
    }
  });
  const totNet = totBuy - totSell;
  document.getElementById('aggCount').textContent  = list.length;
  document.getElementById('aggBuy').textContent    = loaded ? fmtUsd(totBuy)  : '…';
  document.getElementById('aggSell').textContent   = loaded ? fmtUsd(totSell) : '…';
  const aggNetEl = document.getElementById('aggNet');
  aggNetEl.textContent = loaded ? fmtSign(totNet) + fmtUsd(totNet) : '…';
  aggNetEl.className   = 'agg-val ' + (totNet >= 0 ? 'up' : 'down');
  const aggLitEl = document.getElementById('aggNetLit');
  aggLitEl.textContent = loaded ? fmtSign(totNetLit) + fmtLit(totNetLit) + ' LIT' : '…';
  aggLitEl.className   = 'agg-val ' + (totNetLit >= 0 ? 'up' : 'down');
  document.getElementById('aggTs').textContent = new Date().toLocaleTimeString('en-GB', {hour12:false});

  // render each card
  grid.innerHTML = list.map(w => cardHTML(w)).join('');

  // wire up per-card interactions
  list.forEach(w => {
    // label edit
    const lbl = document.getElementById(`wl-lbl-${w.account_id}`);
    if (lbl) {
      lbl.addEventListener('click', () => {
        const cur = twGet().find(x => x.account_id === w.account_id)?.label || '';
        const inp = document.createElement('input');
        Object.assign(inp.style, {
          fontFamily:'var(--font-mono)',fontSize:'11px',padding:'2px 6px',
          background:'var(--bg)',border:'1px solid var(--accent)',
          borderRadius:'2px',color:'var(--ink)',outline:'none',width:'140px',
        });
        inp.value = cur;
        lbl.replaceWith(inp);
        inp.focus();
        const save = () => { twSetLabel(w.account_id, inp.value.trim()); render(); };
        inp.addEventListener('blur', save);
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
      });
    }
    // remove
    const rm = document.getElementById(`wl-rm-${w.account_id}`);
    if (rm) rm.addEventListener('click', () => { twRemove(w.account_id); delete _data[w.account_id]; render(); });
  });
}

function cardHTML(w) {
  const raw   = _data[w.account_id];
  const errMsg = raw?._error_msg;
  const d    = (raw || {})[_period];
  const loading = !raw;   // raw undefined = still fetching; raw._error = failed

  const buy    = d?.buy_usd  || 0;
  const sell   = d?.sell_usd || 0;
  const net    = d?.net_usd  || 0;
  const bSize  = d?.buy_size || 0;
  const sSize  = d?.sell_size|| 0;
  const nSize  = d?.net_size || 0;
  const buyAvg = d?.buy_avg_price;
  const selAvg = d?.sell_avg_price;
  const buyT   = d?.buy_trades  || 0;
  const sellT  = d?.sell_trades || 0;
  const total  = buy + sell || 1;
  const buyPct = (buy / total * 100).toFixed(1);
  const noData = d && buy === 0 && sell === 0;
  const netCls = net >= 0 ? 'var(--green)' : 'var(--red)';
  const litCls = nSize >= 0 ? 'var(--green)' : 'var(--red)';

  const labelText = w.label
    ? `<span id="wl-lbl-${w.account_id}" class="card-label">${w.label}</span>`
    : `<span id="wl-lbl-${w.account_id}" class="card-label" style="color:var(--ink-faint);font-style:italic">click to label</span>`;

  // PnL section
  const avgBuy = d?.buy_avg_price;
  let pnlHtml = '';
  if (!loading && !noData && avgBuy && _litPrice && avgBuy > 0) {
    const pnlPct = (_litPrice - avgBuy) / avgBuy * 100;
    const pnlCls = pnlPct >= 0 ? 'var(--green)' : 'var(--red)';
    const bSize = d?.buy_size || 0;
    const pnlUsd = bSize * (_litPrice - avgBuy);
    pnlHtml = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)">Unrealized PnL</div>
      <div style="text-align:right">
        <div style="font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;color:${pnlCls}">${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%</div>
        <div style="font-size:10px;color:${pnlCls};opacity:.8">${pnlUsd>=0?'+':''}${fmtUsd(pnlUsd)} on ${fmtLit(bSize)} LIT</div>
        <div style="font-size:9px;color:var(--ink-faint);margin-top:1px">avg $${avgBuy.toFixed(4)} → now $${_litPrice.toFixed(4)}</div>
      </div>
    </div>`;
  }

  const inner = loading
    ? `<div class="card-loading">
         <div class="skeleton skeleton-lg"></div>
         <div class="skeleton skeleton-sm"></div>
         <div class="skeleton skeleton-sm" style="width:40%"></div>
       </div>`
    : raw?._error
    ? `<div style="color:var(--ink-faint);font-size:11px;padding:8px 0">${errMsg || 'Account not found or no data available.'}</div>`
    : noData
    ? `<div style="color:var(--ink-faint);font-size:11px;padding:8px 0">No LIT trades found in this window.</div>`
    : `<div class="flow-row">
        <div>
          <div class="flow-side-lbl" style="color:var(--green)">Buy</div>
          <div class="flow-val-lg up">${fmtUsd(buy)}</div>
          ${bSize ? `<div class="flow-lit up">${fmtLit(bSize)} LIT</div>` : ''}
          <div class="flow-sub">${buyT} trade${buyT!==1?'s':''}</div>
          ${buyAvg != null ? `<div class="flow-sub">avg $${Number(buyAvg).toFixed(4)}</div>` : ''}
        </div>
        <div>
          <div class="flow-side-lbl" style="color:var(--red)">Sell</div>
          <div class="flow-val-lg down">${fmtUsd(sell)}</div>
          ${sSize ? `<div class="flow-lit down">${fmtLit(sSize)} LIT</div>` : ''}
          <div class="flow-sub">${sellT} trade${sellT!==1?'s':''}</div>
          ${selAvg != null ? `<div class="flow-sub">avg $${Number(selAvg).toFixed(4)}</div>` : ''}
        </div>
      </div>
      <div>
        <div class="bar-track"><div class="bar-fill" style="width:${buyPct}%"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--ink-faint)">
          <span>${buyPct}% buy</span><span>${(100-buyPct).toFixed(1)}% sell</span>
        </div>
      </div>
      <div class="net-row">
        <div class="net-lbl">Net ${_period}</div>
        <div>
          <div class="net-val" style="color:${netCls}">${fmtSign(net)}${fmtUsd(net)}</div>
          ${nSize != null ? `<div class="net-lit" style="color:${litCls}">${fmtSign(nSize)}${fmtLit(nSize)} LIT</div>` : ''}
        </div>
      </div>
      ${pnlHtml}`;

  return `<div class="card">
    <div class="card-header">
      <div>
        <div class="card-id">
          <a href="/explorer?q=${w.account_id}" target="_blank"
             style="color:var(--ink);text-decoration:none">#${w.account_id}</a>
        </div>
        ${labelText}
      </div>
      <div class="card-actions">
        <a href="/explorer?q=${w.account_id}" target="_blank"
           style="color:var(--accent);font-size:10px;text-decoration:none;letter-spacing:.06em">open ↗</a>
        <button id="wl-rm-${w.account_id}"
          style="background:none;border:none;color:var(--ink-faint);cursor:pointer;font-size:18px;padding:0 2px;line-height:1" title="Remove">×</button>
      </div>
    </div>
    ${inner}
  </div>`;
}

// ── fetch ─────────────────────────────────────────────────────
async function fetchOne(w) {
  const params = new URLSearchParams({ account_id: w.account_id });
  if (w.address) params.set('address', w.address);
  try {
    const r = await fetch(`/api/lit/account-flow-live?${params}`);
    if (!r.ok) {
      const msg = r.status === 404 ? 'Account not found on exchange.'
               : r.status === 429 ? 'Rate limited — try again shortly.'
               : `API error ${r.status}`;
      _data[w.account_id] = { _error: true, _error_msg: msg };
      render();
      return;
    }
    const data = await r.json();
    _data[w.account_id] = data;
    render();
  } catch {
    _data[w.account_id] = { _error: true, _error_msg: 'Network error — check connection.' };
    render();
  }
}

async function refreshAll() {
  const list = twGet();
  if (!list.length) { render(); return; }
  document.getElementById('statusMsg').textContent = `Fetching ${list.length} account${list.length!==1?'s':''}…`;
  render(); // show skeletons first
  // fetch current LIT price in parallel with accounts
  const priceRes = await fetch('/api/lit/summary').then(r => r.json()).catch(() => null);
  if (priceRes) {
    _litPrice = parseFloat(priceRes?.spot?.last_price || priceRes?.perp?.last_price || 0) || null;
  }
  await Promise.allSettled(list.map(fetchOne));
  document.getElementById('statusMsg').textContent =
    `Updated ${new Date().toLocaleTimeString('en-GB',{hour12:false})} · ${list.length} accounts`;
}

// ── period buttons ────────────────────────────────────────────
document.querySelectorAll('[data-period]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-period]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    _period = b.dataset.period;
    render();
  });
});

// ── add account ───────────────────────────────────────────────
function doAdd() {
  const inp = document.getElementById('addInput');
  const raw = inp.value.trim();
  const val = parseInt(raw, 10);
  if (!raw) { inp.placeholder = 'enter an account number'; inp.style.borderColor = 'var(--red)'; setTimeout(() => { inp.style.borderColor = ''; inp.placeholder = 'Add account #'; }, 1500); return; }
  if (!val || val < 1 || isNaN(val)) { inp.style.borderColor = 'var(--red)'; inp.style.outline = 'none'; setTimeout(() => { inp.style.borderColor = ''; }, 1500); return; }
  const added = twAdd(val);
  if (!added) {
    inp.style.borderColor = 'var(--amber)';
    setTimeout(() => { inp.style.borderColor = ''; }, 1500);
    return;
  }
  inp.value = '';
  render();
  const w = twGet().find(x => x.account_id === val);
  if (w) fetchOne(w);
}
document.getElementById('addBtn').addEventListener('click', doAdd);
document.getElementById('addInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') doAdd();
});

// ── boot ─────────────────────────────────────────────────────
refreshAll();
setInterval(refreshAll, 120_000); // auto-refresh every 2 min
