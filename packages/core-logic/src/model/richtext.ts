/**
 * RichText — the mixed-content format used throughout the question bank
 * (prompts, options, solutions, rubrics). Contract §1.1:
 *
 *   RichText = InlineNode[]
 *   InlineNode = {t:"text",v} | {t:"math",v} | {t:"fig",src,alt}
 *
 * `math` nodes carry KaTeX source. `fig` nodes carry a path relative to the
 * bank root; resolve against the core service's `/content/assets/` prefix.
 */
export interface TextNode {
  t: 'text';
  v: string;
}

export interface MathNode {
  t: 'math';
  v: string;
}

export interface FigNode {
  t: 'fig';
  src: string;
  alt?: string;
}

export type InlineNode = TextNode | MathNode | FigNode;

export type RichText = InlineNode[];

/* ------------------------------------------------------------------ */
/* LaTeX → readable plain text (previews, <select> labels, aria only). */
/* NOT a canonicalization — never feed this into checksums or sync.    */
/* ------------------------------------------------------------------ */

const MATHBB: Record<string, string> = {
  R: 'ℝ',
  N: 'ℕ',
  Z: 'ℤ',
  Q: 'ℚ',
  C: 'ℂ',
};

/** Command words replaced in a single pass (\word → symbol, or dropped). */
const SYMBOLS: Record<string, string> = {
  cdot: '·',
  times: '×',
  pm: '±',
  pi: 'π',
  infty: '∞',
  alpha: 'α',
  beta: 'β',
  lambda: 'λ',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  in: '∈',
  notin: '∉',
  cup: '∪',
  cap: '∩',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  setminus: '\\',
  backslash: '\\',
  left: '',
  right: '',
};

/** Multiplication-style operators render tight (2·i), swallowing the spaces
    around them; everything else in SYMBOLS gets symmetric single spaces
    (x ≤ 5, A ∪ B) so spaced source can't come out lopsided ("x ≤5"). */
const TIGHT = new Set(['cdot', 'times', 'pm']);

/** Standalone operands (Greek, ∞): keep preceding space, swallow only the
    command-terminating whitespace after the name (2\pi r → 2πr). */
const OPERAND = new Set(['pi', 'infty', 'alpha', 'beta', 'lambda']);

const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  n: 'ⁿ',
  i: 'ⁱ',
};

const SUBSCRIPTS: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  a: 'ₐ',
  e: 'ₑ',
  h: 'ₕ',
  i: 'ᵢ',
  j: 'ⱼ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  p: 'ₚ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ',
};

/* Sentinels (private-use chars) so ^/_ fallbacks emitted mid-loop cannot be
   re-matched by a later iteration; restored to ^/_ at the very end. Escaped
   braces \{ \} get the same treatment so the group parser and the final
   brace stripper never mistake them for group delimiters. */
const SUP_SENTINEL = '\uE000';
const SUB_SENTINEL = '\uE001';
const LBRACE_SENTINEL = '\uE002';
const RBRACE_SENTINEL = '\uE003';

function toSup(content: string): string {
  let out = '';
  for (const ch of content) {
    const mapped = SUPERSCRIPTS[ch];
    if (mapped === undefined) return `${SUP_SENTINEL}(${content})`;
    out += mapped;
  }
  return out;
}

function toSub(content: string): string {
  let out = '';
  for (const ch of content) {
    const mapped = SUBSCRIPTS[ch];
    if (mapped === undefined) return `${SUB_SENTINEL}${content}`;
    out += mapped;
  }
  return out;
}

/**
 * Conservative KaTeX-source → readable plain text. Pure, dependency-free.
 * Only for human-facing projections (option labels, aria, previews) — it is
 * lossy by design and must never enter checksum/sync canonicalization.
 */
export function mathToPlain(latex: string): string {
  // 1. escaped literal chars (\{ \} \% \& \# \$) and the German
  //    decimal-separator group ({,} keeps "1{,}5" tight in LaTeX)
  let s = latex
    .replace(/\\\{/g, LBRACE_SENTINEL)
    .replace(/\\\}/g, RBRACE_SENTINEL)
    .replace(/\\([%&#$])/g, '$1')
    .replace(/\{,\}/g, ',');

  // 2. brace-group commands, innermost-first: the argument patterns match
  //    only brace-free content, so nested forms (\sqrt{\tfrac{1}{2}}) resolve
  //    over repeated passes. Bounded to guarantee termination.
  for (let pass = 0; pass < 20; pass++) {
    const prev = s;
    s = s
      .replace(/\\[td]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√$1')
      .replace(/\\dot\s*\{([^{}]*)\}/g, '$1\u0307')
      .replace(/\\vec\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\(?:text|mathrm)\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\mathbb\s*\{([^{}]*)\}/g, (_m, inner: string) => MATHBB[inner] ?? inner)
      .replace(/\^\{([^{}]*)\}/g, (_m, c: string) => toSup(c))
      .replace(/\^([^\s{\\(])/g, (_m, c: string) => toSup(c))
      .replace(/_\{([^{}]*)\}/g, (_m, c: string) => toSub(c))
      .replace(/_([^\s{\\(])/g, (_m, c: string) => toSub(c));
    if (s === prev) break;
  }

  // 3. spacing commands: thin spaces → single space, negative space dropped
  s = s.replace(/\\[,;:]/g, ' ').replace(/\\!/g, '');

  // 4. remaining command words in ONE pass (so a produced "\" from
  //    \setminus is never re-scanned). Spacing per class: TIGHT operators
  //    swallow surrounding whitespace (x \cdot y → x·y), OPERANDs swallow
  //    only the command-terminating whitespace (2\pi r → 2πr), unknown
  //    words keep one following space (\sin x → sin x), everything else
  //    gets symmetric single spaces (x\le 5 → x ≤ 5).
  s = s.replace(/(\s*)\\([a-zA-Z]+)(\s*)/g, (_m, pre: string, word: string, post: string) => {
    const sym = SYMBOLS[word];
    if (sym === undefined) return `${pre}${word}${post === '' ? '' : ' '}`;
    if (sym === '') return pre; // \left / \right
    if (TIGHT.has(word)) return sym;
    if (OPERAND.has(word)) return `${pre}${sym}`;
    return ` ${sym} `;
  });

  // 5. strip leftover braces, restore sentinels, tidy whitespace runs
  return s
    .replace(/[{}]/g, '')
    .replace(new RegExp(SUP_SENTINEL, 'g'), '^')
    .replace(new RegExp(SUB_SENTINEL, 'g'), '_')
    .replace(new RegExp(LBRACE_SENTINEL, 'g'), '{')
    .replace(new RegExp(RBRACE_SENTINEL, 'g'), '}')
    .replace(/ {2,}/g, ' ');
}

/** Plain-text projection (for previews, sorting, accessibility fallbacks). */
export function richTextToPlain(rt: RichText | undefined): string {
  if (!rt) return '';
  return rt
    .map((n) => (n.t === 'text' ? n.v : n.t === 'math' ? mathToPlain(n.v) : (n.alt ?? '')))
    .join('')
    .trim();
}
