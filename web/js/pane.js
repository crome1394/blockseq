// The right-hand pane: shows the task list or a PDF next to the page.

import { getSetting, setSetting } from './settings.js';

const pane = document.getElementById('pane');
const titleEl = pane.querySelector('.pane-title');
const actionsEl = pane.querySelector('.pane-actions');
const bodyEl = pane.querySelector('.pane-body');
let current = null; // { kind, key, onClose? }

export function paneKind() {
  return current?.kind || null;
}

// Opens the pane. `kind` ('tasks' | 'pdf') and `key` (e.g. the PDF url)
// identify what it shows; actions are [label, fn, title] header buttons.
export function openPane({ kind, key = '', title, body, actions = [], onClose }) {
  current?.onClose?.();
  current = { kind, key, onClose };
  titleEl.textContent = title;
  actionsEl.replaceChildren(...actions.map(([label, fn, tip]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pane-btn';
    b.textContent = label;
    if (tip) b.title = tip;
    b.addEventListener('click', fn);
    return b;
  }));
  bodyEl.replaceChildren(body);
  pane.classList.remove('hidden');
  document.documentElement.classList.add('pane-open');
  applyWidth();
}

export function closePane() {
  current?.onClose?.();
  current = null;
  pane.classList.add('hidden');
  document.documentElement.classList.remove('pane-open');
  bodyEl.replaceChildren();
}

export function isPaneShowing(kind, key = '') {
  return current?.kind === kind && (key === '' || current.key === key);
}

pane.querySelector('.pane-close').addEventListener('click', closePane);

// Drag the left edge to resize; the width is remembered per browser.
function applyWidth() {
  const w = Math.min(Math.max(getSetting('paneWidth') || 480, 280), Math.round(window.innerWidth * 0.75));
  document.documentElement.style.setProperty('--pane-w', `${w}px`);
}
const grip = pane.querySelector('.pane-grip');
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  pane.classList.add('resizing');
  const move = (ev) => {
    setSetting('paneWidth', Math.round(window.innerWidth - ev.clientX));
    applyWidth();
  };
  const up = () => {
    pane.classList.remove('resizing');
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
});
window.addEventListener('resize', () => { if (current) applyWidth(); });
