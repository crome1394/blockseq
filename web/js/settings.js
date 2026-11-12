// Per-device preferences, kept in this browser's localStorage.

const KEY = 'blockseq.settings';
const DEFAULTS = {
  theme: 'auto', // colour theme; 'auto' follows the system light/dark setting
  wideLayout: false, // let pages use the full window width
  favorites: true, // show favourite pages in the sidebar
  tagColors: true, // give each trailing tag its own colour
  threading: true, // highlight the path from the edited block up to its parents
  threadAlways: false, // show lines from every block to its parent all the time
  linksNewTab: true, // open web links in a new browser tab
  formatBar: true, // floating formatting bar while editing a block
  lockMinutes: 15, // lock encrypted blocks after this many idle minutes (0 = never)
  liveCode: true, // syntax colours while editing code blocks
  codeWrap: false, // wrap long lines in code blocks instead of scrolling sideways
  codeFold: true, // long code blocks start folded
  codeFoldLines: 20, // "long" means more lines than this
  codeFoldShow: 6, // lines shown while a code block is folded
  commentColor: 'yellow', // colour of comments in code blocks
  weekStart: '0', // first day of the week in the calendar (0 = Sunday … 6 = Saturday)
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

// Settings grouped for the Settings screen (settings-ui.js). Each option is
// [name, label, help, choices?]; without choices it is a checkbox. Groups
// with `custom` are drawn by settings-ui.js (task statuses, key bindings).
export const CATEGORIES = [
  { id: 'appearance', label: 'Appearance', options: [
    ['theme', 'Theme', 'Colours for the whole app.', THEMES],
    ['wideLayout', 'Use the full window width', 'Pages grow with the window instead of staying a fixed reading width.'],
    ['tagColors', 'Colour tags', 'Give each tag at the end of a block its own colour.'],
  ] },
  { id: 'editor', label: 'Editor', options: [
    ['formatBar', 'Formatting bar while editing', 'Show a small bar of formatting buttons (bold, heading, alignment, colour, status, maths…) above the block you are editing, or below it near the top of the window.'],
    ['linksNewTab', 'Open links in a new tab', 'Web links (including ones made with /link) open in a new browser tab. When off, they open in this tab.'],
    ['threading', 'Bullet threading', 'Highlight the line from the block you are editing up through its parents.'],
    ['threadAlways', 'Always show bullet threading', 'Show the lines connecting every block to its parent all the time, not only while editing.'],
    ['liveCode', 'Highlight code while editing', 'Show syntax colours while you type in a code block.'],
    ['codeWrap', 'Wrap long lines in code', 'Wrap long lines onto the next row. When off, long lines scroll sideways.'],
    ['commentColor', 'Comment colour in code', 'Colour of comments (# in shell, -- in Lua and SQL, // in C-like languages).', [['yellow', 'Yellow'], ['grey', 'Grey (quiet)']]],
    ['codeFold', 'Fold long code blocks', 'Long code blocks start folded, showing their first lines and a "Show all" bar.'],
    ['codeFoldLines', 'Fold code blocks longer than (lines)', 'A code block with more lines than this starts folded.', { number: true, min: 2, max: 1000 }],
    ['codeFoldShow', 'Lines to show when folded', 'How many lines of a folded code block stay visible.', { number: true, min: 1, max: 200 }],
  ] },
  { id: 'sidebar', label: 'Sidebar', options: [
    ['weekStart', 'First day of the week', 'The day the sidebar calendar starts each week on.', [['0', 'Sunday'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday']]],
    ['favorites', 'Favorites in the sidebar', 'Show starred pages in the sidebar. Star a page with ☆ next to its title.'],
  ] },
  { id: 'tasks', label: 'Tasks', custom: true },
  { id: 'security', label: 'Security', options: [
    ['lockMinutes', 'Lock encrypted blocks after (minutes idle)', 'Unlocked #Encrypted blocks lock again after this long without activity. 0 means only when you close the tab.', { number: true, min: 0, max: 1440 }],
  ] },
  { id: 'keyboard', label: 'Keyboard', custom: true },
  { id: 'backup', label: 'Backup', custom: true },
];

// One setting as a form row (checkbox, select or number). `store` reads and
// writes the value; the Settings screen passes a draft so nothing changes
// until Apply.
export function settingRow([name, label, help, choices], store = { get: getSetting, set: setSetting }) {
  const row = document.createElement('label');
  row.className = 'setting';
  const text = document.createElement('div');
  text.innerHTML = `<div class="setting-label"></div><div class="setting-help"></div>`;
  text.firstChild.textContent = label;
  text.lastChild.textContent = help;
  if (choices?.number) {
    row.classList.add('setting-select');
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'setting-number';
    input.min = choices.min;
    input.max = choices.max;
    input.value = store.get(name);
    input.addEventListener('change', () => {
      const v = Math.round(Number(input.value));
      if (!Number.isFinite(v)) { input.value = store.get(name); return; }
      const clamped = Math.min(choices.max, Math.max(choices.min, v));
      input.value = clamped;
      store.set(name, clamped);
    });
    row.append(text, input);
  } else if (choices) {
    row.classList.add('setting-select');
    const select = document.createElement('select');
    for (const [value, t] of choices) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = t;
      select.append(opt);
    }
    select.value = store.get(name);
    select.addEventListener('change', () => store.set(name, select.value));
    row.append(text, select);
  } else {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!store.get(name);
    box.addEventListener('change', () => store.set(name, box.checked));
    row.append(box, text);
  }
  return row;
}
