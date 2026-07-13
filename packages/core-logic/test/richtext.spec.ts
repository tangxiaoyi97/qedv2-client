import { describe, expect, it } from 'vitest';
import { mathToPlain, richTextToPlain } from '../src/model/richtext.js';
import type { RichText } from '../src/model/richtext.js';

describe('mathToPlain', () => {
  it('converts roots and fractions', () => {
    expect(mathToPlain('\\sqrt{7}')).toBe('√7');
    expect(mathToPlain('-\\sqrt{169}')).toBe('-√169');
    expect(mathToPlain('\\tfrac{20}{5}')).toBe('20/5');
    expect(mathToPlain('\\frac{a}{b}')).toBe('a/b');
    expect(mathToPlain('\\dfrac{1}{2}')).toBe('1/2');
  });

  it('resolves nested brace-group commands innermost-first', () => {
    expect(mathToPlain('\\tfrac{\\pi}{4}')).toBe('π/4');
    expect(mathToPlain('\\sqrt{\\tfrac{1}{2}}')).toBe('√1/2');
  });

  it('converts multiplication-style operators tight, even with spaced source', () => {
    expect(mathToPlain('2\\cdot i')).toBe('2·i');
    expect(mathToPlain('a\\cdot x-5=10')).toBe('a·x-5=10');
    expect(mathToPlain('A \\cdot \\sqrt{7}')).toBe('A·√7'); // symmetric, not "A ·√7"
    expect(mathToPlain('3\\times 4')).toBe('3×4');
    expect(mathToPlain('\\pm 2')).toBe('±2');
    expect(mathToPlain('\\infty')).toBe('∞');
    expect(mathToPlain('\\alpha+\\beta=\\lambda')).toBe('α+β=λ');
  });

  it('converts relations and set operators with symmetric spaces', () => {
    expect(mathToPlain('a\\le b\\leq c')).toBe('a ≤ b ≤ c');
    expect(mathToPlain('x \\le 5')).toBe('x ≤ 5'); // spaced source stays symmetric
    expect(mathToPlain('a\\ge b\\geq c')).toBe('a ≥ b ≥ c');
    expect(mathToPlain('a\\ne b\\neq c')).toBe('a ≠ b ≠ c');
    expect(mathToPlain('x\\approx 3')).toBe('x ≈ 3');
    expect(mathToPlain('A\\cup B\\cap C')).toBe('A ∪ B ∩ C');
    expect(mathToPlain('A\\setminus B')).toBe('A \\ B');
    expect(mathToPlain('A\\backslash B')).toBe('A \\ B');
  });

  it('converts number sets via \\mathbb', () => {
    expect(mathToPlain('x\\in\\mathbb{R}')).toBe('x ∈ ℝ');
    expect(mathToPlain('n\\in\\mathbb{N}')).toBe('n ∈ ℕ');
    expect(mathToPlain('z\\notin\\mathbb{Z}')).toBe('z ∉ ℤ');
    expect(mathToPlain('\\mathbb{Q}\\subset\\mathbb{C}')).toBe('ℚ ⊂ ℂ');
  });

  it('keeps escaped literal chars readable (set braces, percent)', () => {
    expect(mathToPlain('\\mathbb{R}\\setminus\\{0\\}')).toBe('ℝ \\ {0}');
    expect(mathToPlain('\\{1;2\\}')).toBe('{1;2}');
    expect(mathToPlain('50\\,\\%')).toBe('50 %');
    expect(mathToPlain('50\\%')).toBe('50%');
  });

  it('handles the German decimal-comma group and repeating-decimal dots', () => {
    expect(mathToPlain('1{,}\\dot{4}')).toBe('1,4̇');
    expect(mathToPlain('3{,}5')).toBe('3,5');
  });

  it('unwraps \\text, \\mathrm and \\vec', () => {
    expect(mathToPlain('5\\,\\text{km}')).toBe('5 km');
    expect(mathToPlain('\\mathrm{m}')).toBe('m');
    expect(mathToPlain('\\vec{v}')).toBe('v');
  });

  it('maps super- and subscripts to real characters where they exist', () => {
    expect(mathToPlain('x^2')).toBe('x²');
    expect(mathToPlain('x^{2}')).toBe('x²');
    expect(mathToPlain('10^{-3}')).toBe('10⁻³');
    expect(mathToPlain('2^n')).toBe('2ⁿ');
    expect(mathToPlain('x^{10}')).toBe('x¹⁰');
    expect(mathToPlain('a_1')).toBe('a₁');
    expect(mathToPlain('a_{12}')).toBe('a₁₂');
    expect(mathToPlain('a_n')).toBe('aₙ');
  });

  it('falls back readably for unmappable super-/subscripts', () => {
    expect(mathToPlain('x^{y}')).toBe('x^(y)');
    expect(mathToPlain('x^y')).toBe('x^(y)');
    expect(mathToPlain('a_{Bq}')).toBe('a_Bq');
  });

  it('drops \\left/\\right and sizing/space commands', () => {
    expect(mathToPlain('\\left(\\tfrac{1}{2}\\right)')).toBe('(1/2)');
    expect(mathToPlain('a\\,b')).toBe('a b');
    expect(mathToPlain('a\\;b')).toBe('a b');
    expect(mathToPlain('a\\!b')).toBe('ab');
  });

  it('degrades any unknown \\word to its bare word and strips stray braces', () => {
    expect(mathToPlain('\\sin(x)')).toBe('sin(x)');
    expect(mathToPlain('\\sin x')).toBe('sin x'); // command-terminator space kept
    expect(mathToPlain('\\log_2 8')).toBe('log₂ 8');
    expect(mathToPlain('{a+b}')).toBe('a+b');
  });

  it('leaves command-free sources untouched', () => {
    expect(mathToPlain('a<b')).toBe('a<b');
    expect(mathToPlain('f(x)=2x+1')).toBe('f(x)=2x+1');
  });
});

describe('richTextToPlain', () => {
  it('passes plain-text-only RichText through unchanged', () => {
    const rt: RichText = [{ t: 'text', v: 'Exponentialfunktion' }];
    expect(richTextToPlain(rt)).toBe('Exponentialfunktion');
  });

  it('projects math nodes through mathToPlain', () => {
    const rt: RichText = [
      { t: 'text', v: 'Radius ' },
      { t: 'math', v: '\\sqrt{7}' },
    ];
    expect(richTextToPlain(rt)).toBe('Radius √7');
  });

  it('no longer leaks raw LaTeX for the live-repro option labels', () => {
    expect(richTextToPlain([{ t: 'math', v: '\\sqrt{7}' }])).toBe('√7');
    expect(richTextToPlain([{ t: 'math', v: '\\tfrac{\\pi}{4}' }])).toBe('π/4');
    expect(richTextToPlain([{ t: 'math', v: '1{,}\\dot{4}' }])).toBe('1,4̇');
  });

  it('uses fig alt text and handles undefined', () => {
    expect(richTextToPlain([{ t: 'fig', src: 'a.png', alt: 'Skizze' }])).toBe('Skizze');
    expect(richTextToPlain(undefined)).toBe('');
  });
});
