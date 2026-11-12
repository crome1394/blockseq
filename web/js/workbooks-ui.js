// The workbook menu and its dialogs: switch, new, rename, delete, open,
// and the disk-usage figure in the header.

import { api, explain, invalidatePageNames } from './api.js';
import { calendar, formatSize, refreshFavorites, resyncAll, route, settleSaves } from './app.js';
import { importDialog } from './backup-ui.js';
import { el } from './dom.js';
import { editors } from './editor.js';
import { closePane } from './pane.js';
import { clearRefCache } from './refs.js';
import { closeModal, noteSaved, openModal, resetSaved, toast } from './ui.js';
import { setWorkbook, workbook } from './workbook.js';

// ---- workbooks ----------------------------------------------------------------

const wbButton = document.getElementById('workbook-switch');
let workbookList = [];

function workbookName(id) {
  return workbookList.find((w) => w.id === id)?.name || (id === 'main' ? 'Main' : id);
}

export function showWorkbookName() {
  wbButton.querySelector('.wb-name').textContent = workbookName(workbook());
  document.title = workbook() === 'main' ? 'Blockseq' : `${workbookName(workbook())} · Blockseq`;
}

export async function loadWorkbooks() {
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
export async function openWorkbookDialog(selectId = workbook()) {
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

export async function workbooksChanged(ev) {
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
