import { describe, expect, it } from 'vitest';
import bank from './fixtures/sample-questions.json';
import { gradeInterval, parseBoundInput } from '../src/grading/interval.js';
import type { IntervalAnswer, Question, QuestionPart } from '../src/model/question.js';
import type { BreakdownItem, IntervalSubmission } from '../src/grading/types.js';

const questions = (bank as unknown as { questions: Question[] }).questions;
function fixturePart(qid: string, pid: string): QuestionPart {
  const p = questions.find((q) => q.id === qid)?.parts.find((x) => x.id === pid);
  if (!p) throw new Error(`fixture missing ${qid}/${pid}`);
  return p;
}

// 2019-ht-t1-03-a: (-12, -8) open/open, allOrNothing 1.
const part = fixturePart('2019-ht-t1-03', '2019-ht-t1-03-a');
const answer = part.answer as IntervalAnswer;

const sub = (
  lower: string,
  upper: string,
  lowerClosed = false,
  upperClosed = false,
): IntervalSubmission => ({ kind: 'interval', lower, upper, lowerClosed, upperClosed });
const item = (b: BreakdownItem[] | undefined, ref: string): BreakdownItem | undefined =>
  b?.find((x) => x.ref === ref);

describe('parseBoundInput', () => {
  it('empty string means unbounded', () => {
    expect(parseBoundInput('')).toEqual({ value: null });
    expect(parseBoundInput('   ')).toEqual({ value: null });
  });

  it('all infinity notations, case-insensitive, optional sign', () => {
    for (const s of ['-inf', 'inf', '-∞', '∞', '-oo', 'oo', 'INF', '-Inf', '+oo', '−∞', '+∞', 'OO']) {
      expect(parseBoundInput(s)).toEqual({ value: null });
    }
  });

  it('numbers with comma or point decimals and unicode minus', () => {
    expect(parseBoundInput('-12')).toEqual({ value: -12 });
    expect(parseBoundInput('-12,0')).toEqual({ value: -12 });
    expect(parseBoundInput('−8.5')).toEqual({ value: -8.5 });
  });

  it('garbage is unparseable', () => {
    expect(parseBoundInput('abc')).toEqual({ error: 'unparseable' });
    expect(parseBoundInput('minus zwölf')).toEqual({ error: 'unparseable' });
  });
});

describe('gradeInterval — real (-12, -8) open/open fixture', () => {
  it('exact bounds, both open → correct', () => {
    const r = gradeInterval(answer, sub('-12', '-8'), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 });
  });

  it('comma decimals and unicode minus accepted', () => {
    expect(gradeInterval(answer, sub('-12,0', '−8'), part.scoring, part.points).verdict).toBe('correct');
  });

  it('closed-flag mismatch on a finite bound → incorrect', () => {
    const r = gradeInterval(answer, sub('-12', '-8', true, false), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'incorrect', correct: false, awardedPoints: 0 });
    expect(item(r.breakdown, 'lower')).toMatchObject({ correct: false, note: 'closedness-mismatch' });
    expect(item(r.breakdown, 'upper')?.correct).toBe(true);
  });

  it('wrong bound value → incorrect with wrong-bound note', () => {
    const r = gradeInterval(answer, sub('-11', '-8'), part.scoring, part.points);
    expect(r.verdict).toBe('incorrect');
    expect(item(r.breakdown, 'lower')).toMatchObject({ correct: false, note: 'wrong-bound' });
  });

  it('unparseable bound → incorrect with unparseable note', () => {
    const r = gradeInterval(answer, sub('abc', '-8'), part.scoring, part.points);
    expect(item(r.breakdown, 'lower')).toMatchObject({ correct: false, note: 'unparseable' });
    expect(r.verdict).toBe('incorrect');
  });

  it('typing -inf where a number is expected → wrong-bound', () => {
    const r = gradeInterval(answer, sub('-inf', '-8'), part.scoring, part.points);
    expect(item(r.breakdown, 'lower')).toMatchObject({ correct: false, note: 'wrong-bound' });
  });

  it('tiny numeric noise within 1e-9 still matches', () => {
    const r = gradeInterval(answer, sub('-12.0000000001', '-8'), part.scoring, part.points);
    expect(r.verdict).toBe('correct');
  });
});

describe('gradeInterval — unbounded endpoints', () => {
  // Synthetic (-∞, 5]: lower unbounded, upper closed.
  const halfLine: IntervalAnswer = {
    kind: 'interval',
    lower: null,
    upper: 5,
    lowerClosed: false,
    upperClosed: true,
  };

  it.each(['', '-inf', '-∞', '-oo', 'INF', '+oo'])('lower input %j means unbounded', (s) => {
    const r = gradeInterval(halfLine, sub(s, '5', false, true), undefined, 1);
    expect(r.verdict).toBe('correct');
  });

  it('closed flag on an unbounded endpoint is ignored', () => {
    const r = gradeInterval(halfLine, sub('-inf', '5', true, true), undefined, 1);
    expect(r.verdict).toBe('correct');
  });

  it('finite value where the answer is unbounded → wrong', () => {
    const r = gradeInterval(halfLine, sub('-100', '5', false, true), undefined, 1);
    expect(r.verdict).toBe('incorrect');
    expect(item(r.breakdown, 'lower')).toMatchObject({ correct: false, note: 'wrong-bound' });
  });

  it('comma decimal on the finite bound, closedness enforced there', () => {
    const wrongFlag = gradeInterval(halfLine, sub('', '5,0', false, false), undefined, 1);
    expect(item(wrongFlag.breakdown, 'upper')).toMatchObject({
      correct: false,
      note: 'closedness-mismatch',
    });
    expect(wrongFlag.verdict).toBe('incorrect');
  });
});

describe('gradeInterval — scoring interaction', () => {
  it('allOrNothing (typical): one matching bound alone earns nothing', () => {
    const r = gradeInterval(answer, sub('-12', '0'), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'incorrect', awardedPoints: 0, maxPoints: 1 });
    expect(item(r.breakdown, 'lower')?.correct).toBe(true);
  });

  it('perBlank over bounds is honoured if the bank ever uses it', () => {
    const r = gradeInterval(
      answer,
      sub('-12', '0'),
      { mode: 'perBlank', pointsPerCorrect: 0.5, max: 1 },
      part.points,
    );
    expect(r).toMatchObject({ verdict: 'partial', awardedPoints: 0.5, maxPoints: 1 });
  });
});
