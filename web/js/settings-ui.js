// The Settings screen: a search box, categories on the left, options on the
// right. Changes are drafts until Apply; Undo throws away unapplied changes,
// or (when there are none) reverts the last Apply. Task statuses are saved on
// the server (shared by every device); everything else in this browser.

import { el } from './dom.js';
import { CATEGORIES, settingRow, getSetting, setSetting } from './settings.js';
import { ACTIONS, defaultKey, comboOf, prettyKey } from './keys.js';
import { getStatuses, setStatuses, STATUS_COLORS, statusStyle } from './tasks.js';
import { api, explain } from './api.js';
import { toast } from './ui.js';
import { securityPanel } from './secure-ui.js';
import { backupPanel } from './backup-ui.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DEFAULT_STATUSES = [
  ['BACKLOG', 'Backlog', 'gray', false], ['TODO', 'Todo', 'blue', false], ['DOING', 'Doing', 'amber', false],
  ['IN-REVIEW', 'In Review', 'purple', false], ['DONE', 'Done', 'green', true], ['CANCELED', 'Cancelled', 'red', true],
].map(([word, label, color, done]) => ({ word, label, color, done }));

// Every per-browser setting the screen edits.
const NAMES = [...CATEGORIES.flatMap((c) => (c.options || []).map((o) => o[0])), 'keys'];
const snapshot = () => Object.fromEntries(NAMES.map((n) => [n, clone(getSetting(n))]));

let lastCategory = 'appearance';
let lastApplied = null; // what the settings were before the last Apply

export function settingsForm(initial) {
  let base = snapshot(); // as currently applied
  let draft = clone(base);
  let statusBase = clone(getStatuses());
  let statusDraft = clone(statusBase);
  const store = { get: (n) => draft[n], set: (n, v) => { draft[n] = v; updateBar(); } };
  const keyOf = (id) => draft.keys?.[id] ?? defaultKey(id);
  const setKeyDraft = (id, combo) => {
    const keys = { ...(draft.keys || {}) };
    if (combo === defaultKey(id)) delete keys[id]; else keys[id] = combo;
    draft.keys = keys;
    updateBar();
  };
  const dirty = () => !same(draft, base) || !same(statusDraft, statusBase);

  const form = el('div', 'settings-wrap');
  const search = el('input', 'filter settings-search');
  search.type = 'search';
  search.placeholder = 'Search settings';
  const screen = el('div', 'settings-screen');
  const nav = el('nav', 'settings-nav');
  const panel = el('div', 'settings-panel');
  const bar = el('div', 'settings-bar');
  const barNote = el('span', 'muted small');
  const undoBtn = el('button', '', 'Undo');
  undoBtn.type = 'button';
  const applyBtn = el('button', 'primary', 'Apply');
  applyBtn.type = 'button';
  bar.append(barNote, undoBtn, applyBtn);
  screen.append(nav, panel);
  form.append(search, screen, bar);

  function updateBar() {
    const d = dirty();
    applyBtn.disabled = !d;
    undoBtn.disabled = !d && !lastApplied;
    undoBtn.textContent = d ? 'Undo changes' : 'Undo last apply';
    undoBtn.title = d ? 'Throw away changes you have not applied' : 'Go back to the settings before the last Apply';
    barNote.textContent = d ? 'You have changes that are not applied yet.' : '';
  }

  async function applyValues(values, statuses) {
    for (const n of NAMES) if (!same(values[n], getSetting(n))) setSetting(n, clone(values[n]));
    if (!same(statuses, getStatuses())) {
      const r = await api.saveConfig({ statuses });
      if (!r.ok) { toast(explain(r.data, 'Could not save the task statuses')); return false; }
      setStatuses(clone(statuses));
      document.dispatchEvent(new CustomEvent('blockseq:statuses'));
    }
    return true;
  }

  applyBtn.addEventListener('click', async () => {
    const before = { values: clone(base), statuses: clone(statusBase) };
    if (!(await applyValues(draft, statusDraft))) return;
    lastApplied = before;
    base = clone(draft);
    statusBase = clone(statusDraft);
    updateBar();
    toast('Settings applied');
  });

  undoBtn.addEventListener('click', async () => {
    if (dirty()) {
      draft = clone(base);
      statusDraft = clone(statusBase);
      toast('Changes undone');
    } else if (lastApplied) {
      if (!(await applyValues(lastApplied.values, lastApplied.statuses))) return;
      base = clone(lastApplied.values);
      statusBase = clone(lastApplied.statuses);
      draft = clone(base);
      statusDraft = clone(statusBase);
      lastApplied = null;
      toast('Settings put back');
    }
    redraw();
    updateBar();
  });

  // ---- category view ----

  const show = (id) => {
    lastCategory = id;
    search.value = '';
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    const cat = CATEGORIES.find((c) => c.id === id);
    panel.replaceChildren(el('h3', 'settings-heading', cat.label));
    if (id === 'tasks') panel.append(statusEditor());
    else if (id === 'keyboard') panel.append(keyEditor(ACTIONS));
    else if (id === 'backup') {
      const live = el('div');
      panel.append(live);
      backupPanel().then((p) => live.replaceChildren(p));
    }
    else {
      const list = el('div', 'settings');
      cat.options.forEach((o) => list.append(settingRow(o, store)));
      panel.append(list);
      if (id === 'security') {
        const live = el('div');
        panel.insertBefore(live, list);
        securityPanel().then((p) => live.replaceChildren(p));
      }
    }
    if (id !== 'backup') {
      panel.append(el('p', 'muted small', id === 'tasks'
        ? 'Task statuses are shared by all your devices.'
        : 'Saved in this browser, so each computer keeps its own.'));
    }
  };

  // ---- search view ----

  const runSearch = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return show(lastCategory);
    nav.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    panel.replaceChildren(el('h3', 'settings-heading', `Results for “${search.value.trim()}”`));
    const hit = (...texts) => texts.some((t) => String(t).toLowerCase().includes(q));
    let found = 0;
    for (const cat of CATEGORIES) {
      let section = null;
      const add = (node) => {
        if (!section) {
          section = el('section', 'settings-result');
          section.append(el('div', 'settings-result-cat', cat.label));
          panel.append(section);
        }
        section.append(node);
        found++;
      };
      if (cat.options) {
        for (const o of cat.options) if (hit(o[1], o[2], cat.label)) add(settingRow(o, store));
      } else if (cat.id === 'keyboard') {
        const actions = ACTIONS.filter(([id, label, , group]) => hit(label, group, prettyKey(keyOf(id)), 'keyboard shortcut key'));
        if (actions.length) add(keyEditor(actions, true));
      }
      if (cat.id === 'security' && hit('encrypt', 'encrypted', 'password', 'recovery', 'lock', 'security')) {
        const open = el('button', '', 'Encryption password and locking…');
        open.type = 'button';
        open.addEventListener('click', () => show('security'));
        add(open);
      } else if (cat.id === 'backup' && hit('backup', 'export', 'import', 'restore', 'zip', 'download')) {
        const open = el('button', '', 'Back up or restore a workbook…');
        open.type = 'button';
        open.addEventListener('click', () => show('backup'));
        add(open);
      } else if (cat.id === 'tasks' && hit('task', 'status', 'statuses', 'colour', 'color', 'todo', 'done', ...statusDraft.map((s) => `${s.word} ${s.label}`))) {
        const open = el('button', '', 'Edit task statuses…');
        open.type = 'button';
        open.addEventListener('click', () => show('tasks'));
        add(open);
      }
    }
    if (!found) panel.append(el('p', 'muted', 'No settings match.'));
  };
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; runSearch(); } });

  const redraw = () => (search.value.trim() ? runSearch() : show(lastCategory));

  // ---- task statuses ----

  function statusEditor() {
    const wrap = el('div', 'status-editor');
    wrap.append(el('p', 'muted small', 'A block becomes a task when it starts with one of these words, e.g. "TODO Call the bank". Ctrl+Enter steps through them in this order. Finished statuses are struck out and hidden from open tasks.'));
    const table = el('div', 'status-rows');
    const changed = () => { updateBar(); };
    const draw = () => {
      table.replaceChildren();
      const head = el('div', 'status-row status-row-head');
      ['Word in text', 'Label', 'Colour', 'Finished', ''].forEach((h) => head.append(el('span', '', h)));
      table.append(head);
      statusDraft.forEach((s, i) => {
        const row = el('div', 'status-row');
        const word = el('input', 'status-word');
        word.value = s.word;
        word.spellcheck = false;
        word.addEventListener('input', () => { word.value = word.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); s.word = word.value; changed(); });
        const label = el('input');
        label.value = s.label;
        const preview = el('span', 'status-badge', s.label);
        preview.setAttribute('style', statusStyle(s));
        label.addEventListener('input', () => { s.label = label.value; preview.textContent = label.value || s.word; changed(); });
        const color = el('select');
        for (const c of Object.keys(STATUS_COLORS)) {
          const o = el('option', '', c);
          o.value = c;
          color.append(o);
        }
        color.value = s.color;
        color.addEventListener('change', () => { s.color = color.value; preview.setAttribute('style', statusStyle(s)); changed(); });
        const colorCell = el('span', 'status-color');
        colorCell.append(color, preview);
        const done = el('input');
        done.type = 'checkbox';
        done.checked = !!s.done;
        done.addEventListener('change', () => { s.done = done.checked; changed(); });
        const tools = el('span', 'status-tools');
        const btn = (text, title, fn, disabled) => {
          const b = el('button', 'mini', text);
          b.type = 'button';
          b.title = title;
          b.disabled = !!disabled;
          b.addEventListener('click', () => { fn(); draw(); changed(); });
          tools.append(b);
        };
        btn('↑', 'Move up', () => { [statusDraft[i - 1], statusDraft[i]] = [statusDraft[i], statusDraft[i - 1]]; }, i === 0);
        btn('↓', 'Move down', () => { [statusDraft[i + 1], statusDraft[i]] = [statusDraft[i], statusDraft[i + 1]]; }, i === statusDraft.length - 1);
        btn('✕', 'Remove', () => { statusDraft.splice(i, 1); }, statusDraft.length === 1);
        row.append(word, label, colorCell, done, tools);
        table.append(row);
      });
    };
    draw();
    const actions = el('div', 'status-actions');
    const add = el('button', '', '+ Add status');
    add.type = 'button';
    add.addEventListener('click', () => { statusDraft.push({ word: 'NEW', label: 'New', color: 'teal', done: false }); draw(); changed(); });
    const reset = el('button', '', 'Defaults');
    reset.type = 'button';
    reset.addEventListener('click', () => { statusDraft.splice(0, statusDraft.length, ...clone(DEFAULT_STATUSES)); draw(); changed(); });
    actions.append(add, reset);
    wrap.append(table, actions, el('p', 'muted small', 'Renaming a word does not change blocks that already use the old word.'));
    return wrap;
  }

  // ---- key bindings ----

  function keyEditor(actions, compact = false) {
    const wrap = el('div', 'key-editor');
    if (!compact) wrap.append(el('p', 'muted small', 'Click a shortcut, then press the new keys. Single letters (like t) only work when you are not typing in a block; two letters typed quickly (like g then j) make a sequence. Esc cancels.'));
    const list = el('div', 'key-rows');
    const draw = () => {
      list.replaceChildren();
      const used = {};
      for (const [id] of ACTIONS) (used[keyOf(id)] ||= []).push(id);
      for (const [id, label] of actions) {
        const row = el('div', 'key-row');
        const btn = el('button', 'key-btn', prettyKey(keyOf(id)));
        btn.type = 'button';
        btn.dataset.old = keyOf(id);
        if (used[keyOf(id)]?.length > 1) { btn.classList.add('clash'); btn.title = 'Used by more than one action'; }
        btn.addEventListener('click', () => capture(btn, (combo) => { setKeyDraft(id, combo); draw(); }));
        const reset = el('button', 'mini', '↺');
        reset.type = 'button';
        reset.title = `Reset to ${prettyKey(defaultKey(id))}`;
        reset.disabled = keyOf(id) === defaultKey(id);
        reset.addEventListener('click', () => { setKeyDraft(id, defaultKey(id)); draw(); });
        row.append(el('span', 'key-label', label), btn, reset);
        list.append(row);
      }
    };
    draw();
    wrap.append(list);
    if (!compact) {
      const all = el('button', '', 'Reset all shortcuts');
      all.type = 'button';
      all.addEventListener('click', () => { draft.keys = {}; updateBar(); draw(); });
      wrap.append(all);
    }
    return wrap;
  }

  for (const c of CATEGORIES) {
    const b = el('button', '', c.label);
    b.type = 'button';
    b.dataset.id = c.id;
    b.addEventListener('click', () => show(c.id));
    nav.append(b);
  }
  show(initial || lastCategory);
  updateBar();

  // The dialog's Close button asks before throwing away unapplied changes.
  form.canClose = () => !dirty() || confirm('You have changes that are not applied. Close without applying them?');
  setTimeout(() => search.focus(), 0);
  return form;
}

// Waits for the next key combo (or two quick letters) and reports it.
function capture(btn, done) {
  btn.textContent = 'Press keys…';
  btn.classList.add('capturing');
  let first = null;
  let timer = null;
  const finish = (combo) => {
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
    btn.classList.remove('capturing');
    if (combo) done(combo); else btn.textContent = prettyKey(btn.dataset.old || '');
  };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return finish(null);
    const combo = comboOf(e);
    if (!combo) return;
    const single = combo.length === 1;
    if (first) return finish(single ? `${first} ${combo}` : first);
    if (!single) return finish(combo);
    first = combo;
    btn.textContent = `${combo} …`;
    timer = setTimeout(() => finish(first), 700);
  };
  document.addEventListener('keydown', onKey, true);
}
