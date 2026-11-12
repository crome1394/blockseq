// The maths builder: write LaTeX with a palette, see it drawn as you type,
// and learn what each piece does. Pointing at part of the drawn formula
// highlights the code that made it (and the reverse), mistakes are explained
// with a one-click fix, and nothing is hidden: every palette button shows
// the LaTeX it inserts. Uses math.js (analyzeTex) and mathhelp.js.

import { el } from './dom.js';
import { analyzeTex, texToMathML } from './math.js';
import { explain, kindTitle, PALETTE, EXAMPLES } from './mathhelp.js';
import { openModal, closeModal } from './ui.js';

const escHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Opens the builder. `tex` and `display` start it off; onInsert(tex, display)
// gets the result. `editing` labels the button "Update" instead of "Insert".
export function openMathBuilder({ tex = '', display = true, editing = false, onInsert }) {
  const root = el('div', 'mb');

  // ---- palette ----
  const palette = el('div', 'mb-palette');
  const tabs = el('div', 'mb-tabs');
  const items = el('div', 'mb-items');
  palette.append(tabs, items);
  const showTab = (i) => {
    tabs.querySelectorAll('button').forEach((b, j) => b.classList.toggle('active', i === j));
    items.replaceChildren(...PALETTE[i][1].map(([preview, insert, tip]) => {
      const b = el('button', 'mb-item');
      b.type = 'button';
      b.title = tip;
      b.innerHTML = texToMathML(preview, false);
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the code's selection
      b.addEventListener('click', () => insertTemplate(insert, tip));
      return b;
    }));
  };
  PALETTE.forEach(([name], i) => {
    const t = el('button', '', name);
    t.type = 'button';
    t.addEventListener('click', () => showTab(i));
    tabs.append(t);
  });

  // ---- code side ----
  const left = el('div', 'mb-left');
  const bar = el('div', 'mb-bar');
  const mode = el('div', 'seg mb-mode');
  const modeBtn = (label, value, title) => {
    const b = el('button', 'seg-btn', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', () => { display = value; updateMode(); update(); });
    mode.append(b);
    return b;
  };
  const centred = modeBtn('Centred', true, 'On its own line, full size ($$ … $$)');
  const inline = modeBtn('In a sentence', false, 'Inside a line of text ($ … $)');
  const updateMode = () => {
    centred.classList.toggle('active', display);
    inline.classList.toggle('active', !display);
  };
  const examples = el('select', 'mb-examples');
  examples.append(new Option('Start from an example…', ''));
  EXAMPLES.forEach(([name, ex]) => examples.append(new Option(name, ex)));
  examples.addEventListener('change', () => {
    if (!examples.value) return;
    replaceRange(0, ta.value.length, examples.value, examples.value.length);
    examples.value = '';
  });
  bar.append(mode, examples);

  const inputWrap = el('div', 'mb-input');
  const backdrop = el('pre', 'mb-backdrop');
  const ta = el('textarea', 'mb-code');
  ta.spellcheck = false;
  ta.autocapitalize = 'off';
  ta.placeholder = 'Type LaTeX here, or click a button above. Try: x^2 + \\frac{1}{2}';
  ta.value = tex;
  inputWrap.append(backdrop, ta);
  const hint = el('p', 'muted small mb-hint', 'Tab jumps to the next empty {} slot. Ctrl+Enter inserts.');
  const problemsBox = el('div', 'mb-problems');
  left.append(bar, inputWrap, hint, problemsBox);

  // ---- preview side ----
  const right = el('div', 'mb-right');
  const preview = el('div', 'mb-preview');
  const explainBox = el('div', 'mb-explain');
  const usedBox = el('div', 'mb-used');
  right.append(preview, explainBox, usedBox);

  const main = el('div', 'mb-main');
  main.append(left, right);
  root.append(palette, main);

  const box = openModal('Maths builder', root, [
    ['Cancel'],
    [editing ? 'Update' : 'Insert', () => done(), 'primary'],
  ]);
  box.classList.add('modal-wide', 'mb-modal', 'no-overlay-close');

  let analysis = { problems: [], used: [] };
  let highlight = null; // [start, end] of the code being pointed at
  let hovering = false;

  function done() {
    const value = ta.value.trim();
    if (!value) return true; // nothing to insert: just close
    onInsert(value, display);
    return true;
  }

  // Replaces part of the code, keeping the browser's undo history.
  function replaceRange(start, end, text, caret) {
    ta.focus();
    ta.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, start, end, 'end');
    if (caret !== undefined) ta.setSelectionRange(caret, caret);
    update();
  }

  // Inserts a palette template. Selected code goes into the first slot, so
  // selecting "a+b" and clicking the fraction gives \frac{a+b}{}.
  function insertTemplate(template, tip) {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const selected = value.slice(a, b);
    let text = template;
    const slot = text.indexOf('{}');
    if (selected && slot !== -1) text = `${text.slice(0, slot + 1)}${selected}${text.slice(slot + 1)}`;
    const next = text.indexOf('{}');
    replaceRange(a, b, text, next === -1 ? a + text.length : a + next + 1);
    showExplain(tip.split(':')[0], template.trim(), tip);
  }

  // Tab / Shift+Tab: next / previous empty slot.
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const v = ta.value;
      let at = -1;
      if (e.shiftKey) {
        for (let i = ta.selectionStart - 2; i >= 0; i--) if ((v[i] === '{' && v[i + 1] === '}') || (v[i] === '[' && v[i + 1] === ']')) { at = i; break; }
      } else {
        const m = /\{\}|\[\]/.exec(v.slice(ta.selectionEnd));
        if (m) at = ta.selectionEnd + m.index;
      }
      if (at !== -1) {
        e.preventDefault();
        ta.setSelectionRange(at + 1, at + 1);
        followCaret();
      }
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (done()) closeModal();
    }
  });
  ta.addEventListener('input', update);
  for (const ev of ['keyup', 'click', 'select']) ta.addEventListener(ev, () => { if (!hovering) followCaret(); });
  ta.addEventListener('scroll', () => { backdrop.scrollTop = ta.scrollTop; });

  // ---- drawing ----

  function update() {
    const src = ta.value;
    analysis = analyzeTex(src, display);
    preview.classList.toggle('inline-mode', !display);
    if (src.trim()) preview.innerHTML = analysis.html;
    else preview.replaceChildren(el('p', 'muted', 'Your formula appears here as you type.'));
    drawProblems();
    drawUsed();
    followCaret();
  }

  // The code with the pointed-at part highlighted and problems underlined.
  function drawBackdrop() {
    const src = ta.value;
    const marks = analysis.problems.filter((p) => p.end > p.start).map((p) => [p.start, p.end, p.level === 'error' ? 'mb-err' : 'mb-tip']);
    if (highlight) marks.push([highlight[0], highlight[1], 'mb-hl']);
    const cuts = new Set([0, src.length]);
    marks.forEach(([a, b]) => { cuts.add(Math.max(0, a)); cuts.add(Math.min(src.length, b)); });
    const points = [...cuts].sort((x, y) => x - y);
    let html = '';
    for (let i = 0; i < points.length - 1; i++) {
      const [a, b] = [points[i], points[i + 1]];
      const cls = marks.filter(([s, e]) => s <= a && e >= b).map((m) => m[2]);
      const text = escHtml(src.slice(a, b));
      html += cls.length ? `<span class="${[...new Set(cls)].join(' ')}">${text}</span>` : text;
    }
    backdrop.innerHTML = `${html}\n`;
    backdrop.scrollTop = ta.scrollTop;
  }

  const pieces = () => [...preview.querySelectorAll('[data-s]')].map((node) => {
    const [s, e] = node.getAttribute('data-s').split('-').map(Number);
    return { node, s, e, kind: node.getAttribute('data-k') };
  });

  function point(piece) {
    preview.querySelectorAll('.mb-hl').forEach((n) => n.classList.remove('mb-hl'));
    if (!piece) {
      highlight = null;
      drawBackdrop();
      return;
    }
    piece.node.classList.add('mb-hl');
    highlight = [piece.s, piece.e];
    drawBackdrop();
    const code = ta.value.slice(piece.s, piece.e);
    const { title, text } = explain(piece.kind, code);
    showExplain(title, code, text);
  }

  // The smallest drawn piece whose code contains the caret.
  function followCaret() {
    const pos = ta.selectionStart;
    let best = null;
    for (const p of pieces()) {
      if (p.s <= pos && pos <= p.e && (!best || p.e - p.s <= best.e - best.s)) best = p;
    }
    if (best) point(best);
    else {
      point(null);
      if (!ta.value.trim()) showExplain('How it works', '', 'Click a button to insert a piece, or type LaTeX. Point at any part of the drawn formula to see the code behind it and what it does.');
    }
  }

  preview.addEventListener('mousemove', (e) => {
    const target = e.target.closest?.('[data-s]');
    if (!target) return;
    hovering = true;
    const p = pieces().find((x) => x.node === target);
    if (p) point(p);
  });
  preview.addEventListener('mouseleave', () => { hovering = false; followCaret(); });
  // Clicking a piece selects its code.
  preview.addEventListener('click', (e) => {
    const target = e.target.closest?.('[data-s]');
    if (!target) return;
    const [s, end] = target.getAttribute('data-s').split('-').map(Number);
    ta.focus();
    ta.setSelectionRange(s, end);
  });

  function showExplain(title, code, text) {
    explainBox.replaceChildren();
    const head = el('div', 'mb-explain-head');
    head.append(el('strong', '', title));
    if (code) head.append(el('code', '', code.length > 60 ? `${code.slice(0, 57)}…` : code));
    explainBox.append(head, el('p', '', text));
  }

  function drawProblems() {
    problemsBox.replaceChildren();
    for (const p of analysis.problems) {
      const row = el('div', `mb-problem ${p.level}`);
      row.append(el('span', 'mb-badge', p.level === 'error' ? 'Problem' : 'Tip'));
      const msg = el('span', 'mb-msg', p.message);
      msg.title = 'Show in the code';
      msg.addEventListener('click', () => { ta.focus(); ta.setSelectionRange(p.start, Math.max(p.start, p.end)); });
      row.append(msg);
      if (p.fix) {
        const fix = el('button', 'mb-fix', p.fix.text ? `Fix: ${p.fix.text.trim() || 'add'}` : 'Fix: remove');
        fix.type = 'button';
        fix.addEventListener('click', () => replaceRange(p.fix.start, p.fix.end, p.fix.text, p.fix.start + p.fix.text.length));
        row.append(fix);
      }
      problemsBox.append(row);
    }
  }

  // "In this formula": one chip per kind of construct, most useful first.
  function drawUsed() {
    usedBox.replaceChildren();
    const skip = new Set(['variable', 'number', 'operator', 'group', 'size']);
    const used = analysis.used.filter((u) => !skip.has(u.kind));
    if (!used.length) return;
    usedBox.append(el('div', 'mb-used-title', 'In this formula'));
    const chips = el('div', 'mb-chips');
    for (const u of used) {
      const c = el('button', 'mb-chip', kindTitle(u.kind));
      c.type = 'button';
      c.addEventListener('click', () => {
        const { title, text } = explain(u.kind, u.code);
        showExplain(title, u.code, text);
      });
      chips.append(c);
    }
    usedBox.append(chips);
  }

  showTab(0);
  updateMode();
  update();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  followCaret();
}
