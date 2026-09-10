/**
 * Live-preview helper for the expression input control: best-effort parse of
 * the user's raw input, returning KaTeX source for rendering, or undefined
 * while the input is not (yet) parsable.
 *
 * Uses the same normalization as grading so the preview never changes the
 * meaning of a scientific number, function call or decimal-comma input.
 */
import { create, all } from 'mathjs';
import type { FactoryFunctionMap } from 'mathjs';
import { normalizeExpressionInput } from './expression.js';

const math = create(all as FactoryFunctionMap);

export function expressionPreviewLatex(input: string, vars: string[] = []): string | undefined {
  const s = normalizeExpressionInput(input, vars);
  if (s === '') return undefined;
  try {
    return math.parse(s).toTex({ parenthesis: 'auto' });
  } catch {
    return undefined;
  }
}
