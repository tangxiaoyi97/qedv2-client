/**
 * Live-preview helper for the expression input control: best-effort parse of
 * the user's raw input, returning KaTeX source for rendering, or undefined
 * while the input is not (yet) parsable.
 *
 * Preview is advisory — the grading normalization in expression.ts is the
 * authority. Keep the light-touch fixes here aligned with it.
 */
import { create, all } from 'mathjs';
import type { FactoryFunctionMap } from 'mathjs';

const math = create(all as FactoryFunctionMap);

function lightNormalize(input: string): string {
  let s = input.trim();
  // strip a leading assignment like "f(x) =" / "y ="
  s = s.replace(/^[A-Za-z][A-Za-z0-9_]*(?:\([^)]*\))?\s*=\s*/, '');
  // unicode operators
  s = s.replace(/−/g, '-').replace(/[·×]/g, '*').replace(/÷/g, '/').replace(/√/g, 'sqrt');
  // decimal commas when no function-argument commas are plausible
  if (!/\([^()]*,[^()]*\)/.test(s)) s = s.replace(/(\d),(\d)/g, '$1.$2');
  // implicit multiplication: 2x → 2*x, 2( → 2*(, )x → )*x, )( → )*(
  s = s.replace(/(\d)\s*([A-Za-z(])/g, '$1*$2').replace(/\)\s*([A-Za-z0-9(])/g, ')*$1');
  return s;
}

export function expressionPreviewLatex(input: string): string | undefined {
  const s = lightNormalize(input);
  if (s === '') return undefined;
  try {
    return math.parse(s).toTex({ parenthesis: 'auto' });
  } catch {
    return undefined;
  }
}
