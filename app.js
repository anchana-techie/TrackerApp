/* Life Tracker — GitHub Pages front end
 * Talks to an Apps Script web app (see apps-script/Code.gs) that reads/writes the Google Sheet.
 * No build step, no framework. Chart.js is loaded from cdnjs.
 */
'use strict';

/* =========================================================
 * Small utilities
 * ======================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else if (['value', 'checked', 'disabled', 'type', 'min', 'max', 'step', 'placeholder', 'hidden', 'open'].includes(k)) e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

const store = {
  get(k, fallback) { try { const v = localStorage.getItem('lt.' + k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem('lt.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem('lt.' + k); } catch { /* ignore */ } }
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// dates are 'YYYY-MM-DD' strings everywhere
const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
const diffDays = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 864e5);
const todayKey = () => keyOf(new Date());
const dow = k => parseKey(k).getDay();
const monthOf = k => k.slice(0, 7);
const fmt = (k, o = { day: 'numeric', month: 'short' }) => parseKey(k).toLocaleDateString('en-IN', o);
const fmtLong = k => fmt(k, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const rupee = n => n === null || n === undefined || isNaN(n) ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');
const pct = (x, d = 0) => x === null || x === undefined || isNaN(x) ? '—' : (x * 100).toFixed(d) + '%';
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const rangeDays = (a, b) => { const out = []; for (let k = a; k <= b; k = addDays(k, 1)) out.push(k); return out; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2600);
}

/* =========================================================
 * State
 * ======================================================= */
const S = {
  settings: { scriptUrl: store.get('scriptUrl', ''), passcode: store.get('passcode', '') },
  sheetUrl: '',
  demo: false,
  data: null,          // raw response of 'read'
  idx: null,           // derived indexes
  tab: 'log',
  logDate: todayKey(),
  pending: null,
  buyMonth: null,
  buyDraft: null,
  buyDirty: false,
  view: 'overview',
  range: 'all',
  charts: []
};
const freshPending = () => ({ grid: { products: {}, dos: {}, habits: {} }, period: undefined, weight: undefined, newProducts: [] });
S.pending = freshPending();

/* =========================================================
 * API
 * ======================================================= */
async function api(action, payload = {}) {
  if (S.demo) return demoApi(action, payload);
  if (!S.settings.scriptUrl) throw new Error('Add your Apps Script URL in Settings first.');
  const res = await fetch(S.settings.scriptUrl, {
    method: 'POST',
    // no content-type header => text/plain, so the browser skips the CORS preflight Apps Script can't answer
    body: JSON.stringify({ action, passcode: S.settings.passcode, sheetUrl: S.sheetUrl, ...payload })
  });
  let j;
  try { j = await res.json(); } catch { throw new Error('The script did not return JSON. Check the deployment URL and that access is "Anyone".'); }
  if (!j.ok) throw new Error(j.error || 'Request failed');
  return j.data;
}

// applies a write to the in-memory data — used by demo mode and for instant UI updates
function applyLocal(action, p) {
  const sh = S.data.sheets;
  const setMark = (sheet, name, date, on, allowAdd) => {
    if (!sheet) return;
    let it = sheet.items.find(i => norm(i.name) === norm(name));
    if (!it) { if (!on || !allowAdd) return; it = { name: name.trim(), marked: [] }; sheet.items.push(it); }
    const has = it.marked.includes(date);
    if (on && !has) { it.marked.push(date); it.marked.sort(); }
    if (!on && has) it.marked = it.marked.filter(d => d !== date);
  };
  if (action === 'saveDay') {
    for (const k of ['products', 'dos', 'habits']) {
      for (const [name, on] of Object.entries(p.grid[k] || {})) setMark(sh[k], name, p.date, on, k === 'products');
    }
    if (typeof p.period === 'boolean' && sh.period) {
      const m = new Set(sh.period.marked);
      p.period ? m.add(p.date) : m.delete(p.date);
      sh.period.marked = [...m].sort();
    }
    if (p.weight !== undefined && sh.weight) {
      if (p.weight === '') delete sh.weight.entries[p.date]; else sh.weight.entries[p.date] = Number(p.weight);
    }
  } else if (action === 'saveBuyList') {
    sh.buy.months[p.month] = p.items.map(i => ({ product: i.product, cost: i.cost === '' || i.cost === null ? null : Number(i.cost) }));
    sh.buy.slots = Math.max(sh.buy.slots, p.items.length);
    if (p.budget !== undefined) {
      if (p.budget === '' || p.budget === null) delete S.data.budgets[p.month]; else S.data.budgets[p.month] = Number(p.budget);
    }
  } else if (action === 'markBought') {
    setMark(sh.products, p.product, p.date, p.bought !== false, true);
  }
}

async function demoApi(action, payload) {
  await new Promise(r => setTimeout(r, 250));
  if (action === 'read') return S.data || makeDemoData();
  if (action === 'ping') return {};
  applyLocal(action, payload);
  return { ok: true };
}

/* =========================================================
 * Loading & indexing
 * ======================================================= */
async function loadSheet({ quiet = false } = {}) {
  if (!S.demo) {
    S.sheetUrl = $('#sheetUrl').value.trim();
    if (!S.sheetUrl) return;
    if (!S.settings.scriptUrl || !S.settings.passcode) {
      switchTab('settings');
      toast('Add the Apps Script URL and passcode first.', true);
      return;
    }
  }
  const btn = $('#loadBtn');
  btn.disabled = true; btn.textContent = 'Loading…';
  if (!quiet) document.body.classList.add('loading');
  try {
    const data = await api('read');
    S.data = data;
    buildIndex();
    if (!S.demo) rememberSheet(S.sheetUrl, data.title);
    $('#sheetTitle').textContent = (S.demo ? 'Demo · ' : '') + data.title;
    $$('[data-empty]').forEach(e => { e.hidden = true; });
    $$('[data-ready]').forEach(e => { e.hidden = false; });
    showBanner();
    if (!quiet) {
      S.pending = freshPending();
      S.logDate = clampDate(S.logDate);
      S.buyDraft = null; S.buyDirty = false;
      if (!S.buyMonth) S.buyMonth = defaultBuyMonth();
    }
    renderAll();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Load';
    document.body.classList.remove('loading');
  }
}

function buildIndex() {
  const sh = S.data.sheets;
  const grid = k => {
    const s = sh[k];
    if (!s) return null;
    const sets = {};
    s.items.forEach(i => { sets[i.name] = new Set(i.marked); });
    const loggedDays = new Set(s.items.flatMap(i => i.marked));
    return { dates: s.dates, dateSet: new Set(s.dates), items: s.items.map(i => i.name), sets, loggedDays };
  };
  const allDates = [...new Set([...(sh.dos?.dates || []), ...(sh.habits?.dates || []), ...(sh.products?.dates || []), ...(sh.period?.dates || []), ...(sh.weight?.dates || [])])].sort();
  S.idx = {
    products: grid('products'), dos: grid('dos'), habits: grid('habits'),
    period: sh.period ? { dateSet: new Set(sh.period.dates), marked: new Set(sh.period.marked) } : null,
    weight: sh.weight ? { dateSet: new Set(sh.weight.dates), entries: sh.weight.entries } : null,
    first: allDates[0], last: allDates[allDates.length - 1],
    year: (allDates[0] || todayKey()).slice(0, 4)
  };
}

function clampDate(k) {
  if (!S.idx) return k;
  if (k < S.idx.first) return S.idx.first;
  if (k > S.idx.last) return S.idx.last;
  return k;
}

function rememberSheet(url, title) {
  const list = store.get('recent', []).filter(r => r.url !== url);
  list.unshift({ url, title });
  store.set('recent', list.slice(0, 6));
  store.set('lastSheet', url);
  fillRecent();
}
function fillRecent() {
  const dl = $('#recentSheets');
  dl.replaceChildren(...store.get('recent', []).map(r => h('option', { value: r.url }, r.title)));
}

function showBanner() {
  const b = $('#banner');
  const missing = ['products', 'dos', 'habits', 'period', 'weight', 'buy'].filter(k => !S.data.sheets[k]);
  if (S.demo) {
    b.className = 'banner info'; b.hidden = false;
    b.textContent = 'Demo mode — made-up data, changes stay in this tab. Paste your sheet link above to use your real tracker.';
  } else if (missing.length) {
    b.className = 'banner'; b.hidden = false;
    b.textContent = 'Some sheets were not found in this file: ' + missing.join(', ') + '. Those sections are hidden.';
  } else b.hidden = true;
}

/* =========================================================
 * Tabs
 * ======================================================= */
function switchTab(tab) {
  S.tab = tab;
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.tab-panel').forEach(p => { p.hidden = p.id !== 'tab-' + tab; });
  if (S.data) renderTab();
}
function renderAll() { renderTab(); }
function renderTab() {
  if (S.tab === 'log') renderLog();
  else if (S.tab === 'buy') renderBuy();
  else if (S.tab === 'analysis') renderAnalysis();
}

/* =========================================================
 * LOG A DAY
 * ======================================================= */
function originalGrid(k, name, date) { return !!S.idx[k]?.sets[name]?.has(date); }
function currentGrid(k, name, date) {
  const p = S.pending.grid[k];
  return name in p ? p[name] : originalGrid(k, name, date);
}
function pendingCount() {
  const p = S.pending;
  return Object.values(p.grid).reduce((s, o) => s + Object.keys(o).length, 0) + (p.period !== undefined ? 1 : 0) + (p.weight !== undefined ? 1 : 0);
}

function streakEnding(set, date) {
  let n = 0, k = date;
  while (set.has(k)) { n++; k = addDays(k, -1); }
  return n;
}

function renderLog() {
  const date = S.logDate;
  $('#logDate').value = date;
  $('#logDate').min = S.idx.first; $('#logDate').max = S.idx.last;
  $('#dateLabel').textContent = fmtLong(date) + (date === todayKey() ? ' · today' : '');
  const grid = $('#logGrid');
  grid.replaceChildren();

  grid.append(checklistCard('dos', '✅ Daily Dos', date));
  grid.append(checklistCard('habits', '🌿 Habits', date));
  grid.append(bodyCard(date));
  grid.append(productsCard(date));
  updateSaveBar();
}

function checklistCard(k, title, date) {
  const ix = S.idx[k];
  if (!ix) return h('div');
  const inSheet = ix.dateSet.has(date);
  const done = ix.items.filter(n => currentGrid(k, n, date)).length;
  const list = h('ul', { class: 'checklist' }, ix.items.map(name => {
    const on = currentGrid(k, name, date);
    const changed = name in S.pending.grid[k];
    const streak = streakEnding(ix.sets[name], addDays(date, -1)) + (on ? 1 : 0);
    return h('li', null, h('label', { class: 'check' + (changed ? ' changed' : '') },
      h('input', { type: 'checkbox', checked: on, disabled: !inSheet, onchange: e => togglePending(k, name, e.target.checked) }),
      h('span', { class: 'box', 'aria-hidden': 'true' }, '✓'),
      h('span', { class: 'label' }, name),
      streak >= 2 ? h('span', { class: 'meta', title: 'Streak' }, '🔥 ' + streak) : null
    ));
  }));
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, title), h('span', { class: 'count-badge' }, `${done}/${ix.items.length}`)),
    inSheet ? null : h('p', { class: 'hint' }, 'This date is not a column in this sheet.'),
    list,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small ghost', disabled: !inSheet, onclick: () => { ix.items.forEach(n => togglePending(k, n, true, false)); renderLog(); } }, 'Tick all'),
      h('button', { class: 'btn small ghost', disabled: !inSheet, onclick: () => { ix.items.forEach(n => togglePending(k, n, false, false)); renderLog(); } }, 'Clear'))
  );
}

function togglePending(k, name, on, rerender = true) {
  const p = S.pending.grid[k];
  if (on === originalGrid(k, name, S.logDate)) delete p[name]; else p[name] = on;
  if (rerender) renderLog();
}

function bodyCard(date) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '🌸 Period & weight')));
  const ip = S.idx.period;
  if (ip) {
    const orig = ip.marked.has(date);
    const on = S.pending.period !== undefined ? S.pending.period : orig;
    const inCal = ip.dateSet.has(date);
    const btn = h('button', {
      class: 'toggle-big', 'aria-pressed': String(on), disabled: !inCal,
      onclick: () => {
        const next = !on;
        S.pending.period = next === orig ? undefined : next;
        renderLog();
      }
    }, h('span', { style: 'font-size:1.5rem' }, on ? '🩸' : '○'),
      h('span', null, h('b', null, on ? 'Period day' : 'Not a period day'), h('br'), h('span', { class: 'muted' }, 'Tap to change')));
    card.append(btn);
    const P = analyzePeriod();
    if (P.periods.length) {
      const cd = cycleDayOn(P, date);
      card.append(h('p', { class: 'hint' },
        cd ? `Cycle day ${cd.day} · ${cd.phase}` : '',
        P.next ? (P.late && date >= P.next ? ` · expected ${fmt(P.next)} (${plural(P.late, 'day')} late)` : ` · next period expected ${fmt(P.next)}`) : ''));
    }
  }
  const iw = S.idx.weight;
  if (iw) {
    const orig = iw.entries[date];
    const val = S.pending.weight !== undefined ? S.pending.weight : (orig ?? '');
    const inp = h('input', {
      type: 'number', step: '0.1', min: '20', max: '300', value: val, placeholder: 'kg', disabled: !iw.dateSet.has(date),
      'aria-label': 'Weight in kg',
      oninput: e => {
        const v = e.target.value;
        const o = orig === undefined ? '' : String(orig);
        S.pending.weight = v === o ? undefined : v;
        updateSaveBar();
      }
    });
    const prev = Object.keys(iw.entries).filter(k => k < date).sort().pop();
    card.append(h('div', { class: 'weight-row' }, h('label', null, 'Weight '), inp, h('span', { class: 'muted' }, 'kg')));
    if (prev) card.append(h('p', { class: 'hint' }, `Last weigh-in: ${iw.entries[prev]} kg on ${fmt(prev)}`));
  }
  return card;
}

function productsCard(date) {
  const ix = S.idx.products;
  if (!ix) return h('div');
  const inSheet = ix.dateSet.has(date);
  const monthName = MONTHS[parseKey(date).getMonth()];
  const planned = new Set((S.data.sheets.buy?.months[monthName] || []).map(i => norm(i.product)));
  const names = [...ix.items, ...S.pending.newProducts.filter(n => !ix.items.some(i => norm(i) === norm(n)))];
  const lastBought = name => [...(ix.sets[name] || [])].filter(d => d < date).sort().pop();
  const bought = names.filter(n => currentGrid('products', n, date)).length;

  const list = h('ul', { class: 'checklist scroll-list' });
  const draw = q => {
    list.replaceChildren(...names
      .filter(n => !q || norm(n).includes(norm(q)))
      .sort((a, b) => (planned.has(norm(b)) - planned.has(norm(a))) || a.localeCompare(b))
      .map(name => {
        const on = currentGrid('products', name, date);
        const lb = lastBought(name);
        return h('li', null, h('label', { class: 'check' + (name in S.pending.grid.products ? ' changed' : '') },
          h('input', { type: 'checkbox', checked: on, disabled: !inSheet, onchange: e => togglePending('products', name, e.target.checked) }),
          h('span', { class: 'box', 'aria-hidden': 'true' }, '✓'),
          h('span', { class: 'label' }, name),
          h('span', { class: 'meta' }, planned.has(norm(name)) ? h('span', { class: 'tag' }, 'on list') : null, lb ? ' last ' + fmt(lb) : '')
        ));
      }));
  };
  draw('');
  const newInp = h('input', { placeholder: 'New product name', disabled: !inSheet });
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '🛍️ Bought today'), h('span', { class: 'count-badge' }, plural(bought, 'item'))),
    h('input', { class: 'search', placeholder: 'Search products…', oninput: e => draw(e.target.value) }),
    list,
    h('form', {
      class: 'add-inline', onsubmit: e => {
        e.preventDefault();
        const n = newInp.value.trim();
        if (!n) return;
        if (!names.some(x => norm(x) === norm(n))) S.pending.newProducts.push(n);
        const existing = names.find(x => norm(x) === norm(n)) || n;
        togglePending('products', existing, true);
      }
    }, newInp, h('button', { class: 'btn ghost', disabled: !inSheet }, 'Add & tick')),
    h('p', { class: 'hint' }, 'New products are added as a new row in your Products sheet.')
  );
}

function updateSaveBar() {
  const n = pendingCount();
  $('#saveBar').hidden = n === 0;
  $('#pendingText').textContent = plural(n, 'unsaved change');
}

async function saveDay() {
  const p = S.pending;
  const payload = { date: S.logDate, grid: p.grid };
  if (p.period !== undefined) payload.period = p.period;
  if (p.weight !== undefined) payload.weight = p.weight === '' ? '' : Number(p.weight);
  const btn = $('#saveDayBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api('saveDay', payload);
    if (!S.demo) applyLocal('saveDay', payload);
    S.pending = freshPending();
    buildIndex();
    renderLog();
    toast('Saved to your sheet ✓');
    if (!S.demo) loadSheet({ quiet: true });
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Save to sheet';
  }
}

function moveDay(n) {
  if (pendingCount() && !confirm('Discard unsaved changes for this day?')) return;
  S.pending = freshPending();
  S.logDate = clampDate(addDays(S.logDate, n));
  renderLog();
}

/* =========================================================
 * BUY LIST
 * ======================================================= */
function defaultBuyMonth() {
  const t = todayKey();
  if (t.slice(0, 4) === S.idx.year) return MONTHS[parseKey(t).getMonth()];
  const months = S.data.sheets.buy?.months || {};
  return MONTHS.find(m => (months[m] || []).length) || MONTHS[parseKey(S.idx.first).getMonth()];
}

function monthKey(monthName) { return `${S.idx.year}-${pad(MONTHS.indexOf(monthName) + 1)}`; }

function boughtInMonth(product, monthName) {
  const ix = S.idx.products;
  if (!ix) return null;
  const name = ix.items.find(i => norm(i) === norm(product));
  if (!name) return null;
  const ym = monthKey(monthName);
  return [...ix.sets[name]].filter(d => monthOf(d) === ym).sort()[0] || null;
}

function ensureDraft() {
  if (S.buyDraft && S.buyDraft.month === S.buyMonth) return;
  const items = (S.data.sheets.buy?.months[S.buyMonth] || []).map(i => ({ product: i.product, cost: i.cost ?? '' }));
  S.buyDraft = { month: S.buyMonth, items, budget: S.data.budgets?.[S.buyMonth] ?? '' };
  S.buyDirty = false;
}

function renderBuy() {
  if (!S.data.sheets.buy) { $('#tab-buy [data-ready]').replaceChildren(h('p', { class: 'empty' }, 'No "Month List To buy" sheet in this file.')); return; }
  ensureDraft();
  const months = S.data.sheets.buy.months;
  $('#monthChips').replaceChildren(...MONTHS.map(m => h('button', {
    class: 'chip', 'aria-pressed': String(m === S.buyMonth),
    onclick: () => {
      if (S.buyDirty && !confirm('Discard unsaved changes to ' + S.buyMonth + '?')) return;
      S.buyMonth = m; S.buyDraft = null; renderBuy();
    }
  }, m.slice(0, 3), (months[m] || []).length ? h('span', { class: 'dot', 'aria-label': 'has items' }) : null)));

  $('#buyMonthTitle').textContent = `${S.buyMonth} ${S.idx.year}`;
  const bi = $('#budgetInput');
  bi.value = S.buyDraft.budget;
  bi.oninput = () => { S.buyDraft.budget = bi.value; markBuyDirty(); renderBuySummary(); };

  $('#productNames').replaceChildren(...(S.idx.products?.items || []).map(n => h('option', { value: n })));
  const tbody = $('#buyRows');
  tbody.replaceChildren(...S.buyDraft.items.map((it, i) => buyRow(it, i)));
  if (!S.buyDraft.items.length) tbody.append(h('tr', null, h('td', { colspan: '5', class: 'muted', style: 'padding:18px 6px' }, 'Nothing planned yet. Add products below.')));
  $('#buyDirty').hidden = !S.buyDirty;
  renderBuySummary();
}

function buyRow(it, i) {
  const statusCell = h('td', { class: 'status' });
  const drawStatus = () => {
    statusCell.replaceChildren();
    if (!it.product.trim()) return;
    const b = boughtInMonth(it.product, S.buyMonth);
    const known = S.idx.products?.items.some(n => norm(n) === norm(it.product));
    if (b) {
      statusCell.className = 'status bought';
      statusCell.append('✓ Bought ' + fmt(b), ' ', h('button', { class: 'btn small ghost', title: 'Undo', onclick: () => doMarkBought(it.product, b, false) }, 'Undo'));
      return;
    }
    statusCell.className = 'status pending';
    const t = todayKey();
    const ym = monthKey(S.buyMonth);
    const def = monthOf(t) === ym ? t : clampDate(`${ym}-01`);
    const di = h('input', { type: 'date', value: def, min: S.idx.first, max: S.idx.last, 'aria-label': 'Bought on' });
    statusCell.append(h('div', { class: 'buy-bought-form' }, di,
      h('button', { class: 'btn small', onclick: () => doMarkBought(it.product, di.value, true) }, 'Mark bought')));
    if (!known) statusCell.append(h('div', { class: 'new-tag', style: 'font-size:.75rem' }, 'new — will be added to Products'));
  };
  drawStatus();
  return h('tr', null,
    h('td', null, i + 1),
    h('td', null, h('input', { class: 'p', list: 'productNames', value: it.product, placeholder: 'Product', oninput: e => { it.product = e.target.value; markBuyDirty(); drawStatus(); renderBuySummary(); } })),
    h('td', { class: 'num' }, h('input', { class: 'c', type: 'number', min: '0', step: '1', value: it.cost, placeholder: '₹', oninput: e => { it.cost = e.target.value; markBuyDirty(); renderBuySummary(); } })),
    statusCell,
    h('td', null, h('button', { class: 'remove', 'aria-label': 'Remove', onclick: () => { S.buyDraft.items.splice(i, 1); markBuyDirty(); renderBuy(); } }, '×'))
  );
}

function markBuyDirty() { S.buyDirty = true; $('#buyDirty').hidden = false; }

async function doMarkBought(product, date, bought) {
  if (!date) return toast('Pick the date you bought it.', true);
  try {
    await api('markBought', { product, date, bought });
    if (!S.demo) applyLocal('markBought', { product, date, bought });
    buildIndex();
    renderBuy();
    toast(bought ? `${product} marked bought on ${fmt(date)} ✓` : 'Undone');
  } catch (err) { toast(err.message, true); }
}

async function saveBuy() {
  const d = S.buyDraft;
  const items = d.items.filter(i => i.product.trim()).map(i => ({ product: i.product.trim(), cost: i.cost === '' ? '' : Number(i.cost) }));
  const payload = { month: d.month, items, budget: d.budget === '' ? '' : Number(d.budget) };
  const btn = $('#saveBuyBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api('saveBuyList', payload);
    if (!S.demo) applyLocal('saveBuyList', payload);
    S.buyDraft = null;
    buildIndex();
    renderBuy();
    toast(`${d.month} list saved ✓`);
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Save list'; }
}

function renderBuySummary() {
  const d = S.buyDraft;
  const items = d.items.filter(i => i.product.trim());
  const total = items.reduce((s, i) => s + (Number(i.cost) || 0), 0);
  const boughtItems = items.filter(i => boughtInMonth(i.product, d.month));
  const boughtVal = boughtItems.reduce((s, i) => s + (Number(i.cost) || 0), 0);
  const budget = d.budget === '' ? null : Number(d.budget);
  const used = budget ? total / budget : 0;
  const over = budget !== null && total > budget;

  // carry-over: planned in earlier months, never bought since that month
  const mi = MONTHS.indexOf(d.month);
  const carry = [];
  const months = S.data.sheets.buy.months;
  for (let m = 0; m < mi; m++) {
    for (const it of months[MONTHS[m]] || []) {
      const ix = S.idx.products;
      const name = ix?.items.find(n => norm(n) === norm(it.product));
      const since = `${S.idx.year}-${pad(m + 1)}-01`;
      const everBought = name && [...ix.sets[name]].some(x => x >= since);
      if (!everBought && !items.some(i => norm(i.product) === norm(it.product)) && !carry.some(c => norm(c.product) === norm(it.product))) {
        carry.push({ ...it, from: MONTHS[m] });
      }
    }
  }

  const box = $('#buySummary');
  box.replaceChildren(...[
    h('h2', null, 'Summary'),
    budget !== null ? h('div', null,
      h('div', { class: 'meter' + (over ? ' over' : '') }, h('span', { style: `width:${Math.min(100, used * 100).toFixed(1)}%` })),
      h('p', { class: 'sub' }, over ? `Over budget by ${rupee(total - budget)}` : `${pct(used)} of budget planned · ${rupee(budget - total)} left`)
    ) : h('p', { class: 'sub' }, 'Set a budget to track it.'),
    h('div', { class: 'kv' }, h('span', null, 'Planned items'), h('b', null, items.length)),
    h('div', { class: 'kv' }, h('span', null, 'Planned total'), h('b', null, rupee(total))),
    h('div', { class: 'kv' }, h('span', null, 'Budget'), h('b', null, rupee(budget))),
    h('div', { class: 'kv' }, h('span', null, `Bought (${boughtItems.length}/${items.length})`), h('b', null, rupee(boughtVal))),
    h('div', { class: 'kv' }, h('span', null, 'Still to buy'), h('b', null, rupee(total - boughtVal))),
    carry.length ? h('div', { style: 'margin-top:16px' },
      h('h3', null, 'Not bought from earlier months'),
      h('ul', { class: 'insights', style: 'margin-top:8px' }, carry.slice(0, 8).map(c => h('li', null,
        h('span', { style: 'flex:1' }, c.product, h('span', { class: 'muted' }, ` · ${c.from.slice(0, 3)}${c.cost ? ' · ' + rupee(c.cost) : ''}`)),
        h('button', { class: 'btn small ghost', onclick: () => { S.buyDraft.items.push({ product: c.product, cost: c.cost ?? '' }); markBuyDirty(); renderBuy(); } }, '+ Add')
      )))) : null
  ].filter(Boolean));
}

/* =========================================================
 * ANALYSIS ENGINE
 * ======================================================= */
function analysisWindow() {
  const t = todayKey();
  const last = S.idx.last < t ? S.idx.last : t;
  const first = S.idx.first;
  const r = S.range;
  if (r === 'last7') return [addDays(last, -6) < first ? first : addDays(last, -6), last];
  if (r === 'last30') return [addDays(last, -29) < first ? first : addDays(last, -29), last];
  if (/^\d{4}-\d{2}$/.test(r)) {
    const s = r + '-01';
    const e = keyOf(new Date(Number(r.slice(0, 4)), Number(r.slice(5)), 0));
    return [s < first ? first : s, e > last ? last : e];
  }
  return [first, last];
}

function previousWindow([s, e]) {
  const len = diffDays(s, e) + 1;
  return [addDays(s, -len), addDays(s, -1)];
}

function analyzeGrid(k, [start, end]) {
  const ix = S.idx[k];
  if (!ix) return null;
  const days = ix.dates.filter(d => d >= start && d <= end);
  const logged = days.filter(d => ix.loggedDays.has(d));
  const nItems = ix.items.length;
  const score = logged.map(d => ix.items.filter(n => ix.sets[n].has(d)).length / nItems);

  const items = ix.items.map(name => {
    const set = ix.sets[name];
    const done = logged.filter(d => set.has(d));
    // streaks inside window, consecutive calendar days
    let longest = 0, run = 0;
    for (const d of days) { if (set.has(d)) { run++; longest = Math.max(longest, run); } else run = 0; }
    const t = todayKey();
    const anchor = set.has(end) ? end : (end === t ? addDays(end, -1) : end);
    const current = streakEnding(set, anchor);
    const byDow = Array.from({ length: 7 }, (_, w) => {
      const ld = logged.filter(d => dow(d) === w);
      return ld.length ? ld.filter(d => set.has(d)).length / ld.length : null;
    });
    const half = Math.floor(logged.length / 2);
    const a = logged.slice(0, half), b = logged.slice(half);
    const trend = (a.length >= 3 && b.length >= 3) ? (b.filter(d => set.has(d)).length / b.length) - (a.filter(d => set.has(d)).length / a.length) : null;
    const lastDone = [...set].filter(d => d <= end).sort().pop() || null;
    return { name, done: done.length, rate: logged.length ? done.length / logged.length : null, longest, current, byDow, trend, lastDone };
  });

  // keystone: other items' completion on days this item is done vs not
  for (const it of items) {
    const set = ix.sets[it.name];
    const others = ix.items.filter(n => n !== it.name);
    const on = [], off = [];
    for (const d of logged) {
      const sc = others.filter(n => ix.sets[n].has(d)).length / Math.max(1, others.length);
      (set.has(d) ? on : off).push(sc);
    }
    it.lift = (on.length >= 3 && off.length >= 3) ? mean(on) - mean(off) : null;
  }

  const dowAvg = Array.from({ length: 7 }, (_, w) => {
    const idx = logged.map((d, i) => dow(d) === w ? score[i] : null).filter(x => x !== null);
    return idx.length ? mean(idx) : null;
  });
  return { k, days, logged, unlogged: days.length - logged.length, score, items, dowAvg, avg: mean(score) };
}

function rolling(arr, n) {
  return arr.map((_, i) => { const s = arr.slice(Math.max(0, i - n + 1), i + 1).filter(x => x !== null); return s.length ? mean(s) : null; });
}

/* ---------- period ---------- */
function analyzePeriod() {
  if (!S.idx.period) return { periods: [], spotting: [], cycles: [] };
  const marks = [...S.idx.period.marked].sort();
  const runs = [];
  for (const d of marks) {
    const r = runs[runs.length - 1];
    if (r && diffDays(r.end, d) <= 2) r.end = d, r.days.push(d);
    else runs.push({ start: d, end: d, days: [d] });
  }
  const periods = [], spotting = [];
  for (const r of runs) {
    const prev = periods[periods.length - 1];
    if (prev && diffDays(prev.start, r.start) < 15) spotting.push(r);
    else periods.push(r);
  }
  periods.forEach(p => { p.length = diffDays(p.start, p.end) + 1; });
  const cycles = periods.slice(1).map((p, i) => ({ from: periods[i].start, to: p.start, length: diffDays(periods[i].start, p.start) }));
  const cl = cycles.map(c => c.length);
  const avgCycle = cl.length ? mean(cl) : null;
  const usedCycle = Math.round(avgCycle || 28);
  const variation = cl.length >= 2 ? Math.max(...cl) - Math.min(...cl) : null;
  const spread = cl.length >= 2 ? Math.max(2, Math.round(sd(cl))) : 3;
  const avgLen = periods.length ? mean(periods.map(p => p.length)) : null;
  const last = periods[periods.length - 1];
  const t = todayKey();
  let next = null, nextList = [], ovulation = null, fertile = null, late = null;
  if (last) {
    next = addDays(last.start, usedCycle);
    // if the expected date has passed with no new period, keep the date but flag it late
    if (t > addDays(next, 2)) late = diffDays(next, t);
    for (let i = 0; i < 3; i++) nextList.push(addDays(last.start, usedCycle * (i + 1)));
    ovulation = addDays(next, -14);
    fertile = [addDays(ovulation, -5), addDays(ovulation, 1)];
  }
  const flags = [];
  if (cl.some(c => c < 21)) flags.push('A cycle shorter than 21 days was recorded.');
  if (cl.some(c => c > 35)) flags.push('A cycle longer than 35 days was recorded.');
  if (periods.some(p => p.length > 7)) flags.push('A period lasted more than 7 days.');
  if (variation !== null && variation > 7) flags.push(`Cycle length varies by ${variation} days — that counts as irregular.`);
  if (spotting.length) flags.push(`${plural(spotting.length, 'short bleed')} between periods logged (treated as spotting, not a new cycle).`);
  return { periods, spotting, cycles, avgCycle, usedCycle, variation, spread, avgLen, next, nextList, ovulation, fertile, late, flags, estimated: !avgCycle };
}

function cycleDayOn(P, date) {
  const start = [...P.periods].reverse().find(p => p.start <= date);
  if (!start) return null;
  const day = diffDays(start.start, date) + 1;
  const len = P.usedCycle;
  let phase;
  if (date <= start.end) phase = 'Menstrual';
  else if (day <= len - 16) phase = 'Follicular';
  else if (day <= len - 12) phase = 'Ovulation window';
  else phase = 'Luteal';
  if (day > len + 7) phase = 'Beyond expected cycle';
  return { day, phase };
}

/* ---------- weight ---------- */
function analyzeWeight([start, end]) {
  const iw = S.idx.weight;
  if (!iw) return null;
  const all = Object.entries(iw.entries).sort(([a], [b]) => a < b ? -1 : 1);
  const pts = all.filter(([d]) => d >= start && d <= end);
  if (!pts.length) return { n: 0, all };
  const ws = pts.map(p => p[1]);
  const first = pts[0], latest = pts[pts.length - 1];
  const minP = pts.reduce((a, b) => b[1] < a[1] ? b : a), maxP = pts.reduce((a, b) => b[1] > a[1] ? b : a);
  // least-squares slope (kg/day)
  let slope = null;
  if (pts.length >= 3) {
    const xs = pts.map(p => diffDays(first[0], p[0]));
    const mx = mean(xs), my = mean(ws);
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ws[i] - my), 0);
    const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    slope = den ? num / den : null;
  }
  const ma7 = pts.map(([d]) => mean(pts.filter(([x]) => x <= d && diffDays(x, d) < 7).map(p => p[1])));
  const span = diffDays(first[0], latest[0]) + 1;

  // next-day change after doing each item
  const deltas = [];
  for (let i = 0; i < all.length - 1; i++) {
    if (diffDays(all[i][0], all[i + 1][0]) === 1 && all[i][0] >= start && all[i][0] <= end) deltas.push({ d: all[i][0], delta: all[i + 1][1] - all[i][1] });
  }
  const effects = [];
  for (const k of ['dos', 'habits']) {
    const ix = S.idx[k];
    if (!ix) continue;
    for (const name of ix.items) {
      const on = deltas.filter(x => ix.loggedDays.has(x.d) && ix.sets[name].has(x.d)).map(x => x.delta);
      const off = deltas.filter(x => ix.loggedDays.has(x.d) && !ix.sets[name].has(x.d)).map(x => x.delta);
      if (on.length >= 3 && off.length >= 3) effects.push({ name, sheet: k, on: mean(on), off: mean(off), diff: mean(on) - mean(off), n: on.length + off.length });
    }
  }
  effects.sort((a, b) => a.diff - b.diff);
  return { n: pts.length, pts, all, first, latest, minP, maxP, avg: mean(ws), slope, ma7, span, deltas, effects };
}

/* ---------- spending ---------- */
function analyzeSpending() {
  const buy = S.data.sheets.buy;
  const ix = S.idx.products;
  const months = MONTHS.map(m => {
    const items = buy?.months[m] || [];
    const planned = items.reduce((s, i) => s + (i.cost || 0), 0);
    const bought = items.filter(i => boughtInMonth(i.product, m));
    const boughtVal = bought.reduce((s, i) => s + (i.cost || 0), 0);
    const ym = monthKey(m);
    const plannedNames = new Set(items.map(i => norm(i.product)));
    const unplanned = ix ? ix.items.filter(n => [...ix.sets[n]].some(d => monthOf(d) === ym) && !plannedNames.has(norm(n))) : [];
    return { m, items, planned, boughtCount: bought.length, boughtVal, budget: S.data.budgets?.[m] ?? null, unplanned };
  });
  const t = todayKey();
  const restock = ix ? ix.items.map(name => {
    const ds = [...ix.sets[name]].sort();
    const gaps = ds.slice(1).map((d, i) => diffDays(ds[i], d));
    const interval = gaps.length ? mean(gaps) : null;
    const lastD = ds[ds.length - 1] || null;
    const nextD = lastD && interval ? addDays(lastD, Math.round(interval)) : null;
    let status = 'never';
    if (ds.length === 1) status = 'once';
    if (nextD) {
      const dd = diffDays(t, nextD);
      status = dd < 0 ? 'overdue' : dd <= 7 ? 'soon' : 'ok';
    }
    return { name, count: ds.length, interval, last: lastD, next: nextD, status };
  }) : [];
  const repeatPlanned = {};
  months.forEach(mo => mo.items.forEach(i => { const n = norm(i.product); (repeatPlanned[n] ||= { name: i.product, months: [] }).months.push(mo.m.slice(0, 3)); }));
  const allPlanned = months.flatMap(mo => mo.items.map(i => ({ ...i, m: mo.m })));
  return {
    months, restock,
    repeat: Object.values(repeatPlanned).filter(r => r.months.length >= 2),
    priciest: allPlanned.filter(i => i.cost).sort((a, b) => b.cost - a.cost).slice(0, 6),
    yearPlanned: months.reduce((s, m) => s + m.planned, 0),
    yearBudget: months.reduce((s, m) => s + (m.budget || 0), 0),
    yearBought: months.reduce((s, m) => s + m.boughtVal, 0)
  };
}

/* =========================================================
 * ANALYSIS RENDERING
 * ======================================================= */
const VIEWS = [
  ['overview', 'Overview'], ['dos', 'Daily Dos'], ['habits', 'Habits'],
  ['period', 'Period cycle'], ['weight', 'Weight'], ['spending', 'Spending & restock']
];

function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function destroyCharts() { S.charts.forEach(c => c.destroy()); S.charts = []; }

function chart(canvas, config) {
  if (!window.Chart) { canvas.replaceWith(h('p', { class: 'muted' }, 'Charts are loading…')); return; }
  const ink2 = css('--ink-2'), line = css('--line');
  Chart.defaults.font.family = css('--font') || 'sans-serif';
  Chart.defaults.color = ink2;
  config.options = Object.assign({
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true } } }
  }, config.options || {});
  const sc = config.options.scales || {};
  for (const ax of Object.values(sc)) {
    ax.grid = Object.assign({ color: line, drawTicks: false }, ax.grid || {});
    ax.border = { display: false };
    ax.ticks = Object.assign({ padding: 6 }, ax.ticks || {});
  }
  S.charts.push(new Chart(canvas, config));
}

function renderAnalysis() {
  destroyCharts();
  // range options
  const sel = $('#rangeSelect');
  const ms = [...new Set(rangeDays(S.idx.first, S.idx.last).map(monthOf))];
  const opts = [['all', 'All tracked'], ['last30', 'Last 30 days'], ['last7', 'Last 7 days'], ...ms.map(m => [m, monthLabel(m)])];
  sel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = S.range;
  sel.onchange = () => { S.range = sel.value; renderAnalysis(); };
  $('#analysisPills').replaceChildren(...VIEWS.map(([v, l]) => h('button', { class: 'chip', 'aria-pressed': String(S.view === v), onclick: () => { S.view = v; renderAnalysis(); } }, l)));

  const body = $('#analysisBody');
  body.replaceChildren();
  const win = analysisWindow();
  const fn = { overview: viewOverview, dos: (w, b) => viewGrid('dos', w, b), habits: (w, b) => viewGrid('habits', w, b), period: viewPeriod, weight: viewWeight, spending: viewSpending }[S.view];
  fn(win, body);
}

function tile(k, v, s, cls) {
  return h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's ' + (cls || '') }, s) : null);
}
function deltaText(cur, prev, unit = 'pts') {
  if (cur === null || prev === null || cur === undefined || prev === undefined) return null;
  const d = (cur - prev) * 100;
  if (Math.abs(d) < 0.5) return ['≈ same as previous period', ''];
  return [`${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)} ${unit} vs previous period`, d > 0 ? 'up' : 'down'];
}
function insightList(items) {
  return h('ul', { class: 'insights' }, items.filter(Boolean).map(([ico, text]) => h('li', null, h('span', { class: 'ico' }, ico), h('span', null, text))));
}
function windowLabel([s, e]) { return `${fmt(s)} – ${fmt(e)}`; }

/* ---------- overview ---------- */
function viewOverview(win, body) {
  const D = analyzeGrid('dos', win), H = analyzeGrid('habits', win);
  const pw = previousWindow(win);
  const Dp = analyzeGrid('dos', pw), Hp = analyzeGrid('habits', pw);
  const P = analyzePeriod(), W = analyzeWeight(win), $p = analyzeSpending();
  const t = todayKey();
  const allStreaks = [...(D?.items || []), ...(H?.items || [])].sort((a, b) => b.current - a.current);
  const top = allStreaks[0];
  const curMonth = MONTHS[parseKey(t).getMonth()];
  const cm = $p.months.find(m => m.m === curMonth);

  const tiles = h('div', { class: 'tiles' });
  if (D) { const dt = deltaText(D.avg, Dp?.avg); tiles.append(tile('Daily Dos completion', pct(D.avg), dt?.[0] || `${D.logged.length} logged days`, dt?.[1])); }
  if (H) { const dt = deltaText(H.avg, Hp?.avg); tiles.append(tile('Habits completion', pct(H.avg), dt?.[0] || `${H.logged.length} logged days`, dt?.[1])); }
  if (top) tiles.append(tile('Best running streak', top.current ? `${top.current} days` : '—', top.current ? top.name : 'No active streak'));
  if (P.next) tiles.append(tile('Next period', fmt(P.next), P.late ? `Late by ${plural(P.late, 'day')}` : `in ${plural(Math.max(0, diffDays(t, P.next)), 'day')}${P.estimated ? ' · estimate' : ''}`, P.late ? 'down' : ''));
  if (W && W.n) tiles.append(tile('Weight', `${W.latest[1]} kg`, W.n > 1 ? `${W.latest[1] - W.first[1] >= 0 ? '+' : ''}${(W.latest[1] - W.first[1]).toFixed(1)} kg since ${fmt(W.first[0])}` : 'First weigh-in'));
  else if (W) tiles.append(tile('Weight', '—', 'No weigh-ins in this period'));
  if (cm) tiles.append(tile(`${curMonth} buy list`, rupee(cm.planned), cm.budget ? `of ${rupee(cm.budget)} budget · ${cm.boughtCount}/${cm.items.length} bought` : `${cm.boughtCount}/${cm.items.length} bought`));
  body.append(tiles);

  // combined insights
  const ins = [];
  const both = [...(D?.items || []), ...(H?.items || [])].filter(i => i.rate !== null);
  const best = [...both].sort((a, b) => b.rate - a.rate).slice(0, 3);
  if (best.length) ins.push(['🏆', `Most consistent: ${best.map(i => `${i.name} (${pct(i.rate)})`).join(', ')}.`]);
  const never = both.filter(i => i.done === 0).map(i => i.name);
  if (never.length) ins.push(['💤', `Not done even once in this period: ${never.slice(0, 6).join(', ')}${never.length > 6 ? '…' : ''}.`]);
  const improving = both.filter(i => i.trend !== null && i.trend >= 0.15).sort((a, b) => b.trend - a.trend);
  if (improving.length) ins.push(['📈', `Picking up lately: ${improving.slice(0, 3).map(i => `${i.name} (+${(i.trend * 100).toFixed(0)} pts)`).join(', ')}.`]);
  const slipping = both.filter(i => i.trend !== null && i.trend <= -0.15).sort((a, b) => a.trend - b.trend);
  if (slipping.length) ins.push(['📉', `Slipping lately: ${slipping.slice(0, 3).map(i => `${i.name} (${(i.trend * 100).toFixed(0)} pts)`).join(', ')}.`]);
  const ks = (D?.items || []).filter(i => i.lift !== null && i.lift > 0.1).sort((a, b) => b.lift - a.lift)[0];
  if (ks) ins.push(['🔑', `Keystone: on days you do “${ks.name}”, you complete ${(ks.lift * 100).toFixed(0)} pts more of your other Daily Dos.`]);
  if (D && D.unlogged) ins.push(['📝', `${plural(D.unlogged, 'day')} in this period have nothing ticked in Daily Dos — they may just be unlogged.`]);
  if (P.late) ins.push(['🩸', `Period expected ${fmt(P.next)} — now ${plural(P.late, 'day')} late.`]);
  P.flags.slice(0, 2).forEach(f => ins.push(['⚠️', f]));
  const due = analyzeSpending().restock.filter(r => r.status === 'overdue' || r.status === 'soon');
  if (due.length) ins.push(['🛒', `Restock due: ${due.slice(0, 5).map(r => r.name).join(', ')}.`]);
  if (W && W.slope !== null) ins.push(['⚖️', `Weight trend: ${W.slope * 7 >= 0 ? '+' : ''}${(W.slope * 7).toFixed(2)} kg per week over ${plural(W.n, 'weigh-in')}.`]);

  const g = h('div', { class: 'grid-2' });
  g.append(h('div', { class: 'card' }, h('h2', null, 'What stands out'), h('p', { class: 'sub' }, windowLabel(win)), h('div', { style: 'margin-top:12px' }, ins.length ? insightList(ins) : h('p', { class: 'muted' }, 'Log a few more days to see insights.'))));
  const cv = h('canvas');
  g.append(h('div', { class: 'card' }, h('h2', null, 'Daily completion'), h('p', { class: 'sub' }, 'Share of items ticked on each logged day'), h('div', { class: 'chart-box' }, cv)));
  body.append(g);

  const labels = [...new Set([...(D?.logged || []), ...(H?.logged || [])])].sort();
  const ser = (A) => labels.map(d => { const i = A?.logged.indexOf(d); return i >= 0 ? Math.round(A.score[i] * 100) : null; });
  const ds = [];
  if (D) ds.push({ label: 'Daily Dos', data: ser(D), borderColor: css('--accent'), backgroundColor: css('--accent'), borderWidth: 2, pointRadius: 3, spanGaps: true, tension: .25 });
  if (H) ds.push({ label: 'Habits', data: ser(H), borderColor: css('--orange'), backgroundColor: css('--orange'), borderWidth: 2, pointRadius: 3, spanGaps: true, tension: .25 });
  chart(cv, { type: 'line', data: { labels: labels.map(d => fmt(d)), datasets: ds }, options: { scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } } });
}

/* ---------- daily dos / habits ---------- */
function viewGrid(k, win, body) {
  const A = analyzeGrid(k, win);
  const title = k === 'dos' ? 'Daily Dos' : 'Habits';
  if (!A) { body.append(h('p', { class: 'empty' }, `No ${title} sheet found.`)); return; }
  if (!A.logged.length) { body.append(h('p', { class: 'empty' }, `Nothing ticked in ${title} for ${windowLabel(win)}.`)); return; }
  const Ap = analyzeGrid(k, previousWindow(win));
  const perfect = A.score.filter(s => s === 1).length;
  const best = [...A.items].sort((a, b) => b.longest - a.longest)[0];
  const dt = deltaText(A.avg, Ap?.avg);
  const validDow = A.dowAvg.map((v, i) => [v, i]).filter(([v]) => v !== null);
  const bestDow = validDow.sort((a, b) => b[0] - a[0])[0];
  const worstDow = validDow.sort((a, b) => a[0] - b[0])[0];

  body.append(h('div', { class: 'tiles' },
    tile('Average completion', pct(A.avg), dt?.[0], dt?.[1]),
    tile('Logged days', `${A.logged.length}/${A.days.length}`, A.unlogged ? `${A.unlogged} with nothing ticked` : 'Every day logged'),
    tile('100% days', perfect, perfect ? 'Every item ticked' : 'No perfect days yet'),
    tile('Longest streak', best.longest ? `${best.longest} days` : '—', best.longest ? best.name : ''),
    bestDow ? tile('Strongest day', DOW[bestDow[1]], `${pct(bestDow[0])} avg · weakest ${DOW[worstDow[1]]} ${pct(worstDow[0])}`) : null
  ));

  // charts
  const c1 = h('canvas'), c2 = h('canvas');
  body.append(h('div', { class: 'grid-2' },
    h('div', { class: 'card' }, h('h2', null, 'Completion over time'), h('p', { class: 'sub' }, 'Each logged day, with a 7-day rolling average'), h('div', { class: 'chart-box' }, c1)),
    h('div', { class: 'card' }, h('h2', null, 'By day of the week'), h('p', { class: 'sub' }, 'Average completion on logged days'), h('div', { class: 'chart-box' }, c2))
  ));
  const pctScore = A.score.map(s => Math.round(s * 100));
  chart(c1, {
    type: 'line',
    data: {
      labels: A.logged.map(d => fmt(d)), datasets: [
        { label: 'Daily', data: pctScore, borderColor: css('--line'), backgroundColor: css('--ink-3'), borderWidth: 1, pointRadius: 3 },
        { label: '7-day average', data: rolling(pctScore, 7).map(v => v === null ? null : Math.round(v)), borderColor: css('--accent'), backgroundColor: css('--accent'), borderWidth: 2, pointRadius: 0, tension: .3 }
      ]
    },
    options: { scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } }
  });
  const order = [1, 2, 3, 4, 5, 6, 0];
  chart(c2, {
    type: 'bar',
    data: { labels: order.map(i => DOW[i]), datasets: [{ label: 'Completion', data: order.map(i => A.dowAvg[i] === null ? null : Math.round(A.dowAvg[i] * 100)), backgroundColor: css('--accent'), borderRadius: 4, maxBarThickness: 36 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } }
  });

  // per item table
  const rows = [...A.items].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const trendTag = t => t === null ? h('span', { class: 'muted' }, '—') : t >= 0.15 ? h('span', { class: 'tag good' }, `▲ ${(t * 100).toFixed(0)}`) : t <= -0.15 ? h('span', { class: 'tag bad' }, `▼ ${Math.abs(t * 100).toFixed(0)}`) : h('span', { class: 'tag' }, 'steady');
  body.append(h('div', { class: 'card', style: 'margin-bottom:16px' },
    h('h2', null, 'Every item'), h('p', { class: 'sub' }, 'Rate = days done ÷ logged days. Trend compares the second half of the period with the first.'),
    h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Item', 'Done', 'Rate', 'Current streak', 'Longest', 'Trend', 'Best day', 'Last done'].map(t => h('th', null, t)))),
      h('tbody', null, rows.map(r => {
        const bd = r.byDow.map((v, i) => [v, i]).filter(([v]) => v !== null).sort((a, b) => b[0] - a[0])[0];
        return h('tr', null,
          h('td', { class: 'name' }, r.name),
          h('td', null, r.done),
          h('td', null, h('div', { class: 'bar-cell' }, h('div', { class: 'bar' }, h('span', { style: `width:${((r.rate || 0) * 100).toFixed(1)}%` })), pct(r.rate))),
          h('td', null, r.current ? `🔥 ${r.current}` : '—'),
          h('td', null, r.longest || '—'),
          h('td', null, trendTag(r.trend)),
          h('td', null, bd && bd[0] > 0 ? DOW[bd[1]] : '—'),
          h('td', null, r.lastDone ? fmt(r.lastDone) : 'never'));
      }))
    ))
  ));

  // heatmap
  const days = A.days.slice(-62);
  const heat = h('div', { class: 'heat', style: `grid-template-columns: minmax(140px, 220px) repeat(${days.length}, 14px)` });
  heat.append(h('div', { class: 'hn' }, ''));
  days.forEach(d => { const n = parseKey(d).getDate(); heat.append(h('div', { class: 'hd', title: fmtLong(d) }, n === 1 || n % 5 === 0 ? n : '')); });
  const ix = S.idx[k];
  for (const name of ix.items) {
    heat.append(h('div', { class: 'hn', title: name }, name));
    days.forEach(d => {
      const logged = ix.loggedDays.has(d);
      const on = ix.sets[name].has(d);
      heat.append(h('div', { class: 'hc' + (on ? ' on' : logged ? '' : ' off-log'), title: `${name} · ${fmtLong(d)}: ${on ? 'done' : logged ? 'not done' : 'day not logged'}` }));
    });
  }
  body.append(h('div', { class: 'card', style: 'margin-bottom:16px' },
    h('h2', null, 'Day-by-day map'), h('p', { class: 'sub' }, days.length < A.days.length ? 'Last 62 days of the selected period' : windowLabel(win)),
    h('div', { class: 'heat-wrap', style: 'margin-top:12px' }, heat),
    h('div', { class: 'legend' }, h('span', null, h('i', { style: 'background:var(--done)' }), 'Done'), h('span', null, h('i', { style: 'background:var(--miss)' }), 'Not done'), h('span', null, h('i', { style: 'border:1px dashed var(--line)' }), 'Day not logged'))
  ));

  // insights
  const ins = [];
  const keys = A.items.filter(i => i.lift !== null).sort((a, b) => b.lift - a.lift);
  if (keys[0] && keys[0].lift > 0.05) ins.push(['🔑', `When you do “${keys[0].name}”, the rest of your ${title.toLowerCase()} go ${(keys[0].lift * 100).toFixed(0)} pts better that day. It looks like a keystone item.`]);
  if (keys.length > 1 && keys[keys.length - 1].lift < -0.05) ins.push(['⚖️', `Days with “${keys[keys.length - 1].name}” have ${Math.abs(keys[keys.length - 1].lift * 100).toFixed(0)} pts lower completion of everything else — maybe it crowds the day.`]);
  const zero = A.items.filter(i => i.done === 0);
  if (zero.length) ins.push(['💤', `Never ticked in this period: ${zero.map(i => i.name).join(', ')}. Worth asking whether they still belong on the list, or need a smaller version.`]);
  const always = A.items.filter(i => i.rate === 1);
  if (always.length) ins.push(['✨', `Done on every logged day: ${always.map(i => i.name).join(', ')}.`]);
  const weekend = mean([A.dowAvg[0], A.dowAvg[6]].filter(v => v !== null)), weekday = mean([1, 2, 3, 4, 5].map(i => A.dowAvg[i]).filter(v => v !== null));
  if (weekend !== null && weekday !== null && Math.abs(weekend - weekday) >= 0.1) ins.push(['📅', `Weekends run ${Math.abs((weekend - weekday) * 100).toFixed(0)} pts ${weekend > weekday ? 'higher' : 'lower'} than weekdays (${pct(weekend)} vs ${pct(weekday)}).`]);
  const P = analyzePeriod();
  if (P.periods.length) {
    const pd = new Set(P.periods.flatMap(p => rangeDays(p.start, p.end)));
    const onP = A.logged.map((d, i) => pd.has(d) ? A.score[i] : null).filter(v => v !== null);
    const offP = A.logged.map((d, i) => !pd.has(d) ? A.score[i] : null).filter(v => v !== null);
    if (onP.length >= 2 && offP.length >= 3) ins.push(['🌸', `On period days your completion is ${pct(mean(onP))} vs ${pct(mean(offP))} on other days.`]);
  }
  if (ins.length) body.append(h('div', { class: 'card' }, h('h2', null, 'Patterns'), h('div', { style: 'margin-top:10px' }, insightList(ins))));
}

/* ---------- period ---------- */
function viewPeriod(win, body) {
  const P = analyzePeriod();
  if (!S.idx.period) { body.append(h('p', { class: 'empty' }, 'No period tracker sheet found.')); return; }
  if (!P.periods.length) { body.append(h('p', { class: 'empty' }, 'No period days logged yet.')); return; }
  const t = todayKey();
  const cd = cycleDayOn(P, t);
  body.append(h('div', { class: 'tiles' },
    tile('Next period', fmt(P.next), P.late ? `Late by ${plural(P.late, 'day')}` : `in ${plural(Math.max(0, diffDays(t, P.next)), 'day')} · window ${fmt(addDays(P.next, -P.spread))}–${fmt(addDays(P.next, P.spread))}`, P.late ? 'down' : ''),
    tile('Average cycle', P.avgCycle ? `${P.avgCycle.toFixed(1)} d` : '—', P.avgCycle ? `${plural(P.cycles.length, 'cycle')}${P.variation !== null ? ` · varies ${P.variation} d` : ''}` : 'Needs 2 periods — using 28 days for now'),
    tile('Average period', `${P.avgLen.toFixed(1)} d`, `${plural(P.periods.length, 'period')} logged`),
    cd ? tile('Today', `Day ${cd.day}`, cd.phase) : null,
    P.ovulation && P.ovulation >= t ? tile('Est. ovulation', fmt(P.ovulation), `Fertile window ${fmt(P.fertile[0])}–${fmt(P.fertile[1])}`) : null
  ));

  // calendar
  const months = [...new Set([...S.idx.period.dateSet].map(monthOf))].sort();
  const markSet = S.idx.period.marked;
  const spotSet = new Set(P.spotting.flatMap(r => r.days));
  const predSet = new Set();
  P.nextList.forEach(n => rangeDays(n, addDays(n, Math.max(1, Math.round(P.avgLen)) - 1)).forEach(d => { if (d >= t) predSet.add(d); }));
  const fertSet = new Set(P.fertile && P.fertile[1] >= t ? rangeDays(P.fertile[0], P.fertile[1]) : []);
  const cal = h('div', { class: 'cal-months' }, months.map(ym => {
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(y, m - 1, 1).getDay();
    const n = new Date(y, m, 0).getDate();
    const grid = h('div', { class: 'cal-grid' }, ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => h('div', { class: 'dow' }, x)));
    for (let i = 0; i < first; i++) grid.append(h('div'));
    for (let d = 1; d <= n; d++) {
      const k = `${ym}-${pad(d)}`;
      let cls = 'd';
      if (markSet.has(k)) cls += spotSet.has(k) ? ' s' : ' p';
      else if (predSet.has(k)) cls += ' pred';
      else if (fertSet.has(k)) cls += ' fert';
      if (k === t) cls += ' today';
      grid.append(h('div', { class: cls, title: fmtLong(k) }, d));
    }
    return h('div', { class: 'cal' }, h('h3', null, monthLabel(ym)), grid);
  }));
  body.append(h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h2', null, 'Calendar'),
    h('div', { style: 'margin-top:12px' }, cal),
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: 'background:var(--pink)' }), 'Period'),
      h('span', null, h('i', { style: 'background:var(--pink-soft)' }), 'Spotting'),
      h('span', null, h('i', { style: 'border:2px dashed var(--pink)' }), 'Predicted'),
      h('span', null, h('i', { style: 'background:var(--accent-soft)' }), 'Est. fertile window'))));

  const g = h('div', { class: 'grid-2' });
  // periods table
  g.append(h('div', { class: 'card' }, h('h2', null, 'Logged periods'),
    h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Start', 'End', 'Days', 'Cycle length'].map(x => h('th', null, x)))),
      h('tbody', null, P.periods.map((p, i) => h('tr', null, h('td', null, fmt(p.start)), h('td', null, fmt(p.end)), h('td', null, p.length),
        h('td', null, P.cycles[i] ? `${P.cycles[i].length} d` : (i === P.periods.length - 1 ? 'current' : '—')))))))));
  // cycle chart or note
  if (P.cycles.length >= 2) {
    const cv = h('canvas');
    g.append(h('div', { class: 'card' }, h('h2', null, 'Cycle length'), h('p', { class: 'sub' }, '21–35 days is the usual range'), h('div', { class: 'chart-box' }, cv)));
    setTimeout(() => chart(cv, { type: 'bar', data: { labels: P.cycles.map(c => fmt(c.from)), datasets: [{ label: 'Days', data: P.cycles.map(c => c.length), backgroundColor: css('--pink'), borderRadius: 4, maxBarThickness: 40 }] }, options: { plugins: { legend: { display: false } }, scales: { y: { suggestedMin: 15, suggestedMax: 40 }, x: { grid: { display: false } } } } }));
  }
  // cross-sheet effects
  const ins = [];
  const pd = new Set(P.periods.flatMap(p => rangeDays(p.start, p.end)));
  for (const k of ['dos', 'habits']) {
    const ix = S.idx[k];
    if (!ix) continue;
    const logged = [...ix.loggedDays];
    const on = logged.filter(d => pd.has(d)), off = logged.filter(d => !pd.has(d));
    if (on.length < 2 || off.length < 3) continue;
    const drops = ix.items.map(n => ({ n, a: on.filter(d => ix.sets[n].has(d)).length / on.length, b: off.filter(d => ix.sets[n].has(d)).length / off.length }))
      .map(x => ({ ...x, d: x.a - x.b })).filter(x => Math.abs(x.d) >= 0.2).sort((a, b) => a.d - b.d);
    drops.slice(0, 3).forEach(x => ins.push([x.d < 0 ? '🔻' : '🔺', `${x.n}: ${pct(x.a)} on period days vs ${pct(x.b)} otherwise.`]));
  }
  const W = S.idx.weight;
  if (W) {
    const byPhase = {};
    for (const [d, w] of Object.entries(W.entries)) { const c = cycleDayOn(P, d); if (c) (byPhase[c.phase] ||= []).push(w); }
    const ph = Object.entries(byPhase).filter(([, a]) => a.length >= 2);
    if (ph.length >= 2) ins.push(['⚖️', 'Average weight by phase: ' + ph.map(([p, a]) => `${p} ${mean(a).toFixed(1)} kg`).join(' · ') + '.']);
  }
  P.flags.forEach(f => ins.push(['⚠️', f]));
  if (P.estimated) ins.push(['ℹ️', 'Predictions use a 28-day cycle until two periods are logged.']);
  ins.push(['ℹ️', 'Ovulation and fertile-window dates are calendar estimates (14 days before the next period), not medical advice.']);
  g.append(h('div', { class: 'card' }, h('h2', null, 'How your cycle shows up elsewhere'), h('div', { style: 'margin-top:10px' }, insightList(ins))));
  body.append(g);
}

/* ---------- weight ---------- */
function viewWeight(win, body) {
  const W = analyzeWeight(win);
  if (!W) { body.append(h('p', { class: 'empty' }, 'No weight sheet found.')); return; }
  if (!W.n) { body.append(h('p', { class: 'empty' }, `No weigh-ins logged for ${windowLabel(win)}. Add one from “Log a day”.`)); return; }
  const change = W.latest[1] - W.first[1];
  body.append(h('div', { class: 'tiles' },
    tile('Latest', `${W.latest[1]} kg`, fmt(W.latest[0])),
    tile('Change', `${change >= 0 ? '+' : ''}${change.toFixed(1)} kg`, `since ${fmt(W.first[0])}`, change < 0 ? 'up' : change > 0 ? 'down' : ''),
    tile('Weekly trend', W.slope !== null ? `${W.slope * 7 >= 0 ? '+' : ''}${(W.slope * 7).toFixed(2)} kg` : '—', W.slope !== null ? 'per week (best-fit line)' : 'Needs 3+ weigh-ins'),
    tile('Range', `${W.minP[1]}–${W.maxP[1]} kg`, `low ${fmt(W.minP[0])} · high ${fmt(W.maxP[0])}`),
    tile('Weigh-ins', W.n, `${pct(W.n / W.span)} of days since the first one`),
    W.slope !== null && W.n >= 5 ? tile('In 30 days, at this pace', `${(W.latest[1] + W.slope * 30).toFixed(1)} kg`, 'Rough projection') : null
  ));
  const cv = h('canvas');
  body.append(h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h2', null, 'Weight over time'), h('p', { class: 'sub' }, 'Each weigh-in, with a 7-day average to smooth daily water swings'), h('div', { class: 'chart-box tall' }, cv)));
  const lo = Math.floor(Math.min(...W.pts.map(p => p[1])) - 1), hi = Math.ceil(Math.max(...W.pts.map(p => p[1])) + 1);
  chart(cv, {
    type: 'line',
    data: {
      labels: W.pts.map(p => fmt(p[0])), datasets: [
        { label: 'Weigh-in', data: W.pts.map(p => p[1]), borderColor: css('--line'), backgroundColor: css('--ink-3'), borderWidth: 1, pointRadius: 3 },
        { label: '7-day average', data: W.ma7.map(v => +v.toFixed(2)), borderColor: css('--accent'), backgroundColor: css('--accent'), borderWidth: 2, pointRadius: 0, tension: .3 }
      ]
    },
    options: { scales: { y: { min: lo, max: hi, ticks: { callback: v => v + ' kg' } }, x: { grid: { display: false } } } }
  });

  const card = h('div', { class: 'card' }, h('h2', null, 'What moves your weight'), h('p', { class: 'sub' }, 'Average change by the next morning, on days you did each item vs days you didn’t. Needs back-to-back weigh-ins.'));
  if (W.effects.length) {
    const show = [...W.effects.slice(0, 5), ...W.effects.slice(-5).reverse()].filter((v, i, a) => a.indexOf(v) === i);
    card.append(h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Item', 'Next day when done', 'When not done', 'Difference'].map(x => h('th', null, x)))),
      h('tbody', null, show.map(e => h('tr', null, h('td', { class: 'name' }, e.name),
        h('td', null, `${e.on >= 0 ? '+' : ''}${(e.on * 1000).toFixed(0)} g`),
        h('td', null, `${e.off >= 0 ? '+' : ''}${(e.off * 1000).toFixed(0)} g`),
        h('td', null, h('span', { class: 'tag ' + (e.diff < -0.05 ? 'good' : e.diff > 0.05 ? 'bad' : '') }, `${e.diff >= 0 ? '+' : ''}${(e.diff * 1000).toFixed(0)} g`))))))));
    card.append(h('p', { class: 'hint' }, `Based on ${plural(W.deltas.length, 'pair')} of consecutive-day weigh-ins. These are associations, not proof — more data makes them more trustworthy.`));
  } else {
    card.append(h('p', { class: 'muted', style: 'margin-top:10px' }, `Not enough back-to-back weigh-ins yet (${W.deltas.length} pairs). Weigh in daily for 1–2 weeks to unlock this.`));
  }
  body.append(card);
}

/* ---------- spending ---------- */
function viewSpending(win, body) {
  const A = analyzeSpending();
  const t = todayKey();
  const activeMonths = A.months.filter(m => m.items.length || m.budget);
  body.append(h('div', { class: 'tiles' },
    tile('Planned this year', rupee(A.yearPlanned), `${plural(activeMonths.length, 'month')} with a list`),
    tile('Budgets set', A.yearBudget ? rupee(A.yearBudget) : '—', A.yearBudget ? `${pct(A.yearPlanned / A.yearBudget)} planned against it` : 'Set budgets in Buy list'),
    tile('Planned & bought', rupee(A.yearBought), A.yearPlanned ? `${pct(A.yearBought / A.yearPlanned)} of planned value` : ''),
    tile('Restock due', A.restock.filter(r => r.status === 'overdue' || r.status === 'soon').length, 'overdue or within 7 days')
  ));

  const cv = h('canvas');
  const g = h('div', { class: 'grid-2' });
  g.append(h('div', { class: 'card' }, h('h2', null, 'Budget, planned and bought by month'), h('div', { class: 'chart-box' }, cv)));
  const ins = [];
  A.months.forEach(m => {
    if (m.budget && m.planned > m.budget) ins.push(['🔴', `${m.m}: planned ${rupee(m.planned)} is ${rupee(m.planned - m.budget)} over the ${rupee(m.budget)} budget.`]);
    if (m.items.length && monthKey(m.m) < monthOf(t)) {
      const rate = m.boughtCount / m.items.length;
      ins.push([rate >= .8 ? '✅' : '🟡', `${m.m}: bought ${m.boughtCount} of ${m.items.length} planned (${pct(rate)}).`]);
    }
    if (m.unplanned.length) ins.push(['🛍️', `${m.m}: ${plural(m.unplanned.length, 'unplanned purchase')} — ${m.unplanned.slice(0, 5).join(', ')}${m.unplanned.length > 5 ? '…' : ''}.`]);
  });
  if (A.repeat.length) ins.push(['🔁', `On the list in several months: ${A.repeat.slice(0, 5).map(r => `${r.name} (${r.months.join(', ')})`).join('; ')}.`]);
  if (A.priciest.length) ins.push(['💸', `Biggest planned items: ${A.priciest.slice(0, 4).map(i => `${i.product} ${rupee(i.cost)} (${i.m.slice(0, 3)})`).join(', ')}.`]);
  g.append(h('div', { class: 'card' }, h('h2', null, 'Buy-list insights'), h('div', { style: 'margin-top:10px' }, ins.length ? insightList(ins) : h('p', { class: 'muted' }, 'Add items and costs in the Buy list tab to see insights.'))));
  body.append(g);
  const shown = A.months.filter(m => m.items.length || m.budget || monthKey(m.m) >= monthOf(S.idx.first) && monthKey(m.m) <= monthOf(S.idx.last));
  chart(cv, {
    type: 'bar',
    data: {
      labels: shown.map(m => m.m.slice(0, 3)), datasets: [
        { label: 'Planned', data: shown.map(m => m.planned), backgroundColor: css('--accent'), borderRadius: 4, maxBarThickness: 28 },
        { label: 'Bought (planned items)', data: shown.map(m => m.boughtVal), backgroundColor: css('--orange'), borderRadius: 4, maxBarThickness: 28 },
        { label: 'Budget', data: shown.map(m => m.budget), backgroundColor: css('--ink-3'), borderRadius: 4, maxBarThickness: 28 }
      ]
    },
    options: { scales: { y: { beginAtZero: true, ticks: { callback: v => '₹' + Number(v).toLocaleString('en-IN') } }, x: { grid: { display: false } } }, plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${rupee(c.raw)}` } } } }
  });

  // restock table
  const order = { overdue: 0, soon: 1, ok: 2, once: 3, never: 4 };
  const label = { overdue: ['bad', 'Overdue'], soon: ['warn', 'Due soon'], ok: ['good', 'Stocked'], once: ['', 'Bought once'], never: ['', 'Not bought yet'] };
  const rows = [...A.restock].sort((a, b) => order[a.status] - order[b.status] || (a.next || '').localeCompare(b.next || '') || b.count - a.count);
  body.append(h('div', { class: 'card', style: 'margin-top:16px' },
    h('h2', null, 'Restock tracker'), h('p', { class: 'sub' }, 'From the dates you ticked in Products. “Usually lasts” is the average gap between purchases.'),
    h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Product', 'Times bought', 'Usually lasts', 'Last bought', 'Next expected', 'Status'].map(x => h('th', null, x)))),
      h('tbody', null, rows.map(r => h('tr', null,
        h('td', { class: 'name' }, r.name), h('td', null, r.count),
        h('td', null, r.interval ? `${Math.round(r.interval)} days` : '—'),
        h('td', null, r.last ? fmt(r.last) : '—'),
        h('td', null, r.next ? fmt(r.next) : '—'),
        h('td', null, h('span', { class: 'tag ' + label[r.status][0] }, label[r.status][1])))))))));
}

/* =========================================================
 * Demo data (made up)
 * ======================================================= */
function makeDemoData() {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const year = new Date().getFullYear();
  const dates = rangeDays(`${year}-09-01`, `${year}-12-31`);
  const t = todayKey();
  const past = dates.filter(d => d < t);
  const dos = ['Bath', 'Breakfast', 'Brush Teeth morning', 'Dinner', 'Exercise - 45 mins', 'Fold bed sheet', 'Learn a new language', 'Lunch', 'Meditate - 10 mins', 'Night brush teeth', 'Night face wash', 'Read books/ Art - 1 hour', 'Study Technology - 1 hour', 'Work', 'Face exercise 5 mins'];
  const dosP = [.97, .9, .97, .95, .45, .8, .2, .93, .35, .6, .55, .4, .5, .7, .25];
  const habits = ['Eat curry leaves', 'Eat fenu greek seeds', 'Eat Nuts', 'Exercise 30-45 mins', 'Face Massage', 'No sugar', 'Sun - Vitamin D - 10 mins', 'Tea', 'Water (2 liters)', 'Eat sesame seeds', 'Massage hair', 'No cheese', 'No maida'];
  const habP = [.5, .45, .6, .4, .35, .5, .3, .85, .55, .3, .25, .7, .6];
  const products = ['Blue harpic', 'Body scrub', 'Bodywise body wash', 'Brush', 'Clinic plus', 'Coconut oil', 'Colgate Active salt', 'Dettol', 'Fruits', 'Hair growth serum', 'Pears soap', 'Sesame oil', 'Surf excel', 'Tea varieties', 'Turmeric'];
  const prodEvery = [30, 45, 40, 60, 35, 25, 28, 50, 6, 40, 20, 30, 30, 21, 45];
  const gridOf = (names, probs, skip = .1) => {
    const logged = past.filter(() => rnd() > skip);
    return { sheetName: '', dates, items: names.map((n, i) => ({ name: n, marked: logged.filter(d => rnd() < probs[i] + (dow(d) % 6 === 0 ? -.1 : .05)) })) };
  };
  const prod = { sheetName: '', dates, items: products.map((n, i) => {
    const m = []; let d = addDays(dates[0], Math.floor(rnd() * 12));
    while (d < t) { m.push(d); d = addDays(d, Math.round(prodEvery[i] * (0.8 + rnd() * 0.4))); }
    return { name: n, marked: m };
  }) };
  const period = [];
  for (const [s, len] of [[`${year}-09-04`, 5], [`${year}-10-02`, 4], [`${year}-10-30`, 5]]) rangeDays(s, addDays(s, len - 1)).forEach(d => { if (d < t) period.push(d); });
  if (`${year}-09-15` < t) period.push(`${year}-09-15`);
  const entries = {};
  let w = 64.8;
  past.forEach(d => { w += (rnd() - .55) * .35; if (rnd() > .25) entries[d] = +w.toFixed(1); });
  const buy = { sheetName: 'Month List To buy', slots: 11, months: {} };
  MONTHS.forEach(m => { buy.months[m] = []; });
  buy.months.September = [{ product: 'Coconut oil', cost: 220 }, { product: 'Bodywise body wash', cost: 499 }, { product: 'Tea varieties', cost: 350 }, { product: 'Brush', cost: 90 }];
  buy.months.October = [{ product: 'Hair growth serum', cost: 650 }, { product: 'Surf excel', cost: 310 }, { product: 'Fruits', cost: 600 }, { product: 'Running shoes', cost: 2800 }, { product: 'Turmeric', cost: 80 }];
  buy.months.November = [{ product: 'Coconut oil', cost: 220 }, { product: 'Winter moisturiser', cost: 420 }, { product: 'Sesame oil', cost: 260 }];
  buy.months.December = [{ product: 'Body scrub', cost: 550 }, { product: 'Fruits', cost: 600 }];
  return {
    title: `${year} Tracker (demo)`, timezone: 'Asia/Kolkata',
    sheets: {
      products: prod, dos: gridOf(dos, dosP), habits: gridOf(habits, habP, .25),
      period: { sheetName: '', dates, marked: period.sort() },
      weight: { sheetName: '', dates, entries },
      buy
    },
    budgets: { September: 1500, October: 4000, November: 1200 }
  };
}

/* =========================================================
 * Wiring
 * ======================================================= */
function init() {
  fillRecent();
  const params = new URLSearchParams(location.search);
  $('#sheetUrl').value = params.get('sheet') || store.get('lastSheet', '');
  $('#scriptUrl').value = S.settings.scriptUrl;
  $('#passcode').value = S.settings.passcode;

  $$('.tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#sheetForm').addEventListener('submit', e => { e.preventDefault(); S.demo = false; loadSheet(); });

  $('#logDate').addEventListener('change', e => {
    if (!e.target.value) return;
    if (pendingCount() && !confirm('Discard unsaved changes for this day?')) { e.target.value = S.logDate; return; }
    S.pending = freshPending(); S.logDate = clampDate(e.target.value); renderLog();
  });
  $('#prevDay').addEventListener('click', () => moveDay(-1));
  $('#nextDay').addEventListener('click', () => moveDay(1));
  $('#todayBtn').addEventListener('click', () => moveDay(diffDays(S.logDate, todayKey())));
  $('#discardBtn').addEventListener('click', () => { S.pending = freshPending(); renderLog(); });
  $('#saveDayBtn').addEventListener('click', saveDay);

  $('#addBuyRow').addEventListener('click', () => { S.buyDraft.items.push({ product: '', cost: '' }); markBuyDirty(); renderBuy(); const ins = $$('#buyRows input.p'); ins[ins.length - 1]?.focus(); });
  $('#saveBuyBtn').addEventListener('click', saveBuy);

  $('#saveSettings').addEventListener('click', async () => {
    S.settings.scriptUrl = $('#scriptUrl').value.trim();
    S.settings.passcode = $('#passcode').value;
    store.set('scriptUrl', S.settings.scriptUrl);
    store.set('passcode', S.settings.passcode);
    const st = $('#settingsStatus');
    st.textContent = 'Testing…';
    const wasDemo = S.demo; S.demo = false;
    try { await api('ping'); st.textContent = '✓ Connected'; toast('Connected to your script ✓'); }
    catch (err) { st.textContent = '✗ ' + err.message; S.demo = wasDemo; }
  });
  $('#forgetSettings').addEventListener('click', () => {
    ['scriptUrl', 'passcode', 'recent', 'lastSheet'].forEach(k => store.del(k));
    S.settings = { scriptUrl: '', passcode: '' };
    $('#scriptUrl').value = ''; $('#passcode').value = ''; fillRecent();
    toast('Cleared from this device');
  });
  $('#demoBtn').addEventListener('click', () => { S.demo = true; S.data = null; loadSheet().then(() => switchTab('log')); });

  window.addEventListener('beforeunload', e => { if (pendingCount() || S.buyDirty) { e.preventDefault(); e.returnValue = ''; } });

  if (!S.settings.scriptUrl) switchTab('settings');
  else if ($('#sheetUrl').value) loadSheet();
}

document.addEventListener('DOMContentLoaded', init);
