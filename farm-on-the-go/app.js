/* Farm on the Go - the app.
   Everything is kept on this phone (IndexedDB 'farm_on_the_go_v1'), so it works with no internet at all. It shares
   nothing with the other DukaGO apps: its own database, its own offline cache and its own settings. */
'use strict';
const BUILD = '2026-11-06-1';
const L = window.FARM_LIB;
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
const fmtN = n => (Math.round(n * 100) / 100).toLocaleString('en-KE');
const ksh = n => 'KSh ' + Math.round(n).toLocaleString('en-KE');
const plural = (n, w, ws) => fmtN(n) + ' ' + (Math.abs(n) === 1 ? w : (ws || w + 's'));

// ---------------- dates (local, as YYYY-MM-DD) ----------------
const p2 = n => String(n).padStart(2, '0');
const ds = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const today = () => ds(new Date());
const pd = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const addD = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return ds(d); };
const dd = (a, b) => Math.round((pd(b) - pd(a)) / 864e5);           // days from a to b
const fmtD = s => { if (!s) return ''; const d = pd(s), y = d.getFullYear() !== new Date().getFullYear(); return d.toLocaleDateString('en-GB', y ? { day: 'numeric', month: 'short', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short' }); };
const rel = s => { const n = dd(today(), s); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? 'in ' + n + ' days' : -n + ' days ago'; };
const monthKey = s => String(s).slice(0, 7);
const monthName = k => pd(k + '-01').toLocaleDateString('en-GB', { month: 'short' });

// ---------------- storage ----------------
const DBN = 'farm_on_the_go_v1';
const STORES = ['kv', 'fields', 'plantings', 'acts', 'harvests', 'sales', 'expenses', 'batches', 'orders', 'sorders', 'dx', 'animals', 'milk', 'herdlog', 'flocks', 'flocklog'];
let db; const D = {}; const K = {};
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DBN, 3);
    r.onupgradeneeded = () => { const d = r.result; STORES.forEach(s => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); }); if (!d.objectStoreNames.contains('_sync')) d.createObjectStore('_sync', { keyPath: 'id' }); };
    r.onsuccess = () => { db = r.result; res(); }; r.onerror = () => rej(r.error);
  });
}
const idb = (s, mode, f) => new Promise((res, rej) => { const t = db.transaction(s, mode); const q = f(t.objectStore(s)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); });
async function loadAll() {
  for (const s of STORES) { const rows = await idb(s, 'readonly', o => o.getAll()); if (s === 'kv') rows.forEach(r => { K[r.id] = r.v; }); else D[s] = rows; }
}
async function save(s, obj) {
  obj.updated_at = new Date().toISOString();
  obj._d = obj.updated_at;                       // mark dirty for cloud sync
  const a = D[s], i = a.findIndex(x => x.id === obj.id); if (i >= 0) a[i] = obj; else a.push(obj);
  await idb(s, 'readwrite', o => o.put(obj)); if (typeof scheduleSync === 'function') scheduleSync(); return obj;
}
async function remove(s, id) { const rec = D[s].find(x => x.id === id); try { if (s !== 'kv') await idb('_sync', 'readwrite', o => o.put({ id: 'tomb:' + s + ':' + id, store: s, rid: id, doc: { id: id }, _ts: new Date().toISOString() })); } catch (e) {} D[s] = D[s].filter(x => x.id !== id); await idb(s, 'readwrite', o => o.delete(id)); if (typeof scheduleSync === 'function') scheduleSync(); }
async function setK(k, v) { K[k] = v; const loc = (typeof KV_LOCAL !== 'undefined' && KV_LOCAL.includes(k)) || k[0] === '_'; const rec = { id: k, v }; if (!loc) rec._d = new Date().toISOString(); await idb('kv', 'readwrite', o => o.put(rec)); if (!loc && typeof scheduleSync === 'function') scheduleSync(); }
const byId = (s, id) => D[s].find(x => x.id === id);
const prof = () => K.profile || {};
const isProp = () => prof().role === 'propagator';

// ---------------- crops, plantings and schedules ----------------
const crop = id => L.CROP[id] || { id, n: id || 'Crop', e: '🌿', stages: [], tasks: [], problems: [], units: ['kg'], unit: 'kg', first: 0, last: 0, nursery: 0, custom: true };
const cropName = (p) => p.crop === 'other' ? (p.cropName || 'Other crop') : crop(p.crop).n;
const cropEm = (id) => id === 'other' ? '🌿' : crop(id).e;
const pName = p => (p.name || cropName(p) + (p.variety ? ' - ' + p.variety : '')) + (p.field && byId('fields', p.field) ? ' · ' + byId('fields', p.field).name : '');
const age = p => dd(p.date, today());
function stageOf(p) {
  const c = crop(p.crop), a = age(p);
  if (a < 0) return { name: 'Planned - planting ' + rel(p.date), i: -1 };
  let st = null, i = -1; c.stages.forEach((s, j) => { if (a >= s[1] && a <= s[2]) { st = s; i = j; } });
  if (st) return { name: st[0], i };
  if (c.stages.length && a > c.last) return { name: c.perennial ? 'Bearing' : 'Past the usual harvest end', i: c.stages.length, over: !c.perennial };
  return { name: 'Growing', i: -1 };
}
// every care task of a planting from today-21 to today+60 (repeating tasks expanded), plus the farmer's own reminders
function tasksOf(p) {
  const c = crop(p.crop), out = []; const a = age(p);
  const mk = (key, day, type, t, x) => ({ key, day, due: addD(p.date, day), type, t, x, p });
  (c.tasks || []).forEach((tk, i) => {
    const [d, type, t, x, every, until] = tk;
    if (!every) { out.push(mk(i + '@' + d, d, type, t, x)); return; }
    for (let k = Math.max(0, Math.ceil((a - 21 - d) / every)); ; k++) { const day = d + k * every; if (day > until || day > a + 60) break; out.push(mk(i + '@' + day, day, type, t, x)); }
  });
  (p.extra || []).forEach(e => out.push(mk('x:' + e.id, dd(p.date, e.date), e.type || 'other', e.t, e.x || 'Your reminder')));
  return out.sort((x, y) => x.day - y.day);
}
const taskState = t => (t.p.done || {})[t.key];
function openTasks(p, horizon) {
  const t0 = today(), list = tasksOf(p).filter(t => !taskState(t) && dd(t0, t.due) >= -21 && dd(t0, t.due) <= horizon);
  // a repeating job missed several times shows once - its latest date
  const last = {}; list.forEach(t => { if (t.due <= t0 && !/^x:/.test(t.key)) { const g = t.key.split('@')[0]; if (!last[g] || t.day > last[g].day) last[g] = t; } });
  return list.filter(t => t.due > t0 || /^x:/.test(t.key) || last[t.key.split('@')[0]] === t);
}
const activePlantings = () => D.plantings.filter(p => p.status !== 'ended').sort((a, b) => a.date < b.date ? -1 : 1);
// pre-harvest interval: the last spray decides the first safe harvest day
function phiUntil(pid) {
  let u = null, prod = '';
  D.acts.filter(a => a.pid === pid && a.type === 'spray' && num(a.phi) > 0).forEach(a => { const d = addD(a.date, num(a.phi)); if (!u || d > u) { u = d; prod = a.product || a.title; } });
  return u && u > today() ? { until: u, prod } : null;
}
const TT = L.TASK_TYPES;
const ttIcon = t => (TT[t] || TT.other)[1], ttName = t => (TT[t] || TT.other)[0];

// ---------------- propagator: batches ----------------
function bCalc(b) {
  const c = crop(b.crop), raised = Math.max(0, Math.round(num(b.trays) * num(b.cells) * (num(b.germ || 85) / 100)) - num(b.lost));
  const ord = D.orders.filter(o => o.batch === b.id);
  const reserved = ord.filter(o => o.status === 'accepted').reduce((s, o) => s + num(o.qty), 0);
  const sold = ord.filter(o => o.status === 'collected').reduce((s, o) => s + num(o.qty), 0) + D.sales.filter(s => s.batch === b.id).reduce((s, x) => s + num(x.qty), 0);
  const avail = Math.max(0, raised - reserved - sold), ready = b.ready || addD(b.sow, c.nursery || 30), toReady = dd(today(), ready);
  let st, cls;
  if (b.closed) { st = 'Closed'; cls = ''; }
  else if (raised > 0 && avail <= 0) { st = reserved > 0 ? 'Fully booked' : 'Sold out'; cls = 'p'; }
  else if (toReady > 7) { st = 'Growing'; cls = 'b'; }
  else if (toReady > 0) { st = 'Ready soon'; cls = 'a'; }
  else if (toReady >= -21) { st = 'Ready'; cls = 'g'; }
  else { st = 'Getting old'; cls = 'r'; }
  return { c, raised, reserved, sold, avail, ready, toReady, st, cls, open: !b.closed && avail > 0 && toReady >= -21 };
}
const bName = b => crop(b.crop).n + (b.variety ? ' - ' + b.variety : '');
const activeBatches = () => D.batches.filter(b => !b.closed).sort((a, b) => (bCalc(a).ready < bCalc(b).ready ? -1 : 1));

// ---------------- money ----------------
const FARM_COSTS = ['Seed / seedlings', 'Fertiliser and manure', 'Sprays (chemicals)', 'Labour', 'Water and irrigation', 'Transport', 'Land lease', 'Tools and equipment', 'Packaging', 'Other'];
const NURSERY_COSTS = ['Seed', 'Trays and media (cocopeat)', 'Sprays (chemicals)', 'Fertiliser', 'Labour', 'Water', 'Shade net and structures', 'Transport', 'Other'];
const ACT_COST_CAT = { spray: 'Sprays (chemicals)', fertilise: 'Fertiliser and manure', irrigate: 'Water and irrigation', weed: 'Labour', stake: 'Labour', prune: 'Labour', harvest: 'Labour', scout: 'Other', other: 'Other' };
const saleTotal = s => num(s.total != null ? s.total : num(s.qty) * num(s.price));
const salePaid = s => s.pay === 'credit' ? num(s.paid) : (s.paid != null && s.paid !== '' ? num(s.paid) : saleTotal(s));
// each side keeps its own books: a record belongs to the side it was made on
const sideOf = r => r.side || (r.batch ? 'propagator' : 'farmer');
const mine = r => sideOf(r) === (isProp() ? 'propagator' : 'farmer');
const myExp = () => D.expenses.filter(mine);
function incomeRows() {   // every shilling earned: sales, plus seedling orders collected
  if (!isProp()) return D.sales.filter(mine).map(s => ({ date: s.date, amt: saleTotal(s), pid: s.pid, s }));
  const rows = D.sales.filter(mine).map(s => ({ date: s.date, amt: saleTotal(s), pid: s.pid, batch: s.batch, what: s.what || '', s }));
  D.orders.filter(o => o.status === 'collected').forEach(o => rows.push({ date: o.collected || o.date, amt: num(o.qty) * num(o.price), batch: o.batch, what: 'Order - ' + o.name, o }));
  return rows;
}
function owed() {
  const r = [];
  D.sales.filter(s => mine(s) || s.ent).forEach(s => { const b = saleTotal(s) - salePaid(s); if (b > 0.5) r.push({ who: s.buyer || 'Buyer', phone: s.phone, amt: b, date: s.date, s }); });
  if (isProp()) D.orders.filter(o => o.status === 'collected').forEach(o => { const b = num(o.qty) * num(o.price) - num(o.paid); if (b > 0.5) r.push({ who: o.name, phone: o.phone, amt: b, date: o.collected || o.date, o }); });
  return r.sort((a, b) => b.amt - a.amt);
}

// ---------------- UI helpers ----------------
function toast(msg, ms) { let t = $('toast'); if (t) t.remove(); t = document.createElement('div'); t.id = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms || 2600); }
let sheetStack = [];
function sheet(title, body, opts) {
  const ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = '<div class="sheet" role="dialog"><div class="grab"></div><h3>' + title + '<button class="x" aria-label="Close">✕</button></h3><div class="sb">' + body + '</div></div>';
  ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('.x')) closeSheet(); });
  document.body.appendChild(ov); sheetStack.push(ov); history.pushState({ sheet: sheetStack.length }, '');
  (opts && opts.onOpen) && opts.onOpen(ov);
  const f = ov.querySelector('input:not([type=hidden]):not([type=file]):not([readonly]), select'); if (f && !(opts && opts.noFocus) && matchMedia('(pointer:fine)').matches) f.focus();
  return ov;
}
function closeSheet(fromPop, target) {
  const i = target ? sheetStack.indexOf(target) : sheetStack.length - 1; if (i < 0) return;
  const ov = sheetStack.splice(i, 1)[0]; ov.remove();
  if (!fromPop) { ignorePop++; history.back(); }
  if (!sheetStack.length && pendingReload) location.reload();
}
const closeAll = () => { while (sheetStack.length) closeSheet(); };
let ignorePop = 0;
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop--; return; }
  if (sheetStack.length) { closeSheet(true); return; }
  if (S.view) { S.view = null; render(); }
});
function ask(msg, yes, no, danger) {
  return new Promise(res => {
    const ov = sheet('Please confirm', '<p style="margin:0 0 16px">' + msg + '</p><div class="btns"><button class="btn ' + (danger ? 'bad' : 'pri') + '" id="askYes">' + (yes || 'Yes') + '</button><button class="btn" id="askNo">' + (no || 'Cancel') + '</button></div>', { noFocus: true });
    let done = false; const fin = v => { if (done) return; done = true; closeSheet(false, ov); res(v); };
    ov.querySelector('#askYes').onclick = () => fin(true); ov.querySelector('#askNo').onclick = () => fin(false);
    const mo = new MutationObserver(() => { if (!document.body.contains(ov)) { mo.disconnect(); if (!done) { done = true; res(false); } } }); mo.observe(document.body, { childList: true });
  });
}
// forms: [{k, l (label), t (type), o (options), v (value), req, hint, ph, step, show}]
function fieldHtml(f) {
  const id = 'f_' + f.k, v = f.v == null ? '' : f.v;
  if (f.t === 'hidden') return '<input type="hidden" id="' + id + '" value="' + esc(v) + '">';
  if (f.t === 'html') return '<div id="' + id + '">' + f.html + '</div>';
  let inp;
  if (f.t === 'select') inp = '<select id="' + id + '">' + f.o.map(o => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return '<option value="' + esc(val) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + esc(lab) + '</option>'; }).join('') + '</select>';
  else if (f.t === 'area') inp = '<textarea id="' + id + '" placeholder="' + esc(f.ph || '') + '">' + esc(v) + '</textarea>';
  else inp = '<input id="' + id + '" type="' + (f.t === 'num' ? 'text' : f.t || 'text') + '"' + (f.t === 'num' ? ' inputmode="decimal"' : '') + (f.t === 'tel' ? ' inputmode="tel"' : '') + (f.list ? ' list="' + id + '_l"' : '') + ' value="' + esc(v) + '" placeholder="' + esc(f.ph || '') + '" autocomplete="off">' + (f.list ? '<datalist id="' + id + '_l">' + f.list.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>' : '');
  return '<label class="fld" id="w_' + f.k + '"><span>' + esc(f.l) + (f.req ? ' *' : '') + '</span>' + inp + (f.hint != null ? '<div class="hint" id="h_' + f.k + '">' + f.hint + '</div>' : '') + '</label>';
}
function form(title, fields, onSave, opts) {
  opts = opts || {};
  const body = (opts.top || '') + fields.map(fieldHtml).join('') + '<div id="formMsg"></div><div class="btns actions"><button class="btn pri" id="fSave" style="flex:1">' + (opts.save || 'Save') + '</button>' + (opts.del ? '<button class="btn bad" id="fDel">Delete</button>' : '') + '</div>';
  const ov = sheet(title, body, { noFocus: opts.noFocus });
  const val = () => { const o = {}; fields.forEach(f => { const e = $('f_' + f.k); if (!e) return; o[f.k] = f.t === 'num' ? (e.value.trim() === '' ? '' : num(e.value)) : e.value.trim(); }); return o; };
  ov.querySelector('#fSave').onclick = async () => {
    const o = val(); let bad = false;
    fields.forEach(f => { const w = $('w_' + f.k); if (!w) return; const miss = f.req && (o[f.k] === '' || o[f.k] == null); w.classList.toggle('err', !!miss); if (miss) bad = true; });
    if (bad) { $('formMsg').innerHTML = '<div class="note bad">Please fill in the parts marked *</div>'; return; }
    const btn = ov.querySelector('#fSave'); btn.disabled = true;
    try { const r = await onSave(o, ov); if (r === false) { btn.disabled = false; return; } closeSheet(false, ov); render(); } catch (e) { btn.disabled = false; $('formMsg').innerHTML = '<div class="note bad">' + esc(e.message || e) + '</div>'; }
  };
  if (opts.del) ov.querySelector('#fDel').onclick = async () => { if (await ask('Delete this record? This cannot be undone.', 'Delete', 'Keep', true)) { try { await opts.del(); } catch (e) { return; } closeSheet(false, ov); render(); toast('Deleted'); } };
  opts.onOpen && opts.onOpen(ov, val);
  return ov;
}
const on = (ov, sel, ev, f) => { const e = ov.querySelector(sel); e && e.addEventListener(ev, f); };
function waLink(phone, text) {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1); else if (/^\+/.test(p)) p = p.slice(1); else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return 'https://wa.me/' + (p ? p : '') + '?text=' + encodeURIComponent(text);
}
const emptyBox = (em, t, s, btn) => '<div class="card empty"><div class="em">' + em + '</div><div class="t">' + t + '</div><div class="s" style="margin:4px 0 12px">' + s + '</div>' + (btn || '') + '</div>';

// ---------------- navigation ----------------
const S = { tab: 'today', view: null, moneyP: 'month', dx: null };
const FARMER_TABS = [['today', '🏡', 'Today'], ['crops', '🌱', 'My crops'], ['doctor', '🩺', 'Plant doctor'], ['money', '💰', 'Money'], ['more', '☰', 'More']];
const PROP_TABS = [['today', '🏡', 'Today'], ['batches', '🌱', 'Seedlings'], ['orders', '📥', 'Orders'], ['money', '💰', 'Money'], ['more', '☰', 'More']];
function tabsNow() {
  if (isProp()) return hasAnimals() ? PROP_TABS.slice(0, 3).concat([['animals', '🐄', 'Animals']], PROP_TABS.slice(3)) : PROP_TABS;
  const a = hasAnimals(), c = hasEnt('crops'), t = [FARMER_TABS[0]];
  if (c) t.push(FARMER_TABS[1]);
  if (a) t.push(['animals', '🐄', 'Animals']);
  if (!(a && c)) t.push(FARMER_TABS[2]);
  return t.concat(FARMER_TABS.slice(3));
}
function go(tab) { S.tab = tab; S.view = null; render(); window.scrollTo(0, 0); }
function openView(v) { S.view = v; history.pushState({ view: 1 }, ''); render(); window.scrollTo(0, 0); }
function back() { history.back(); }
function render() {
  if (LOCKED && K.lock) { $('top').classList.add('hide'); $('tabs').classList.add('hide'); $('backBtn').classList.add('hide'); $('main').innerHTML = lockHtml(); return; }
  if (!K.profile) { $('top').classList.add('hide'); $('tabs').classList.add('hide'); $('main').innerHTML = welcomeHtml(); return; }
  const tabs = tabsNow();
  if (S.tab !== 'doctor' && !tabs.some(t => t[0] === S.tab)) S.tab = 'today';
  $('top').classList.remove('hide'); $('tabs').classList.remove('hide');
  const badge = isProp() ? D.orders.filter(o => o.status === 'pending').length : 0;
  $('tabs').innerHTML = tabs.map(t => '<button data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '"><i>' + t[1] + '</i>' + t[2] + (t[0] === 'orders' && badge ? '<span class="dot">' + badge + '</span>' : '') + '</button>').join('');
  $('roleBtn').textContent = isProp() ? '🌱 Propagator' : '🧑‍🌾 Farmer';
  let title = 'Farm on the Go', html;
  const v = S.view;
  try {
    if (v) { const r = VIEWS[v.t](v); title = r[0]; html = r[1]; }
    else { const r = TABS[S.tab](); title = r[0]; html = r[1]; }
  } catch (e) { console.error(e); html = '<div class="note bad">Something went wrong showing this screen: ' + esc(e.message) + '</div>'; }
  $('title').textContent = title; $('backBtn').classList.toggle('hide', !v);
  $('main').innerHTML = html;
}

// ================= welcome =================
let W = { role: null };
let LOCKED = false, PINBUF = '', PINERR = '';
function welcomeHtml() {
  const c = L.CROPS;
  return '<div class="welcome"><img class="logo" src="icons/icon-192-f1.png" alt=""><h1>Farm on the Go</h1><p class="lead">Plan, record and sell - on your phone, even with no internet.</p>' +
    '<h2>Who are you?</h2>' +
    '<button class="rolecard ' + (W.role === 'farmer' ? 'on' : '') + '" onclick="A.wRole(\'farmer\')"><i>🧑‍🌾</i><div><b>I am a farmer</b><span class="s">Crop calendars, dairy and poultry records, sales and profit, and a plant doctor.</span></div></button>' +
    '<button class="rolecard ' + (W.role === 'propagator' ? 'on' : '') + '" onclick="A.wRole(\'propagator\')"><i>🌱</i><div><b>I am a propagator</b><span class="s">Seedling batches with ready dates, stock that is ready or about to be, and farmers\' orders to accept or decline.</span></div></button>' +
    (W.role ? '<h2>About you</h2><div class="card">' +
      fieldHtml({ k: 'w_name', l: 'Your name', req: 1, ph: 'e.g. Jane Wanjiku' }) +
      fieldHtml({ k: 'w_farm', l: W.role === 'farmer' ? 'Farm name' : 'Nursery name', ph: W.role === 'farmer' ? 'e.g. Wanjiku Farm' : 'e.g. Green Seedlings Nursery' }) +
      fieldHtml({ k: 'w_county', l: 'County / area', ph: 'e.g. Kirinyaga' }) +
      fieldHtml({ k: 'w_phone', l: 'Phone (for WhatsApp)', t: 'tel', ph: '07..' }) +
      '<div class="fld"><span>' + (W.role === 'farmer' ? 'What do you grow?' : 'What seedlings do you raise?') + ' (tap all that apply)</span><div class="chips" id="wCrops">' +
      c.map(x => '<button class="chip" data-c="' + x.id + '" onclick="this.classList.toggle(\'on\')">' + x.e + ' ' + esc(x.n) + '</button>').join('') + '</div></div>' +
      '<div class="fld"><span>Do you also keep? (tap all that apply)</span><div class="chips" id="wEnts"><button class="chip" data-e="dairy" onclick="this.classList.toggle(\'on\')">🐄 Dairy cows</button><button class="chip" data-e="poultry" onclick="this.classList.toggle(\'on\')">🐔 Poultry</button><button class="chip" data-e="'+(W.role === 'farmer' ? 'nursery' : 'crops')+'" onclick="this.classList.toggle(\'on\')">'+(W.role === 'farmer' ? '🌿 A seedling nursery' : '🌱 Crops')+'</button></div></div><div id="wMsg"></div><button class="btn pri wide" onclick="A.wDone()">Start</button></div>' : '') +
    '<p class="xs" style="text-align:center;margin-top:24px">Your records stay on this phone. Make a backup from More → Backup now and then.</p></div>';
}

// ================= farmer: today =================
function todayFarmer() {
  const t0 = today(), pl = activePlantings();
  let tasks = []; pl.forEach(p => { tasks = tasks.concat(openTasks(p, 7)); });
  const over = tasks.filter(t => t.due < t0), now = tasks.filter(t => t.due === t0), soon = tasks.filter(t => t.due > t0);
  const so = D.sorders.filter(o => o.status === 'waiting' || o.status === 'ready');
  const phis = pl.map(p => ({ p, f: phiUntil(p.id) })).filter(x => x.f);
  const ow = owed(), mon = monthKey(t0);
  const inc = incomeRows().filter(r => monthKey(r.date) === mon).reduce((s, r) => s + r.amt, 0), cost = myExp().filter(e => monthKey(e.date) === mon).reduce((s, e) => s + num(e.amount), 0);
  let h = '<div class="row" style="margin:2px 2px 14px"><div class="grow"><div class="big">' + greet() + (prof().name ? ', ' + esc(prof().name.split(' ')[0]) : '') + '</div><div class="s">' + fmtD(t0) + (prof().farm ? ' · ' + esc(prof().farm) : '') + '</div></div></div>';
  h += '<div class="quick">' + (hasEnt('crops') ? '<button onclick="A.newPlanting()"><i>🌱</i>Planting</button>' : '') + '<button onclick="A.newAct()"><i>🧴</i>Spray / feed</button><button onclick="A.newSale()"><i>🧾</i>Sale</button><button onclick="A.newExpense()"><i>💸</i>Expense</button></div>';
  h += animalsToday();
  h += '<div class="grid3" style="margin-top:12px"><div class="stat"><div class="s">Sales this month</div><div class="v pos">' + ksh(inc) + '</div></div><div class="stat"><div class="s">Costs this month</div><div class="v">' + ksh(cost) + '</div></div><div class="stat"><div class="s">Profit</div><div class="v ' + (inc - cost >= 0 ? 'pos' : 'neg') + '">' + ksh(inc - cost) + '</div></div></div>';
  if (!pl.length && hasEnt('crops')) h += '<h2>Get started</h2>' + emptyBox('🌱', 'Add your first planting', 'Pick the crop and the planting date - the app builds its calendar: feeding, sprays, scouting and when to expect the harvest.', '<button class="btn pri" onclick="A.newPlanting()">+ New planting</button>');
  phis.forEach(x => { h += '<div class="note bad"><b>⚠️ Do not harvest ' + esc(cropName(x.p)) + ' before ' + fmtD(x.f.until) + '</b><br><span class="s">Waiting period (PHI) after spraying ' + esc(x.f.prod || '') + '.</span></div>'; });
  if (over.length || now.length) h += '<h2>To do today</h2><div class="card">' + over.concat(now).map(taskRow).join('') + '</div>';
  else if (pl.length) h += '<h2>To do today</h2><div class="card"><div class="row"><div class="em">✅</div><div class="grow"><div class="t">Nothing due today</div><div class="s">Scout your crops and record anything you do.</div></div></div></div>';
  if (soon.length) h += '<h2>Coming up this week</h2><div class="card">' + soon.slice(0, 12).map(taskRow).join('') + (soon.length > 12 ? '<div class="xs" style="padding-top:8px">+ ' + (soon.length - 12) + ' more - see each crop</div>' : '') + '</div>';
  if (so.length) h += '<h2>Seedlings ordered</h2><div class="card list">' + so.map(o => { const n = dd(t0, o.ready); return '<div class="li"><div class="em">' + cropEm(o.crop) + '</div><div class="grow"><div class="t">' + plural(num(o.qty), 'seedling') + ' · ' + esc(crop(o.crop).n) + (o.variety ? ' ' + esc(o.variety) : '') + '</div><div class="s">' + esc(o.nursery || 'Nursery') + ' · ' + (n > 0 ? 'ready ' + rel(o.ready) + ' (' + fmtD(o.ready) + ')' : '<b class="pos">ready now - collect and plant</b>') + '</div></div>' + (n <= 0 ? '<button class="btn sm ok" onclick="A.plantFromOrder(\'' + o.id + '\')">Plant</button>' : '<span class="pill b">' + n + ' d</span>') + '</div>'; }).join('') + '</div>';
  if (ow.length) h += '<h2>Who owes you</h2><div class="card list">' + ow.slice(0, 5).map(owRow).join('') + '</div>';
  if (pl.length) h += '<h2>My crops</h2>' + pl.slice(0, 4).map(plantingCard).join('') + (pl.length > 4 ? '<button class="btn wide" onclick="A.go(\'crops\')">All ' + pl.length + ' plantings</button>' : '');
  return ['Today', h];
}
function greet() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
function taskRow(t) {
  const st = taskState(t), late = !st && t.due < today();
  return '<div class="task' + (st ? ' done' : '') + '"><div class="ic">' + ttIcon(t.type) + '</div><div class="grow"><div class="t">' + esc(t.t) + '</div><div class="s">' + esc(cropName(t.p)) + (t.p.field && byId('fields', t.p.field) ? ' · ' + esc(byId('fields', t.p.field).name) : '') + ' · day ' + t.day + ' · ' + (late ? '<b class="neg">' + rel(t.due) + '</b>' : rel(t.due)) + '</div><div class="xs">' + esc(t.x) + '</div></div>' +
    (st ? '<span class="pill ' + (st === 'skip' ? '' : 'g') + '">' + (st === 'skip' ? 'Skipped' : 'Done') + '</span>' : '<div class="btns" style="flex-direction:column;gap:5px"><button class="btn sm ok" onclick="A.taskDone(\'' + t.p.id + '\',\'' + t.key + '\')">Done</button><button class="btn sm" onclick="A.taskSkip(\'' + t.p.id + '\',\'' + t.key + '\')">Skip</button></div>') + '</div>';
}
function owRow(x) { return '<div class="li"><div class="em">🤝</div><div class="grow"><div class="t">' + esc(x.who) + '</div><div class="s">since ' + fmtD(x.date) + '</div></div><b class="neg">' + ksh(x.amt) + '</b><button class="btn sm" onclick="A.payIn(\'' + (x.s ? 's' : 'o') + '\',\'' + (x.s || x.o).id + '\')">Paid</button></div>'; }
function plantingCard(p) {
  const c = crop(p.crop), st = stageOf(p), a = age(p), fh = addD(p.date, c.first), lh = addD(p.date, c.last), n = openTasks(p, 0).length;
  const pct = c.last ? Math.max(0, Math.min(100, a / c.last * 100)) : 0;
  return '<div class="card tap" onclick="A.openP(\'' + p.id + '\')"><div class="row"><div class="em">' + cropEm(p.crop) + '</div><div class="grow"><div class="t">' + esc(pName(p)) + '</div><div class="s">' + (a >= 0 ? 'Day ' + a + ' · ' : '') + esc(st.name) + '</div></div>' + (n ? '<span class="pill a">' + n + ' to do</span>' : p.status === 'ended' ? '<span class="pill">Ended</span>' : '') + '</div>' +
    (p.crop !== 'other' && c.last ? '<div class="bar" style="margin-top:10px"><div style="width:' + pct + '%;background:' + (st.over ? 'var(--red)' : 'var(--green)') + '"></div></div><div class="xs" style="margin-top:4px">' + (a < c.first ? 'First harvest about ' + fmtD(fh) + ' (' + rel(fh) + ')' : a <= c.last ? 'Harvest window until about ' + fmtD(lh) : 'Expected harvest ended ' + fmtD(lh)) + '</div>' : '') + '</div>';
}

// ================= farmer: crops =================
function cropsTab() {
  const pl = activePlantings(), ended = D.plantings.filter(p => p.status === 'ended');
  let h = '<div class="btns" style="margin-bottom:12px"><button class="btn pri" style="flex:1" onclick="A.newPlanting()">+ New planting</button><button class="btn" onclick="A.fields()">🗺️ Fields</button><button class="btn" onclick="A.seedOrders()">🌱 Seedlings</button></div>';
  if (!pl.length) h += emptyBox('🌱', 'No crops in the ground yet', 'Add a planting to get its calendar, reminders and records.');
  const groups = {}; pl.forEach(p => { const f = (p.field && byId('fields', p.field)) ? byId('fields', p.field).name : 'No field set'; (groups[f] = groups[f] || []).push(p); });
  Object.keys(groups).sort().forEach(g => { h += '<h2>' + esc(g) + '</h2><div class="grid-md">' + groups[g].map(plantingCard).join('') + '</div>'; });
  if (ended.length) h += '<h2>Ended plantings</h2>' + ended.sort((a, b) => a.date < b.date ? 1 : -1).map(p => { const pl2 = plP(p.id); return '<div class="card tap" onclick="A.openP(\'' + p.id + '\')"><div class="row"><div class="em">' + cropEm(p.crop) + '</div><div class="grow"><div class="t">' + esc(pName(p)) + '</div><div class="s">' + fmtD(p.date) + ' - ' + fmtD(p.ended || p.date) + '</div></div><b class="' + (pl2.profit >= 0 ? 'pos' : 'neg') + '">' + ksh(pl2.profit) + '</b></div></div>'; }).join('');
  return ['My crops', h];
}
function plP(pid) {
  const inc = D.sales.filter(s => s.pid === pid).reduce((s, x) => s + saleTotal(x), 0), cost = D.expenses.filter(e => e.pid === pid).reduce((s, e) => s + num(e.amount), 0);
  const har = D.harvests.filter(h => h.pid === pid); return { inc, cost, profit: inc - cost, har };
}
const VIEWS = {};
VIEWS.planting = v => {
  const p = byId('plantings', v.id); if (!p) return ['Planting', '<div class="note">This planting was deleted.</div>'];
  const c = crop(p.crop), a = age(p), st = stageOf(p), tab = v.tab || 'plan', ph = phiUntil(p.id), m = plP(p.id);
  let h = '<div class="card"><div class="row"><div class="em">' + cropEm(p.crop) + '</div><div class="grow"><div class="t">' + esc(cropName(p)) + (p.variety ? ' · ' + esc(p.variety) : '') + '</div><div class="s">' + (p.field && byId('fields', p.field) ? esc(byId('fields', p.field).name) + ' · ' : '') + (p.plants ? fmtN(p.plants) + ' plants · ' : '') + (p.area ? fmtN(p.area) + ' acre · ' : '') + (c.grow === 'nursery' || p.how === 'transplant' ? 'transplanted ' : 'planted ') + fmtD(p.date) + '</div></div><button class="btn sm" onclick="A.editPlanting(\'' + p.id + '\')">Edit</button></div>';
  if (p.crop !== 'other' && c.stages.length) {
    const span = c.perennial ? Math.min(c.last, Math.max(c.first + 365, a + 60)) : c.last, cols = ['#7fc8a0', '#9bd27a', '#e8c35a', '#f0a45a', '#e88a6a', '#c39be8'];
    h += '<div class="timeline">' + c.stages.map((s, i) => { const w = Math.max(0, Math.min(s[2], span) - Math.max(s[1], i ? c.stages[i - 1][2] : 0)); return w > 0 ? '<div style="flex:' + w + ';background:' + cols[i % cols.length] + '" title="' + esc(s[0]) + '">' + (w / span > .16 ? esc(s[0].split(' ')[0]) : '') + '</div>' : ''; }).join('') + (a >= 0 && a <= span ? '<span class="now" style="left:calc(' + (a / span * 100) + '% - 1px)"></span>' : '') + '</div>';
    h += '<div class="row"><div class="grow"><b>' + (a >= 0 ? 'Day ' + a : 'Not planted yet') + '</b> · ' + esc(st.name) + '</div><span class="xs">' + (a < c.first ? 'harvest ~' + fmtD(addD(p.date, c.first)) : a <= c.last ? 'harvesting' : '') + '</span></div>';
  }
  h += '</div>';
  if (ph) h += '<div class="note bad"><b>⚠️ Do not harvest before ' + fmtD(ph.until) + '</b> - waiting period (PHI) after ' + esc(ph.prod) + '.</div>';
  if (st.over && p.status !== 'ended') h += '<div class="note warn">This crop is past its usual harvest end. <button class="btn sm" onclick="A.endPlanting(\'' + p.id + '\')">End planting</button></div>';
  h += '<div class="quick"><button onclick="A.newAct(\'' + p.id + '\')"><i>🧴</i>Activity</button><button onclick="A.newHarvest(\'' + p.id + '\')"><i>🧺</i>Harvest</button><button onclick="A.newSale(\'' + p.id + '\')"><i>🧾</i>Sale</button><button onclick="A.newExpense(\'' + p.id + '\')"><i>💸</i>Expense</button></div>';
  h += '<div class="grid3" style="margin-top:10px"><div class="stat"><div class="s">Sales</div><div class="v pos">' + ksh(m.inc) + '</div></div><div class="stat"><div class="s">Costs</div><div class="v">' + ksh(m.cost) + '</div></div><div class="stat"><div class="s">Profit</div><div class="v ' + (m.profit >= 0 ? 'pos' : 'neg') + '">' + ksh(m.profit) + '</div></div></div>';
  h += '<div class="seg" style="margin:14px 0 10px">' + [['plan', 'Calendar'], ['rec', 'Records'], ['money', 'Money'], ['care', 'Problems']].map(t => '<button class="' + (tab === t[0] ? 'on' : '') + '" onclick="A.pTab(\'' + t[0] + '\')">' + t[1] + '</button>').join('') + '</div>';
  if (tab === 'plan') {
    const all = tasksOf(p), t0 = today();
    const open = openTasks(p, 0), next = all.filter(t => !taskState(t) && t.due > t0).slice(0, 15), done = all.filter(t => taskState(t)).slice(-8).reverse();
    if (p.crop === 'other') h += '<div class="note">A crop that is not in the library has no ready-made calendar. Add your own reminders below.</div>';
    h += '<div class="card">' + (open.length ? open.map(taskRow).join('') : '<div class="s">Nothing due now.</div>') + '</div>';
    if (next.length) h += '<h2>Next</h2><div class="card">' + next.map(taskRow).join('') + '</div>';
    h += '<button class="btn wide" onclick="A.addReminder(\'' + p.id + '\')">+ Add my own reminder</button>';
    if (done.length) h += '<h2>Done lately</h2><div class="card">' + done.map(taskRow).join('') + '</div>';
    if (c.level === 'managed') h += '<div class="note" style="margin-top:12px">💡 The spray dates are a protective programme. In the rains, spray every 7 days; in dry weather, every 10-14 days. Spray against pests only when scouting finds them. Always use a PCPB-registered product at the label rate, and respect its waiting period before harvest.</div>';
  } else if (tab === 'rec') {
    const acts = D.acts.filter(x => x.pid === p.id).map(x => ({ d: x.date, h: actRow(x) })), hv = D.harvests.filter(x => x.pid === p.id).map(x => ({ d: x.date, h: '<div class="li"><div class="em">🧺</div><div class="grow"><div class="t">Harvest: ' + fmtN(num(x.qty)) + ' ' + esc(x.unit) + (x.grade ? ' · ' + esc(x.grade) : '') + '</div><div class="s">' + fmtD(x.date) + (x.notes ? ' · ' + esc(x.notes) : '') + '</div></div><button class="btn sm" onclick="A.editHarvest(\'' + x.id + '\')">Edit</button></div>' }));
    const rows = acts.concat(hv).sort((a, b) => a.d < b.d ? 1 : -1);
    const tot = {}; D.harvests.filter(x => x.pid === p.id).forEach(x => { tot[x.unit] = (tot[x.unit] || 0) + num(x.qty); });
    if (Object.keys(tot).length) h += '<div class="note good">Harvested so far: <b>' + Object.keys(tot).map(u => fmtN(tot[u]) + ' ' + esc(u)).join(', ') + '</b></div>';
    h += rows.length ? '<div class="card list">' + rows.map(r => r.h).join('') + '</div>' : emptyBox('📒', 'No records yet', 'Record sprays, feeding, watering, scouting and harvests as you do them.');
  } else if (tab === 'money') {
    const ss = D.sales.filter(s => s.pid === p.id).sort((a, b) => a.date < b.date ? 1 : -1), ee = D.expenses.filter(e => e.pid === p.id).sort((a, b) => a.date < b.date ? 1 : -1);
    const hq = {}; m.har.forEach(x => { hq[x.unit] = (hq[x.unit] || 0) + num(x.qty); }); const mu = Object.keys(hq).sort((a, b) => hq[b] - hq[a])[0];
    if (mu && m.cost) h += '<div class="note">Cost per ' + esc(mu) + ' harvested: <b>' + ksh(m.cost / hq[mu]) + '</b> (' + fmtN(hq[mu]) + ' ' + esc(mu) + ' so far)</div>';
    h += '<h2>Sales</h2>' + (ss.length ? '<div class="card list">' + ss.map(saleRow).join('') + '</div>' : '<div class="card s">No sales yet.</div>');
    h += '<h2>Costs</h2>' + (ee.length ? '<div class="card list">' + ee.map(expRow).join('') + '</div>' : '<div class="card s">No costs yet.</div>');
  } else {
    h += '<button class="btn pri wide" style="margin-bottom:10px" onclick="A.doctorFor(\'' + p.id + '\')">🩺 Check a sick plant</button>';
    h += (c.problems || []).map(id => probCard(id, true)).join('') || '<div class="card s">No problems listed for this crop.</div>';
  }
  h += '<div class="btns" style="margin-top:16px">' + (p.status === 'ended' ? '<button class="btn" onclick="A.reopenPlanting(\'' + p.id + '\')">Reopen planting</button>' : '<button class="btn" onclick="A.endPlanting(\'' + p.id + '\')">End this planting</button>') + '</div>';
  return [cropName(p), h];
};
function actRow(x) { return '<div class="li"><div class="em">' + ttIcon(x.type) + '</div><div class="grow"><div class="t">' + esc(x.title || ttName(x.type)) + '</div><div class="s">' + fmtD(x.date) + (x.product ? ' · ' + esc(x.product) : '') + (x.rate ? ' · ' + esc(x.rate) : '') + (num(x.phi) ? ' · PHI ' + num(x.phi) + ' d' : '') + (num(x.cost) ? ' · ' + ksh(num(x.cost)) : '') + '</div>' + (x.notes ? '<div class="xs">' + esc(x.notes) + '</div>' : '') + '</div><button class="btn sm" onclick="A.editAct(\'' + x.id + '\')">Edit</button></div>'; }
function saleRow(s) { const bal = saleTotal(s) - salePaid(s); return '<div class="li"><div class="em">🧾</div><div class="grow"><div class="t">' + (s.qty ? fmtN(num(s.qty)) + ' ' + esc(s.unit || '') + ' · ' : '') + esc(s.buyer || 'Sale') + '</div><div class="s">' + fmtD(s.date) + ' · ' + esc({ cash: 'Cash', mpesa: 'M-Pesa', credit: 'Credit', bank: 'Bank' }[s.pay] || s.pay || '') + (bal > 0.5 ? ' · <b class="neg">owes ' + ksh(bal) + '</b>' : '') + '</div></div><b class="pos">' + ksh(saleTotal(s)) + '</b><button class="btn sm" onclick="A.editSale(\'' + s.id + '\')">Edit</button></div>'; }
function expRow(e) { const p = e.pid && byId('plantings', e.pid), b = e.batch && byId('batches', e.batch); return '<div class="li"><div class="em">💸</div><div class="grow"><div class="t">' + esc(e.cat) + '</div><div class="s">' + fmtD(e.date) + (p ? ' · ' + esc(cropName(p)) : b ? ' · ' + esc(bName(b)) : '') + (e.notes ? ' · ' + esc(e.notes) : '') + '</div></div><b>' + ksh(num(e.amount)) + '</b><button class="btn sm" onclick="A.editExpense(\'' + e.id + '\')">Edit</button></div>'; }
function probCard(id, open) {
  const p = L.PROBLEMS[id]; if (!p) return '';
  return '<details class="card"' + (open === 'open' ? ' open' : '') + '><summary class="row" style="cursor:pointer;list-style:none"><div class="em">' + (p.k === 'pest' ? '🐛' : p.k === 'disorder' ? '⚗️' : '🦠') + '</div><div class="grow"><div class="t">' + esc(p.n) + '</div><div class="s">' + ({ pest: 'Pest', disease: 'Disease', disorder: 'Not a disease - a growing problem' }[p.k]) + '</div></div><span class="xs">▾</span></summary>' +
    '<div style="margin-top:10px"><div class="s"><b>How to recognise it:</b> ' + esc(p.see) + '</div><div class="s" style="margin-top:8px"><b>What to do:</b><ul class="tight">' + p.do.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div><div class="s" style="margin-top:8px"><b>Sprays (active ingredients):</b> ' + esc(p.ai) + '</div><div class="xs" style="margin-top:8px">Use only PCPB-registered products for this crop, at the label rate, and keep to the waiting period before harvest.</div></div></details>';
}

// ================= plant doctor =================
let DX = { crop: '', pid: '', sym: [], photo: null, small: null, ai: null, busy: false };
function doctorTab() {
  const pl = activePlantings(), crops = [...new Set(pl.map(p => p.crop).filter(c => c !== 'other'))];
  const opts = crops.concat(L.CROPS.map(c => c.id).filter(id => !crops.includes(id)));
  let h = '<div class="note">Take a clear photo of the sick leaf, fruit or stem in daylight, then tick what you see. The app lists the likely problems and what to do.</div>';
  h += '<div class="card"><div class="fld"><span>Which crop?</span><select id="dxCrop" onchange="A.dxCrop(this.value)"><option value="">Choose the crop…</option>' + opts.map(id => '<option value="' + id + '"' + (DX.crop === id ? ' selected' : '') + '>' + crop(id).e + ' ' + esc(crop(id).n) + '</option>').join('') + '</select></div>';
  h += DX.photo ? '<img class="photo" src="' + DX.photo + '" alt="Plant photo"><div class="btns" style="margin-top:8px"><button class="btn sm" onclick="A.dxPhoto()">📷 Retake</button><button class="btn sm" onclick="A.dxClearPhoto()">Remove photo</button></div>' : '<div class="camera" onclick="A.dxPhoto()"><i>📷</i><b>Take a photo</b><div class="s">or pick one from the gallery</div></div>';
  h += '<input type="file" id="dxFile" accept="image/*" capture="environment" class="hide" onchange="A.dxFile(this)"></div>';
  if (DX.crop) {
    const c = crop(DX.crop), syms = [...new Set((c.problems || []).flatMap(id => L.PROBLEMS[id].s))];
    h += '<h2>What do you see?</h2><div class="card"><div class="chips">' + syms.map(s => '<button class="chip ' + (DX.sym.includes(s) ? 'on' : '') + '" onclick="A.dxSym(\'' + s + '\')">' + esc(L.SYMPTOMS[s]) + '</button>').join('') + '</div></div>';
    const r = rankProblems(DX.crop, DX.sym);
    if (DX.ai) h += aiResultHtml(DX.ai);
    h += '<div class="card" style="border-color:var(--purple)"><div class="row"><div class="em">✨</div><div class="grow"><div class="t">AI photo check</div><div class="s">' + (aiReady() ? 'Sends the photo to the DukaGO plant doctor for a second opinion. Needs internet.' : 'Coming with the online version of Farm on the Go. Your photo is saved with this check so it can be looked at then.') + '</div></div></div>' + (aiReady() ? '<button class="btn wide" style="margin-top:10px" ' + (DX.photo && !DX.busy ? '' : 'disabled') + ' onclick="A.dxAI()">' + (DX.busy ? 'Checking…' : DX.photo ? '✨ Check the photo with AI' : 'Take a photo first') + '</button>' : '') + '</div>';
    if (DX.sym.length) {
      h += '<h2>Likely problems</h2>' + (r.length ? r.slice(0, 4).map((x, i) => '<div class="card"><div class="row"><div class="grow"><div class="t">' + (i + 1) + '. ' + esc(x.p.n) + '</div><div class="s">' + x.hit + ' of your ' + DX.sym.length + ' signs match · ' + x.label + '</div></div></div><div class="match"><div style="width:' + Math.round(x.score * 100) + '%;background:' + (x.score >= .7 ? 'var(--red)' : x.score >= .45 ? 'var(--accent)' : 'var(--muted)') + '"></div></div>' + probCard(x.id, i === 0 ? 'open' : '').replace('<details class="card"', '<details style="margin-top:8px"') + '</div>').join('') : '<div class="card s">None of the common problems of ' + esc(c.n) + ' match these signs. Ask an agronomist or the county extension officer.</div>');
      h += '<button class="btn pri wide" onclick="A.dxSave()">Save this check</button>';
    } else h += '<div class="s" style="margin:4px 2px 12px">Tick the signs you see to get the likely problems.</div>';
    h += '<div class="note warn" style="margin-top:12px">This is a guide, not a lab test. Several problems look alike - if a large part of the crop is affected, show the plant to an agronomist or the county agricultural officer before spending on sprays.</div>';
  }
  const hist = D.dx.slice().sort((a, b) => a.date < b.date ? 1 : -1);
  if (hist.length) h += '<h2>Past checks</h2><div class="card list">' + hist.slice(0, 20).map(x => '<div class="li">' + (x.photo ? '<img class="thumb" src="' + x.photo + '" alt="">' : '<div class="em">🩺</div>') + '<div class="grow"><div class="t">' + esc(crop(x.crop).n) + ': ' + esc(x.top || 'not sure') + '</div><div class="s">' + fmtD(x.date) + (x.ai ? ' · AI: ' + esc(x.ai.name) : '') + '</div></div><button class="btn sm" onclick="A.dxDel(\'' + x.id + '\')">✕</button></div>').join('') + '</div>';
  return ['Plant doctor', h];
}
function rankProblems(cid, sel) {
  if (!sel.length) return [];
  return (crop(cid).problems || []).map(id => { const p = L.PROBLEMS[id], hit = p.s.filter(s => sel.includes(s)).length; if (!hit) return null; const score = 0.6 * hit / sel.length + 0.4 * hit / p.s.length; return { id, p, hit, score, label: score >= .7 ? 'strong match' : score >= .45 ? 'possible' : 'weak match' }; }).filter(Boolean).sort((a, b) => b.score - a.score || b.hit - a.hit);
}
const aiReady = () => !!(K.server && K.server.url);
function aiResultHtml(r) {
  if (r.error) return '<div class="note bad">AI check: ' + esc(r.error) + '</div>';
  return '<div class="card" style="border-color:var(--purple)"><div class="row"><div class="em">✨</div><div class="grow"><div class="t">AI: ' + esc(r.name || 'Not sure') + '</div><div class="s">' + esc(r.kind || '') + (r.confidence ? ' · ' + esc(r.confidence) + ' confidence' : '') + '</div></div></div>' + (r.signs ? '<div class="s" style="margin-top:8px">' + esc(r.signs) + '</div>' : '') + (r.actions && r.actions.length ? '<ul class="tight s">' + r.actions.map(a => '<li>' + esc(a) + '</li>').join('') + '</ul>' : '') + (r.sprays ? '<div class="s"><b>Sprays:</b> ' + esc(r.sprays) + '</div>' : '') + (r.note ? '<div class="xs" style="margin-top:6px">' + esc(r.note) + '</div>' : '') + '</div>';
}
function shrink(file, max, q) {
  return new Promise((res, rej) => { const img = new Image(), url = URL.createObjectURL(file); img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)), cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); res(cv.toDataURL('image/jpeg', q)); }; img.onerror = () => rej(new Error('That file is not a photo')); img.src = url; });
}

// ================= money =================
function periodRange(p) {
  const t = pd(today()), y = t.getFullYear(), m = t.getMonth();
  if (p === 'month') return [ds(new Date(y, m, 1)), ds(new Date(y, m + 1, 0)), 'This month'];
  if (p === 'last') return [ds(new Date(y, m - 1, 1)), ds(new Date(y, m, 0)), 'Last month'];
  if (p === 'year') return [y + '-01-01', y + '-12-31', 'This year'];
  return ['0000-01-01', '9999-12-31', 'All time'];
}
function moneyTab() {
  const [a, b, lab] = periodRange(S.moneyP), inR = d => d >= a && d <= b, prop = isProp();
  const inc = incomeRows().filter(r => inR(r.date)), ex = myExp().filter(e => inR(e.date));
  const ti = inc.reduce((s, r) => s + r.amt, 0), tc = ex.reduce((s, e) => s + num(e.amount), 0), ow = owed();
  let h = '<div class="seg" style="margin-bottom:12px">' + [['month', 'This month'], ['last', 'Last month'], ['year', 'This year'], ['all', 'All']].map(x => '<button class="' + (S.moneyP === x[0] ? 'on' : '') + '" onclick="A.moneyP(\'' + x[0] + '\')">' + x[1] + '</button>').join('') + '</div>';
  h += '<div class="grid3"><div class="stat"><div class="s">Income</div><div class="v pos">' + ksh(ti) + '</div></div><div class="stat"><div class="s">Costs</div><div class="v">' + ksh(tc) + '</div></div><div class="stat"><div class="s">Profit</div><div class="v ' + (ti - tc >= 0 ? 'pos' : 'neg') + '">' + ksh(ti - tc) + '</div></div></div>';
  h += '<div class="btns" style="margin:12px 0"><button class="btn pri" style="flex:1" onclick="A.newSale()">+ Sale</button><button class="btn" style="flex:1" onclick="A.newExpense()">+ Expense</button><button class="btn" onclick="A.exportCsv()">⬇ CSV</button></div>';
  h += '<h2>Last 6 months</h2><div class="card">' + chart6() + '</div>';
  // profit and loss by planting (farmer) or batch (propagator)
  const groups = {};
  const g = (k, n) => (groups[k] = groups[k] || { n, inc: 0, cost: 0 });
  inc.forEach(r => { if (r.s && r.s.ent) { g('#' + r.s.ent, ENTS[r.s.ent][0] + ' ' + ENTS[r.s.ent][1]).inc += r.amt; return; } if (prop) { const bb = r.batch && byId('batches', r.batch); g(bb ? bb.id : '_', bb ? bName(bb) + ' (sown ' + fmtD(bb.sow) + ')' : 'Other sales').inc += r.amt; } else { const p = r.pid && byId('plantings', r.pid); g(p ? p.id : '_', p ? pName(p) : 'Other sales').inc += r.amt; } });
  ex.forEach(e => { if (e.ent) { g('#' + e.ent, ENTS[e.ent][0] + ' ' + ENTS[e.ent][1]).cost += num(e.amount); return; } if (prop) { const bb = e.batch && byId('batches', e.batch); g(bb ? bb.id : '__', bb ? bName(bb) + ' (sown ' + fmtD(bb.sow) + ')' : 'General nursery costs').cost += num(e.amount); } else { const p = e.pid && byId('plantings', e.pid); g(p ? p.id : '__', p ? pName(p) : 'General farm costs').cost += num(e.amount); } });
  const ks = Object.keys(groups).sort((x, y) => (x[0] === '_') - (y[0] === '_') || (groups[y].inc - groups[y].cost) - (groups[x].inc - groups[x].cost));
  h += wholeFarmHtml(inR, lab);
  h += '<h2>Profit and loss · ' + lab + '</h2><div class="card tbwrap"><table class="tb"><tr><th>' + (prop ? 'Batch' : hasAnimals() ? 'Crop / animals' : 'Planting') + '</th><th class="n">Income</th><th class="n">Costs</th><th class="n">Profit</th></tr>' +
    (ks.length ? ks.map(k => { const x = groups[k]; return '<tr><td>' + esc(x.n) + '</td><td class="n">' + fmtN(Math.round(x.inc)) + '</td><td class="n">' + fmtN(Math.round(x.cost)) + '</td><td class="n ' + (x.inc - x.cost >= 0 ? 'pos' : 'neg') + '">' + fmtN(Math.round(x.inc - x.cost)) + '</td></tr>'; }).join('') : '<tr><td colspan="4" class="s">Nothing recorded in this period.</td></tr>') +
    '<tr class="tot"><td>Total</td><td class="n">' + fmtN(Math.round(ti)) + '</td><td class="n">' + fmtN(Math.round(tc)) + '</td><td class="n ' + (ti - tc >= 0 ? 'pos' : 'neg') + '">' + fmtN(Math.round(ti - tc)) + '</td></tr></table></div>';
  const cats = {}; ex.forEach(e => { cats[e.cat] = (cats[e.cat] || 0) + num(e.amount); });
  if (tc) h += '<h2>Where the money went</h2><div class="card">' + Object.keys(cats).sort((x, y) => cats[y] - cats[x]).map(k => '<div style="margin-bottom:8px"><div class="row"><div class="grow s">' + esc(k) + '</div><b>' + ksh(cats[k]) + '</b></div><div class="bar"><div style="width:' + (cats[k] / tc * 100) + '%;background:var(--accent)"></div></div></div>').join('') + '</div>';
  if (ow.length) h += '<h2>Who owes you · ' + ksh(ow.reduce((s, x) => s + x.amt, 0)) + '</h2><div class="card list">' + ow.map(owRow).join('') + '</div>';
  const recent = D.sales.filter(s => mine(s) && inR(s.date)).sort((x, y) => x.date < y.date ? 1 : -1).slice(0, 15);
  if (recent.length) h += '<h2>Sales</h2><div class="card list">' + recent.map(saleRow).join('') + '</div>';
  const re = ex.slice().sort((x, y) => x.date < y.date ? 1 : -1).slice(0, 15);
  if (re.length) h += '<h2>Expenses</h2><div class="card list">' + re.map(expRow).join('') + '</div>';
  return ['Money', h];
}
function chart6() {
  const t = pd(today()), ms = []; for (let i = 5; i >= 0; i--) { const d = new Date(t.getFullYear(), t.getMonth() - i, 1); ms.push(ds(d).slice(0, 7)); }
  const inc = ms.map(m => incomeRows().filter(r => monthKey(r.date) === m).reduce((s, r) => s + r.amt, 0)), cost = ms.map(m => myExp().filter(e => monthKey(e.date) === m).reduce((s, e) => s + num(e.amount), 0));
  const mx = Math.max(1, ...inc, ...cost), W = 340, H = 150, bw = 18, gap = W / 6;
  let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + (H + 22) + '" role="img" aria-label="Income and costs by month">';
  s += '<line x1="0" x2="' + W + '" y1="' + H + '" y2="' + H + '" stroke="var(--line)"/>';
  ms.forEach((m, i) => { const x = i * gap + gap / 2, hi = inc[i] / mx * (H - 10), hc = cost[i] / mx * (H - 10);
    s += '<rect x="' + (x - bw - 1) + '" y="' + (H - hi) + '" width="' + bw + '" height="' + hi + '" rx="3" fill="var(--green)"><title>' + monthName(m) + ' income ' + ksh(inc[i]) + '</title></rect>';
    s += '<rect x="' + (x + 1) + '" y="' + (H - hc) + '" width="' + bw + '" height="' + hc + '" rx="3" fill="var(--accent)"><title>' + monthName(m) + ' costs ' + ksh(cost[i]) + '</title></rect>';
    s += '<text x="' + x + '" y="' + (H + 16) + '" text-anchor="middle" font-size="11" fill="var(--muted)">' + monthName(m) + '</text>'; });
  return s + '</svg><div class="legend"><span><i style="background:var(--green)"></i>Income</span><span><i style="background:var(--accent)"></i>Costs</span></div>';
}

// ================= propagator =================
function todayProp() {
  const t0 = today(), bs = activeBatches().map(b => ({ b, k: bCalc(b) })), pend = D.orders.filter(o => o.status === 'pending').sort((a, b) => a.date < b.date ? -1 : 1);
  const due = D.orders.filter(o => o.status === 'accepted' && o.want && dd(t0, o.want) <= 1).sort((a, b) => a.want < b.want ? -1 : 1);
  const mon = monthKey(t0), inc = incomeRows().filter(r => monthKey(r.date) === mon).reduce((s, r) => s + r.amt, 0), cost = myExp().filter(e => monthKey(e.date) === mon).reduce((s, e) => s + num(e.amount), 0);
  const readyN = bs.filter(x => x.k.st === 'Ready').reduce((s, x) => s + x.k.avail, 0), soonN = bs.filter(x => x.k.st === 'Ready soon').reduce((s, x) => s + x.k.avail, 0), growN = bs.filter(x => x.k.st === 'Growing').reduce((s, x) => s + x.k.avail, 0);
  let h = '<div class="row" style="margin:2px 2px 14px"><div class="grow"><div class="big">' + greet() + (prof().name ? ', ' + esc(prof().name.split(' ')[0]) : '') + '</div><div class="s">' + fmtD(t0) + (prof().farm ? ' · ' + esc(prof().farm) : '') + '</div></div></div>';
  h += '<div class="quick"><button onclick="A.newBatch()"><i>🌱</i>New batch</button><button onclick="A.newOrder()"><i>📥</i>Order</button><button onclick="A.newSale()"><i>🧾</i>Sale</button><button onclick="A.shareStock()"><i>📣</i>Share stock</button></div>';
  h += animalsToday();
  h += '<div class="grid3" style="margin-top:12px"><div class="stat"><div class="s">Ready now</div><div class="v pos">' + fmtN(readyN) + '</div></div><div class="stat"><div class="s">Ready within 7 days</div><div class="v" style="color:var(--accent)">' + fmtN(soonN) + '</div></div><div class="stat"><div class="s">Still growing</div><div class="v" style="color:var(--blue)">' + fmtN(growN) + '</div></div></div>';
  if (pend.length) h += '<h2>New orders to answer (' + pend.length + ')</h2>' + pend.map(orderCard).join('');
  if (due.length) h += '<h2>Collections due</h2>' + due.map(orderCard).join('');
  // nursery reminders
  const rem = [];
  bs.forEach(({ b, k }) => {
    const a = dd(b.sow, t0);
    if (!b.germAt && a >= 7 && a <= 25) rem.push(['🔢', 'Count germination: ' + bName(b), 'Sown ' + fmtD(b.sow) + ' · enter how many came up so stock is right', '<button class="btn sm ok" onclick="A.germ(\'' + b.id + '\')">Count</button>']);
    if (k.toReady > 0 && k.toReady <= 7 && !b.hardened) rem.push(['☀️', 'Harden off: ' + bName(b), 'Ready ' + rel(k.ready) + ' - less water and more sun this week', '<button class="btn sm ok" onclick="A.hardened(\'' + b.id + '\')">Done</button>']);
    if (k.st === 'Getting old' && k.avail > 0) rem.push(['⏳', 'Old seedlings: ' + bName(b), plural(k.avail, 'seedling') + ' were ready ' + rel(k.ready) + ' - sell at a discount or discard', '<button class="btn sm" onclick="A.openB(\'' + b.id + '\')">Open</button>']);
  });
  if (rem.length) h += '<h2>Nursery jobs</h2><div class="card">' + rem.map(r => '<div class="task"><div class="ic">' + r[0] + '</div><div class="grow"><div class="t">' + esc(r[1]) + '</div><div class="s">' + esc(r[2]) + '</div></div>' + r[3] + '</div>').join('') + '</div>';
  h += '<div class="grid3" style="margin-top:12px"><div class="stat"><div class="s">Sales this month</div><div class="v pos">' + ksh(inc) + '</div></div><div class="stat"><div class="s">Costs</div><div class="v">' + ksh(cost) + '</div></div><div class="stat"><div class="s">Profit</div><div class="v ' + (inc - cost >= 0 ? 'pos' : 'neg') + '">' + ksh(inc - cost) + '</div></div></div>';
  if (!bs.length) h += '<h2>Get started</h2>' + emptyBox('🌱', 'Add your first seedling batch', 'Enter the crop, sowing date and trays - the app works out when the seedlings will be ready and how many you can sell.', '<button class="btn pri" onclick="A.newBatch()">+ New batch</button>');
  else h += '<h2>Seedling stock</h2>' + bs.slice(0, 6).map(x => batchCard(x.b)).join('') + (bs.length > 6 ? '<button class="btn wide" onclick="A.go(\'batches\')">All ' + bs.length + ' batches</button>' : '');
  const ow = owed(); if (ow.length) h += '<h2>Who owes you</h2><div class="card list">' + ow.slice(0, 5).map(owRow).join('') + '</div>';
  return ['Today', h];
}
function batchCard(b) {
  const k = bCalc(b), pct = k.raised ? (k.reserved + k.sold) / k.raised * 100 : 0;
  return '<div class="card tap" onclick="A.openB(\'' + b.id + '\')"><div class="row"><div class="em">' + cropEm(b.crop) + '</div><div class="grow"><div class="t">' + esc(bName(b)) + '</div><div class="s">Sown ' + fmtD(b.sow) + ' · ' + (k.toReady > 0 ? 'ready ' + fmtD(k.ready) + ' (' + rel(k.ready) + ')' : 'ready since ' + fmtD(k.ready)) + '</div></div><span class="pill ' + k.cls + '">' + k.st + '</span></div>' +
    '<div class="bar" style="margin-top:10px"><div style="width:' + pct + '%;background:var(--purple)"></div></div><div class="row xs" style="margin-top:5px"><span class="grow"><b style="color:var(--text)">' + fmtN(k.avail) + '</b> available</span><span>' + fmtN(k.reserved) + ' booked · ' + fmtN(k.sold) + ' sold · ' + fmtN(k.raised) + ' raised</span></div></div>';
}
function batchesTab() {
  const bs = activeBatches(), groups = [['Ready', 'Ready now'], ['Ready soon', 'Ready within 7 days'], ['Growing', 'Still growing'], ['Fully booked', 'Fully booked'], ['Sold out', 'Sold out'], ['Getting old', 'Past their best']];
  let h = '<div class="btns" style="margin-bottom:12px"><button class="btn pri" style="flex:1" onclick="A.newBatch()">+ New batch</button><button class="btn" onclick="A.shareStock()">📣 Share stock</button></div>';
  if (!bs.length) h += emptyBox('🌱', 'No seedling batches yet', 'Each sowing is a batch: crop, variety, sowing date and trays.');
  groups.forEach(([st, lab]) => { const g = bs.filter(b => bCalc(b).st === st); if (g.length) h += '<h2>' + lab + '</h2><div class="grid-md">' + g.map(batchCard).join('') + '</div>'; });
  const closed = D.batches.filter(b => b.closed); if (closed.length) h += '<h2>Closed batches</h2>' + closed.slice(-10).reverse().map(batchCard).join('');
  return ['Seedlings', h];
}
VIEWS.batch = v => {
  const b = byId('batches', v.id); if (!b) return ['Batch', '<div class="note">This batch was deleted.</div>'];
  const k = bCalc(b), ords = D.orders.filter(o => o.batch === b.id).sort((x, y) => x.date < y.date ? 1 : -1), a = dd(b.sow, today());
  const inc = incomeRows().filter(r => r.batch === b.id).reduce((s, r) => s + r.amt, 0), cost = D.expenses.filter(e => e.batch === b.id).reduce((s, e) => s + num(e.amount), 0);
  let h = '<div class="card"><div class="row"><div class="em">' + cropEm(b.crop) + '</div><div class="grow"><div class="t">' + esc(bName(b)) + '</div><div class="s">Sown ' + fmtD(b.sow) + ' · day ' + a + ' · ' + fmtN(num(b.trays)) + ' trays × ' + fmtN(num(b.cells)) + ' cells</div></div><span class="pill ' + k.cls + '">' + k.st + '</span></div>';
  const span = Math.max(1, dd(b.sow, k.ready)); h += '<div class="timeline"><div style="flex:' + Math.max(1, span - 7) + ';background:#7fc8a0">Growing</div><div style="flex:7;background:#e8c35a">Harden</div><div style="flex:' + Math.max(7, Math.round(span * .4)) + ';background:#9bd27a">Ready</div><span class="now" style="left:calc(' + Math.min(100, a / (span + Math.max(7, Math.round(span * .4))) * 100) + '% - 1px)"></span></div>';
  h += '<div class="s">Ready ' + fmtD(k.ready) + ' (' + rel(k.ready) + ')' + (num(b.price) ? ' · ' + ksh(num(b.price)) + ' per seedling' : '') + '</div></div>';
  h += '<div class="grid2"><div class="stat"><div class="s">Available to sell</div><div class="v pos">' + fmtN(k.avail) + '</div></div><div class="stat"><div class="s">Raised (after germination ' + fmtN(num(b.germ || 85)) + '%' + (b.germAt ? '' : ', estimate') + ')</div><div class="v">' + fmtN(k.raised) + '</div></div><div class="stat"><div class="s">Booked by orders</div><div class="v" style="color:var(--purple)">' + fmtN(k.reserved) + '</div></div><div class="stat"><div class="s">Sold / collected</div><div class="v">' + fmtN(k.sold) + '</div></div></div>';
  h += '<div class="btns" style="margin:12px 0"><button class="btn pri" onclick="A.newOrder(\'' + b.id + '\')">+ Order</button><button class="btn" onclick="A.newSale(null,\'' + b.id + '\')">+ Walk-in sale</button><button class="btn" onclick="A.germ(\'' + b.id + '\')">🔢 Germination</button><button class="btn" onclick="A.lost(\'' + b.id + '\')">Losses</button><button class="btn" onclick="A.newExpense(null,\'' + b.id + '\')">+ Cost</button><button class="btn" onclick="A.editBatch(\'' + b.id + '\')">Edit</button></div>';
  h += '<div class="grid3"><div class="stat"><div class="s">Income</div><div class="v pos">' + ksh(inc) + '</div></div><div class="stat"><div class="s">Costs</div><div class="v">' + ksh(cost) + '</div></div><div class="stat"><div class="s">Profit</div><div class="v ' + (inc - cost >= 0 ? 'pos' : 'neg') + '">' + ksh(inc - cost) + '</div></div></div>';
  h += '<h2>Orders</h2>' + (ords.length ? ords.map(orderCard).join('') : '<div class="card s">No orders on this batch yet.</div>');
  if (b.notes) h += '<div class="note">' + esc(b.notes) + '</div>';
  h += '<div class="btns" style="margin-top:14px"><button class="btn" onclick="A.closeBatch(\'' + b.id + '\')">' + (b.closed ? 'Reopen batch' : 'Close batch (finished)') + '</button></div>';
  return [bName(b), h];
};
const OST = { pending: ['New - answer it', 'a'], accepted: ['Accepted - to collect', 'g'], declined: ['Declined', 'r'], collected: ['Collected', ''], cancelled: ['Cancelled', ''] };
function orderCard(o) {
  const b = byId('batches', o.batch), k = b && bCalc(b), st = OST[o.status] || ['', ''];
  let h = '<div class="card"><div class="row top"><div class="em">' + cropEm(o.crop || (b && b.crop)) + '</div><div class="grow"><div class="t">' + esc(o.name) + ' · ' + plural(num(o.qty), 'seedling') + '</div><div class="s">' + esc(b ? bName(b) : crop(o.crop).n) + (o.want ? ' · wanted ' + fmtD(o.want) : '') + (num(o.price) ? ' · ' + ksh(num(o.qty) * num(o.price)) : '') + '</div>' + (o.phone ? '<div class="xs">📞 ' + esc(o.phone) + '</div>' : '') + (o.notes ? '<div class="xs">' + esc(o.notes) + '</div>' : '') + '</div><span class="pill ' + st[1] + '">' + st[0] + '</span></div>';
  if (o.status === 'pending') {
    const enough = k && k.avail >= num(o.qty);
    h += '<div class="note ' + (enough ? 'good' : 'warn') + '" style="margin:10px 0 8px">' + (k ? (enough ? '✓ ' + fmtN(k.avail) + ' available in this batch' + (k.toReady > 0 ? ', ready ' + fmtD(k.ready) : '') : 'Only ' + fmtN(k.avail) + ' left in this batch') : 'No batch chosen') + '</div><div class="btns"><button class="btn ok" style="flex:1" onclick="A.accept(\'' + o.id + '\')">✓ Accept</button><button class="btn bad" style="flex:1" onclick="A.decline(\'' + o.id + '\')">✕ Not available</button><button class="btn" onclick="A.editOrder(\'' + o.id + '\')">Edit</button></div>';
  } else if (o.status === 'accepted') h += '<div class="btns" style="margin-top:10px"><button class="btn ok" style="flex:1" onclick="A.collect(\'' + o.id + '\')">Collected &amp; paid</button>' + (o.phone ? '<a class="btn" target="_blank" rel="noopener" href="' + waLink(o.phone, readyMsg(o)) + '">💬 Tell them</a>' : '') + '<button class="btn" onclick="A.editOrder(\'' + o.id + '\')">Edit</button></div>';
  else h += '<div class="btns" style="margin-top:10px"><button class="btn sm" onclick="A.editOrder(\'' + o.id + '\')">Edit</button></div>';
  return h + '</div>';
}
function readyMsg(o) { const b = byId('batches', o.batch), k = b && bCalc(b); return 'Hello ' + o.name + ', your order of ' + fmtN(num(o.qty)) + ' ' + (b ? bName(b) : '') + ' seedlings is confirmed' + (k ? (k.toReady > 0 ? '. They will be ready on ' + fmtD(k.ready) : ' and ready for collection') : '') + '.' + (num(o.price) ? ' Total ' + ksh(num(o.qty) * num(o.price)) + '.' : '') + ' - ' + (prof().farm || prof().name || ''); }
function ordersTab() {
  const f = S.oF || 'open', os = D.orders.slice().sort((a, b) => a.date < b.date ? 1 : -1);
  const sel = f === 'open' ? os.filter(o => o.status === 'pending' || o.status === 'accepted') : f === 'done' ? os.filter(o => o.status === 'collected') : os.filter(o => o.status === 'declined' || o.status === 'cancelled');
  let h = '<div class="btns" style="margin-bottom:12px"><button class="btn pri" style="flex:1" onclick="A.newOrder()">+ New order</button></div>';
  h += '<div class="note">Farmers order by phone or WhatsApp - enter each order here, then accept it if you still have the seedlings or tell them they are not available. Accepted orders are set aside from your stock.</div>';
  h += '<div class="seg" style="margin-bottom:12px">' + [['open', 'Open'], ['done', 'Collected'], ['no', 'Declined']].map(x => '<button class="' + (f === x[0] ? 'on' : '') + '" onclick="A.oF(\'' + x[0] + '\')">' + x[1] + '</button>').join('') + '</div>';
  h += sel.length ? sel.map(orderCard).join('') : emptyBox('📥', 'No orders here', 'New orders show here to accept or decline.');
  return ['Orders', h];
}

// ================= more =================
function moreTab() {
  const p = prof(), prop = isProp();
  const item = (em, t, s, fn) => '<div class="li" style="cursor:pointer" onclick="' + fn + '"><div class="em">' + em + '</div><div class="grow"><div class="t">' + t + '</div><div class="s">' + s + '</div></div><span class="xs">›</span></div>';
  let h = '<div class="card"><div class="row"><div class="em">' + (prop ? '🌱' : '🧑‍🌾') + '</div><div class="grow"><div class="t">' + esc(p.name || '') + '</div><div class="s">' + esc(p.farm || '') + (p.county ? ' · ' + esc(p.county) : '') + '</div></div><button class="btn sm" onclick="A.profile()">Edit</button></div></div>';
  h += (typeof accountCardHtml === 'function' ? accountCardHtml() : '');
  h += '<div class="card list">' + item('🚜', 'What is on your farm', ents().map(e => ENTS[e][1]).join(', '), 'A.activities()') + (prop || !hasAnimals() || !hasEnt('crops') ? '' : item('🩺', 'Plant doctor', 'Check sick plants', 'A.go(\'doctor\')')) + (prop ? '' : item('🗺️', 'Fields and blocks', 'Where each crop is planted', 'A.fields()') + item('🌱', 'Seedlings I ordered', 'Know when they are ready to plant', 'A.seedOrders()')) +
    (prop ? item('🩺', 'Plant doctor', 'Check sick seedlings', 'A.go(\'doctor\')') : '') +
    item('🌱', 'My crops', (prof().crops || []).map(c0).join(', ') || 'All crops', 'A.myCrops()') +
    item('📚', 'Crop guide', 'How each crop grows, its care and problems', 'A.openV({t:\'guide\'})') +
    item('🧮', 'Seedling calculator', 'How many seedlings for your land', 'A.calc()') + '</div>';
  h += '<div class="card list">' + item(prop ? '🧑‍🌾' : '🌱', 'Switch to the ' + (prop ? 'farmer' : 'propagator') + ' side', prop ? 'If you also grow crops' : 'If you also raise seedlings for sale', 'A.switchRole()') +
    item(document.documentElement.dataset.theme === 'light' ? '🌙' : '☀️', document.documentElement.dataset.theme === 'light' ? 'Dark screen' : 'Light screen', 'Light is easier to read in the sun', 'A.theme()') +
    item('🔔', 'Reminders on this phone', K.notify ? 'On - shown when the app is opened' : 'Off', 'A.notify()') +
    item('🔒', 'Screen lock', K.lock ? 'PIN on - asked when the app opens' : 'Off - add a PIN to open the app', 'A.pinSet()') +
    (K.lock ? item('🔐', 'Lock now', 'Lock the screen straight away', 'A.lockNow()') : '') +
    item('💾', 'Backup', 'Save all records to a file, or restore them', 'A.backup()') + '</div>';
  h += '<p class="xs" style="text-align:center">Farm on the Go · build ' + BUILD + ' · records stay on this phone<br>Spray advice is general - always follow the product label and PCPB rules.</p>';
  return ['More', h];
}
VIEWS.guide = v => {
  if (v.id) {
    const c = crop(v.id); let h = '<div class="card"><div class="row"><div class="em">' + c.e + '</div><div class="grow"><div class="t">' + esc(c.n) + ' <span class="s">(' + esc(c.sw) + ')</span></div><div class="s">' + ({ nursery: 'Raised in a nursery, then transplanted', direct: 'Sown straight in the field', tubers: 'Planted from seed tubers', grafted: 'Grafted seedlings from a nursery', tissue: 'Suckers or tissue-culture plantlets' }[c.grow]) + '</div></div></div>';
    h += '<div class="grid2" style="margin-top:10px">' + (c.nursery ? '<div class="stat"><div class="s">In the nursery</div><div class="v">' + (c.nursery >= 60 ? Math.round(c.nursery / 30) + ' months' : Math.round(c.nursery / 7) + ' weeks') + '</div></div>' : '') + '<div class="stat"><div class="s">First harvest</div><div class="v">' + (c.first >= 365 ? (c.first / 365).toFixed(c.first % 365 ? 1 : 0) + ' years' : c.first + ' days') + '</div></div><div class="stat"><div class="s">Spacing</div><div class="v">' + c.space[0] + ' × ' + c.space[1] + ' cm</div></div><div class="stat"><div class="s">Plants per acre</div><div class="v">~' + fmtN(Math.round(4047 / (c.space[0] / 100 * c.space[1] / 100))) + '</div></div></div>';
    h += '<div class="s" style="margin-top:6px">Common varieties: ' + esc(c.varieties.join(', ')) + '</div></div>';
    h += '<h2>Growth stages</h2><div class="card list">' + c.stages.map(s => '<div class="li"><div class="grow">' + esc(s[0]) + '</div><span class="s">day ' + s[1] + '-' + s[2] + '</span></div>').join('') + '</div>';
    h += '<h2>Care programme</h2><div class="card">' + c.tasks.slice().sort((a, b) => a[0] - b[0]).map(t => '<div class="task"><div class="ic">' + ttIcon(t[1]) + '</div><div class="grow"><div class="t">' + esc(t[2]) + '</div><div class="s">Day ' + t[0] + (t[4] ? ', then every ' + t[4] + ' days to day ' + t[5] : '') + '</div><div class="xs">' + esc(t[3]) + '</div></div></div>').join('') + '</div>';
    h += '<h2>Common problems</h2>' + c.problems.map(id => probCard(id)).join('');
    h += '<p class="xs">Days count from transplanting (nursery crops) or sowing. Timings change with variety, altitude and season.</p>';
    return [c.n, h];
  }
  return ['Crop guide', '<div class="grid-md">' + L.CROPS.map(c => '<div class="card tap" onclick="A.openV({t:\'guide\',id:\'' + c.id + '\'})"><div class="row"><div class="em">' + c.e + '</div><div class="grow"><div class="t">' + esc(c.n) + '</div><div class="s">' + esc(c.sw) + ' · first harvest ' + (c.first >= 365 ? Math.round(c.first / 365) + ' yrs' : c.first + ' days') + '</div></div><span class="pill ' + (c.level === 'managed' ? 'a' : '') + '">' + (c.level === 'managed' ? 'Full programme' : 'Light care') + '</span></div></div>').join('') + '</div>'];
};
// ================= one farm: activities, dairy and poultry =================
const ENTS = { crops: ['🌱', 'Crops'], nursery: ['🌿', 'Nursery'], dairy: ['🐄', 'Dairy'], poultry: ['🐔', 'Poultry'] };
const ents = () => prof().activities || [isProp() ? 'nursery' : 'crops'];
const hasEnt = e => ents().includes(e);
const hasAnimals = () => hasEnt('dairy') || hasEnt('poultry');
const COW_STATUS = { milking: 'Milking', dry: 'Dry', heifer: 'Heifer', calf: 'Calf', bull: 'Bull', sold: 'Sold', dead: 'Dead' };
const HERD_EVENTS = { service: 'AI / bull service', pregcheck: 'Pregnancy check', calving: 'Calving', dryoff: 'Dried off', vaccine: 'Vaccination', deworm: 'Deworming', treat: 'Treatment', vet: 'Vet visit', other: 'Other' };
const FLOCK_TYPES = { layers: 'Layers', broilers: 'Broilers', kienyeji: 'Kienyeji', other: 'Other' };
const FLOCK_LOGS = { vaccine: 'Vaccination', treat: 'Treatment', deworm: 'Deworming', vet: 'Vet visit', other: 'Other' };
const DAIRY_COSTS = ['Feed and fodder', 'Dairy meal', 'Vet and medicine', 'AI / bull service', 'Labour', 'Water', 'Equipment', 'Transport', 'Other'];
const POULTRY_COSTS = ['Feed', 'Chicks', 'Vet and vaccines', 'Labour', 'Litter and bedding', 'Packaging (trays)', 'Equipment', 'Transport', 'Other'];
const GESTATION_DAYS = 283;   // typical for dairy cattle; shown as an estimate and can be changed
const cows = () => D.animals.filter(a => !['sold', 'dead'].includes(a.status)).sort((a, b) => String(a.name).localeCompare(b.name));
const activeFlocks = () => D.flocks.filter(f => !f.closed);
const milkOn = d => D.milk.filter(m => m.date === d).reduce((s, m) => s + num(m.am) + num(m.pm), 0);
const milkIn = (a, b) => D.milk.filter(m => m.date >= a && m.date <= b).reduce((s, m) => s + num(m.am) + num(m.pm), 0);
const flockLogs = id => D.flocklog.filter(l => l.flock === id);
function flockCount(f) {
  const lg = flockLogs(f.id), dead = lg.filter(l => l.kind === 'deaths').reduce((s, l) => s + num(l.qty), 0);
  const sold = D.sales.filter(s => s.ent === 'poultry' && s.ref === f.id && s.unit === 'bird').reduce((s, x) => s + num(x.qty), 0);
  return Math.max(0, num(f.count) - dead - sold);
}
const entSales = e => D.sales.filter(s => e === 'crops' ? !s.ent && sideOf(s) === 'farmer' : e === 'nursery' ? !s.ent && sideOf(s) === 'propagator' : s.ent === e);
const entCosts = e => D.expenses.filter(x => e === 'crops' ? !x.ent && sideOf(x) === 'farmer' : e === 'nursery' ? !x.ent && sideOf(x) === 'propagator' : x.ent === e);
function entMoney(e, inR) {
  let inc = entSales(e).filter(s => inR(s.date)).reduce((t, s) => t + saleTotal(s), 0);
  if (e === 'nursery') inc += D.orders.filter(o => o.status === 'collected' && inR(o.collected || o.date)).reduce((t, o) => t + num(o.qty) * num(o.price), 0);
  return { inc, cost: entCosts(e).filter(x => inR(x.date)).reduce((t, x) => t + num(x.amount), 0) };
}
function wholeFarmHtml(inR, lab) {
  const list = Object.keys(ENTS).filter(e => hasEnt(e) || entSales(e).length || entCosts(e).length);
  if (list.length < 2) return '';
  let ti = 0, tc = 0;
  const rows = list.map(e => { const m = entMoney(e, inR), p = m.inc - m.cost; ti += m.inc; tc += m.cost; return '<tr><td>' + ENTS[e][0] + ' ' + ENTS[e][1] + '</td><td class="n">' + fmtN(Math.round(m.inc)) + '</td><td class="n">' + fmtN(Math.round(m.cost)) + '</td><td class="n ' + (p >= 0 ? 'pos' : 'neg') + '">' + fmtN(Math.round(p)) + '</td></tr>'; }).join('');
  return '<h2>Whole farm · ' + lab + '</h2><div class="card tbwrap"><table class="tb"><tr><th>Activity</th><th class="n">Income</th><th class="n">Costs</th><th class="n">Profit</th></tr>' + rows + '<tr class="tot"><td>Total</td><td class="n">' + fmtN(Math.round(ti)) + '</td><td class="n">' + fmtN(Math.round(tc)) + '</td><td class="n ' + (ti - tc >= 0 ? 'pos' : 'neg') + '">' + fmtN(Math.round(ti - tc)) + '</td></tr></table></div>';
}
// jobs that have a next date: vaccinations, calving due and so on
function animalDue(horizon) {
  const lim = addD(today(), horizon), out = [];
  if (hasEnt('dairy')) D.herdlog.filter(l => l.next && !l.nextDone && l.next <= lim).forEach(l => { const c = byId('animals', l.animal); if (c && !['sold', 'dead'].includes(c.status)) out.push({ em: '🐄', who: c.name, what: l.nextWhat || HERD_EVENTS[l.kind], due: l.next, id: l.id, s: 'herdlog' }); });
  if (hasEnt('poultry')) D.flocklog.filter(l => l.next && !l.nextDone && l.next <= lim).forEach(l => { const f = byId('flocks', l.flock); if (f && !f.closed) out.push({ em: '🐔', who: f.name, what: l.nextWhat || FLOCK_LOGS[l.kind], due: l.next, id: l.id, s: 'flocklog' }); });
  return out.sort((a, b) => a.due < b.due ? -1 : 1);
}
function withdrawals() {
  const t0 = today(), out = [];
  D.herdlog.filter(l => l.withdraw && l.withdraw >= t0).forEach(l => { const c = byId('animals', l.animal); if (c) out.push('<b>⚠️ Do not sell milk from ' + esc(c.name) + ' until after ' + fmtD(l.withdraw) + '</b>'); });
  D.flocklog.filter(l => l.withdraw && l.withdraw >= t0).forEach(l => { const f = byId('flocks', l.flock); if (f) out.push('<b>⚠️ Do not sell eggs or meat from ' + esc(f.name) + ' until after ' + fmtD(l.withdraw) + '</b>'); });
  return out.map(x => '<div class="note bad">' + x + '<br><span class="s">Withdrawal period you recorded after treatment.</span></div>').join('');
}
const dueRow = x => '<div class="li"><div class="em">' + x.em + '</div><div class="grow"><div class="t">' + esc(x.what) + ' · ' + esc(x.who) + '</div><div class="s">' + fmtD(x.due) + ' · ' + rel(x.due) + '</div></div><button class="btn sm" onclick="A.dueDone(\'' + x.s + '\',\'' + x.id + '\')">Done</button></div>';
function animalsToday() {
  if (!hasAnimals()) return '';
  const t0 = today(), due = animalDue(7);
  let h = '<div class="quick" style="margin-top:12px">' +
    (hasEnt('dairy') ? '<button onclick="A.milkDay()"><i>🥛</i>Milk</button><button onclick="A.herdEvent()"><i>🐄</i>Herd event</button>' : '') +
    (hasEnt('poultry') ? '<button onclick="A.eggsDay()"><i>🥚</i>Eggs</button><button onclick="A.flockEvent()"><i>🐔</i>Flock event</button>' : '') + '</div>';
  h += withdrawals();
  if (due.length) h += '<h2>Animal jobs · this week</h2><div class="card list">' + due.map(dueRow).join('') + '</div>';
  if (hasEnt('dairy') && cows().some(c => c.status === 'milking') && !D.milk.some(m => m.date === t0)) h += '<div class="note">🥛 No milk recorded yet today. <button class="btn sm" onclick="A.milkDay()">Record milk</button></div>';
  return h;
}
function animalsTab() {
  const t0 = today(), mon = t0.slice(0, 7), inMon = d => monthKey(d) === mon;
  let h = '';
  h += withdrawals();
  if (hasEnt('dairy')) {
    const m = entMoney('dairy', inMon), list = cows();
    h += '<h2>🐄 Dairy</h2><div class="grid3"><div class="stat"><div class="s">Milk today</div><div class="v">' + fmtN(milkOn(t0)) + ' L</div></div><div class="stat"><div class="s">Milk this month</div><div class="v">' + fmtN(milkIn(mon + '-01', mon + '-31')) + ' L</div></div><div class="stat"><div class="s">Profit this month</div><div class="v ' + (m.inc - m.cost >= 0 ? 'pos' : 'neg') + '">' + ksh(m.inc - m.cost) + '</div></div></div>';
    h += '<div class="btns" style="margin:12px 0"><button class="btn pri" onclick="A.milkDay()">🥛 Milk</button><button class="btn" onclick="A.herdEvent()">+ Event</button><button class="btn" onclick="A.anSale(\'dairy\')">+ Sale</button><button class="btn" onclick="A.anCost(\'dairy\')">+ Cost</button><button class="btn" onclick="A.editCow()">+ Cow</button></div>';
    h += list.length ? '<div class="card list">' + list.map(c => { const tm = D.milk.find(x => x.animal === c.id && x.date === t0); return '<div class="li" style="cursor:pointer" onclick="A.openV({t:\'cow\',id:\'' + c.id + '\'})"><div class="em">🐄</div><div class="grow"><div class="t">' + esc(c.name) + '</div><div class="s">' + esc(c.breed || '') + (c.breed ? ' · ' : '') + COW_STATUS[c.status] + '</div></div><b>' + (tm ? fmtN(num(tm.am) + num(tm.pm)) + ' L' : '') + '</b></div>'; }).join('') + '</div>' : emptyBox('🐄', 'Add your first cow', 'Record milk per cow, breeding, health and what each one earns.', '<button class="btn pri" onclick="A.editCow()">+ Add a cow</button>');
  }
  if (hasEnt('poultry')) {
    const m = entMoney('poultry', inMon), fl = activeFlocks(), eggsT = D.flocklog.filter(l => l.kind === 'eggs' && l.date === t0).reduce((s, l) => s + num(l.qty), 0);
    h += '<h2>🐔 Poultry</h2><div class="grid3"><div class="stat"><div class="s">Birds now</div><div class="v">' + fmtN(fl.reduce((s, f) => s + flockCount(f), 0)) + '</div></div><div class="stat"><div class="s">Eggs today</div><div class="v">' + fmtN(eggsT) + '</div></div><div class="stat"><div class="s">Profit this month</div><div class="v ' + (m.inc - m.cost >= 0 ? 'pos' : 'neg') + '">' + ksh(m.inc - m.cost) + '</div></div></div>';
    h += '<div class="btns" style="margin:12px 0"><button class="btn pri" onclick="A.eggsDay()">🥚 Eggs</button><button class="btn" onclick="A.flockEvent()">+ Event</button><button class="btn" onclick="A.anSale(\'poultry\')">+ Sale</button><button class="btn" onclick="A.anCost(\'poultry\')">+ Cost</button><button class="btn" onclick="A.editFlock()">+ Flock</button></div>';
    h += fl.length ? '<div class="card list">' + fl.map(f => '<div class="li" style="cursor:pointer" onclick="A.openV({t:\'flock\',id:\'' + f.id + '\'})"><div class="em">🐔</div><div class="grow"><div class="t">' + esc(f.name) + '</div><div class="s">' + FLOCK_TYPES[f.type] + ' · ' + dd(f.start, t0) + ' days old on the farm</div></div><b>' + plural(flockCount(f), 'bird') + '</b></div>').join('') + '</div>' : emptyBox('🐔', 'Add your first flock', 'Record eggs, deaths, feed, vaccinations and what each flock earns.', '<button class="btn pri" onclick="A.editFlock()">+ Add a flock</button>');
  }
  const due = animalDue(30);
  if (due.length) h += '<h2>Coming up · 30 days</h2><div class="card list">' + due.map(dueRow).join('') + '</div>';
  return ['Animals', h];
}
const logRow = (l, label, fn) => '<div class="li"><div class="grow"><div class="t">' + esc(label) + '</div><div class="s">' + fmtD(l.date) + (l.notes ? ' · ' + esc(l.notes) : '') + (l.next && !l.nextDone ? ' · next ' + fmtD(l.next) : '') + '</div></div>' + (num(l.cost) ? '<b>' + ksh(num(l.cost)) + '</b>' : '') + '<button class="btn sm" onclick="' + fn + '">Edit</button></div>';
VIEWS.cow = v => {
  const c = byId('animals', v.id); if (!c) return ['Cow', '<div class="note">This cow is no longer in your records.</div>'];
  const t0 = today(), from = addD(t0, -29), rows = D.milk.filter(m => m.animal === c.id).sort((a, b) => a.date < b.date ? 1 : -1), r30 = rows.filter(m => m.date >= from), tot = r30.reduce((s, m) => s + num(m.am) + num(m.pm), 0);
  const sold = D.sales.filter(s => s.ref === c.id).reduce((s, x) => s + saleTotal(x), 0), costs = D.expenses.filter(e => e.ref === c.id).reduce((s, e) => s + num(e.amount), 0);
  let h = '<div class="card"><div class="row"><div class="em">🐄</div><div class="grow"><div class="t">' + esc(c.name) + '</div><div class="s">' + esc(c.breed || '') + (c.breed ? ' · ' : '') + COW_STATUS[c.status] + (c.tag ? ' · tag ' + esc(c.tag) : '') + '</div></div><button class="btn sm" onclick="A.editCow(\'' + c.id + '\')">Edit</button></div></div>';
  h += '<div class="grid3" style="margin-top:12px"><div class="stat"><div class="s">Last 30 days</div><div class="v">' + fmtN(tot) + ' L</div></div><div class="stat"><div class="s">Average per milking day</div><div class="v">' + (r30.length ? fmtN(Math.round(tot / r30.length * 10) / 10) : 0) + ' L</div></div><div class="stat"><div class="s">Costs recorded</div><div class="v">' + ksh(costs) + '</div></div></div>';
  if (sold) h += '<div class="s" style="margin-top:8px">Direct sales recorded for this animal: ' + ksh(sold) + '</div>';
  h += '<div class="btns" style="margin:12px 0"><button class="btn pri" onclick="A.herdEvent(null,\'' + c.id + '\')">+ Event</button><button class="btn" onclick="A.anCost(\'dairy\',\'' + c.id + '\')">+ Cost</button></div>';
  const ev = D.herdlog.filter(l => l.animal === c.id).sort((a, b) => a.date < b.date ? 1 : -1);
  if (ev.length) h += '<h2>Breeding and health</h2><div class="card list">' + ev.map(l => logRow(l, HERD_EVENTS[l.kind], 'A.herdEvent(\'' + l.id + '\')')).join('') + '</div>';
  if (rows.length) h += '<h2>Recent milk</h2><div class="card tbwrap"><table class="tb"><tr><th>Date</th><th class="n">Morning</th><th class="n">Evening</th><th class="n">Total</th></tr>' + rows.slice(0, 14).map(m => '<tr><td>' + fmtD(m.date) + '</td><td class="n">' + fmtN(num(m.am)) + '</td><td class="n">' + fmtN(num(m.pm)) + '</td><td class="n">' + fmtN(num(m.am) + num(m.pm)) + '</td></tr>').join('') + '</table></div>';
  return [c.name, h];
};
VIEWS.flock = v => {
  const f = byId('flocks', v.id); if (!f) return ['Flock', '<div class="note">This flock is no longer in your records.</div>'];
  const n = flockCount(f), lg = flockLogs(f.id).sort((a, b) => a.date < b.date ? 1 : -1), from = addD(today(), -6), eggs7 = lg.filter(l => l.kind === 'eggs' && l.date >= from).reduce((s, l) => s + num(l.qty), 0);
  const dead = lg.filter(l => l.kind === 'deaths').reduce((s, l) => s + num(l.qty), 0), sales = D.sales.filter(s => s.ref === f.id).reduce((s, x) => s + saleTotal(x), 0), costs = D.expenses.filter(e => e.ref === f.id).reduce((s, e) => s + num(e.amount), 0);
  let h = '<div class="card"><div class="row"><div class="em">🐔</div><div class="grow"><div class="t">' + esc(f.name) + '</div><div class="s">' + FLOCK_TYPES[f.type] + ' · started ' + fmtD(f.start) + ' with ' + plural(num(f.count), 'bird') + '</div></div><button class="btn sm" onclick="A.editFlock(\'' + f.id + '\')">Edit</button></div></div>';
  h += '<div class="grid3" style="margin-top:12px"><div class="stat"><div class="s">Birds now</div><div class="v">' + fmtN(n) + '</div></div><div class="stat"><div class="s">Eggs, 7 days</div><div class="v">' + fmtN(eggs7) + '</div></div><div class="stat"><div class="s">Deaths</div><div class="v">' + fmtN(dead) + '</div></div></div>';
  h += '<div class="grid2" style="margin-top:10px"><div class="stat"><div class="s">Sales</div><div class="v pos">' + ksh(sales) + '</div></div><div class="stat"><div class="s">Costs</div><div class="v">' + ksh(costs) + '</div></div></div>';
  h += '<div class="btns" style="margin:12px 0"><button class="btn pri" onclick="A.eggsDay(\'' + f.id + '\')">🥚 Eggs</button><button class="btn" onclick="A.flockQty(\'deaths\',\'' + f.id + '\')">Deaths</button><button class="btn" onclick="A.flockQty(\'feed\',\'' + f.id + '\')">Feed</button><button class="btn" onclick="A.flockEvent(null,\'' + f.id + '\')">+ Event</button><button class="btn" onclick="A.anSale(\'poultry\',\'' + f.id + '\')">+ Sale</button></div>';
  if (lg.length) h += '<h2>Records</h2><div class="card list">' + lg.slice(0, 30).map(l => logRow(l, l.kind === 'eggs' ? fmtN(num(l.qty)) + ' eggs' + (num(l.broken) ? ', ' + fmtN(num(l.broken)) + ' broken' : '') : l.kind === 'deaths' ? plural(num(l.qty), 'death') : l.kind === 'feed' ? fmtN(num(l.qty)) + ' kg feed' : FLOCK_LOGS[l.kind], (l.kind === 'eggs' ? 'A.eggsDay(\'' + f.id + '\',\'' + l.id + '\')' : ['deaths', 'feed'].includes(l.kind) ? 'A.flockQty(\'' + l.kind + '\',\'' + f.id + '\',\'' + l.id + '\')' : 'A.flockEvent(\'' + l.id + '\')'))).join('') + '</div>';
  return [f.name, h];
};
// a record's cost is kept as one linked expense, so Money always matches the record
async function syncLogCost(l, ent, ref, cat, what) {
  const old = D.expenses.find(e => e.log === l.id);
  if (num(l.cost) > 0) await save('expenses', Object.assign(old || { id: uid(), side: 'farmer', log: l.id }, { ent, ref, cat, amount: num(l.cost), date: l.date, notes: what }));
  else if (old) await remove('expenses', old.id);
}
async function delLog(store, id) { const e = D.expenses.find(x => x.log === id); if (e) await remove('expenses', e.id); await remove(store, id); }
const cowOpts = () => cows().map(c => [c.id, c.name]);
const flockOpts = () => activeFlocks().map(f => [f.id, f.name]);
const animalActions = {
  activities() {
    const cur = ents();
    const ov = sheet('What is on your farm?', '<p class="s" style="margin-top:0">Switch on everything you keep. Today and Money bring them together.</p><div class="chips" id="entChips">' + Object.keys(ENTS).map(e => '<button class="chip ' + (cur.includes(e) ? 'on' : '') + '" data-e="' + e + '" onclick="this.classList.toggle(\'on\')">' + ENTS[e][0] + ' ' + ENTS[e][1] + '</button>').join('') + '</div><div id="entMsg"></div><button class="btn pri wide" style="margin-top:16px" id="entSave">Save</button>');
    ov.querySelector('#entSave').onclick = async () => {
      const list = [...ov.querySelectorAll('#entChips .chip.on')].map(b => b.dataset.e);
      if (!list.length) { ov.querySelector('#entMsg').innerHTML = '<div class="note bad" style="margin-top:10px">Pick at least one</div>'; return; }
      const p = Object.assign({}, prof(), { activities: list });
      if (p.role === 'propagator' && !list.includes('nursery')) p.role = 'farmer';
      if (p.role === 'farmer' && !list.includes('crops') && !list.includes('dairy') && !list.includes('poultry')) p.role = 'propagator';
      await setK('profile', p); closeSheet(false, ov); go('today'); toast('Farm updated');
    };
  },
  editCow(id) {
    const c = id ? byId('animals', id) : null, v = c || { status: 'milking' };
    form(c ? 'Edit cow' : 'Add a cow', [
      { k: 'name', l: 'Name', v: v.name, req: 1, ph: 'e.g. Neema' }, { k: 'tag', l: 'Ear tag (optional)', v: v.tag }, { k: 'breed', l: 'Breed', v: v.breed, list: ['Friesian', 'Ayrshire', 'Jersey', 'Guernsey', 'Sahiwal', 'Cross'] },
      { k: 'status', l: 'Status', t: 'select', o: Object.entries(COW_STATUS), v: v.status }, { k: 'born', l: 'Date of birth (optional)', t: 'date', v: v.born }, { k: 'notes', l: 'Notes', v: v.notes }
    ], async o => { await save('animals', Object.assign(c || { id: uid() }, o)); toast('Saved'); }, {
      del: c ? async () => {
        for (const m of D.milk.filter(x => x.animal === c.id)) await remove('milk', m.id);
        for (const l of D.herdlog.filter(x => x.animal === c.id)) await delLog('herdlog', l.id);
        await remove('animals', c.id); S.view = null;
      } : null
    });
  },
  milkDay(date) {
    const list = cows().filter(c => c.status === 'milking');
    if (!list.length) { toast('Add a milking cow first'); A.editCow(); return; }
    const d = date || today(), rec = id => D.milk.find(m => m.animal === id && m.date === d) || {};
    const fields = [{ k: 'date', l: 'Date', t: 'date', v: d, req: 1, hint: 'Morning and evening litres per cow' }];
    list.forEach(c => { fields.push({ k: 'am_' + c.id, l: c.name + ' · morning (L)', t: 'num', v: rec(c.id).am }, { k: 'pm_' + c.id, l: c.name + ' · evening (L)', t: 'num', v: rec(c.id).pm }); });
    form('Record milk', fields, async o => {
      for (const c of list) {
        const am = o['am_' + c.id], pm = o['pm_' + c.id], mid = c.id + '_' + o.date, old = byId('milk', mid);
        if (am === '' && pm === '') { if (old) await remove('milk', mid); continue; }
        if (num(am) < 0 || num(pm) < 0) throw new Error('Litres cannot be negative');
        await save('milk', Object.assign(old || { id: mid, animal: c.id, date: o.date }, { am: num(am), pm: num(pm) }));
      }
      toast('Milk saved');
    }, { onOpen: ov => on(ov, '#f_date', 'change', e => { const nd = e.target.value; if (nd) { closeSheet(false, ov); A.milkDay(nd); } }) });
  },
  herdEvent(id, cid) {
    const l = id ? byId('herdlog', id) : null, opts = cowOpts();
    if (!opts.length && !l) { toast('Add a cow first'); A.editCow(); return; }
    const v = l || { animal: cid || opts[0][0], kind: 'service', date: today() };
    if (l && !opts.some(o => o[0] === l.animal)) { const c0 = byId('animals', l.animal); opts.push([l.animal, c0 ? c0.name : 'Removed cow']); }
    form(l ? 'Edit herd event' : 'Herd event', [
      { k: 'animal', l: 'Cow', t: 'select', o: opts, v: v.animal }, { k: 'kind', l: 'What happened', t: 'select', o: Object.entries(HERD_EVENTS), v: v.kind }, { k: 'date', l: 'Date', t: 'date', v: v.date, req: 1 },
      { k: 'cost', l: 'Cost (KSh)', t: 'num', v: v.cost }, { k: 'next', l: 'Next date (reminder)', t: 'date', v: v.next, hint: 'After a service, calving is estimated at ' + GESTATION_DAYS + ' days - change it if your vet advises differently' },
      { k: 'nextWhat', l: 'Reminder for', v: v.nextWhat, ph: 'e.g. Calving due, booster' }, { k: 'withdraw', l: 'Do not sell milk until (if treated)', t: 'date', v: v.withdraw, hint: 'Take this from the medicine label or your vet' }, { k: 'notes', l: 'Notes', v: v.notes }
    ], async o => {
      if (o.next && l && o.next !== l.next) o.nextDone = false;
      const r = await save('herdlog', Object.assign(l || { id: uid() }, o));
      await syncLogCost(r, 'dairy', r.animal, ['vaccine', 'deworm', 'treat', 'vet'].includes(r.kind) ? 'Vet and medicine' : r.kind === 'service' ? 'AI / bull service' : 'Other', HERD_EVENTS[r.kind]);
      if (r.kind === 'calving' || r.kind === 'dryoff') { const c = byId('animals', r.animal); if (c && !l) await save('animals', Object.assign(c, { status: r.kind === 'calving' ? 'milking' : 'dry' })); }
      toast('Saved');
    }, { del: l ? () => delLog('herdlog', l.id) : null, onOpen: ov => {
      const fill = () => { if (!l && $('f_kind').value === 'service' && $('f_date').value) { $('f_next').value = addD($('f_date').value, GESTATION_DAYS); $('f_nextWhat').value = 'Calving due'; } };
      on(ov, '#f_kind', 'change', fill); on(ov, '#f_date', 'change', fill); fill();
    } });
  },
  editFlock(id) {
    const f = id ? byId('flocks', id) : null, v = f || { type: 'layers', start: today() };
    form(f ? 'Edit flock' : 'Add a flock', [
      { k: 'name', l: 'Flock name', v: v.name, req: 1, ph: 'e.g. Layers house 1' }, { k: 'type', l: 'Type', t: 'select', o: Object.entries(FLOCK_TYPES), v: v.type }, { k: 'start', l: 'Date started', t: 'date', v: v.start, req: 1 },
      { k: 'count', l: 'Number of birds at the start', t: 'num', v: v.count, req: 1 }, { k: 'closed', l: 'Status', t: 'select', o: [['', 'Active'], ['1', 'Finished']], v: v.closed ? '1' : '' }, { k: 'notes', l: 'Notes', v: v.notes }
    ], async o => { if (num(o.count) <= 0) throw new Error('Enter the number of birds'); o.closed = !!o.closed; await save('flocks', Object.assign(f || { id: uid() }, o)); toast('Saved'); }, {
      del: f ? async () => { for (const l of flockLogs(f.id)) await delLog('flocklog', l.id); await remove('flocks', f.id); S.view = null; } : null
    });
  },
  eggsDay(fid, id) {
    const l = id ? byId('flocklog', id) : null, opts = flockOpts();
    if (!opts.length && !l) { toast('Add a flock first'); A.editFlock(); return; }
    const v = l || { flock: fid || opts[0][0], date: today() };
    form('Record eggs', [{ k: 'flock', l: 'Flock', t: 'select', o: opts, v: v.flock }, { k: 'date', l: 'Date', t: 'date', v: v.date, req: 1 }, { k: 'qty', l: 'Eggs collected', t: 'num', v: v.qty, req: 1 }, { k: 'broken', l: 'Of these, broken', t: 'num', v: v.broken }],
      async o => { if (num(o.broken) > num(o.qty)) throw new Error('Broken eggs cannot be more than eggs collected'); await save('flocklog', Object.assign(l || { id: uid(), kind: 'eggs' }, o)); toast('Eggs saved'); }, { del: l ? () => delLog('flocklog', l.id) : null });
  },
  flockQty(kind, fid, id) {
    const l = id ? byId('flocklog', id) : null, f = byId('flocks', fid), v = l || { date: today() };
    const fields = [{ k: 'date', l: 'Date', t: 'date', v: v.date, req: 1 }, { k: 'qty', l: kind === 'feed' ? 'Feed used or bought (kg)' : 'Birds that died', t: 'num', v: v.qty, req: 1 }];
    if (kind === 'feed') fields.push({ k: 'cost', l: 'Cost (KSh), if bought', t: 'num', v: v.cost });
    fields.push({ k: 'notes', l: 'Notes', v: v.notes });
    form(kind === 'feed' ? 'Feed · ' + f.name : 'Deaths · ' + f.name, fields, async o => {
      if (kind === 'deaths' && num(o.qty) > flockCount(f) + num(l && l.qty)) throw new Error('That is more birds than this flock has');
      const r = await save('flocklog', Object.assign(l || { id: uid(), kind, flock: fid }, o));
      if (kind === 'feed') await syncLogCost(r, 'poultry', fid, 'Feed', fmtN(num(r.qty)) + ' kg feed');
      toast('Saved');
    }, { del: l ? () => delLog('flocklog', l.id) : null });
  },
  flockEvent(id, fid) {
    const l = id ? byId('flocklog', id) : null, opts = flockOpts();
    if (!opts.length && !l) { toast('Add a flock first'); A.editFlock(); return; }
    const v = l || { flock: fid || opts[0][0], kind: 'vaccine', date: today() };
    form(l ? 'Edit flock event' : 'Flock event', [
      { k: 'flock', l: 'Flock', t: 'select', o: opts, v: v.flock }, { k: 'kind', l: 'What happened', t: 'select', o: Object.entries(FLOCK_LOGS), v: v.kind }, { k: 'date', l: 'Date', t: 'date', v: v.date, req: 1 }, { k: 'cost', l: 'Cost (KSh)', t: 'num', v: v.cost },
      { k: 'next', l: 'Next date (reminder)', t: 'date', v: v.next }, { k: 'nextWhat', l: 'Reminder for', v: v.nextWhat, ph: 'e.g. Booster' }, { k: 'withdraw', l: 'Do not sell eggs or meat until (if treated)', t: 'date', v: v.withdraw, hint: 'Take this from the medicine label or your vet' }, { k: 'notes', l: 'Notes', v: v.notes }
    ], async o => {
      if (o.next && l && o.next !== l.next) o.nextDone = false;
      const r = await save('flocklog', Object.assign(l || { id: uid() }, o));
      await syncLogCost(r, 'poultry', r.flock, 'Vet and vaccines', FLOCK_LOGS[r.kind]); toast('Saved');
    }, { del: l ? () => delLog('flocklog', l.id) : null });
  },
  async dueDone(store, id) { const l = byId(store, id); if (l) { await save(store, Object.assign(l, { nextDone: true })); render(); toast('Marked done'); } },
  anSale(ent, ref, id) {
    const s = id ? byId('sales', id) : null, dairy = ent === 'dairy', opts = [['', dairy ? 'Whole herd' : 'All flocks']].concat(dairy ? cowOpts() : flockOpts());
    const v = s || { date: today(), pay: 'cash', ref: ref || '', unit: dairy ? 'litre' : 'tray' };
    if (s && s.ref && !opts.some(o => o[0] === s.ref)) { const x = byId(dairy ? 'animals' : 'flocks', s.ref); opts.push([s.ref, x ? x.name : 'Removed']); }
    form((s ? 'Edit ' : 'Record ') + (dairy ? 'dairy' : 'poultry') + ' sale', [
      { k: 'ref', l: dairy ? 'Cow' : 'Flock', t: 'select', o: opts, v: v.ref }, { k: 'date', l: 'Date', t: 'date', v: v.date, req: 1 }, { k: 'unit', l: 'What was sold', t: 'select', o: dairy ? [['litre', 'Milk (litres)'], ['animal', 'Animal'], ['other', 'Other']] : [['tray', 'Eggs (trays)'], ['egg', 'Eggs (single)'], ['bird', 'Birds'], ['manure', 'Manure (bags)'], ['other', 'Other']], v: v.unit },
      { k: 'qty', l: 'Quantity', t: 'num', v: v.qty }, { k: 'price', l: 'Price per unit (KSh)', t: 'num', v: v.price }, { k: 'total', l: 'Total (KSh)', t: 'num', v: s ? saleTotal(s) : '', req: 1 },
      { k: 'buyer', l: 'Buyer', v: v.buyer, ph: dairy ? 'e.g. Co-op, neighbour' : 'e.g. Hotel, market' }, { k: 'phone', l: 'Buyer phone', t: 'tel', v: v.phone }, { k: 'pay', l: 'Paid by', t: 'select', o: [['cash', 'Cash'], ['mpesa', 'M-Pesa'], ['bank', 'Bank'], ['credit', 'Credit - will pay later']], v: v.pay }, { k: 'paid', l: 'Amount paid now (KSh)', t: 'num', v: v.pay === 'credit' ? v.paid : '' }, { k: 'notes', l: 'Notes / M-Pesa code', v: v.notes }
    ], async o => {
      if (o.pay === 'credit' && !o.buyer) throw new Error('Enter the buyer\'s name for a credit sale');
      if (o.unit === 'bird' && !o.ref) throw new Error('Choose the flock these birds came from');
      if (o.unit === 'bird') { const f = byId('flocks', o.ref), was = s && s.unit === 'bird' && s.ref === o.ref ? num(s.qty) : 0; if (f && num(o.qty) > flockCount(f) + was) throw new Error('That is more birds than this flock has'); }
      if (o.pay !== 'credit') o.paid = '';
      await save('sales', Object.assign(s || { id: uid(), side: 'farmer', ent }, o)); toast('Sale recorded');
    }, { del: s ? () => remove('sales', s.id) : null, onOpen: ov => {
      const tot = () => { const q = num($('f_qty').value), pr = num($('f_price').value); if (q && pr) $('f_total').value = Math.round(q * pr * 100) / 100; };
      const pay = () => $('w_paid').classList.toggle('hide', $('f_pay').value !== 'credit');
      on(ov, '#f_qty', 'input', tot); on(ov, '#f_price', 'input', tot); on(ov, '#f_pay', 'change', pay); pay();
    } });
  },
  anCost(ent, ref, id) {
    const e = id ? byId('expenses', id) : null, dairy = ent === 'dairy';
    if (e && e.log) { if (byId('herdlog', e.log)) A.herdEvent(e.log); else { const fl = byId('flocklog', e.log); if (fl && fl.kind === 'feed') A.flockQty('feed', fl.flock, fl.id); else A.flockEvent(e.log); } toast('This cost belongs to that record - change it there'); return; }
    const cats = (dairy ? DAIRY_COSTS : POULTRY_COSTS).slice(), opts = [['', dairy ? 'Whole herd' : 'All flocks']].concat(dairy ? cowOpts() : flockOpts()), v = e || { date: today(), ref: ref || '', cat: cats[0] };
    if (v.cat && !cats.includes(v.cat)) cats.push(v.cat);
    if (e && e.ref && !opts.some(o => o[0] === e.ref)) opts.push([e.ref, 'Removed']);
    form((e ? 'Edit ' : 'Record ') + (dairy ? 'dairy' : 'poultry') + ' cost', [{ k: 'ref', l: dairy ? 'Cow' : 'Flock', t: 'select', o: opts, v: v.ref }, { k: 'cat', l: 'Type of cost', t: 'select', o: cats, v: v.cat }, { k: 'amount', l: 'Amount (KSh)', t: 'num', v: v.amount, req: 1 }, { k: 'date', l: 'Date', t: 'date', v: v.date, req: 1 }, { k: 'notes', l: 'Notes', v: v.notes }],
      async o => { await save('expenses', Object.assign(e || { id: uid(), side: 'farmer', ent }, o)); toast('Cost recorded'); }, { del: e ? () => remove('expenses', e.id) : null });
  }
};

const TABS = { today: () => isProp() ? todayProp() : todayFarmer(), crops: cropsTab, doctor: doctorTab, money: moneyTab, more: moreTab, batches: batchesTab, orders: ordersTab, animals: animalsTab };

// ================= actions =================
// crop pickers show only the crops this farm chose, plus any crop an existing record already uses
const cropOpts = (withOther, keep) => {
  const mine = prof().crops || [], list = mine.length ? mine.slice() : L.CROPS.map(c => c.id);
  if (keep && keep !== 'other' && !list.includes(keep)) list.push(keep);
  const rest = L.CROPS.some(c => !list.includes(c.id));
  return list.map(id => [id, crop(id).e + ' ' + crop(id).n]).concat(withOther ? [['other', '🌿 Other crop']] : [], rest ? [['__addcrop', '+ Add another crop…']] : []);
};
document.addEventListener('change', e => {
  const el = e.target; if (!el || el.tagName !== 'SELECT' || el.value !== '__addcrop') return;
  el.value = el.options[0].value;   // a real crop stays selected until one is picked
  A.addCrop(el);
}, true);
const fieldOpts = () => [['', 'No field / not set']].concat(D.fields.map(f => [f.id, f.name])).concat([['__new', '+ Add a new field…']]);
const plantOpts = (pid) => [['', 'Not for one crop (general)']].concat(D.plantings.filter(p => p.status !== 'ended' || p.id === pid).map(p => [p.id, pName(p)]));
const batchOpts = (bid) => [['', 'Not for one batch (general)']].concat(D.batches.filter(b => !b.closed || b.id === bid).map(b => [b.id, bName(b) + ' (sown ' + fmtD(b.sow) + ')']));
async function newFieldInline(sel) {
  const name = prompt('Name of the new field or block (e.g. "Block A - near the river")'); if (!name) { sel.value = ''; return; }
  const f = await save('fields', { id: uid(), name: name.trim() }); sel.insertAdjacentHTML('beforeend', '<option value="' + f.id + '">' + esc(f.name) + '</option>'); sel.value = f.id;
}
const c0 = id => crop(id).n;
// ---------------- screen lock (PIN) ----------------
const _hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
function _rsalt() { const a = new Uint8Array(16); if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a); else for (let i = 0; i < 16; i++) a[i] = Math.random() * 256 | 0; return _hex(a.buffer); }
async function hashPin(pin, saltHex, iter) {
  const enc = new TextEncoder();
  if (window.crypto && crypto.subtle) {
    const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
    const base = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, 256);
    return _hex(bits);
  }
  let h = saltHex + '|' + pin; for (let i = 0; i < iter; i++) { let x = 5381; for (let j = 0; j < h.length; j++) x = (x * 33 + h.charCodeAt(j)) >>> 0; h = (x.toString(16)) + h.slice(0, 40); } return h;
}
function lockHtml() {
  const len = (K.lock && K.lock.len) || 4;
  const dots = Array.from({ length: len }, (_, i) => '<span class="pd' + (i < PINBUF.length ? ' on' : '') + '"></span>').join('');
  const keys = ['1','2','3','4','5','6','7','8','9','','0','back'].map(k => k === '' ? '<span></span>' : '<button class="pk" onclick="A.pk(\'' + k + '\')">' + (k === 'back' ? '⌫' : k) + '</button>').join('');
  return '<div class="lock"><img class="logo" src="icons/icon-192-f1.png" alt=""><h1>Farm on the Go</h1>' +
    '<p class="lead">Enter your PIN to open the app</p>' +
    '<div class="pindots">' + dots + '</div>' +
    (PINERR ? '<div class="note bad" style="text-align:center">' + esc(PINERR) + '</div>' : '') +
    '<div class="keys">' + keys + '</div>' +
    '<p class="xs" style="text-align:center;margin-top:18px">Forgot your PIN? <button class="linkbtn" onclick="A.pinForgot()">What to do</button></p></div>';
}
const A = window.A = {
  go, openV: openView,
  async pk(k) {
    if (!LOCKED) return;
    const len = (K.lock && K.lock.len) || 4; PINERR = '';
    if (k === 'back') PINBUF = PINBUF.slice(0, -1); else if (PINBUF.length < len) PINBUF += k;
    if (PINBUF.length === len) return A.pinTry();
    render();
  },
  async pinTry() {
    const L = K.lock; if (!L) { LOCKED = false; return render(); }
    const h = await hashPin(PINBUF, L.salt, L.iter);
    if (h === L.hash) { LOCKED = false; PINBUF = ''; PINERR = ''; render(); }
    else { PINBUF = ''; PINERR = 'Wrong PIN, try again'; if (navigator.vibrate) try { navigator.vibrate(120); } catch (e) {} render(); }
  },
  lockNow() { if (!K.lock) { toast('Set a PIN first'); return A.pinSet(); } LOCKED = true; PINBUF = ''; PINERR = ''; closeAll(); render(); },
  pinForgot() { sheet('Forgot PIN', '<p class="s" style="margin-top:0">The PIN locks the screen so someone who picks up the phone cannot open the app. It does not scramble your records, and a forgotten PIN cannot be recovered from here.</p><p class="s">If you keep a backup file, you can reinstall the app and restore it. As a last resort, clearing this app’s data in your phone’s browser settings removes the lock, but it also erases the records on this phone — so back up first.</p>', { noFocus: true }); },
  pinSet() {
    const has = !!K.lock;
    sheet(has ? 'Change or remove PIN' : 'Set a PIN',
      (has ? '<div class="fld"><span>Current PIN</span><input id="pinCur" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>' : '') +
      '<div class="fld"><span>' + (has ? 'New PIN' : 'PIN') + ' (4 to 6 digits)</span><input id="pinNew" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>' +
      '<div class="fld"><span>Repeat ' + (has ? 'new ' : '') + 'PIN</span><input id="pinNew2" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>' +
      '<div id="pinMsg"></div><button class="btn pri wide" onclick="A.pinSave()">' + (has ? 'Save new PIN' : 'Turn on lock') + '</button>' +
      (has ? '<div style="height:8px"></div><button class="btn bad wide" onclick="A.pinRemove()">Remove the lock</button>' : ''), { noFocus: true });
  },
  async pinSave() {
    const set = m => { $('pinMsg').innerHTML = '<div class="note bad">' + esc(m) + '</div>'; };
    const a = ($('pinNew').value || '').trim(), b = ($('pinNew2').value || '').trim();
    if (K.lock) { const cur = $('pinCur') ? $('pinCur').value : ''; const h = await hashPin(cur, K.lock.salt, K.lock.iter); if (h !== K.lock.hash) return set('Current PIN is wrong'); }
    if (!/^[0-9]{4,6}$/.test(a)) return set('Use 4 to 6 digits');
    if (a !== b) return set('The two PINs do not match');
    const salt = _rsalt(), iter = 120000, hash = await hashPin(a, salt, iter);
    await setK('lock', { salt, iter, hash, len: a.length });
    closeAll(); render(); toast('Screen lock on');
  },
  async pinRemove() {
    const cur = $('pinCur') ? $('pinCur').value : '';
    if (K.lock) { const h = await hashPin(cur, K.lock.salt, K.lock.iter); if (h !== K.lock.hash) { $('pinMsg').innerHTML = '<div class="note bad">Enter your current PIN to remove the lock</div>'; return; } }
    await setK('lock', null); LOCKED = false; closeAll(); render(); toast('Screen lock removed');
  },
  addCrop(sel) {
    const mine = prof().crops || [], rest = L.CROPS.filter(c => !mine.includes(c.id));
    const ov = sheet('Add another crop', '<div class="chips">' + rest.map(c => '<button class="chip" data-c="' + c.id + '">' + c.e + ' ' + esc(c.n) + '</button>').join('') + '</div>', { noFocus: true });
    ov.querySelector('.chips').onclick = async e => {
      const b = e.target.closest('[data-c]'); if (!b) return;
      await setK('profile', Object.assign({}, prof(), { crops: mine.concat([b.dataset.c]) }));
      closeSheet(false, ov);
      if (sel && document.body.contains(sel)) {
        const c = crop(b.dataset.c), o = new Option(c.e + ' ' + c.n, c.id), at = [...sel.options].find(x => x.value === 'other' || x.value === '__addcrop');
        sel.insertBefore(o, at || null); sel.value = c.id; sel.dispatchEvent(new Event('change', { bubbles: true }));
      } else render();
      toast(c0(b.dataset.c) + ' added');
    };
  },
  myCrops() {
    const mine = prof().crops || [];
    const ov = sheet('My crops', '<p class="s" style="margin-top:0">Only these show when you add a planting or batch. Records you already have are kept.</p><div class="chips" id="myCropChips">' + L.CROPS.map(c => '<button class="chip ' + (mine.includes(c.id) ? 'on' : '') + '" data-c="' + c.id + '" onclick="this.classList.toggle(\'on\')">' + c.e + ' ' + esc(c.n) + '</button>').join('') + '</div><button class="btn pri wide" style="margin-top:16px" id="myCropSave">Save</button>', { noFocus: true });
    ov.querySelector('#myCropSave').onclick = async () => { await setK('profile', Object.assign({}, prof(), { crops: [...ov.querySelectorAll('#myCropChips .chip.on')].map(b => b.dataset.c) })); closeSheet(false, ov); render(); toast('Crops updated'); };
  },
  wRole(r) { W.role = r; render(); setTimeout(() => { const e = $('f_w_name'); e && e.focus(); }, 50); },
  async wDone() {
    const name = $('f_w_name').value.trim(); if (!name) { $('wMsg').innerHTML = '<div class="note bad">Please enter your name</div>'; return; }
    const crops = [...document.querySelectorAll('#wCrops .chip.on')].map(b => b.dataset.c);
    await setK('profile', { role: W.role, name, farm: $('f_w_farm').value.trim(), county: $('f_w_county').value.trim(), phone: $('f_w_phone').value.trim(), crops, since: today(), activities: [W.role === 'farmer' ? 'crops' : 'nursery'].concat([...document.querySelectorAll('#wEnts .chip.on')].map(b => b.dataset.e)) });
    S.tab = 'today'; render(); toast('Welcome to Farm on the Go');
  },
  profile() {
    const p = prof();
    form('Your details', [{ k: 'name', l: 'Your name', v: p.name, req: 1 }, { k: 'farm', l: isProp() ? 'Nursery name' : 'Farm name', v: p.farm }, { k: 'county', l: 'County / area', v: p.county }, { k: 'phone', l: 'Phone', t: 'tel', v: p.phone }], async o => { await setK('profile', Object.assign({}, p, o)); });
  },
  async switchRole() {
    const to = isProp() ? 'farmer' : 'propagator';
    if (!await ask('Switch to the ' + to + ' side? Your records on both sides are kept - you can switch back any time from More.', 'Switch')) return;
    await setK('profile', Object.assign({}, prof(), { role: to })); go('today'); toast('Now on the ' + to + ' side');
  },
  theme() { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = t; try { localStorage.setItem('fog_theme', t); } catch (e) {} render(); },
  // ----- fields -----
  fields() {
    const list = () => D.fields.map(f => { const n = activePlantings().filter(p => p.field === f.id).length; return '<div class="li"><div class="em">🗺️</div><div class="grow"><div class="t">' + esc(f.name) + '</div><div class="s">' + (f.size ? fmtN(num(f.size)) + ' acre · ' : '') + plural(n, 'crop') + ' growing' + (f.notes ? ' · ' + esc(f.notes) : '') + '</div></div><button class="btn sm" onclick="A.editField(\'' + f.id + '\')">Edit</button></div>'; }).join('');
    sheet('Fields and blocks', '<div class="card list">' + (D.fields.length ? list() : '<div class="s">No fields yet. Name each block of land so you know where every crop is.</div>') + '</div><button class="btn pri wide" onclick="A.editField()">+ Add a field</button>');
  },
  editField(id) {
    const f = id ? byId('fields', id) : null; if (sheetStack.length) closeSheet();
    form(f ? 'Edit field' : 'New field', [{ k: 'name', l: 'Name', v: f && f.name, req: 1, ph: 'e.g. Block A, Greenhouse 1' }, { k: 'size', l: 'Size (acres)', t: 'num', v: f && f.size, ph: 'e.g. 0.5' }, { k: 'notes', l: 'Notes (soil, water source…)', v: f && f.notes }], async o => { await save('fields', Object.assign(f || { id: uid() }, o)); toast('Field saved'); },
      { del: f && !D.plantings.some(p => p.field === f.id) ? () => remove('fields', f.id) : null });
  },
  // ----- plantings -----
  newPlanting(pre) { A.editPlanting(null, pre); },
  editPlanting(id, pre) {
    const p = id ? byId('plantings', id) : null, v = p || Object.assign({ crop: (prof().crops || [])[0] || 'tomato', date: today() }, pre || {});
    const c0 = crop(v.crop);
    const fields = [
      { k: 'crop', l: 'Crop', t: 'select', o: cropOpts(true, v.crop), v: v.crop, req: 1 },
      { k: 'cropName', l: 'Crop name', v: v.cropName, ph: 'e.g. Chilli, Coriander' },
      { k: 'variety', l: 'Variety', v: v.variety, list: c0.varieties || [], ph: 'e.g. ' + ((c0.varieties || [])[0] || '') },
      { k: 'field', l: 'Field / block', t: 'select', o: fieldOpts(), v: v.field || '' },
      { k: 'date', l: dateLabel(v.crop), t: 'date', v: v.date, req: 1, hint: '' },
      { k: 'area', l: 'Area (acres)', t: 'num', v: v.area, ph: 'e.g. 0.25' },
      { k: 'plants', l: 'Number of plants / seedlings', t: 'num', v: v.plants, hint: '' },
      { k: 'source', l: 'Seedlings / seed from', v: v.source, ph: 'e.g. Green Seedlings Nursery, own seed' },
      { k: 'notes', l: 'Notes', t: 'area', v: v.notes },
      { k: 'sorder', t: 'hidden', v: v.sorder || '' }
    ];
    form(p ? 'Edit planting' : 'New planting', fields, async o => {
      if (o.crop === 'other' && !o.cropName) throw new Error('Please enter the crop name');
      if (o.field === '__new') o.field = '';
      const rec = Object.assign(p || { id: uid(), status: 'active', done: {}, extra: [] }, o);
      if (!p && rec.sorder) { const so = byId('sorders', rec.sorder); if (so) await save('sorders', Object.assign(so, { status: 'collected' })); }
      // a planting entered late: care jobs older than 3 weeks are taken as done already
      if (!p) { const back = age(rec); if (back > 21) tasksOf(rec).forEach(t => { if (dd(t.due, today()) > 21) rec.done[t.key] = 'past'; }); }
      await save('plantings', rec); toast(p ? 'Planting saved' : 'Planting added - its calendar is ready');
      if (!p) { S.tab = 'crops'; S.view = { t: 'planting', id: rec.id }; history.pushState({ view: 1 }, ''); }
    }, { del: p ? async () => { await remove('plantings', p.id); S.view = null; } : null, onOpen: (ov) => {
      const upd = () => { const cid = $('f_crop').value, c = crop(cid); $('w_cropName').classList.toggle('hide', cid !== 'other'); $('w_date').querySelector('span').textContent = dateLabel(cid) + ' *';
        $('f_variety_l').innerHTML = (c.varieties || []).map(x => '<option value="' + esc(x) + '">').join('');
        const d = $('f_date').value; $('h_date').innerHTML = cid !== 'other' && d ? 'First harvest about <b>' + fmtD(addD(d, c.first)) + '</b>' + (c.nursery && c.grow !== 'direct' ? ' · seedlings need ' + Math.round(c.nursery / 7) + ' weeks in the nursery before this date' : '') : '';
        const ar = num($('f_area').value); $('h_plants').innerHTML = cid !== 'other' && ar && c.space ? 'At ' + c.space[0] + ' × ' + c.space[1] + ' cm that is about <b>' + fmtN(Math.round(ar * 4047 / (c.space[0] / 100 * c.space[1] / 100))) + '</b> plants. <a href="#" onclick="event.preventDefault();A.fillPlants()">Use this</a>' : ''; };
      on(ov, '#f_crop', 'change', upd); on(ov, '#f_date', 'change', upd); on(ov, '#f_area', 'input', upd);
      on(ov, '#f_field', 'change', e => { if (e.target.value === '__new') newFieldInline(e.target); }); upd(); } });
  },
  fillPlants() { const c = crop($('f_crop').value), ar = num($('f_area').value); $('f_plants').value = Math.round(ar * 4047 / (c.space[0] / 100 * c.space[1] / 100)); },
  openP(id) { openView({ t: 'planting', id }); },
  pTab(t) { S.view.tab = t; render(); },
  async taskDone(pid, key) {
    const p = byId('plantings', pid), t = tasksOf(p).find(x => x.key === key); if (!t) return;
    A.newAct(pid, { type: t.type === 'harvest' ? 'other' : t.type, title: t.t, taskKey: key, date: today() }, t.type === 'harvest');
  },
  async taskSkip(pid, key) { const p = byId('plantings', pid); p.done = p.done || {}; p.done[key] = 'skip'; await save('plantings', p); render(); },
  addReminder(pid) {
    form('My own reminder', [{ k: 't', l: 'What to do', req: 1, ph: 'e.g. Apply foliar feed' }, { k: 'type', l: 'Type', t: 'select', o: Object.keys(TT).map(k => [k, TT[k][1] + ' ' + TT[k][0]]), v: 'other' }, { k: 'date', l: 'When', t: 'date', v: addD(today(), 1), req: 1 }, { k: 'x', l: 'Details', v: '' }],
      async o => { const p = byId('plantings', pid); p.extra = (p.extra || []).concat([Object.assign({ id: uid() }, o)]); await save('plantings', p); toast('Reminder added'); });
  },
  async endPlanting(id) {
    const p = byId('plantings', id); if (!await ask('End this planting? It moves to "Ended plantings" with its records and profit, and its reminders stop.', 'End planting')) return;
    p.status = 'ended'; p.ended = today(); await save('plantings', p); render(); toast('Planting ended');
  },
  async reopenPlanting(id) { const p = byId('plantings', id); p.status = 'active'; delete p.ended; await save('plantings', p); render(); },
  // ----- activities -----
  newAct(pid, pre, thenHarvest) { A.editAct(null, pid, pre, thenHarvest); },
  editAct(id, pid, pre, thenHarvest) {
    const a = id ? byId('acts', id) : null, v = a || Object.assign({ pid: pid || (activePlantings()[0] || {}).id || '', date: today(), type: 'spray' }, pre || {});
    if (!D.plantings.length) { toast('Add a planting first'); A.newPlanting(); return; }
    const fields = [
      { k: 'pid', l: 'Crop', t: 'select', o: plantOpts(v.pid).slice(1), v: v.pid, req: 1 },
      { k: 'type', l: 'What did you do?', t: 'select', o: Object.keys(TT).filter(k => k !== 'harvest').map(k => [k, TT[k][1] + ' ' + TT[k][0]]), v: v.type },
      { k: 'title', l: 'Description', v: v.title, ph: 'e.g. Sprayed for blight' },
      { k: 'date', l: 'Date', t: 'date', v: v.date, req: 1 },
      { k: 'product', l: 'Product used', v: v.product, ph: 'e.g. the product name on the pack' },
      { k: 'ai', l: 'Active ingredient (on the label)', v: v.ai, ph: 'e.g. mancozeb' },
      { k: 'rate', l: 'Rate / amount', v: v.rate, ph: 'e.g. 40 g per 20 L, 1 bag CAN' },
      { k: 'phi', l: 'Waiting period before harvest (PHI, days, on the label)', t: 'num', v: v.phi, ph: 'e.g. 7' },
      { k: 'cost', l: 'Cost (KSh) - adds to your expenses', t: 'num', v: v.cost },
      { k: 'notes', l: 'Notes (weather, what you saw)', t: 'area', v: v.notes }
    ];
    form(a ? 'Edit record' : 'Record an activity', fields, async o => {
      const rec = Object.assign(a || { id: uid(), taskKey: v.taskKey }, o);
      if (!rec.title) rec.title = ttName(rec.type);
      await save('acts', rec);
      // its cost is one expense, kept in step with the record
      let ex = D.expenses.find(e => e.act === rec.id);
      if (num(rec.cost) > 0) await save('expenses', Object.assign(ex || { id: uid(), act: rec.id, side: 'farmer' }, { date: rec.date, pid: rec.pid, cat: ACT_COST_CAT[rec.type] || 'Other', amount: num(rec.cost), notes: rec.title + (rec.product ? ' - ' + rec.product : '') }));
      else if (ex) await remove('expenses', ex.id);
      if (rec.taskKey) { const p = byId('plantings', rec.pid); if (p) { p.done = p.done || {}; p.done[rec.taskKey] = 'done'; await save('plantings', p); } }
      toast('Saved'); if (thenHarvest) setTimeout(() => A.newHarvest(rec.pid), 50);
    }, { del: a ? async () => { const ex = D.expenses.find(e => e.act === a.id); if (ex) await remove('expenses', ex.id); await remove('acts', a.id); } : null, onOpen: ov => {
      const upd = () => { const t = $('f_type').value, chem = t === 'spray' || t === 'fertilise'; ['product', 'ai', 'rate'].forEach(k => $('w_' + k).classList.toggle('hide', !chem)); $('w_phi').classList.toggle('hide', t !== 'spray'); };
      on(ov, '#f_type', 'change', upd); upd();
      if (thenHarvest) $('formMsg').innerHTML = '<div class="note">Save this, then record how much you harvested.</div>'; } });
  },
  // ----- harvests -----
  newHarvest(pid) { A.editHarvest(null, pid); },
  editHarvest(id, pid) {
    const h = id ? byId('harvests', id) : null, v = h || { pid: pid || (activePlantings()[0] || {}).id, date: today() };
    if (!D.plantings.length) { toast('Add a planting first'); return; }
    const p0 = byId('plantings', v.pid), c = crop(p0 && p0.crop);
    form(h ? 'Edit harvest' : 'Record a harvest', [
      { k: 'pid', l: 'Crop', t: 'select', o: plantOpts(v.pid).slice(1), v: v.pid, req: 1 },
      { k: 'date', l: 'Date', t: 'date', v: v.date, req: 1 },
      { k: 'qty', l: 'Quantity', t: 'num', v: v.qty, req: 1 },
      { k: 'unit', l: 'Unit', t: 'select', o: (c.units || ['kg']).concat(['kg', 'crate', 'bag', 'bunch', 'piece', 'head']).filter((x, i, a) => a.indexOf(x) === i), v: v.unit || c.unit },
      { k: 'grade', l: 'Grade', t: 'select', o: [['', 'Not graded'], 'Grade 1', 'Grade 2', 'Rejects', 'Mixed'], v: v.grade || '' },
      { k: 'notes', l: 'Notes', v: v.notes }
    ], async o => { await save('harvests', Object.assign(h || { id: uid() }, o)); toast('Harvest recorded'); if (!h) setTimeout(async () => { if (await ask('Did you sell this harvest now?', 'Record the sale', 'Not yet')) A.newSale(o.pid, null, { qty: o.qty, unit: o.unit }); }, 60); },
    { del: h ? () => remove('harvests', h.id) : null, onOpen: ov => { const chk = () => { const f = phiUntil($('f_pid').value), d = $('f_date').value; $('formMsg').innerHTML = f && d < f.until ? '<div class="note bad">⚠️ The waiting period after spraying ' + esc(f.prod) + ' runs until <b>' + fmtD(f.until) + '</b>. Harvesting earlier can leave harmful residues on the produce.</div>' : ''; }; on(ov, '#f_pid', 'change', chk); on(ov, '#f_date', 'change', chk); chk(); } });
  },
  // ----- sales -----
  newSale(pid, bid, pre) { A.editSale(null, pid, bid, pre); },
  editSale(id, pid, bid, pre) {
    const s = id ? byId('sales', id) : null, prop = isProp();
    if (s && s.ent) return A.anSale(s.ent, null, s.id);
    const v = s || Object.assign({ date: today(), pay: 'cash', pid: pid || '', batch: bid || '' }, pre || {});
    if (!s && prop && v.batch && !v.price) v.price = (byId('batches', v.batch) || {}).price;
    const p0 = v.pid && byId('plantings', v.pid), c = crop(p0 ? p0.crop : '');
    const fields = [
      prop ? { k: 'batch', l: 'Seedling batch', t: 'select', o: batchOpts(v.batch), v: v.batch } : { k: 'pid', l: 'Crop sold', t: 'select', o: plantOpts(v.pid), v: v.pid },
      { k: 'what', l: 'What was sold', v: v.what, ph: prop ? 'e.g. Trays, seedlings' : 'e.g. Tomatoes grade 1' },
      { k: 'date', l: 'Date', t: 'date', v: v.date, req: 1 },
      { k: 'qty', l: prop ? 'Number of seedlings' : 'Quantity', t: 'num', v: v.qty },
      prop ? { k: 'unit', t: 'hidden', v: 'seedlings' } : { k: 'unit', l: 'Unit', t: 'select', o: (p0 ? c.units : ['kg']).concat(['kg', 'crate', 'bag', 'bunch', 'piece', 'head', 'net bag']).filter((x, i, a) => a.indexOf(x) === i), v: v.unit || (p0 ? c.unit : 'kg') },
      { k: 'price', l: 'Price per unit (KSh)', t: 'num', v: v.price },
      { k: 'total', l: 'Total (KSh)', t: 'num', v: s ? saleTotal(s) : v.total, req: 1 },
      { k: 'buyer', l: 'Buyer', v: v.buyer, list: [...new Set(D.sales.map(x => x.buyer).filter(Boolean))], ph: 'e.g. Mama Njeri, broker, market' },
      { k: 'phone', l: 'Buyer phone', t: 'tel', v: v.phone },
      { k: 'pay', l: 'Paid by', t: 'select', o: [['cash', 'Cash'], ['mpesa', 'M-Pesa'], ['bank', 'Bank'], ['credit', 'Credit - will pay later']], v: v.pay },
      { k: 'paid', l: 'Amount paid now (KSh)', t: 'num', v: v.pay === 'credit' ? v.paid : '' },
      { k: 'notes', l: 'Notes / M-Pesa code', v: v.notes }
    ];
    form(s ? 'Edit sale' : 'Record a sale', fields, async o => {
      if (o.pay === 'credit' && !o.buyer) throw new Error('Enter the buyer\'s name for a credit sale');
      if (o.pay !== 'credit') o.paid = '';
      await save('sales', Object.assign(s || { id: uid(), side: isProp() ? 'propagator' : 'farmer' }, o)); toast('Sale recorded');
    }, { del: s ? () => remove('sales', s.id) : null, onOpen: ov => {
      const tot = () => { const q = num($('f_qty').value), pr = num($('f_price').value); if (q && pr) $('f_total').value = Math.round(q * pr * 100) / 100; };
      const pay = () => $('w_paid').classList.toggle('hide', $('f_pay').value !== 'credit');
      on(ov, '#f_qty', 'input', tot); on(ov, '#f_price', 'input', tot); on(ov, '#f_pay', 'change', pay); pay();
      on(ov, '#f_batch', 'change', e => { const b = byId('batches', e.target.value); if (b && b.price && !$('f_price').value) { $('f_price').value = b.price; tot(); } });
    } });
  },
  async payIn(kind, id) {
    const r = kind === 's' ? byId('sales', id) : byId('orders', id), total = kind === 's' ? saleTotal(r) : num(r.qty) * num(r.price), paid = kind === 's' ? salePaid(r) : num(r.paid);
    form('Payment received', [{ k: 'amt', l: 'Amount received (KSh) - owed ' + ksh(total - paid), t: 'num', v: total - paid, req: 1 }, { k: 'how', l: 'Paid by', t: 'select', o: [['mpesa', 'M-Pesa'], ['cash', 'Cash'], ['bank', 'Bank']] }],
      async o => { const np = Math.min(total, paid + num(o.amt)); if (kind === 's') { r.paid = np; if (np >= total) r.pay = o.how; } else r.paid = np; r.payments = (r.payments || []).concat([{ date: today(), amt: num(o.amt), how: o.how }]); await save(kind === 's' ? 'sales' : 'orders', r); toast('Payment recorded'); });
  },
  // ----- expenses -----
  newExpense(pid, bid) { A.editExpense(null, pid, bid); },
  editExpense(id, pid, bid) {
    const e = id ? byId('expenses', id) : null, prop = isProp(), v = e || { date: today(), pid: pid || '', batch: bid || '', cat: prop ? NURSERY_COSTS[0] : FARM_COSTS[0] };
    if (e && e.ent) return A.anCost(e.ent, null, e.id);
    if (e && e.act) { toast('This cost belongs to an activity record - edit it there'); A.editAct(e.act); return; }
    const cats = (prop ? NURSERY_COSTS : FARM_COSTS); if (v.cat && !cats.includes(v.cat)) cats.push(v.cat);
    form(e ? 'Edit expense' : 'Record an expense', [
      prop ? { k: 'batch', l: 'For which batch', t: 'select', o: batchOpts(v.batch), v: v.batch } : { k: 'pid', l: 'For which crop', t: 'select', o: plantOpts(v.pid), v: v.pid },
      { k: 'cat', l: 'Type of cost', t: 'select', o: cats, v: v.cat },
      { k: 'amount', l: 'Amount (KSh)', t: 'num', v: v.amount, req: 1 },
      { k: 'date', l: 'Date', t: 'date', v: v.date, req: 1 },
      { k: 'notes', l: 'Details', v: v.notes, ph: 'e.g. 2 bags CAN, 3 casuals for weeding' }
    ], async o => { if (!(num(o.amount) > 0)) throw new Error('Enter the amount'); await save('expenses', Object.assign(e || { id: uid(), side: isProp() ? 'propagator' : 'farmer' }, o)); toast('Expense recorded'); }, { del: e ? () => remove('expenses', e.id) : null });
  },
  moneyP(p) { S.moneyP = p; render(); },
  exportCsv() {
    const rows = [['Type', 'Date', 'Crop / batch', 'Details', 'Quantity', 'Unit', 'Amount KSh', 'Paid KSh', 'Payment']];
    D.sales.filter(mine).forEach(s => { const p = s.pid && byId('plantings', s.pid), b = s.batch && byId('batches', s.batch); rows.push(['Sale', s.date, p ? pName(p) : b ? bName(b) : '', [s.what, s.buyer].filter(Boolean).join(' - '), s.qty, s.unit, saleTotal(s), salePaid(s), s.pay]); });
    (isProp() ? D.orders : []).filter(o => o.status === 'collected').forEach(o => { const b = byId('batches', o.batch); rows.push(['Seedling order', o.collected || o.date, b ? bName(b) : '', o.name, o.qty, 'seedlings', num(o.qty) * num(o.price), num(o.paid), o.pay || '']); });
    myExp().forEach(e => { const p = e.pid && byId('plantings', e.pid), b = e.batch && byId('batches', e.batch); rows.push(['Expense', e.date, p ? pName(p) : b ? bName(b) : 'General', e.cat + (e.notes ? ' - ' + e.notes : ''), '', '', -num(e.amount), '', '']); });
    rows.sort((a, b) => a[0] === 'Type' ? -1 : b[0] === 'Type' ? 1 : a[1] < b[1] ? -1 : 1);
    download((isProp() ? 'nursery' : 'farm') + '-money-' + today() + '.csv', rows.map(r => r.map(x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"').join(',')).join('\n'), 'text/csv');
  },
  // ----- seedling orders a farmer placed -----
  seedOrders() {
    const os = D.sorders.slice().sort((a, b) => a.ready < b.ready ? -1 : 1);
    sheet('Seedlings I ordered', '<div class="note">Order from a nursery by phone or WhatsApp, then note it here - the app reminds you when the seedlings are ready to plant.</div>' + (os.length ? '<div class="card list">' + os.map(o => '<div class="li"><div class="em">' + cropEm(o.crop) + '</div><div class="grow"><div class="t">' + plural(num(o.qty), 'seedling') + ' · ' + esc(crop(o.crop).n) + (o.variety ? ' ' + esc(o.variety) : '') + '</div><div class="s">' + esc(o.nursery || '') + ' · ready ' + fmtD(o.ready) + ' · ' + esc({ waiting: 'waiting', ready: 'ready', collected: 'collected and planted', cancelled: 'cancelled' }[o.status]) + '</div></div><button class="btn sm" onclick="A.editSOrder(\'' + o.id + '\')">Edit</button></div>').join('') + '</div>' : '') + '<button class="btn pri wide" onclick="A.editSOrder()">+ Seedlings I ordered</button>');
  },
  editSOrder(id) {
    const o = id ? byId('sorders', id) : null, v = o || { date: today(), crop: (prof().crops || [])[0] || 'tomato', status: 'waiting' }; if (sheetStack.length) closeSheet();
    form(o ? 'Edit seedling order' : 'Seedlings I ordered', [
      { k: 'crop', l: 'Crop', t: 'select', o: cropOpts(false, v.crop), v: v.crop }, { k: 'variety', l: 'Variety', v: v.variety }, { k: 'qty', l: 'Number of seedlings', t: 'num', v: v.qty, req: 1 },
      { k: 'nursery', l: 'Nursery / propagator', v: v.nursery, list: [...new Set(D.sorders.map(x => x.nursery).filter(Boolean))], req: 1 }, { k: 'phone', l: 'Nursery phone', t: 'tel', v: v.phone },
      { k: 'ready', l: 'Ready date (as the nursery told you)', t: 'date', v: v.ready || addD(today(), crop(v.crop).nursery || 30), req: 1 },
      { k: 'price', l: 'Price per seedling (KSh)', t: 'num', v: v.price },
      { k: 'status', l: 'Status', t: 'select', o: [['waiting', 'Waiting'], ['collected', 'Collected and planted'], ['cancelled', 'Cancelled']], v: v.status }
    ], async r => { const rec = await save('sorders', Object.assign(o || { id: uid() }, r));
      if (!o && r.phone) setTimeout(async () => { if (await ask('Send this order to the nursery on WhatsApp?', 'Open WhatsApp', 'No')) window.open(waLink(r.phone, 'Hello ' + r.nursery + ', I would like to order ' + fmtN(num(r.qty)) + ' ' + crop(r.crop).n + (r.variety ? ' (' + r.variety + ')' : '') + ' seedlings, ready by ' + fmtD(r.ready) + '. Please confirm. - ' + (prof().name || '')), '_blank'); }, 60);
      if (!o && r.price) await save('expenses', { id: uid(), side: 'farmer', date: today(), pid: '', cat: 'Seed / seedlings', amount: num(r.price) * num(r.qty), notes: 'Seedlings from ' + r.nursery, sorder: rec.id }) && toast('Seedling cost added to expenses');
    }, { del: o ? () => remove('sorders', o.id) : null, onOpen: ov => on(ov, '#f_crop', 'change', e => { if (!o) $('f_ready').value = addD(today(), crop(e.target.value).nursery || 30); }) });
  },
  plantFromOrder(id) {
    const o = byId('sorders', id); A.newPlanting({ crop: o.crop, variety: o.variety, plants: o.qty, source: o.nursery, sorder: o.id, date: today() });
  },
  calc() {
    sheet('Seedling calculator', fieldHtml({ k: 'cc', l: 'Crop', t: 'select', o: cropOpts(false) }) + fieldHtml({ k: 'ca', l: 'Land (acres)', t: 'num', v: 0.25 }) + '<div id="cOut" class="note good"></div><p class="xs">Uses the usual spacing for the crop and adds 10% for gaps and losses.</p>', { onOpen: ov => {
      const up = () => { const c = crop($('f_cc').value), a = num($('f_ca').value), n = Math.round(a * 4047 / (c.space[0] / 100 * c.space[1] / 100)); $('cOut').innerHTML = 'Spacing ' + c.space[0] + ' × ' + c.space[1] + ' cm → about <b>' + fmtN(n) + ' plants</b>. Order about <b>' + fmtN(Math.ceil(n * 1.1 / 10) * 10) + '</b>' + (c.grow === 'nursery' ? ' seedlings, ' + Math.round(c.nursery / 7) + ' weeks before you plan to transplant.' : c.grow === 'direct' ? ' seeds (direct sown).' : '.'); };
      on(ov, '#f_cc', 'change', up); on(ov, '#f_ca', 'input', up); up(); } });
  },
  // ----- plant doctor -----
  dxCrop(c) { DX.crop = c; DX.sym = []; DX.ai = null; render(); },
  doctorFor(pid) { const p = byId('plantings', pid); DX = { crop: p.crop === 'other' ? '' : p.crop, pid, sym: [], photo: null, small: null, ai: null }; go('doctor'); },
  dxPhoto() { $('dxFile').click(); },
  async dxFile(inp) {
    const f = inp.files && inp.files[0]; if (!f) return;
    try { DX.photo = await shrink(f, 1024, 0.8); DX.small = await shrink(f, 360, 0.7); DX.ai = null; render(); } catch (e) { toast(e.message); }
  },
  dxClearPhoto() { DX.photo = DX.small = null; DX.ai = null; render(); },
  dxSym(s) { const i = DX.sym.indexOf(s); if (i >= 0) DX.sym.splice(i, 1); else DX.sym.push(s); render(); },
  async dxSave() {
    const r = rankProblems(DX.crop, DX.sym);
    await save('dx', { id: uid(), date: today(), crop: DX.crop, pid: DX.pid || '', symptoms: DX.sym.slice(), top: r[0] ? r[0].p.n : '', photo: DX.small, ai: DX.ai && !DX.ai.error ? DX.ai : null, aiPending: !!DX.photo && !DX.ai });
    if (DX.pid) { const p = byId('plantings', DX.pid); if (p) await save('acts', { id: uid(), pid: p.id, date: today(), type: 'scout', title: 'Plant check: ' + (r[0] ? r[0].p.n : 'not sure'), notes: DX.sym.map(s => L.SYMPTOMS[s]).join('; ') }); }
    DX = { crop: DX.crop, pid: DX.pid, sym: [], photo: null, small: null, ai: null }; render(); toast('Check saved' + (DX.pid ? ' to the crop\'s records' : ''));
  },
  async dxDel(id) { if (await ask('Delete this check?', 'Delete', 'Keep', true)) { await remove('dx', id); render(); } },
  async dxAI() {
    if (!navigator.onLine) { toast('No internet - the AI check needs a connection. Save the check and try later.'); return; }
    DX.busy = true; render();
    try {
      const sv = K.server, r = await fetch(sv.url.replace(/\/+$/, '') + '/functions/v1/plant-doctor', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: sv.key || '', Authorization: 'Bearer ' + (sv.key || '') }, body: JSON.stringify({ crop: crop(DX.crop).n, symptoms: DX.sym.map(s => L.SYMPTOMS[s]), image: DX.photo.split(',')[1] }) });
      const j = await r.json().catch(() => ({})); DX.ai = r.ok ? j : { error: j.error || 'The plant doctor could not be reached (' + r.status + ')' };
    } catch (e) { DX.ai = { error: 'The plant doctor could not be reached - check the internet and try again' }; }
    DX.busy = false; render();
  },
  // ----- propagator: batches -----
  newBatch() { A.editBatch(); },
  editBatch(id) {
    const b = id ? byId('batches', id) : null, v = b || { sow: today(), crop: (prof().crops || [])[0] || 'tomato', trays: 10, cells: 200, germ: 85 };
    form(b ? 'Edit batch' : 'New seedling batch', [
      { k: 'crop', l: 'Crop', t: 'select', o: cropOpts(false, v.crop), v: v.crop, req: 1 },
      { k: 'variety', l: 'Variety', v: v.variety, list: crop(v.crop).varieties || [] },
      { k: 'sow', l: 'Sowing date', t: 'date', v: v.sow, req: 1 },
      { k: 'ready', l: 'Ready date', t: 'date', v: v.ready || addD(v.sow, crop(v.crop).nursery || 30), req: 1, hint: '' },
      { k: 'trays', l: 'Number of trays', t: 'num', v: v.trays, req: 1 },
      { k: 'cells', l: 'Cells per tray', t: 'select', o: [['98', '98'], ['128', '128'], ['150', '150'], ['200', '200'], ['288', '288'], ['1', 'Pots / bags (1 per tray)']], v: String(v.cells) },
      { k: 'germ', l: 'Germination % (expected, until you count)', t: 'num', v: v.germ },
      { k: 'price', l: 'Price per seedling (KSh)', t: 'num', v: v.price, ph: 'e.g. 3' },
      { k: 'seedCost', l: b ? 'Seed cost (KSh) - change it under Money' : 'Seed cost (KSh) - adds to your expenses', t: 'num', v: '' },
      { k: 'notes', l: 'Notes (seed lot, location in the nursery)', t: 'area', v: v.notes }
    ], async o => {
      const sc = num(o.seedCost); delete o.seedCost; o.cells = num(o.cells); const rec = await save('batches', Object.assign(b || { id: uid() }, o));
      if (sc > 0) await save('expenses', { id: uid(), side: 'propagator', date: o.sow, batch: rec.id, cat: 'Seed', amount: sc, notes: 'Seed for ' + bName(rec) });
      toast(b ? 'Batch saved' : 'Batch added'); if (!b) { S.tab = 'batches'; S.view = { t: 'batch', id: rec.id }; history.pushState({ view: 1 }, ''); }
    }, { del: b ? async () => { if (D.orders.some(o => o.batch === b.id)) { toast('This batch has orders - close it instead'); throw new Error('This batch has orders - close it instead of deleting'); } await remove('batches', b.id); S.view = null; } : null, onOpen: ov => {
      if (b) $('w_seedCost').classList.add('hide');
      let touched = !!b; on(ov, '#f_ready', 'change', () => { touched = true; });
      const up = () => { const c = crop($('f_crop').value); if (!touched) $('f_ready').value = addD($('f_sow').value || today(), c.nursery || 30); $('h_ready').innerHTML = c.n + ' seedlings are usually ready about ' + (c.nursery >= 60 ? Math.round(c.nursery / 30) + ' months' : Math.round(c.nursery / 7) + ' weeks') + ' after sowing.'; $('f_variety_l').innerHTML = (c.varieties || []).map(x => '<option value="' + esc(x) + '">').join(''); };
      on(ov, '#f_crop', 'change', up); on(ov, '#f_sow', 'change', up); up(); } });
  },
  openB(id) { openView({ t: 'batch', id }); },
  germ(id) {
    const b = byId('batches', id), total = num(b.trays) * num(b.cells);
    form('Germination count', [{ k: 'up', l: 'How many seedlings came up (of ' + fmtN(total) + ' cells)?', t: 'num', v: b.germAt ? Math.round(total * num(b.germ) / 100) : '', req: 1, hint: 'Count a few trays and multiply, if easier.' }], async o => {
      const n = num(o.up); if (n > total) throw new Error('That is more than the cells sown (' + fmtN(total) + ')');
      b.germ = Math.round(n / total * 1000) / 10; b.germAt = today(); await save('batches', b); toast('Germination ' + b.germ + '% - stock updated');
    });
  },
  lost(id) {
    const b = byId('batches', id);
    form('Seedlings lost or thrown away', [{ k: 'n', l: 'How many more were lost (disease, damage, too old)?', t: 'num', req: 1 }, { k: 'why', l: 'Why', v: '' }], async o => { b.lost = num(b.lost) + num(o.n); b.notes = (b.notes ? b.notes + '\n' : '') + fmtD(today()) + ': ' + fmtN(num(o.n)) + ' lost' + (o.why ? ' - ' + o.why : ''); await save('batches', b); toast('Stock updated'); });
  },
  async hardened(id) { const b = byId('batches', id); b.hardened = today(); await save('batches', b); render(); },
  async closeBatch(id) { const b = byId('batches', id); if (!b.closed && !await ask('Close this batch? It leaves your stock list; its records and profit are kept.', 'Close batch')) return; b.closed = !b.closed; await save('batches', b); render(); },
  shareStock() {
    const bs = activeBatches().map(b => ({ b, k: bCalc(b) })).filter(x => x.k.avail > 0 && x.k.st !== 'Getting old');
    const line = x => '• ' + bName(x.b) + ': ' + fmtN(x.k.avail) + (num(x.b.price) ? ' @ KSh ' + fmtN(num(x.b.price)) : '');
    const r = bs.filter(x => x.k.toReady <= 0), s = bs.filter(x => x.k.toReady > 0 && x.k.toReady <= 14), g = bs.filter(x => x.k.toReady > 14);
    const txt = '🌱 ' + (prof().farm || 'Our nursery') + ' - seedlings ' + fmtD(today()) + '\n' + (r.length ? '\nREADY NOW\n' + r.map(line).join('\n') + '\n' : '') + (s.length ? '\nREADY SOON\n' + s.map(x => line(x) + ' (from ' + fmtD(x.k.ready) + ')').join('\n') + '\n' : '') + (g.length ? '\nBOOK NOW\n' + g.map(x => line(x) + ' (ready ' + fmtD(x.k.ready) + ')').join('\n') + '\n' : '') + (bs.length ? '' : '\nNo seedlings available right now.\n') + '\nTo order call or WhatsApp ' + (prof().phone || '') + (prof().county ? ' · ' + prof().county : '');
    sheet('Share your stock', '<p class="s" style="margin-top:0">Send this to your farmers\' WhatsApp group or status. Farmers can then book from what is ready or coming up.</p><textarea id="shareTxt" style="width:100%;min-height:220px;border-radius:12px;border:1px solid var(--line);background:var(--card);padding:10px">' + esc(txt) + '</textarea><div class="btns" style="margin-top:10px"><a class="btn ok" style="flex:1" target="_blank" rel="noopener" id="shareWa" href="' + waLink('', txt) + '">💬 WhatsApp</a><button class="btn" onclick="A.copyShare()">Copy</button></div>', { noFocus: true, onOpen: ov => on(ov, '#shareTxt', 'input', e => { $('shareWa').href = waLink('', e.target.value); }) });
  },
  async copyShare() { try { await navigator.clipboard.writeText($('shareTxt').value); toast('Copied'); } catch (e) { $('shareTxt').select(); document.execCommand('copy'); toast('Copied'); } },
  // ----- propagator: orders -----
  oF(f) { S.oF = f; render(); },
  newOrder(bid) { A.editOrder(null, bid); },
  editOrder(id, bid) {
    const o = id ? byId('orders', id) : null, v = o || { date: today(), batch: bid || '', status: 'pending' };
    const bs = D.batches.filter(b => !b.closed || b.id === v.batch);
    if (!bs.length) { toast('Add a seedling batch first'); A.newBatch(); return; }
    if (!v.batch) { const open = bs.filter(b => bCalc(b).open); v.batch = (open[0] || bs[0]).id; }
    form(o ? 'Edit order' : 'New order', [
      { k: 'name', l: 'Farmer\'s name', v: v.name, req: 1, list: [...new Set(D.orders.map(x => x.name))] },
      { k: 'phone', l: 'Phone', t: 'tel', v: v.phone },
      { k: 'batch', l: 'Seedlings from batch', t: 'select', o: bs.map(b => { const k = bCalc(b); return [b.id, bName(b) + ' - ' + fmtN(k.avail) + ' available, ' + (k.toReady > 0 ? 'ready ' + fmtD(k.ready) : 'ready')]; }), v: v.batch, req: 1 },
      { k: 'qty', l: 'Number of seedlings', t: 'num', v: v.qty, req: 1 },
      { k: 'price', l: 'Price per seedling (KSh)', t: 'num', v: v.price != null ? v.price : (byId('batches', v.batch) || {}).price },
      { k: 'want', l: 'Wanted on', t: 'date', v: v.want || bCalc(byId('batches', v.batch)).ready },
      { k: 'paid', l: 'Deposit paid (KSh)', t: 'num', v: v.paid },
      { k: 'notes', l: 'Notes', v: v.notes }
    ], async r => { const rec = Object.assign(o || { id: uid(), status: 'pending' }, r); rec.crop = (byId('batches', rec.batch) || {}).crop; await save('orders', rec); toast(o ? 'Order saved' : 'Order added - accept it or say it is not available'); },
    { del: o ? () => remove('orders', o.id) : null, onOpen: ov => on(ov, '#f_batch', 'change', e => { const b = byId('batches', e.target.value); if (b) { if (b.price) $('f_price').value = b.price; $('f_want').value = bCalc(b).ready; } }) });
  },
  async accept(id) {
    const o = byId('orders', id), b = byId('batches', o.batch), k = b && bCalc(b);
    if (k && k.avail < num(o.qty)) {
      if (k.avail <= 0) { if (await ask('This batch has no seedlings left. Tell ' + esc(o.name) + ' they are not available?', 'Not available')) return A.decline(id, true); return; }
      if (!await ask('Only ' + fmtN(k.avail) + ' seedlings are left - not the ' + fmtN(num(o.qty)) + ' ordered. Accept ' + fmtN(k.avail) + ' instead?', 'Accept ' + fmtN(k.avail))) return;
      o.notes = (o.notes ? o.notes + ' · ' : '') + 'Ordered ' + fmtN(num(o.qty)) + ', accepted ' + fmtN(k.avail); o.qty = k.avail;
    }
    o.status = 'accepted'; o.answered = today(); await save('orders', o); render();
    replyBox(o, readyMsg(o), 'Order accepted');
  },
  async decline(id, sure) {
    const o = byId('orders', id), b = byId('batches', o.batch);
    if (!sure && !await ask('Tell ' + esc(o.name) + ' the seedlings are not available?', 'Not available')) return;
    o.status = 'declined'; o.answered = today(); await save('orders', o); render();
    const next = D.batches.filter(x => x.crop === o.crop && x.id !== o.batch && bCalc(x).open && bCalc(x).avail >= num(o.qty)).sort((x, y) => bCalc(x).ready < bCalc(y).ready ? -1 : 1)[0];
    replyBox(o, 'Hello ' + o.name + ', sorry - the ' + (b ? bName(b) : '') + ' seedlings you ordered are not available.' + (next ? ' We will have ' + bName(next) + ' ready on ' + fmtD(bCalc(next).ready) + ' if you would like to book.' : '') + ' - ' + (prof().farm || prof().name || ''), 'Order declined');
  },
  async collect(id) {
    const o = byId('orders', id), total = num(o.qty) * num(o.price);
    form('Collected', [{ k: 'qty', l: 'Seedlings collected', t: 'num', v: o.qty, req: 1 }, { k: 'paid', l: 'Total paid (KSh, incl. deposit)', t: 'num', v: total, req: 1 }, { k: 'pay', l: 'Paid by', t: 'select', o: [['mpesa', 'M-Pesa'], ['cash', 'Cash'], ['bank', 'Bank'], ['credit', 'Will pay later']] }],
      async r => { o.qty = num(r.qty); o.paid = r.pay === 'credit' ? num(o.paid) : num(r.paid); o.pay = r.pay; o.status = 'collected'; o.collected = today(); await save('orders', o); toast('Collected - added to your sales'); });
  },
  // ----- settings -----
  async notify() {
    if (K.notify) { await setK('notify', false); render(); return; }
    if (!('Notification' in window)) { toast('This phone does not support reminders'); return; }
    const p = await Notification.requestPermission(); if (p !== 'granted') { toast('Reminders were not allowed'); return; }
    await setK('notify', true); render(); toast('Reminders on'); remindNow(true);
  },
  backup() {
    sheet('Backup', '<p class="s" style="margin-top:0">Your records live only on this phone. Save a backup file now and then (and keep it in Google Drive or send it to yourself on WhatsApp), so you do not lose them if the phone is lost.</p><button class="btn pri wide" onclick="A.doBackup()">⬇ Save backup file</button><div style="height:10px"></div><label class="btn wide">⬆ Restore from a backup file<input type="file" accept=".json,application/json" class="hide" onchange="A.restore(this)"></label><p class="xs">Last backup: ' + (K.lastBackup ? fmtD(K.lastBackup) : 'never') + '</p><details><summary class="xs" style="cursor:pointer">Advanced (for DukaGO support)</summary><div style="margin-top:8px">' + fieldHtml({ k: 'svUrl', l: 'Plant doctor server address', v: (K.server || {}).url }) + fieldHtml({ k: 'svKey', l: 'Server key', v: (K.server || {}).key }) + '<button class="btn sm" onclick="A.saveServer()">Save</button></div></details>');
  },
  async saveServer() { const u = $('f_svUrl').value.trim(); await setK('server', u ? { url: u, key: $('f_svKey').value.trim() } : null); toast('Saved'); },
  async doBackup() {
    const out = { app: 'farm-on-the-go', build: BUILD, at: new Date().toISOString(), kv: Object.assign({}, K), data: {} }; STORES.filter(s => s !== 'kv').forEach(s => { out.data[s] = D[s]; });
    delete out.kv.server; download('farm-on-the-go-backup-' + today() + '.json', JSON.stringify(out), 'application/json'); await setK('lastBackup', today()); toast('Backup saved');
  },
  async restore(inp) {
    const f = inp.files && inp.files[0]; if (!f) return;
    let j; try { j = JSON.parse(await f.text()); } catch (e) { toast('That is not a Farm on the Go backup file'); return; }
    if (!j || j.app !== 'farm-on-the-go' || !j.data) { toast('That is not a Farm on the Go backup file'); return; }
    const n = Object.values(j.data).reduce((s, a) => s + (a || []).length, 0);
    if (!await ask('Restore ' + n + ' records from ' + fmtD(String(j.at).slice(0, 10)) + '? This replaces the records on this phone.', 'Restore', 'Cancel', true)) return;
    for (const s of STORES) await idb(s, 'readwrite', o => o.clear());
    for (const s of Object.keys(j.data)) if (STORES.includes(s)) for (const r of j.data[s]) await idb(s, 'readwrite', o => o.put(r));
    for (const k of Object.keys(j.kv || {})) await idb('kv', 'readwrite', o => o.put({ id: k, v: j.kv[k] }));
    Object.keys(K).forEach(k => delete K[k]); await loadAll(); closeAll(); go('today'); toast('Records restored');
  }
};
Object.assign(A, animalActions);
function replyBox(o, msg, title) {
  sheet(title, '<p class="s" style="margin-top:0">Let ' + esc(o.name) + ' know:</p><div class="note">' + esc(msg) + '</div>' + (o.phone ? '<a class="btn ok wide" target="_blank" rel="noopener" href="' + waLink(o.phone, msg) + '">💬 Send on WhatsApp</a><div style="height:8px"></div><a class="btn wide" href="sms:' + esc(o.phone) + '?body=' + encodeURIComponent(msg) + '">✉️ Send as SMS</a>' : '<div class="s">No phone number saved for this farmer.</div>'), { noFocus: true });
}
function dateLabel(cid) { const c = crop(cid); return cid === 'other' ? 'Planting date' : c.grow === 'nursery' ? 'Transplanting date' : c.grow === 'direct' ? 'Sowing date' : 'Planting date'; }
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }

// ---------------- reminders (shown when the app is opened; the online version will push them) ----------------
async function remindNow(force) {
  if (!K.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const t0 = today(); if (!force && K.lastNotified === t0) return;
  let lines = [];
  if (isProp()) {
    const pend = D.orders.filter(o => o.status === 'pending').length; if (pend) lines.push(pend + ' new order' + (pend > 1 ? 's' : '') + ' to answer');
    activeBatches().forEach(b => { const k = bCalc(b); if (k.toReady === 0) lines.push(bName(b) + ' seedlings are ready today'); else if (k.toReady > 0 && k.toReady <= 3) lines.push(bName(b) + ' ready ' + rel(k.ready)); });
  } else {
    let n = 0; activePlantings().forEach(p => { n += openTasks(p, 0).length; }); if (n) lines.push(n + ' farm job' + (n > 1 ? 's' : '') + ' due today');
    D.sorders.filter(o => o.status === 'waiting' && dd(t0, o.ready) <= 0).forEach(o => lines.push(crop(o.crop).n + ' seedlings from ' + (o.nursery || 'the nursery') + ' are ready'));
  }
  if (!lines.length) return;
  await setK('lastNotified', t0);
  try { const reg = await navigator.serviceWorker.getRegistration(); const opt = { body: lines.slice(0, 4).join('\n'), icon: 'icons/icon-192-f1.png', badge: 'icons/icon-192-f1.png', tag: 'farm-today' }; if (reg) reg.showNotification('Farm on the Go', opt); else new Notification('Farm on the Go', opt); } catch (e) {}
}

// ---------------- updates and offline ----------------
let pendingReload = false;
function initSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  let had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!had) { had = true; return; } if (sheetStack.length || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) pendingReload = true; else location.reload(); });
}

// ---------------- start ----------------
(async function start() {
  if (window.FARM_BLOCKED) return;
  $('backBtn').onclick = back; $('roleBtn').onclick = () => { go('more'); };
  let _hidAt = 0;
  document.addEventListener('visibilitychange', () => { if (document.hidden) { _hidAt = Date.now(); } else if (K.lock && !LOCKED && _hidAt && Date.now() - _hidAt > 60000) { LOCKED = true; PINBUF = ''; PINERR = ''; closeAll(); render(); } });
  $('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) { if (S.view) { S.view = null; } go(b.dataset.tab); } });
  try { await openDB(); await loadAll(); } catch (e) { $('main').innerHTML = '<div class="note bad" style="margin:20px">This phone\'s browser storage is not available (' + esc(e.message || e) + '). Open the app in Chrome, not in a private window.</div>'; return; }
  if (K.lock) LOCKED = true;
  render(); initSW(); setTimeout(() => remindNow(false), 2500);
  try { initSync(); } catch (e) {}
  setInterval(() => { if (!sheetStack.length && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) render(); }, 10 * 60 * 1000);
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
})();

// ================= cloud sync + account (phone + PIN) =================
// Offline-first: the app always works on this phone. When signed in and online, records
// sync to Farm on the Go's backend so they survive a lost phone and reach the farmer's other
// devices. Each farm is isolated by the login token (see farm-auth / RLS). No dependency libs.
const SB_URL = 'https://zvptfimvfnptweaexmse.supabase.co';
const SB_KEY = 'sb_publishable_TZ5e7kSlOu7DqUBnAXZJqw_1IUkJ4MT';
const SYNC_STORES = STORES.filter(s => s !== 'kv');                 // data tables
const KV_LOCAL = ['_session', '_sync', 'notify', 'lock', 'theme']; // never leave this phone
const stripMeta = o => { const c = { ...o }; delete c._d; delete c._rev; return c; };
let SY = { session: null, busy: false, timer: 0, lastOk: 0, lastErr: '' };

// tombstones + cursors live in their own object store (added at DB v3)
const sput = (rec) => idb('_sync', 'readwrite', o => o.put(rec));
const sdel = (id) => idb('_sync', 'readwrite', o => o.delete(id));
const sall = () => idb('_sync', 'readonly', o => o.getAll());

function sess() { return SY.session; }
async function setSession(s) { SY.session = s; await setK('_session', s); updateSyncUI(); }
async function signOut() { SY.session = null; await setK('_session', null); updateSyncUI(); try { closeAll(); } catch (e) {} toast('Signed out - records stay on this phone'); }
async function freshToken() {
  const s = sess(); if (!s) return null;
  if (s.expires_at && s.expires_at * 1000 > Date.now() + 60000) return s.access_token;
  try {
    const r = await fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error(j.error_description || j.msg || 'refresh failed');
    const ns = { access_token: j.access_token, refresh_token: j.refresh_token || s.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), farm_id: s.farm_id, name: s.name };
    await setSession(ns); return ns.access_token;
  } catch (e) { SY.lastErr = String(e.message || e); return null; }
}

async function farmAuth(action, phone, pin, extra) {
  const r = await fetch(SB_URL + '/functions/v1/farm-auth', {
    method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action, phone, pin }, extra || {})),
  });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...j };
}

async function sb(path, opts) {
  const tok = await freshToken(); if (!tok) throw new Error('not signed in');
  const r = await fetch(SB_URL + '/rest/v1/' + path, Object.assign({}, opts, {
    headers: Object.assign({ apikey: SB_KEY, Authorization: 'Bearer ' + tok }, (opts && opts.headers) || {}),
  }));
  if (!r.ok) throw new Error('rest ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

// mark everything already on this phone as needing upload (first sign-in on a device)
async function markAllDirty() {
  for (const s of SYNC_STORES) for (const rec of D[s]) { rec._d = rec.updated_at || new Date().toISOString(); await idb(s, 'readwrite', o => o.put(rec)); }
  for (const k of Object.keys(K)) if (!KV_LOCAL.includes(k) && k[0] !== '_') { const rec = { id: k, v: K[k], _d: new Date().toISOString() }; await idb('kv', 'readwrite', o => o.put(rec)); }
}

// push local changes up
async function pushChanges() {
  const fid = sess().farm_id;
  for (const s of SYNC_STORES) {
    const dirty = D[s].filter(r => r._d);
    const tombs = (await sall()).filter(t => t.store === s);
    const rows = dirty.map(r => ({ farm_id: fid, id: r.id, doc: stripMeta(r), deleted: false }))
      .concat(tombs.map(t => ({ farm_id: fid, id: t.rid, doc: t.doc || {}, deleted: true })));
    if (!rows.length) continue;
    await sb(s + '?on_conflict=farm_id,id', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows) });
    for (const r of dirty) { delete r._d; await idb(s, 'readwrite', o => o.put(r)); }
    for (const t of tombs) await sdel(t.id);
  }
  const kvRec = await idb('kv', 'readonly', o => o.getAll());
  const kvDirty = kvRec.filter(r => r._d && !KV_LOCAL.includes(r.id) && r.id[0] !== '_');
  if (kvDirty.length) {
    const rows = kvDirty.map(r => ({ farm_id: fid, id: r.id, doc: { v: r.v }, deleted: false }));
    await sb('kv?on_conflict=farm_id,id', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows) });
    for (const r of kvDirty) { delete r._d; await idb('kv', 'readwrite', o => o.put(r)); }
  }
}

// pull remote changes down (by rev cursor per store)
async function pullChanges() {
  const fid = sess().farm_id;
  const cursors = (await idb('_sync', 'readonly', o => o.get('cursors')))?.v || {};
  let changed = false;
  for (const s of STORES) {
    let cur = cursors[s] || 0, more = true;
    while (more) {
      const rows = await sb(s + '?farm_id=eq.' + fid + '&rev=gt.' + cur + '&order=rev.asc&limit=500&select=id,doc,deleted,rev,updated_at');
      if (!rows || !rows.length) break;
      for (const row of rows) {
        cur = Math.max(cur, row.rev);
        if (s === 'kv') {
          if (row.deleted) { if (!KV_LOCAL.includes(row.id)) { delete K[row.id]; await idb('kv', 'readwrite', o => o.delete(row.id)); changed = true; } continue; }
          if (KV_LOCAL.includes(row.id)) continue;
          K[row.id] = row.doc.v; await idb('kv', 'readwrite', o => o.put({ id: row.id, v: row.doc.v })); changed = true; continue;
        }
        const local = byId(s, row.id);
        if (row.deleted) { if (local) { D[s] = D[s].filter(x => x.id !== row.id); await idb(s, 'readwrite', o => o.delete(row.id)); changed = true; } continue; }
        // last-write-wins: keep local only if it is dirty AND newer
        if (local && local._d && (local.updated_at || '') > (row.updated_at || '')) continue;
        const rec = Object.assign({}, row.doc, { id: row.id, updated_at: row.updated_at, _rev: row.rev });
        const i = D[s].findIndex(x => x.id === row.id); if (i >= 0) D[s][i] = rec; else D[s].push(rec);
        await idb(s, 'readwrite', o => o.put(rec)); changed = true;
      }
      cursors[s] = cur; more = rows.length === 500;
    }
  }
  await sput({ id: 'cursors', v: cursors });
  return changed;
}

async function syncNow(silent) {
  if (!sess() || SY.busy || !navigator.onLine) { if (!silent && !navigator.onLine) toast('No internet - will sync when back online'); return; }
  SY.busy = true; updateSyncUI();
  try {
    await pushChanges();
    const changed = await pullChanges();
    SY.lastOk = Date.now(); SY.lastErr = '';
    if (changed && !sheetStack.length) render();
    if (!silent) toast('Synced');
  } catch (e) {
    SY.lastErr = String(e.message || e);
    if (!silent) toast('Sync failed - will retry');
  } finally { SY.busy = false; updateSyncUI(); }
}
const scheduleSync = () => { clearTimeout(SY.timer); SY.timer = setTimeout(() => syncNow(true), 2500); };

// account card shown at the top of the More tab
function accountCardHtml() {
  const on = !!sess();
  const title = on ? esc((sess().name) || 'My farm') : 'Back up &amp; sync';
  const sub = on ? (SY.lastErr ? '&#9888;&#65039; sync problem - tap to retry' : (SY.lastOk ? 'Backed up &middot; ' + new Date(SY.lastOk).toLocaleTimeString() : 'Signed in &middot; backing up...')) : 'Create an account so your records are safe';
  const em = on ? (SY.busy ? '&#128260;' : (SY.lastErr ? '&#9888;&#65039;' : '&#9729;&#65039;')) : '&#9729;&#65039;';
  return '<div class="card"><div class="li" style="cursor:pointer" onclick="A.account()"><div class="em">' + em + '</div><div class="grow"><div class="t">' + title + '</div><div class="s">' + sub + '</div></div><span class="xs">&rsaquo;</span></div></div>';
}

// account UI
function accountSheet() {
  if (sess()) {
    const s = sess();
    sheet('Your account', '<div class="card"><div class="row"><div class="em">&#9729;&#65039;</div><div class="grow"><div class="t">' + esc(s.name || 'My farm') + '</div><div class="s">Signed in &middot; records back up automatically</div></div></div></div>' +
      '<div id="accMsg" class="s" style="text-align:center;margin:10px 0">' + (SY.lastErr ? '&#9888;&#65039; ' + esc(SY.lastErr).slice(0, 60) : (SY.lastOk ? 'Last sync ' + new Date(SY.lastOk).toLocaleTimeString() : 'Not synced yet')) + '</div>' +
      '<button class="btn pri wide" onclick="A.syncNow()">Sync now</button><div style="height:8px"></div><button class="btn wide" onclick="A.signOut()">Sign out</button>', { noFocus: true });
    return;
  }
  sheet('Back up &amp; sync', '<p class="s" style="margin-top:0">Create an account or sign in with your phone number and a PIN. Your records back up to the cloud and reach your other phones. The app keeps working offline.</p>' +
    '<button class="btn pri wide" onclick="A.authForm(\'register\')">Create an account</button><div style="height:8px"></div><button class="btn wide" onclick="A.authForm(\'login\')">I already have one</button>', { noFocus: true });
}
function authForm(mode) {
  const reg = mode === 'register', p = prof();
  const body = (reg ? '<div class="fld"><span>Your name</span><input id="auName" value="' + esc(p.name || '') + '" maxlength="80"></div>' : '') +
    '<div class="fld"><span>Phone number</span><input id="auPhone" type="tel" inputmode="tel" placeholder="07xx xxx xxx" value="' + esc(p.phone || '') + '"></div>' +
    '<div class="fld"><span>PIN (4 to 6 digits)</span><input id="auPin" type="password" inputmode="numeric" maxlength="6"></div>' +
    (reg ? '<div class="fld"><span>Repeat PIN</span><input id="auPin2" type="password" inputmode="numeric" maxlength="6"></div>' : '') +
    '<div id="auMsg"></div><button class="btn pri wide" id="auGo">' + (reg ? 'Create account' : 'Sign in') + '</button>';
  const ov = sheet(reg ? 'Create an account' : 'Sign in', body, { noFocus: true });
  ov.querySelector('#auGo').onclick = async () => {
    const set = m => { ov.querySelector('#auMsg').innerHTML = '<div class="note bad">' + esc(m) + '</div>'; };
    const phone = ($('auPhone').value || '').trim(), pin = ($('auPin').value || '').trim();
    if (!/^[0-9+\s]{9,}$/.test(phone)) return set('Enter a valid phone number');
    if (!/^\d{4,6}$/.test(pin)) return set('PIN must be 4 to 6 digits');
    if (reg && pin !== ($('auPin2').value || '').trim()) return set('The two PINs do not match');
    if (!navigator.onLine) return set('You need internet to set up the account the first time');
    const go2 = ov.querySelector('#auGo'); go2.disabled = true; go2.textContent = 'Please wait...';
    const name = reg ? ($('auName').value || '').trim() : '';
    const activities = (prof().activities) || [isProp() ? 'nursery' : 'crops'];
    let res; try { res = await farmAuth(mode, phone, pin, reg ? { name, activities } : {}); } catch (e) { res = { ok: false, code: 'network' }; }
    if (!res.ok) {
      const msg = { phone_taken: 'That phone already has an account - sign in instead', not_found: 'No account for that phone - create one', bad_pin: 'Wrong PIN', bad_phone: 'Enter a valid phone number', forbidden_origin: 'This copy of the app is not allowed', network: 'No internet - try again' }[res.code] || ('Could not ' + (reg ? 'create account' : 'sign in'));
      go2.disabled = false; go2.textContent = reg ? 'Create account' : 'Sign in';
      return set(msg);
    }
    await setSession({ ...res.session, farm_id: res.farm.id, name: res.farm.name || name });
    await markAllDirty();
    closeAll();
    toast(reg ? 'Account created' : 'Signed in');
    await syncNow(false);
  };
}
function updateSyncUI() { const b = $('syncDot'); if (b) b.textContent = !sess() ? '' : SY.busy ? '🔄' : SY.lastErr ? '⚠️' : '☁️'; try { if (sheetStack.length) { const m = $('accMsg'); if (m) m.innerHTML = SY.lastErr ? '⚠️ ' + esc(SY.lastErr).slice(0, 60) : (SY.lastOk ? 'Last sync ' + new Date(SY.lastOk).toLocaleTimeString() : 'Not synced yet'); } } catch (e) {} }

async function initSync() {
  try { const s = (typeof K !== 'undefined') ? K['_session'] : null; if (s) SY.session = s; } catch (e) {}
  updateSyncUI();
  window.addEventListener('online', () => syncNow(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(true); });
  setInterval(() => syncNow(true), 60000);
  if (sess()) syncNow(true);
}

try { Object.assign(window.A, { account: accountSheet, accountSheet, authForm, syncNow, signOut, scheduleSync }); } catch (e) {}
