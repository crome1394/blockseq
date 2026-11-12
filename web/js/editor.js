// The block outliner. One PageEditor edits one page; the journals view shows
// several at once. Each keeps the page as a tree of nodes, re-renders after
// structural changes, and autosaves the whole page with optimistic
// versioning (the server answers 409 if another device saved first).

import { api, uuid, getPageNames, invalidatePageNames } from './api.js';
import {
  renderContent, parseOutline, esc, splitProps, joinProps, imageAlign, imageSize, pdfView, findFences, isPureCode,
  isVideoUrl, mathSpans,
} from './render.js';
import {
  imageFiles, uploadImage, pickImages, imageAt, withAlign, withMeta, withoutImage, withoutFileLink,
  openLightbox, copyImage, downloadImage,
} from './images.js';
import { getStatuses, statusOf, statusPrefix, stripStatus, withStatus, nextStatus, statusStyle, hasTaskTag } from './tasks.js';
import { matches } from './keys.js';
import { openPdfPane, openFilePane } from './pdfview.js';
import { ENCRYPTED_TAG, isUnlocked, available as cryptoAvailable, encryptText, decryptText } from './crypto.js';
import { unlockDialog } from './secure-ui.js';
import { rekeyDialog } from './backup-ui.js';
import { openMathBuilder } from './mathbuilder.js';
import { journalName } from './dates.js';
import { toast, copyText, updateStatus, openModal } from './ui.js';
import { decorateCode, highlightForEditor, CodeEditor } from './code.js';
import { getSetting } from './settings.js';

export const editors = new Set();

const pad2 = (n) => String(n).padStart(2, '0');
const timeNow = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const timestamp = () => `[[${journalName(new Date())}]] ${timeNow()}`;

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

const SAVE_DELAY = 600;
const HISTORY_LIMIT = 200;
// A #quote tag on a block shows it and its children as a quotation.
const QUOTE_TAG = /(^|\s)#quote(?=\s|$)/i;
const NUMBERED = 'logseq.order-list-type';
const COLOR = 'background-color';
const HEADING = 'heading';
const COLORS = ['yellow', 'red', 'pink', 'green', 'blue', 'purple', 'gray'];

// The editor the user touched last; keyboard undo outside a block goes here.
let lastEditor = null;
// The editor that has blocks selected (only one at a time).
let selectedEditor = null;
// Text we last put on the clipboard from selected blocks.
let lastCopy = '';

const isField = (t) => !!t?.closest?.('input, textarea, select, [contenteditable]');

// Toggles **bold** or _italic_ around one line's text, leaving a status word,
// heading marker and trailing #tags outside the marks.
const TRAILING_TAG_RUN = /(?:\s+(?:#\[\[[^\]\n]+\]\]|#[^\s#,.!?;:()[\]"'`+][^\s#,.!?;:()[\]"'`]*))+\s*$/;
const MARKS = ['**', '_'];

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

function makeNode(content = '', id = uuid(), props = {}) {
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

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// True if the caret sits inside a ``` code fence (including its first line).
// True when pos is inside a #+BEGIN_… / #+END_… admonition.
function inAdmonition(text, pos) {
  const before = text.slice(0, pos);
  const begin = before.lastIndexOf('#+BEGIN_');
  if (begin === -1 || (begin > 0 && before[begin - 1] !== '\n')) return false;
  return !/\n#\+END_/i.test(before.slice(begin)) && /\n#\+END_/i.test(text.slice(pos - 1));
}

function inFence(text, pos) {
  return ((text.slice(0, pos).match(/^```/gm) || []).length) % 2 === 1;
}

function lineAt(text, pos) {
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
    this.render();
    this.openSecrets();
  }

  // ---- #Encrypted blocks -----------------------------------------------------
  //
  // A block tagged #Encrypted keeps its own text readable; its children are
  // stored as one encrypted outline in its hidden `encrypted::` property.
  // `node.unsealed` means the children are decrypted in memory right now.

  // Every #Encrypted block, innermost first (so nested ones seal before the
  // block that contains them).
  secretRoots() {
    const out = [];
    const walk = (n) => n.children.forEach((c) => {
      walk(c);
      if (ENCRYPTED_TAG.test(c.content) || c.props.encrypted) out.push(c);
    });
    walk(this.root);
    return out;
  }

  // Decrypts every locked encrypted block on the page (when unlocked).
  async openSecrets() {
    if (!isUnlocked()) return;
    if (this.needsSealing()) this.sealNow();
    let changed = false;
    for (const r of this.secretRoots()) {
      if (!r.props.encrypted || r.unsealed) continue;
      try {
        const text = await decryptText(r.props.encrypted);
        if (this.disposed || r.unsealed) return;
        const kids = text.trim() ? (parseOutline(text, uuid) || []) : [];
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
        kids.forEach((k) => adopt(k, r));
        r.children = [...kids, ...r.children]; // keep blocks added while locked
        r.unsealed = true;
        r.sealedText = text;
        r.decryptError = false;
        changed = true;
      } catch {
        r.decryptError = true;
        changed = true;
      }
    }
    if (changed && !this.disposed) {
      this.refresh(this.editing, this.ta?.selectionStart);
      // Opening a block may reveal encrypted blocks nested inside it.
      if (this.secretRoots().some((r) => r.props.encrypted && !r.unsealed && !r.decryptError)) this.openSecrets();
    }
  }

  // Before saving: encrypt the children of every #Encrypted block. Children
  // are only ever sent to the server inside the encrypted property.
  async sealSecrets() {
    for (const r of this.secretRoots()) {
      const tagged = ENCRYPTED_TAG.test(r.content);
      if (!tagged && r.props.encrypted && r.unsealed) {
        // Tag removed while unlocked: store the children as normal blocks again.
        delete r.props.encrypted;
        r.unsealed = false;
        this.decorateSecret(r);
        continue;
      }
      if (!tagged || !isUnlocked()) continue;
      if (r.props.encrypted && !r.unsealed) continue; // still locked
      const text = r.children.map((c) => subtreeMarkdown(c, { ids: true })).join('\n');
      if (!r.props.encrypted || text !== r.sealedText) {
        r.props.encrypted = await encryptText(text);
        r.sealedText = text;
      }
      const was = r.unsealed;
      r.unsealed = true;
      if (!was) this.decorateSecret(r);
    }
  }

  // #Encrypted blocks whose children are still plain text (tagged before a
  // password existed, or while locked).
  needsSealing() {
    return this.secretRoots().some((r) => ENCRYPTED_TAG.test(r.content) && !r.props.encrypted && r.children.length);
  }

  // Encrypt such blocks now (needs the key). Resolves once saved.
  async sealNow() {
    if (!isUnlocked() || !this.needsSealing()) return;
    this.dirty = true;
    this.changeSeq++;
    await this.save();
  }

  // After /encrypted: open an empty child for the secret text, and ask to
  // unlock first if needed so nothing is saved as plain text.
  startSecretChild(node) {
    const child = makeNode();
    this.insertChild(node, child, 0);
    node.collapsed = false;
    this.refresh(child, 'end');
    if (!isUnlocked()) {
      // The password prompt takes the focus; come back to the child after it.
      const reopen = () => setTimeout(() => {
        const n = this.findNode(child.id);
        if (n && !this.disposed) this.edit(n, 'end');
      }, 50);
      document.addEventListener('blockseq:unlocked', reopen, { once: true });
      unlockDialog();
    }
  }

  // Called while locking: save (encrypting with the key one last time).
  async beforeLock() {
    if (this.editing && this.secretRoots().some((r) => isInside(this.editing, r))) this.stopEdit();
    if (this.codeEdit && this.secretRoots().some((r) => isInside(this.codeEdit.node, r))) this.closeCodeEditor();
    if (this.dirty || this.needsSealing()) {
      this.dirty = true;
      await this.save();
    }
  }

  // After locking: drop decrypted text from memory (and undo history).
  afterLock() {
    let any = false;
    for (const r of this.secretRoots()) {
      if (r.props.encrypted && r.unsealed) {
        if (this.editing && isInside(this.editing, r)) this.stopEdit();
        r.children = [];
        r.unsealed = false;
        r.sealedText = null;
        any = true;
      }
    }
    if (any) {
      this.undoStack = [];
      this.redoStack = [];
      this.refresh(this.editing, this.ta?.selectionStart);
    }
  }

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

  // Lock button, styling and the locked / not-encrypted notice of an
  // #Encrypted block. Re-run whenever its state changes.
  decorateSecret(node) {
    const wrap = node.el;
    if (!wrap) return;
    const row = wrap.querySelector(':scope > .block-row');
    wrap.querySelector(':scope > .secret-box')?.remove();
    row?.querySelector(':scope > .secret-lock')?.remove();
    const secret = ENCRYPTED_TAG.test(node.content) || !!node.props.encrypted;
    wrap.classList.toggle('secret-root', secret);
    wrap.classList.toggle('unlocked', secret && !!node.unsealed);
    if (!secret) return;
    if (node.unsealed && row) {
      const lockBtn = el('button', 'secret-lock', '🔓 Lock');
      lockBtn.type = 'button';
      lockBtn.title = 'Lock all encrypted blocks now';
      lockBtn.addEventListener('mousedown', (e) => e.preventDefault());
      lockBtn.addEventListener('click', () => import('./crypto.js').then((m) => m.lock()));
      row.append(lockBtn);
    } else if (node.props.encrypted || node.children.length) {
      wrap.append(this.secretNotice(node));
    }
  }

  // The box shown under a locked #Encrypted block (or one not encrypted yet).
  secretNotice(node) {
    const box = el('div', 'children secret-box');
    const btn = el('button', 'secret-unlock');
    btn.type = 'button';
    if (!node.props.encrypted) {
      btn.textContent = isUnlocked()
        ? '⚠ Encrypting…'
        : '⚠ Not encrypted yet: these blocks are still stored as plain text. Click to unlock and encrypt them now.';
      btn.classList.add('warn');
    } else if (!cryptoAvailable()) {
      btn.textContent = '🔒 Encrypted. Open Blockseq over HTTPS to unlock it.';
      btn.disabled = true;
    } else if (node.decryptError) {
      btn.textContent = "🔒 Encrypted with a different password (restored from a backup?). Click to re-encrypt it with your current password.";
      btn.classList.add('warn');
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => rekeyDialog());
      box.append(btn);
      return box;
    } else {
      btn.textContent = '🔒 Encrypted. Click to unlock.';
    }
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => unlockDialog());
    box.append(btn);
    return box;
  }

  renderConflict() {
    const bar = el('div', 'conflict');
    bar.append(el('span', '', 'This page was changed on another device while you were editing it.'));
    const theirs = el('button', '', 'Use their version');
    theirs.addEventListener('click', () => {
      this.conflict = null;
      this.dirty = false;
      this.load(this.conflictData);
      updateStatus();
    });
    const mine = el('button', 'primary', 'Keep mine');
    mine.addEventListener('click', () => {
      this.version = this.conflict.version;
      this.conflict = null;
      this.render();
      this.save();
    });
    bar.append(theirs, mine);
    return bar;
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
    } else if (matches(e, 'bold') || matches(e, 'italic')) {
      e.preventDefault();
      this.formatText(node, ta, matches(e, 'bold') ? '**' : '_');
    } else if (k === 'Escape') {
      // Esc stops editing and selects the block (Esc again clears it).
      e.preventDefault();
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
    } else if (matches(e, 'bold') || matches(e, 'italic')) {
      e.preventDefault();
      const mark = matches(e, 'bold') ? '**' : '_';
      this.beginOp();
      roots.forEach((n) => {
        const nl = n.content.indexOf('\n');
        const first = nl === -1 ? n.content : n.content.slice(0, nl);
        this.applyValue(n, toggleLine(first, mark, true) + (nl === -1 ? '' : n.content.slice(nl)));
      });
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

  // Opens the code editor on the idx-th code fence of a block.
  openCodeEditor(node, idx, caret = 0) {
    if (this.editing) this.stopEdit();
    this.closeCodeEditor();
    if (!node.contentEl) return;
    const f = findFences(node.content)[idx];
    const pre = node.contentEl.querySelector(`pre.code[data-fence="${idx}"]`);
    if (!f || !pre) return;
    lastEditor = this;
    this.burst = false;
    const ce = new CodeEditor({
      code: f.code,
      lang: f.lang,
      live: getSetting('liveCode'),
      wrap: getSetting('codeWrap'),
      onChange: (code) => this.codeChanged(node, idx, code),
      onLang: (lang) => this.codeLang(node, idx, lang),
      onExit: () => this.closeCodeEditor(),
      onNavigate: (dir) => {
        const vis = this.visible();
        const target = vis[vis.indexOf(node) + dir];
        if (!target) return;
        this.closeCodeEditor();
        this.edit(target, dir < 0 ? 'end' : 'start');
      },
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onRaw: () => {
        this.closeCodeEditor();
        this.edit(node, 'end', { raw: true });
      },
    });
    pre.replaceWith(ce.el);
    node.el.classList.add('editing');
    this.codeEdit = { node, idx, ce };
    ce.focus(caret);
    this.updateThread();
  }

  closeCodeEditor() {
    const c = this.codeEdit;
    if (!c) return;
    this.codeEdit = null;
    c.ce.close();
    this.burst = false;
    c.node.el?.classList.remove('editing');
    this.rerenderContent(c.node);
    this.updateThread();
    if (this.pendingReload && !this.dirty) this.reload();
  }

  codeChanged(node, idx, code) {
    if (!this.burst) {
      this.checkpoint();
      this.burst = true;
    }
    clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => { this.burst = false; }, 1000);
    const f = findFences(node.content)[idx];
    if (f) this.setContent(node, node.content.slice(0, f.codeStart) + code + node.content.slice(f.codeEnd));
  }

  codeLang(node, idx, lang) {
    this.beginOp();
    const f = findFences(node.content)[idx];
    if (f) this.setContent(node, node.content.slice(0, f.langStart) + lang + node.content.slice(f.langEnd));
  }

  // Maps a click on a rendered code block to a cursor position in its code
  // (end of the clicked line).
  caretFromClick(node, pre, e) {
    const f = findFences(node.content)[Number(pre.dataset.fence)];
    if (!f) return 0;
    // Find the clicked line's row (rows can be taller when lines wrap).
    const rows = [...pre.querySelectorAll('.lc')];
    let line = rows.findIndex((r) => e.clientY < r.getBoundingClientRect().bottom);
    if (line < 0) line = rows.length - 1;
    const lines = f.code.split('\n');
    const l = Math.max(0, Math.min(line, lines.length - 1));
    return lines.slice(0, l + 1).join('\n').length;
  }

  // Tab / Shift+Tab inside a code fence indents the current line.
  codeIndent(node, ta, out) {
    this.beginOp();
    const pos = ta.selectionStart;
    const { start } = lineAt(ta.value, pos);
    if (!out) return this.replaceText(node, ta, pos, pos, '  ');
    const lead = /^ {1,2}/.exec(ta.value.slice(start))?.[0].length || 0;
    if (!lead) return;
    ta.value = ta.value.slice(0, start) + ta.value.slice(start + lead);
    const p = Math.max(start, pos - lead);
    ta.setSelectionRange(p, p);
    this.setContent(node, ta.value);
  }

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
  reveal(id) {
    const node = this.findNode(id);
    if (!node) return toast('That block is no longer on this page');
    for (let n = node.parent; n && n !== this.root; n = n.parent) n.collapsed = false;
    this.render();
    node.el.scrollIntoView({ block: 'center' });
    node.el.classList.add('flash');
    setTimeout(() => node.el?.classList.remove('flash'), 2000);
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

  showImageMenu(node, index, e) {
    lastEditor = this;
    const info = imageAt(node.content, index);
    if (!info) return;
    const align = imageAlign(info.meta);
    const alignItem = (a, label) => ({
      label: `${label}${align === a ? '  ✓' : ''}`,
      fn: () => this.changeText(node, withAlign(node.content, index, a)),
    });
    const size = imageSize(info.meta);
    const sizeItem = (s, label) => ({
      label: `${label}${size === s ? '  ✓' : ''}`,
      fn: () => this.changeText(node, withMeta(node.content, index, 'size', s || null)),
    });
    showMenu(e.clientX, e.clientY, [
      alignItem('left', 'Align left'),
      alignItem('center', 'Align center'),
      alignItem('right', 'Align right'),
      '-',
      sizeItem('', 'Fit to width'),
      sizeItem('original', 'Original size'),
      sizeItem('half', 'Half size'),
      sizeItem('quarter', 'Quarter size'),
      sizeItem('small', 'Very small'),
      '-',
      { label: 'Copy image', fn: () => copyImage(info.url) },
      { label: 'Open in new tab', fn: () => window.open(info.url, '_blank', 'noopener') },
      { label: 'Download', fn: () => downloadImage(info.url) },
      '-',
      { label: 'Delete image', danger: true, fn: () => this.changeText(node, withoutImage(node.content, index)) },
    ]);
  }

  showFileMenu(node, wrap, name, e) {
    lastEditor = this;
    const url = wrap.dataset.src;
    const kind = wrap.dataset.kind;
    const index = Number(wrap.dataset.index);
    const remove = () => this.changeText(node, wrap.dataset.md === 'link'
      ? withoutFileLink(node.content, index) : withoutImage(node.content, index));
    showMenu(e.clientX, e.clientY, [
      ...(kind === 'other' ? [] : [{ label: 'Open in side pane', fn: () => openFilePane(url, name, kind) }]),
      { label: 'Open in new tab', fn: () => window.open(url, '_blank', 'noopener') },
      { label: 'Download', fn: () => downloadImage(url) },
      '-',
      { label: 'Remove from block', danger: true, fn: remove },
    ]);
  }

  showPdfMenu(node, index, e) {
    lastEditor = this;
    const info = imageAt(node.content, index);
    if (!info) return;
    const name = info.alt || decodeURIComponent(info.url.split('?')[0].split('/').pop());
    const view = pdfView(info.meta);
    showMenu(e.clientX, e.clientY, [
      { label: `Show as link${view === 'link' ? '  ✓' : ''}`, fn: () => this.changeText(node, withMeta(node.content, index, 'view', null)) },
      { label: `Show full preview${view === 'preview' ? '  ✓' : ''}`, fn: () => this.changeText(node, withMeta(node.content, index, 'view', 'preview')) },
      '-',
      { label: 'Open in side pane', fn: () => openPdfPane(info.url, name) },
      { label: 'Open in new tab', fn: () => window.open(info.url, '_blank', 'noopener') },
      { label: 'Download', fn: () => downloadImage(info.url) },
      '-',
      { label: 'Remove from block', danger: true, fn: () => this.changeText(node, withoutImage(node.content, index)) },
    ]);
  }

  // A text change made from a menu: undoable, cursor kept if editing.
  changeText(node, value) {
    this.beginOp();
    this.applyValue(node, value);
  }

  showBlockMenu(node, e) {
    lastEditor = this;
    const colors = el('div', 'menu-swatches');
    for (const c of COLORS) {
      const sw = el('button', `swatch sw-${c}`);
      sw.title = c;
      if (node.props[COLOR] === c) sw.classList.add('active');
      sw.addEventListener('click', () => { closeMenu(); this.setProp(node, COLOR, c); });
      colors.append(sw);
    }
    const none = el('button', 'swatch sw-none');
    none.title = 'No colour';
    none.addEventListener('click', () => { closeMenu(); this.setProp(node, COLOR, null); });
    colors.append(none);

    const heads = el('div', 'menu-headings');
    const current = /^(#{1,6}) /.exec(stripStatus(node.content))?.[1].length || 0;
    const headBtn = (label, title, level, active) => {
      const b = el('button', 'head-btn' + (active ? ' active' : ''), label);
      b.title = title;
      b.addEventListener('click', () => { closeMenu(); this.setHeadingStyle(node, level); });
      heads.append(b);
    };
    for (let i = 1; i <= 6; i++) headBtn(`H${i}`, `Heading ${i}`, i, current === i);
    headBtn('HA', 'Auto heading (size by depth)', 'auto', node.props[HEADING] === 'true');
    headBtn('H', 'Remove heading', 0, false);
    heads.lastChild.classList.add('no-head');

    const entries = [
      { element: colors },
      { element: heads },
      '-',
      { label: 'Add timestamp', fn: () => this.addTimestamp(node) },
      '-',
      { label: 'Copy block ref', fn: () => { copyText(`((${node.id}))`); toast('Block ref copied'); } },
      { label: 'Copy block URL', fn: () => { copyText(this.blockUrl(node)); toast('Block URL copied'); } },
      { label: 'Copy / Export as…', fn: () => this.exportBlock(node) },
      { label: 'Cut', fn: () => this.cut(node) },
      { label: 'Delete block', fn: () => this.removeNode(node), danger: true },
      '-',
      { label: node.props[NUMBERED] === 'number' ? 'Remove number list' : 'Toggle number list', fn: () => this.toggleNumbered(node) },
    ];
    if (node.children.length) {
      entries.push('-',
        { label: 'Expand all', shortcut: 'Ctrl ↓', fn: () => this.setCollapsedDeep(node, false) },
        { label: 'Collapse all', shortcut: 'Ctrl ↑', fn: () => this.setCollapsedDeep(node, true) });
    }
    showMenu(e.clientX, e.clientY, entries);
  }

  // ---- saving and sync ---------------------------------------------------

  markDirty() {
    this.dirty = true;
    this.changeSeq++;
    updateStatus();
    if (this.conflict) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY);
  }

  async save(opts) {
    if (this.conflict || !this.dirty) return;
    if (this.saving) { this.saveAgain = true; return; }
    clearTimeout(this.saveTimer);
    this.saving = true;
    updateStatus();
    const seq = this.changeSeq;
    const wasNew = this.version === 0;
    try {
      await this.sealSecrets();
      const r = await api.savePage(this.name, this.version, this.flatten({ forSave: true }), opts);
      if (r.status === 200) {
        this.version = r.data.page.version;
        this.offline = false;
        if (this.changeSeq === seq) this.dirty = false;
        if (wasNew) invalidatePageNames();
        this.opts.onSaved?.(this);
      } else if (r.status === 409) {
        this.conflict = r.data.page;
        this.conflictData = { name: r.data.page.name, page: r.data.page, blocks: r.data.blocks };
        const caret = this.ta?.selectionStart;
        const editing = this.editing;
        this.render();
        if (editing) this.edit(editing, caret);
      } else {
        this.offline = true;
        toast(`Save failed: ${r.data?.error || r.status}`);
      }
    } catch {
      this.offline = true;
    } finally {
      this.saving = false;
      if (this.dirty && !this.conflict) {
        const delay = this.offline ? 4000 : this.saveAgain ? 0 : SAVE_DELAY;
        this.saveTimer = setTimeout(() => this.save(), delay);
      }
      this.saveAgain = false;
      if (!this.dirty && this.disposed) editors.delete(this);
      updateStatus();
    }
  }

  // Called when another device saved this page.
  remoteChanged(version) {
    if (this.disposed) return;
    if (version !== undefined && version <= this.version) return;
    if (this.dirty || this.saving) return; // the next save reports the conflict
    if (this.editing || this.codeEdit) { this.pendingReload = true; return; }
    this.reload();
  }

  async reload() {
    this.pendingReload = false;
    try {
      const data = await api.page(this.name);
      if (this.dirty || this.editing || this.codeEdit) return;
      this.load(data);
    } catch { /* offline; try again on the next event */ }
  }

  dispose() {
    this.disposed = true;
    this.resizeObs?.disconnect();
    this.closeCodeEditor();
    this.stopEdit();
    if (this.dirty) this.save(); else editors.delete(this);
  }
}

function pick(obj, ...keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function isInside(node, ancestor) {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// opts.ids adds id:: lines (so a cut block keeps its refs when pasted);
// opts.plain gives indented text without bullets or properties.
function subtreeMarkdown(node, opts = {}) {
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

// ---- block references ((uuid)) ---------------------------------------------

const refCache = new Map();

function findLocalBlock(id) {
  for (const ed of editors) {
    const n = ed.findNode(id);
    if (n) return { id, content: n.content, page_name: ed.name };
  }
  return null;
}

export function hydrateRefs(container) {
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

// ---- slash commands ----------------------------------------------------------

const SLASH_COMMANDS = [
  { id: 'link', label: 'Link', hint: '[text](url)' },
  { id: 'page', label: 'Page reference', hint: '[[ ]]' },
  { id: 'blockref', label: 'Block reference', hint: '(( ))' },
  { id: 'code', label: 'Code block', hint: '```' },
  { id: 'table', label: 'Table', hint: '| a | b |' },
  { id: 'numbered', label: 'Numbered list' },
  { id: 'h1', label: 'Heading 1', hint: '#' },
  { id: 'h2', label: 'Heading 2', hint: '##' },
  { id: 'h3', label: 'Heading 3', hint: '###' },
  { id: 'quote', label: 'Quote line', hint: '>' },
  { id: 'quoteblock', label: 'Quote block', hint: '#quote (block and children)' },
  { id: 'encrypted', label: 'Encrypted block', hint: '#Encrypted (children are encrypted)' },
  { id: 'tip', label: 'Tip', hint: 'admonition' },
  { id: 'note', label: 'Note', hint: 'admonition' },
  { id: 'important', label: 'Important', hint: 'admonition' },
  { id: 'caution', label: 'Caution', hint: 'admonition' },
  { id: 'warning', label: 'Warning', hint: 'admonition' },
  { id: 'pinned', label: 'Pinned', hint: 'admonition' },
  { id: 'image', label: 'Upload image', hint: 'png, jpg, gif, webp' },
  { id: 'pdf', label: 'Upload PDF', hint: 'link or preview' },
  { id: 'file', label: 'Upload file', hint: 'video, audio, documents…' },
  { id: 'video', label: 'Embed video', hint: 'YouTube or Vimeo link' },
  { id: 'today', label: 'Today', hint: "today's journal" },
  { id: 'time', label: 'Current time', hint: 'e.g. 14:32' },
  { id: 'timestamp', label: 'Timestamp', hint: "today's journal + time" },
  { id: 'math', label: 'Math (LaTeX)', hint: '$$ … $$' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'yesterday', label: 'Yesterday' },
];

function slashMatches(query) {
  const q = query.toLowerCase();
  // Task statuses come from Settings, so they are added each time.
  const statusCmds = getStatuses().map((s) => ({ id: `status:${s.word}`, label: s.label, hint: 'task status', word: s.word }));
  const hit = (c) => c.id.startsWith(q) || c.label.toLowerCase().includes(q) || c.word?.toLowerCase().startsWith(q);
  const first = (c) => c.id.startsWith(q) || c.label.toLowerCase().startsWith(q) || !!c.word?.toLowerCase().startsWith(q);
  return [...SLASH_COMMANDS, ...statusCmds].filter(hit).sort((a, b) => first(b) - first(a));
}

function runSlash(editor, node, ta, cmd, at) {
  // `at` is where the "/query" text was; it has already been removed.
  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `[[${journalName(d)}]]`; };
  switch (cmd) {
    case 'link': return editor.replaceText(node, ta, at, at, '[text](https://)', 1, 5);
    case 'page':
      editor.replaceText(node, ta, at, at, '[[]]', 2);
      return updateAutocomplete(editor, node, ta);
    case 'blockref':
      editor.replaceText(node, ta, at, at, '(())', 2);
      return updateAutocomplete(editor, node, ta);
    case 'code': {
      const lead = at > 0 && ta.value[at - 1] !== '\n' ? '\n' : '';
      editor.replaceText(node, ta, at, at, `${lead}\`\`\`\n\n\`\`\``, lead.length + 4);
      const idx = findFences(node.content).findIndex((f) => f.start === at + lead.length);
      return editor.openCodeEditor(node, Math.max(0, idx), 0);
    }
    case 'table': {
      const lead = at > 0 && ta.value[at - 1] !== '\n' ? '\n' : '';
      const t = `${lead}| Column 1 | Column 2 |\n| --- | --- |\n|  |  |`;
      return editor.replaceText(node, ta, at, at, t, lead.length + 2, lead.length + 10);
    }
    case 'tip': case 'note': case 'important': case 'caution': case 'warning': case 'pinned': {
      const lead = at > 0 && ta.value[at - 1] !== '\n' ? '\n' : '';
      const kind = cmd.toUpperCase();
      return editor.replaceText(node, ta, at, at, `${lead}#+BEGIN_${kind}\n\n#+END_${kind}`, lead.length + kind.length + 9);
    }
    case 'encrypted': {
      // This block becomes the readable label; the secret goes in a child.
      const first = ta.value.split('\n')[0];
      if (!ENCRYPTED_TAG.test(first)) {
        const label = first.trim() ? `${first.trimEnd()} ` : 'Encrypted ';
        editor.replaceText(node, ta, 0, first.length, `${label}#Encrypted`);
      }
      return editor.startSecretChild(node);
    }
    case 'quoteblock': {
      const first = ta.value.split('\n')[0];
      if (/(^|\s)#quote(\s|$)/i.test(first)) return;
      const pos = first.length;
      return editor.replaceText(node, ta, pos, pos, `${first.trim() ? ' ' : ''}#quote`, ta.selectionStart - pos);
    }
    case 'pdf':
      return pickImages('application/pdf,.pdf').then((files) => { if (files.length) editor.insertImages(node, files, at); });
    case 'file':
      return pickImages('').then((files) => { if (files.length) editor.insertImages(node, files, at); });
    case 'video':
      return editor.replaceText(node, ta, at, at, '{{video }}', 8);
    case 'numbered': return editor.toggleNumbered(node);
    case 'h1': case 'h2': case 'h3': return editor.setHeading(node, Number(cmd[1]));
    case 'quote': {
      const { start } = lineAt(ta.value, at);
      return editor.replaceText(node, ta, start, start, '> ', ta.selectionStart - start + 2);
    }
    case 'image':
      return pickImages().then((files) => { if (files.length) editor.insertImages(node, files, at); });
    case 'today': return editor.replaceText(node, ta, at, at, day(0));
    case 'time': return editor.replaceText(node, ta, at, at, timeNow());
    case 'timestamp': return editor.replaceText(node, ta, at, at, timestamp());
    case 'math': {
      // Inside an existing formula: edit it; otherwise build a new one here.
      const span = mathSpans(ta.value).find((m) => m.start < at && at < m.end);
      return editor.openMath(node, span || null, span ? null : at);
    }
    case 'tomorrow': return editor.replaceText(node, ta, at, at, day(1));
    case 'yesterday': return editor.replaceText(node, ta, at, at, day(-1));
    default:
      if (cmd.startsWith('status:')) return editor.setMarker(node, cmd.slice(7));
  }
}

// ---- autocomplete for [[pages]], ((blocks)) and /commands -------------------

let ac = null;

function closeAutocomplete() {
  ac?.el.remove();
  ac = null;
}

async function updateAutocomplete(editor, node, ta) {
  const before = ta.value.slice(0, ta.selectionStart);
  const page = /\[\[([^[\]\n]*)$/.exec(before);
  const block = !page && /\(\(([^()\n]*)$/.exec(before);
  const slash = !page && !block && !inFence(ta.value, ta.selectionStart) && /(?:^|\s)\/([\w-]*)$/.exec(before);
  const tag = !page && !block && !slash && !inFence(ta.value, ta.selectionStart)
    && /(?:^|\s)#([^\s#,.!?;:()[\]"'`+][^\s#,.!?;:()[\]"'`]*|)$/.exec(before);
  if (!page && !block && !slash && !tag) return closeAutocomplete();
  const query = (page || block || slash || tag)[1];
  const kind = page ? 'page' : block ? 'block' : slash ? 'slash' : 'tag';
  const seq = (ac?.seq || 0) + 1;

  let items = [];
  if (kind === 'slash') {
    items = slashMatches(query).map((c) => ({
      label: `${esc(c.label)}${c.hint ? `<span class="cmd-hint">${esc(c.hint)}</span>` : ''}`,
      value: c.id,
    }));
    if (!items.length) return closeAutocomplete(); // e.g. typing a path like /etc
  }
  if (!ac || ac.ta !== ta) {
    closeAutocomplete();
    const box = el('div', 'popup autocomplete');
    document.body.append(box);
    ac = { el: box, ta, editor, node, items: [], index: 0 };
  }
  ac.seq = seq;
  ac.kind = kind;
  ac.query = query;

  if (kind === 'page') {
    const q = query.toLowerCase();
    const names = await getPageNames();
    items = names
      .filter((n) => n.toLowerCase().includes(q))
      .sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)) || a.length - b.length)
      .slice(0, 8)
      .map((n) => ({ label: esc(n), value: n }));
    if (q && !names.some((n) => n.toLowerCase() === q)) items.push({ label: `New page: <b>${esc(query)}</b>`, value: query });
  } else if (kind === 'tag') {
    // Like Logseq: "New tag …" first, then existing pages that match.
    const q = query.toLowerCase();
    const names = await getPageNames();
    const mark = (n) => {
      const i = n.toLowerCase().indexOf(q);
      return q && i >= 0 ? `${esc(n.slice(0, i))}<mark>${esc(n.slice(i, i + q.length))}</mark>${esc(n.slice(i + q.length))}` : esc(n);
    };
    const found = names
      .filter((n) => !/^[A-Z][a-z]{2} \d{1,2}(st|nd|rd|th), \d{4}$/.test(n) && n.toLowerCase().includes(q))
      .sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)) || a.length - b.length)
      .slice(0, 7)
      .map((n) => ({ label: mark(n), value: n }));
    items = q && !names.some((n) => n.toLowerCase() === q) ? [{ label: `New tag <b>${esc(query)}</b>`, value: query }, ...found] : found;
    if (!q && !items.length) return closeAutocomplete();
  } else if (kind === 'block' && query.trim().length >= 2) {
    try {
      const res = await api.search(query, 8);
      items = res.blocks.filter((b) => b.id !== node.id).map((b) => ({
        label: `${esc(b.content.slice(0, 90))}<small>${esc(b.page_name)}</small>`,
        value: b.id,
      }));
    } catch { items = []; }
  }
  if (!ac || ac.seq !== seq) return;
  if (!items.length) {
    ac.el.innerHTML = `<div class="hint">${kind === 'page' ? 'Type a page name' : 'Type to search blocks'}</div>`;
    ac.items = [];
  } else {
    ac.items = items;
    ac.index = 0;
    ac.el.replaceChildren(...items.map((it, i) => {
      const row = el('div', 'item');
      row.innerHTML = it.label;
      row.addEventListener('mousedown', (e) => { e.preventDefault(); ac.index = i; acceptAutocomplete(e.ctrlKey || e.metaKey); });
      return row;
    }));
    if (kind === 'tag') {
      const foot = el('div', 'hint ac-foot');
      foot.innerHTML = '<kbd>Ctrl</kbd> <kbd>⏎</kbd> to put the tag here instead of at the end of the line';
      ac.el.append(foot);
    }
    highlight();
  }
  const r = ta.getBoundingClientRect();
  ac.el.style.left = `${r.left + window.scrollX}px`;
  ac.el.style.top = `${r.bottom + window.scrollY + 4}px`;
}

function highlight() {
  [...ac.el.querySelectorAll('.item')].forEach((c, i) => c.classList.toggle('active', i === ac.index));
}

function handleAutocompleteKey(e) {
  if (!ac) return false;
  if (e.key === 'Escape') { e.preventDefault(); closeAutocomplete(); return true; }
  if (!ac.items.length) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    ac.index = (ac.index + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length;
    highlight();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    acceptAutocomplete(e.ctrlKey || e.metaKey);
    return true;
  }
  return false;
}

function acceptAutocomplete(inline = false) {
  const { ta, editor, node, kind, query } = ac;
  const item = ac.items[ac.index];
  if (!item) return;
  const pos = ta.selectionStart;
  closeAutocomplete();
  if (kind === 'tag') {
    editor.beginOp();
    const name = item.value;
    const token = /^[^\s#,.!?;:()[\]"'`+][^\s#,.!?;:()[\]"'`]*$/.test(name) ? `#${name}` : `#[[${name}]]`;
    const at = pos - query.length - 1; // where "#query" starts
    const v = ta.value;
    const firstEnd = v.indexOf('\n') === -1 ? v.length : v.indexOf('\n');
    // Default: the tag goes to the end of the first line (shown on the right).
    if (inline || v.startsWith('```') || at > firstEnd) {
      const space = /^\s/.test(v.slice(pos)) ? '' : ' ';
      editor.replaceText(node, ta, at, pos, token + space, token.length + space.length);
      return;
    }
    const lead = at > 0 && v[at - 1] === ' ' ? 1 : 0;
    let first = v.slice(0, at - lead) + v.slice(pos, firstEnd);
    const has = new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'i').test(first);
    if (!has) first = first.trimEnd() + (first.trim() ? ' ' : '') + token;
    ta.value = first + v.slice(firstEnd);
    const caret = at - lead;
    ta.setSelectionRange(caret, caret);
    editor.setContent(node, ta.value);
    autosize(ta);
    return;
  }
  if (kind === 'slash') {
    editor.beginOp();
    const at = pos - query.length - 1; // remove "/query"
    editor.replaceText(node, ta, at, pos, '');
    runSlash(editor, node, ta, item.value, at);
    return;
  }
  const close = kind === 'page' ? ']]' : '))';
  const start = pos - query.length;
  const rest = ta.value.slice(pos).startsWith(close) ? ta.value.slice(pos + 2) : ta.value.slice(pos);
  const insert = item.value + close;
  ta.value = ta.value.slice(0, start) + insert + rest;
  const caret = start + insert.length;
  ta.setSelectionRange(caret, caret);
  editor.setContent(node, ta.value);
  autosize(ta);
}

// ---- small popup menu --------------------------------------------------------

// entries: [label, fn, cls] arrays, {label, fn, shortcut, danger} objects,
// {element} for custom rows, or '-' for a separator.
// A small menu of coloured status badges; onPick(word or null).
export function showStatusPicker(x, y, current, onPick) {
  const entries = getStatuses().map((st) => {
    const item = el('div', 'item status-item');
    const b = el('span', 'status-badge', st.label);
    b.setAttribute('style', statusStyle(st));
    item.append(b);
    if (st.word === current) item.append(el('span', 'check', '✓'));
    item.addEventListener('click', () => { closeMenu(); onPick(st.word); });
    return { element: item };
  });
  const none = el('div', 'item');
  none.append(el('span', 'muted', 'No status'));
  none.addEventListener('click', () => { closeMenu(); onPick(null); });
  showMenu(x, y, [...entries, '-', { element: none }]);
}

export function showMenu(x, y, entries) {
  closeMenu();
  const menu = el('div', 'popup menu');
  for (const entry of entries) {
    if (entry === '-') { menu.append(el('div', 'menu-sep')); continue; }
    if (entry.element) { menu.append(entry.element); continue; }
    const [label, fn, cls] = Array.isArray(entry) ? entry : [entry.label, entry.fn, entry.danger ? 'danger' : ''];
    const item = el('div', 'item' + (cls ? ` ${cls}` : ''));
    item.append(el('span', '', label));
    if (entry.shortcut) item.append(el('kbd', '', entry.shortcut));
    item.addEventListener('click', () => { closeMenu(); fn(); });
    menu.append(item);
  }
  menu.style.position = 'fixed';
  document.body.append(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  menu.style.top = `${y + h + 14 > window.innerHeight ? Math.max(8, y - h - 6) : y + 6}px`;
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside);
    window.addEventListener('scroll', closeMenu, { once: true, capture: true });
  }, 0);
}

function onOutside(e) {
  if (!e.target.closest('.menu')) closeMenu();
}

export function closeMenu() {
  document.querySelector('.menu')?.remove();
  document.removeEventListener('mousedown', onOutside);
}
