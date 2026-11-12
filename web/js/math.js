// LaTeX math → MathML, which browsers draw natively (Chrome 109+, Firefox,
// Safari). Written in-house: it covers the everyday subset of TeX math
// (fractions, roots, scripts, Greek, operators, \text, \left…\right,
// accents, matrices, cases, aligned) rather than all of TeX. Anything it
// doesn't know is shown in red instead of breaking the block.

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο',
  pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

// Symbols drawn as operators (<mo>).
const OPS = {
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '∙',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼',
  simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫', lt: '<', gt: '>',
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', Rightarrow: '⇒',
  Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹', impliedby: '⟸', iff: '⟺', mapsto: '↦',
  longrightarrow: '⟶', longleftarrow: '⟵', uparrow: '↑', downarrow: '↓',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', land: '∧', wedge: '∧', lor: '∨', vee: '∨', lnot: '¬', neg: '¬',
  forall: '∀', exists: '∃', nexists: '∄', mid: '∣', parallel: '∥', perp: '⊥', angle: '∠',
  oplus: '⊕', otimes: '⊗', odot: '⊙', vdash: '⊢', models: '⊨',
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  colon: ':', vert: '|', Vert: '‖', '|': '‖', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋',
  lceil: '⌈', rceil: '⌉', lbrace: '{', rbrace: '}', '{': '{', '}': '}',
  '%': '%', '$': '$', '#': '#', '&': '&', _: '_',
};

// Symbols drawn as identifiers (<mi>, upright).
const IDENTS = {
  infty: '∞', partial: '∂', nabla: '∇', emptyset: '∅', varnothing: '∅', hbar: 'ℏ', ell: 'ℓ',
  Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', degree: '°', prime: '′', triangle: '△', square: '□',
};

// Big operators: limits go above/below in display maths.
const BIG = { sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂' };
const NO_LIMITS = new Set(['int', 'iint', 'iiint', 'oint']);

// Named functions, drawn upright.
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh',
  'tanh', 'log', 'ln', 'lg', 'exp', 'det', 'dim', 'ker', 'deg', 'gcd', 'arg', 'hom', 'Pr']);
const LIMIT_FUNCS = new Set(['lim', 'max', 'min', 'sup', 'inf', 'limsup', 'liminf', 'argmax', 'argmin']);

const SPACES = { ',': '0.1667em', ':': '0.2222em', '>': '0.2222em', ';': '0.2778em', ' ': '0.25em', quad: '1em', qquad: '2em', enspace: '0.5em', thinspace: '0.1667em' };

const ACCENTS = { hat: '^', widehat: '^', bar: '¯', overline: '‾', vec: '→', overrightarrow: '→', dot: '˙', ddot: '¨', tilde: '~', widetilde: '~', check: 'ˇ', breve: '˘', acute: '´', grave: '`' };
const UNDER = { underline: '_', underbrace: '⏟' };

const SIZES = new Set(['big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr', 'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits']);

// Letters in the Unicode maths alphabets (MathML Core has no mathvariant
// other than "normal", so bold/blackboard/script use these characters).
const BB = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };
const CAL = { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' };
function alphabet(text, font) {
  return [...text].map((ch) => {
    const up = ch >= 'A' && ch <= 'Z';
    const low = ch >= 'a' && ch <= 'z';
    const dig = ch >= '0' && ch <= '9';
    const at = (base, start) => String.fromCodePoint(base + ch.charCodeAt(0) - start.charCodeAt(0));
    if (font === 'bb') return BB[ch] || (up ? at(0x1d538, 'A') : low ? at(0x1d552, 'a') : dig ? at(0x1d7d8, '0') : ch);
    if (font === 'bf') return up ? at(0x1d400, 'A') : low ? at(0x1d41a, 'a') : dig ? at(0x1d7ce, '0') : ch;
    if (font === 'cal') return CAL[ch] || (up ? at(0x1d49c, 'A') : low ? at(0x1d4b6, 'a') : ch);
    if (font === 'frak') return up ? ({ C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' }[ch] || at(0x1d504, 'A')) : low ? at(0x1d51e, 'a') : ch;
    return ch;
  }).join('');
}

// ---- tokens -------------------------------------------------------------
//
// Every token keeps its place in the source (p = start, e = end), so the
// maths builder can map each drawn piece back to the code that made it.

function tokenize(src) {
  const out = [];
  out.comments = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i));
      if (!m) { i++; continue; }
      out.push({ t: 'cmd', v: m[1], p: i, e: i + m[0].length });
      i += m[0].length;
      // Spaces after a command word are not part of the maths.
      if (/[a-zA-Z]/.test(m[1])) while (src[i] === ' ') i++;
    } else if (c === '%') {
      // As in TeX, % starts a comment that runs to the end of the line.
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out.comments.push([i, stop]);
      i = stop;
    } else if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i));
      out.push({ t: 'num', v: m[0], p: i, e: i + m[0].length });
      i += m[0].length;
    } else {
      // Keep surrogate pairs (e.g. pasted maths letters) together.
      const ch = String.fromCodePoint(src.codePointAt(i));
      out.push({ t: 'ch', v: ch, p: i, e: i + ch.length });
      i += ch.length;
    }
  }
  return out;
}

// ---- what each command is (for the builder's explanations) ----------------

const ARROWS = new Set(['to', 'rightarrow', 'leftarrow', 'gets', 'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow',
  'implies', 'impliedby', 'iff', 'mapsto', 'longrightarrow', 'longleftarrow', 'uparrow', 'downarrow']);
const RELATIONS = new Set(['leq', 'le', 'geq', 'ge', 'neq', 'ne', 'approx', 'equiv', 'sim', 'simeq', 'cong', 'propto', 'll', 'gg', 'lt', 'gt',
  'in', 'notin', 'ni', 'subset', 'supset', 'subseteq', 'supseteq', 'mid', 'parallel', 'perp', 'vdash', 'models']);
const DELIMS = new Set(['langle', 'rangle', 'lfloor', 'rfloor', 'lceil', 'rceil', 'lbrace', 'rbrace', '{', '}', 'vert', 'Vert', '|']);
const ENVIRONMENTS = new Set(['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'cases',
  'aligned', 'align', 'alignat', 'split', 'gathered', 'gather', 'eqnarray', 'array']);
const STRUCTURES = {
  frac: 'frac', dfrac: 'frac', tfrac: 'frac', cfrac: 'frac', binom: 'binom', dbinom: 'binom', tbinom: 'binom', sqrt: 'sqrt',
  text: 'text', textrm: 'text', textnormal: 'text', mbox: 'text', textit: 'text', textbf: 'text', textsf: 'text', texttt: 'text',
  mathrm: 'upright', operatorname: 'upright', mathsf: 'upright', mathtt: 'upright', rm: 'upright', mathit: 'upright',
  mathbb: 'font', mathbf: 'font', bf: 'font', boldsymbol: 'font', bm: 'font', mathcal: 'font', mathscr: 'font', mathfrak: 'font',
  left: 'leftright', right: 'leftright', middle: 'leftright', begin: 'env', pmod: 'mod', bmod: 'mod', mod: 'mod', not: 'not',
  stackrel: 'overset', overset: 'overset', underset: 'overset', boxed: 'boxed', color: 'color', textcolor: 'color', overbrace: 'accent',
};

// Every command this file understands (for "did you mean…?").
const KNOWN = [...new Set([
  ...Object.keys(GREEK), ...Object.keys(OPS), ...Object.keys(IDENTS), ...Object.keys(BIG), ...FUNCS, ...LIMIT_FUNCS,
  ...Object.keys(SPACES), ...Object.keys(ACCENTS), ...Object.keys(UNDER), ...SIZES, ...Object.keys(STRUCTURES), 'end', 'lvert', 'rvert', 'lVert', 'rVert',
])].filter((k) => /^[a-zA-Z]+$/.test(k));

export function kindOfCommand(name) {
  if (GREEK[name]) return 'greek';
  if (ARROWS.has(name)) return 'arrow';
  if (RELATIONS.has(name)) return 'relation';
  if (DELIMS.has(name)) return 'delimiter';
  if (OPS[name] !== undefined || IDENTS[name]) return 'symbol';
  if (BIG[name]) return 'big';
  if (FUNCS.has(name)) return 'func';
  if (LIMIT_FUNCS.has(name)) return 'limitfunc';
  if (SPACES[name] || name === '!') return 'space';
  if (name === '\\') return 'newline';
  if (ACCENTS[name] || UNDER[name]) return 'accent';
  if (SIZES.has(name)) return 'size';
  return STRUCTURES[name] || 'unknown';
}

function kindOf(tok) {
  if (tok.t === 'num') return 'number';
  if (tok.t === 'cmd') return kindOfCommand(tok.v);
  if (tok.v === '{') return 'group';
  if (/\p{L}/u.test(tok.v)) return 'variable';
  return 'operator';
}

// Closest known command, for typos like \fac or \alpah.
function suggest(name) {
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  };
  let best = null;
  let bestD = Math.max(1, Math.min(2, Math.floor(name.length / 3)));
  for (const k of KNOWN) {
    const dd = dist(name, k);
    if (dd < bestD || (dd === bestD && !best)) { best = k; bestD = dd; }
  }
  return best;
}

const CLOSERS = { '(': ')', '[': ']', '\\{': '\\}', '|': '|', '\\|': '\\|', '\\langle': '\\rangle', '\\lfloor': '\\rfloor', '\\lceil': '\\rceil', '.': '.', '\\lvert': '\\rvert' };

// ---- parser ---------------------------------------------------------------

class Parser {
  constructor(src, display, map = false) {
    this.toks = tokenize(src);
    this.i = 0;
    this.display = display;
    this.src = src;
    this.map = map; // add data-s / data-k source positions (builder only)
    this.problems = [];
    this.used = new Map(); // kind → first piece of source using it
  }

  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  isCmd(tok, ...names) { return tok?.t === 'cmd' && names.includes(tok.v); }
  isCh(tok, c) { return tok?.t === 'ch' && tok.v === c; }
  endPos() { return this.toks[this.i - 1]?.e ?? this.src.length; }

  // level: 'error' (shown wrong) or 'tip' (works, but there's a better way).
  // fix: {start, end, text} replacement that solves it.
  problem(level, start, end, message, fix = null) {
    if (this.quiet) return;
    this.problems.push({ level, start, end, message, fix });
  }

  // Tags the outermost element with the source range that produced it.
  mark(html, start, end, kind) {
    if (!html || kind === 'size') return html;
    if (!this.used.has(kind)) this.used.set(kind, this.src.slice(start, end));
    if (!this.map || html[0] !== '<') return html;
    return html.replace(/^<([a-z]+)/, `<$1 data-s="${start}-${end}" data-k="${kind}"`);
  }

  // Text inside {…} taken literally, spaces included (for \text,
  // \begin{env}, \operatorname). Read from the source, then skip its tokens.
  rawGroup() {
    const tok = this.peek();
    if (!this.isCh(tok, '{')) {
      this.next();
      return tok ? tok.v : '';
    }
    let depth = 0;
    let j = tok.p;
    for (; j < this.src.length; j++) {
      const c = this.src[j];
      if (c === '\\') { j++; continue; }
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) break;
    }
    const text = this.src.slice(tok.p + 1, j);
    while (this.peek() && this.peek().p <= j) this.next();
    return text;
  }

  // A list of items until a closing token; returns joined MathML.
  expr(stop = () => false) {
    const items = [];
    while (this.peek() && !stop(this.peek())) {
      const item = this.scripted();
      if (item !== null) items.push(item);
    }
    return items.join('');
  }

  row(stop) {
    return `<mrow>${this.expr(stop)}</mrow>`;
  }

  // One argument: {group} or a single token. `who` names the command it
  // belongs to (for messages about a missing argument).
  arg(who = '') {
    const tok = this.peek();
    const missing = (at) => {
      this.problem('error', at, at, `${who || 'This'} needs something after it, e.g. ${who === '^' ? 'x^{2}' : who === '_' ? 'x_{1}' : `${who}{…}`}.`, { start: at, end: at, text: '{}' });
      return '<mrow></mrow>';
    };
    if (!tok) return missing(this.src.length);
    if (this.isCh(tok, '}') || this.isCh(tok, '&') || this.isCmd(tok, '\\', 'end', 'right')) return missing(tok.p);
    if (this.isCh(tok, '{')) {
      this.next();
      const r = this.row((t) => this.isCh(t, '}'));
      this.next();
      return this.mark(r, tok.p, this.endPos(), 'group');
    }
    // As in TeX, an argument without braces is one character: x^10 is x¹0.
    if (tok.t === 'num' && tok.v.length > 1) {
      const full = tok.v;
      if (who === '^' || who === '_') {
        this.problem('tip', tok.p - 1, tok.e, `In ${who}${full} only the ${full[0]} is ${who === '^' ? 'raised' : 'lowered'}; the ${full.slice(1)} stays on the line. Use braces to keep them together: ${who}{${full}}.`,
          { start: tok.p, end: tok.e, text: `{${full}}` });
      }
      tok.v = full.slice(1);
      tok.p += 1;
      return this.mark(`<mn>${full[0]}</mn>`, tok.p - 1, tok.p, 'number');
    }
    if ((who === '^' || who === '_') && tok.t === 'ch' && /\p{L}/u.test(tok.v)) {
      // e^ix: only "i" is raised, a common slip.
      let j = this.i + 1;
      let end = tok.e;
      while (this.toks[j] && this.toks[j].p === end && (this.toks[j].t === 'num' || (this.toks[j].t === 'ch' && /\p{L}/u.test(this.toks[j].v)))) end = this.toks[j++].e;
      if (end > tok.e) {
        const run = this.src.slice(tok.p, end);
        this.problem('tip', tok.p - 1, end, `Only “${tok.v}” is ${who === '^' ? 'raised' : 'lowered'}. If you meant all of “${run}”, use braces: ${who}{${run}}.`,
          { start: tok.p, end, text: `{${run}}` });
      }
    }
    return this.atom() ?? '<mrow></mrow>';
  }

  // An atom followed by any ^ and _ (and primes).
  scripted() {
    const start = this.peek();
    let base = this.atom();
    if (base === null) return null;
    const limits = start?.t === 'cmd' && ((BIG[start.v] && !NO_LIMITS.has(start.v)) || LIMIT_FUNCS.has(start.v));
    let sub = null;
    let sup = null;
    for (;;) {
      const t = this.peek();
      if (this.isCmd(t, 'limits', 'nolimits')) { this.next(); continue; }
      if (this.isCh(t, '_') || this.isCh(t, '^')) {
        const isSup = t.v === '^';
        if ((isSup ? sup : sub) !== null) {
          this.problem('error', t.p, t.e, `Two ${isSup ? 'superscripts' : 'subscripts'} in a row. Put braces around the first one, e.g. x^{2^{3}}.`);
          this.next();
          this.arg(t.v);
          continue;
        }
        this.next();
        const a = this.arg(t.v);
        if (isSup) sup = a; else sub = a;
        continue;
      }
      if (this.isCh(t, "'")) {
        this.next();
        let primes = '′';
        while (this.isCh(this.peek(), "'")) { this.next(); primes += '′'; }
        sup = `<mo>${primes}</mo>`;
        continue;
      }
      break;
    }
    if (sub === null && sup === null) return base;
    if (base === '') base = '<mrow></mrow>';
    const [u, o, uo] = limits ? ['munder', 'mover', 'munderover'] : ['msub', 'msup', 'msubsup'];
    let html;
    if (sub !== null && sup !== null) html = `<${uo}>${base}${sub}${sup}</${uo}>`;
    else if (sub !== null) html = `<${u}>${base}${sub}</${u}>`;
    else html = `<${o}>${base}${sup}</${o}>`;
    const kind = limits ? 'limits' : sub !== null && sup !== null ? 'subsup' : sub !== null ? 'sub' : 'sup';
    return this.mark(html, start.p, this.endPos(), kind);
  }

  atom() {
    const tok = this.peek();
    if (!tok) return null;
    const html = this.atomInner();
    if (html === null) return null;
    return this.mark(html, tok.p, this.endPos(), kindOf(tok));
  }

  atomInner() {
    const tok = this.next();
    if (!tok) return null;
    if (tok.t === 'num') return `<mn>${tok.v}</mn>`;
    if (tok.t === 'ch') {
      const c = tok.v;
      if (c === '{') {
        const r = this.row((t) => this.isCh(t, '}'));
        this.next();
        return r;
      }
      if (c === '}') return '';
      if (c === '^' || c === '_') {
        this.problem('error', tok.p, tok.e, `${c} needs something in front of it to attach to, like x${c}{2}.`);
        return '<mrow></mrow>';
      }
      if (c === '&') {
        this.problem('error', tok.p, tok.e, '& lines up columns, so it only works inside an environment such as \\begin{aligned} … \\end{aligned} or a matrix. Write \\& for an ampersand sign.',
          { start: tok.p, end: tok.e, text: '\\&' });
        return '<mo>&amp;</mo>';
      }
      if (/\p{L}/u.test(c)) return `<mi>${esc(c)}</mi>`;
      if (c === '~') return '<mspace width="0.25em"></mspace>';
      if (c === '-') return '<mo>−</mo>';
      if (c === '*') {
        this.problem('tip', tok.p, tok.e, '* shows as an asterisk. For multiplication use \\times (×) or \\cdot (⋅).', { start: tok.p, end: tok.e, text: this.src[tok.e] === ' ' ? '\\times' : '\\times ' });
        return '<mo>∗</mo>';
      }
      // Plain brackets keep their size (only \left…\right stretches them).
      if ('()[]|'.includes(c)) return `<mo stretchy="false">${c}</mo>`;
      return `<mo>${esc(c)}</mo>`;
    }
    return this.command(tok.v, tok);
  }

  command(name, tok) {
    if (GREEK[name]) return /^[A-Z]/.test(name) ? `<mi mathvariant="normal">${GREEK[name]}</mi>` : `<mi>${GREEK[name]}</mi>`;
    if (OPS[name] !== undefined) return `<mo>${esc(OPS[name])}</mo>`;
    if (IDENTS[name]) return `<mi mathvariant="normal">${IDENTS[name]}</mi>`;
    if (BIG[name]) return `<mo largeop="true"${NO_LIMITS.has(name) ? '' : ' movablelimits="true"'}>${BIG[name]}</mo>`;
    if (FUNCS.has(name)) return `<mi>${name}</mi><mo>&#x2061;</mo><mspace width="0.1667em"></mspace>`;
    if (LIMIT_FUNCS.has(name)) return `<mo movablelimits="true" form="prefix">${name.replace(/^(lim)(sup|inf)$/, '$1 $2')}</mo>`;
    if (SPACES[name]) return `<mspace width="${SPACES[name]}"></mspace>`;
    if (name === '!') return '<mspace width="-0.1667em"></mspace>';
    if (name === '\\') return '<mspace linebreak="newline"></mspace>';
    if (SIZES.has(name)) return '';
    const who = `\\${name}`;
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac': {
        const a = this.arg(who);
        const b = this.arg(who);
        const style = name === 'dfrac' ? ' displaystyle="true"' : name === 'tfrac' ? ' displaystyle="false"' : '';
        return `<mfrac${style}>${a}${b}</mfrac>`;
      }
      case 'binom': case 'dbinom': case 'tbinom': {
        const a = this.arg(who);
        const b = this.arg(who);
        return `<mrow><mo>(</mo><mfrac linethickness="0">${a}${b}</mfrac><mo>)</mo></mrow>`;
      }
      case 'sqrt': {
        if (this.isCh(this.peek(), '[')) {
          this.next();
          const index = this.row((x) => this.isCh(x, ']'));
          this.next();
          return `<mroot>${this.arg(who)}${index}</mroot>`;
        }
        return `<msqrt>${this.arg(who)}</msqrt>`;
      }
      case 'text': case 'textrm': case 'textnormal': case 'mbox': case 'textit': case 'textbf': case 'textsf': case 'texttt': {
        if (!this.isCh(this.peek(), '{')) this.problem('tip', tok.p, tok.e, `Put the words in braces: ${who}{your words}. Without them only one letter is taken.`);
        const s = this.rawGroup().replace(/\\([%$#&_{}])/g, '$1');
        const style = name === 'textbf' ? ' style="font-weight:bold"' : name === 'textit' ? ' style="font-style:italic"' : name === 'texttt' ? ' style="font-family:monospace"' : '';
        return `<mtext${style}>${esc(s)}</mtext>`;
      }
      case 'mathrm': case 'operatorname': case 'mathsf': case 'mathtt': case 'rm': {
        const s = this.rawGroup().replace(/\\,|\\ /g, ' ');
        return name === 'operatorname' ? `<mi>${esc(s)}</mi><mo>&#x2061;</mo>` : `<mi mathvariant="normal">${esc(s)}</mi>`;
      }
      case 'mathit': return `<mi>${esc(this.rawGroup())}</mi>`;
      case 'mathbb': return `<mi>${esc(alphabet(this.rawGroup(), 'bb'))}</mi>`;
      case 'mathbf': case 'bf': case 'boldsymbol': case 'bm': return `<mi>${esc(alphabet(this.rawGroup(), 'bf'))}</mi>`;
      case 'mathcal': case 'mathscr': return `<mi>${esc(alphabet(this.rawGroup(), 'cal'))}</mi>`;
      case 'mathfrak': return `<mi>${esc(alphabet(this.rawGroup(), 'frak'))}</mi>`;
      case 'left': return this.fenced(tok);
      case 'right': case 'middle': {
        const d = this.delimiter(tok);
        if (name === 'right') {
          this.problem('error', tok.p, this.endPos(), `${this.src.slice(tok.p, this.endPos())} has no \\left before it. They come in pairs: \\left( … \\right).`,
            { start: tok.p, end: this.endPos(), text: this.src.slice(tok.e, this.endPos()).trim() });
        }
        return `<mo stretchy="true">${esc(d)}</mo>`;
      }
      case 'begin': return this.environment(this.rawGroup().trim(), tok);
      case 'end': {
        const envName = this.rawGroup();
        this.problem('error', tok.p, this.endPos(), `\\end{${envName}} has no \\begin{${envName}} before it.`, { start: tok.p, end: this.endPos(), text: '' });
        return '';
      }
      case 'pmod': return `<mspace width="0.5em"></mspace><mo>(</mo><mi mathvariant="normal">mod</mi><mspace width="0.3em"></mspace>${this.arg(who)}<mo>)</mo>`;
      case 'bmod': case 'mod': return '<mo lspace="0.3em" rspace="0.3em">mod</mo>';
      case 'not': {
        const next = this.atom() || '';
        return `<mrow><mpadded width="0">${next}</mpadded><mo>/</mo></mrow>`;
      }
      case 'stackrel': case 'overset': {
        const top = this.arg(who);
        return `<mover>${this.arg(who)}${top}</mover>`;
      }
      case 'underset': {
        const bottom = this.arg(who);
        return `<munder>${this.arg(who)}${bottom}</munder>`;
      }
      case 'boxed': return `<menclose notation="box" style="border:1px solid;padding:2px">${this.arg(who)}</menclose>`;
      case 'color': case 'textcolor': {
        const color = this.rawGroup().replace(/[^#\w]/g, '');
        const body = name === 'textcolor' ? this.arg(who) : this.row((t) => this.isCh(t, '}'));
        return `<mrow style="color:${esc(color)}">${body}</mrow>`;
      }
      default: {
        if (ACCENTS[name]) {
          const stretch = /^(widehat|widetilde|overline|overrightarrow)$/.test(name) ? ' stretchy="true"' : ' stretchy="false"';
          return `<mover accent="true">${this.arg(who)}<mo${stretch}>${ACCENTS[name]}</mo></mover>`;
        }
        if (UNDER[name]) return `<munder accentunder="true">${this.arg(who)}<mo stretchy="true">${UNDER[name]}</mo></munder>`;
        if (name === 'overbrace') return `<mover>${this.arg(who)}<mo stretchy="true">⏞</mo></mover>`;
        const guess = /^[a-zA-Z]+$/.test(name) ? suggest(name) : null;
        this.problem('error', tok.p, tok.e, guess ? `\\${name} isn't a command I know. Did you mean \\${guess}?` : `\\${name} isn't a command I know.`,
          guess ? { start: tok.p, end: tok.e, text: `\\${guess}` } : null);
        return `<merror><mtext>\\${esc(name)}</mtext></merror>`;
      }
    }
  }

  // The delimiter after \left, \right, \big…: one character or command.
  delimiter(owner) {
    const t = this.peek();
    if (!t || this.isCh(t, '}')) {
      const at = t ? t.p : this.src.length;
      this.problem('error', owner.p, owner.e, `\\${owner.v} needs a bracket after it, e.g. \\${owner.v}( or \\${owner.v}. for none.`, { start: at, end: at, text: owner.v === 'left' ? '(' : ')' });
      return '';
    }
    this.next();
    if (t.t === 'ch') return t.v === '.' ? '' : t.v;
    return OPS[t.v] ?? (t.v === 'lvert' || t.v === 'rvert' ? '|' : t.v === 'lVert' || t.v === 'rVert' ? '‖' : '');
  }

  fenced(leftTok) {
    const delimStart = this.peek()?.p;
    const open = this.delimiter(leftTok);
    const openSrc = delimStart === undefined ? '' : this.src.slice(delimStart, this.endPos());
    const inner = this.expr((t) => this.isCmd(t, 'right'));
    let close = '';
    if (this.isCmd(this.peek(), 'right')) {
      close = this.delimiter(this.next());
    } else {
      const closer = CLOSERS[openSrc] || ')';
      this.problem('error', leftTok.p, this.endPos() > leftTok.p ? Math.min(this.endPos(), leftTok.e + openSrc.length) : leftTok.e,
        `\\left${openSrc} needs a matching \\right${closer} later on.`, { start: this.src.length, end: this.src.length, text: ` \\right${closer}` });
    }
    return `<mrow><mo stretchy="true" fence="true">${esc(open)}</mo>${inner}<mo stretchy="true" fence="true">${esc(close)}</mo></mrow>`;
  }

  // Rows split by \\ and cells by &, until \end{…}.
  table(name, beginTok) {
    const rows = [];
    let row = [];
    const done = (t) => this.isCmd(t, 'end') || this.isCh(t, '&') || this.isCmd(t, '\\');
    for (;;) {
      row.push(this.expr(done));
      const t = this.next();
      if (!t) {
        if (beginTok) {
          this.problem('error', beginTok.p, beginTok.e + name.length + 2, `\\begin{${name}} is never closed. Add \\end{${name}} at the end.`,
            { start: this.src.length, end: this.src.length, text: ` \\end{${name}}` });
        }
        break;
      }
      if (this.isCh(t, '&')) continue;
      if (this.isCmd(t, '\\')) {
        // Skip an optional [2pt] spacing after \\.
        if (this.isCh(this.peek(), '[')) while (this.peek() && this.next().v !== ']');
        rows.push(row);
        row = [];
        continue;
      }
      // \end{name}
      const groupStart = this.peek()?.p ?? t.e;
      const endName = this.rawGroup().trim();
      if (beginTok && endName !== name) {
        this.problem('error', t.p, this.endPos(), `This closes “${endName}” but the open environment is “${name}”.`,
          { start: groupStart, end: this.endPos(), text: `{${name}}` });
      }
      break;
    }
    if (row.length > 1 || row[0]) rows.push(row);
    return rows;
  }

  // beginTok is null for the implicit table made from a top-level \\.
  environment(name, beginTok = null) {
    const base = name.replace(/\*$/, '');
    if (beginTok && !ENVIRONMENTS.has(base)) {
      this.problem('error', beginTok.p, this.peek()?.p ?? this.src.length, `“${name}” isn't an environment I know. Try matrix, pmatrix, bmatrix, cases or aligned.`);
    }
    if (base === 'array') this.rawGroup(); // column spec: not used
    const rows = this.table(name, beginTok);
    const aligned = /^(aligned|align|alignat|split|eqnarray)$/.test(base);
    const cell = (c, j) => {
      // aligned: odd columns right, even left (around the = sign).
      const style = aligned ? ` style="text-align:${j % 2 ? 'left' : 'right'};padding:0 ${j % 2 ? '1em 0 0' : '0'}"` : base === 'cases' ? ' style="text-align:left;padding-right:1em"' : '';
      return `<mtd${style}><mrow>${c}</mrow></mtd>`;
    };
    const table = `<mtable${aligned ? ' displaystyle="true"' : ''}>${rows.map((r) => `<mtr>${r.map(cell).join('')}</mtr>`).join('')}</mtable>`;
    const fences = { pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', ''] }[base];
    if (!fences) return table;
    return `<mrow><mo stretchy="true" fence="true">${fences[0]}</mo>${table}<mo stretchy="true" fence="true">${fences[1]}</mo></mrow>`;
  }
}

// Braces that don't pair up, found before parsing.
function braceProblems(p) {
  const stack = [];
  for (const t of p.toks) {
    if (p.isCh(t, '{')) stack.push(t);
    else if (p.isCh(t, '}')) {
      if (stack.length) stack.pop();
      else p.problem('error', t.p, t.e, 'This } has no { to close.', { start: t.p, end: t.e, text: '' });
    }
  }
  for (const t of stack) {
    p.problem('error', t.p, t.e, 'This { is never closed with a }.', { start: p.src.length, end: p.src.length, text: '}' });
  }
  for (const [a, b] of p.toks.comments) {
    p.problem('tip', a, b, '% starts a comment in LaTeX, so the rest of the line is hidden. Write \\% for a percent sign.', { start: a, end: a + 1, text: '\\%' });
  }
}

function build(tex, display, map) {
  const p = new Parser(tex, display, map);
  let body;
  try {
    braceProblems(p);
    // A top-level \\ (several lines) becomes an aligned table.
    if (p.toks.some((t) => p.isCmd(t, '\\')) && !p.toks.some((t) => p.isCmd(t, 'begin'))) {
      // A fake "\end{}" past the end of the source closes the table.
      const end = tex.length + 1;
      p.src = `${tex} {}`;
      p.toks.push({ t: 'cmd', v: 'end', p: end - 1, e: end }, { t: 'ch', v: '{', p: end, e: end + 1 }, { t: 'ch', v: '}', p: end + 1, e: end + 2 });
      body = p.environment(p.toks.some((t) => p.isCh(t, '&')) ? 'aligned' : 'gathered');
      p.src = tex;
    } else {
      body = p.expr();
    }
  } catch (e) {
    body = `<merror><mtext>${esc(tex)}</mtext></merror>`;
    p.problems.push({ level: 'error', start: 0, end: tex.length, message: `Couldn't read this formula (${e.message}).`, fix: null });
  }
  const html = `<math class="math"${display ? ' display="block"' : ''}><semantics><mrow>${body}</mrow><annotation encoding="application/x-tex">${esc(tex)}</annotation></semantics></math>`;
  return { html, parser: p };
}

// Renders TeX as a <math> element (HTML string). `display` centres it on
// its own line. The source is kept for copying (semantics/annotation).
export function texToMathML(tex, display = false) {
  return build(tex, display, false).html;
}

// For the maths builder: the MathML with source positions on each piece
// (data-s="start-end", data-k=kind), the problems found, and which kinds
// of construct the formula uses ([{kind, code}]).
export function analyzeTex(tex, display = true) {
  const { html, parser } = build(tex, display, true);
  const seen = new Set();
  const problems = parser.problems
    .filter((q) => {
      const key = `${q.start}:${q.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.level === b.level ? a.start - b.start : a.level === 'error' ? -1 : 1));
  const used = [...parser.used].map(([kind, code]) => ({ kind, code }));
  return { html, problems, used };
}
