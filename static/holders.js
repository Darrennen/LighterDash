/* ─────────────────────────────────────────────────────────────
   Holders — LIT holder tiers + leaderboard for Lighter
   Talks to /api/holders/summary.
   ───────────────────────────────────────────────────────────── */

const $ = s => document.querySelector(s);

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
function renderStats(d) {
  if (!d) return;
  $('#kpi-holders').textContent = fmtNum(d.holders_count);
  $('#kpi-holders-sub').textContent = `≥100K LIT · of ${fmtNum(d.accounts_scanned)} accounts scanned`;

  $('#kpi-whales').textContent = fmtNum(d.stats?.whale_count);
  $('#kpi-mega').textContent = fmtNum(d.stats?.mega_count);

  $('#kpi-tracked').textContent = fmtLit(d.tracked_lit_total);
  $('#kpi-tracked-sub').textContent = `≈ ${fmtUsd(d.tracked_usd_total)} · whale+mega only`;
}

// ── Top LIT Holders table ───────────────────────────────────
function renderHolders(d) {
  const tbody = $('#holdersBody');
  const holders = d?.holders || [];
  $('#holdersCaption').textContent = d
    ? `${fmtNum(d.holders_count)} whale+mega holders (≥100K LIT) among ${fmtNum(d.accounts_scanned)} accounts scanned · smaller balances tracked once, not kept fresh`
    : '';

  if (!d) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">holders unavailable — backend not reachable</td></tr>`;
    return;
  }
  if (!holders.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">no holders tracked yet</td></tr>`;
    return;
  }

  tbody.innerHTML = holders.map((h, i) => `<tr>
      <td class="rank">${i + 1}</td>
      <td>${acctCell(h.account_index)}</td>
      <td class="num">${fmtLit(h.balance_lit)}</td>
      <td class="num">${h.usd != null ? fmtUsd(h.usd) : '—'}</td>
      <td class="num">${fmtPct1(h.share_pct)}</td>
      <td>${tierPill(h.tier, TIER_LABEL[h.tier])}</td>
    </tr>`).join('');
}

// ── Tier Breakdown table ─────────────────────────────────────
function renderTiers(d) {
  const tbody = $('#tierBody');
  const tiers = d?.tier_breakdown || [];
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
      <td class="num">${fmtNum(t.count)}</td>
      <td class="num">${fmtLit(t.lit_sum)}</td>
      <td class="num">${fmtPct1(t.share_pct)}</td>
    </tr>`;
  }).join('');
}

// ── Holder Pyramid (hand-rolled inline SVG, mirrors drawVolVenue in lit.js) ──
function drawPyramid(d) {
  const el = $('#pyramidChart');
  if (!el) return;
  const tiers = d?.tier_breakdown || [];
  if (!tiers.length) {
    el.innerHTML = '<div style="color:var(--ink-faint);font-size:11px;padding:12px 0">no tier data yet</div>';
    return;
  }

  const W = 800, rowH = 28, gap = 10, labelW = 92, padR = 60;
  const barMaxW = W - labelW - padR;
  const H = tiers.length * rowH + (tiers.length - 1) * gap;
  const max = Math.max(...tiers.map(t => t.count), 1);

  const rows = tiers.map((t, i) => {
    const y = i * (rowH + gap);
    const w = Math.max(2, (t.count / max) * barMaxW);
    const c = TIER_COLOR[t.key] || { bg: 'var(--accent)', fg: 'var(--accent)' };
    const title = `${t.label}: ${fmtNum(t.count)} holder${t.count === 1 ? '' : 's'} · ${fmtLit(t.lit_sum)} LIT`;
    return `<g>
      <text x="0" y="${(y + rowH / 2 + 4).toFixed(1)}" fill="var(--ink-dim)" font-size="11" font-family="monospace">${t.label}</text>
      <rect x="${labelW}" y="${y}" width="${barMaxW}" height="${rowH}" fill="var(--line)" opacity="0.35"><title>${title}</title></rect>
      <rect x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${rowH}" fill="${c.bg}" stroke="${c.fg}" stroke-width="1"><title>${title}</title></rect>
      <text x="${(labelW + w + 8).toFixed(1)}" y="${(y + rowH / 2 + 4).toFixed(1)}" fill="var(--ink)" font-size="11" font-family="monospace">${t.count}</text>
    </g>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" style="width:100%;height:${H}px;display:block">${rows}</svg>`;
}

// ── fetch + refresh ──────────────────────────────────────────
async function refreshAll() {
  const d = await apiGet('/api/holders/summary?limit=100');

  setStatus(d ? '' : 'err', d ? 'live' : 'backend unreachable');
  $('#lastSync').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });

  renderStats(d);
  renderHolders(d);
  renderTiers(d);
  drawPyramid(d);
}

// ── boot ─────────────────────────────────────────────────────
refreshAll();
setInterval(refreshAll, 60_000);
