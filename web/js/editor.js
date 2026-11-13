// The block outliner. One PageEditor edits one page; the journals view shows
// several at once. Each keeps the page as a tree of nodes, re-renders after
// structural changes, and autosaves the whole page with optimistic
// versioning (the server answers 409 if another device saved first).

import { el } from './dom.js';
import { uuid } from './api.js';
import {
  renderContent, parseOutline, splitProps, joinProps, findFences, isPureCode, isVideoUrl, mathSpans, tweetId } from './render.js';
import {
  imageFiles, uploadImage, openLightbox } from './images.js';
import { statusOf, statusPrefix, withStatus, nextStatus, hasTaskTag } from './tasks.js';
import { matches } from './keys.js';
import { openPdfPane, openFilePane } from './pdfview.js';
import { isUnlocked } from './crypto.js';

import { openMathBuilder } from './mathbuilder.js';
import { journalName } from './dates.js';
import { toast, copyText, openModal } from './ui.js';
import { decorateCode, highlightForEditor } from './code.js';
import { getSetting } from './settings.js';
import { readDrafts, removeDraft, sameBlocks } from './drafts.js';
import { editors, installSync } from './sync.js';
import { closeAutocomplete, handleAutocompleteKey, updateAutocomplete } from './autocomplete.js';
import { bar, hideBar, positionBar } from './formatbar.js';
import { closeMenu, showStatusPicker } from './menus.js';
import { hydrateRefs } from './refs.js';
import { installBlockMenus } from './blockmenus.js';
import { installCodeBlocks } from './codeblocks.js';
import { installSecrets } from './secrets.js';
import { installFormatBar } from './formatbar.js';

export { editors };

const pad2 = (n) => String(n).padStart(2, '0');
export const timeNow = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
export const timestamp = () => `[[${journalName(new Date())}]] ${timeNow()}`;

// Wraps LaTeX from the builder in delimiters, keeping the style an edited
// formula already used (\[ \] or $$ $$).
function mathSource(tex, display, old) {
  if (display) {
    const multi = tex.includes('\n');
    if (old?.delim === 'tex') return multi ? `\\[\n${tex}\n\\]` : `\\[${tex}\\]`;
    return multi ? `$$\n${tex}\n$$` : `$$${tex}$$`;
  }
  const one = tex.replace(/\s*\n\s*/g, ' ');
  return old?.delim === 'tex' ? `\\(${one}\\)` : `$${one}$`;
}

const HISTORY_LIMIT = 200;
// A #quote tag on a block shows it and its children as a quotation.
const QUOTE_TAG = /(^|\s)#quote(?=\s|$)/i;
export const NUMBERED = 'logseq.order-list-type';
export const COLOR = 'background-color';
export const HEADING = 'heading';
export const ALIGN = 'text-align';
export const COLORS = ['yellow', 'red', 'pink', 'green', 'blue', 'purple', 'gray'];

// The editor the user touched last; keyboard undo outside a block goes here.
let lastEditor = null;
// The editor used last (moved methods set it through this).
export function noteActive(ed) { lastEditor = ed; }
// The editor that has blocks selected (only one at a time).
let selectedEditor = null;
// Text we last put on the clipboard from selected blocks.
let lastCopy = '';

const isField = (t) => !!t?.closest?.('input, textarea, select, [contenteditable]');

// Toggles **bold** or _italic_ around one line's text, leaving a status word,
// heading marker and trailing #tags outside the marks.
const TRAILING_TAG_RUN = /(?:\s+(?:#\[\[[^\]\n]+\]\]|#[^\s#,.!?;:()[\]"'`+][^\s#,.!?;:()[\]"'`]*))+\s*$/;
const MARKS = ['**', '~~', '_'];

function toggleMark(core, mark) {
  const m = mark.length;
  if (core.length >= 2 * m && core.startsWith(mark) && core.endsWith(mark)) return core.slice(m, -m);
  for (const other of MARKS) {
    const o = other.length;
    if (other !== mark && core.length >= 2 * o && core.startsWith(other) && core.endsWith(other)) {
      return other + toggleMark(core.slice(o, -o), mark) + other;
    }
  }
  return core ? mark + core + mark : core;
}

function toggleLine(line, mark, isFirst) {
  if (/^\s*(```|#\+|\|)/.test(line) || /^[\w.-]+:: /.test(line)) return line;
  let pre = isFirst ? statusPrefix(line) : '';
  let rest = line.slice(pre.length);
  const h = /^(\s*(?:#{1,6} |> )?)/.exec(rest)[1];
  pre += h;
  rest = rest.slice(h.length);
  let tail = '';
  const t = TRAILING_TAG_RUN.exec(rest);
  if (t && t.index > 0) { tail = rest.slice(t.index); rest = rest.slice(0, t.index); }
  const ws = /\s*$/.exec(rest)[0];
  if (ws) { tail = ws + tail; rest = rest.slice(0, rest.length - ws.length); }
  return pre + toggleMark(rest, mark) + tail;
}

// A block's text with its first line marked (or unmarked); the rest is kept.
export function toggleFirstLine(content, mark) {
  const nl = content.indexOf('\n');
  return nl === -1 ? toggleLine(content, mark, true) : toggleLine(content.slice(0, nl), mark, true) + content.slice(nl);
}

// ---- block selection: page-wide events ----------------------------------------

function editorAt(target) {
  for (const ed of editors) if (!ed.disposed && ed.container.contains(target)) return ed;
  return null;
}

function nodeAt(ed, target) {
  const block = target?.closest?.('.block');
  return block && ed.container.contains(block) ? ed.findNode(block.dataset.id) : null;
}

document.addEventListener('keydown', (e) => {
  if (!e.key || !selectedEditor || e.defaultPrevented || isField(e.target) || document.querySelector('.modal-overlay, .menu')) return;
  if (selectedEditor.disposed || !selectedEditor.sel) { selectedEditor = null; return; }
  selectedEditor.onSelectionKey(e);
});

document.addEventListener('copy', (e) => {
  if (!selectedEditor?.sel || isField(e.target)) return;
  const n = selectedEditor.selectedRoots().length;
  lastCopy = selectedEditor.selectionMarkdown();
  e.clipboardData.setData('text/plain', lastCopy);
  e.preventDefault();
  toast(`Copied ${n} block${n === 1 ? '' : 's'}`);
});

document.addEventListener('cut', (e) => {
  if (!selectedEditor?.sel || isField(e.target)) return;
  // Ids are kept, so ((references)) still work after pasting it elsewhere.
  lastCopy = selectedEditor.selectionMarkdown({ ids: true });
  e.clipboardData.setData('text/plain', lastCopy);
  e.preventDefault();
  selectedEditor.deleteSelection();
  toast('Cut. Paste it anywhere to move it.');
});

document.addEventListener('paste', (e) => {
  const ed = selectedEditor;
  if (!ed?.sel || isField(e.target)) return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  const roots = parseOutline(text, uuid) || [makeNode(text.replace(/\r\n/g, '\n'))];
  const sel = ed.selectedRoots();
  const anchor = sel[sel.length - 1];
  if (!anchor) return;
  ed.beginOp();
  const first = roots[0];
  ed.insertOutline(anchor, roots);
  ed.refresh();
  const last = ed.findNode(roots[roots.length - 1].id);
  if (first && last) ed.selectBlocks(ed.findNode(first.id), last);
});

// Dragging from one block into another selects whole blocks.
let drag = null;
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const ed = editorAt(e.target);
  const node = ed && !e.target.closest('.bullet, .toggle, button, a, .code-editor') && nodeAt(ed, e.target);
  drag = node ? { ed, node, active: false } : null;
  // Clicking anywhere else clears a block selection.
  if (selectedEditor?.sel && !e.target.closest('.menu, .popup, .modal-overlay') && !(e.shiftKey && node)) {
    if (!node || selectedEditor !== ed) selectedEditor.clearSelection();
  }
});
document.addEventListener('mousemove', (e) => {
  if (!drag || !(e.buttons & 1)) return;
  const over = nodeAt(drag.ed, document.elementFromPoint(e.clientX, e.clientY));
  if (!over || (over === drag.node && !drag.active)) return;
  drag.active = true;
  e.preventDefault();
  window.getSelection()?.removeAllRanges();
  const cur = drag.ed.sel;
  if (!cur || cur.anchor !== drag.node || cur.focus !== over) drag.ed.selectBlocks(drag.node, over);
});
document.addEventListener('mouseup', () => {
  // A finished drag must not turn into a click that starts editing.
  if (drag?.active) {
    const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', stop, { capture: true }), 0);
  }
  drag = null;
});
export function activeEditor() {
  return lastEditor && editors.has(lastEditor) && !lastEditor.disposed ? lastEditor : null;
}

export function makeNode(content = '', id = uuid(), props = {}) {
  return { id, content, props, collapsed: false, children: [], parent: null };
}

function buildTree(blocks) {
  const root = makeNode('', null);
  const byId = new Map([[null, root]]);
  for (const b of blocks) {
    const { content, props } = splitProps(b.content);
    const node = makeNode(content, b.id, props);
    node.collapsed = !!b.collapsed;
    const parent = byId.get(b.parent_id ?? null) || root;
    node.parent = parent;
    parent.children.push(node);
    byId.set(b.id, node);
  }
  return root;
}

// True if the caret sits inside a ``` code fence (including its first line).
// True when pos is inside a #+BEGIN_… / #+END_… admonition.
function inAdmonition(text, pos) {
  const before = text.slice(0, pos);
  const begin = before.lastIndexOf('#+BEGIN_');
  if (begin === -1 || (begin > 0 && before[begin - 1] !== '\n')) return false;
  return !/\n#\+END_/i.test(before.slice(begin)) && /\n#\+END_/i.test(text.slice(pos - 1));
}

export function inFence(text, pos) {
  return ((text.slice(0, pos).match(/^```/gm) || []).length) % 2 === 1;
}

export function lineAt(text, pos) {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const endIdx = text.indexOf('\n', pos);
  const end = endIdx === -1 ? text.length : endIdx;
  return { start, end, line: text.slice(start, end) };
}

export class PageEditor {
  constructor(container, data, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.editing = null; // node being edited
    this.ta = null;
    this.dirty = false;
    this.saving = false;
    this.offline = false;
    this.conflict = null;
    this.changeSeq = 0;
    this.saveTimer = null;
    this.pendingReload = false;
    this.disposed = false;
    editors.add(this);
    // With "always show threading" the lines depend on layout (images
    // loading, blocks collapsing), so redraw them when the outline resizes.
    if (typeof ResizeObserver === 'function') {
      this.resizeObs = new ResizeObserver(() => {
        if (!getSetting('threadAlways')) return;
        cancelAnimationFrame(this.threadFrame);
        this.threadFrame = requestAnimationFrame(() => this.updateThread());
      });
      this.resizeObs.observe(container);
    }
    this.load(data);
  }

  load(data) {
    this.name = data.name;
    this.version = data.page ? data.page.version : 0;
    this.root = buildTree(data.blocks || []);
    if (!this.root.children.length) this.insertChild(this.root, makeNode(), 0);
    this.undoStack = [];
    this.redoStack = [];
    this.burst = false;
    this.draft = null;
    this.draftToken = null; // an offer still waiting from an earlier load is void
    const serverBlocks = data.blocks || [];
    const pending = [];
    for (const d of readDrafts(this.name)) {
      // A copy the server already has is done with, whichever tab kept it.
      if (sameBlocks(d.blocks, serverBlocks)) removeDraft(d.key);
      else pending.push(d);
    }
    this.render();
    this.openSecrets();
    if (pending.length) this.offerDraft(pending);
  }

  // Replaces the whole outline (a restored draft or an older version).
  setBlocks(blocks) {
    this.root = buildTree(blocks);
    if (!this.root.children.length) this.insertChild(this.root, makeNode(), 0);
  }

  // ---- #Encrypted blocks -----------------------------------------------------
  //
  // A block tagged #Encrypted keeps its own text readable; its children are
  // stored as one encrypted outline in its hidden `encrypted::` property.
  // `node.unsealed` means the children are decrypted in memory right now.

  get lower() { return this.name.toLowerCase(); }

  // ---- tree helpers ------------------------------------------------------

  insertChild(parent, node, index) {
    node.parent = parent;
    parent.children.splice(index, 0, node);
  }

  insertAfter(ref, node) {
    this.insertChild(ref.parent, node, ref.parent.children.indexOf(ref) + 1);
  }

  detach(node) {
    const sibs = node.parent.children;
    sibs.splice(sibs.indexOf(node), 1);
  }

  visible() {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { out.push(c); if (!c.collapsed) walk(c); });
    walk(this.root);
    return out;
  }

  findNode(id) {
    let found = null;
    const walk = (n) => n.children.forEach((c) => { if (c.id === id) found = c; else if (!found) walk(c); });
    walk(this.root);
    return found;
  }

  // opts.forSave: leave out the children of unlocked #Encrypted blocks
  // (they travel inside the block's encrypted property instead).
  flatten(opts = {}) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => {
      const sealed = opts.forSave && c.props.encrypted && c.unsealed;
      out.push({
        id: c.id,
        parent_id: n === this.root ? null : n.id,
        content: joinProps(c.content, c.props),
        collapsed: !sealed && c.collapsed && c.children.length > 0,
      });
      if (!sealed) walk(c);
    });
    walk(this.root);
    return out;
  }

  // ---- undo / redo ---------------------------------------------------------
  // History holds whole-page snapshots. Structural edits take one before they
  // change anything; typing takes one at the start of each burst of keystrokes.

  snapshot() {
    let focus = null;
    if (this.editing) focus = { id: this.editing.id, caret: this.ta?.selectionStart ?? 0 };
    else if (this.codeEdit) focus = { id: this.codeEdit.node.id, code: this.codeEdit.idx, caret: this.codeEdit.ce.ta.selectionStart };
    return { blocks: this.flatten(), focus };
  }

  checkpoint() {
    const snap = this.snapshot();
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && JSON.stringify(top.blocks) === JSON.stringify(snap.blocks)) return;
    this.undoStack.push(snap);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  // Call at the start of every structural edit.
  beginOp() {
    lastEditor = this;
    this.burst = false;
    this.checkpoint();
  }

  undo() { this.travel(this.undoStack, this.redoStack, 'Nothing to undo'); }
  redo() { this.travel(this.redoStack, this.undoStack, 'Nothing to redo'); }

  travel(from, to, emptyMsg) {
    this.burst = false;
    const snap = from.pop();
    if (!snap) return toast(emptyMsg);
    to.push(this.snapshot());
    closeAutocomplete();
    this.root = buildTree(snap.blocks);
    if (!this.root.children.length) this.insertChild(this.root, makeNode(), 0);
    // Restored encrypted blocks that came back with their children are open.
    for (const r of this.secretRoots()) if (r.props.encrypted && r.children.length && isUnlocked()) r.unsealed = true;
    this.markDirty();
    this.render();
    const n = snap.focus && this.findNode(snap.focus.id);
    if (n && snap.focus.code !== undefined) this.openCodeEditor(n, snap.focus.code, snap.focus.caret);
    else if (n) this.edit(n, snap.focus.caret);
  }

  // ---- rendering ---------------------------------------------------------

  render() {
    this.rendering = true;
    if (selectedEditor === this) selectedEditor = null;
    this.sel = null;
    this.editing = null;
    this.ta = null;
    this.mirror = null;
    this.codeEdit?.ce.close();
    this.codeEdit = null;
    const frag = document.createDocumentFragment();
    if (this.conflict) frag.append(this.renderConflict());
    else if (this.draft) frag.append(this.renderDraft());
    this.appendNodes(frag, this.root.children);
    const tail = el('div', 'add-block');
    tail.title = 'Click to add a block';
    tail.addEventListener('click', () => this.appendBlock());
    frag.append(tail);
    this.container.replaceChildren(frag);
    this.container.classList.add('outline');
    this.rendering = false;
  }

  // Renders sibling nodes; runs of numbered blocks count 1, 2, 3...
  appendNodes(parentEl, nodes) {
    let n = 0;
    for (const c of nodes) {
      n = c.props[NUMBERED] === 'number' ? n + 1 : 0;
      parentEl.append(this.renderNode(c, n));
    }
  }

  renderNode(node, number = 0) {
    const wrap = el('div', 'block');
    wrap.dataset.id = node.id;
    const row = el('div', 'block-row');
    const toggle = el('span', 'toggle');
    if (node.children.length) {
      toggle.classList.add('has');
      toggle.textContent = node.collapsed ? '▸' : '▾';
      toggle.addEventListener('mousedown', (e) => e.preventDefault());
      toggle.addEventListener('click', () => this.toggleCollapse(node));
    }
    const bullet = el('span', 'bullet' + (node.collapsed && node.children.length ? ' collapsed' : ''));
    if (number) {
      bullet.classList.add('numbered');
      bullet.textContent = `${number}.`;
    } else {
      bullet.append(el('span', 'dot'));
    }
    bullet.addEventListener('mousedown', (e) => e.preventDefault());
    bullet.addEventListener('click', (e) => this.showBlockMenu(node, e));
    bullet.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showBlockMenu(node, e); });
    const content = el('div', 'content');
    this.styleContent(node, content);
    content.innerHTML = renderContent(node.content);
    decorateCode(content);
    content.addEventListener('click', (e) => this.onContentClick(node, e));
    content.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    content.addEventListener('drop', (e) => {
      const files = imageFiles(e.dataTransfer);
      if (!files.length || this.editing === node) return;
      e.preventDefault();
      this.insertImages(node, files, node.content.length);
    });
    row.append(toggle, bullet, content);
    wrap.append(row);
    if (QUOTE_TAG.test(node.content)) wrap.classList.add('quote-block');
    node.el = wrap;
    node.contentEl = content;
    if (node.children.length && !node.collapsed) {
      const kids = el('div', 'children');
      this.appendNodes(kids, node.children);
      wrap.append(kids);
    }
    this.decorateSecret(node);
    hydrateRefs(content);
    return wrap;
  }

  rerenderContent(node) {
    if (!node.contentEl) return;
    node.el?.classList.toggle('quote-block', QUOTE_TAG.test(node.content));
    this.decorateSecret(node);
    this.styleContent(node, node.contentEl);
    node.contentEl.innerHTML = renderContent(node.content);
    decorateCode(node.contentEl);
    hydrateRefs(node.contentEl);
  }

  // Block colour and "auto heading" (size by depth) live on the content box.
  styleContent(node, content) {
    const color = node.props[COLOR];
    if (color) content.dataset.color = color; else delete content.dataset.color;
    const align = node.props[ALIGN];
    if (align === 'center' || align === 'right') content.dataset.align = align; else delete content.dataset.align;
    content.className = content.className.replace(/\bah\d\b/g, '').trim();
    if (node.props[HEADING] === 'true') {
      let depth = 0;
      for (let n = node.parent; n && n !== this.root; n = n.parent) depth++;
      content.classList.add(`ah${Math.min(depth + 1, 6)}`);
    }
  }

  // ---- editing -----------------------------------------------------------

  onContentClick(node, e) {
    const t = e.target;
    if (e.shiftKey && !t.closest('a, button')) {
      const anchor = this.sel?.anchor || this.lastEdited;
      if (anchor && this.findNode(anchor.id)) {
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        this.selectBlocks(anchor, node);
        return;
      }
    }
    if (this.sel) this.clearSelection();
    if (t.closest('.code-editor')) return; // the code editor handles its own clicks
    // Clicking a formula opens it in the maths builder.
    const math = t.closest('math.math');
    if (math && this.editing !== node && !math.closest('.block-ref')) {
      const own = [...e.currentTarget.querySelectorAll('math.math')].filter((x) => !x.closest('.block-ref'));
      const spans = mathSpans(node.content);
      if (spans.length === own.length) {
        e.preventDefault();
        this.openMath(node, spans[own.indexOf(math)]);
        return;
      }
    }
    if (t.closest('a') || t.closest('.code-copy')) return; // links navigate (hash router / new tab)
    const pre = t.closest('pre.code');
    if (pre && this.editing !== node) {
      this.openCodeEditor(node, Number(pre.dataset.fence), this.caretFromClick(node, pre, e));
      return;
    }
    const imgMenu = t.closest('.img-menu');
    if (imgMenu) {
      e.stopPropagation();
      this.showImageMenu(node, Number(imgMenu.closest('.img-wrap').dataset.index), e);
      return;
    }
    const img = t.closest('.img-box img');
    if (img) {
      // Images on the same row can be stepped through with ‹ ›.
      const row = img.closest('.media-row');
      const imgs = row ? [...row.querySelectorAll('.img-box img')] : [img];
      openLightbox(imgs.map((i) => ({ src: i.src, alt: i.alt })), imgs.indexOf(img));
      return;
    }
    const badge = t.closest('.status-badge');
    if (badge) {
      e.preventDefault();
      e.stopPropagation();
      showStatusPicker(e.clientX, e.clientY, statusOf(node.content)?.word, (word) => {
        this.beginOp();
        this.setMarker(node, word);
      });
      return;
    }
    if (t.closest('video, audio')) return; // using the player, not editing
    if (t.closest('.inline-copy')) return; // copied by the page-wide handler in app.js
    const file = t.closest('.file-wrap, .media-wrap');
    if (file) {
      e.stopPropagation();
      const name = file.querySelector('.file-name')?.textContent || file.title || 'File';
      if (t.closest('.file-menu')) this.showFileMenu(node, file, name, e);
      else if (t.closest('.file-open')) openFilePane(file.dataset.src, name, file.dataset.kind);
      return;
    }
    const pdf = t.closest('.pdf-wrap');
    if (pdf) {
      e.stopPropagation();
      const index = Number(pdf.dataset.index);
      if (t.closest('.pdf-menu')) this.showPdfMenu(node, index, e);
      else if (t.closest('.pdf-open')) openPdfPane(pdf.dataset.src, pdf.querySelector('.pdf-open span')?.textContent || 'PDF');
      return;
    }
    const ref = t.closest('.block-ref');
    if (ref && ref.dataset.page) {
      location.hash = `#/page/${encodeURIComponent(ref.dataset.page)}?b=${ref.dataset.ref}`;
      return;
    }
    if (this.editing !== node) this.edit(node, 'end');
  }

  edit(node, caret = 'end', opts = {}) {
    this.closeCodeEditor();
    const raw = opts.raw || this.rawId === node.id;
    if (!raw && isPureCode(node.content)) {
      if (this.editing) this.stopEdit();
      const f = findFences(node.content)[0];
      const c = caret === 'end' ? f.code.length : caret === 'start' ? 0 : caret - f.codeStart;
      return this.openCodeEditor(node, 0, Math.max(0, Math.min(c, f.code.length)));
    }
    this.rawId = raw ? node.id : null;
    if (this.editing && this.editing !== node) this.stopEdit();
    if (!node.contentEl) return;
    lastEditor = this;
    this.burst = false;
    this.editing = node;
    const ta = el('textarea', 'editor');
    ta.value = node.content;
    ta.rows = 1;
    ta.spellcheck = true;
    this.mirror = null;
    const isCode = /^```/m.test(node.content);
    if (isCode) {
      ta.classList.add('code-edit');
      ta.spellcheck = false;
    }
    if (isCode && getSetting('liveCode')) {
      // Live mode: transparent text over a highlighted copy of itself.
      const wrap = el('div', 'live-wrap');
      this.mirror = el('pre', 'live-mirror');
      this.mirror.setAttribute('aria-hidden', 'true');
      this.mirror.innerHTML = highlightForEditor(ta.value);
      ta.classList.add('live');
      wrap.append(this.mirror, ta);
      node.contentEl.replaceChildren(wrap);
    } else {
      node.contentEl.replaceChildren(ta);
    }
    node.el.classList.add('editing');
    this.ta = ta;
    autosize(ta);
    this.updateThread();
    ta.focus({ preventScroll: false });
    const pos = caret === 'end' ? ta.value.length : caret === 'start' ? 0 : Math.min(caret, ta.value.length);
    ta.setSelectionRange(pos, pos);
    this.showBar(node);
    ta.addEventListener('input', (e) => this.onInput(node, ta, e));
    ta.addEventListener('keydown', (e) => this.onKey(node, ta, e));
    ta.addEventListener('paste', (e) => this.onPaste(node, ta, e));
    ta.addEventListener('drop', (e) => {
      const files = imageFiles(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      this.insertImages(node, files);
    });
    ta.addEventListener('blur', () => {
      if (this.rendering || this.editing !== node) return;
      // Clicking the autocomplete list must not end editing.
      setTimeout(() => {
        if (this.editing === node && this.ta === ta && document.activeElement !== ta) this.stopEdit();
      }, 0);
    });
  }

  stopEdit() {
    const node = this.editing;
    if (!node) return;
    this.lastEdited = node;
    this.editing = null;
    this.ta = null;
    this.mirror = null;
    this.rawId = null;
    this.burst = false;
    closeAutocomplete();
    if (bar?.editor === this) hideBar();
    node.el?.classList.remove('editing');
    this.rerenderContent(node);
    this.updateThread();
    if (this.pendingReload && !this.dirty) this.reload();
  }

  setContent(node, value) {
    if (this.mirror && this.editing === node) this.mirror.innerHTML = highlightForEditor(value);
    if (node.content === value) return;
    node.content = value;
    this.markDirty();
  }

  // Replaces ta[start, end) with text, selects [selStart, selEnd) relative to
  // the inserted text, and saves it to the node.
  replaceText(node, ta, start, end, text, selStart = text.length, selEnd = selStart) {
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.setSelectionRange(start + selStart, start + selEnd);
    this.setContent(node, ta.value);
    autosize(ta);
  }

  onInput(node, ta, e) {
    if (bar?.node === node) positionBar(); // the block may have grown
    // Snapshot once at the start of a burst of typing.
    if (!this.burst) {
      this.checkpoint();
      this.burst = true;
    }
    clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => { this.burst = false; }, 1000);

    // Auto-close [[ and (( like Logseq.
    const pos = ta.selectionStart;
    if (e.inputType === 'insertText' && (e.data === '[' || e.data === '(')) {
      const pair = e.data === '[' ? ['[[', ']]'] : ['((', '))'];
      if (ta.value.slice(pos - 2, pos) === pair[0] && !ta.value.slice(pos).startsWith(pair[1])) {
        ta.value = ta.value.slice(0, pos) + pair[1] + ta.value.slice(pos);
        ta.setSelectionRange(pos, pos);
      }
    }
    this.setContent(node, ta.value);
    autosize(ta);
    updateAutocomplete(this, node, ta);
  }

  onKey(node, ta, e) {
    if (handleAutocompleteKey(e)) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const v = ta.value;
    const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (e.isComposing) return;

    if (mod && !e.altKey && (k === 'z' || k === 'Z' || k === 'y')) {
      e.preventDefault();
      if (k === 'y' || e.shiftKey) this.redo(); else this.undo();
      return;
    }

    if (k === 'Enter' && plain) {
      if (inAdmonition(v, start)) return; // a plain newline inside #+BEGIN_…
      if (inFence(v, start)) {
        if (this.expandFence(node, ta)) e.preventDefault();
        return; // otherwise a plain newline inside code
      }
      const { start: ls, end: le, line } = lineAt(v, start);
      if (/^\s*\|/.test(line)) {
        e.preventDefault();
        this.tableEnter(node, ta, ls, le, line);
        return;
      }
      e.preventDefault();
      this.split(node, start, end);
    } else if (matches(e, 'cycleStatus')) {
      e.preventDefault();
      this.beginOp();
      this.setMarker(node, nextStatus(statusOf(node.content)?.word));
    } else if (matches(e, 'statusPicker')) {
      e.preventDefault();
      const r = ta.getBoundingClientRect();
      showStatusPicker(r.left, r.top + 20, statusOf(node.content)?.word, (word) => {
        this.beginOp();
        this.setMarker(node, word);
        this.edit(node, ta.selectionStart);
      });
    } else if (k === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      if (!e.shiftKey && this.expandFence(node, ta)) return;
      if (inFence(v, start)) this.codeIndent(node, ta, e.shiftKey);
      else if (e.shiftKey) this.outdent(node, start);
      else this.indent(node, start);
    } else if (k === 'Backspace' && start === 0 && end === 0) {
      if (this.mergeUp(node)) e.preventDefault();
    } else if (k === 'Delete' && start === v.length && end === v.length) {
      const vis = this.visible();
      const next = vis[vis.indexOf(node) + 1];
      if (next) { e.preventDefault(); this.mergeUp(next); }
    } else if ((k === 'ArrowUp' || k === 'ArrowDown') && mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (node.children.length) this.setCollapsedDeep(node, k === 'ArrowUp');
    } else if ((k === 'ArrowUp' || k === 'ArrowDown') && e.altKey && e.shiftKey) {
      e.preventDefault();
      this.move(node, k === 'ArrowUp' ? -1 : 1, start);
    } else if (k === 'ArrowUp' && plain && start === end && !v.slice(0, start).includes('\n')) {
      const vis = this.visible();
      const prev = vis[vis.indexOf(node) - 1];
      if (prev) { e.preventDefault(); this.edit(prev, 'end'); }
    } else if (k === 'ArrowDown' && plain && start === end && !v.slice(end).includes('\n')) {
      const vis = this.visible();
      const next = vis[vis.indexOf(node) + 1];
      if (next) { e.preventDefault(); this.edit(next, 'start'); }
    } else if ((k === 'ArrowUp' || k === 'ArrowDown') && e.shiftKey && !mod && !e.altKey && start === end
      && (k === 'ArrowUp' ? !v.slice(0, start).includes('\n') : !v.slice(end).includes('\n'))) {
      // Shift+↑ on the first line / Shift+↓ on the last selects whole blocks.
      e.preventDefault();
      const vis = this.visible();
      const other = vis[vis.indexOf(node) + (k === 'ArrowUp' ? -1 : 1)] || node;
      this.selectBlocks(node, other);
    } else if (matches(e, 'bold') || matches(e, 'italic') || matches(e, 'strike')) {
      e.preventDefault();
      this.formatText(node, ta, matches(e, 'bold') ? '**' : matches(e, 'strike') ? '~~' : '_');
    } else if (k === 'Escape') {
      e.preventDefault();
      // A menu from the format bar closes first; editing carries on.
      if (document.querySelector('.menu')) return closeMenu();
      // Esc stops editing and selects the block (Esc again clears it).
      this.selectBlocks(node);
    }
  }

  // ---- bold / italic ---------------------------------------------------------

  // Ctrl+B / Ctrl+I: wrap the selected text, or the whole current line when
  // nothing is selected. Pressing again removes the marks.
  formatText(node, ta, mark) {
    this.beginOp();
    const v = ta.value;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const m = mark.length;
    if (s !== e) {
      const sel = v.slice(s, e);
      if (sel.length >= 2 * m && sel.startsWith(mark) && sel.endsWith(mark)) {
        const inner = sel.slice(m, -m);
        return this.replaceText(node, ta, s, e, inner, 0, inner.length);
      }
      if (v.slice(s - m, s) === mark && v.slice(e, e + m) === mark) {
        return this.replaceText(node, ta, s - m, e + m, sel, 0, sel.length);
      }
      return this.replaceText(node, ta, s, e, mark + sel + mark, m, m + sel.length);
    }
    const { start: ls, end: le, line } = lineAt(v, s);
    const core = line.slice(ls === 0 ? statusPrefix(line).length : 0).replace(/^\s*(?:#{1,6} |> )?/, '');
    if (!core.trim()) return this.replaceText(node, ta, s, s, mark + mark, m);
    const next = toggleLine(line, mark, ls === 0);
    const shift = (next.length - line.length) / 2;
    const caret = Math.max(0, Math.min(next.length, s - ls + shift));
    this.replaceText(node, ta, ls, le, next, caret);
  }

  // ---- block selection ---------------------------------------------------------

  // Selects the visible blocks from `anchor` to `focus` (inclusive). Each
  // selected block counts with all its children.
  selectBlocks(anchor, focus = anchor) {
    if (this.editing) this.stopEdit();
    this.closeCodeEditor();
    if (selectedEditor && selectedEditor !== this) selectedEditor.clearSelection();
    selectedEditor = this;
    lastEditor = this;
    this.sel = { anchor, focus };
    document.activeElement?.blur?.();
    this.paintSelection();
  }

  clearSelection() {
    this.sel = null;
    if (selectedEditor === this) selectedEditor = null;
    this.container.querySelectorAll('.block.selected').forEach((b) => b.classList.remove('selected'));
  }

  // Top-most selected nodes in document order (children ride along).
  selectedRoots() {
    if (!this.sel) return [];
    const vis = this.visible();
    let a = vis.indexOf(this.sel.anchor);
    let b = vis.indexOf(this.sel.focus);
    if (a === -1 || b === -1) return [];
    if (a > b) [a, b] = [b, a];
    const range = vis.slice(a, b + 1);
    const set = new Set(range);
    return range.filter((n) => { for (let p = n.parent; p; p = p.parent) if (set.has(p)) return false; return true; });
  }

  paintSelection() {
    this.container.querySelectorAll('.block.selected').forEach((b) => b.classList.remove('selected'));
    const roots = this.selectedRoots();
    roots.forEach((n) => n.el?.classList.add('selected'));
    roots[roots.length - 1]?.el?.scrollIntoView({ block: 'nearest' });
  }

  selectionMarkdown(opts = {}) {
    return this.selectedRoots().map((n) => subtreeMarkdown(n, opts)).join('\n');
  }

  deleteSelection() {
    const roots = this.selectedRoots();
    if (!roots.length) return;
    const vis = this.visible();
    const after = vis.slice(vis.indexOf(roots[roots.length - 1]) + 1).find((n) => !roots.some((r) => isInside(n, r)));
    this.beginOp();
    roots.forEach((n) => this.detach(n));
    if (!this.root.children.length) this.insertChild(this.root, makeNode(), 0);
    this.refresh();
    const next = after && this.findNode(after.id);
    if (next) this.selectBlocks(next);
  }

  // Keys while blocks are selected (no text field focused).
  onSelectionKey(e) {
    const vis = this.visible();
    const roots = this.selectedRoots();
    if (!roots.length) return this.clearSelection();
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const step = (dir) => vis[Math.max(0, Math.min(vis.length - 1, vis.indexOf(this.sel.focus) + dir))];
    if (k === 'Escape') {
      e.preventDefault();
      this.clearSelection();
    } else if (k === 'Enter' && !mod && !e.shiftKey) {
      e.preventDefault();
      const n = roots[0];
      this.clearSelection();
      this.edit(n, 'end');
    } else if ((k === 'ArrowUp' || k === 'ArrowDown') && !mod && !e.altKey) {
      e.preventDefault();
      const target = step(k === 'ArrowUp' ? -1 : 1);
      if (e.shiftKey) { this.sel.focus = target; this.paintSelection(); } else this.selectBlocks(target);
    } else if ((k === 'Backspace' || k === 'Delete') && !mod) {
      e.preventDefault();
      this.deleteSelection();
    } else if (mod && k?.toLowerCase() === 'a' && !e.shiftKey) {
      e.preventDefault();
      const top = this.root.children;
      if (top.length) this.selectBlocks(top[0], vis[vis.length - 1]);
    } else if (matches(e, 'cycleStatus')) {
      e.preventDefault();
      const word = nextStatus(statusOf(roots[0].content)?.word);
      this.beginOp();
      roots.forEach((n) => this.setMarker(n, word));
      this.paintSelection();
    } else if (matches(e, 'bold') || matches(e, 'italic') || matches(e, 'strike')) {
      e.preventDefault();
      const mark = matches(e, 'bold') ? '**' : matches(e, 'strike') ? '~~' : '_';
      this.beginOp();
      roots.forEach((n) => this.applyValue(n, toggleFirstLine(n.content, mark)));
      this.paintSelection();
    } else if (k === 'Tab' && !mod) {
      e.preventDefault(); // keep focus from jumping to the sidebar
    }
  }

  // Inserts parsed outline nodes (from paste) after `anchor`, as siblings.
  // Ids from the text are kept unless they already exist. Returns the
  // last inserted node (deepest last child), or null.
  insertOutline(anchor, roots, replaceEmpty = false) {
    const existing = new Set(this.flatten().map((b) => b.id));
    const adopt = (n, parent) => {
      if (existing.has(n.id)) n.id = uuid();
      existing.add(n.id);
      n.parent = parent;
      const split = splitProps(n.content);
      n.content = split.content;
      n.props = split.props;
      n.children.forEach((c) => adopt(c, n));
    };
    let last = null;
    roots.forEach((r, idx) => {
      adopt(r, anchor.parent);
      if (idx === 0 && replaceEmpty && anchor.content.trim() === '' && !anchor.children.length) {
        const sibs = anchor.parent.children;
        sibs.splice(sibs.indexOf(anchor), 1, r);
      } else {
        this.insertAfter(anchor, r);
      }
      anchor = r;
      last = r;
    });
    if (!last) return null;
    while (last.children.length && !last.collapsed) last = last.children[last.children.length - 1];
    return last;
  }

  // Enter in a table row adds a row with the same number of cells. Enter on
  // an empty row removes it and starts a new block.
  tableEnter(node, ta, ls, le, line) {
    this.beginOp();
    const cols = Math.max(1, (line.match(/\|/g) || []).length - 1);
    const empty = line.replace(/[|\s]/g, '') === '';
    if (empty) {
      const from = ls > 0 ? ls - 1 : ls;
      this.replaceText(node, ta, from, le, '');
      this.split(node, from, from, true);
      return;
    }
    const row = '\n' + '|  '.repeat(cols) + '|';
    this.replaceText(node, ta, le, le, row, 3);
  }

  // Tab or Enter at the end of an opening fence ("```" or "```bash") that has
  // no closing fence yet: add the closing fence and put the cursor inside.
  expandFence(node, ta) {
    const v = ta.value;
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return false;
    const { start, end, line } = lineAt(v, pos);
    if (pos !== end || !/^```[^`\s]*\s*$/.test(line)) return false;
    const before = (v.slice(0, start).match(/^```/gm) || []).length;
    const total = (v.match(/^```/gm) || []).length;
    if (before % 2 !== 0 || total % 2 !== 1) return false;
    this.beginOp();
    const open = line.trimEnd();
    this.replaceText(node, ta, start, end, `${open}\n\n\`\`\``, open.length + 1);
    const idx = findFences(node.content).findIndex((f) => f.start === start);
    this.openCodeEditor(node, Math.max(0, idx), 0);
    return true;
  }

  // ---- code editor ---------------------------------------------------------

  // Re-render the whole outline, then put the cursor back.
  refresh(focusNode, caret) {
    this.markDirty();
    this.render();
    if (focusNode) this.edit(focusNode, caret);
  }

  split(node, start, end, skipCheckpoint = false) {
    if (!skipCheckpoint) this.beginOp();
    const v = node.content;
    // Enter on an empty numbered item ends the list.
    if (v === '' && node.props[NUMBERED]) {
      delete node.props[NUMBERED];
      return this.refresh(node, 0);
    }
    // Enter on an empty nested block moves it out a level.
    if (v === '' && node.parent !== this.root) return this.outdent(node, 0);
    // Enter at the very start of a block inserts an empty block above it.
    if (start === 0 && end === 0 && v !== '') {
      const n = makeNode('', uuid(), { ...pick(node.props, NUMBERED) });
      this.insertChild(node.parent, n, node.parent.children.indexOf(node));
      return this.refresh(node, 0);
    }
    node.content = v.slice(0, start);
    const n = makeNode(v.slice(end));
    if (node.children.length && !node.collapsed) {
      this.insertChild(node, n, 0);
    } else {
      n.props = { ...pick(node.props, NUMBERED) }; // numbered lists continue
      this.insertAfter(node, n);
    }
    this.refresh(n, 'start');
  }

  indent(node, caret) {
    const sibs = node.parent.children;
    const i = sibs.indexOf(node);
    if (i === 0) return;
    this.beginOp();
    const prev = sibs[i - 1];
    this.detach(node);
    prev.collapsed = false;
    this.insertChild(prev, node, prev.children.length);
    this.refresh(node, caret);
  }

  outdent(node, caret) {
    const parent = node.parent;
    if (parent === this.root) return;
    this.beginOp();
    this.detach(node);
    this.insertAfter(parent, node);
    this.refresh(node, caret);
  }

  move(node, dir, caret) {
    const sibs = node.parent.children;
    const i = sibs.indexOf(node);
    const j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    this.beginOp();
    [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
    this.refresh(node, caret);
  }

  // Backspace at the start of a block: join it onto the block above.
  mergeUp(node) {
    const vis = this.visible();
    const i = vis.indexOf(node);
    if (i <= 0) return false;
    this.beginOp();
    const prev = vis[i - 1];
    const caret = prev.content.length;
    if (node.content === '' && !node.children.length) {
      this.detach(node);
      this.refresh(prev, 'end');
      return true;
    }
    prev.content += node.content;
    // The merged block's children take its place in the tree.
    const sibs = node.parent.children;
    const at = sibs.indexOf(node);
    node.children.forEach((c) => { c.parent = node.parent; });
    sibs.splice(at, 1, ...node.children);
    this.refresh(prev, caret);
    return true;
  }

  appendBlock() {
    const last = this.root.children[this.root.children.length - 1];
    if (last && last.content === '' && !last.children.length) return this.edit(last, 'end');
    const n = makeNode();
    this.insertChild(this.root, n, this.root.children.length);
    this.render();
    this.edit(n);
  }

  // Sets the task status word (null removes it). Setting one also adds
  // #task at the end of the first line; the cursor stays in the text.
  setMarker(node, word) {
    const old = node.content;
    const value = withStatus(old, word);
    let caret;
    if (this.editing === node && this.ta) {
      const oldPre = statusPrefix(old).length;
      const newPre = statusPrefix(value).length;
      caret = Math.max(newPre, this.ta.selectionStart - oldPre + newPre);
      if (word && !hasTaskTag(old)) {
        const firstEnd = value.indexOf('\n') === -1 ? value.length : value.indexOf('\n');
        if (value.slice(0, firstEnd).endsWith('#task')) {
          const tagAt = firstEnd - '#task'.length;
          caret = Math.min(caret, value[tagAt - 1] === ' ' ? tagAt - 1 : tagAt);
        }
      }
    }
    this.applyValue(node, value, caret);
  }

  // Sets "# " .. "###### " on the first line (level 0 removes it).
  setHeading(node, level) {
    const marker = statusPrefix(node.content);
    const rest = node.content.slice(marker.length).replace(/^#{1,6} /, '');
    const value = marker + (level ? '#'.repeat(level) + ' ' : '') + rest;
    this.applyValue(node, value);
  }

  // Sets a block's whole text, keeping the cursor in place while editing.
  applyValue(node, value, caret) {
    const delta = value.length - node.content.length;
    if (this.editing === node && this.ta) {
      const pos = caret ?? Math.max(0, this.ta.selectionStart + delta);
      this.ta.value = value;
      this.ta.setSelectionRange(pos, pos);
      this.setContent(node, value);
      autosize(this.ta);
    } else {
      this.setContent(node, value);
      this.rerenderContent(node);
    }
  }

  // Opens the maths builder for an existing formula (span from mathSpans),
  // or for a new one at `at` (then editing resumes after it).
  openMath(node, span, at = null) {
    openMathBuilder({
      tex: span ? span.tex.trim() : '',
      display: span ? span.display : true,
      editing: !!span,
      onInsert: (tex, display) => {
        const text = mathSource(tex, display, span);
        const pos = at ?? node.content.length;
        const [start, end] = span ? [span.start, span.end] : [pos, pos];
        this.beginOp();
        const value = node.content.slice(0, start) + text + node.content.slice(end);
        if (this.editing === node) this.applyValue(node, value, start + text.length);
        else {
          this.applyValue(node, value);
          if (at !== null) this.edit(node, start + text.length);
        }
      },
    });
  }

  // Adds "[[Nov 11th, 2026]] 14:32": at the cursor while editing, otherwise at
  // the end of the first line (before any tags, so they stay on the right).
  addTimestamp(node) {
    const stamp = timestamp();
    if (this.editing === node && this.ta) {
      const { selectionStart: a, selectionEnd: b, value } = this.ta;
      const pad = a > 0 && !/\s/.test(value[a - 1]) ? ' ' : '';
      this.checkpoint();
      this.replaceText(node, this.ta, a, b, pad + stamp);
      this.ta.focus();
      return;
    }
    this.beginOp();
    const text = node.content;
    const nl = text.indexOf('\n');
    const first = nl === -1 ? text : text.slice(0, nl);
    let value;
    if (!first.trim()) value = stamp + text.slice(first.length);
    else if (first.startsWith('```') || /^\s*\|/.test(first)) value = `${stamp}\n${text}`;
    else {
      const tags = /((?:\s+(?:#\[\[[^\]\n]+\]\]|#[^\s#,.!?;:()[\]"'`]+))*)\s*$/.exec(first);
      const cut = tags.index;
      value = `${first.slice(0, cut)} ${stamp}${first.slice(cut)}${text.slice(first.length)}`;
    }
    this.applyValue(node, value);
  }

  // Sets or clears a managed property (colour, heading, list type).
  setProp(node, key, value) {
    this.beginOp();
    if (value === null || value === undefined) delete node.props[key];
    else node.props[key] = value;
    const keep = this.editing;
    const caret = this.ta?.selectionStart;
    this.refresh(keep, caret);
  }

  // level: 1-6 sets a Markdown heading, 'auto' sizes by depth, 0 clears both.
  setHeadingStyle(node, level) {
    this.beginOp();
    if (level === 'auto') {
      this.setHeading(node, 0);
      node.props[HEADING] = 'true';
    } else {
      delete node.props[HEADING];
      this.setHeading(node, level);
    }
    const keep = this.editing;
    const caret = this.ta?.selectionStart;
    this.refresh(keep, caret);
  }

  // Expands or collapses a block and everything under it.
  setCollapsedDeep(node, collapsed) {
    const walk = (n) => { if (n.children.length) n.collapsed = collapsed; n.children.forEach(walk); };
    walk(node);
    let keep = this.editing;
    const caret = this.ta?.selectionStart;
    if (keep && collapsed && isInside(keep, node)) keep = node;
    this.refresh(keep, keep === this.editing ? caret : 'end');
  }

  cut(node) {
    copyText(subtreeMarkdown(node, { ids: true }));
    this.removeNode(node);
    toast('Block cut. Paste it anywhere to move it.');
  }

  blockUrl(node) {
    return `${location.origin}${location.pathname}#/page/${encodeURIComponent(this.name)}?b=${node.id}`;
  }

  // Scrolls to a block (opening collapsed parents) and flashes it.
  // Scrolls to a block and flashes it; with `edit`, puts the cursor in it.
  reveal(id, { edit = false } = {}) {
    const node = this.findNode(id);
    if (!node) return toast('That block is no longer on this page');
    for (let n = node.parent; n && n !== this.root; n = n.parent) n.collapsed = false;
    this.render();
    node.el.scrollIntoView({ block: 'center' });
    node.el.classList.add('flash');
    setTimeout(() => node.el?.classList.remove('flash'), 2000);
    if (edit) this.edit(node, 'end');
  }

  // Puts the cursor back where you last edited on this page, or at the end
  // of its first block (for "go to the editor").
  focusForKeyboard() {
    const last = this.lastEdited && this.findNode(this.lastEdited.id);
    const node = last || this.root.children[0];
    if (!node) return;
    node.el?.scrollIntoView({ block: 'nearest' });
    this.edit(node, 'end');
  }

  exportBlock(node) {
    const body = el('div', 'export');
    const tabs = el('div', 'tabs');
    const out = el('textarea', 'export-text');
    out.readOnly = true;
    const formats = [['Markdown', () => subtreeMarkdown(node)], ['Plain text', () => subtreeMarkdown(node, { plain: true })]];
    let current = 0;
    const show = (i) => {
      current = i;
      [...tabs.children].forEach((b, j) => b.classList.toggle('active', i === j));
      out.value = formats[i][1]();
    };
    formats.forEach(([label], i) => {
      const b = el('button', 'tab', label);
      b.addEventListener('click', () => show(i));
      tabs.append(b);
    });
    body.append(tabs, out);
    openModal('Copy / Export', body, [
      ['Close'],
      ['Copy', () => { copyText(out.value); toast('Copied'); }, 'primary'],
    ]);
    show(current);
    out.focus();
    out.select();
  }

  // Bullet threading: draws the path from the edited block up to the top.
  updateThread() {
    this.container.querySelectorAll('.thread-line').forEach((e) => e.remove());
    this.container.querySelectorAll('.bullet.thread').forEach((e) => e.classList.remove('thread'));
    // "Always show": a faint line from every block to its parent.
    const all = !!getSetting('threadAlways');
    this.container.classList.toggle('thread-all', all);
    if (all) {
      const lines = []; // measure everything first, then add (one layout pass)
      for (const box of this.container.querySelectorAll('.children')) {
        const top = box.getBoundingClientRect().top;
        for (const child of box.children) {
          const row = child.classList.contains('block') && child.querySelector(':scope > .block-row');
          if (row) lines.push([box, row.getBoundingClientRect().top - top + 14]);
        }
      }
      for (const [box, height] of lines) {
        if (height <= 0) continue;
        const line = el('div', 'thread-line dim');
        line.style.height = `${height}px`;
        box.append(line);
      }
    }
    const node = this.editing || this.codeEdit?.node;
    if (!node || !node.el || !getSetting('threading')) return;
    const bulletOf = (n) => n.el?.querySelector(':scope > .block-row > .bullet');
    bulletOf(node)?.classList.add('thread');
    for (let n = node; n.parent && n.parent !== this.root; n = n.parent) {
      const box = n.parent.el?.querySelector(':scope > .children');
      const row = n.el?.querySelector(':scope > .block-row');
      if (!box || !row) break;
      const height = row.getBoundingClientRect().top - box.getBoundingClientRect().top + 14;
      const line = el('div', 'thread-line');
      line.style.height = `${height}px`;
      box.append(line);
      bulletOf(n.parent)?.classList.add('thread');
    }
  }

  toggleNumbered(node) {
    this.beginOp();
    const keep = this.editing;
    const caret = this.ta?.selectionStart;
    if (node.props[NUMBERED] === 'number') delete node.props[NUMBERED];
    else node.props[NUMBERED] = 'number';
    this.refresh(keep, caret);
  }

  toggleCollapse(node) {
    node.collapsed = !node.collapsed;
    const keep = this.editing && !isInside(this.editing, node) ? this.editing : null;
    const caret = this.ta?.selectionStart;
    this.refresh(keep, caret);
  }

  removeNode(node) {
    this.beginOp();
    this.detach(node);
    if (!this.root.children.length) this.insertChild(this.root, makeNode(), 0);
    this.refresh();
  }

  onPaste(node, ta, e) {
    const files = imageFiles(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      this.insertImages(node, files);
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    // A pasted YouTube / Vimeo link becomes an embedded player.
    if (text && !text.trim().includes('\n') && isVideoUrl(text.trim()) && !inFence(ta.value, ta.selectionStart)) {
      e.preventDefault();
      this.beginOp();
      this.replaceText(node, ta, ta.selectionStart, ta.selectionEnd, `{{video ${text.trim()}}}`);
      return;
    }
    // A pasted X / Twitter post link becomes an embedded post (Logseq's
    // {{tweet}} macro). Tracking parameters (?s=20&t=…) are dropped.
    if (text && !text.trim().includes('\n') && tweetId(text.trim()) && !inFence(ta.value, ta.selectionStart)) {
      e.preventDefault();
      this.beginOp();
      this.replaceText(node, ta, ta.selectionStart, ta.selectionEnd, `{{tweet ${text.trim().split(/[?#]/)[0]}}}`);
      return;
    }
    if (text && text === lastCopy && /^- [^\n]*$/.test(text)) {
      // One block copied from Blockseq: paste its text, not "- text".
      e.preventDefault();
      this.beginOp();
      this.replaceText(node, ta, ta.selectionStart, ta.selectionEnd, text.slice(2));
      return;
    }
    if (!text || !text.includes('\n') || inFence(ta.value, ta.selectionStart)) return;
    const roots = parseOutline(text, uuid);
    if (!roots || !roots.length) return;
    e.preventDefault();
    this.beginOp();
    const lastNode = this.insertOutline(node, roots, true);
    this.refresh(lastNode, 'end');
  }

  // Uploads images and inserts their Markdown at `at` (default: the cursor,
  // or the end of the block when it isn't being edited).
  async insertImages(node, files, at) {
    const editingNow = () => this.editing === node && this.ta;
    let start = at ?? (editingNow() ? this.ta.selectionStart : node.content.length);
    let end = at ?? (editingNow() ? this.ta.selectionEnd : node.content.length);
    toast(files.length > 1 ? `Uploading ${files.length} files…` : 'Uploading…');
    const parts = [];
    for (const f of files) {
      try { parts.push(await uploadImage(f)); } catch (err) { toast(`Upload failed: ${err.message}`); }
    }
    if (!parts.length || this.disposed) return;
    this.beginOp();
    const v = node.content;
    start = Math.min(start, v.length);
    end = Math.min(Math.max(end, start), v.length);
    // Put an image on its own line unless the block is empty, dropping any
    // spaces left at the end of the line before it.
    while (start > 0 && (v[start - 1] === ' ' || v[start - 1] === '\t')) start--;
    const sep = start > 0 && v[start - 1] !== '\n' ? '\n' : '';
    const md = sep + parts.join('\n');
    if (editingNow()) {
      this.replaceText(node, this.ta, start, end, md);
    } else {
      this.setContent(node, v.slice(0, start) + md + v.slice(end));
      this.rerenderContent(node);
    }
    toast(parts.length > 1 ? 'Files added' : 'Added');
  }

  //
  // While a block is edited, a small bar floats just above it (or below it
  // when there is no room above, e.g. near the top of the window). Its
  // buttons never take focus, so the cursor and selection stay put.

  // ---- saving and sync ---------------------------------------------------

  dispose() {
    this.disposed = true;
    this.resizeObs?.disconnect();
    this.closeCodeEditor();
    this.stopEdit();
    if (this.dirty) this.save(); else editors.delete(this);
  }
}

installSync(PageEditor);
installFormatBar(PageEditor);
installSecrets(PageEditor);
installCodeBlocks(PageEditor);
installBlockMenus(PageEditor);

function pick(obj, ...keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function isInside(node, ancestor) {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

export function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

export function subtreeMarkdown(node, opts = {}) {
  const lines = [];
  const walk = (n, depth) => {
    const ind = '\t'.repeat(depth);
    if (opts.plain) {
      n.content.split('\n').forEach((l) => lines.push(ind + l));
    } else {
      const [first, ...rest] = joinProps(n.content, n.props).split('\n');
      lines.push(`${ind}- ${first}`);
      if (opts.ids) lines.push(`${ind}  id:: ${n.id}`);
      rest.forEach((l) => lines.push(`${ind}  ${l}`));
    }
    // An open #Encrypted block is copied encrypted (its property holds the
    // children), so plaintext never ends up on the clipboard.
    if (n.props.encrypted && n.unsealed) return;
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(node, 0);
  return lines.join('\n');
}
