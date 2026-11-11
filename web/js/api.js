// Thin wrapper around the server's JSON API.

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

async function getJson(url) {
  const r = await request('GET', url);
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
  pages: () => getJson('/api/pages'),
  names: () => getJson('/api/names'),
  journals: (before, limit = 10) =>
    getJson(`/api/journals?limit=${limit}${before ? `&before=${before}` : ''}`),
  search: (q, limit = 20) => getJson(`/api/search?q=${enc(q)}&limit=${limit}`),
  block: async (id) => {
    const r = await request('GET', `/api/block?id=${enc(id)}`);
    return r.ok ? r.data : null;
  },
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
