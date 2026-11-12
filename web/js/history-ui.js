// Page history: earlier versions of a page (kept by the server, see
// src/db/history.rs), with a preview and Restore; and the list of deleted pages
// that can be brought back.

import { api, explain } from './api.js';
import { el } from './dom.js';
import { renderOutline } from './render.js';
import { openModal, closeModal, toast } from './ui.js';

const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const REASONS = {
  autosave: 'Saved while editing',
};
const reasonText = (r) => REASONS[r] || r.charAt(0).toUpperCase() + r.slice(1);

// Shows a page's kept versions. `deleted`: the page doesn't exist now.
export async function historyDialog(name, { deleted = false, pageId = '' } = {}) {
  let entries;
  try { entries = await api.history(name, pageId); } catch (e) { toast(`Could not load the history: ${e.message}`); return; }
  const body = el('div', 'history');
  if (!entries.length) {
    body.append(el('p', 'muted', 'No earlier versions of this page yet. While you edit, a version is kept every 10 minutes, and always before big changes, a "Keep mine", a restore or a deletion.'));
    openModal(`History of ${name}`, body, [['Close']]);
    return;
  }
  const list = el('div', 'history-list');
  const preview = el('div', 'history-preview');
  body.append(list, preview);
  let selected = null;
  const box = openModal(`History of ${name}`, body, [
    ['Close'],
    [deleted ? 'Restore this page' : 'Restore this version', () => { restore(); return false; }, 'primary'],
  ]);
  box.classList.add('modal-wide', 'history-modal');
  const restoreBtn = box.querySelector('.modal-actions .primary');
  restoreBtn.disabled = true;

  const show = async (entry, row) => {
    list.querySelectorAll('.history-row').forEach((r) => r.classList.toggle('active', r === row));
    preview.replaceChildren(el('p', 'muted', 'Loading…'));
    const v = await api.historyVersion(entry.id).catch(() => null);
    if (!v) { preview.replaceChildren(el('p', 'error', 'Could not load this version')); return; }
    selected = v;
    restoreBtn.disabled = false;
    const head = el('div', 'history-preview-head');
    head.append(el('strong', '', when(v.saved_at)), el('span', 'muted small', ` · ${reasonText(v.reason)}`));
    const tree = el('div');
    tree.innerHTML = renderOutline(v.blocks);
    preview.replaceChildren(head, tree);
  };
  let opened = false;
  entries.forEach((entry) => {
    const row = el('button', 'history-row');
    row.type = 'button';
    const detail = entry.damaged
      ? "Damaged version, can't be opened"
      : `${entry.blocks} block${entry.blocks === 1 ? '' : 's'} · ${entry.words} words`;
    row.append(el('span', 'history-when', when(entry.saved_at)), el('span', 'history-why', reasonText(entry.reason)),
      el('span', 'muted small', detail));
    if (entry.damaged) {
      row.disabled = true;
    } else {
      row.addEventListener('click', () => show(entry, row));
      if (!opened) { opened = true; show(entry, row); }
    }
    list.append(row);
  });

  async function restore() {
    if (!selected) return;
    const question = deleted
      ? `Bring back “${name}” as it was on ${when(selected.saved_at)}?`
      : `Replace the current “${name}” with the version from ${when(selected.saved_at)}? The current version is kept in the history, so this can be undone.`;
    if (!confirm(question)) return;
    restoreBtn.disabled = true;
    const r = await api.restoreVersion(selected.id);
    if (!r.ok) { toast(explain(r.data, 'Could not restore it')); restoreBtn.disabled = false; return; }
    closeModal();
    toast(deleted ? `Restored ${name}` : 'Older version restored');
    document.dispatchEvent(new CustomEvent('blockseq:resync'));
    const target = `#/page/${encodeURIComponent(r.data.page.name)}`;
    if (location.hash !== target) location.hash = target;
  }
}

// Deleted pages that still have kept versions.
export async function deletedPagesDialog() {
  let pages;
  try { pages = await api.deletedPages(); } catch (e) { toast(`Could not load them: ${e.message}`); return; }
  const body = el('div', 'dialog-form');
  if (!pages.length) {
    body.append(el('p', 'muted', 'No deleted pages to bring back.'));
  } else {
    body.append(el('p', 'muted small', 'Pick a page to see its last versions and restore it.'));
    const list = el('div', 'journal-pick');
    for (const p of pages) {
      const row = el('button', 'pick-row');
      row.type = 'button';
      row.append(el('span', '', p.name), el('span', 'muted small', `deleted ${when(p.deleted_at)}`));
      row.addEventListener('click', () => historyDialog(p.name, { deleted: true, pageId: p.page_id }));
      list.append(row);
    }
    body.append(list);
  }
  openModal('Recently deleted pages', body, [['Close']]);
}
