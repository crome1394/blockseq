// The tasks pane: every task in the workbook, keyboard control, and the
// short delay before a task whose status was cleared leaves the list.

import { api, explain } from './api.js';
import { pageHref } from './app.js';
import { el } from './dom.js';
import { activeEditor, editors } from './editor.js';
import { keyFor, matches, prettyKey } from './keys.js';
import { showStatusPicker } from './menus.js';
import { closePane, isPaneShowing, openPane } from './pane.js';
import { inline } from './render.js';
import { getSetting, setSetting } from './settings.js';
import { badgeHtml, nextStatus, statusOf, taskTitle, withStatus } from './tasks.js';
import { toast } from './ui.js';

// ---- tasks pane ------------------------------------------------------------------

let tasksTimer = null;
export function refreshTasks() {
  if (!isPaneShowing('tasks')) return;
  clearTimeout(tasksTimer);
  tasksTimer = setTimeout(renderTasks, 300);
}

// The shortcut (t) opens the list with the keyboard in it; if the list is
// already open but you're elsewhere, it moves the keyboard there instead.
export function toggleTasks({ fromKey = false } = {}) {
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
export function focusEditor() {
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
