import { describe, expect, it } from 'vitest';
import { create, all, type FactoryFunctionMap } from 'mathjs';
import { expressionPreviewLatex } from '../src/grading/expression-preview.js';

const math = create(all as FactoryFunctionMap);

describe('expression preview matches the notation used to grade', () => {
  it.each([
    ['2e3', '2000'],
    ['log10(x)', 'log10(x)'],
    ['√x', 'sqrt(x)'],
    ['(1,5)*x', '(1.5)*x'],
  ])('preserves the meaning of %s', (input, normalized) => {
    expect(expressionPreviewLatex(input)).toBe(math.parse(normalized!).toTex({ parenthesis: 'auto' }));
  });

  it('uses known question variables to distinguish multiplication from a function call', () => {
    expect(expressionPreviewLatex('x(x+1)', ['x'])).toBe(math.parse('x*(x+1)').toTex({ parenthesis: 'auto' }));
    expect(expressionPreviewLatex('x_n(x_n+1)', ['x_n'])).toBe(math.parse('xn*(xn+1)').toTex({ parenthesis: 'auto' }));
  });
});
