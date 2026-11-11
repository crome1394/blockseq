// App shell: routing, views, search and live updates from the server.

import { api, clientId, invalidatePageNames } from './api.js';
import { journalName, journalDay, formatTime } from './dates.js';
import { esc, renderContent, tagHue } from './render.js';
import { PageEditor, editors, hydrateRefs, clearRefCache, showMenu, activeEditor } from './editor.js';
import { toast, updateStatus, setConnected, openModal, closeModal } from './ui.js';
import { decorateCode } from './code.js';
import { settingsForm, onSettingChange, getSetting, setSetting } from './settings.js';
import { Calendar } from './calendar.js';

const main = document.getElementById('main');

// Sidebar calendar: picking a day opens that journal, creating it if needed.
const calendar = new Calendar(document.getElementById('calendar'), async (date) => {
  const name = journalName(date);
  try { await api.ensurePage(name); } catch { /* offline: it's created on first save */ }
  invalidatePageNames();
  location.hash = pageHref(name);
});
let calendarTimer = null;
function refreshCalendar() {
  clearTimeout(calendarTimer);
  calendarTimer = setTimeout(() => { calendar.refresh(); refreshFavorites(); }, 1000);
}
let view = null; // { refresh?() }
let routeSeq = 0;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pageHref(name) {
  return `#/page/${encodeURIComponent(name)}`;
}

// ---- routing ---------------------------------------------------------------

async function settleSaves() {
  const until = Date.now() + 3000;
  while (Date.now() < until && [...editors].some((e) => e.saving || (e.dirty && !e.offline && !e.conflict))) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function route() {
  const seq = ++routeSeq;
  for (const ed of [...editors]) if (!ed.disposed) ed.dispose();
  // Let pending saves land before loading pages they might belong to.
  await settleSaves();
  if (seq !== routeSeq) return;
  view = null;
  const hash = location.hash.slice(1) || '/journals';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', hash === `/${a.dataset.nav}`));
  markActiveFavorite();
  if (matchMedia('(max-width: 760px)').matches && !document.documentElement.classList.contains('sidebar-hidden')) {
    // On a phone the sidebar covers the page; close it after navigating.
    if (sidebarOpenedByUser) setSidebar(false);
  }
  window.scrollTo(0, 0);
  try {
    if (hash.startsWith('/page/')) {
      // #/page/<name>?b=<block id> opens a page scrolled to one block.
      const rest = hash.slice(6);
      const q = rest.indexOf('?');
      const name = decodeURIComponent(q === -1 ? rest : rest.slice(0, q));
      const block = q === -1 ? null : new URLSearchParams(rest.slice(q + 1)).get('b');
      await pageView(name, seq, block);
    }
    else if (hash === '/all') { calendar.select(null); await allPagesView(seq); }
    else { calendar.select(null); calendar.goToday(); await journalsView(seq); }
  } catch (e) {
    if (seq === routeSeq) main.replaceChildren(el('p', 'error', `Could not load: ${e.message}`));
  }
}

// ---- journals --------------------------------------------------------------

async function journalsView(seq) {
  const today = new Date();
  const todayDay = journalDay(today);
  const list = (await api.journals(null, 10)).map((j) => ({ name: j.page.name, page: j.page, blocks: j.blocks }));
  if (seq !== routeSeq) return;
  if (!list.some((j) => j.page.journal_day === todayDay)) {
    const at = list.findIndex((j) => j.page.journal_day < todayDay);
    const entry = { name: journalName(today), page: null, blocks: [] };
    list.splice(at === -1 ? list.length : at, 0, entry);
  }
  const wrap = el('div', 'journals');
  const more = el('button', 'load-more', 'Load older journals');
  main.replaceChildren(wrap, more);

  const add = (j) => {
    const section = el('section', 'journal');
    const head = el('div', 'journal-head');
    const h = el('a', 'journal-title', j.name);
    h.href = pageHref(j.name);
    const menu = el('button', 'icon-button journal-menu', '⋯');
    menu.title = 'Journal actions';
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      showMenu(e.clientX - 160, e.clientY, [
        ['Open journal', () => { location.hash = pageHref(j.name); }],
        ['Delete journal', () => deletePage(j.name, true), 'danger'],
      ]);
    });
    head.append(h, menu);
    const body = el('div');
    section.append(head, body);
    wrap.append(section);
    new PageEditor(body, j);
  };
  list.forEach(add);

  let oldest = Math.min(...list.map((j) => j.page?.journal_day ?? todayDay));
  more.addEventListener('click', async () => {
    more.disabled = true;
    const older = await api.journals(oldest, 10);
    older.forEach((j) => add({ name: j.page.name, page: j.page, blocks: j.blocks }));
    if (older.length) oldest = older[older.length - 1].page.journal_day;
    if (older.length < 10) more.remove(); else more.disabled = false;
  });
  if (list.length < 10) more.remove();
}

// ---- single page -----------------------------------------------------------

async function pageView(name, seq, blockId) {
  const data = await api.page(name);
  if (seq !== routeSeq) return;
  calendar.select(data.page?.journal_day ?? null);
  const isJournal = data.page?.journal_day != null || journalNameDay(data.name);
  const header = el('div', 'page-header');
  const title = el('h1', 'page-title', data.name);
  const star = el('button', 'icon-button star');
  let fav = !!data.page?.favorite;
  const drawStar = () => {
    star.textContent = fav ? '★' : '☆';
    star.classList.toggle('on', fav);
    star.title = fav ? 'Remove from favorites' : 'Add to favorites';
  };
  drawStar();
  star.addEventListener('click', async () => {
    fav = !fav;
    drawStar();
    const r = await api.setFavorite(data.name, fav);
    if (!r.ok) { fav = !fav; drawStar(); toast('Could not update favorites'); }
    refreshFavorites(true);
  });
  const actions = el('button', 'icon-button', '⋯');
  actions.title = 'Page actions';
  actions.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu(e.clientX - 160, e.clientY, [
      [fav ? 'Remove from favorites' : 'Add to favorites', () => star.click()],
      [isJournal ? 'Delete journal' : 'Delete page', () => deletePage(data.name, isJournal), 'danger'],
    ]);
  });
  header.append(title, star, actions);
  const body = el('div');
  const refs = el('section', 'backlinks');
  main.replaceChildren(header, body, refs);
  const editor = new PageEditor(body, data);
  renderBacklinks(refs, data.backlinks);
  if (blockId) editor.reveal(blockId);
  view = {
    refresh: async () => {
      try { renderBacklinks(refs, (await api.page(name)).backlinks); } catch { /* offline */ }
    },
  };
}

function renderBacklinks(container, groups) {
  container.replaceChildren();
  if (!groups.length) return;
  const count = groups.reduce((n, g) => n + g.blocks.length, 0);
  container.append(el('h2', '', `${count} Linked Reference${count === 1 ? '' : 's'}`));
  for (const g of groups) {
    const group = el('div', 'ref-group');
    const link = el('a', 'ref-page', g.page_name);
    link.href = pageHref(g.page_name);
    group.append(link);
    for (const b of g.blocks) {
      const item = el('div', 'ref-block');
      item.innerHTML = `<span class="bullet"><span class="dot"></span></span><div class="content">${renderContent(b.content)}</div>`;
      item.addEventListener('click', (e) => {
        if (!e.target.closest('a') && !e.target.closest('.code-copy')) location.hash = `${pageHref(g.page_name)}?b=${b.id}`;
      });
      decorateCode(item);
      hydrateRefs(item);
      group.append(item);
    }
    container.append(group);
  }
}

async function deletePage(name, journal = false) {
  const what = journal ? 'journal' : 'page';
  if (!confirm(`Delete the ${what} "${name}" from the server? This cannot be undone.`)) return;
  for (const ed of editors) if (ed.lower === name.toLowerCase()) { ed.dirty = false; ed.dispose(); }
  const r = await api.deletePage(name);
  if (r.ok || r.status === 404) {
    invalidatePageNames();
    refreshCalendar();
    toast(journal ? 'Journal deleted' : 'Page deleted');
    const target = journal ? '#/journals' : '#/all';
    if (location.hash === target) route(); else location.hash = target;
  } else {
    toast(`Delete failed: ${r.data?.error || r.status}`);
  }
}

// True when a name is a journal date like "Nov 11th, 2026".
function journalNameDay(name) {
  return /^[A-Z][a-z]{2} \d{1,2}(st|nd|rd|th), \d{4}$/.test(name);
}

// ---- journals: new / open ----------------------------------------------------

function dateInputValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function openJournalDate(date) {
  const name = journalName(date);
  try { await api.ensurePage(name); } catch { /* offline: created on first save */ }
  invalidatePageNames();
  refreshCalendar();
  location.hash = pageHref(name);
}

function newJournalDialog() {
  const body = el('div', 'dialog-form');
  const label = el('label', 'field');
  label.append(el('span', '', 'Date'));
  const input = el('input');
  input.type = 'date';
  input.value = dateInputValue(new Date());
  label.append(input);
  body.append(label, el('p', 'muted small', 'Creates the journal for that day on the server and opens it. If it already exists, it just opens.'));
  const create = () => {
    if (!input.value) return false;
    const [y, m, d] = input.value.split('-').map(Number);
    openJournalDate(new Date(y, m - 1, d));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); closeModal(); } });
  openModal('New journal', body, [['Cancel'], ['Create', create, 'primary']]);
  input.focus();
}

async function openJournalDialog() {
  const body = el('div', 'dialog-form');
  const filter = el('input', 'filter');
  filter.type = 'search';
  filter.placeholder = 'Filter journals (e.g. "Nov" or "2026")';
  const list = el('div', 'journal-pick');
  body.append(filter, list);
  openModal('Open journal', body, [['Close']]);
  filter.focus();
  let journals = [];
  try {
    journals = (await api.pages())
      .filter((p) => p.journal_day != null)
      .sort((a, b) => b.journal_day - a.journal_day);
  } catch (e) {
    list.append(el('p', 'error', `Could not load journals: ${e.message}`));
    return;
  }
  let index = 0;
  let shown = [];
  const go = (p) => { closeModal(); location.hash = pageHref(p.name); };
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    shown = journals.filter((p) => p.name.toLowerCase().includes(q));
    index = Math.min(index, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((p, i) => {
      const row = el('button', 'pick-row' + (i === index ? ' active' : ''));
      row.type = 'button';
      row.append(el('span', '', p.name), el('span', 'muted small', p.block_count ? `${p.block_count} block${p.block_count === 1 ? '' : 's'}` : 'empty'));
      row.addEventListener('click', () => go(p));
      return row;
    }));
    if (!shown.length) list.append(el('p', 'muted', journals.length ? 'No matching journals.' : 'No journals yet.'));
    list.children[index]?.scrollIntoView?.({ block: 'nearest' });
  };
  filter.addEventListener('input', () => { index = 0; draw(); });
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) index = (index + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      draw();
    } else if (e.key === 'Enter' && shown[index]) {
      e.preventDefault();
      go(shown[index]);
    }
  });
  draw();
}

document.getElementById('new-journal').addEventListener('click', newJournalDialog);
document.getElementById('open-journal').addEventListener('click', openJournalDialog);

// ---- favorites ---------------------------------------------------------------

const favBox = document.getElementById('favorites');
let favTimer = null;
function refreshFavorites(now = false) {
  clearTimeout(favTimer);
  favTimer = setTimeout(async () => {
    if (!getSetting('favorites')) return;
    let pages;
    try { pages = await api.pages(); } catch { return; }
    const favs = pages.filter((p) => p.favorite).sort((a, b) => a.name.localeCompare(b.name));
    const list = favBox.querySelector('.fav-list');
    list.replaceChildren(...favs.map((p) => {
      const a = el('a', 'fav', p.name);
      a.href = pageHref(p.name);
      a.dataset.name = p.name.toLowerCase();
      return a;
    }));
    if (!favs.length) list.append(el('div', 'muted small fav-empty', 'Star a page (☆ next to its title) to add it here.'));
    markActiveFavorite();
  }, now ? 0 : 300);
}
function markActiveFavorite() {
  const hash = location.hash.slice(1);
  const name = hash.startsWith('/page/') ? decodeURIComponent(hash.slice(6).split('?')[0]).toLowerCase() : null;
  favBox.querySelectorAll('.fav').forEach((a) => a.classList.toggle('active', a.dataset.name === name));
}

// ---- all pages ---------------------------------------------------------------

async function allPagesView(seq) {
  const pages = await api.pages();
  if (seq !== routeSeq) return;
  const header = el('div', 'page-header');
  header.append(el('h1', 'page-title', 'All pages'));
  const controls = el('div', 'list-controls');
  const filter = el('input', 'filter');
  filter.type = 'search';
  filter.placeholder = 'Filter pages';
  const hideLabel = el('label', 'check');
  const hide = el('input');
  hide.type = 'checkbox';
  hide.checked = true;
  hideLabel.append(hide, ' Hide journals');
  const newBtn = el('button', 'primary', 'New page');
  newBtn.addEventListener('click', () => {
    const n = prompt('Page name');
    if (n?.trim()) location.hash = pageHref(n.trim());
  });
  controls.append(filter, hideLabel, newBtn);
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'page-table');
  const COLS = [['name', 'Page name'], ['tags', 'Tags'], ['created_at', 'Created at'], ['updated_at', 'Updated at']];
  let sortKey = 'updated_at';
  let sortDir = -1;
  const thead = el('thead');
  const headRow = el('tr');
  for (const [key, label] of COLS) {
    const th = el('th', `col-${key}`, label);
    if (key !== 'tags') {
      th.classList.add('sortable');
      th.title = 'Sort';
      th.addEventListener('click', () => {
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = key === 'name' ? 1 : -1; }
        draw();
      });
    }
    th.dataset.key = key;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = el('tbody');
  table.append(thead, tbody);
  wrap.append(table);
  const empty = el('p', 'muted');
  main.replaceChildren(header, controls, wrap, empty);

  const fullTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = pages.filter((p) => (!hide.checked || p.journal_day == null)
      && (p.name.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q))));
    rows.sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      return (typeof x === 'string' ? x.localeCompare(y, undefined, { sensitivity: 'base' }) : x - y) * sortDir;
    });
    headRow.querySelectorAll('th').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.key === sortKey);
      th.dataset.dir = th.dataset.key === sortKey ? (sortDir > 0 ? '▲' : '▼') : '';
    });
    tbody.replaceChildren(...rows.map((p) => {
      const tr = el('tr');
      const name = el('td', 'col-name');
      const link = el('a', '', p.name);
      link.href = pageHref(p.name);
      name.append(link);
      if (p.favorite) name.append(el('span', 'fav-mark', ' ★'));
      const tags = el('td', 'col-tags');
      for (const t of p.tags) {
        const a = el('a', 'page-ref tag', `#${t}`);
        a.href = pageHref(t);
        a.style.setProperty('--tag-h', tagHue(t));
        tags.append(a);
      }
      const created = el('td', 'col-created_at', formatTime(p.created_at));
      created.title = fullTime(p.created_at);
      const updated = el('td', 'col-updated_at', formatTime(p.updated_at));
      updated.title = fullTime(p.updated_at);
      tr.append(name, tags, created, updated);
      tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = pageHref(p.name); });
      return tr;
    }));
    empty.textContent = rows.length ? '' : (q ? 'No matching pages.' : 'No pages yet.');
  };
  filter.addEventListener('input', draw);
  hide.addEventListener('change', draw);
  draw();
  filter.focus();
}

// ---- search ------------------------------------------------------------------

const searchInput = document.getElementById('search');
const searchBox = document.getElementById('search-results');
let searchItems = [];
let searchIndex = 0;
let searchTimer = null;
let searchSeq = 0;

function closeSearch() {
  searchBox.classList.add('hidden');
  searchItems = [];
}

async function runSearch() {
  const q = searchInput.value.trim();
  const seq = ++searchSeq;
  if (!q) return closeSearch();
  let res;
  try { res = await api.search(q, 12); } catch { return; }
  if (seq !== searchSeq) return;
  searchItems = [];
  const exact = res.pages.some((p) => p.toLowerCase() === q.toLowerCase());
  res.pages.slice(0, 6).forEach((p) => searchItems.push({ html: `<span class="kind">Page</span>${esc(p)}`, go: p }));
  if (!exact) searchItems.push({ html: `<span class="kind">New</span>Create page <b>${esc(q)}</b>`, go: q });
  res.blocks.forEach((b) => searchItems.push({
    html: `<div class="snippet">${esc(b.content.slice(0, 140))}</div><small>${esc(b.page_name)}</small>`,
    go: b.page_name,
    block: b.id,
  }));
  searchIndex = 0;
  searchBox.replaceChildren(...searchItems.map((it, i) => {
    const row = el('div', 'item');
    row.innerHTML = it.html;
    row.addEventListener('mousedown', (e) => { e.preventDefault(); searchIndex = i; acceptSearch(); });
    return row;
  }));
  markSearch();
  searchBox.classList.remove('hidden');
}

function markSearch() {
  [...searchBox.children].forEach((c, i) => c.classList.toggle('active', i === searchIndex));
  searchBox.children[searchIndex]?.scrollIntoView({ block: 'nearest' });
}

function acceptSearch() {
  const it = searchItems[searchIndex];
  if (!it) return;
  location.hash = pageHref(it.go) + (it.block ? `?b=${it.block}` : '');
  searchInput.value = '';
  closeSearch();
  searchInput.blur();
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; closeSearch(); searchInput.blur(); return; }
  if (!searchItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchIndex = (searchIndex + (e.key === 'ArrowDown' ? 1 : -1) + searchItems.length) % searchItems.length;
    markSearch();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    acceptSearch();
  }
});
searchInput.addEventListener('blur', () => setTimeout(closeSearch, 100));

// ---- live updates ------------------------------------------------------------

let refreshTimer = null;
function refreshView() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => view?.refresh?.(), 300);
}

function resyncAll() {
  refreshCalendar();
  clearRefCache();
  invalidatePageNames();
  for (const ed of editors) ed.remoteChanged();
  refreshView();
}

function connectEvents() {
  const es = new EventSource('/api/events');
  let opened = false;
  es.onopen = () => {
    setConnected(true);
    if (opened) resyncAll(); // we may have missed events while disconnected
    opened = true;
  };
  es.onerror = () => setConnected(false);
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === 'resync') return resyncAll();
    refreshCalendar(); // our own saves can add a journal dot too
    if (ev.type === 'favorite') return; // the sidebar list refreshes above
    if (ev.client === clientId) return;
    clearRefCache();
    invalidatePageNames();
    for (const ed of editors) {
      if (ed.lower === ev.name.toLowerCase()) ed.remoteChanged(ev.type === 'deleted' ? undefined : ev.version);
    }
    refreshView();
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resyncAll();
});

window.addEventListener('beforeunload', (e) => {
  const dirty = [...editors].filter((ed) => ed.dirty);
  if (!dirty.length) return;
  dirty.forEach((ed) => ed.save({ keepalive: true }));
  e.preventDefault();
  e.returnValue = '';
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === '\\') {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  // Undo/redo when no block is being edited (inside a block the editor handles it).
  const inField = e.target.closest?.('input, textarea, [contenteditable]');
  if (mod && !inField && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase())) {
    const ed = activeEditor();
    if (!ed) return;
    e.preventDefault();
    if (e.key.toLowerCase() === 'y' || e.shiftKey) ed.redo(); else ed.undo();
  }
});

document.getElementById('open-settings').addEventListener('click', () => {
  openModal('Settings', settingsForm());
});

// ---- sidebar toggle --------------------------------------------------------

let sidebarOpenedByUser = false;
function setSidebar(open) {
  document.documentElement.classList.toggle('sidebar-hidden', !open);
  setSetting('sidebar', open);
}
function toggleSidebar() {
  const open = document.documentElement.classList.contains('sidebar-hidden');
  sidebarOpenedByUser = open;
  setSidebar(open);
}
document.getElementById('menu-toggle').addEventListener('click', toggleSidebar);

// ---- settings ----------------------------------------------------------------

// Most settings are page-wide classes or attributes that the CSS follows.
function applySettings() {
  const root = document.documentElement;
  const theme = getSetting('theme');
  if (theme && theme !== 'auto') root.dataset.theme = theme; else delete root.dataset.theme;
  root.classList.toggle('code-wrap', !!getSetting('codeWrap'));
  root.classList.toggle('wide', !!getSetting('wideLayout'));
  root.classList.toggle('tag-colors', !!getSetting('tagColors'));
  root.classList.toggle('no-favorites', !getSetting('favorites'));
  favBox.classList.toggle('hidden', !getSetting('favorites'));
}
applySettings();
refreshFavorites(true);
onSettingChange((name) => {
  applySettings();
  if (name === 'favorites') refreshFavorites(true);
  // Layout may have changed (width, theme fonts): redraw threading lines.
  requestAnimationFrame(() => { for (const ed of editors) ed.updateThread(); });
});
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { for (const ed of editors) ed.updateThread(); }, 100);
});

window.addEventListener('hashchange', route);
connectEvents();
updateStatus();
route();
