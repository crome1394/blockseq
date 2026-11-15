// The format bar: one for the page, following the block being edited.
// Movable (default) it floats above or below the block depending on the
// scroll position, and dragged by its handle it stays parked where it was
// dropped (per device) until the handle is double-clicked. Inline it is
// inserted in the page between the block and the row above, pushing the
// block down, and has no handle.

import { runSlash, SLASH_COMMANDS } from './autocomplete.js';
import { el } from './dom.js';
import { ALIGN, COLOR, COLORS, HEADING } from './editor.js';
import { closeMenu, showMenu, showStatusPicker } from './menus.js';
import { mathSpans } from './render.js';
import { getSetting, setSetting } from './settings.js';
import { statusOf, stripStatus } from './tasks.js';

// ---- format bar (one for the whole page; follows the block being edited) ----

export let bar = null;
const barIcon = (d, extra = '') => `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>${extra}</svg>`;
const ALIGN_SVG = {
  left: barIcon('M3 5h14M3 10h9M3 15h12'),
  center: barIcon('M3 5h14M5.5 10h9M4 15h12'),
  right: barIcon('M3 5h14M8 10h9M5 15h12'),
};
// [action, label (HTML), title, group]; group "mark" is hidden in code blocks.
// Everything in the / menu is reachable here: common things as buttons, the
// rest in small menus that show each item's slash command.
const BAR_BUTTONS = [
  ['bold', '<b>B</b>', 'Bold (Ctrl+B)', 'mark'],
  ['italic', '<i>I</i>', 'Italic (Ctrl+I)', 'mark'],
  ['strike', '<s>S</s>', 'Strikethrough ~~text~~', 'mark'],
  ['highlight', '<mark>H</mark>', 'Highlight ==text==', 'mark'],
  ['code', barIcon('M7 6l-4 4 4 4M13 6l4 4-4 4'), 'Inline code `text`', 'mark'],
  ['link', barIcon('M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9'), 'Link [text](url)  /link', 'mark'],
  ['page', '<span class="bar-text">[[ ]]</span>', 'Page reference [[ ]]  /page', 'mark'],
  ['blockref', '<span class="bar-text">(( ))</span>', 'Block reference (( ))  /blockref', 'mark'],
  '|',
  ['heading', 'H', 'Heading  /h1 /h2 /h3'],
  ['blocks', `${barIcon('M3 4h14v4H3zM3 12h6v4H3zM12 12h5v4h-5z')}<span class="bar-caret">▾</span>`, 'Insert: code block, table, list, quote, encrypted block, admonitions'],
  ['media', `${barIcon('M15.5 9.5l-5.8 5.8a3.5 3.5 0 0 1-5-5l6.3-6.3a2.3 2.3 0 0 1 3.3 3.3l-6.2 6.2a1.2 1.2 0 0 1-1.7-1.7l5.6-5.6')}<span class="bar-caret">▾</span>`, 'Upload an image, PDF or file, or embed a video'],
  ['dates', `${barIcon('M4 5h12v11H4zM4 8.5h12M7.5 3v3M12.5 3v3')}<span class="bar-caret">▾</span>`, 'Dates and times: today, tomorrow, yesterday, current time, timestamp'],
  ['status', barIcon('M4 10.5l3.5 3.5L16 5.5'), 'Task status (Backlog, Todo, Doing…)'],
  ['math', '∑', 'Maths (LaTeX) builder  /math'],
  '|',
  ['align', '', 'Text alignment'],
  ['color', '<span class="bar-swatch"></span>', 'Block colour'],
  ['more', '⋯', 'More (block menu)'],
];

// Menu groups: slash command ids, '-' for a divider.
const BAR_MENUS = {
  blocks: ['code', 'table', 'numbered', 'quote', 'hr', 'quoteblock', 'encrypted', '-', 'tip', 'note', 'important', 'caution', 'warning', 'pinned'],
  media: ['image', 'pdf', 'file', 'video'],
  dates: ['today', 'tomorrow', 'yesterday', '-', 'time', 'timestamp'],
};

function makeBar() {
  const root = el('div', 'format-bar');
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Formatting');
  const b = { el: root, editor: null, node: null };
  root.append(makeGrip(root));
  for (const def of BAR_BUTTONS) {
    if (def === '|') { root.append(el('span', 'bar-sep')); continue; }
    const [action, label, title, group] = def;
    const btn = el('button', `bar-btn${group ? ` bar-${group}` : ''}`);
    btn.type = 'button';
    btn.innerHTML = label;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.dataset.action = action;
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the cursor
    btn.addEventListener('click', () => b.editor?.barAction(action, btn));
    root.append(btn);
    if (action === 'align') b.align = btn;
    if (action === 'color') b.color = btn;
    if (action === 'heading') b.heading = btn;
  }
  return b;
}

// The ⠿ handle: drag to park the bar anywhere in the window, double-click
// to let it follow the block again. It never takes focus, so the cursor stays.
function makeGrip(root) {
  const grip = el('div', 'bar-grip');
  grip.textContent = '⠿';
  grip.title = 'Drag to move the bar out of the way. Double-click to put it back next to the block.';
  grip.setAttribute('aria-hidden', 'true');
  grip.addEventListener('mousedown', (e) => e.preventDefault());
  grip.addEventListener('dblclick', () => {
    setSetting('formatBarPos', null);
    if (bar?.node) bar.editor?.showBar(bar.node);
  });
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = root.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    root.classList.add('dragging');
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      root.classList.remove('dragging');
      const now = root.getBoundingClientRect();
      setSetting('formatBarPos', { left: Math.round(now.left), top: Math.round(now.top) });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  return grip;
}

// Puts the floating bar at (left, top), kept inside the window.
function place(left, top) {
  const e = bar.el;
  const x = Math.max(4, Math.min(left, window.innerWidth - e.offsetWidth - 4));
  const y = Math.max(4, Math.min(top, window.innerHeight - e.offsetHeight - 4));
  e.style.left = `${Math.round(x)}px`;
  e.style.top = `${Math.round(y)}px`;
  e.style.visibility = '';
}

const parked = () => {
  const pos = getSetting('formatBarPos');
  return pos && Number.isFinite(pos.left) && Number.isFinite(pos.top) ? pos : null;
};

export function hideBar() {
  if (!bar) return;
  bar.el.remove();
  bar.editor = null;
  bar.node = null;
}

// Above the block if it fits below the top of the window, else below it;
// a block taller than the window keeps the bar pinned at the bottom edge.
export function positionBar() {
  if (!bar?.node?.contentEl || !bar.el.isConnected) return;
  if (bar.el.classList.contains('dragging')) return;
  if (bar.el.classList.contains('inline')) {
    // Line it up with the text, not the bullet.
    const wrap = bar.node.el.getBoundingClientRect();
    const indent = bar.node.contentEl.getBoundingClientRect().left - wrap.left;
    bar.el.style.marginLeft = `${Math.round(indent)}px`;
    bar.el.style.maxWidth = `${Math.max(160, wrap.width - indent)}px`;
    return;
  }
  const pos = parked();
  if (pos) { // only reached when movable: inline returned above
    bar.el.style.maxWidth = '';
    bar.el.classList.remove('below');
    return place(pos.left, pos.top);
  }
  const r = bar.node.contentEl.getBoundingClientRect();
  const h = bar.el.offsetHeight;
  const w = bar.el.offsetWidth;
  const gap = 6;
  // Below the fixed header, not under it.
  const header = document.getElementById('topbar')?.getBoundingClientRect();
  const minTop = (header && header.bottom > 0 ? header.bottom : 0) + 6;
  const maxTop = window.innerHeight - h - 8;
  let top;
  if (r.top - h - gap >= minTop) top = r.top - h - gap;
  else if (r.bottom + gap <= maxTop) top = r.bottom + gap;
  else top = maxTop;
  // Stay left of the side pane when it is open (the bar scrolls if narrow).
  const pane = document.getElementById('pane');
  const right = pane && !pane.classList.contains('hidden') ? pane.getBoundingClientRect().left : window.innerWidth;
  bar.el.style.maxWidth = `${Math.max(160, right - 16)}px`;
  const left = Math.max(8, Math.min(r.left - 4, right - Math.min(w, right - 16) - 8));
  const offscreen = r.bottom < 0 || r.top > window.innerHeight;
  bar.el.style.top = `${Math.round(top)}px`;
  bar.el.style.left = `${Math.round(left)}px`;
  bar.el.style.visibility = offscreen ? 'hidden' : '';
  bar.el.classList.toggle('below', top > r.top);
}

let barFrame = 0;
const queueBar = () => {
  if (!bar?.node || barFrame) return;
  barFrame = requestAnimationFrame(() => { barFrame = 0; positionBar(); });
};
window.addEventListener('scroll', queueBar, { capture: true, passive: true });
window.addEventListener('resize', queueBar);

class FormatBarMethods {
  showBar(node) {
    if (!getSetting('formatBar')) return hideBar();
    if (!bar) bar = makeBar();
    bar.editor = this;
    bar.node = node;
    const code = /^```/.test(node.content);
    bar.el.classList.toggle('bar-code', code); // no inline marks in code
    const align = node.props[ALIGN] || 'left';
    bar.align.innerHTML = ALIGN_SVG[align];
    bar.align.title = `Text alignment: ${align} (click to change)`;
    const color = node.props[COLOR];
    bar.color.dataset.color = color || '';
    bar.heading.textContent = (() => {
      const h = /^(#{1,6}) /.exec(stripStatus(node.content))?.[1].length;
      return h ? `H${h}` : node.props[HEADING] === 'true' ? 'HA' : 'H';
    })();
    // Inline: in the page, between the block's row and whatever is above.
    const attach = getSetting('formatBarPlace') === 'inline' && node.el;
    bar.el.classList.toggle('inline', !!attach);
    bar.el.style.marginLeft = '';
    if (attach) {
      bar.el.style.top = '';
      bar.el.style.left = '';
      bar.el.style.visibility = '';
      bar.el.classList.remove('below');
      node.el.prepend(bar.el);
    } else {
      document.body.append(bar.el);
    }
    positionBar();
  }

  // Runs a / command at the cursor, exactly as typing it would.
  barSlash(cmd) {
    const node = this.editing;
    const ta = this.ta;
    if (!node || !ta) return;
    this.beginOp();
    runSlash(this, node, ta, cmd, ta.selectionStart);
    if (bar?.node === node) positionBar();
  }

  barAction(action, button) {
    const node = this.editing;
    const ta = this.ta;
    if (!node || !ta) return;
    const r = button.getBoundingClientRect();
    const keep = { keepFocus: true };
    switch (action) {
      case 'bold': return this.formatText(node, ta, '**');
      case 'italic': return this.formatText(node, ta, '_');
      case 'strike': return this.formatText(node, ta, '~~');
      case 'highlight': return this.formatText(node, ta, '==');
      case 'code': {
        const { selectionStart: a, selectionEnd: b } = ta;
        this.beginOp();
        if (a === b) return this.replaceText(node, ta, a, b, '``', 1);
        const sel = ta.value.slice(a, b);
        return this.replaceText(node, ta, a, b, `\`${sel}\``, 1, 1 + sel.length);
      }
      case 'link': {
        const { selectionStart: a, selectionEnd: b } = ta;
        const sel = ta.value.slice(a, b);
        this.beginOp();
        if (/^https?:\/\/\S+$/.test(sel)) return this.replaceText(node, ta, a, b, `[text](${sel})`, 1, 5);
        const text = `[${sel || 'text'}](https://)`;
        return sel ? this.replaceText(node, ta, a, b, text, sel.length + 3, text.length - 1) : this.replaceText(node, ta, a, b, text, 1, 5);
      }
      case 'heading': {
        const entries = [1, 2, 3, 4, 5, 6].map((n) => ({ label: `Heading ${n}`, fn: () => this.setHeadingStyle(node, n) }));
        entries.push({ label: 'Auto heading (size by depth)', fn: () => this.setHeadingStyle(node, 'auto') }, '-', { label: 'Normal text', fn: () => this.setHeadingStyle(node, 0) });
        return showMenu(r.left, r.bottom, entries, keep);
      }
      case 'align': {
        const order = ['left', 'center', 'right'];
        const next = order[(order.indexOf(node.props[ALIGN] || 'left') + 1) % 3];
        return this.setProp(node, ALIGN, next === 'left' ? null : next);
      }
      case 'color': {
        const sw = el('div', 'menu-swatches');
        for (const c of [...COLORS, null]) {
          const b = el('button', c ? `swatch sw-${c}` : 'swatch sw-none');
          b.title = c || 'No colour';
          if ((node.props[COLOR] || null) === c) b.classList.add('active');
          b.addEventListener('click', () => { closeMenu(); this.setProp(node, COLOR, c); });
          sw.append(b);
        }
        return showMenu(r.left, r.bottom, [{ element: sw }], keep);
      }
      case 'status':
        return showStatusPicker(r.left, r.bottom, statusOf(node.content)?.word, (word) => {
          this.beginOp();
          this.setMarker(node, word);
        });
      case 'math': {
        const at = ta.selectionStart;
        const span = mathSpans(ta.value).find((m) => m.start < at && at < m.end);
        return this.openMath(node, span || null, span ? null : at);
      }
      case 'page': case 'blockref': {
        // Selected text becomes the reference; otherwise start one and search.
        const { selectionStart: a, selectionEnd: b } = ta;
        const sel = ta.value.slice(a, b);
        if (sel && action === 'page') {
          this.beginOp();
          return this.replaceText(node, ta, a, b, `[[${sel}]]`);
        }
        return this.barSlash(action);
      }
      case 'blocks': case 'media': case 'dates': {
        const entries = BAR_MENUS[action].map((id) => {
          if (id === '-') return '-';
          const cmd = SLASH_COMMANDS.find((c) => c.id === id);
          return { label: cmd.label, shortcut: `/${id}`, fn: () => this.barSlash(id) };
        });
        return showMenu(r.left, r.bottom, entries, keep);
      }
      case 'more': return this.showBlockMenu(node, { clientX: r.left, clientY: r.bottom }, keep);
      default:
    }
  }
}

// Adds the methods above to the editor class.
export function installFormatBar(cls) {
  for (const name of Object.getOwnPropertyNames(FormatBarMethods.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(cls.prototype, name, Object.getOwnPropertyDescriptor(FormatBarMethods.prototype, name));
  }
}
