// The Settings screen: categories on the left, options on the right.
// Task statuses are saved on the server (shared by every device); everything
// else is saved in this browser.

import { CATEGORIES, settingRow } from './settings.js';
import { ACTIONS, keyFor, setKey, resetKeys, defaultKey, comboOf, prettyKey } from './keys.js';
import { getStatuses, setStatuses, STATUS_COLORS, statusStyle } from './tasks.js';
import { api } from './api.js';
import { toast } from './ui.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let lastCategory = 'appearance';

export function settingsForm(initial) {
  const form = el('div', 'settings-screen');
  const nav = el('nav', 'settings-nav');
  const panel = el('div', 'settings-panel');
  const show = (id) => {
    lastCategory = id;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    const cat = CATEGORIES.find((c) => c.id === id);
    panel.replaceChildren(el('h3', 'settings-heading', cat.label));
    if (id === 'tasks') panel.append(statusEditor());
    else if (id === 'keyboard') panel.append(keyEditor());
    else {
      const list = el('div', 'settings');
      cat.options.forEach((o) => list.append(settingRow(o)));
      panel.append(list);
    }
    if (id !== 'tasks') panel.append(el('p', 'muted small', 'Saved in this browser, so each computer keeps its own.'));
  };
  for (const c of CATEGORIES) {
    const b = el('button', '', c.label);
    b.type = 'button';
    b.dataset.id = c.id;
    b.addEventListener('click', () => show(c.id));
    nav.append(b);
  }
  form.append(nav, panel);
  show(initial || lastCategory);
  return form;
}

// ---- task statuses ----------------------------------------------------------

function statusEditor() {
  const wrap = el('div', 'status-editor');
  wrap.append(el('p', 'muted small', 'A block becomes a task when it starts with one of these words, e.g. "TODO Call the bank". Ctrl+Enter steps through them in this order. Finished statuses are struck out and hidden from open tasks. Shared by all your devices.'));
  let rows = getStatuses().map((s) => ({ ...s }));
  const table = el('div', 'status-rows');
  const draw = () => {
    table.replaceChildren();
    const head = el('div', 'status-row status-row-head');
    ['Word in text', 'Label', 'Colour', 'Finished', ''].forEach((h) => head.append(el('span', '', h)));
    table.append(head);
    rows.forEach((s, i) => {
      const row = el('div', 'status-row');
      const word = el('input', 'status-word');
      word.value = s.word;
      word.spellcheck = false;
      word.addEventListener('input', () => { word.value = word.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); s.word = word.value; });
      const label = el('input');
      label.value = s.label;
      label.addEventListener('input', () => { s.label = label.value; preview.textContent = label.value || s.word; });
      const color = el('select');
      for (const c of Object.keys(STATUS_COLORS)) {
        const o = el('option', '', c);
        o.value = c;
        color.append(o);
      }
      color.value = s.color;
      const preview = el('span', 'status-badge', s.label);
      preview.setAttribute('style', statusStyle(s));
      color.addEventListener('change', () => { s.color = color.value; preview.setAttribute('style', statusStyle(s)); });
      const colorCell = el('span', 'status-color');
      colorCell.append(color, preview);
      const done = el('input');
      done.type = 'checkbox';
      done.checked = !!s.done;
      done.addEventListener('change', () => { s.done = done.checked; });
      const tools = el('span', 'status-tools');
      const btn = (text, title, fn, disabled) => {
        const b = el('button', 'mini', text);
        b.type = 'button';
        b.title = title;
        b.disabled = !!disabled;
        b.addEventListener('click', fn);
        tools.append(b);
      };
      btn('↑', 'Move up', () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); }, i === 0);
      btn('↓', 'Move down', () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); }, i === rows.length - 1);
      btn('✕', 'Remove', () => { rows.splice(i, 1); draw(); }, rows.length === 1);
      row.append(word, label, colorCell, done, tools);
      table.append(row);
    });
  };
  draw();
  const actions = el('div', 'status-actions');
  const add = el('button', '', '+ Add status');
  add.type = 'button';
  add.addEventListener('click', () => { rows.push({ word: 'NEW', label: 'New', color: 'teal', done: false }); draw(); });
  const reset = el('button', '', 'Defaults');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    rows = [['BACKLOG', 'Backlog', 'gray', false], ['TODO', 'Todo', 'blue', false], ['DOING', 'Doing', 'amber', false],
      ['IN-REVIEW', 'In Review', 'purple', false], ['DONE', 'Done', 'green', true], ['CANCELED', 'Cancelled', 'red', true]]
      .map(([word, label, color, done]) => ({ word, label, color, done }));
    draw();
  });
  const save = el('button', 'primary', 'Save statuses');
  save.type = 'button';
  save.addEventListener('click', async () => {
    const r = await api.saveConfig({ statuses: rows });
    if (!r.ok) { toast(r.data?.error || 'Could not save'); return; }
    setStatuses(rows.map((s) => ({ ...s })));
    toast('Statuses saved');
    document.dispatchEvent(new CustomEvent('blockseq:statuses'));
  });
  actions.append(add, reset, save);
  wrap.append(table, actions, el('p', 'muted small', 'Renaming a word does not change blocks that already use the old word.'));
  return wrap;
}

// ---- key bindings -----------------------------------------------------------

function keyEditor() {
  const wrap = el('div', 'key-editor');
  wrap.append(el('p', 'muted small', 'Click a shortcut, then press the new keys. Single letters (like t) only work when you are not typing in a block; two letters typed quickly (like g then j) make a sequence. Esc cancels.'));
  const list = el('div', 'key-rows');
  const draw = () => {
    list.replaceChildren();
    const used = {};
    for (const [id] of ACTIONS) (used[keyFor(id)] ||= []).push(id);
    for (const [id, label] of ACTIONS) {
      const row = el('div', 'key-row');
      const name = el('span', 'key-label', label);
      const btn = el('button', 'key-btn', prettyKey(keyFor(id)));
      btn.dataset.old = keyFor(id);
      btn.type = 'button';
      if (used[keyFor(id)]?.length > 1) { btn.classList.add('clash'); btn.title = 'Used by more than one action'; }
      btn.addEventListener('click', () => capture(btn, (combo) => { setKey(id, combo); draw(); }));
      const reset = el('button', 'mini', '↺');
      reset.type = 'button';
      reset.title = `Reset to ${prettyKey(defaultKey(id))}`;
      reset.disabled = keyFor(id) === defaultKey(id);
      reset.addEventListener('click', () => { setKey(id, defaultKey(id)); draw(); });
      row.append(name, btn, reset);
      list.append(row);
    }
  };
  draw();
  const all = el('button', '', 'Reset all shortcuts');
  all.type = 'button';
  all.addEventListener('click', () => { resetKeys(); draw(); });
  wrap.append(list, all);
  return wrap;
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
