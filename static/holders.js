/* ─────────────────────────────────────────────────────────────
   Holders — LIT holder tiers + leaderboard for Lighter
   Talks to /api/holders/summary.
   ───────────────────────────────────────────────────────────── */

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// Net LIT moved in the window. Dormant is its own state, not zero-with-a-dash:
// 20 of the top 25 holders have not moved a single LIT in 30 days, and that
// stillness is the finding.
function flowCell(v) {
  if (v == null) return '<td class="num">—</td>';
  if (Math.abs(v) < 1) return '<td class="num" style="color:var(--ink-faint)">dormant</td>';
  const up = v > 0;
  return `<td class="num" style="color:${up ? 'var(--green)' : 'var(--red)'}">${up ? '+' : '−'}${fmtLit(Math.abs(v))}</td>`;
}

// ── formatters (copied verbatim from traders.js for consistency) ───
const fmtUsd = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(2) + 'K';
  return sign + '$' + abs.toFixed(2);
};
const fmtNum = n => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtPct1 = n => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(1) + '%';

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

// ── LIT amount formatter — thousands separators, more decimals below 1 ──
const fmtLit = n => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1) return Number(n).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const fmtLitShort = n => n >= 1e6 ? (n / 1e6) + 'M' : n >= 1e3 ? (n / 1e3) + 'K' : String(n);

// ── tier display colors (mirrors the .tier t1/t2/t3 palette already in styles.css) ──
const TIER_COLOR = {
  mega:    { bg: 'var(--accent)',              fg: '#04101f' },
  whale:   { bg: 'rgba(111,185,255,0.35)',     fg: '#cfe7ff' },
  dolphin: { bg: 'rgba(111,185,255,0.14)',     fg: 'var(--accent)' },
  fish:    { bg: 'rgba(242,193,78,0.15)',      fg: 'var(--amber)' },
  shrimp:  { bg: 'rgba(135,148,168,0.15)',     fg: 'var(--ink-dim)' },
};
const TIER_LABEL = {
  mega: 'Mega Whale', whale: 'Whale', dolphin: 'Dolphin', fish: 'Fish', shrimp: 'Shrimp',
};

function tierPill(tier, label) {
  const c = TIER_COLOR[tier] || { bg: 'var(--line-2)', fg: 'var(--ink-dim)' };
  return `<span class="pill" style="background:${c.bg};color:${c.fg}">${label || tier}</span>`;
}

// ── KPI strip ────────────────────────────────────────────────
// The KPI row reports the GLOBAL on-chain set. Bridge and burn balances are
// split out rather than counted as holders: the bridge is the L2 float, and
// burned LIT belongs to nobody.
let _litPrice = 0;

// Two genuinely different populations, not one list with a flag:
//   outside — L1 addresses holding LIT on Ethereum, no Lighter account needed
//   inside  — accounts holding LIT inside Lighter L2
// The bridge is the seam: its L1 balance IS the whole L2 float.
let _side = 'outside';
let _l1 = null, _l2 = null;

function renderStats(l1) {
  if (!l1 || !l1.count) return;
  const supply = Number(l1.meta.total_supply || 0);
  const by = k => (l1.kinds || []).find(x => x.kind === k) || { lit: 0, holders: 0 };
  const pct = v => supply ? ` · ${(v / supply * 100).toFixed(2)}% of supply` : '';

  $('#kpi-holders').textContent = fmtNum(l1.count);
  $('#kpi-holders-sub').textContent =
    `addresses holding LIT · ${Number(l1.meta.accounted_pct).toFixed(2)}% of supply accounted`;

  const w = by('wallet');
  $('#kpi-wallets').textContent = fmtLit(w.lit);
  $('#kpi-wallets-sub').textContent = `${fmtNum(w.holders)} wallets${pct(w.lit)}`;

  const b = by('bridge');
  $('#kpi-bridge').textContent = fmtLit(b.lit);
  $('#kpi-bridge-sub').textContent = `held by the L1 bridge${pct(b.lit)}`;

  const x = by('burn');
  $('#kpi-burned').textContent = fmtLit(x.lit);
  $('#kpi-burned-sub').textContent = `sent to 0x…dead${pct(x.lit)}`;
}

// ── Top LIT Holders table ───────────────────────────────────
function renderHolders(l1) {
  if (_side === 'inside') return renderInsideTable();
  const tbody = $('#holdersBody');
  // "Not in Lighter" excludes the bridge: its balance is the L2 float, so
  // counting it on the outside side would double-count the inside one.
  const all = l1?.holders || [];
  const holders = _side === 'outside' ? all.filter(h => h.kind !== 'bridge') : all;
  const asOf = l1?.meta?.snapshot_ts
    ? new Date(Number(l1.meta.snapshot_ts) * 1000).toLocaleString('en-MY',
        { timeZone: 'Asia/Kuala_Lumpur', hour12: false,
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  const bridge = (l1?.kinds || []).find(k => k.kind === 'bridge');
  $('#holdersCaption').innerHTML = l1?.count
    ? (_side === 'outside'
        ? `LIT held OUTSIDE Lighter — ${fmtNum(l1.count - 1)} Ethereum addresses, `
          + `${fmtLit((l1.total_lit || 0) - (bridge?.lit || 0))} LIT`
        : `every address holding LIT on Ethereum · ${fmtNum(l1.count)} total, `
          + `${Number(l1.meta.accounted_pct).toFixed(2)}% of the 1B supply accounted`)
      + (asOf ? ` · as of ${asOf}` : '')
    : '';

  if (!l1) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">holder set unavailable</td></tr>`;
    return;
  }
  if (!holders.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">holder set not loaded — run scripts/load_lit_holders.py</td></tr>`;
    return;
  }

  // Bridge and burn rows are real balances but not holders; marked so neither
  // is read as somebody's position.
  const KIND = {
    bridge: '<span class="tier t1" title="Lighter L1 bridge — this balance is the L2 float">BRIDGE</span>',
    burn:   '<span class="tier t3" title="sent to 0x…dead">BURNED</span>',
  };
  tbody.innerHTML = holders.map(h => `<tr${h.kind !== 'wallet' ? ' style="opacity:.75"' : ''}>
      <td class="rank">${h.rank}</td>
      <td class="acct" style="font-size:11px"><a href="/explorer?q=${h.address}" title="open in explorer" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line-2)">${h.address}</a>${h.label ? `<div style="color:var(--ink-faint);font-size:10px">${h.label}</div>` : ''}</td>
      <td class="num">${fmtLit(h.lit)}</td>
      <td class="num">${_litPrice ? fmtUsd(h.lit * _litPrice) : '—'}</td>
      <td class="num">${h.pct_supply != null ? h.pct_supply.toFixed(3) + '%' : '—'}</td>
      ${flowCell(h.net_30d)}
      <td>${KIND[h.kind] || ''}</td>
    </tr>`).join('');
}

// ── inside-Lighter view ──────────────────────────────────────────────
// Deliberately honest about its own incompleteness: the bridge holds the whole
// L2 float, but we can only see accounts we have scanned, which is a fraction.
function renderInsideTable() {
  const tbody = $('#holdersBody');
  const rows = _l2?.holders || [];
  const bridge = (_l1?.kinds || []).find(k => k.kind === 'bridge');
  const float = bridge?.lit || 0;
  const seen = rows.reduce((a, h) => a + (h.balance_lit || 0), 0);

  $('#holdersCaption').innerHTML = float
    ? `LIT held INSIDE Lighter — ${fmtLit(float)} LIT sits in the L1 bridge, `
      + `of which we can see <b>${fmtLit(seen)}</b> across ${fmtNum(rows.length)} scanned accounts `
      + `(${(seen / float * 100).toFixed(1)}% — only accounts observed trading are scanned)`
    : 'LIT held inside Lighter';

  tbody.innerHTML = rows.length
    ? rows.map((h, i) => `<tr>
        <td class="rank">${i + 1}</td>
        <td class="acct" style="font-size:11px"><a href="/explorer?q=${h.account_index}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line-2)">#${h.account_index}</a></td>
        <td class="num">${fmtLit(h.balance_lit)}</td>
        <td class="num">${h.usd != null ? fmtUsd(h.usd) : (_litPrice ? fmtUsd(h.balance_lit * _litPrice) : '—')}</td>
        <td class="num">${float ? (h.balance_lit / float * 100).toFixed(3) + '%' : '—'}</td>
        <td class="num" style="color:var(--ink-faint)">—</td>
        <td>${tierPill(h.tier, TIER_LABEL[h.tier])}</td>
      </tr>`).join('')
    : `<tr><td colspan="7" class="empty">no scanned Lighter accounts hold LIT</td></tr>`;
}

$$('[data-side]').forEach(b => {
  b.addEventListener('click', () => {
    $$('[data-side]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    _side = b.dataset.side;
    renderHolders(_l1);
  });
});


// ── Tier Breakdown table ─────────────────────────────────────
function renderTiers(l1) {
  const tbody = $('#tierBody');
  const tiers = (l1?.tiers || []).filter(t => t.holders > 0);
  const supply = Number(l1?.meta?.total_supply || 0);
  if (!tiers.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">no tier data yet</td></tr>`;
    return;
  }
  tbody.innerHTML = tiers.map(t => {
    const threshold = t.max == null
      ? `≥ ${fmtLitShort(t.min)}`
      : `${fmtLitShort(t.min)} – ${fmtLitShort(t.max)}`;
    return `<tr>
      <td>${tierPill(t.key, t.label)}</td>
      <td class="num">${threshold}</td>
      <td class="num">${fmtNum(t.holders)}</td>
      <td class="num">${fmtLit(t.lit)}</td>
      <td class="num">${supply ? (t.lit / supply * 100).toFixed(2) + '%' : '—'}</td>
    </tr>`;
  }).join('');
}

// ── Holder Pyramid (hand-rolled inline SVG, mirrors drawVolVenue in lit.js) ──
function drawPyramid(l1) {
  const el = $('#pyramidChart');
  if (!el) return;
  const tiers = (l1?.tiers || []).filter(t => t.holders > 0);
  if (!tiers.length) {
    el.innerHTML = '<div style="color:var(--ink-faint);font-size:11px;padding:12px 0">no tier data yet</div>';
    return;
  }

  const W = 800, rowH = 28, gap = 10, labelW = 92, padR = 60;
  const barMaxW = W - labelW - padR;
  const H = tiers.length * rowH + (tiers.length - 1) * gap;
  const max = Math.max(...tiers.map(t => t.holders), 1);

  const rows = tiers.map((t, i) => {
    const y = i * (rowH + gap);
    const w = Math.max(2, (t.holders / max) * barMaxW);
    const c = TIER_COLOR[t.key] || { bg: 'var(--accent)', fg: 'var(--accent)' };
    const title = `${t.label}: ${fmtNum(t.holders)} holder${t.holders === 1 ? '' : 's'} · ${fmtLit(t.lit)} LIT`;
    return `<g>
      <text x="0" y="${(y + rowH / 2 + 4).toFixed(1)}" fill="var(--ink-dim)" font-size="11" font-family="monospace">${t.label}</text>
      <rect x="${labelW}" y="${y}" width="${barMaxW}" height="${rowH}" fill="var(--line)" opacity="0.35"><title>${title}</title></rect>
      <rect x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${rowH}" fill="${c.bg}" stroke="${c.fg}" stroke-width="1"><title>${title}</title></rect>
      <text x="${(labelW + w + 8).toFixed(1)}" y="${(y + rowH / 2 + 4).toFixed(1)}" fill="var(--ink)" font-size="11" font-family="monospace">${fmtNum(t.holders)}</text>
    </g>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" style="width:100%;height:${H}px;display:block">${rows}</svg>`;
}

// ── fetch + refresh ──────────────────────────────────────────
async function refreshAll() {
  // Two different questions: the global on-chain holder set drives the page,
  // and the Lighter L2 sample gets its own clearly-labelled section below.
  const [l1, l2] = await Promise.all([
    apiGet('/api/holders/l1?limit=100'),
    apiGet('/api/holders/summary?limit=100'),
  ]);

  setStatus(l1 ? '' : 'err', l1 ? 'live' : 'backend unreachable');
  $('#lastSync').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });

  _litPrice = Number(l2?.lit_price || 0);
  _l1 = l1; _l2 = l2;
  renderStats(l1);
  renderHolders(l1);
  renderTiers(l1);
  drawPyramid(l1);
}

// ── boot ─────────────────────────────────────────────────────
refreshAll();
setInterval(refreshAll, 60_000);
