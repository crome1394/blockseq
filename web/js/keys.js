// Keyboard shortcuts that can be changed in Settings > Keyboard.
// A binding is "Ctrl+K", "Ctrl+Shift+Enter", "?" or a two-key sequence "g j".

import { getSetting, setSetting } from './settings.js';

// [id, description, default, group, needsNoField]
// needsNoField: only when not typing in a block or box (single-key shortcuts).
export const ACTIONS = [
  ['search', 'Search', 'Ctrl+K', 'Navigation', false],
  ['toggleSidebar', 'Show / hide the sidebar', 'Ctrl+\\', 'Navigation', false],
  ['toggleTasks', 'Show / hide the task list', 't', 'Navigation', true],
  ['goJournals', 'Go to journals', 'g j', 'Navigation', true],
  ['goAllPages', 'Go to all pages', 'g a', 'Navigation', true],
  ['goAssets', 'Go to assets', 'g f', 'Navigation', true],
  ['switchWorkbook', 'Switch workbook', 'w', 'Navigation', true],
  ['help', 'Keyboard shortcuts (this screen)', '?', 'Navigation', true],
  ['cycleStatus', 'Next task status', 'Ctrl+Enter', 'Tasks', false],
  ['statusPicker', 'Choose task status', 'Ctrl+Shift+Enter', 'Tasks', false],
];

export function defaultKey(id) {
  return ACTIONS.find((a) => a[0] === id)?.[2] || '';
}

export function keyFor(id) {
  return getSetting('keys')?.[id] ?? defaultKey(id);
}

export function setKey(id, combo) {
  const keys = { ...(getSetting('keys') || {}) };
  if (combo === defaultKey(id)) delete keys[id]; else keys[id] = combo;
  setSetting('keys', keys);
}

export function resetKeys() {
  setSetting('keys', {});
}

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

// The combo a key event stands for, e.g. "Ctrl+Shift+Enter" or "?".
// Shift is left out for printable characters ("?" already includes it).
export function comboOf(e) {
  if (MODIFIERS.has(e.key)) return null;
  let key = e.key === ' ' ? 'Space' : e.key;
  if (key.length === 1 && /[a-z]/i.test(key) && (e.ctrlKey || e.metaKey || e.altKey)) key = key.toUpperCase();
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  const letterWithMod = /^[A-Z]$/.test(key) && (e.ctrlKey || e.metaKey || e.altKey);
  if (e.shiftKey && (key.length > 1 || letterWithMod)) mods.push('Shift');
  return [...mods, key].join('+');
}

// Matches a single-combo binding (sequences are handled by the global handler).
export function matches(e, id) {
  const want = keyFor(id);
  return !!want && !want.includes(' ') && comboOf(e) === want;
}

// Pretty form for help and settings: "Ctrl+\" → "Ctrl + \", "g j" → "g then j".
export function prettyKey(combo) {
  if (!combo) return '—';
  return combo.split(' ').map((c) => c.split('+').join(' + ')).join(' then ');
}
