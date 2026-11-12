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

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i));
      if (!m) { i++; continue; }
      out.push({ t: 'cmd', v: m[1], p: i });
      i += m[0].length;
      // Spaces after a command word are not part of the maths.
      if (/[a-zA-Z]/.test(m[1])) while (src[i] === ' ') i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i));
      out.push({ t: 'num', v: m[0], p: i });
      i += m[0].length;
    } else {
      // Keep surrogate pairs (e.g. pasted maths letters) together.
      const ch = String.fromCodePoint(src.codePointAt(i));
      out.push({ t: 'ch', v: ch, p: i });
      i += ch.length;
    }
  }
  return out;
}

// ---- parser ---------------------------------------------------------------

class Parser {
  constructor(src, display) {
    this.toks = tokenize(src);
    this.i = 0;
    this.display = display;
    this.src = src;
  }

  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  isCmd(tok, ...names) { return tok?.t === 'cmd' && names.includes(tok.v); }

  // Text inside {…} taken literally, spaces included (for \text,
  // \begin{env}, \operatorname). Read from the source, then skip its tokens.
  rawGroup() {
    const tok = this.peek();
    if (tok?.t !== 'ch' || tok.v !== '{') {
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
    const inner = this.expr(stop);
    return `<mrow>${inner}</mrow>`;
  }

  // One argument: {group} or a single token.
  arg() {
    const tok = this.peek();
    if (!tok) return '<mrow></mrow>';
    if (tok.t === 'ch' && tok.v === '{') {
      this.next();
      const r = this.row((t) => t.t === 'ch' && t.v === '}');
      this.next();
      return r;
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
      if (t?.t === 'cmd' && (t.v === 'limits' || t.v === 'nolimits')) { this.next(); continue; }
      if (t?.t === 'ch' && t.v === '_' && sub === null) { this.next(); sub = this.arg(); continue; }
      if (t?.t === 'ch' && t.v === '^' && sup === null) { this.next(); sup = this.arg(); continue; }
      if (t?.t === 'ch' && t.v === "'") {
        this.next();
        let primes = '′';
        while (this.peek()?.t === 'ch' && this.peek().v === "'") { this.next(); primes += '′'; }
        sup = `<mo>${primes}</mo>`;
        continue;
      }
      break;
    }
    if (sub === null && sup === null) return base;
    if (base === '') base = '<mrow></mrow>';
    const [u, o, uo] = limits ? ['munder', 'mover', 'munderover'] : ['msub', 'msup', 'msubsup'];
    if (sub !== null && sup !== null) return `<${uo}>${base}${sub}${sup}</${uo}>`;
    if (sub !== null) return `<${u}>${base}${sub}</${u}>`;
    return `<${o}>${base}${sup}</${o}>`;
  }

  atom() {
    const tok = this.next();
    if (!tok) return null;
    if (tok.t === 'num') return `<mn>${tok.v}</mn>`;
    if (tok.t === 'ch') {
      const c = tok.v;
      if (c === '{') {
        const r = this.row((t) => t.t === 'ch' && t.v === '}');
        this.next();
        return r;
      }
      if (c === '}') return '';
      if (c === '^' || c === '_') return `<mrow></mrow>`;
      if (/\p{L}/u.test(c)) return `<mi>${esc(c)}</mi>`;
      if (c === '~') return '<mspace width="0.25em"></mspace>';
      if (c === '-') return '<mo>−</mo>';
      if (c === '*') return '<mo>∗</mo>';
      // Plain brackets keep their size (only \left…\right stretches them).
      if ('()[]|'.includes(c)) return `<mo stretchy="false">${c}</mo>`;
      return `<mo>${esc(c)}</mo>`;
    }
    return this.command(tok.v);
  }

  command(name) {
    if (GREEK[name]) return /^[A-Z]/.test(name) ? `<mi mathvariant="normal">${GREEK[name]}</mi>` : `<mi>${GREEK[name]}</mi>`;
    if (OPS[name] !== undefined) return `<mo>${esc(OPS[name])}</mo>`;
    if (IDENTS[name]) return `<mi mathvariant="normal">${IDENTS[name]}</mi>`;
    if (BIG[name]) return `<mo largeop="true"${NO_LIMITS.has(name) ? '' : ' movablelimits="true"'}>${BIG[name]}</mo>`;
    if (FUNCS.has(name)) return `<mi>${name}</mi><mo>&#x2061;</mo><mspace width="0.1667em"></mspace>`;
    if (LIMIT_FUNCS.has(name)) return `<mo movablelimits="true" form="prefix">${name.replace(/^(lim)(sup|inf)$/, '$1 $2')}</mo>`;
    if (SPACES[name]) return `<mspace width="${SPACES[name]}"></mspace>`;
    if (name === '!') return '<mspace width="-0.1667em"></mspace>';
    if (name === '\\') return this.lineBreak();
    if (SIZES.has(name)) return '';
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac': {
        const a = this.arg();
        const b = this.arg();
        const style = name === 'dfrac' ? ' displaystyle="true"' : name === 'tfrac' ? ' displaystyle="false"' : '';
        return `<mfrac${style}>${a}${b}</mfrac>`;
      }
      case 'binom': case 'dbinom': case 'tbinom': {
        const a = this.arg();
        const b = this.arg();
        return `<mrow><mo>(</mo><mfrac linethickness="0">${a}${b}</mfrac><mo>)</mo></mrow>`;
      }
      case 'sqrt': {
        const t = this.peek();
        if (t?.t === 'ch' && t.v === '[') {
          this.next();
          const index = this.row((x) => x.t === 'ch' && x.v === ']');
          this.next();
          return `<mroot>${this.arg()}${index}</mroot>`;
        }
        return `<msqrt>${this.arg()}</msqrt>`;
      }
      case 'text': case 'textrm': case 'textnormal': case 'mbox': case 'textit': case 'textbf': case 'textsf': case 'texttt': {
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
      case 'left': return this.fenced();
      case 'right': case 'middle': {
        const d = this.delimiter();
        return `<mo stretchy="true">${esc(d)}</mo>`;
      }
      case 'begin': return this.environment(this.rawGroup().trim());
      case 'pmod': return `<mspace width="0.5em"></mspace><mo>(</mo><mi mathvariant="normal">mod</mi><mspace width="0.3em"></mspace>${this.arg()}<mo>)</mo>`;
      case 'bmod': case 'mod': return '<mo lspace="0.3em" rspace="0.3em">mod</mo>';
      case 'not': {
        const next = this.atom() || '';
        return `<mrow><mpadded width="0">${next}</mpadded><mo>/</mo></mrow>`;
      }
      case 'stackrel': case 'overset': {
        const top = this.arg();
        return `<mover>${this.arg()}${top}</mover>`;
      }
      case 'underset': {
        const bottom = this.arg();
        return `<munder>${this.arg()}${bottom}</munder>`;
      }
      case 'boxed': return `<menclose notation="box" style="border:1px solid;padding:2px">${this.arg()}</menclose>`;
      case 'color': case 'textcolor': {
        const color = this.rawGroup().replace(/[^#\w]/g, '');
        const body = name === 'textcolor' ? this.arg() : this.row((t) => t.t === 'ch' && t.v === '}');
        return `<mrow style="color:${esc(color)}">${body}</mrow>`;
      }
      default:
        if (ACCENTS[name]) {
          const stretch = /^(widehat|widetilde|overline|overrightarrow)$/.test(name) ? ' stretchy="true"' : ' stretchy="false"';
          return `<mover accent="true">${this.arg()}<mo${stretch}>${ACCENTS[name]}</mo></mover>`;
        }
        if (UNDER[name]) return `<munder accentunder="true">${this.arg()}<mo stretchy="true">${UNDER[name]}</mo></munder>`;
        if (name === 'overbrace') return `<mover>${this.arg()}<mo stretchy="true">⏞</mo></mover>`;
        return `<merror><mtext>\\${esc(name)}</mtext></merror>`;
    }
  }

  // The delimiter after \left, \right, \big…: one character or command.
  delimiter() {
    const t = this.next();
    if (!t) return '';
    if (t.t === 'ch') return t.v === '.' ? '' : t.v;
    return OPS[t.v] ?? (t.v === 'lvert' || t.v === 'rvert' ? '|' : t.v === 'lVert' || t.v === 'rVert' ? '‖' : '');
  }

  fenced() {
    const open = this.delimiter();
    const inner = this.expr((t) => this.isCmd(t, 'right'));
    let close = '';
    if (this.isCmd(this.peek(), 'right')) { this.next(); close = this.delimiter(); }
    return `<mrow><mo stretchy="true" fence="true">${esc(open)}</mo>${inner}<mo stretchy="true" fence="true">${esc(close)}</mo></mrow>`;
  }

  // `\\` outside an environment: the caller (render) makes rows of these.
  lineBreak() {
    return '<mspace linebreak="newline"></mspace>';
  }

  // Rows split by \\ and cells by &, until \end{…}.
  table(stopName) {
    const rows = [];
    let row = [];
    const done = (t) => this.isCmd(t, 'end') || (t.t === 'ch' && t.v === '&') || this.isCmd(t, '\\');
    for (;;) {
      row.push(this.expr(done));
      const t = this.next();
      if (!t) break;
      if (t.t === 'ch' && t.v === '&') continue;
      if (this.isCmd(t, '\\')) {
        // Skip an optional [2pt] spacing after \\.
        if (this.peek()?.t === 'ch' && this.peek().v === '[') while (this.peek() && this.next().v !== ']');
        rows.push(row);
        row = [];
        continue;
      }
      // \end{name}
      this.rawGroup();
      break;
    }
    if (row.length > 1 || row[0]) rows.push(row);
    void stopName;
    return rows;
  }

  environment(name) {
    const base = name.replace(/\*$/, '');
    if (base === 'array') this.rawGroup(); // column spec: not used
    const rows = this.table(name);
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

// Renders TeX as a <math> element (HTML string). `display` centres it on
// its own line. The source is kept for copying (semantics/annotation).
export function texToMathML(tex, display = false) {
  let body;
  try {
    const p = new Parser(tex, display);
    // A top-level \\ (several lines) becomes an aligned table.
    if (p.toks.some((t) => t.t === 'cmd' && t.v === '\\') && !p.toks.some((t) => t.t === 'cmd' && t.v === 'begin')) {
      // A fake "\end{}" past the end of the source closes the table.
      const end = tex.length + 1;
      p.src = `${tex} {}`;
      p.toks.push({ t: 'cmd', v: 'end', p: end - 1 }, { t: 'ch', v: '{', p: end }, { t: 'ch', v: '}', p: end + 1 });
      body = p.environment(p.toks.some((t) => t.t === 'ch' && t.v === '&') ? 'aligned' : 'gathered');
    } else {
      body = p.expr();
    }
  } catch {
    body = `<merror><mtext>${esc(tex)}</mtext></merror>`;
  }
  return `<math class="math"${display ? ' display="block"' : ''}><semantics><mrow>${body}</mrow><annotation encoding="application/x-tex">${esc(tex)}</annotation></semantics></math>`;
}
