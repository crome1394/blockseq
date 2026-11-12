// Plain-words explanations of LaTeX pieces, and the maths builder's palette.
// Kinds come from math.js (data-k on each drawn piece, and analyzeTex().used).

// kind → [title, explanation]. {code} is replaced with the piece of source.
const KINDS = {
  variable: ['Variable', 'A single letter is a variable, drawn in italics. Each letter is its own variable, so “ab” means a times b. For a word use \\text{…}.'],
  number: ['Number', 'Digits are drawn upright. Several digits in a row stay together as one number, except right after ^ or _ (see Superscript).'],
  operator: ['Symbol', '{code} is typed straight from the keyboard. +, −, =, <, >, brackets and commas need no command.'],
  group: ['Braces { }', 'Braces group things without being drawn themselves. Use them whenever a command or ^ / _ should take more than one character: x^{10}, \\frac{a+b}{2}.'],
  frac: ['Fraction', '\\frac{top}{bottom}: the first braces are the numerator, the second the denominator. \\dfrac always draws it full size, \\tfrac small.'],
  binom: ['Binomial', '\\binom{n}{k} draws “n choose k”: n over k in brackets, with no line between them.'],
  sqrt: ['Square root', '\\sqrt{x} is a square root. For other roots put the index in square brackets first: \\sqrt[3]{x} is a cube root.'],
  sup: ['Superscript', '^ raises what follows: x^2. Without braces it takes only one character, so write x^{10} or e^{-x}.'],
  sub: ['Subscript', '_ lowers what follows: x_1. Without braces it takes only one character, so write x_{12} or a_{n+1}.'],
  subsup: ['Sub- and superscript', 'Use both on one base, in either order: x_i^2 is the same as x^2_i.'],
  limits: ['Limits', 'On \\sum, \\prod, \\lim, \\max and friends, _ and ^ set the limits. In a centred formula they go below and above; inline they sit to the side to save height.'],
  text: ['Text', '\\text{…} writes ordinary words inside maths, upright and with their spaces kept. Spaces typed in maths are otherwise ignored.'],
  upright: ['Upright letters', '{code} draws letters upright instead of italic. \\operatorname{name} also spaces it like a function (e.g. \\operatorname{sgn} x).'],
  font: ['Maths alphabet', '{code} uses a special alphabet: \\mathbb{R} blackboard bold (ℝ), \\mathbf bold, \\mathcal script, \\mathfrak Fraktur.'],
  greek: ['Greek letter', '{code} is a Greek letter. Lower case for small letters (\\alpha α), capitalised for capitals (\\Delta Δ). Capitals that look Latin (A, B…) are just typed.'],
  arrow: ['Arrow', '{code} draws an arrow. \\to and \\rightarrow are the same; capitalised ones (\\Rightarrow ⇒) are double arrows for “implies”.'],
  relation: ['Relation', '{code} compares two things (like = does), so it gets space on both sides: \\le ≤, \\ge ≥, \\ne ≠, \\approx ≈, \\in ∈.'],
  delimiter: ['Bracket', '{code} is a bracket that has no key of its own: \\{ \\} braces, \\langle \\rangle angle brackets, \\lfloor \\rfloor floor.'],
  symbol: ['Symbol', '{code} is a named symbol: \\times ×, \\cdot ⋅, \\pm ±, \\infty ∞, \\partial ∂, \\ldots ….'],
  big: ['Big operator', '{code} is a large operator. Add limits with _ and ^: \\sum_{i=1}^{n}, \\int_0^1.'],
  func: ['Function name', '{code} writes the function name upright with the right spacing. Typing “sin” without the backslash would mean s × i × n.'],
  limitfunc: ['Limit-style function', '{code} is upright like a function, and its _ goes underneath in a centred formula: \\lim_{x \\to 0}.'],
  space: ['Space', 'Maths ignores typed spaces. {code} adds one: \\, thin, \\: medium, \\; thick, \\quad wide, \\qquad wider, \\! negative.'],
  newline: ['New line', '\\\\ starts a new line. With & as well, the lines line up at the & (e.g. on the = signs).'],
  accent: ['Accent', '{code} puts a mark over (or under) its argument: \\hat{x} x̂, \\bar{x} x̄, \\vec{v} v⃗, \\dot{x} ẋ, \\overline{AB}.'],
  leftright: ['Growing brackets', '\\left( … \\right) makes brackets grow to fit what is inside, such as a fraction. They always come in pairs; use \\left. or \\right. for an invisible side.'],
  env: ['Environment', '\\begin{name} … \\end{name} builds a layout: & moves to the next column and \\\\ to the next row. matrix / pmatrix ( ) / bmatrix [ ] / vmatrix | | for matrices, cases for piecewise rules, aligned to line up equations.'],
  mod: ['Modulo', '\\pmod{n} writes “(mod n)” at the end; \\bmod writes “mod” between two numbers.'],
  not: ['Negation', '\\not puts a slash through the next symbol: \\not= ≠ (though \\ne is simpler).'],
  overset: ['Stacked', '\\overset{top}{base} puts something small above a symbol; \\underset{bottom}{base} below.'],
  boxed: ['Box', '\\boxed{…} draws a frame around part of a formula, e.g. a final answer.'],
  color: ['Colour', '\\textcolor{red}{…} colours part of a formula.'],
  size: ['Size', '{code} sets a size or style. It is accepted, but this renderer sizes things automatically.'],
  unknown: ['Unknown command', '{code} isn’t a command this builder knows, so it is shown in red. Check the spelling, or look for a suggestion below.'],
};

export function explain(kind, code = '') {
  const [title, text] = KINDS[kind] || KINDS.unknown;
  return { title, text: text.replace('{code}', code.trim() || 'This') };
}

export function kindTitle(kind) {
  return (KINDS[kind] || KINDS.unknown)[0];
}

// The palette: [preview TeX, text inserted, tip]. In the inserted text, an
// empty {} is a slot: the cursor goes to the first one and Tab moves on.
export const PALETTE = [
  ['Structures', [
    ['\\frac{a}{b}', '\\frac{}{}', 'Fraction: \\frac{top}{bottom}'],
    ['x^{2}', '^{}', 'Superscript: x^{2}. Braces keep several characters together.'],
    ['x_{1}', '_{}', 'Subscript: x_{1}'],
    ['x_{i}^{2}', '_{}^{}', 'Both: x_{i}^{2}'],
    ['\\sqrt{x}', '\\sqrt{}', 'Square root: \\sqrt{x}'],
    ['\\sqrt[n]{x}', '\\sqrt[]{}', 'nth root: \\sqrt[n]{x}'],
    ['\\left( \\frac{a}{b} \\right)', '\\left( {} \\right)', 'Brackets that grow to fit: \\left( … \\right)'],
    ['\\binom{n}{k}', '\\binom{}{}', 'Binomial: \\binom{n}{k}'],
    ['\\text{abc}', '\\text{}', 'Words inside maths: \\text{…}'],
    ['\\overline{AB}', '\\overline{}', 'Line over: \\overline{AB}'],
    ['\\hat{x}', '\\hat{}', 'Hat accent: \\hat{x}'],
    ['\\vec{v}', '\\vec{}', 'Vector arrow: \\vec{v}'],
    ['\\boxed{x}', '\\boxed{}', 'Frame: \\boxed{…}'],
  ]],
  ['Operators', [
    ['\\times', '\\times ', 'Multiplication: \\times'],
    ['\\cdot', '\\cdot ', 'Centred dot: \\cdot'],
    ['\\div', '\\div ', 'Division: \\div'],
    ['\\pm', '\\pm ', 'Plus or minus: \\pm'],
    ['\\sum_{i=1}^{n}', '\\sum_{}^{}', 'Sum with limits: \\sum_{i=1}^{n}'],
    ['\\prod_{i=1}^{n}', '\\prod_{}^{}', 'Product: \\prod_{i=1}^{n}'],
    ['\\int_{a}^{b}', '\\int_{}^{} {} \\, dx', 'Integral: \\int_{a}^{b} f(x) \\, dx (\\, is a thin space)'],
    ['\\oint', '\\oint ', 'Contour integral: \\oint'],
    ['\\lim_{x \\to 0}', '\\lim_{{} \\to {}} ', 'Limit: \\lim_{x \\to 0}'],
    ['\\sin', '\\sin ', 'Functions: \\sin \\cos \\tan \\log \\ln \\exp'],
    ['\\log_{b}', '\\log_{} ', 'Logarithm to a base: \\log_{b}'],
    ['\\partial', '\\partial ', 'Partial derivative: \\partial'],
    ['\\nabla', '\\nabla ', 'Nabla / gradient: \\nabla'],
    ['\\infty', '\\infty ', 'Infinity: \\infty'],
    ['\\ldots', '\\ldots ', 'Dots: \\ldots (low) \\cdots (centred)'],
  ]],
  ['Relations', [
    ['\\le', '\\le ', 'Less than or equal: \\le'],
    ['\\ge', '\\ge ', 'Greater than or equal: \\ge'],
    ['\\ne', '\\ne ', 'Not equal: \\ne'],
    ['\\approx', '\\approx ', 'Approximately: \\approx'],
    ['\\equiv', '\\equiv ', 'Equivalent: \\equiv'],
    ['\\propto', '\\propto ', 'Proportional to: \\propto'],
    ['\\in', '\\in ', 'Element of: \\in'],
    ['\\notin', '\\notin ', 'Not an element of: \\notin'],
    ['\\subseteq', '\\subseteq ', 'Subset: \\subseteq'],
    ['\\cup', '\\cup ', 'Union: \\cup'],
    ['\\cap', '\\cap ', 'Intersection: \\cap'],
    ['\\forall', '\\forall ', 'For all: \\forall'],
    ['\\exists', '\\exists ', 'There exists: \\exists'],
    ['\\to', '\\to ', 'Arrow / tends to: \\to'],
    ['\\Rightarrow', '\\Rightarrow ', 'Implies: \\Rightarrow'],
    ['\\Leftrightarrow', '\\Leftrightarrow ', 'If and only if: \\Leftrightarrow'],
  ]],
  ['Greek', ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi', 'rho', 'sigma', 'tau', 'phi', 'omega',
    'Gamma', 'Delta', 'Theta', 'Lambda', 'Pi', 'Sigma', 'Phi', 'Omega'].map((g) => [`\\${g}`, `\\${g} `, `\\${g}`])],
  ['Layouts', [
    ['\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', '\\begin{pmatrix} {} & {} \\\\ {} & {} \\end{pmatrix}', 'Matrix in ( ): & next column, \\\\ next row. bmatrix for [ ], vmatrix for | |'],
    ['\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}', '\\begin{bmatrix} {} & {} \\\\ {} & {} \\end{bmatrix}', 'Matrix in [ ]'],
    ['\\begin{cases} a & x > 0 \\\\ b & x \\le 0 \\end{cases}', '\\begin{cases} {} & {} \\\\ {} & {} \\end{cases}', 'Piecewise: value & condition on each row'],
    ['\\begin{aligned} a &= b \\\\ &= c \\end{aligned}', '\\begin{aligned} {} &= {} \\\\ &= {} \\end{aligned}', 'Equations lined up on the = signs (put & before each =)'],
  ]],
  ['Letters', [
    ['\\mathbb{R}', '\\mathbb{}', 'Blackboard bold: \\mathbb{R} (number sets ℝ ℕ ℤ ℚ ℂ)'],
    ['\\mathbf{v}', '\\mathbf{}', 'Bold: \\mathbf{v}'],
    ['\\mathcal{L}', '\\mathcal{}', 'Script: \\mathcal{L}'],
    ['\\mathrm{d}', '\\mathrm{}', 'Upright: \\mathrm{d}'],
    ['x\\,y', '\\,', 'Thin space: \\,'],
    ['x\\quad y', '\\quad ', 'Wide space: \\quad'],
  ]],
];

// Ready-made formulas to start from.
export const EXAMPLES = [
  ['Percentage change', '\\text{Percentage Change} = \\frac{\\text{New Value} - \\text{Old Value}}{\\text{Old Value}} \\times 100'],
  ['Quadratic formula', 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}'],
  ['Compound interest', 'A = P \\left(1 + \\frac{r}{n}\\right)^{nt}'],
  ['Pythagoras', 'a^2 + b^2 = c^2'],
  ['Mean', '\\bar{x} = \\frac{1}{n} \\sum_{i=1}^{n} x_i'],
  ['Standard deviation', '\\sigma = \\sqrt{\\frac{1}{N} \\sum_{i=1}^{N} (x_i - \\mu)^2}'],
];
