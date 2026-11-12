// The All pages view: the sortable, filterable table of pages.

import { api } from './api.js';
import { main, pageHref, refreshFavorites, routeSeq } from './app.js';
import { formatTime } from './dates.js';
import { el } from './dom.js';
import { deletedPagesDialog } from './history-ui.js';
import { tagHue } from './render.js';
import { getSetting, setSetting } from './settings.js';
import { toast } from './ui.js';

// ---- all pages ---------------------------------------------------------------

export async function allPagesView(seq) {
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
