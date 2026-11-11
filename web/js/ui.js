// Small shared UI helpers: toast, clipboard and the save-status indicator.

import { editors } from './editor.js';

let toastTimer = null;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// navigator.clipboard needs HTTPS, so fall back to execCommand on plain HTTP.
export function copyText(text) {
  if (window.isSecureContext && navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  } else {
    legacyCopy(text);
  }
}

function legacyCopy(text) {
  const active = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  active?.focus?.();
}

let connected = true;
export function setConnected(value) {
  connected = value;
  updateStatus();
}

export function updateStatus() {
  const el = document.getElementById('status');
  if (!el) return;
  const all = [...editors];
  let text = 'Saved';
  let cls = 'ok';
  if (all.some((e) => e.conflict)) { text = 'Conflict: choose a version'; cls = 'bad'; }
  else if (all.some((e) => e.offline)) { text = 'Offline: changes not saved yet'; cls = 'bad'; }
  else if (all.some((e) => e.dirty || e.saving)) { text = 'Saving…'; cls = 'busy'; }
  else if (!connected) { text = 'Reconnecting…'; cls = 'busy'; }
  el.textContent = text;
  el.className = `status ${cls}`;
}
