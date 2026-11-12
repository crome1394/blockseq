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
  return { ok: res.ok, status: res.status, data };
}

async function getJson(url, opts) {
  const r = await request('GET', url, undefined, opts);
  if (!r.ok) throw new Error(r.data?.error || `HTTP ${r.status}`);
  return r.data;
}

export const api = {
  page: (name) => getJson(`/api/page?name=${enc(name)}`),
  // Resolves to {ok, status, data}; status 409 means the page changed elsewhere.
  savePage: (name, baseVersion, blocks, opts) =>
    request('PUT', `/api/page?name=${enc(name)}`, { base_version: baseVersion, blocks }, opts),
  deletePage: (name) => request('DELETE', `/api/page?name=${enc(name)}`),
  ensurePage: (name) => request('POST', `/api/page/ensure?name=${enc(name)}`),
  renamePage: (name, to) => request('POST', `/api/page/rename?name=${enc(name)}&to=${enc(to)}`),
  setFavorite: (name, on) => request('POST', `/api/page/favorite?name=${enc(name)}&on=${on}`),
  pages: () => getJson('/api/pages'),
  names: () => getJson('/api/names'),
  journals: (before, limit = 10) =>
    getJson(`/api/journals?limit=${limit}${before ? `&before=${before}` : ''}`),
  search: (q, limit = 20) => getJson(`/api/search?q=${enc(q)}&limit=${limit}`),
  block: async (id) => {
    const r = await request('GET', `/api/block?id=${enc(id)}`);
    return r.ok ? r.data : null;
  },
  putBlock: (id, content) => request('PUT', `/api/block?id=${enc(id)}`, { content }),
  tasks: () => getJson('/api/tasks'),
  encryptionPending: () => getJson('/api/encryption/pending'),
  sealedPages: () => getJson('/api/encryption/sealed'),
  importedKey: () => getJson('/api/encryption/imported'),
  importedKeyDone: () => request('DELETE', '/api/encryption/imported'),
  assets: () => getJson('/api/assets'),
  deleteAsset: (name) => request('DELETE', `/api/assets?name=${enc(name)}`),
  workbooks: () => getJson('/api/workbooks', { global: true }),
  createWorkbook: (name) => request('POST', `/api/workbooks?name=${enc(name)}`, undefined, { global: true }),
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
