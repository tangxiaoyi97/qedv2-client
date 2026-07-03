/**
 * KaTeX-flavoured LaTeX → mathjs syntax for the bank's `canonical` strings
 * (supplement §5). Implemented as a small recursive walker (not one regex
 * chain) so nested constructs like \frac{\frac{a}{b}}{c} convert correctly.
 *
 * Unknown backslash commands THROW — callers treat an unconvertible canonical
 * as unparsable and grade indeterminate (never hard-fail the user).
 */

export class LatexConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LatexConversionError';
  }
}

/** Zero-argument commands mapped 1:1 to mathjs tokens. */
const SIMPLE_COMMANDS: Record<string, string> = {
  cdot: '*',
  times: '*',
  div: '/',
  pi: 'pi',
  // \ln is mathjs' natural log; \log (unqualified) is treated as log10.
  ln: 'log',
  log: 'log10',
  // Function names that mathjs shares (or renames) — kept so trig /
  // transcendental canonicals go through the same equivalence path.
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  arcsin: 'asin',
  arccos: 'acos',
  arctan: 'atan',
  exp: 'exp',
};

/** Spacing macros stripped entirely (single-char and word forms). */
const SPACING_COMMANDS = new Set([',', ';', ':', '!', ' ', 'quad', 'qquad']);

/**
 * Read a balanced `{...}` group starting at `src[open] === '{'`.
 * Returns the inner (unconverted) source and the index after the `}`.
 */
function readGroup(src: string, open: number): [inner: string, next: number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return [src.slice(open + 1, i), i + 1];
    }
  }
  throw new LatexConversionError(`unbalanced "{" at index ${open}`);
}

/**
 * Flatten a subscript into identifier characters: x_{max} → "max".
 * Subscripts merge into the preceding symbol (x_n → xn) because mathjs
 * treats the whole thing as one plain identifier.
 */
function flattenSubscript(inner: string): string {
  if (inner.includes('\\')) {
    throw new LatexConversionError(`unsupported command inside subscript: "${inner}"`);
  }
  return inner.replace(/[^A-Za-z0-9]/g, '');
}

function convert(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '\\') {
      i++;
      // Command name: a letter run, or a single non-letter char (\, \% \{ ...).
      let cmd = '';
      while (i < src.length && /[A-Za-z]/.test(src[i]!)) {
        cmd += src[i]!;
        i++;
      }
      if (cmd === '') {
        if (i >= src.length) throw new LatexConversionError('dangling "\\" at end of input');
        cmd = src[i]!;
        i++;
      }

      if (SPACING_COMMANDS.has(cmd)) continue;
      if (cmd === '%') {
        // \% — percent of the preceding value.
        out += '/100';
        continue;
      }
      if (cmd === '{' || cmd === '}') {
        // Literal braces render as grouping parentheses.
        out += cmd === '{' ? '(' : ')';
        continue;
      }
      if (cmd === 'left' || cmd === 'right') {
        // Strip the sizing macro; a "." delimiter is invisible — drop it too.
        // Real delimiters ( ) [ ] pass through as ordinary characters.
        if (src[i] === '.') i++;
        continue;
      }
      if (cmd === 'frac') {
        if (src[i] !== '{') throw new LatexConversionError('\\frac expects {num}{den}');
        const [num, afterNum] = readGroup(src, i);
        if (src[afterNum] !== '{') throw new LatexConversionError('\\frac expects {num}{den}');
        const [den, afterDen] = readGroup(src, afterNum);
        out += `((${convert(num)})/(${convert(den)}))`;
        i = afterDen;
        continue;
      }
      if (cmd === 'sqrt') {
        let index: string | undefined;
        if (src[i] === '[') {
          const close = src.indexOf(']', i);
          if (close < 0) throw new LatexConversionError('unbalanced "[" in \\sqrt');
          index = src.slice(i + 1, close);
          i = close + 1;
        }
        if (src[i] !== '{') throw new LatexConversionError('\\sqrt expects {radicand}');
        const [radicand, next] = readGroup(src, i);
        out +=
          index !== undefined
            ? `nthRoot(${convert(radicand)},${convert(index)})`
            : `sqrt(${convert(radicand)})`;
        i = next;
        continue;
      }
      const mapped = SIMPLE_COMMANDS[cmd];
      if (mapped !== undefined) {
        out += mapped;
        continue;
      }
      throw new LatexConversionError(`unsupported LaTeX command "\\${cmd}"`);
    }

    if (ch === '{') {
      // {,} is the bank's German decimal comma (e.g. 1{,}03).
      if (src[i + 1] === ',' && src[i + 2] === '}') {
        out += '.';
        i += 3;
        continue;
      }
      // Any other remaining group only groups → convert to parentheses.
      const [inner, next] = readGroup(src, i);
      out += `(${convert(inner)})`;
      i = next;
      continue;
    }

    if (ch === '}') throw new LatexConversionError(`unbalanced "}" at index ${i}`);

    if (ch === '_') {
      // Subscript merges into the preceding identifier: x_n → xn, x_{max} → xmax.
      i++;
      if (src[i] === '{') {
        const [inner, next] = readGroup(src, i);
        out += flattenSubscript(inner);
        i = next;
      } else if (i < src.length) {
        out += flattenSubscript(src[i]!);
        i++;
      }
      continue;
    }

    if (ch === '^') {
      // ^{...} needs explicit parentheses; a bare ^x passes through untouched.
      i++;
      if (src[i] === '{') {
        const [inner, next] = readGroup(src, i);
        out += `^(${convert(inner)})`;
        i = next;
      } else {
        out += '^';
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Convert a KaTeX-flavoured canonical expression to mathjs-parsable syntax.
 * Throws {@link LatexConversionError} on anything it cannot faithfully map.
 */
export function latexToMathjs(src: string): string {
  return convert(src);
}
