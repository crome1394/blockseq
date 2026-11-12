// Block references ((uuid)) and embeds: fetching, caching and filling in
// the referenced text wherever a block is rendered.

import { api } from './api.js';
import { decorateCode } from './code.js';
import { pageLink, renderContent, renderOutline } from './render.js';
import { editors } from './sync.js';
import { stripStatus } from './tasks.js';

// ---- block references ((uuid)) ---------------------------------------------

const refCache = new Map();

function findLocalBlock(id) {
  for (const ed of editors) {
    const n = ed.findNode(id);
    if (n) return { id, content: n.content, page_name: ed.name };
  }
  return null;
}

// Fills in {{embed}} boxes: a page's blocks or one block, read-only. Two
// levels of embeds inside embeds are shown; deeper ones only link, so a page
// that embeds itself can't loop.
function hydrateEmbeds(container) {
  container.querySelectorAll('.embed-box:not([data-loaded])').forEach(async (box) => {
    box.dataset.loaded = '1';
    const body = box.querySelector('.embed-body');
    let depth = 0;
    for (let n = box.parentElement; n; n = n.parentElement) if (n.classList?.contains('embed-body')) depth++;
    if (depth >= 2) {
      body.textContent = 'Embedded again inside an embed: open it to see it.';
      return;
    }
    try {
      if (box.dataset.embedPage) {
        const data = await api.page(box.dataset.embedPage);
        body.classList.remove('muted');
        if (data.blocks?.length) body.innerHTML = renderOutline(data.blocks);
        else body.innerHTML = '<span class="muted">This page is empty.</span>';
      } else {
        const b = await api.block(box.dataset.embedBlock);
        if (!b) { body.textContent = 'That block no longer exists.'; return; }
        body.classList.remove('muted');
        body.innerHTML = renderContent(b.content);
        const head = box.querySelector('.embed-head');
        head.classList.remove('muted', 'small');
        head.innerHTML = `<span class="muted small">Embedded block from </span>${pageLink(b.page_name)}`;
      }
      decorateCode(body);
      hydrateRefs(body);
    } catch {
      body.textContent = 'Could not load it.';
    }
  });
}

export function hydrateRefs(container) {
  hydrateEmbeds(container);
  container.querySelectorAll('.block-ref[data-ref]:not([data-page])').forEach(async (span) => {
    const id = span.dataset.ref;
    let b = findLocalBlock(id);
    if (!b) {
      if (!refCache.has(id)) refCache.set(id, api.block(id).catch(() => null));
      b = await refCache.get(id);
      if (!b) refCache.delete(id);
    }
    if (!b) { span.classList.add('missing'); return; }
    span.dataset.page = b.page_name;
    span.title = b.page_name;
    const text = stripStatus(b.content).split('\n')[0];
    // One level only, so refs to refs can't loop.
    span.innerHTML = renderContent(text, { inlineTags: true }).replace(/class="block-ref"/g, 'class="block-ref nested"');
  });
}

export function clearRefCache() { refCache.clear(); }
