// App shell: routing, views, search and live updates from the server.

import { el } from './dom.js';
import { api, clientId, explain, invalidatePageNames, getPageNames, signingOut } from './api.js';
import { signOut, showSignOut } from './signin.js';
import { journalName, journalDay, formatTime } from './dates.js';
import { esc, renderContent, tagHue, inline, COPY_ICON, CHECK_ICON } from './render.js';
import { PageEditor, editors, hydrateRefs, clearRefCache, showMenu, showStatusPicker, activeEditor } from './editor.js';
import { toast, updateStatus, setConnected, setLivePaused, openModal, closeModal, copyText, noteSaved, resetSaved } from './ui.js';
import { decorateCode } from './code.js';
import { onSettingChange, getSetting, setSetting } from './settings.js';
import { settingsForm } from './settings-ui.js';
import { importDialog } from './backup-ui.js';
import { historyDialog, deletedPagesDialog } from './history-ui.js';
import { Calendar } from './calendar.js';
import { workbook, setWorkbook, withWb } from './workbook.js';
import { loadStatuses, statusOf, withStatus, badgeHtml, taskTitle, nextStatus } from './tasks.js';
import { ACTIONS, keyFor, comboOf, prettyKey, matches } from './keys.js';
import { openPane, closePane, isPaneShowing, paneKind } from './pane.js';
import { openFilePane } from './pdfview.js';
import { downloadImage } from './images.js';
import { isUnlocked as cryptoIsUnlocked, lock as cryptoLock } from './crypto.js';
import { unlockDialog } from './secure-ui.js';

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
  // The assets table has many columns: give it more room than a page of text.
  main.classList.toggle('wide-table', hash === '/assets');
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
      const params = new URLSearchParams(q === -1 ? '' : rest.slice(q + 1));
      // &edit=1 also puts the cursor in that block (from the task list).
      await pageView(name, seq, params.get('b'), params.get('edit') === '1');
    }
    else if (hash === '/all') { calendar.select(null); await allPagesView(seq); }
    else if (hash === '/assets') { calendar.select(null); await assetsView(seq); }
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

async function pageView(name, seq, blockId, editBlock = false) {
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
  // The star in the sidebar's favourites (×) can change this page's star too.
  const onFavorite = (e) => {
    if (!star.isConnected) { document.removeEventListener('blockseq:favorite', onFavorite); return; }
    if (e.detail.name.toLowerCase() === data.name.toLowerCase()) { fav = e.detail.on; drawStar(); }
  };
  document.addEventListener('blockseq:favorite', onFavorite);
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
      ...(isJournal || data.name.toLowerCase() === 'task' ? [] : [['Rename…', () => renameDialog(data)]]),
      ['History…', () => historyDialog(data.name)],
      [isJournal ? 'Delete journal' : 'Delete page', () => deletePage(data.name, isJournal), 'danger'],
    ]);
  });
  header.append(title, star, actions);
  const body = el('div');
  const refs = el('section', 'backlinks');
  main.replaceChildren(header, body, refs);
  const editor = new PageEditor(body, data);
  renderBacklinks(refs, data.backlinks);
  if (blockId) editor.reveal(blockId, { edit: editBlock });
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
  if (!confirm(`Delete the ${what} "${name}"? You can bring it back from All pages → Recently deleted.`)) return;
  for (const ed of editors) if (ed.lower === name.toLowerCase()) { ed.dirty = false; ed.dispose(); }
  const r = await api.deletePage(name);
  if (r.ok || r.status === 404) {
    invalidatePageNames();
    refreshCalendar();
    toast(journal ? 'Journal deleted' : 'Page deleted');
    const target = journal ? '#/journals' : '#/all';
    if (location.hash === target) route(); else location.hash = target;
  } else {
    toast(`Delete failed: ${explain(r.data, 'Could not delete it')}`);
  }
}

// Renames a page or tag; every link and tag to it is rewritten on the server.
async function renameDialog(data) {
  const refs = data.backlinks.reduce((n, g) => n + g.blocks.length, 0);
  const body = el('div', 'dialog-form');
  const label = el('label', 'field');
  label.append(el('span', '', 'New name'));
  const input = el('input');
  input.value = data.name;
  label.append(input);
  const note = el('p', 'muted small', refs
    ? `${refs} block${refs === 1 ? '' : 's'} link to or tag this page; they will be updated to the new name.`
    : 'No other blocks link to this page yet.');
  const merge = el('p', 'small rename-merge');
  const err = el('p', 'error small');
  body.append(label, note, merge, err);
  const names = await getPageNames(true);
  const check = () => {
    const v = input.value.trim().toLowerCase();
    const other = v && v !== data.name.toLowerCase() && names.find((n) => n.toLowerCase() === v);
    merge.textContent = other ? `A page called “${other}” already exists. Its blocks are kept and this page's blocks are added after them.` : '';
  };
  input.addEventListener('input', check);
  const go = async () => {
    const to = input.value.trim();
    if (!to || to === data.name) return false;
    // Let pending edits land under the old name first.
    for (const ed of [...editors]) if (!ed.disposed) ed.dispose();
    await settleSaves();
    const r = await api.renamePage(data.name, to);
    if (!r.ok) {
      err.textContent = explain(r.data, 'Could not rename it');
      route(); // reopen the editors
      return false;
    }
    closeModal();
    clearRefCache();
    invalidatePageNames();
    refreshFavorites(true);
    const n = r.data.updated_pages;
    toast(r.data.merged ? `Merged into ${r.data.page.name}` : `Renamed${n ? `; updated ${n} page${n === 1 ? '' : 's'}` : ''}`);
    location.hash = pageHref(r.data.page.name);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  openModal(`Rename “${data.name}”`, body, [['Cancel'], ['Rename', () => { go(); return false; }, 'primary']]);
  input.focus();
  input.select();
}

// True when a name is a journal date like "Nov 11th, 2026".
function journalNameDay(name) {
  return /^[A-Z][a-z]{2} \d{1,2}(st|nd|rd|th), \d{4}$/.test(name);
}


// ---- favorites ---------------------------------------------------------------

const favBox = document.getElementById('favorites');
let favTimer = null;
function refreshFavorites(now = false) {
  clearTimeout(favTimer);
  favTimer = setTimeout(async () => {
    if (!getSetting('favorites')) return;
    let favs;
    try { favs = (await api.sidebar()).favorites; } catch { return; }
    const list = favBox.querySelector('.fav-list');
    list.replaceChildren(...favs.map((name) => {
      const row = el('div', 'fav-row');
      const a = el('a', 'fav', name);
      a.href = pageHref(name);
      a.dataset.name = name.toLowerCase();
      // Unstar without opening or deleting the page.
      const x = el('button', 'fav-remove', '×');
      x.type = 'button';
      x.title = 'Remove from favorites (the page stays)';
      x.setAttribute('aria-label', `Remove ${name} from favorites`);
      x.addEventListener('click', async () => {
        const r = await api.setFavorite(name, false);
        if (!r.ok) { toast('Could not update favorites'); return; }
        document.dispatchEvent(new CustomEvent('blockseq:favorite', { detail: { name, on: false } }));
        refreshFavorites(true);
        if (location.hash === '#/all') refreshView();
        toast(`Removed ${name} from favorites`);
      });
      row.append(a, x);
      return row;
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
  const deletedBtn = el('button', 'link-button', 'Recently deleted…');
  deletedBtn.type = 'button';
  deletedBtn.addEventListener('click', () => deletedPagesDialog());
  header.append(deletedBtn);
  const controls = el('div', 'list-controls');
  const filter = el('input', 'filter');
  filter.type = 'search';
  filter.placeholder = 'Filter pages';
  // Which pages to list; remembered per browser.
  const SHOW = [['pages', 'Pages', 'Hide journals'], ['journals', 'Journals', 'Only journals'], ['starred', 'Starred', 'Only starred pages'], ['all', 'All', 'Everything']];
  let show = getSetting('allPagesShow') || 'pages';
  const showGroup = el('div', 'seg');
  showGroup.setAttribute('role', 'group');
  for (const [value, label, title] of SHOW) {
    const b = el('button', 'seg-btn', label);
    b.type = 'button';
    b.title = title;
    b.dataset.value = value;
    b.addEventListener('click', () => { show = value; setSetting('allPagesShow', value); draw(); });
    showGroup.append(b);
  }
  const keep = (p) => (show === 'pages' ? p.journal_day == null
    : show === 'journals' ? p.journal_day != null
      : show === 'starred' ? p.favorite : true);
  const newBtn = el('button', 'primary', 'New page');
  newBtn.addEventListener('click', () => {
    const n = prompt('Page name');
    if (n?.trim()) location.hash = pageHref(n.trim());
  });
  controls.append(filter, showGroup, newBtn);
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'page-table');
  const COLS = [['favorite', '★'], ['name', 'Page name'], ['tags', 'Tags'], ['words', 'Words'], ['created_at', 'Created at'], ['updated_at', 'Updated at']];
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
        if (key === 'favorite') th.title = 'Sort by favorites';
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
    showGroup.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.value === show));
    const rows = pages.filter((p) => keep(p)
      && (p.name.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q))));
    rows.sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      return (typeof x === 'string' ? x.localeCompare(y, undefined, { sensitivity: 'base' }) : Number(x) - Number(y)) * sortDir;
    });
    headRow.querySelectorAll('th').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.key === sortKey);
      th.dataset.dir = th.dataset.key === sortKey ? (sortDir > 0 ? '▲' : '▼') : '';
    });
    tbody.replaceChildren(...rows.map((p) => {
      const tr = el('tr');
      const starCell = el('td', 'col-favorite');
      const star = el('button', 'star-cell' + (p.favorite ? ' on' : ''), p.favorite ? '★' : '☆');
      star.type = 'button';
      star.title = p.favorite ? 'Remove from favorites' : 'Add to favorites';
      star.addEventListener('click', async (e) => {
        e.stopPropagation();
        p.favorite = !p.favorite;
        const r = await api.setFavorite(p.name, p.favorite);
        if (!r.ok) { p.favorite = !p.favorite; toast('Could not update favorites'); }
        draw();
        refreshFavorites(true);
      });
      starCell.append(star);
      const name = el('td', 'col-name');
      const link = el('a', '', p.name);
      link.href = pageHref(p.name);
      name.append(link);
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
      const words = el('td', 'col-words', (p.words || 0).toLocaleString());
      tr.append(starCell, name, tags, words, created, updated);
      tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = pageHref(p.name); });
      return tr;
    }));
    empty.textContent = rows.length ? '' : q ? 'No matching pages.'
      : show === 'starred' ? 'No starred pages yet. Click a ☆ to star one.'
        : show === 'journals' ? 'No journals yet.' : 'No pages yet.';
  };
  filter.addEventListener('input', draw);
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
  reloadStatuses();
  loadWorkbooks();
  for (const ed of editors) ed.remoteChanged();
  refreshView();
}

// The open stream, or null while live updates are paused (see 'replaced').
let events = null;

function connectEvents() {
  const es = new EventSource('/api/events');
  events = es;
  setLivePaused(false);
  let opened = false;
  es.onopen = () => {
    setConnected(true);
    if (opened) resyncAll(); // we may have missed events while disconnected
    opened = true;
  };
  es.onerror = () => {
    setConnected(false);
    // A dropped connection is retried by the browser itself. An error
    // response (a proxy's 502 while Blockseq restarts, 401 once signed out)
    // closes the stream for good, so start a new one after a pause.
    if (es.readyState === EventSource.CLOSED && events === es) {
      events = null;
      setTimeout(() => { if (!events && !document.hidden) connectEvents(); }, 5000);
    }
  };
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === 'resync') return resyncAll();
    if (ev.type === 'replaced') {
      // Too many tabs are open. Stay off until this tab is shown again,
      // instead of reconnecting and pushing another tab off in turn.
      es.close();
      events = null;
      setLivePaused(true);
      return;
    }
    if (ev.type === 'workbooks') return workbooksChanged(ev);
    if (ev.type === 'encryption') return;
    // These carry no page name. Handle them before that check, or a status
    // change in another tab never arrives.
    if (ev.type === 'config') return reloadStatuses();
    if (!ev.name) return; // everything below is about one page
    if (ev.wb && ev.wb !== workbook()) return; // another workbook
    refreshCalendar(); // our own saves can add a journal dot too
    refreshTasks();
    if (ev.type === 'assets') return refreshView();
    if (ev.type === 'favorite') return; // the sidebar list refreshes above
    if (ev.client === clientId) return;
    noteSaved(); // another device saved into this workbook
    clearRefCache();
    invalidatePageNames();
    for (const ed of editors) {
      if (ed.lower === ev.name.toLowerCase()) ed.remoteChanged(ev.type === 'deleted' ? undefined : ev.version);
    }
    refreshView();
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!events) connectEvents();
  resyncAll();
});

window.addEventListener('beforeunload', (e) => {
  const dirty = [...editors].filter((ed) => ed.dirty);
  if (!dirty.length) return;
  // Writes each local draft synchronously, before anything else.
  dirty.forEach((ed) => ed.save({ keepalive: true }));
  // Leaving for the sign-in page: the drafts keep the edits, no prompt.
  if (signingOut) return;
  e.preventDefault();
  e.returnValue = '';
});

// ---- keyboard shortcuts --------------------------------------------------------

const ACTION_FNS = {
  search: () => { searchInput.focus(); searchInput.select(); },
  toggleSidebar: () => toggleSidebar(),
  toggleTasks: () => toggleTasks({ fromKey: true }),
  focusEditor: () => focusEditor(),
  goJournals: () => { location.hash = '#/journals'; },
  goAllPages: () => { location.hash = '#/all'; },
  goAssets: () => { location.hash = '#/assets'; },
  switchWorkbook: () => openWorkbookDialog(),
  help: () => openHelp(),
  toggleLock: () => document.getElementById('lock-toggle').click(),
};
let pendingKey = null; // first key of a two-key sequence ("g" of "g j")
let pendingTimer = null;

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || !e.key) return;
  const combo = comboOf(e);
  if (!combo) return;
  const inField = !!e.target.closest?.('input, textarea, select, [contenteditable]');
  const modal = document.querySelector('.modal-overlay');
  // Esc outside a block closes the side pane.
  if (e.key === 'Escape' && !inField && !modal && paneKind()) { closePane(); return; }
  if (modal) return;
  const seq = pendingKey ? `${pendingKey} ${combo}` : null;
  pendingKey = null;
  clearTimeout(pendingTimer);
  for (const [id, , , , noField] of ACTIONS) {
    const want = keyFor(id);
    if (!ACTION_FNS[id] || !want) continue;
    if ((noField || want.length === 1 || want.includes(' ')) && inField) continue;
    if (want === combo || want === seq) {
      e.preventDefault();
      ACTION_FNS[id]();
      return;
    }
  }
  // Start of a sequence?
  if (!inField && ACTIONS.some(([id]) => keyFor(id).startsWith(`${combo} `))) {
    pendingKey = combo;
    pendingTimer = setTimeout(() => { pendingKey = null; }, 1000);
    return;
  }
  // Undo/redo when no block is being edited (inside a block the editor handles it).
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !inField && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase())) {
    const ed = activeEditor();
    if (!ed) return;
    e.preventDefault();
    if (e.key.toLowerCase() === 'y' || e.shiftKey) ed.redo(); else ed.undo();
  }
});

// Gmail-style help screen ("?" when not editing).
const FIXED_KEYS = [
  ['Editing', [
    ['Enter', 'New block (splits at the cursor)'], ['Shift + Enter', 'New line in the block'],
    ['Tab / Shift + Tab', 'Indent / outdent'], ['Backspace at start', 'Merge with the block above'],
    ['Alt + Shift + ↑ / ↓', 'Move block'], ['Ctrl + ↑ / ↓', 'Collapse / expand'],
    ['↑ / ↓', 'Previous / next block'], ['Esc', 'Stop editing'],
    ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / redo'],
  ]],
  ['Selecting blocks', [
    ['Esc', 'Select the block you are editing'], ['Shift + ↑ / ↓', 'Select more blocks'],
    ['Drag across blocks', 'Select them'], ['Shift + click', 'Select a range'],
    ['Ctrl + C / Ctrl + X / Ctrl + V', 'Copy / cut / paste blocks'], ['Backspace', 'Delete selected blocks'],
    ['Ctrl + A', 'Select all blocks'], ['Enter', 'Edit the first selected block'],
  ]],
  ['Typing', [
    ['#', 'Tag: pick an existing one or make a new one'],
    ['[[', 'Link a page'], ['((', 'Reference a block'], ['/', 'Commands (link, code, admonitions, statuses…)'],
    ['``` then Tab', 'Code block'], ['#quote', 'Quote block (block and children)'],
  ]],
];

function openHelp() {
  const body = el('div', 'help-grid');
  const groups = {};
  for (const [id, label, , group] of ACTIONS) (groups[group] ||= []).push([prettyKey(keyFor(id)), label]);
  const section = (title, rows) => {
    const s = el('section', 'help-section');
    s.append(el('h3', '', title));
    for (const [k, label] of rows) {
      const r = el('div', 'help-row');
      const keys = el('span', 'help-keys');
      k.split(' then ').forEach((part, i) => {
        if (i) keys.append(el('span', 'help-then', 'then'));
        part.split(' / ').forEach((alt, j) => {
          if (j) keys.append(el('span', 'help-then', '/'));
          keys.append(el('kbd', '', alt));
        });
      });
      r.append(keys, el('span', 'help-label', label));
      s.append(r);
    }
    body.append(s);
  };
  Object.entries(groups).forEach(([g, rows]) => section(g, rows));
  FIXED_KEYS.forEach(([g, rows]) => section(g, rows));
  const box = openModal('Keyboard shortcuts', body, [['Change shortcuts', () => { openSettings('keyboard'); return false; }], ['Close']]);
  box.classList.add('modal-wide');
}

function openSettings(category) {
  const form = settingsForm(category);
  const box = openModal('Settings', form, [['Close', () => form.canClose()]]);
  box.classList.add('modal-wide');
}
document.getElementById('open-settings').addEventListener('click', () => openSettings());
document.getElementById('help-toggle').addEventListener('click', () => openHelp());
const signOutButton = document.getElementById('sign-out');
signOutButton.addEventListener('click', () => signOut());
showSignOut(signOutButton);
document.getElementById('tasks-toggle').addEventListener('click', () => toggleTasks());

// ---- workbooks ----------------------------------------------------------------

const wbButton = document.getElementById('workbook-switch');
let workbookList = [];

function workbookName(id) {
  return workbookList.find((w) => w.id === id)?.name || (id === 'main' ? 'Main' : id);
}

function showWorkbookName() {
  wbButton.querySelector('.wb-name').textContent = workbookName(workbook());
  document.title = workbook() === 'main' ? 'Blockseq' : `${workbookName(workbook())} · Blockseq`;
}

async function loadWorkbooks() {
  try { workbookList = await api.workbooks(); } catch { /* offline */ }
  // A workbook removed from the server: fall back to Main.
  if (workbookList.length && !workbookList.some((w) => w.id === workbook())) setWorkbook('main');
  showWorkbookName();
  return workbookList;
}

async function switchWorkbook(id) {
  closeModal();
  if (id === workbook()) return;
  for (const ed of [...editors]) if (!ed.disposed) ed.dispose();
  await settleSaves(); // finish saving into the old workbook first
  setWorkbook(id);
  resetSaved();
  clearRefCache();
  invalidatePageNames();
  showWorkbookName();
  calendar.refresh();
  refreshFavorites(true);
  closePane();
  toast(`Opened workbook ${workbookName(id)}`);
  if (location.hash === '#/journals') route(); else location.hash = '#/journals';
}

function newWorkbookDialog() {
  const body = el('div', 'dialog-form');
  const label = el('label', 'field');
  label.append(el('span', '', 'Name'));
  const input = el('input');
  input.placeholder = 'e.g. Home Lab';
  input.maxLength = 64;
  label.append(input);
  const err = el('p', 'error small');
  body.append(label, el('p', 'muted small', 'A workbook is a separate set of pages, journals and assets, stored in its own folder on the server.'), err);
  const create = async () => {
    const name = input.value.trim();
    if (!name) return false;
    const r = await api.createWorkbook(name);
    if (!r.ok) { err.textContent = explain(r.data, 'Could not create it'); return false; }
    await loadWorkbooks();
    switchWorkbook(r.data.id);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  openModal('New workbook', body, [['Cancel'], ['Create', () => { create(); return false; }, 'primary']]);
  input.focus();
}

// Icons for the workbook menu's buttons.
const wbIcon = (d) => `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const WB_ICONS = {
  rename: wbIcon('M12.5 4.5l3 3L7 16H4v-3zM11 6l3 3'),
  delete: wbIcon('M4 6h12M8 6V4h4v2M6 6l.8 10h6.4L14 6M8.5 9v4.5M11.5 9v4.5'),
  import: wbIcon('M10 3v9M6.5 8.5L10 12l3.5-3.5M4 13v3h12v-3'),
  create: wbIcon('M10 4v12M4 10h12'),
  open: wbIcon('M3 6.5V15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-6L8.5 5H4a1 1 0 0 0-1 1.5z'),
  close: wbIcon('M5.5 5.5l9 9M14.5 5.5l-9 9'),
};

// The workbook menu: pick a workbook, then Open or Rename it.
async function openWorkbookDialog(selectId = workbook()) {
  const body = el('div', 'dialog-form');
  const list = el('div', 'journal-pick');
  list.setAttribute('role', 'listbox');
  list.tabIndex = 0;
  body.append(list, el('p', 'muted small',
    'To add a workbook from another place, copy its folder into workbooks/ in the server\'s data folder (e.g. /var/lib/blockseq/workbooks/My Notes), or use Import backup. A Logseq graph folder (with pages/ and journals/) is imported the first time you open it; its original files are kept in logseq-original/.'));
  let selected = selectId;
  const open = () => switchWorkbook(selected);
  openModal('Workbooks', body, [
    ['Rename…', () => { renameWorkbookDialog(selected); return false; }, '', WB_ICONS.rename],
    ['Delete…', () => { deleteWorkbookDialog(selected); return false; }, 'danger', WB_ICONS.delete],
    ['Import backup…', () => { importDialog(); return false; }, '', WB_ICONS.import],
    ['New workbook…', () => { newWorkbookDialog(); return false; }, '', WB_ICONS.create],
    ['Open', () => { open(); return false; }, 'primary', WB_ICONS.open],
    ['Close', undefined, '', WB_ICONS.close],
  ]);
  list.append(el('p', 'muted', 'Loading…'));
  await loadWorkbooks();
  if (!workbookList.some((w) => w.id === selected)) selected = workbook();
  const paint = () => list.querySelectorAll('.pick-row').forEach((r) => {
    const on = r.dataset.id === selected;
    r.classList.toggle('selected', on);
    r.setAttribute('aria-selected', on);
  });
  list.replaceChildren(...workbookList.map((w) => {
    const row = el('button', 'pick-row' + (w.id === workbook() ? ' active' : ''));
    row.type = 'button';
    row.dataset.id = w.id;
    row.setAttribute('role', 'option');
    const note = w.id === workbook() ? 'open now' : w.kind === 'logseq' ? 'Logseq graph · imports on open' : w.kind === 'empty' ? 'new' : '';
    const label = el('span', 'wb-label-col');
    const where = w.absolute || (w.path === '.' ? 'data folder' : w.path);
    label.append(el('span', 'wb-row-name', w.name), el('span', 'wb-path', where));
    label.lastChild.title = w.absolute
      ? 'Where this workbook is stored on the server'
      : 'Where this workbook is stored, relative to the data folder';
    row.append(label, el('span', 'muted small', note));
    // Click selects, double-click (or Enter) opens. The server opens (and,
    // for a Logseq graph, imports) it on first use.
    row.addEventListener('click', () => { selected = w.id; paint(); });
    row.addEventListener('dblclick', open);
    return row;
  }));
  paint();
  list.addEventListener('keydown', (e) => {
    const i = workbookList.findIndex((w) => w.id === selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = workbookList[Math.max(0, Math.min(workbookList.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      selected = next.id;
      paint();
      list.querySelector(`.pick-row[data-id="${CSS.escape(selected)}"]`)?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open();
    } else if (e.key === 'F2') {
      e.preventDefault();
      renameWorkbookDialog(selected);
    }
  });
  list.querySelector('.pick-row.selected')?.focus();
}

function deleteWorkbookDialog(id) {
  const w = workbookList.find((x) => x.id === id);
  if (!w) return;
  if (id === 'main') {
    toast("Main can't be deleted: it is the server's data folder itself");
    return;
  }
  const body = el('div', 'dialog-form');
  body.append(el('p', '', `Delete the workbook “${w.name}”: its pages, journals and files.`));
  const parent = w.absolute
    ? `${w.absolute.replace(/[/\\][^/\\]*$/, '')}/.trash/`
    : `${w.path.includes('/') ? w.path.replace(/[/\\][^/\\]*$/, '') : 'workbooks'}/.trash/ inside the data folder`;
  body.append(el('p', 'muted small', `Nothing is erased: the folder is moved to ${parent}, where it can be moved back (or removed for good). Consider downloading a backup first (Settings → Backup).`));
  const label = el('label', 'field');
  label.append(el('span', '', `Type the name to confirm: ${w.name}`));
  const input = el('input');
  input.autocomplete = 'off';
  label.append(input);
  const err = el('p', 'error small');
  body.append(label, err);
  const go = async () => {
    if (input.value.trim() !== w.name) { err.textContent = 'The name doesn’t match'; return; }
    const r = await api.deleteWorkbook(id);
    if (!r.ok) { err.textContent = explain(r.data, 'Could not delete it'); return; }
    toast(`Deleted ${w.name} (moved to the server's trash folder)`);
    await workbookGone(id);
    openWorkbookDialog();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  const box = openModal(`Delete ${w.name}?`, body, [['Cancel', () => { openWorkbookDialog(id); return false; }], ['Delete workbook', () => { go(); return false; }, 'danger']]);
  box.classList.add('no-overlay-close');
  input.focus();
}

// A workbook was deleted (here or on another device): leave it if open.
async function workbookGone(id) {
  if (workbook() === id) {
    await switchWorkbook('main');
  }
  await loadWorkbooks();
}

function renameWorkbookDialog(id) {
  const w = workbookList.find((x) => x.id === id);
  if (!w) return;
  const body = el('div', 'dialog-form');
  const label = el('label', 'field');
  label.append(el('span', '', 'New name'));
  const input = el('input');
  input.value = w.name;
  input.maxLength = 64;
  label.append(input);
  const err = el('p', 'error small');
  body.append(label, el('p', 'muted small', id === 'main'
    ? 'Main is the server\'s data folder itself, so only the name shown here changes.'
    : `Renames the folder workbooks/${id} on the server. Other devices that have it open follow the new name.`), err);
  const save = async () => {
    const to = input.value.trim();
    if (!to || to === w.name) { openWorkbookDialog(id); return; }
    const r = await api.renameWorkbook(id, to);
    if (!r.ok) { err.textContent = explain(r.data, 'Could not rename it'); return; }
    renamed(id, r.data.id);
    toast(`Renamed to ${r.data.name}`);
    openWorkbookDialog(r.data.id);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  openModal(`Rename ${w.name}`, body, [['Cancel', () => { openWorkbookDialog(id); return false; }], ['Rename', () => { save(); return false; }, 'primary']]);
  input.select();
}

// A workbook's id changed (renamed here or on another device).
async function renamed(from, to) {
  if (workbook() === from) setWorkbook(to);
  await loadWorkbooks();
}

async function workbooksChanged(ev) {
  if (ev.renamed) await renamed(ev.renamed.from, ev.renamed.to);
  else if (ev.deleted) await workbookGone(ev.deleted);
  else await loadWorkbooks();
}

wbButton.addEventListener('click', () => openWorkbookDialog());
// A backup was just restored (backup-ui.js).
document.addEventListener('blockseq:open-workbook', async (e) => {
  await loadWorkbooks();
  switchWorkbook(e.detail.id);
});
// Pages were rewritten by this tab outside an editor (re-encryption).
document.addEventListener('blockseq:resync', () => resyncAll());
// The calendar loads every page; the newest change is the "last saved" time.
document.addEventListener('blockseq:last-change', (e) => {
  noteSaved(e.detail.at);
  showUsage(e.detail.usage);
});

// Header: how much space the workbook takes on the server.
function showUsage(u) {
  const box = document.getElementById('usage');
  if (!box || !u) return;
  box.hidden = false;
  box.querySelector('.usage-value').textContent = formatSize(u.total);
  const where = u.absolute || (u.folder && u.folder !== '.' ? u.folder : '');
  box.title = `${workbookName(workbook())} uses ${formatSize(u.total)} on the server`
    + `${where ? ` (${where})` : ''}:\n`
    + `• assets/ (uploaded files): ${formatSize(u.files)}\n`
    + `• database, with page history: ${formatSize(u.database)}\n`
    + `• Markdown copies and other: ${formatSize(u.other)}`;
}

// Embedded X posts report their height from inside their frame.
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://platform.twitter.com') return;
  let data = e.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
  const msg = data?.['twttr.embed'];
  if (msg?.method !== 'twttr.private.resize') return;
  const height = Number(msg.params?.[0]?.height);
  if (!(height > 0)) return;
  for (const frame of document.querySelectorAll('iframe.tweet-frame')) {
    if (frame.contentWindow === e.source) frame.style.height = `${Math.ceil(height)}px`;
  }
});

// ---- assets --------------------------------------------------------------------

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function assetsView(seq) {
  const list = await api.assets();
  if (seq !== routeSeq) return;
  const header = el('div', 'page-header');
  header.append(el('h1', 'page-title', 'Assets'));
  const controls = el('div', 'list-controls');
  const filter = el('input', 'filter');
  filter.type = 'search';
  filter.placeholder = 'Filter files';
  const unused = el('label', 'check');
  const unusedBox = el('input');
  unusedBox.type = 'checkbox';
  unused.append(unusedBox, ' Only unused');
  const total = el('span', 'muted small');
  total.textContent = `${list.length} file${list.length === 1 ? '' : 's'} · ${formatSize(list.reduce((n, a) => n + a.size, 0))}`;
  controls.append(filter, unused, total);
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'page-table asset-table');
  table.innerHTML = '<thead><tr><th></th><th>File</th><th>Path</th><th>Used on</th><th>Size</th><th>Added</th><th></th></tr></thead>';
  const tbody = el('tbody');
  table.append(tbody);
  wrap.append(table);
  const empty = el('p', 'muted');
  main.replaceChildren(header, controls, wrap, empty);

  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = list.filter((a) => a.name.toLowerCase().includes(q) && (!unusedBox.checked || !a.pages.length));
    tbody.replaceChildren(...rows.map((a) => {
      const url = withWb(`/assets/${encodeURIComponent(a.name)}`);
      const tr = el('tr');
      const thumb = el('td', 'asset-thumb');
      if (a.kind === 'image') {
        const img = el('img');
        img.src = url;
        img.loading = 'lazy';
        img.alt = '';
        thumb.append(img);
      } else if (a.kind === 'video') {
        const v = el('video');
        v.src = `${url}#t=0.5`;
        v.preload = 'metadata';
        v.muted = true;
        thumb.append(v);
      } else {
        thumb.append(el('span', `asset-kind kind-${a.kind}`, (a.name.split('.').pop() || 'file').toUpperCase().slice(0, 4)));
      }
      const name = el('td', 'col-name asset-name', a.name);
      const pathCell = el('td', 'asset-path');
      // absolute is the full server path for a direct connection on this
      // machine, and for every client when BLOCKSEQ_EXPOSE_PATHS is set.
      const shown = a.absolute || a.path;
      const pathText = el('code', '', shown);
      const copy = el('button', 'inline-copy', '');
      copy.type = 'button';
      copy.innerHTML = COPY_ICON;
      copy.dataset.copy = shown; // handled by the page-wide copy-button listener
      copy.title = 'Copy the path';
      copy.setAttribute('aria-label', `Copy the path of ${a.name}`);
      pathCell.append(pathText, copy);
      const used = el('td', 'asset-used');
      if (a.pages.length) {
        a.pages.forEach((p) => { const l = el('a', '', p); l.href = pageHref(p); used.append(l); });
      } else {
        used.append(el('span', 'muted', 'not used'));
      }
      const size = el('td', 'col-updated_at', formatSize(a.size));
      const added = el('td', 'col-updated_at', formatTime(a.modified));
      const actions = el('td', 'asset-actions');
      const btn = (label, fn, cls = '') => {
        const b = el('button', `mini ${cls}`, label);
        b.type = 'button';
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        actions.append(b);
      };
      btn('Open', () => (a.kind === 'image' ? window.open(url, '_blank', 'noopener') : openFilePane(url, a.name, a.kind === 'other' ? 'tab' : a.kind)));
      btn('Download', () => downloadImage(url));
      btn('Delete', async () => {
        const warn = a.pages.length ? `\n\nIt is used on: ${a.pages.join(', ')}. Those blocks will show a broken link.` : '';
        if (!confirm(`Delete ${a.name} from the server? This cannot be undone.${warn}`)) return;
        const r = await api.deleteAsset(a.name);
        if (!r.ok && r.status !== 404) { toast(`Delete failed: ${explain(r.data, 'Could not delete it')}`); return; }
        list.splice(list.indexOf(a), 1);
        draw();
        toast('File deleted');
      }, 'danger');
      tr.append(thumb, name, pathCell, used, size, added, actions);
      return tr;
    }));
    empty.textContent = rows.length ? '' : (list.length ? 'No matching files.' : 'No files yet. Paste or drop images and PDFs into a block.');
  };
  filter.addEventListener('input', draw);
  unusedBox.addEventListener('change', draw);
  draw();
  view = { refresh: () => { if (location.hash === '#/assets') route(); } };
}

// ---- tasks pane ------------------------------------------------------------------

let tasksTimer = null;
function refreshTasks() {
  if (!isPaneShowing('tasks')) return;
  clearTimeout(tasksTimer);
  tasksTimer = setTimeout(renderTasks, 300);
}

// The shortcut (t) opens the list with the keyboard in it; if the list is
// already open but you're elsewhere, it moves the keyboard there instead.
function toggleTasks({ fromKey = false } = {}) {
  if (isPaneShowing('tasks')) {
    const body = document.querySelector('.tasks-pane');
    if (fromKey && body && !body.contains(document.activeElement)) { focusTasks(); return; }
    closePane();
    return;
  }
  const body = el('div', 'tasks-pane');
  openPane({ kind: 'tasks', title: 'Tasks', body });
  renderTasks({ focus: true });
}

let taskFocusId = null; // the task row the keyboard is on
let taskFocusIndex = 0; // its position, for when that task leaves the list
let lastTaskOrder = []; // task ids as last shown (to keep a lingering task in place)

function focusTasks() {
  const list = document.querySelector('.tasks-pane .task-list');
  if (!list) return;
  const rows = [...list.querySelectorAll('.task-row')];
  const row = rows.find((r) => r.dataset.id === taskFocusId) || rows[Math.min(taskFocusIndex, rows.length - 1)] || list;
  row.focus();
}

// "Go to the editor": the page or journal you were working in.
function focusEditor() {
  const live = [...editors].filter((ed) => !ed.disposed && ed.container.isConnected);
  const ed = live.includes(activeEditor()) ? activeEditor() : live[0];
  if (ed) ed.focusForKeyboard();
  else toast('No page open to edit');
}

// A task changed from the list stays visible for a few seconds even if it no
// longer matches (no status, or done while completed ones are hidden), so
// cycling with Space / Ctrl+Enter can carry on: … → Cancelled → no status →
// Backlog → …. Every change restarts the delay.
const LINGER_MS = 6000;
const lingering = new Map(); // task id → { task, until }
let lingerTimer = null;

async function setTaskStatus(t, word) {
  const content = withStatus(t.content, word);
  taskFocusId = t.id;
  lingering.set(t.id, { task: { ...t, content, st: statusOf(content) }, until: Date.now() + LINGER_MS });
  clearTimeout(lingerTimer);
  lingerTimer = setTimeout(() => renderTasks(), LINGER_MS + 100);
  const r = await api.putBlock(t.id, content, t.content);
  if (!r.ok) lingering.delete(t.id);
  // The server tags the change as this tab's own, so the live-update stream
  // won't tell this tab's editor; tell it here, or its next save would
  // conflict with the change just made.
  if (r.ok) {
    for (const ed of editors) if (ed.lower === t.page_name.toLowerCase()) ed.remoteChanged(r.data.page.version);
  }
  if (r.status === 409) toast('That task was changed elsewhere; the list is refreshed, try again');
  else if (!r.ok) toast(explain(r.data, 'Could not change the status'));
  await renderTasks({ focus: true });
}

async function renderTasks({ focus = false } = {}) {
  const body = document.querySelector('.tasks-pane');
  if (!body) return;
  const keepFocus = focus || body.contains(document.activeElement);
  let tasks;
  try { tasks = await api.tasks(); } catch (e) { body.replaceChildren(el('p', 'error', e.message)); return; }
  const showDone = !!getSetting('tasksShowDone');
  const controls = el('div', 'tasks-controls');
  const label = el('label', 'check');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = showDone;
  box.addEventListener('change', () => { setSetting('tasksShowDone', box.checked); renderTasks(); });
  label.append(box, ' Show completed');
  const items = tasks.map((t) => ({ ...t, st: statusOf(t.content) })).filter((t) => t.st);
  const open = items.filter((t) => !t.st.done).length;
  // Recently changed tasks: shown even if filtered out; a task that lost its
  // status (so the server no longer lists it) goes back where it was.
  const now = Date.now();
  for (const [id, l] of lingering) if (l.until < now) lingering.delete(id);
  for (const [id, l] of lingering) {
    const at = items.findIndex((t) => t.id === id);
    if (at !== -1) { items[at].keep = true; continue; }
    const before = lastTaskOrder.slice(0, Math.max(0, lastTaskOrder.indexOf(id))).reverse().find((x) => items.some((t) => t.id === x));
    const pos = before ? items.findIndex((t) => t.id === before) + 1 : items.findIndex((t) => t.page_name === l.task.page_name);
    items.splice(pos < 0 ? items.length : pos, 0, { ...l.task, keep: true });
  }
  controls.append(el('span', 'muted small', `${open} open`), label);
  const list = el('div', 'task-list');
  list.tabIndex = -1;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Tasks');
  const byId = new Map();
  let lastPage = null;
  const shown = [];
  for (const t of items) {
    if (t.st?.done && !showDone && !t.keep) continue;
    shown.push(t.id);
    if (t.page_name !== lastPage) {
      const h = el('a', 'task-page', t.page_name);
      h.href = pageHref(t.page_name);
      list.append(h);
      lastPage = t.page_name;
    }
    const row = el('div', 'task-row' + (t.st?.done ? ' done' : '') + (t.keep && (!t.st || (t.st.done && !showDone)) ? ' lingering' : ''));
    const badge = t.st ? badgeHtml(t.st) : '<button type="button" class="status-badge no-status" title="Change status">No status</button>';
    row.innerHTML = `${badge}<span class="task-text">${inline(taskTitle(t.content))}</span>`;
    row.tabIndex = -1;
    row.dataset.id = t.id;
    row.setAttribute('role', 'option');
    byId.set(t.id, t);
    row.addEventListener('focus', () => {
      taskFocusId = t.id;
      taskFocusIndex = [...list.querySelectorAll('.task-row')].indexOf(row);
    });
    row.querySelector('.status-badge').addEventListener('click', (e) => {
      e.stopPropagation();
      taskFocusId = t.id;
      showStatusPicker(e.clientX, e.clientY, t.st?.word, (word) => setTaskStatus(t, word));
    });
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      location.hash = `${pageHref(t.page_name)}?b=${t.id}`;
    });
    list.append(row);
  }
  if (!list.children.length) list.append(el('p', 'muted', items.length ? 'No open tasks.' : 'No tasks yet. Start a block with TODO (or press Ctrl+Enter in a block).'));

  // Keyboard: ↑/↓ (j/k) move, Space or Ctrl+Enter next status, s or
  // Ctrl+Shift+Enter choose one, Enter opens the task in the editor.
  list.addEventListener('keydown', (e) => {
    const rows = [...list.querySelectorAll('.task-row')];
    const i = rows.indexOf(document.activeElement);
    if (!rows.length) return;
    const go = (j) => { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, j))].focus(); };
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if ((e.key === 'ArrowDown' || (plain && e.key === 'j'))) return go(i + 1);
    if ((e.key === 'ArrowUp' || (plain && e.key === 'k'))) return go(i < 0 ? 0 : i - 1);
    if (e.key === 'Home') return go(0);
    if (e.key === 'End') return go(rows.length - 1);
    if (i < 0) return;
    const t = byId.get(rows[i].dataset.id);
    if (matches(e, 'statusPicker') || (plain && e.key === 's')) {
      e.preventDefault();
      const r = rows[i].querySelector('.status-badge').getBoundingClientRect();
      showStatusPicker(r.left, r.bottom, t.st?.word, (word) => setTaskStatus(t, word));
    } else if (matches(e, 'cycleStatus') || (plain && e.key === ' ')) {
      e.preventDefault();
      setTaskStatus(t, nextStatus(t.st?.word));
    } else if (plain && e.key === 'Enter') {
      e.preventDefault();
      location.hash = `${pageHref(t.page_name)}?b=${t.id}&edit=1`;
    }
  });
  const hint = el('div', 'tasks-keys muted small');
  hint.textContent = `↑ ↓ move · Space next status · s choose · Enter edit · ${prettyKey(keyFor('focusEditor'))} editor · Esc close`;
  body.replaceChildren(controls, list, hint);
  lastTaskOrder = shown;
  if (keepFocus) focusTasks();
}

// ---- statuses --------------------------------------------------------------------

async function reloadStatuses() {
  await loadStatuses();
  refreshTasks();
  for (const ed of editors) if (!ed.editing && !ed.codeEdit) ed.render?.();
}
document.addEventListener('blockseq:statuses', () => {
  refreshTasks();
  for (const ed of editors) if (!ed.editing && !ed.codeEdit) ed.render?.();
});

// Copy buttons on ``inline code`` work everywhere (pages, references, tasks).
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.inline-copy');
  if (!btn) return;
  e.preventDefault();
  copyText(btn.dataset.copy);
  btn.innerHTML = CHECK_ICON;
  btn.classList.add('copied');
  setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('copied'); }, 1200);
});
document.addEventListener('mousedown', (e) => {
  if (e.target.closest?.('.inline-copy')) e.preventDefault(); // don't end editing elsewhere
});

// #Encrypted blocks: open them on unlock; save and hide them on lock.
document.addEventListener('blockseq:unlocked', () => {
  for (const ed of editors) ed.openSecrets();
  encryptPending();
  updateLockButton();
});

// Encrypts #Encrypted blocks that are still plain text on pages that aren't
// open (tagged before the password existed). Runs in the background.
async function encryptPending() {
  let names;
  try { names = await api.encryptionPending(); } catch { return; }
  let done = 0;
  for (const name of names) {
    if ([...editors].some((ed) => !ed.disposed && ed.lower === name.toLowerCase())) continue; // open: done above
    try {
      const data = await api.page(name);
      const ed = new PageEditor(document.createElement('div'), data);
      await ed.sealNow();
      ed.dispose();
      done++;
    } catch { /* try again next unlock */ }
  }
  if (done) toast(`Encrypted blocks on ${done} more page${done === 1 ? '' : 's'}`);
}
document.addEventListener('blockseq:locking', (e) => { for (const ed of editors) e.detail.wait.push(ed.beforeLock()); });
document.addEventListener('blockseq:locked', () => { for (const ed of editors) ed.afterLock(); updateLockButton(); toast('Encrypted blocks locked'); });

// Lock / unlock button in the top bar.
const lockToggle = document.getElementById('lock-toggle');
function updateLockButton() {
  const open = cryptoIsUnlocked();
  lockToggle.textContent = open ? '🔓' : '🔒';
  lockToggle.title = `${open ? 'Lock' : 'Unlock'} encrypted blocks (${prettyKey(keyFor('toggleLock'))})`;
  lockToggle.classList.toggle('open', open);
}
lockToggle.addEventListener('click', () => (cryptoIsUnlocked() ? cryptoLock() : unlockDialog()));
updateLockButton();

// Image sizes ({:size "half"}) depend on the picture's real size, known once loaded.
const SIZE_FACTORS = { original: 1, half: 0.5, quarter: 0.25 };
document.addEventListener('load', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.size) return;
  img.style.width = img.dataset.size === 'small' ? '96px' : `${Math.max(16, Math.round(img.naturalWidth * SIZE_FACTORS[img.dataset.size]))}px`;
}, true);

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
  root.classList.toggle('comments-grey', getSetting('commentColor') === 'grey');
  root.classList.toggle('wide', !!getSetting('wideLayout'));
  root.classList.toggle('tag-colors', !!getSetting('tagColors'));
  root.classList.toggle('no-favorites', !getSetting('favorites'));
  favBox.classList.toggle('hidden', !getSetting('favorites'));
}
applySettings();
refreshFavorites(true);
onSettingChange((name) => {
  if (['paneWidth', 'sidebar', 'tasksShowDone', 'keys', 'allPagesShow'].includes(name)) return;
  applySettings();
  if (['linksNewTab', 'codeFold', 'codeFoldLines', 'codeFoldShow'].includes(name)) for (const ed of editors) if (!ed.editing && !ed.codeEdit) ed.render?.();
  if (name === 'favorites') refreshFavorites(true);
  if (name === 'weekStart') calendar.render();
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
showWorkbookName();
// Statuses decide how blocks render, so load them before the first page.
Promise.all([loadStatuses(), loadWorkbooks()]).finally(route);
