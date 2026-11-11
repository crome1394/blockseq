// Per-device preferences, kept in this browser's localStorage.

const KEY = 'blockseq.settings';
const DEFAULTS = {
  threading: true, // highlight the path from the edited block up to its parents
  liveCode: true, // syntax colours while editing code blocks
  codeWrap: false, // wrap long lines in code blocks instead of scrolling sideways
};

const listeners = new Set();
let cache = null;

function load() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    Object.assign(cache, JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch { /* storage blocked or corrupt: use defaults */ }
  return cache;
}

export function getSetting(name) {
  return load()[name];
}

export function setSetting(name, value) {
  load()[name] = value;
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* not persisted */ }
  listeners.forEach((fn) => fn(name, value));
}

export function onSettingChange(fn) {
  listeners.add(fn);
}

const OPTIONS = [
  ['threading', 'Bullet threading', 'Highlight the line from the block you are editing up through its parents.'],
  ['liveCode', 'Highlight code while editing', 'Show syntax colours while you type in a code block. When off, code is plain text until you click away.'],
  ['codeWrap', 'Wrap long lines in code', 'Wrap long lines onto the next row. When off, long lines scroll sideways.'],
];

export function settingsForm() {
  const form = document.createElement('div');
  form.className = 'settings';
  for (const [name, label, help] of OPTIONS) {
    const row = document.createElement('label');
    row.className = 'setting';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!getSetting(name);
    box.addEventListener('change', () => setSetting(name, box.checked));
    const text = document.createElement('div');
    text.innerHTML = `<div class="setting-label"></div><div class="setting-help"></div>`;
    text.firstChild.textContent = label;
    text.lastChild.textContent = help;
    row.append(box, text);
    form.append(row);
  }
  const note = document.createElement('p');
  note.className = 'muted small';
  note.textContent = 'Settings are saved in this browser, so each computer keeps its own.';
  form.append(note);
  return form;
}
