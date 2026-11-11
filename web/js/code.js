// Code blocks: a small built-in syntax highlighter, line numbers, a copy
// button, and the highlighted backdrop used while editing (live mode).
//
// The highlighter is deliberately simple: each language is an ordered list of
// [class, sticky regex] rules tried at every position. It colours code well
// enough for notes without shipping a third-party library.

import { esc } from './render.js';
import { copyText } from './ui.js';

const STR_D = /"(?:\\.|[^"\\\n])*"?/y;
const STR_S = /'(?:\\.|[^'\\\n])*'?/y;
const STR_B = /`(?:\\.|[^`\\])*`?/y;
const NUM = /\b(?:0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y;
const WORD = /[A-Za-z_$][\w$]*/y; // plain words, so keywords never match mid-word
const C_LINE = /\/\/.*/y;
const C_BLOCK = /\/\*[\s\S]*?(?:\*\/|$)/y;
const HASH_LINE = /(?<=^|\s)#.*/my;

const kw = (words, flags = '') => new RegExp(`\\b(?:${words.split(' ').join('|')})\\b`, `y${flags}`);

const C_LIKE_TYPES = /\b[A-Z][A-Za-z0-9_]*\b/y;
const CALL = /[A-Za-z_]\w*(?=\s*\()/y;

const LANGS = {
  bash: {
    aliases: ['sh', 'shell', 'zsh', 'console', 'fish', 'shellsession', 'terminal'],
    rules: [
      ['comment', HASH_LINE],
      ['string', STR_D],
      ['string', STR_S],
      ['var', /\$\{[^}\n]*\}|\$\(|\$[\w@#?$!*-]/y],
      ['keyword', kw('if then else elif fi for while until do done case esac in function select return exit local export readonly declare unset shift break continue source alias')],
      ['cmd', /(?<=(?:^|[|;&(`]|\$\(|\b(?:sudo|then|do|else|time|exec|xargs|env))[ \t]*)[A-Za-z_.~/][\w.+/~-]*/my],
      ['attr', /(?<=^[ \t]*)[A-Za-z_][\w.-]*(?==)/my],
      ['flag', /(?<=\s)--?[A-Za-z0-9][\w-]*/y],
      ['number', NUM],
      ['punct', /\\$|&&|\|\||[|;&<>]/my],
      [null, WORD],
    ],
  },
  ini: {
    aliases: ['conf', 'config', 'cfg', 'toml', 'properties', 'env', 'dotenv', 'desktop', 'systemd', 'service'],
    rules: [
      ['comment', /(?<=^\s*)[#;].*/my],
      ['meta', /(?<=^\s*)\[[^\]\n]*\]/my],
      ['attr', /(?<=^\s*)[\w.$-]+(?=\s*[=:])/my],
      ['string', STR_D],
      ['string', STR_S],
      ['literal', kw('true false yes no on off null none')],
      ['number', NUM],
      [null, WORD],
    ],
  },
  yaml: {
    aliases: ['yml'],
    rules: [
      ['comment', HASH_LINE],
      ['attr', /(?<=^[ \t-]*)[\w.$/-]+(?=\s*:(?:\s|$))/my],
      ['string', STR_D],
      ['string', STR_S],
      ['meta', /^---$|[&*][\w-]+|![\w!]+/my],
      ['literal', kw('true false yes no on off null')],
      ['number', NUM],
      [null, WORD],
    ],
  },
  json: {
    aliases: ['jsonc', 'json5'],
    rules: [
      ['comment', C_LINE],
      ['attr', /"(?:\\.|[^"\\\n])*"(?=\s*:)/y],
      ['string', STR_D],
      ['literal', kw('true false null')],
      ['number', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
      [null, WORD],
    ],
  },
  python: {
    aliases: ['py', 'python3'],
    rules: [
      ['comment', /#.*/y],
      ['string', /[rbfuRBFU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y],
      ['string', /[rbfuRBFU]{0,2}(?:"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/y],
      ['meta', /@[\w.]+/y],
      ['keyword', kw('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case')],
      ['literal', kw('True False None self cls')],
      ['builtin', kw('print len range open str int float list dict set tuple bool type isinstance enumerate zip map filter sorted sum min max abs any all input super object Exception')],
      ['title', /(?<=\b(?:def|class)\s+)[A-Za-z_]\w*/y],
      ['number', NUM],
      [null, WORD],
    ],
  },
  javascript: {
    aliases: ['js', 'jsx', 'ts', 'tsx', 'typescript', 'mjs', 'cjs', 'node'],
    rules: [
      ['comment', C_LINE],
      ['comment', C_BLOCK],
      ['string', STR_D],
      ['string', STR_S],
      ['string', STR_B],
      ['keyword', kw('const let var function return if else for while do switch case default break continue new delete typeof instanceof in of class extends super import export from as async await yield try catch finally throw this void static get set interface type enum implements private public protected readonly declare namespace')],
      ['literal', kw('true false null undefined NaN Infinity')],
      ['title', CALL],
      ['type', C_LIKE_TYPES],
      ['number', NUM],
      [null, WORD],
    ],
  },
  rust: {
    aliases: ['rs'],
    rules: [
      ['comment', C_LINE],
      ['comment', C_BLOCK],
      ['meta', /#!?\[[^\]\n]*\]/y],
      ['string', /b?r#*"[\s\S]*?"#*/y],
      ['string', STR_D],
      ['string', /'(?:\\.|[^'\\\n])'/y],
      ['type', /'[a-z_]\w*\b/y], // lifetimes
      ['keyword', kw('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while')],
      ['literal', kw('true false None Some Ok Err')],
      ['builtin', /\b[a-z_]\w*!/y],
      ['type', kw('u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64 bool char str String Vec Option Result Box')],
      ['title', CALL],
      ['type', C_LIKE_TYPES],
      ['number', NUM],
      [null, WORD],
    ],
  },
  go: {
    aliases: ['golang'],
    rules: [
      ['comment', C_LINE],
      ['comment', C_BLOCK],
      ['string', STR_D],
      ['string', STR_B],
      ['string', /'(?:\\.|[^'\\\n])'/y],
      ['keyword', kw('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var')],
      ['literal', kw('true false nil iota')],
      ['type', kw('int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any')],
      ['title', CALL],
      ['number', NUM],
      [null, WORD],
    ],
  },
  c: {
    aliases: ['h', 'cpp', 'c++', 'hpp', 'cc', 'cs', 'csharp', 'java', 'kotlin', 'kt', 'swift', 'php', 'dart', 'zig'],
    rules: [
      ['comment', C_LINE],
      ['comment', C_BLOCK],
      ['meta', /(?<=^\s*)#\s*\w+.*/my],
      ['string', STR_D],
      ['string', /'(?:\\.|[^'\\\n])*'/y],
      ['keyword', kw('auto break case catch class const constexpr continue default delete do else enum explicit extern final for friend goto if inline namespace new operator override private protected public return sizeof static struct switch template this throw try typedef typename union using virtual volatile while import package extends implements interface fun val var func let fn when')],
      ['literal', kw('true false null nullptr NULL nil')],
      ['type', kw('void int char short long float double bool unsigned signed size_t string String')],
      ['title', CALL],
      ['type', C_LIKE_TYPES],
      ['number', NUM],
      [null, WORD],
    ],
  },
  sql: {
    aliases: ['sqlite', 'postgres', 'postgresql', 'mysql', 'psql'],
    rules: [
      ['comment', /--.*/y],
      ['comment', C_BLOCK],
      ['string', STR_S],
      ['attr', STR_D],
      ['keyword', kw('select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references on join left right inner outer full cross group by order having limit offset as distinct union all exists in is null like between case when then else end begin commit rollback transaction if pragma default unique check returning with recursive asc desc count sum avg min max integer text real blob varchar boolean', 'i')],
      ['number', NUM],
      [null, WORD],
    ],
  },
  html: {
    aliases: ['xml', 'svg', 'xhtml', 'vue', 'plist'],
    rules: [
      ['comment', /<!--[\s\S]*?(?:-->|$)/y],
      ['meta', /<![^>]*>|<\?[\s\S]*?\?>/y],
      ['tag', /<\/?[A-Za-z][\w:.-]*|\/?>/y],
      ['attr', /(?<=\s)[A-Za-z_:][\w:.-]*(?==)/y],
      ['string', STR_D],
      ['string', STR_S],
      [null, WORD],
    ],
  },
  css: {
    aliases: ['scss', 'less', 'sass'],
    rules: [
      ['comment', C_BLOCK],
      ['comment', /(?<=^\s*)\/\/.*/my],
      ['string', STR_D],
      ['string', STR_S],
      ['meta', /@[\w-]+/y],
      ['attr', /[\w-]+(?=\s*:[^:]*[;}\n])/y],
      ['number', /#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b/y],
      ['var', /--[\w-]+|\$[\w-]+/y],
      [null, WORD],
    ],
  },
  dockerfile: {
    aliases: ['docker', 'containerfile'],
    rules: [
      ['comment', /(?<=^\s*)#.*/my],
      ['keyword', /(?<=^\s*)(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|AS)\b/imy],
      ['string', STR_D],
      ['string', STR_S],
      ['var', /\$\{[^}\n]*\}|\$\w+/y],
      ['flag', /(?<=\s)--?[A-Za-z0-9][\w-]*/y],
      ['number', NUM],
      [null, WORD],
    ],
  },
  diff: {
    aliases: ['patch'],
    rules: [
      ['meta', /^(?:@@.*|diff .*|index .*|---.*|\+\+\+.*)$/my],
      ['add', /^\+.*$/my],
      ['del', /^-.*$/my],
      [null, /.+/y],
    ],
  },
  // Fallback for languages not listed above.
  generic: {
    aliases: [],
    rules: [
      ['comment', C_LINE],
      ['comment', C_BLOCK],
      ['comment', HASH_LINE],
      ['string', STR_D],
      ['string', STR_S],
      ['literal', kw('true false null nil none')],
      ['number', NUM],
      [null, WORD],
    ],
  },
};

const BY_NAME = new Map();
for (const [name, def] of Object.entries(LANGS)) {
  BY_NAME.set(name, def.rules);
  def.aliases.forEach((a) => BY_NAME.set(a, def.rules));
}

export function highlight(code, lang) {
  const name = (lang || '').toLowerCase().trim();
  if (!name || name === 'text' || name === 'plain' || name === 'txt') return esc(code);
  const rules = BY_NAME.get(name) || BY_NAME.get('generic');
  let out = '';
  let plain = '';
  let i = 0;
  outer: while (i < code.length) {
    for (const [cls, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m[0].length) {
        if (plain) { out += esc(plain); plain = ''; }
        out += cls ? `<span class="c-${cls}">${esc(m[0])}</span>` : esc(m[0]);
        i += m[0].length;
        continue outer;
      }
    }
    plain += code[i++];
  }
  return out + esc(plain);
}

// Adds highlighting, line numbers and a copy button to rendered code blocks.
export function decorateCode(container) {
  container.querySelectorAll('pre.code:not(.decorated)').forEach((pre) => {
    pre.classList.add('decorated');
    const codeEl = pre.querySelector('code');
    const text = codeEl.textContent;
    const lang = pre.dataset.lang || '';
    codeEl.innerHTML = highlight(text, lang);

    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    gutter.textContent = text.split('\n').map((_, i) => i + 1).join('\n');
    const body = document.createElement('div');
    body.className = 'code-body';
    body.append(codeEl);

    const head = document.createElement('div');
    head.className = 'code-head';
    if (lang) {
      const label = document.createElement('span');
      label.className = 'code-lang';
      label.textContent = lang;
      head.append(label);
    }
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.title = 'Copy code';
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(text);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
    head.append(btn);
    pre.replaceChildren(gutter, body, head);
  });
}

// HTML for the backdrop behind the textarea when live highlighting is on.
// Must produce exactly the same characters as the textarea text.
export function highlightForEditor(text) {
  const lines = text.split('\n');
  let out = '';
  let code = [];
  let lang = null; // non-null while inside a fence
  const flushCode = () => {
    if (code.length) out += highlight(code.join('\n'), lang) + '\n';
    code = [];
  };
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : '';
    if (/^```/.test(line)) {
      if (lang === null) {
        out += `<span class="c-fence">${esc(line)}</span>${nl}`;
        lang = line.slice(3).trim();
      } else {
        flushCode();
        out += `<span class="c-fence">${esc(line)}</span>${nl}`;
        lang = null;
      }
    } else if (lang !== null) {
      code.push(line);
      if (!nl) { out += highlight(code.join('\n'), lang); code = []; }
    } else {
      out += esc(line) + nl;
    }
  });
  if (code.length) out += highlight(code.join('\n'), lang);
  // A trailing newline needs a character after it to take up a line.
  return text.endsWith('\n') ? out + ' ' : out;
}

// ---- the in-block code editor ------------------------------------------------

// Languages offered in the editor's dropdown: [value written after ```, label].
export const LANG_CHOICES = [
  ['', 'Plain text'], ['bash', 'Shell'], ['python', 'Python'], ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'], ['rust', 'Rust'], ['go', 'Go'], ['c', 'C'], ['cpp', 'C++'],
  ['csharp', 'C#'], ['java', 'Java'], ['json', 'JSON'], ['yaml', 'YAML'], ['toml', 'TOML'],
  ['ini', 'INI / Config'], ['sql', 'SQL'], ['html', 'HTML'], ['xml', 'XML'], ['css', 'CSS'],
  ['dockerfile', 'Dockerfile'], ['diff', 'Diff'], ['markdown', 'Markdown'],
];

const INDENT = '  ';

// A small code editor: line numbers, current-line highlight, syntax colours
// (a transparent textarea over a highlighted copy), language picker and copy.
// It edits only the code inside one fence; the owner applies the changes.
export class CodeEditor {
  // opts: { code, lang, live, onChange(code), onLang(lang), onExit(),
  //         onNavigate(dir), onUndo(), onRedo(), onRaw() }
  constructor(opts) {
    this.o = opts;
    this.lang = opts.lang || '';
    const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

    this.el = el('div', 'code-editor' + (opts.live ? ' live' : ''));
    this.gutter = el('div', 'ce-gutter');
    const main = el('div', 'ce-main');
    this.band = el('div', 'ce-line');
    this.mirror = el('pre', 'ce-mirror');
    this.mirror.setAttribute('aria-hidden', 'true');
    this.ta = el('textarea', 'ce-input');
    this.ta.spellcheck = false;
    this.ta.wrap = 'off';
    this.ta.setAttribute('autocapitalize', 'off');
    this.ta.setAttribute('autocomplete', 'off');
    this.ta.value = opts.code;
    main.append(this.band, this.mirror, this.ta);

    const bar = el('div', 'ce-toolbar');
    this.select = el('select', 'ce-lang');
    this.select.title = 'Language';
    const known = LANG_CHOICES.some(([v]) => v === this.lang);
    for (const [value, label] of known ? LANG_CHOICES : [[this.lang, this.lang], ...LANG_CHOICES]) {
      const opt = el('option');
      opt.value = value;
      opt.textContent = label;
      this.select.append(opt);
    }
    this.select.value = this.lang;
    const copy = el('button', 'code-copy');
    copy.type = 'button';
    copy.textContent = 'Copy';
    const raw = el('button', 'ce-raw');
    raw.type = 'button';
    raw.textContent = 'Edit as text';
    raw.title = 'Edit the whole block as plain text';
    bar.append(this.select, copy, raw);
    this.el.append(this.gutter, main, bar);

    this.ta.addEventListener('input', () => this.changed());
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    for (const ev of ['keyup', 'click', 'select', 'focus']) this.ta.addEventListener(ev, () => this.updateLine());
    this.ta.addEventListener('scroll', () => { this.mirror.scrollLeft = this.ta.scrollLeft; });
    this.select.addEventListener('change', () => {
      this.lang = this.select.value;
      this.o.onLang(this.lang);
      this.refresh();
      this.ta.focus();
    });
    copy.addEventListener('click', () => {
      copyText(this.ta.value);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      this.ta.focus();
    });
    raw.addEventListener('mousedown', (e) => e.preventDefault());
    raw.addEventListener('click', () => this.o.onRaw());
    // Leaving the editor (focus moves outside it) closes it.
    this.el.addEventListener('focusout', () => {
      setTimeout(() => { if (!this.closed && !this.el.contains(document.activeElement)) this.o.onExit(); }, 0);
    });
    this.refresh();
  }

  focus(caret = 0) {
    this.ta.focus({ preventScroll: true });
    const pos = Math.max(0, Math.min(caret, this.ta.value.length));
    this.ta.setSelectionRange(pos, pos);
    this.el.scrollIntoView({ block: 'nearest' });
    this.updateLine();
  }

  close() { this.closed = true; }

  changed() {
    this.refresh();
    this.o.onChange(this.ta.value);
  }

  refresh() {
    const v = this.ta.value;
    if (this.o.live) this.mirror.innerHTML = highlight(v, this.lang) + (v.endsWith('\n') || !v ? ' ' : '');
    const lines = v.split('\n').length;
    if (this.gutter.childElementCount !== lines) {
      this.gutter.replaceChildren(...Array.from({ length: lines }, (_, i) => {
        const n = document.createElement('div');
        n.textContent = String(i + 1);
        return n;
      }));
    }
    this.ta.style.height = 'auto';
    this.ta.style.height = this.ta.scrollHeight + 'px';
    this.updateLine();
  }

  currentLine() {
    return this.ta.value.slice(0, this.ta.selectionStart).split('\n').length - 1;
  }

  updateLine() {
    const line = this.currentLine();
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 21;
    const pad = parseFloat(getComputedStyle(this.ta).paddingTop) || 0;
    this.band.style.top = `${pad + line * lh}px`;
    this.band.style.height = `${lh}px`;
    [...this.gutter.children].forEach((n, i) => n.classList.toggle('current', i === line));
  }

  // Replaces [start, end) and puts the cursor at `caret`.
  splice(start, end, text, caret = start + text.length, caretEnd = caret) {
    const v = this.ta.value;
    this.ta.value = v.slice(0, start) + text + v.slice(end);
    this.ta.setSelectionRange(caret, caretEnd);
    this.changed();
  }

  onKey(e) {
    const ta = this.ta;
    const v = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const mod = e.ctrlKey || e.metaKey;
    const plain = !mod && !e.altKey && !e.shiftKey;
    if (e.isComposing) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      this.o.onExit();
    } else if (mod && !e.altKey && ['z', 'Z', 'y'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'y' || e.shiftKey) this.o.onRedo(); else this.o.onUndo();
    } else if (e.key === 'Enter' && plain) {
      // New line keeps the current line's indentation.
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', start - 1) + 1;
      const indent = /^[ \t]*/.exec(v.slice(lineStart))[0];
      this.splice(start, end, '\n' + indent);
    } else if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      this.indent(e.shiftKey);
    } else if (e.key === 'ArrowUp' && plain && start === end && !v.slice(0, start).includes('\n')) {
      e.preventDefault();
      this.o.onNavigate(-1);
    } else if (e.key === 'ArrowDown' && plain && start === end && !v.slice(end).includes('\n')) {
      e.preventDefault();
      this.o.onNavigate(1);
    }
  }

  // Tab indents (Shift+Tab outdents) the current line, or every selected line.
  indent(out) {
    const ta = this.ta;
    const v = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (!out && start === end) return this.splice(start, end, INDENT);
    const first = v.lastIndexOf('\n', start - 1) + 1;
    const lastEnd = v.indexOf('\n', end > start && v[end - 1] === '\n' ? end - 1 : end);
    const stop = lastEnd === -1 ? v.length : lastEnd;
    const lines = v.slice(first, stop).split('\n');
    let delta0 = 0;
    let total = 0;
    const changed = lines.map((l, i) => {
      if (out) {
        const n = /^( {1,2}|\t)/.exec(l)?.[0].length || 0;
        if (i === 0) delta0 = -n;
        total -= n;
        return l.slice(n);
      }
      if (i === 0) delta0 = INDENT.length;
      total += INDENT.length;
      return INDENT + l;
    });
    const text = changed.join('\n');
    const newStart = Math.max(first, start + delta0);
    const newEnd = start === end ? newStart : end + total;
    this.splice(first, stop, text, newStart, newEnd);
  }
}
