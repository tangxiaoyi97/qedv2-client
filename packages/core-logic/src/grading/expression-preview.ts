/**
 * Live-preview helper for the expression input control: best-effort parse of
 * the user's raw input, returning KaTeX source for rendering, or undefined
 * while the input is not (yet) parsable.
 *
 * Uses the same normalization as grading so the preview never changes the
 * meaning of a scientific number, function call or decimal-comma input.
 */
import { normalizeExpressionInput } from './expression.js';
import { expressionMath as math, isBoundedExpressionSource } from './expression-safety.js';

export function expressionPreviewLatex(input: string, vars: string[] = []): string | undefined {
  if (!isBoundedExpressionSource(input) || vars.length > 32 || vars.some((name) => name.length > 128)) {
    return undefined;
  }
  try {
    const s = normalizeExpressionInput(input, vars);
    if (s === '') return undefined;
    return math.parse(s).toTex({ parenthesis: 'auto' });
  } catch {
    return undefined;
  }
}
