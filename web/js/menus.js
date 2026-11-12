// Small popup menus: the right-click menu and the task status picker.

import { el } from './dom.js';
import { getStatuses, statusStyle } from './tasks.js';

// ---- small popup menu --------------------------------------------------------

// entries: [label, fn, cls] arrays, {label, fn, shortcut, danger} objects,
// {element} for custom rows, or '-' for a separator.
// A small menu of coloured status badges; onPick(word or null).

export function showStatusPicker(x, y, current, onPick, opts = { keepFocus: true }) {
  const entries = getStatuses().map((st) => {
    const item = el('div', 'item status-item');
    const b = el('span', 'status-badge', st.label);
    b.setAttribute('style', statusStyle(st));
    item.append(b);
    if (st.word === current) item.append(el('span', 'check', '✓'));
    item.addEventListener('click', () => { closeMenu(); onPick(st.word); });
    return { element: item };
  });
  const none = el('div', 'item');
  none.append(el('span', 'muted', 'No status'));
  none.addEventListener('click', () => { closeMenu(); onPick(null); });
  showMenu(x, y, [...entries, '-', { element: none }], opts);
}

export function showMenu(x, y, entries, opts = {}) {
  closeMenu();
  const menu = el('div', 'popup menu');
  // Opened from the format bar: clicks must not end editing.
  if (opts.keepFocus) menu.addEventListener('mousedown', (e) => e.preventDefault());
  for (const entry of entries) {
    if (entry === '-') { menu.append(el('div', 'menu-sep')); continue; }
    if (entry.element) { menu.append(entry.element); continue; }
    const [label, fn, cls] = Array.isArray(entry) ? entry : [entry.label, entry.fn, entry.danger ? 'danger' : ''];
    const item = el('div', 'item' + (cls ? ` ${cls}` : ''));
    item.append(el('span', '', label));
    if (entry.shortcut) item.append(el('kbd', '', entry.shortcut));
    item.addEventListener('click', () => { closeMenu(); fn(); });
    menu.append(item);
  }
  menu.style.position = 'fixed';
  document.body.append(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  menu.style.top = `${y + h + 14 > window.innerHeight ? Math.max(8, y - h - 6) : y + 6}px`;
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside);
    window.addEventListener('scroll', closeMenu, { once: true, capture: true });
  }, 0);
}

function onOutside(e) {
  if (!e.target.closest('.menu')) closeMenu();
}

export function closeMenu() {
  document.querySelector('.menu')?.remove();
  document.removeEventListener('mousedown', onOutside);
}
