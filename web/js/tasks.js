// Task statuses ("TODO Buy milk"). The list is shared by every device and
// lives on the server (Settings > Tasks); a default is used until it loads.

import { api } from './api.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const STATUS_COLORS = {
  gray: null, blue: 215, teal: 175, green: 145, amber: 38, orange: 22, red: 355, pink: 325, purple: 270,
};

let statuses = [
  { word: 'BACKLOG', label: 'Backlog', color: 'gray', done: false },
  { word: 'TODO', label: 'Todo', color: 'blue', done: false },
  { word: 'DOING', label: 'Doing', color: 'amber', done: false },
  { word: 'IN-REVIEW', label: 'In Review', color: 'purple', done: false },
  { word: 'DONE', label: 'Done', color: 'green', done: true },
  { word: 'CANCELED', label: 'Cancelled', color: 'red', done: true },
];

export async function loadStatuses() {
  try {
    const cfg = await api.config();
    if (cfg?.statuses?.length) statuses = cfg.statuses;
  } catch { /* offline: keep what we have */ }
  return statuses;
}

export function getStatuses() {
  return statuses;
}

export function setStatuses(list) {
  statuses = list;
}

// The status a block starts with, or null.
export function statusOf(content) {
  const word = /^(\S+)(?:\s|$)/.exec(content)?.[1];
  return (word && statuses.find((s) => s.word === word)) || null;
}

// "TODO " (with its space) at the start of the text, or "".
export function statusPrefix(content) {
  const st = statusOf(content);
  return st ? content.slice(0, st.word.length).concat(content[st.word.length] === ' ' ? ' ' : '') : '';
}

export function stripStatus(content) {
  return content.slice(statusPrefix(content).length);
}

export function withStatus(content, word) {
  const body = stripStatus(content);
  return word ? `${word} ${body}` : body;
}

// Ctrl+Enter order: none → first → … → last → none.
export function nextStatus(word) {
  const i = statuses.findIndex((s) => s.word === word);
  return i === -1 ? statuses[0]?.word : statuses[i + 1]?.word ?? null;
}

export function statusStyle(st) {
  const hue = STATUS_COLORS[st.color];
  return hue == null ? '--st-h:0;--st-s:0%' : `--st-h:${hue}`;
}

export function badgeHtml(st) {
  return `<button type="button" class="status-badge" data-status="${esc(st.word)}" style="${statusStyle(st)}" title="Change status">${esc(st.label)}</button>`;
}
