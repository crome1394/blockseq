// Local drafts: this browser's copy of edits the server may not have yet,
// and the limit on what a keepalive request can carry. Used by sync.js
// (saving) and editor.js (offering a copy when a page opens).
//
// Every save attempt first keeps a copy of what is being sent in this
// browser's storage, and removes it once the server has it. If the tab dies
// while the server is unreachable (crash, killed tab, flat battery), the page
// offers that copy the next time it opens, whenever it differs from the server.
// Copies are taken after #Encrypted blocks are sealed, so they hold only
// ciphertext, like the server. A keepalive save on close is sent only when the
// body fits in 64 KB; a larger page stays in this copy.
//
// Each tab keeps its own copy, so two tabs of one page cannot overwrite or
// delete each other's: `<prefix><workbook>:<page>\n<tab id>`. Page names
// cannot contain a newline. A key with no tab id comes from an older version.

import { clientId } from './api.js';
import { toast } from './ui.js';
import { workbook } from './workbook.js';

const DRAFT_PREFIX = 'blockseq.draft:';
const DRAFT_MAX_AGE = 30 * 24 * 3600 * 1000;
const draftBase = (name) => `${DRAFT_PREFIX}${workbook()}:${name.toLowerCase()}`;
const draftKey = (name) => `${draftBase(name)}\n${clientId}`;

// Every tab holds a Web Lock named after its id until it closes or crashes.
// Another tab can then tell a copy whose tab is still open (and probably
// still sending it) from one that was left behind. Web Locks need https or
// localhost; without them every other tab's copy counts as left behind.
const TAB_LOCK = 'blockseq.tab:';
try { navigator.locks?.request(TAB_LOCK + clientId, () => new Promise(() => {})); } catch { /* unsupported */ }
export async function openTabs() {
  try {
    const { held = [] } = await navigator.locks.query();
    return new Set(held.map((l) => l.name || '').filter((n) => n.startsWith(TAB_LOCK)).map((n) => n.slice(TAB_LOCK.length)));
  } catch { return new Set(); }
}

// Warned once until a copy can be stored again.
let draftWarned = false;
export function saveDraft(name, baseVersion, blocks) {
  try {
    localStorage.setItem(draftKey(name), JSON.stringify({ name, baseVersion, blocks, at: Date.now() }));
    draftWarned = false;
  } catch {
    // Storage full or blocked. The server save still runs, but nothing would
    // survive the tab closing before it arrives, so say so.
    if (!draftWarned) {
      draftWarned = true;
      toast('This browser could not keep a local copy of your edits (its storage is full or blocked). They are still sent to the server, but would be lost if this tab closed before they arrive.', 10000);
    }
  }
}

// Every copy of this page, from any tab, newest first.
export function readDrafts(name) {
  const base = draftBase(name);
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== base && !key?.startsWith(`${base}\n`)) continue;
      try {
        const d = JSON.parse(localStorage.getItem(key) || 'null');
        if (d && Array.isArray(d.blocks)) out.push({ ...d, key, owner: key.split('\n')[1] || '' });
      } catch { /* damaged copy: skipped */ }
    }
  } catch { /* storage blocked */ }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

export function removeDraft(key) {
  try { localStorage.removeItem(key); } catch { /* blocked */ }
}

// This tab's copy of the page.
export function dropDraft(name) {
  removeDraft(draftKey(name));
}

// Old drafts (the page was never opened again) are dropped after a month.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k?.startsWith(DRAFT_PREFIX)) continue;
    const at = JSON.parse(localStorage.getItem(k) || '{}').at || 0;
    if (Date.now() - at > DRAFT_MAX_AGE) localStorage.removeItem(k);
  }
} catch { /* storage blocked */ }

export const sameBlocks = (a, b) => JSON.stringify(a.map((x) => [x.id, x.parent_id, x.content, !!x.collapsed]))
  === JSON.stringify(b.map((x) => [x.id, x.parent_id, x.content, !!x.collapsed]));
// Browsers discard a keepalive request whose body is larger than this.
const KEEPALIVE_LIMIT = 64 * 1024;
export function keepaliveFits(baseVersion, blocks, extra) {
  const json = JSON.stringify({ base_version: baseVersion, blocks, ...extra });
  return new TextEncoder().encode(json).length <= KEEPALIVE_LIMIT;
}
