'use strict';
/* Munney SPA — vanilla JS, hash routing, hand-rolled SVG charts. */

// ---------- utilities ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}

const fmtUSD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function fmt(cents) { return fmtUSD.format((cents || 0) / 100); }
function fmtShort(cents) {
  const d = (cents || 0) / 100;
  if (Math.abs(d) >= 1000) return (d < 0 ? '-$' : '$') + (Math.abs(d) / 1000).toFixed(1) + 'k';
  return (d < 0 ? '-$' : '$') + Math.abs(d).toFixed(0);
}
function parseMoney(str) {
  const n = Number(String(str).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function thisMonth() { return new Date().toISOString().slice(0, 7); }
function today() { return new Date().toISOString().slice(0, 10); }
function monthLabel(m) {
  const [y, mo] = m.split('-');
  return new Date(Date.UTC(+y, +mo - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function monthShort(m) {
  const [y, mo] = m.split('-');
  return new Date(Date.UTC(+y, +mo - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
}
function shiftMonth(m, delta) {
  let [y, mo] = m.split('-').map(Number);
  mo += delta;
  while (mo < 1) { mo += 12; y--; }
  while (mo > 12) { mo -= 12; y++; }
  return `${y}-${String(mo).padStart(2, '0')}`;
}
function signClass(cents) { return cents > 0 ? 'pos' : cents < 0 ? 'neg' : ''; }

// ---------- inline icons (stroked, currentColor) ----------
const ICON = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  left: '<polyline points="15 18 9 12 15 6"/>',
  right: '<polyline points="9 18 15 12 9 6"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.5"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  networth: '<path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/>',
  income: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  spending: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  net: '<path d="M12 3v3M12 18v3"/><path d="M7.5 7.5h6a2.5 2.5 0 0 1 0 5h-3a2.5 2.5 0 0 0 0 5h6"/>',
  wallet: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H18a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 8.5V6.5A1.5 1.5 0 0 1 4.5 5H16"/><circle cx="16.5" cy="13" r="1.3" fill="currentColor" stroke="none"/>',
  receipt: '<path d="M5 3h14v18l-3-1.5L13 21l-3-1.5L7 21l-2-1z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  repeat: '<path d="M17 2.1 21 6l-4 3.9"/><path d="M21 6H8a4 4 0 0 0-4 4v1"/><path d="M7 21.9 3 18l4-3.9"/><path d="M3 18h13a4 4 0 0 0 4-4v-1"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>',
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M4 12 6.5 5h11L20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16l3-4 3 2 5-7"/>',
};
function ic(name, cls = '') {
  return `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;
}

function toast(msg, type = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const glyph = type === 'success' ? ic('check') : type === 'error' ? ic('alert') : '';
  el.innerHTML = glyph + `<span>${esc(msg)}</span>`;
  root.appendChild(el);
  // keep at most 3 toasts on screen
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); }, 2800);
}

// ---------- modal ----------
let modalKeyHandler = null;
function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">
    <button class="icon-btn modal-close" aria-label="Close dialog">${ic('close')}</button>${html}</div></div>`;
  const modal = root.querySelector('.modal');
  root.querySelector('.modal-back').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  root.querySelector('.modal-close').addEventListener('click', closeModal);
  modalKeyHandler = e => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', modalKeyHandler);
  // focus the first field for keyboard users, unless a caller already focused one
  requestAnimationFrame(() => {
    if (!modal.contains(document.activeElement)) {
      modal.querySelector('input, select, textarea, button:not(.modal-close)')?.focus();
    }
  });
  return modal;
}
function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
  if (modalKeyHandler) { document.removeEventListener('keydown', modalKeyHandler); modalKeyHandler = null; }
}

// ---------- theme ----------
function currentTheme() {
  return document.documentElement.getAttribute('data-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function paintThemeToggles() {
  const dark = currentTheme() === 'dark';
  document.querySelectorAll('.theme-toggle').forEach(btn => {
    const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = ic(dark ? 'sun' : 'moon') + (btn.classList.contains('icon-btn') ? '' : `<span>${dark ? 'Light mode' : 'Dark mode'}</span>`);
  });
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101318' : '#ffffff');
}
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('munney-theme', theme); } catch {}
  paintThemeToggles();
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('munney-theme'); } catch {}
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  paintThemeToggles();
  document.querySelectorAll('.theme-toggle').forEach(btn =>
    btn.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark')));
}

// ---------- mobile nav drawer ----------
function setNav(open) {
  document.body.classList.toggle('nav-open', open);
  const toggle = document.getElementById('nav-toggle');
  toggle?.setAttribute('aria-expanded', String(open));
}
function initNav() {
  document.getElementById('nav-toggle')?.addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
  document.getElementById('scrim')?.addEventListener('click', () => setNav(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setNav(false); });
}

// ---------- shared UI states ----------
function emptyState(icon, title, text, actionHtml = '') {
  return `<div class="empty">
    <div class="empty-ico">${ic(icon)}</div>
    <div class="empty-title">${esc(title)}</div>
    ${text ? `<div class="empty-text">${esc(text)}</div>` : ''}
    ${actionHtml}
  </div>`;
}
function skeleton(kind) {
  const line = (w) => `<div class="skeleton sk-line" style="width:${w}"></div>`;
  const tiles = `<div class="grid cols-4">${'<div class="card"><div class="skeleton sk-tile"></div></div>'.repeat(4)}</div>`;
  if (kind === 'tiles') {
    return `<div class="skeleton sk-line" style="width:180px;height:22px;margin-bottom:18px"></div>${tiles}
      <div class="grid cols-2 mt-4">${'<div class="card"><div class="skeleton sk-block"></div></div>'.repeat(2)}</div>`;
  }
  if (kind === 'table') {
    return `<div class="skeleton sk-line" style="width:180px;height:22px;margin-bottom:18px"></div>
      <div class="card">${line('100%') + line('92%') + line('96%') + line('88%') + line('94%') + line('90%')}</div>`;
  }
  return `<div class="card">${line('60%') + line('90%') + line('80%')}</div>`;
}

// ---------- shared state ----------
const state = { accounts: [], categories: null, month: thisMonth() };

async function refreshAccounts() {
  state.accounts = (await api('GET', '/api/accounts')).accounts;
  renderSidebar();
}
async function refreshCategories() {
  state.categories = await api('GET', '/api/categories');
}

const ACCT_DOT = { checking: 'var(--s1)', savings: 'var(--s2)', cash: 'var(--s3)', credit: 'var(--s7)', investment: 'var(--s5)', loan: 'var(--s8)' };
function renderSidebar() {
  const list = document.getElementById('account-list');
  const open = state.accounts.filter(a => !a.closed);
  list.innerHTML = open.map(a => `
    <a class="acct-link" data-acct="${a.id}" href="#/accounts/${a.id}">
      <span class="acct-name"><span class="acct-dot" style="background:${ACCT_DOT[a.type] || 'var(--s1)'}"></span><span>${esc(a.name)}</span></span>
      <span class="amt ${signClass(a.balance_cents)}">${fmt(a.balance_cents)}</span>
    </a>`).join('') || '<div class="muted" style="padding:8px 10px;font-size:13px">No accounts yet</div>';
  highlightNav();
}

function highlightNav() {
  const hash = location.hash.slice(1) || '/';
  document.querySelectorAll('#nav a').forEach(a => {
    const on = a.dataset.route === hash;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.querySelectorAll('.acct-link').forEach(a => {
    const on = hash === `/accounts/${a.dataset.acct}`;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

// ---------- category select helper ----------
function categoryOptions(selectedId, { includeIncome = true, includeNone = true } = {}) {
  const c = state.categories;
  let html = includeNone ? `<option value="" ${!selectedId ? 'selected' : ''}>— Uncategorized —</option>` : '';
  if (includeIncome) {
    html += `<option value="${c.income_category_id}" ${selectedId === c.income_category_id ? 'selected' : ''}>💰 Income: Ready to Assign</option>`;
  }
  for (const g of c.groups) {
    html += `<optgroup label="${esc(g.name)}">` + g.categories.map(cat =>
      `<option value="${cat.id}" ${selectedId === cat.id ? 'selected' : ''}>${esc(cat.name)}</option>`
    ).join('') + '</optgroup>';
  }
  return html;
}

// ---------- SVG charts ----------
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

function donutChart(items) { // items: [{label, value}] cents
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) return emptyState('chart', 'No spending this month', 'Categorized spending will appear here as a breakdown.');
  const top = items.slice(0, 7);
  const other = items.slice(7).reduce((s, i) => s + i.value, 0);
  if (other > 0) top.push({ label: 'Other', value: other, gray: true });

  const R = 70, r = 44, cx = 90, cy = 90;
  let angle = -Math.PI / 2, paths = '';
  top.forEach((it, i) => {
    const frac = it.value / total;
    const a2 = angle + frac * Math.PI * 2 - 0.03; // 0.03rad ≈ 2px spacer gap
    const large = frac > 0.5 ? 1 : 0;
    const p = (a, rad) => `${cx + Math.cos(a) * rad},${cy + Math.sin(a) * rad}`;
    const color = it.gray ? 'var(--baseline)' : SERIES[i % SERIES.length];
    paths += `<path d="M${p(angle, R)} A${R},${R} 0 ${large} 1 ${p(a2, R)} L${p(a2, r)} A${r},${r} 0 ${large} 0 ${p(angle, r)} Z"
      fill="${color}"><title>${esc(it.label)}: ${fmt(it.value)} (${Math.round(frac * 100)}%)</title></path>`;
    angle = a2 + 0.03;
  });
  const legend = top.map((it, i) => `
    <span class="key"><span class="swatch" style="background:${it.gray ? 'var(--baseline)' : SERIES[i % SERIES.length]}"></span>
    ${esc(it.label)} <b class="amt">${fmt(it.value)}</b></span>`).join('');
  return `
    <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
      <svg width="180" height="180" viewBox="0 0 180 180" role="img" aria-label="Spending by category">
        ${paths}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" style="font-size:11px">Total</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" style="font-size:15px;font-weight:700;fill:var(--ink)">${fmt(total)}</text>
      </svg>
      <div class="legend" style="flex-direction:column;align-items:flex-start;gap:6px">${legend}</div>
    </div>`;
}

function cashflowChart(months) { // [{month, income_cents, spent_cents}]
  const W = 640, H = 220, padL = 46, padB = 24, padT = 12;
  const max = Math.max(1, ...months.flatMap(m => [m.income_cents, m.spent_cents]));
  const plotW = W - padL - 10, plotH = H - padT - padB;
  const groupW = plotW / months.length;
  const barW = Math.min(20, groupW / 2.6);
  const y = v => padT + plotH - (v / max) * plotH;

  const ticks = 4;
  let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i, yy = y(v);
    grid += `<g class="tick"><line x1="${padL}" x2="${W - 10}" y1="${yy}" y2="${yy}"/>
      <text x="${padL - 6}" y="${yy + 4}" text-anchor="end">${fmtShort(v)}</text></g>`;
  }
  let bars = '';
  months.forEach((m, i) => {
    const x0 = padL + i * groupW + groupW / 2;
    bars += `
      <rect x="${x0 - barW - 1}" y="${y(m.income_cents)}" width="${barW}" height="${Math.max(0, padT + plotH - y(m.income_cents))}"
        rx="3" fill="var(--s2)"><title>${monthShort(m.month)} income: ${fmt(m.income_cents)}</title></rect>
      <rect x="${x0 + 1}" y="${y(m.spent_cents)}" width="${barW}" height="${Math.max(0, padT + plotH - y(m.spent_cents))}"
        rx="3" fill="var(--s1)"><title>${monthShort(m.month)} spending: ${fmt(m.spent_cents)}</title></rect>
      <text x="${x0}" y="${H - 6}" text-anchor="middle">${monthShort(m.month)}</text>`;
  });
  return `
    <div class="chart-wrap"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Income vs spending by month">
      ${grid}<line class="axis" x1="${padL}" x2="${W - 10}" y1="${padT + plotH}" y2="${padT + plotH}"/>${bars}
    </svg></div>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--s2)"></span>Income</span>
      <span class="key"><span class="swatch" style="background:var(--s1)"></span>Spending</span>
    </div>`;
}

function netWorthChart(months, { width = 640, height = 200, mini = false } = {}) {
  if (!months.length) return '';
  const padL = mini ? 0 : 52, padB = mini ? 0 : 22, padT = 8, padR = mini ? 0 : 10;
  const vals = months.map(m => m.net_worth_cents);
  let lo = Math.min(...vals, 0), hi = Math.max(...vals, 1);
  if (hi === lo) hi = lo + 1;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const x = i => padL + (months.length === 1 ? plotW / 2 : (i / (months.length - 1)) * plotW);
  const y = v => padT + plotH - ((v - lo) / (hi - lo)) * plotH;
  const pts = months.map((m, i) => `${x(i)},${y(m.net_worth_cents)}`).join(' ');
  const area = `${padL},${y(Math.max(lo, 0))} ${pts} ${x(months.length - 1)},${y(Math.max(lo, 0))}`;

  let chrome = '';
  if (!mini) {
    for (let i = 0; i <= 3; i++) {
      const v = lo + ((hi - lo) / 3) * i, yy = y(v);
      chrome += `<g class="tick"><line x1="${padL}" x2="${width - padR}" y1="${yy}" y2="${yy}"/>
        <text x="${padL - 6}" y="${yy + 4}" text-anchor="end">${fmtShort(v)}</text></g>`;
    }
    months.forEach((m, i) => {
      if (months.length <= 6 || i % 2 === 0) {
        chrome += `<text x="${x(i)}" y="${height - 4}" text-anchor="middle">${monthShort(m.month)}</text>`;
      }
    });
  }
  const dots = months.map((m, i) =>
    `<circle cx="${x(i)}" cy="${y(m.net_worth_cents)}" r="${mini ? 0 : 4}" fill="var(--s1)" stroke="var(--surface)" stroke-width="2">
       <title>${monthLabel(m.month)}: ${fmt(m.net_worth_cents)}</title></circle>`).join('');
  return `
    <div class="chart-wrap"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Net worth over time">
      ${chrome}
      <polygon points="${area}" fill="var(--s1)" opacity="0.12"/>
      <polyline points="${pts}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/>
      ${dots}
    </svg></div>`;
}

function progressBar(spent, budgeted) {
  const over = budgeted > 0 && spent > budgeted;
  const pct = budgeted > 0 ? Math.min(100, (spent / budgeted) * 100) : (spent > 0 ? 100 : 0);
  return `<div class="bar"><i class="${over || budgeted === 0 ? 'over' : ''}" style="width:${pct}%"></i></div>`;
}

// ---------- pages ----------
const main = document.getElementById('main');

async function pageDashboard() {
  const d = await api('GET', `/api/dashboard?month=${state.month}`);
  const nwPrev = d.net_worth_series.length > 1 ? d.net_worth_series[d.net_worth_series.length - 2].net_worth_cents : d.net_worth_cents;
  const nwDelta = d.net_worth_cents - nwPrev;
  main.innerHTML = `
    <div class="page-head">
      <h1>Dashboard</h1>
      <p class="sub">Your money at a glance · ${monthLabel(d.month)}</p>
    </div>
    <div class="grid cols-4">
      <div class="card tile">
        <div class="tile-head"><span class="tile-ico">${ic('networth')}</span><span class="label">Net worth</span></div>
        <div class="value amt">${fmt(d.net_worth_cents)}</div>
        <div class="delta ${signClass(nwDelta)}">${nwDelta >= 0 ? '↑' : '↓'} ${fmt(Math.abs(nwDelta))} this month</div>
      </div>
      <div class="card tile">
        <div class="tile-head"><span class="tile-ico good">${ic('income')}</span><span class="label">Income</span></div>
        <div class="value amt pos">${fmt(d.income_cents)}</div>
        <div class="delta">received in ${monthShort(d.month)}</div>
      </div>
      <div class="card tile">
        <div class="tile-head"><span class="tile-ico bad">${ic('spending')}</span><span class="label">Spending</span></div>
        <div class="value amt">${fmt(d.spent_cents)}</div>
        <div class="delta">spent in ${monthShort(d.month)}</div>
      </div>
      <div class="card tile">
        <div class="tile-head"><span class="tile-ico">${ic('net')}</span><span class="label">Net</span></div>
        <div class="value amt ${signClass(d.net_cents)}">${fmt(d.net_cents)}</div>
        <div class="delta">${d.ready_to_assign !== 0
          ? `<a href="#/budget">${fmt(d.ready_to_assign)} ready to assign →</a>` : '✓ every dollar has a job'}</div>
      </div>
    </div>
    <div class="grid cols-2 mt-4">
      <div class="card">
        <h2>Net worth — last 12 months</h2>
        ${netWorthChart(d.net_worth_series, { width: 480, height: 180 })}
      </div>
      <div class="card">
        <h2>Top categories this month</h2>
        ${d.top_categories.length ? d.top_categories.map(c => `
          <div class="bar-row">
            <div class="top"><span class="who">${esc(c.category)}</span>
              <span class="num amt">${fmt(c.spent_cents)}${c.assigned_cents ? ` / ${fmt(c.assigned_cents)}` : ''}</span></div>
            ${progressBar(c.spent_cents, c.assigned_cents)}
          </div>`).join('') : emptyState('chart', 'No spending yet', 'Spending in your budget categories will show up here.')}
      </div>
      <div class="card pad-0">
        <div style="padding:16px 20px 4px"><h2 style="margin:0">Upcoming recurring</h2></div>
        ${d.upcoming_recurring.length ? `<div class="table-wrap"><table><tbody>${d.upcoming_recurring.map(s => `
          <tr><td>${esc(s.payee)} <span class="tag">${s.cadence}</span></td>
          <td class="muted nowrap">${s.next_date}</td>
          <td class="num amt">${fmt(s.amount_cents)}</td></tr>`).join('')}</tbody></table></div>`
          : emptyState('repeat', 'Nothing detected yet', 'Add more transaction history and Munney will spot your subscriptions.')}
      </div>
      <div class="card pad-0">
        <div style="padding:16px 20px 4px"><h2 style="margin:0">Recent transactions</h2></div>
        ${d.recent_transactions.length ? `<div class="table-wrap"><table><tbody>${d.recent_transactions.map(t => `
          <tr><td class="muted nowrap">${t.date.slice(5)}</td><td>${esc(t.payee || '(no payee)')}</td>
          <td class="muted">${esc(t.category_name || '')}</td>
          <td class="num amt ${signClass(t.amount_cents)}">${fmt(t.amount_cents)}</td></tr>`).join('')}</tbody></table></div>`
          : emptyState('receipt', 'No transactions yet', 'Add a transaction or import a CSV to get started.',
              `<a class="btn primary" href="#/transactions">Add transaction</a>`)}
      </div>
    </div>`;
}

async function pageBudget() {
  const b = await api('GET', `/api/budget/${state.month}`);
  const rtaClass = b.ready_to_assign === 0 ? 'zero' : b.ready_to_assign < 0 ? 'negative' : '';
  const rows = b.groups.map(g => `
    <tr class="group-row"><td colspan="2">${esc(g.name)}
      <button class="btn ghost small" data-add-cat="${g.id}">${ic('plus')} category</button></td>
      <td class="num">${fmt(g.categories.reduce((s, c) => s + c.assigned_cents, 0))}</td>
      <td class="num">${fmt(g.categories.reduce((s, c) => s + c.activity_cents, 0))}</td>
      <td class="num">${fmt(g.categories.reduce((s, c) => s + c.available_cents, 0))}</td></tr>
    ${g.categories.filter(c => !c.hidden).map(c => {
      const pillClass = c.available_cents > 0 ? 'ok' : c.available_cents < 0 ? 'over' : 'zero';
      const target = c.target_cents ? `
        <div class="bar tiny" title="Target ${fmt(c.target_cents)}/mo"><i class="${c.assigned_cents >= c.target_cents ? '' : 'over'}"
          style="width:${Math.min(100, c.target_cents ? (c.assigned_cents / c.target_cents) * 100 : 0)}%;${c.assigned_cents >= c.target_cents ? '' : 'background:var(--warn-fill)'}"></i></div>` : '';
      return `
      <tr data-cat-row="${c.id}">
        <td style="width:34%"><span class="cat-name">${esc(c.name)}</span>${target}</td>
        <td><button class="icon-btn mini ${c.target_cents ? 'accent' : ''}" data-target="${c.id}" data-target-val="${c.target_cents ?? ''}"
          aria-label="${c.target_cents ? `Monthly target ${fmt(c.target_cents)} — edit` : 'Set monthly target'}"
          title="${c.target_cents ? `Target ${fmt(c.target_cents)}/mo` : 'Set monthly target'}"
          style="${c.target_cents ? 'color:var(--accent)' : ''}">${ic('target')}</button></td>
        <td class="num"><input class="assign-input" data-assign="${c.id}" inputmode="decimal" aria-label="Assigned to ${esc(c.name)}" value="${(c.assigned_cents / 100).toFixed(2)}"></td>
        <td class="num amt muted">${fmt(c.activity_cents)}</td>
        <td class="num"><span class="pill ${pillClass}">${fmt(c.available_cents)}</span></td>
      </tr>`;
    }).join('')}`).join('');

  const rtaMsg = b.ready_to_assign > 0 ? 'You have money without a job. Assign it to categories below.'
    : b.ready_to_assign < 0 ? 'You assigned more than you have — reduce some categories to get back to zero.'
    : 'Every dollar has a job. Nicely done. 🎉';

  main.innerHTML = `
    <div class="page-head">
      <h1>Budget</h1>
      <p class="sub">Give every dollar a job — assign until Ready to Assign is zero.</p>
    </div>
    <div class="toolbar">
      <div class="stepper">
        <button id="prev-month" aria-label="Previous month">${ic('left')}</button>
        <span class="label">${monthLabel(state.month)}</span>
        <button id="next-month" aria-label="Next month">${ic('right')}</button>
      </div>
      <span class="spacer"></span>
      <button class="btn" id="add-group">${ic('plus')} New group</button>
    </div>
    <div class="rta-banner ${rtaClass}">
      <div class="rta-main">
        <div class="rta-label">Ready to Assign</div>
        <div class="big amt ${signClass(b.ready_to_assign)}">${fmt(b.ready_to_assign)}</div>
      </div>
      <div class="hint">${rtaMsg}</div>
    </div>
    <div class="card pad-0">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Category</th><th></th><th class="num">Assigned</th><th class="num">Activity</th><th class="num">Available</th></tr></thead>
          <tbody>${rows || ''}</tbody>
        </table>
      </div>
      ${b.groups.length ? '' : emptyState('wallet', 'No categories yet', 'Create a category group, then add categories to start giving your dollars a job.',
        `<button class="btn primary" id="empty-add-group">${ic('plus')} New group</button>`)}
    </div>`;
  const emptyAdd = main.querySelector('#empty-add-group');
  if (emptyAdd) emptyAdd.onclick = () => modalAddGroup();

  main.querySelector('#prev-month').onclick = () => { state.month = shiftMonth(state.month, -1); render(); };
  main.querySelector('#next-month').onclick = () => { state.month = shiftMonth(state.month, 1); render(); };
  main.querySelector('#add-group').onclick = () => modalAddGroup();
  main.querySelectorAll('[data-add-cat]').forEach(btn => btn.onclick = () => modalAddCategory(Number(btn.dataset.addCat)));
  main.querySelectorAll('[data-target]').forEach(btn => btn.onclick = () => modalSetTarget(Number(btn.dataset.target), btn.dataset.targetVal));
  main.querySelectorAll('[data-assign]').forEach(input => {
    input.addEventListener('change', async () => {
      const cents = parseMoney(input.value);
      if (cents === null) { toast('Enter a dollar amount', 'error'); return; }
      await api('PUT', `/api/budget/${state.month}/${input.dataset.assign}`, { assigned_cents: cents });
      render(); refreshAccounts();
    });
    input.addEventListener('focus', () => input.select());
  });
}

async function pageTransactions(accountId) {
  const account = accountId ? state.accounts.find(a => a.id === accountId) : null;
  const q = new URLSearchParams({ limit: 200 });
  if (accountId) q.set('account_id', accountId);
  const filters = state.txnFilters || {};
  if (filters.month) q.set('month', filters.month);
  if (filters.search) q.set('search', filters.search);
  if (filters.uncategorized) q.set('uncategorized', '1');
  const { transactions, total } = await api('GET', `/api/transactions?${q}`);

  const hasFilters = !!(filters.month || filters.search || filters.uncategorized);
  main.innerHTML = `
    <div class="page-head">
      <h1>${account ? esc(account.name) : 'Transactions'}</h1>
      <p class="sub">${account
        ? `<span class="tag">${esc(account.type)}</span> · balance <b class="amt ${signClass(account.balance_cents)}">${fmt(account.balance_cents)}</b>`
        : `${total} transaction${total === 1 ? '' : 's'}`}</p>
    </div>
    <div class="toolbar">
      <button class="btn primary" id="add-txn">${ic('plus')} Transaction</button>
      <button class="btn" id="import-csv">Import CSV</button>
      ${account ? `<button class="btn danger" id="close-acct">${account.closed ? 'Reopen' : 'Close'} account</button>` : ''}
      <span class="spacer"></span>
      <label class="check"><input type="checkbox" id="f-uncat" ${filters.uncategorized ? 'checked' : ''}> Needs category</label>
      <input type="month" id="f-month" aria-label="Filter by month" value="${filters.month || ''}">
      <input type="text" class="search" id="f-search" placeholder="Search payee or memo…" aria-label="Search transactions" value="${esc(filters.search || '')}">
    </div>
    <div class="card pad-0">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Payee</th><th>Category</th><th>Account</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>
          ${transactions.map(t => `
            <tr>
              <td class="muted nowrap">${t.date}</td>
              <td>${esc(t.payee || '(no payee)')}${t.memo ? ` <span class="muted">· ${esc(t.memo)}</span>` : ''}</td>
              <td>${t.transfer_pair_id ? '<span class="tag">transfer</span>'
                : `<select class="inline" data-txn-cat="${t.id}" aria-label="Category">${categoryOptions(t.category_id)}</select>`}</td>
              <td class="muted">${esc(t.account_name)}</td>
              <td class="num amt ${signClass(t.amount_cents)}">${fmt(t.amount_cents)}</td>
              <td class="num"><span class="row-actions">
                <button class="icon-btn mini" data-edit="${t.id}" aria-label="Edit transaction" title="Edit">${ic('edit')}</button>
                <button class="icon-btn mini danger" data-del="${t.id}" aria-label="Delete transaction" title="Delete">${ic('trash')}</button>
              </span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${transactions.length ? '' : (hasFilters
        ? emptyState('search', 'No matching transactions', 'Try clearing a filter or searching for something else.')
        : emptyState('receipt', 'No transactions yet', 'Add your first transaction or import a CSV to see it here.',
            `<button class="btn primary" id="empty-add-txn">${ic('plus')} Add transaction</button>`))}
    </div>`;
  const emptyAddTxn = main.querySelector('#empty-add-txn');
  if (emptyAddTxn) emptyAddTxn.onclick = () => modalTransaction(null, accountId);

  main.querySelector('#add-txn').onclick = () => modalTransaction(null, accountId);
  main.querySelector('#import-csv').onclick = () => modalImport(accountId);
  const closeBtn = main.querySelector('#close-acct');
  if (closeBtn) closeBtn.onclick = async () => {
    await api('PATCH', `/api/accounts/${accountId}`, { closed: account.closed ? 0 : 1 });
    await refreshAccounts(); location.hash = '#/transactions';
  };
  const setFilter = () => {
    state.txnFilters = {
      month: main.querySelector('#f-month').value || null,
      search: main.querySelector('#f-search').value.trim() || null,
      uncategorized: main.querySelector('#f-uncat').checked,
    };
    render();
  };
  main.querySelector('#f-month').onchange = setFilter;
  main.querySelector('#f-uncat').onchange = setFilter;
  let debounce;
  main.querySelector('#f-search').oninput = () => { clearTimeout(debounce); debounce = setTimeout(setFilter, 300); };

  main.querySelectorAll('[data-txn-cat]').forEach(sel => sel.onchange = async () => {
    await api('PATCH', `/api/transactions/${sel.dataset.txnCat}`, { category_id: sel.value ? Number(sel.value) : null });
    toast('Categorized — Munney will remember this payee', 'success');
    refreshAccounts();
  });
  main.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    await api('DELETE', `/api/transactions/${btn.dataset.del}`);
    render(); refreshAccounts();
  });
  main.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => {
    const t = transactions.find(x => x.id === Number(btn.dataset.edit));
    modalTransaction(t, accountId);
  });
}

async function pageRecurring() {
  const { series, total_monthly_cost_cents } = await api('GET', '/api/recurring');
  const active = series.filter(s => s.active), lapsed = series.filter(s => !s.active);
  const row = s => `
    <tr>
      <td class="cat-name">${esc(s.payee)}</td>
      <td><span class="tag accent">${s.cadence}</span></td>
      <td class="muted nowrap">${s.count}× seen</td>
      <td class="muted nowrap">${s.next_date}</td>
      <td class="num amt">${fmt(s.amount_cents)}</td>
      <td class="num amt muted">${fmt(s.monthly_cost_cents)}/mo</td>
    </tr>`;
  main.innerHTML = `
    <div class="page-head">
      <h1>Recurring</h1>
      <p class="sub">Subscriptions and bills detected from your transaction history.</p>
    </div>
    <div class="grid cols-4">
      <div class="card tile">
        <div class="tile-head"><span class="tile-ico">${ic('repeat')}</span><span class="label">Active recurring</span></div>
        <div class="value">${active.length}</div>
        <div class="delta">detected series</div>
      </div>
      <div class="card tile">
        <div class="tile-head"><span class="tile-ico warn">${ic('spending')}</span><span class="label">Est. monthly cost</span></div>
        <div class="value amt">${fmt(total_monthly_cost_cents)}</div>
        <div class="delta">across active subscriptions</div>
      </div>
    </div>
    <div class="card pad-0 mt-4">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Payee</th><th>Cadence</th><th></th><th>Next charge</th><th class="num">Amount</th><th class="num">Monthly</th></tr></thead>
          <tbody>${active.map(row).join('')}</tbody>
        </table>
      </div>
      ${active.length ? '' : emptyState('repeat', 'Nothing detected yet',
        'Recurring charges need at least 2 occurrences at a steady interval. Add or import more history.')}
    </div>
    ${lapsed.length ? `
      <h2 style="margin-top:24px">Possibly cancelled</h2>
      <div class="card pad-0"><div class="table-wrap"><table><tbody>${lapsed.map(row).join('')}</tbody></table></div></div>` : ''}`;
}

async function pageReports() {
  const month = state.month;
  const [spend, cash, nw] = await Promise.all([
    api('GET', `/api/reports/spending?month=${month}`),
    api('GET', '/api/reports/cashflow?months=12'),
    api('GET', '/api/reports/networth?months=12'),
  ]);
  main.innerHTML = `
    <div class="page-head">
      <h1>Reports</h1>
      <p class="sub">Where the money goes.</p>
    </div>
    <div class="toolbar">
      <div class="stepper">
        <button id="prev-month" aria-label="Previous month">${ic('left')}</button>
        <span class="label">${monthLabel(month)}</span>
        <button id="next-month" aria-label="Next month">${ic('right')}</button>
      </div>
    </div>
    <div class="card">
      <h2>Spending by category — ${monthLabel(month)}</h2>
      ${donutChart(spend.categories.map(c => ({ label: c.category, value: c.spent_cents })))}
    </div>
    <div class="card">
      <h2>Income vs spending — last 12 months</h2>
      ${cashflowChart(cash.months)}
    </div>
    <div class="card">
      <h2>Net worth — last 12 months</h2>
      ${netWorthChart(nw.months)}
    </div>`;
  main.querySelector('#prev-month').onclick = () => { state.month = shiftMonth(state.month, -1); render(); };
  main.querySelector('#next-month').onclick = () => { state.month = shiftMonth(state.month, 1); render(); };
}

// ---------- modals ----------
function modalAddAccount() {
  const m = openModal(`
    <h2>Add account</h2>
    <div class="form-row"><label>Name</label><input type="text" id="m-name" placeholder="e.g. Chase Checking"></div>
    <div class="inline-fields">
      <div class="form-row"><label>Type</label>
        <select id="m-type">
          <option value="checking">Checking</option><option value="savings">Savings</option>
          <option value="cash">Cash</option><option value="credit">Credit card</option>
          <option value="investment">Investment (off-budget)</option><option value="loan">Loan (off-budget)</option>
        </select></div>
      <div class="form-row"><label>Current balance</label><input type="text" id="m-balance" placeholder="0.00"></div>
    </div>
    <p class="hint-text">A positive balance in a spending account becomes money that's Ready to Assign. Enter credit card debt as a negative number.</p>
    <div class="form-actions">
      <button class="btn" id="m-cancel">Cancel</button>
      <button class="btn primary" id="m-save">Add account</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-name').focus();
  m.querySelector('#m-save').onclick = async () => {
    const name = m.querySelector('#m-name').value.trim();
    if (!name) return toast('Name is required', 'error');
    const balance = parseMoney(m.querySelector('#m-balance').value || '0');
    if (balance === null) return toast('Enter a valid balance', 'error');
    await api('POST', '/api/accounts', { name, type: m.querySelector('#m-type').value, balance_cents: balance });
    closeModal(); await refreshAccounts(); render();
    toast('Account added', 'success');
  };
}

function modalTransaction(txn, defaultAccountId) {
  const isEdit = !!txn;
  const accounts = state.accounts.filter(a => !a.closed);
  if (!accounts.length) return toast('Add an account first', 'error');
  const isOutflow = !isEdit || txn.amount_cents < 0;
  const m = openModal(`
    <h2>${isEdit ? 'Edit' : 'Add'} transaction</h2>
    <div class="inline-fields">
      <div class="form-row"><label>Account</label>
        <select id="m-acct" ${isEdit ? 'disabled' : ''}>${accounts.map(a =>
          `<option value="${a.id}" ${(isEdit ? txn.account_id : defaultAccountId) === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
      <div class="form-row"><label>Date</label><input type="date" id="m-date" value="${isEdit ? txn.date : today()}"></div>
    </div>
    <div class="form-row"><label>Payee</label><input type="text" id="m-payee" value="${isEdit ? esc(txn.payee) : ''}" placeholder="e.g. Kroger"></div>
    ${isEdit && txn.transfer_pair_id ? '' : `
    <div class="form-row"><label>Category</label>
      <select id="m-cat">${categoryOptions(isEdit ? txn.category_id : null)}
        ${!isEdit ? `<optgroup label="Transfer">${accounts.map(a => `<option value="transfer:${a.id}">↔ Transfer to ${esc(a.name)}</option>`).join('')}</optgroup>` : ''}
      </select></div>`}
    <div class="inline-fields">
      <div class="form-row"><label>Direction</label>
        <select id="m-dir"><option value="out" ${isOutflow ? 'selected' : ''}>Outflow (spending)</option>
        <option value="in" ${!isOutflow ? 'selected' : ''}>Inflow (money in)</option></select></div>
      <div class="form-row"><label>Amount</label><input type="text" id="m-amount" value="${isEdit ? Math.abs(txn.amount_cents / 100).toFixed(2) : ''}" placeholder="0.00"></div>
    </div>
    <div class="form-row"><label>Memo</label><input type="text" id="m-memo" value="${isEdit ? esc(txn.memo) : ''}"></div>
    <div class="form-actions">
      <button class="btn" id="m-cancel">Cancel</button>
      <button class="btn primary" id="m-save">${isEdit ? 'Save' : 'Add'}</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-payee').focus();
  const catSel = m.querySelector('#m-cat');
  if (catSel) catSel.onchange = () => {
    // Selecting income flips direction to inflow for convenience.
    if (Number(catSel.value) === state.categories.income_category_id) m.querySelector('#m-dir').value = 'in';
  };
  m.querySelector('#m-save').onclick = async () => {
    const amount = parseMoney(m.querySelector('#m-amount').value);
    if (amount === null || amount === 0) return toast('Enter an amount', 'error');
    const signed = m.querySelector('#m-dir').value === 'out' ? -Math.abs(amount) : Math.abs(amount);
    const base = {
      date: m.querySelector('#m-date').value,
      payee: m.querySelector('#m-payee').value.trim(),
      memo: m.querySelector('#m-memo').value.trim(),
      amount_cents: signed,
    };
    try {
      if (isEdit) {
        const patch = { ...base };
        if (catSel) patch.category_id = catSel.value ? Number(catSel.value) : null;
        await api('PATCH', `/api/transactions/${txn.id}`, patch);
      } else {
        const catVal = catSel.value;
        const body = { ...base, account_id: Number(m.querySelector('#m-acct').value) };
        if (catVal.startsWith('transfer:')) body.transfer_account_id = Number(catVal.slice(9));
        else if (catVal) body.category_id = Number(catVal);
        await api('POST', '/api/transactions', body);
      }
      closeModal(); render(); refreshAccounts();
    } catch (e) { toast(e.message, 'error'); }
  };
}

function modalImport(defaultAccountId) {
  const accounts = state.accounts.filter(a => !a.closed);
  if (!accounts.length) return toast('Add an account first', 'error');
  const m = openModal(`
    <h2>Import CSV</h2>
    <div class="form-row"><label>Into account</label>
      <select id="m-acct">${accounts.map(a =>
        `<option value="${a.id}" ${defaultAccountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
    <div class="form-row"><label>CSV file</label><input type="file" id="m-file" accept=".csv,text/csv"></div>
    <div class="form-row"><label>…or paste CSV</label>
      <textarea id="m-csv" rows="8" placeholder="Date,Description,Amount&#10;2026-06-01,Kroger,-45.67"></textarea></div>
    <p class="hint-text">Needs a header row with date, payee/description, and amount (or debit/credit) columns. Duplicates are skipped automatically; known payees are auto-categorized.</p>
    <div class="form-actions">
      <button class="btn" id="m-cancel">Cancel</button>
      <button class="btn primary" id="m-save">Import</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-file').onchange = async e => {
    const f = e.target.files[0];
    if (f) m.querySelector('#m-csv').value = await f.text();
  };
  m.querySelector('#m-save').onclick = async () => {
    const csv = m.querySelector('#m-csv').value.trim();
    if (!csv) return toast('Choose a file or paste CSV', 'error');
    try {
      const r = await api('POST', '/api/transactions/import', {
        account_id: Number(m.querySelector('#m-acct').value), csv,
      });
      closeModal(); render(); refreshAccounts();
      toast(`Imported ${r.imported} · skipped ${r.skipped_duplicates} duplicates · auto-categorized ${r.auto_categorized}`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  };
}

function modalAddGroup() {
  const m = openModal(`
    <h2>New category group</h2>
    <div class="form-row"><label>Name</label><input type="text" id="m-name" placeholder="e.g. Kids"></div>
    <div class="form-actions">
      <button class="btn" id="m-cancel">Cancel</button>
      <button class="btn primary" id="m-save">Add</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-name').focus();
  m.querySelector('#m-save').onclick = async () => {
    const name = m.querySelector('#m-name').value.trim();
    if (!name) return toast('Name is required', 'error');
    await api('POST', '/api/category-groups', { name });
    await refreshCategories(); closeModal(); render();
  };
}

function modalAddCategory(groupId) {
  const m = openModal(`
    <h2>New category</h2>
    <div class="form-row"><label>Name</label><input type="text" id="m-name" placeholder="e.g. Coffee"></div>
    <div class="form-row"><label>Monthly target (optional)</label><input type="text" id="m-target" placeholder="e.g. 50.00"></div>
    <div class="form-actions">
      <button class="btn" id="m-cancel">Cancel</button>
      <button class="btn primary" id="m-save">Add</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-name').focus();
  m.querySelector('#m-save').onclick = async () => {
    const name = m.querySelector('#m-name').value.trim();
    if (!name) return toast('Name is required', 'error');
    const targetStr = m.querySelector('#m-target').value.trim();
    const target = targetStr ? parseMoney(targetStr) : null;
    await api('POST', '/api/categories', { group_id: groupId, name, target_cents: target });
    await refreshCategories(); closeModal(); render();
  };
}

function modalSetTarget(categoryId, current) {
  const m = openModal(`
    <h2>Monthly target</h2>
    <p class="hint-text">How much do you want to assign to this category each month? (YNAB rule 2: embrace your true expenses.)</p>
    <div class="form-row"><label>Target</label><input type="text" id="m-target" value="${current ? (Number(current) / 100).toFixed(2) : ''}" placeholder="e.g. 100.00"></div>
    <div class="form-actions">
      <button class="btn danger" id="m-clear">Clear target</button>
      <span class="spacer"></span>
      <button class="btn" id="m-cancel">Cancel</button>
      <button class="btn primary" id="m-save">Save</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-target').focus();
  m.querySelector('#m-clear').onclick = async () => {
    await api('PATCH', `/api/categories/${categoryId}`, { target_cents: null });
    await refreshCategories(); closeModal(); render();
  };
  m.querySelector('#m-save').onclick = async () => {
    const cents = parseMoney(m.querySelector('#m-target').value);
    if (cents === null) return toast('Enter a dollar amount', 'error');
    await api('PATCH', `/api/categories/${categoryId}`, { target_cents: cents });
    await refreshCategories(); closeModal(); render();
  };
}

// ---------- router ----------
const SKELETON = { '/': 'tiles', '/budget': 'table', '/transactions': 'table', '/recurring': 'tiles', '/reports': 'card' };
async function render() {
  const hash = location.hash.slice(1) || '/';
  highlightNav();
  setNav(false); // close the mobile drawer on navigation
  const acctMatch = hash.match(/^\/accounts\/(\d+)$/);
  main.innerHTML = skeleton(acctMatch ? 'table' : (SKELETON[hash] || 'card'));
  try {
    if (!state.categories) await refreshCategories();
    if (hash === '/') await pageDashboard();
    else if (hash === '/budget') await pageBudget();
    else if (hash === '/transactions') await pageTransactions(null);
    else if (acctMatch) await pageTransactions(Number(acctMatch[1]));
    else if (hash === '/recurring') await pageRecurring();
    else if (hash === '/reports') await pageReports();
    else { location.hash = '#/'; return; }
    main.focus?.({ preventScroll: true });
  } catch (e) {
    main.innerHTML = `<div class="card error-card">
      <div class="error-head">${ic('alert')} Something went wrong</div>
      <p class="hint-text">${esc(e.message)}</p>
      <button class="btn" id="retry">Try again</button>
    </div>`;
    main.querySelector('#retry').onclick = () => render();
    console.error(e);
  }
}

window.addEventListener('hashchange', render);
document.getElementById('add-account').onclick = () => modalAddAccount();

(async function init() {
  initTheme();
  initNav();
  await refreshAccounts();
  await render();
})();
