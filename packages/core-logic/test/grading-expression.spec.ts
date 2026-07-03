import { describe, expect, it } from 'vitest';
import { create, all } from 'mathjs';
import type { FactoryFunctionMap } from 'mathjs';
import { gradeExpression } from '../src/grading/expression.js';
import { latexToMathjs, LatexConversionError } from '../src/grading/latex.js';
import type { ExpressionSubmission, GradeOutcome } from '../src/grading/types.js';
import type { ExpressionAnswer, Question, Scoring } from '../src/model/question.js';
import sampleQuestions from './fixtures/sample-questions.json';

// `all` is typed as possibly-undefined only because of noUncheckedIndexedAccess.
const math = create(all as FactoryFunctionMap);

const answer = (canonical: string, vars: string[]): ExpressionAnswer => ({
  kind: 'expression',
  canonical,
  vars,
  checker: 'cas',
});

const sub = (expr: string): ExpressionSubmission => ({ kind: 'expression', expr });

const grade = (
  canonical: string,
  vars: string[],
  expr: string,
  scoring?: Scoring,
  points?: number,
): GradeOutcome => gradeExpression(answer(canonical, vars), sub(expr), scoring, points);

describe('latexToMathjs', () => {
  it('maps operators, decimal comma and pi', () => {
    expect(latexToMathjs('x_n\\cdot 1{,}03')).toBe('xn* 1.03');
    expect(latexToMathjs('a\\times b')).toBe('a* b');
    expect(latexToMathjs('2\\pi')).toBe('2pi');
  });

  it('converts \\frac with nested braces', () => {
    expect(latexToMathjs('\\frac{1}{2}')).toBe('((1)/(2))');
    expect(latexToMathjs('\\frac{\\frac{1}{2}}{3}')).toBe('((((1)/(2)))/(3))');
  });

  it('converts \\sqrt and \\sqrt[n]', () => {
    expect(latexToMathjs('\\sqrt{x}')).toBe('sqrt(x)');
    expect(latexToMathjs('\\sqrt[3]{x+1}')).toBe('nthRoot(x+1,3)');
  });

  it('strips \\left/\\right and spacing macros', () => {
    expect(latexToMathjs('\\left(x+1\\right)')).toBe('(x+1)');
    expect(latexToMathjs('2\\,x')).toBe('2x');
    expect(latexToMathjs('a\\;b\\quad c')).toBe('ab c');
  });

  it('flattens subscripts into plain identifiers', () => {
    expect(latexToMathjs('x_n')).toBe('xn');
    expect(latexToMathjs('x_{max}')).toBe('xmax');
    expect(latexToMathjs('p_1\\cdot p_2')).toBe('p1* p2');
  });

  it('converts exponent groups, percent, log/ln', () => {
    expect(latexToMathjs('e^{x}')).toBe('e^(x)');
    expect(latexToMathjs('(1-p)^{2}')).toBe('(1-p)^(2)');
    expect(latexToMathjs('50\\%')).toBe('50/100');
    expect(latexToMathjs('\\ln{x}')).toBe('log(x)');
    expect(latexToMathjs('\\log{x}')).toBe('log10(x)');
  });

  it('turns remaining grouping braces into parentheses', () => {
    expect(latexToMathjs('2^{x+1}{x}')).toBe('2^(x+1)(x)');
  });

  it('throws on unknown commands and unbalanced braces', () => {
    expect(() => latexToMathjs('\\unknowncmd{x}')).toThrow(LatexConversionError);
    expect(() => latexToMathjs('{x')).toThrow(LatexConversionError);
    expect(() => latexToMathjs('x}')).toThrow(LatexConversionError);
  });
});

describe('gradeExpression — real canonical x_n\\cdot 1{,}03', () => {
  const canonical = 'x_n\\cdot 1{,}03';
  const vars = ['x_n'];

  it.each(['1.03*x_n', '1,03x_n', 'x_n*1.03'])('accepts %s', (expr) => {
    const r = grade(canonical, vars, expr);
    expect(r.verdict).toBe('correct');
    if (r.verdict !== 'indeterminate') {
      expect(r.correct).toBe(true);
      expect(r.awardedPoints).toBe(1);
      expect(r.maxPoints).toBe(1);
    }
  });

  it('rejects x_n*1.3 (wrong factor)', () => {
    const r = grade(canonical, vars, 'x_n*1.3');
    expect(r.verdict).toBe('incorrect');
    if (r.verdict !== 'indeterminate') expect(r.awardedPoints).toBe(0);
  });
});

describe('gradeExpression — algebraic equivalence', () => {
  it('(x-2)(x+2) ≡ x^2-4', () => {
    expect(grade('(x-2)(x+2)', ['x'], 'x^2-4').verdict).toBe('correct');
  });

  it('2x+3 ≡ 3+2x', () => {
    expect(grade('2x+3', ['x'], '3+2x').verdict).toBe('correct');
  });

  it('\\frac{1}{2}x ≡ 0.5x and x/2', () => {
    expect(grade('\\frac{1}{2}x', ['x'], '0.5x').verdict).toBe('correct');
    expect(grade('\\frac{1}{2}x', ['x'], 'x/2').verdict).toBe('correct');
  });

  it('unicode operators and sqrt are accepted', () => {
    expect(grade('2\\cdot x-4', ['x'], '2·x −4').verdict).toBe('correct');
    expect(grade('\\sqrt{x}', ['x'], '√x').verdict).toBe('correct');
  });

  it('sqrt(x^2) is NOT equivalent to x (negative sample points)', () => {
    const r = grade('\\sqrt{x^{2}}', ['x'], 'x');
    expect(r.verdict).not.toBe('correct');
    expect(['incorrect', 'indeterminate']).toContain(r.verdict);
  });
});

describe('gradeExpression — left-hand-side stripping', () => {
  it('strips f(x)= from the user input', () => {
    expect(grade('2\\cdot x-4', ['x'], 'f(x)=2x-4').verdict).toBe('correct');
  });

  it('strips y= from the user input', () => {
    expect(grade('2\\cdot x-4', ['x'], 'y = 2x - 4').verdict).toBe('correct');
  });

  it('strips a LHS on the canonical too', () => {
    expect(grade('f(x)=2\\cdot x-4', ['x'], '2x-4').verdict).toBe('correct');
  });
});

describe('gradeExpression — degradation paths', () => {
  it('unparsable canonical → indeterminate cas-parse-error', () => {
    const r = grade('\\unknowncmd{x}', ['x'], 'x');
    expect(r.verdict).toBe('indeterminate');
    if (r.verdict === 'indeterminate') {
      expect(r.reason).toBe('cas-parse-error');
      expect(r.maxPoints).toBe(1);
    }
  });

  it('empty / whitespace-only user input → incorrect with 0 points', () => {
    for (const expr of ['', '   ']) {
      const r = grade('x_n\\cdot 1{,}03', ['x_n'], expr);
      expect(r.verdict).toBe('incorrect');
      if (r.verdict !== 'indeterminate') {
        expect(r.awardedPoints).toBe(0);
        expect(r.maxPoints).toBe(1);
      }
    }
  });

  it('garbage user input is never graded correct', () => {
    const r = grade('x_n\\cdot 1{,}03', ['x_n'], '@@@');
    expect(r.verdict).not.toBe('correct');
    expect(['incorrect', 'indeterminate']).toContain(r.verdict);
  });

  it('user expression over unknown symbols degrades, never throws', () => {
    const r = grade('x_n\\cdot 1{,}03', ['x_n'], 'q*1.03');
    expect(r.verdict).not.toBe('correct');
  });
});

describe('gradeExpression — scoring', () => {
  it('uses allOrNothing points when present', () => {
    const scoring: Scoring = { mode: 'allOrNothing', points: 2 };
    const ok = grade('2x+3', ['x'], '3+2x', scoring, 1);
    expect(ok).toEqual({ verdict: 'correct', correct: true, awardedPoints: 2, maxPoints: 2 });
    const bad = grade('2x+3', ['x'], '3+2x+1', scoring, 1);
    expect(bad).toEqual({ verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 2 });
  });

  it('falls back to points ?? 1 without scoring', () => {
    const r = grade('2x+3', ['x'], '3+2x', undefined, 3);
    if (r.verdict !== 'indeterminate') expect(r.awardedPoints).toBe(3);
    expect(grade('2x+3', ['x'], '3+2x').maxPoints).toBe(1);
  });

  it('indeterminate outcomes carry maxPoints from scoring', () => {
    const r = grade('\\unknowncmd{x}', ['x'], 'x', { mode: 'allOrNothing', points: 2 });
    expect(r.maxPoints).toBe(2);
  });
});

describe('real bank canonicals (fixtures)', () => {
  const bank = sampleQuestions as unknown as { questions: Question[] };
  const expressionAnswers: { id: string; answer: ExpressionAnswer }[] = [];
  for (const q of bank.questions) {
    for (const p of q.parts) {
      if (p.answer?.kind === 'expression') {
        expressionAnswers.push({ id: p.id, answer: p.answer });
      }
    }
  }

  it('fixtures contain the expected expression parts', () => {
    const ids = expressionAnswers.map((e) => e.id);
    expect(ids).toContain('2019-ht-t1-14-a');
    expect(ids).toContain('2019-ht-t2-01-a1');
    expect(ids).toContain('2019-ht-t2-01-b1');
  });

  it.each(expressionAnswers.map((e) => [e.id, e.answer] as const))(
    '%s canonical round-trips into mathjs-parsable syntax',
    (_id, a) => {
      // If latexToMathjs cannot convert a real canonical, the grader must
      // degrade to indeterminate instead of throwing — assert both layers.
      let converted: string | undefined;
      expect(() => {
        converted = latexToMathjs(a.canonical);
      }).not.toThrow();
      expect(() => math.parse(converted!)).not.toThrow();
      expect(() => gradeExpression(a, sub('x'), undefined, 1)).not.toThrow();
    },
  );

  it('grades 1-(1-p)^2 against its expansion 2p-p^2', () => {
    const b1 = expressionAnswers.find((e) => e.id === '2019-ht-t2-01-b1')!;
    expect(gradeExpression(b1.answer, sub('2p-p^2'), undefined, 1).verdict).toBe('correct');
    expect(gradeExpression(b1.answer, sub('2p-p'), undefined, 1).verdict).toBe('incorrect');
  });

  it('grades p_1\\cdot p_2 with two variables', () => {
    const a1 = expressionAnswers.find((e) => e.id === '2019-ht-t2-01-a1')!;
    expect(gradeExpression(a1.answer, sub('p_2 * p_1'), undefined, 1).verdict).toBe('correct');
    expect(gradeExpression(a1.answer, sub('p_1 + p_2'), undefined, 1).verdict).toBe('incorrect');
  });
});
