// Editing a fenced code block in place with the code editor (code.js).

import { CodeEditor } from './code.js';
import { lineAt, noteActive } from './editor.js';
import { findFences } from './render.js';
import { getSetting } from './settings.js';

class CodeBlocksMethods {
  // Opens the code editor on the idx-th code fence of a block.
  openCodeEditor(node, idx, caret = 0) {
    if (this.editing) this.stopEdit();
    this.closeCodeEditor();
    if (!node.contentEl) return;
    const f = findFences(node.content)[idx];
    const pre = node.contentEl.querySelector(`pre.code[data-fence="${idx}"]`);
    if (!f || !pre) return;
    noteActive(this);
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
}

// Adds the methods above to the editor class.
export function installCodeBlocks(cls) {
  for (const name of Object.getOwnPropertyNames(CodeBlocksMethods.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(cls.prototype, name, Object.getOwnPropertyDescriptor(CodeBlocksMethods.prototype, name));
  }
}
