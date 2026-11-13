// Thin wrapper around the server's JSON API. Calls go to the current
// workbook (see workbook.js) unless they are about workbooks themselves.

import { withWb } from './workbook.js';

// crypto.randomUUID only exists on HTTPS/localhost, and Blockseq is often
// reached over plain HTTP on a LAN or tailnet address, so build v4 UUIDs by hand.
export function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Identifies this tab, so it can ignore change events caused by its own saves.
export const clientId = uuid();

const enc = encodeURIComponent;

// True while the page is leaving for the sign-in page (no "leave page?" prompt).
export let signingOut = false;

// The session ended (signed out elsewhere, expired, or the password changed).
// Unsaved text is already in this tab's local draft and is offered again
// after signing in.
export function signedOut() {
  if (signingOut) return;
  signingOut = true;
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

async function request(method, url, body, opts = {}) {
  if (!opts.global) url = withWb(url);
  delete opts.global;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...opts,
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text }; }
  }
  if (res.status === 401 && data?.error === 'login') signedOut();
  return { ok: res.ok, status: res.status, data };
}

// Stable codes from the server. `message`, when present, is a short phrase
// the server chose to show. A bare code becomes one of these sentences.
const ERROR_TEXT = {
  invalid: 'That was not accepted.',
  conflict: 'It was changed somewhere else.',
  storage: 'The server could not write that just now.',
  error: 'The server had a problem with that.',
  not_found: 'That could not be found.',
  forbidden: 'Unlock with the current password first.',
  too_large: 'That file is too large.',
  no_space: 'The server does not have enough free space for that.',
  login: 'Signed out. Sign in again to continue.',
};

export function explain(data, fallback) {
  if (typeof data?.message === 'string' && data.message) return data.message;
  const code = data?.error;
  if (typeof code === 'string' && ERROR_TEXT[code]) return ERROR_TEXT[code];
  return fallback;
}

async function getJson(url, opts) {
  const r = await request('GET', url, undefined, opts);
  if (!r.ok) throw new Error(explain(r.data, `HTTP ${r.status}`));
  return r.data;
}

export const api = {
  // { password: true } when signing in is used (BLOCKSEQ_PASSWORD is set).
  session: () => getJson('/api/session', { global: true }),
  // Paired devices (apps with their own token), and unpairing one.
  devices: () => getJson('/api/devices', { global: true }),
  revokeDevice: (id) => request('DELETE', `/api/devices?id=${enc(id)}`, undefined, { global: true }),
  // Zips of Main saved before each Restore into Main, newest first.
  backups: () => getJson('/api/backups', { global: true }),
  // Ends this browser's session, or every browser's with `all`.
  logout: (all = false) => request('POST', `/api/logout${all ? '?all=1' : ''}`, undefined, { global: true }),
  page: (name) => getJson(`/api/page?name=${enc(name)}`),
  // Resolves to {ok, status, data}; status 409 means the page changed elsewhere.
  // `extra`: more body fields, e.g. { overwrite: true } for "Keep mine".
  savePage: (name, baseVersion, blocks, opts, extra = {}) =>
    request('PUT', `/api/page?name=${enc(name)}`, { base_version: baseVersion, blocks, ...extra }, opts),
  deletePage: (name) => request('DELETE', `/api/page?name=${enc(name)}`),
  history: (name, page) => getJson(`/api/history?name=${enc(name)}${page ? `&page=${enc(page)}` : ''}`),
  historyVersion: (id) => getJson(`/api/history/version?id=${enc(id)}`),
  deletedPages: () => getJson('/api/history/deleted'),
  restoreVersion: (id) => request('POST', `/api/history/restore?id=${enc(id)}`),
  ensurePage: (name) => request('POST', `/api/page/ensure?name=${enc(name)}`),
  renamePage: (name, to) => request('POST', `/api/page/rename?name=${enc(name)}&to=${enc(to)}`),
  setFavorite: (name, on) => request('POST', `/api/page/favorite?name=${enc(name)}&on=${on}`),
  pages: () => getJson('/api/pages'),
  // Calendar dots, favourites and the last change: cheap, fetched after saves.
  sidebar: () => getJson('/api/sidebar'),
  names: () => getJson('/api/names'),
  journals: (before, limit = 10) =>
    getJson(`/api/journals?limit=${limit}${before ? `&before=${before}` : ''}`),
  search: (q, limit = 20) => getJson(`/api/search?q=${enc(q)}&limit=${limit}`),
  block: async (id) => {
    const r = await request('GET', `/api/block?id=${enc(id)}`);
    return r.ok ? r.data : null;
  },
  // `expected`: the text this view last saw; the server refuses (409) if it changed.
  putBlock: (id, content, expected) => request('PUT', `/api/block?id=${enc(id)}`, { content, expected }),
  tasks: () => getJson('/api/tasks'),
  encryptionPending: () => getJson('/api/encryption/pending'),
  sealedPages: () => getJson('/api/encryption/sealed'),
  importedKey: () => getJson('/api/encryption/imported'),
  importedKeyDone: () => request('DELETE', '/api/encryption/imported'),
  assets: () => getJson('/api/assets'),
  deleteAsset: (name) => request('DELETE', `/api/assets?name=${enc(name)}`),
  workbooks: () => getJson('/api/workbooks', { global: true }),
  createWorkbook: (name) => request('POST', `/api/workbooks?name=${enc(name)}`, undefined, { global: true }),
  deleteWorkbook: (id) => request('DELETE', `/api/workbooks?id=${enc(id)}`, undefined, { global: true }),
  renameWorkbook: (id, to) => request('POST', `/api/workbooks/rename?id=${enc(id)}&to=${enc(to)}`, undefined, { global: true }),
  config: () => getJson('/api/config', { global: true }),
  saveConfig: (cfg) => request('PUT', '/api/config', cfg, { global: true }),
};

// Cached page names (including linked-but-empty pages) for [[ autocomplete.
let pageNames = [];
let pageNamesAt = 0;
export async function getPageNames(force = false) {
  if (force || Date.now() - pageNamesAt > 10000) {
    try {
      pageNames = await api.names();
      pageNamesAt = Date.now();
    } catch { /* keep the old list when offline */ }
  }
  return pageNames;
}
export function invalidatePageNames() { pageNamesAt = 0; }
