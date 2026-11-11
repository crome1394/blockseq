// App shell: routing, views, search and live updates from the server.

import { api, clientId, invalidatePageNames } from './api.js';
import { journalName, journalDay, formatTime } from './dates.js';
import { esc, renderContent } from './render.js';
import { PageEditor, editors, hydrateRefs, clearRefCache, showMenu, activeEditor } from './editor.js';
import { toast, updateStatus, setConnected } from './ui.js';

const main = document.getElementById('main');
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
  window.scrollTo(0, 0);
  try {
    if (hash.startsWith('/page/')) await pageView(decodeURIComponent(hash.slice(6)), seq);
    else if (hash === '/all') await allPagesView(seq);
    else await journalsView(seq);
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
    const h = el('a', 'journal-title', j.name);
    h.href = pageHref(j.name);
    const body = el('div');
    section.append(h, body);
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

async function pageView(name, seq) {
  const data = await api.page(name);
  if (seq !== routeSeq) return;
  const header = el('div', 'page-header');
  const title = el('h1', 'page-title', data.name);
  const actions = el('button', 'icon-button', '⋯');
  actions.title = 'Page actions';
  actions.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu(e.clientX - 160, e.clientY, [
      ['Delete page', () => deletePage(data.name), 'danger'],
    ]);
  });
  header.append(title, actions);
  const body = el('div');
  const refs = el('section', 'backlinks');
  main.replaceChildren(header, body, refs);
  new PageEditor(body, data);
  renderBacklinks(refs, data.backlinks);
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
        if (!e.target.closest('a')) location.hash = pageHref(g.page_name);
      });
      hydrateRefs(item);
      group.append(item);
    }
    container.append(group);
  }
}

async function deletePage(name) {
  if (!confirm(`Delete the page "${name}"? This cannot be undone.`)) return;
  for (const ed of editors) if (ed.lower === name.toLowerCase()) { ed.dirty = false; ed.dispose(); }
  const r = await api.deletePage(name);
  if (r.ok || r.status === 404) {
    invalidatePageNames();
    toast('Page deleted');
    location.hash = '#/all';
  } else {
    toast(`Delete failed: ${r.data?.error || r.status}`);
  }
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
  const table = el('div', 'page-list');
  main.replaceChildren(header, controls, table);

  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = pages.filter((p) => (!hide.checked || p.journal_day == null) && p.name.toLowerCase().includes(q));
    table.replaceChildren(...rows.map((p) => {
      const row = el('a', 'page-row');
      row.href = pageHref(p.name);
      row.append(el('span', 'name', p.name), el('span', 'meta', `${p.block_count} blocks · ${formatTime(p.updated_at)}`));
      return row;
    }));
    if (!rows.length) table.append(el('p', 'muted', q ? 'No matching pages.' : 'No pages yet.'));
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
  location.hash = pageHref(it.go);
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

window.addEventListener('hashchange', route);
connectEvents();
updateStatus();
route();
