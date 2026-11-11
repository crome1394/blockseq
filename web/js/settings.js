// Per-device preferences, kept in this browser's localStorage.

const KEY = 'blockseq.settings';
const DEFAULTS = {
  theme: 'auto', // colour theme; 'auto' follows the system light/dark setting
  wideLayout: false, // let pages use the full window width
  favorites: true, // show favourite pages in the sidebar
  tagColors: true, // give each trailing tag its own colour
  threading: true, // highlight the path from the edited block up to its parents
  threadAlways: false, // show lines from every block to its parent all the time
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

// [value, label]. Each theme's colours are in app.css under [data-theme].
export const THEMES = [
  ['auto', 'Automatic (follow system)'],
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['sepia', 'Sepia'],
  ['solarized-light', 'Solarized Light'],
  ['catppuccin-latte', 'Catppuccin Latte'],
  ['nord', 'Nord'],
  ['solarized-dark', 'Solarized Dark'],
  ['gruvbox', 'Gruvbox Dark'],
  ['dracula', 'Dracula'],
  ['catppuccin-mocha', 'Catppuccin Mocha'],
  ['tokyo-night', 'Tokyo Night'],
];

// [name, label, help, choices?]. Without choices the setting is a checkbox.
const OPTIONS = [
  ['theme', 'Theme', 'Colours for the whole app.', THEMES],
  ['wideLayout', 'Use the full window width', 'Pages grow with the window instead of staying a fixed reading width.'],
  ['favorites', 'Favorites in the sidebar', 'Show starred pages in the sidebar. Star a page with ☆ next to its title.'],
  ['tagColors', 'Colour tags', 'Give each tag at the end of a block its own colour.'],
  ['threading', 'Bullet threading', 'Highlight the line from the block you are editing up through its parents.'],
  ['threadAlways', 'Always show bullet threading', 'Show the lines connecting every block to its parent all the time, not only while editing.'],
  ['liveCode', 'Highlight code while editing', 'Show syntax colours while you type in a code block. When off, code is plain text until you click away.'],
  ['codeWrap', 'Wrap long lines in code', 'Wrap long lines onto the next row. When off, long lines scroll sideways.'],
];

export function settingsForm() {
  const form = document.createElement('div');
  form.className = 'settings';
  for (const [name, label, help, choices] of OPTIONS) {
    const row = document.createElement('label');
    row.className = 'setting';
    const text = document.createElement('div');
    text.innerHTML = `<div class="setting-label"></div><div class="setting-help"></div>`;
    text.firstChild.textContent = label;
    text.lastChild.textContent = help;
    if (choices) {
      row.classList.add('setting-select');
      const select = document.createElement('select');
      for (const [value, text] of choices) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        select.append(opt);
      }
      select.value = getSetting(name);
      select.addEventListener('change', () => setSetting(name, select.value));
      row.append(text, select);
    } else {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!getSetting(name);
      box.addEventListener('change', () => setSetting(name, box.checked));
      row.append(box, text);
    }
    form.append(row);
  }
  const note = document.createElement('p');
  note.className = 'muted small';
  note.textContent = 'Settings are saved in this browser, so each computer keeps its own.';
  form.append(note);
  return form;
}
