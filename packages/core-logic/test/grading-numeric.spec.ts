import { describe, expect, it } from 'vitest';
import bank from './fixtures/sample-questions.json';
import { gradeNumeric, parseDecimalInput } from '../src/grading/numeric.js';
import type { NumericAnswer, Question, QuestionPart, Scoring } from '../src/model/question.js';
import type { BreakdownItem, NumericSubmission } from '../src/grading/types.js';

const questions = (bank as unknown as { questions: Question[] }).questions;
function fixturePart(qid: string, pid: string): QuestionPart {
  const p = questions.find((q) => q.id === qid)?.parts.find((x) => x.id === pid);
  if (!p) throw new Error(`fixture missing ${qid}/${pid}`);
  return p;
}

// 2019-ht-t1-02-a: blank "v", value 37.5, tol 0.5, unit "km/h", allOrNothing 1.
const part = fixturePart('2019-ht-t1-02', '2019-ht-t1-02-a');
const answer = part.answer as NumericAnswer;
const sub = (values: Record<string, string>): NumericSubmission => ({ kind: 'numeric', values });
const item = (b: BreakdownItem[] | undefined, ref: string): BreakdownItem | undefined =>
  b?.find((x) => x.ref === ref);

describe('parseDecimalInput', () => {
  it('accepts point and comma decimals', () => {
    expect(parseDecimalInput('37.5')).toBe(37.5);
    expect(parseDecimalInput('37,5')).toBe(37.5);
    expect(parseDecimalInput('-0,25')).toBe(-0.25);
    expect(parseDecimalInput('+2')).toBe(2);
    expect(parseDecimalInput(',5')).toBe(0.5);
  });

  it('accepts the unicode minus U+2212', () => {
    expect(parseDecimalInput('−5')).toBe(-5);
    expect(parseDecimalInput('−12,5')).toBe(-12.5);
  });

  it('rejects thousands grouping and mixed separators', () => {
    expect(parseDecimalInput('1.234,5')).toBeUndefined();
    expect(parseDecimalInput('1,234.5')).toBeUndefined();
    expect(parseDecimalInput('1,2,3')).toBeUndefined();
  });

  it('rejects non-numbers', () => {
    expect(parseDecimalInput('abc')).toBeUndefined();
    expect(parseDecimalInput('12x')).toBeUndefined();
    expect(parseDecimalInput('')).toBeUndefined();
    expect(parseDecimalInput('-')).toBeUndefined();
    expect(parseDecimalInput('3.')).toBeUndefined();
  });
});

describe('gradeNumeric — real km/h fixture (allOrNothing)', () => {
  it('comma decimal "37,5" is correct', () => {
    const r = gradeNumeric(answer, sub({ v: '37,5' }), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 });
  });

  it('point decimal "37.5" is correct', () => {
    expect(gradeNumeric(answer, sub({ v: '37.5' }), part.scoring, part.points).verdict).toBe('correct');
  });

  it('tolerance edges 37 and 38 are inside (tol 0.5)', () => {
    expect(gradeNumeric(answer, sub({ v: '37' }), part.scoring, part.points).verdict).toBe('correct');
    expect(gradeNumeric(answer, sub({ v: '38' }), part.scoring, part.points).verdict).toBe('correct');
  });

  it('just outside tolerance → incorrect with out-of-tolerance note', () => {
    const r = gradeNumeric(answer, sub({ v: '38,001' }), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'incorrect', awardedPoints: 0 });
    expect(item(r.breakdown, 'v')).toMatchObject({ correct: false, note: 'out-of-tolerance' });
  });

  it('typed unit suffix is stripped ("38 km/h", "37,5km/h", case-insensitive)', () => {
    expect(gradeNumeric(answer, sub({ v: '38 km/h' }), part.scoring, part.points).verdict).toBe('correct');
    expect(gradeNumeric(answer, sub({ v: '37,5km/h' }), part.scoring, part.points).verdict).toBe('correct');
    expect(gradeNumeric(answer, sub({ v: '37.5 KM/H' }), part.scoring, part.points).verdict).toBe('correct');
  });

  it('unit alone is unparseable', () => {
    const r = gradeNumeric(answer, sub({ v: 'km/h' }), part.scoring, part.points);
    expect(item(r.breakdown, 'v')).toMatchObject({ correct: false, note: 'unparseable' });
  });

  it('missing / empty input → note missing', () => {
    const missing = gradeNumeric(answer, sub({}), part.scoring, part.points);
    expect(item(missing.breakdown, 'v')).toMatchObject({ correct: false, note: 'missing' });
    const empty = gradeNumeric(answer, sub({ v: '   ' }), part.scoring, part.points);
    expect(item(empty.breakdown, 'v')).toMatchObject({ correct: false, note: 'missing' });
    expect(empty.verdict).toBe('incorrect');
  });

  it('garbage input → note unparseable', () => {
    const r = gradeNumeric(answer, sub({ v: 'schnell' }), part.scoring, part.points);
    expect(item(r.breakdown, 'v')).toMatchObject({ correct: false, note: 'unparseable' });
  });
});

describe('gradeNumeric — fp-exact tolerance edge (0.935 ± 0.005 fixture)', () => {
  // 0.94 - 0.935 evaluates to 0.005000...0004 in IEEE-754; the 1e-12 guard
  // must keep the exact-edge answer correct.
  const p2 = fixturePart('2019-ht-t2-01', '2019-ht-t2-01-a2');
  const a2 = p2.answer as NumericAnswer;

  it('"0,94" is exactly on the edge and counts as correct', () => {
    expect(gradeNumeric(a2, sub({ pneu: '0,94' }), p2.scoring, p2.points).verdict).toBe('correct');
    expect(gradeNumeric(a2, sub({ pneu: '0.93' }), p2.scoring, p2.points).verdict).toBe('correct');
  });

  it('"0,941" is outside', () => {
    expect(gradeNumeric(a2, sub({ pneu: '0,941' }), p2.scoring, p2.points).verdict).toBe('incorrect');
  });
});

describe('gradeNumeric — multi-blank perBlank scoring', () => {
  const multi: NumericAnswer = {
    kind: 'numeric',
    blanks: [
      { id: 'a', value: 2, tol: 0 },
      { id: 'b', value: -5, tol: 0.1, unit: 'm' },
    ],
  };
  const perBlank: Scoring = { mode: 'perBlank', pointsPerCorrect: 1, max: 2 };

  it('one right, one wrong → half points, partial, per-blank awardedPoints', () => {
    const r = gradeNumeric(multi, sub({ a: '2', b: '7' }), perBlank, undefined);
    expect(r).toMatchObject({ verdict: 'partial', correct: false, awardedPoints: 1, maxPoints: 2 });
    expect(item(r.breakdown, 'a')).toMatchObject({ correct: true, awardedPoints: 1 });
    expect(item(r.breakdown, 'b')).toMatchObject({ correct: false, awardedPoints: 0 });
  });

  it('unicode minus and unit strip work together ("−5 m")', () => {
    const r = gradeNumeric(multi, sub({ a: '2', b: '−5 m' }), perBlank, undefined);
    expect(r).toMatchObject({ verdict: 'correct', awardedPoints: 2, maxPoints: 2 });
  });

  it('all blanks missing → incorrect, 0 points', () => {
    const r = gradeNumeric(multi, sub({}), perBlank, undefined);
    expect(r).toMatchObject({ verdict: 'incorrect', awardedPoints: 0, maxPoints: 2 });
    expect(r.breakdown?.map((b) => b.note)).toEqual(['missing', 'missing']);
  });

  it('no per-blank awardedPoints outside perBlank mode', () => {
    const r = gradeNumeric(multi, sub({ a: '2', b: '-5' }), undefined, 1);
    expect('awardedPoints' in (item(r.breakdown, 'a') ?? {})).toBe(false);
  });
});
