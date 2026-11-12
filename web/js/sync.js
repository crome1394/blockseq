// Saving and sync for PageEditor: autosave with a version check, conflicts
// with another device (Keep mine / Use theirs), local drafts, and the last
// save when a tab closes. The methods are installed on PageEditor.prototype
// (installSync), so `this` is the editor. Retry policy: only a lost
// connection and a 503 retry on their own; any other refusal waits for the
// next edit.

import { el } from './dom.js';
import { api, clientId, explain, uuid, invalidatePageNames } from './api.js';
import { ENCRYPTED_TAG } from './crypto.js';
import { dropDraft, keepaliveFits, openTabs, removeDraft, saveDraft } from './drafts.js';
import { toast, updateStatus, openModal, noteSaved } from './ui.js';

// Open editors, including disposed ones that are still finishing a save.
export const editors = new Set();

export const SAVE_DELAY = 600;

class SyncMethods {
  // Shows the newest copy that never reached the server, however recent,
  // unless the tab that kept it is still open and may be sending it now.
  async offerDraft(pending) {
    const token = {};
    this.draftToken = token;
    const live = await openTabs();
    if (this.draftToken !== token || this.disposed || this.draft) return;
    const sendingHere = [...editors].some((ed) => ed !== this && ed.name === this.name && (ed.dirty || ed.saving));
    const draft = pending.find((d) => (d.owner === clientId ? !sendingHere : !live.has(d.owner)));
    if (!draft) return;
    this.draft = draft;
    const caret = this.ta?.selectionStart;
    const editing = this.editing;
    this.render();
    if (editing) this.edit(editing, caret);
  }

  renderDraft() {
    const bar = el('div', 'conflict draft-bar');
    const when = new Date(this.draft.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
    const newer = this.draft.baseVersion !== this.version;
    bar.append(el('span', '', `This browser has changes to this page from ${when} that never reached the server${newer ? ' (the page has changed since)' : ''}.`));
    const view = el('button', '', 'Discard them');
    view.addEventListener('click', () => {
      removeDraft(this.draft.key);
      this.draft = null;
      this.render();
    });
    const restore = el('button', 'primary', 'Restore them');
    restore.title = 'Replaces this page with the unsaved version';
    restore.addEventListener('click', () => {
      const blocks = this.draft.blocks;
      // From here this tab's own copy holds them, until the server has them.
      removeDraft(this.draft.key);
      this.draft = null;
      this.beginOp();
      this.setBlocks(blocks);
      this.render();
      this.openSecrets();
      this.markDirty();
      toast('Unsaved changes restored');
    });
    bar.append(view, restore);
    return bar;
  }

  renderConflict() {
    const bar = el('div', 'conflict');
    const gone = this.conflict.deleted;
    bar.append(el('span', '', gone
      ? 'This page was deleted on another device while you were editing it.'
      : 'This page was changed on another device while you were editing it.'));
    const diff = el('button', '', 'Show differences');
    diff.addEventListener('click', () => this.showConflictDiff());
    const theirs = el('button', '', gone ? 'Leave it deleted' : 'Use their version');
    theirs.addEventListener('click', () => this.useTheirs());
    const mine = el('button', 'primary', 'Keep mine');
    mine.addEventListener('click', () => this.keepMine());
    bar.append(diff, theirs, mine);
    return bar;
  }

  useTheirs() {
    if (!this.conflict) return;
    this.conflict = null;
    this.dirty = false;
    dropDraft(this.name); // their version was chosen: the local copy goes too
    this.load(this.conflictData);
    updateStatus();
  }

  keepMine() {
    if (!this.conflict) return;
    this.version = this.conflict.version;
    this.conflict = null;
    this.overwriteNext = true; // the server keeps their version in the history
    this.render();
    this.save();
  }

  // Their version (on the server) next to mine, line by line.
  showConflictDiff() {
    if (!this.conflict) return;
    const theirs = outlineLines(this.conflictData.blocks || []);
    const mine = outlineLines(this.flatten({ forSave: true }));
    const body = el('div', 'diff-view');
    const legend = el('p', 'muted small');
    legend.innerHTML = '<span class="diff-del">− only in their version (on the server)</span> · <span class="diff-add">+ only in yours</span>';
    const out = el('div', 'diff-lines');
    const ops = diffLines(theirs, mine);
    if (!ops) {
      out.append(el('p', 'muted', 'The pages are too long to compare line by line here. Open the page history after choosing, to see both versions.'));
    } else if (!ops.some((o) => o.kind !== 'same')) {
      out.append(el('p', 'muted', 'No differences in the text (only the order of saving differs). Either choice keeps the same text.'));
    } else {
      // Long runs of unchanged lines are folded to a few lines of context.
      const CONTEXT = 2;
      ops.forEach((o, i) => {
        if (o.kind === 'same') {
          const near = ops.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.kind !== 'same');
          if (!near) {
            if (out.lastChild?.classList?.contains('diff-fold')) out.lastChild.dataset.n = String(Number(out.lastChild.dataset.n) + 1);
            else { const f = el('div', 'diff-fold'); f.dataset.n = '1'; out.append(f); }
            return;
          }
        }
        const line = el('div', `diff-line diff-${o.kind}`);
        line.append(el('span', 'diff-sign', o.kind === 'del' ? '−' : o.kind === 'add' ? '+' : ' '), el('span', 'diff-text', o.text || ' '));
        out.append(line);
      });
      out.querySelectorAll('.diff-fold').forEach((f) => { f.textContent = `… ${f.dataset.n} unchanged line${f.dataset.n === '1' ? '' : 's'}`; });
    }
    body.append(legend, out);
    const box = openModal(`Differences: ${this.name}`, body, [
      ['Close'],
      ['Use their version', () => this.useTheirs()],
      ['Keep mine', () => this.keepMine(), 'primary'],
    ]);
    box.classList.add('modal-wide');
  }

  markDirty() {
    this.dirty = true;
    this.changeSeq++;
    updateStatus();
    if (this.conflict) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY);
  }

  // What to store before sealing finishes. Children of a #Encrypted block are
  // left out, so their plaintext never sits in localStorage.
  blocksForDraft() {
    const hidden = new Set();
    const mark = (n) => n.children.forEach((c) => { hidden.add(c.id); mark(c); });
    const walk = (n) => n.children.forEach((c) => {
      if (ENCRYPTED_TAG.test(c.content)) mark(c);
      walk(c);
    });
    walk(this.root);
    return this.flatten({ forSave: true }).filter((b) => !hidden.has(b.id));
  }

  // After sealing, replace the draft with the ciphertext the server would store.
  async rememberDraft() {
    try { await this.sealSecrets(); } catch { /* the copy already stored stays */ }
    const sending = this.flatten({ forSave: true });
    saveDraft(this.name, this.version, sending);
    return sending;
  }

  // One last save as the page goes away, when the body is small enough for
  // the browser to actually send it.
  sendKeepalive(blocks) {
    const extra = this.overwriteNext ? { overwrite: true } : {};
    if (!keepaliveFits(this.version, blocks, extra)) return;
    api.savePage(this.name, this.version, blocks, { keepalive: true }, extra).catch(() => {});
  }

  async save(opts) {
    const unloading = !!opts?.keepalive;
    // localStorage is synchronous. Write before any await, so a closing tab
    // keeps the latest text even when a save is already running.
    if (unloading && this.dirty) saveDraft(this.name, this.version, this.blocksForDraft());
    if (this.conflict || !this.dirty) {
      if (unloading && this.dirty) await this.rememberDraft();
      return;
    }
    if (this.saving) {
      if (unloading) {
        // The request already running is cancelled with the page. Keep the
        // keystrokes typed since it started, and send them when they fit.
        const sending = await this.rememberDraft();
        this.sendKeepalive(sending);
      } else {
        this.saveAgain = true;
      }
      return;
    }
    clearTimeout(this.saveTimer);
    this.saving = true;
    updateStatus();
    const seq = this.changeSeq;
    const wasNew = this.version === 0;
    // null: leave the edit dirty and wait for the next keystroke.
    // A number: try again after that many milliseconds. Only a lost
    // connection and a 503 (storage) keep retrying on their own.
    let schedule = null;
    try {
      await this.sealSecrets();
      const sending = this.flatten({ forSave: true });
      saveDraft(this.name, this.version, sending);
      const extra = this.overwriteNext ? { overwrite: true } : {};
      if (unloading && !keepaliveFits(this.version, sending, extra)) {
        // The draft holds it. A normal save runs if the user stays on the page.
        schedule = 0;
        return;
      }
      const r = await api.savePage(this.name, this.version, sending, opts, extra);
      if (r.status === 200) {
        this.idWaits = 0;
        if (extra.overwrite) this.overwriteNext = false;
        this.version = r.data.page.version;
        this.offline = false;
        if (this.changeSeq === seq) {
          this.dirty = false;
          dropDraft(this.name);
        } else {
          schedule = SAVE_DELAY;
        }
        if (wasNew) invalidatePageNames();
        noteSaved(r.data.page.updated_at || Date.now());
        this.opts.onSaved?.(this);
      } else if (r.status === 409 && r.data?.foreign_ids) {
        // Pasted blocks reuse ids that belong to another page. A cut and
        // paste in this tab may simply not have saved the old page yet:
        // wait for it a few times. Otherwise they are copies: new ids.
        this.offline = false;
        const busy = [...editors].some((ed) => ed !== this && !ed.disposed && (ed.dirty || ed.saving));
        this.idWaits = (this.idWaits || 0) + 1;
        if (!busy || this.idWaits > 3) {
          this.renewIds(r.data.foreign_ids);
          this.idWaits = 0;
          schedule = 0;
        } else {
          schedule = SAVE_DELAY;
        }
      } else if (r.status === 409 && r.data?.deleted) {
        // The page was deleted or renamed. Version 0 lets Keep mine create it
        // again; Leave it deleted discards this edit.
        this.offline = false;
        this.conflict = { name: this.name, version: 0, deleted: true };
        this.conflictData = { name: this.name, page: null, blocks: [] };
        const caret = this.ta?.selectionStart;
        const editing = this.editing;
        this.render();
        if (editing) this.edit(editing, caret);
      } else if (r.status === 409 && r.data?.page) {
        // Another device saved this page. Show both versions; do not retry.
        this.offline = false;
        this.conflict = r.data.page;
        this.conflictData = { name: r.data.page.name, page: r.data.page, blocks: r.data.blocks };
        const caret = this.ta?.selectionStart;
        const editing = this.editing;
        this.render();
        if (editing) this.edit(editing, caret);
      } else if (r.status === 503) {
        this.offline = true;
        toast(`Save failed: ${explain(r.data, 'The server could not store that just now')}`);
        schedule = 4000;
      } else {
        this.offline = false;
        toast(`Save failed: ${explain(r.data, 'Could not save')}`);
        if (this.changeSeq !== seq) schedule = SAVE_DELAY;
      }
    } catch {
      this.offline = true;
      schedule = 4000;
    } finally {
      this.saving = false;
      // A save() that arrived while this one was running wants the new text
      // sent now, unless the connection itself is the problem.
      if (this.saveAgain && this.dirty && !this.conflict && !this.offline) schedule = 0;
      if (schedule !== null && this.dirty && !this.conflict) {
        this.saveTimer = setTimeout(() => this.save(), schedule);
      }
      this.saveAgain = false;
      if (!this.dirty && this.disposed) editors.delete(this);
      updateStatus();
    }
  }

  // Gives blocks new ids (they turned out to belong to another page).
  renewIds(ids) {
    const renew = new Set(ids);
    const walk = (n) => n.children.forEach((c) => {
      if (renew.has(c.id)) {
        c.id = uuid();
        if (c.el) c.el.dataset.id = c.id;
      }
      walk(c);
    });
    walk(this.root);
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
}

// Adds the methods above to the editor class.
export function installSync(cls) {
  for (const name of Object.getOwnPropertyNames(SyncMethods.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(cls.prototype, name, Object.getOwnPropertyDescriptor(SyncMethods.prototype, name));
  }
}

// opts.ids adds id:: lines (so a cut block keeps its refs when pasted);
// opts.plain gives indented text without bullets or properties.
// Blocks (with parent ids) as indented outline lines for comparing two
// versions. Encrypted contents are shown as 🔒, not as scrambled text.
function outlineLines(blocks) {
  const depth = new Map();
  const lines = [];
  for (const b of blocks) {
    const d = b.parent_id && depth.has(b.parent_id) ? depth.get(b.parent_id) + 1 : 0;
    depth.set(b.id, d);
    const ind = '    '.repeat(d);
    b.content.replace(/^encrypted:: v1:\S+$/gm, 'encrypted:: 🔒 (encrypted contents)').split('\n').forEach((l, i) => {
      lines.push(i === 0 ? `${ind}• ${l}` : `${ind}  ${l}`);
    });
  }
  return lines;
}

// Line diff (longest common subsequence): [{kind: 'same'|'del'|'add', text}],
// del = only in `a`, add = only in `b`. null if too big to compare here.
function diffLines(a, b) {
  if (a.length * b.length > 4_000_000) return null;
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ kind: 'del', text: a[i++] });
    else ops.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++] });
  while (j < m) ops.push({ kind: 'add', text: b[j++] });
  return ops;
}
