import { describe, expect, it } from 'vitest';
import bank from './fixtures/sample-questions.json';
import { gradeChoice } from '../src/grading/choice.js';
import type { ChoiceAnswer, Question, QuestionPart, Scoring } from '../src/model/question.js';
import type { BreakdownItem, ChoiceSubmission } from '../src/grading/types.js';

const questions = (bank as unknown as { questions: Question[] }).questions;
function fixturePart(qid: string, pid: string): QuestionPart {
  const p = questions.find((q) => q.id === qid)?.parts.find((x) => x.id === pid);
  if (!p) throw new Error(`fixture missing ${qid}/${pid}`);
  return p;
}

// 2019-ht-t1-01-a: "2 aus 5", correct [1,3], allOrNothing 1 point.
const part = fixturePart('2019-ht-t1-01', '2019-ht-t1-01-a');
const answer = part.answer as ChoiceAnswer;
const sub = (selected: number[]): ChoiceSubmission => ({ kind: 'choice', selected });
const note = (b: BreakdownItem[] | undefined, ref: string): string | undefined =>
  b?.find((x) => x.ref === ref)?.note;

describe('gradeChoice — real 2-aus-5 fixture (allOrNothing)', () => {
  it('exact correct set → correct, full points', () => {
    const r = gradeChoice(answer, sub([1, 3]), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 });
  });

  it('selection order does not matter', () => {
    const r = gradeChoice(answer, sub([3, 1]), part.scoring, part.points);
    expect(r.verdict).toBe('correct');
  });

  it('duplicate selections are deduped', () => {
    const r = gradeChoice(answer, sub([1, 1, 3, 3]), part.scoring, part.points);
    expect(r.verdict).toBe('correct');
    expect(r.awardedPoints).toBe(1);
  });

  it('one right + one wrong → incorrect (no partial credit invented)', () => {
    const r = gradeChoice(answer, sub([1, 2]), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 });
  });

  it('subset of the correct set → incorrect under allOrNothing', () => {
    const r = gradeChoice(answer, sub([1]), part.scoring, part.points);
    expect(r.verdict).toBe('incorrect');
    expect(r.awardedPoints).toBe(0);
  });

  it('superset (all correct + one extra) → incorrect', () => {
    const r = gradeChoice(answer, sub([1, 3, 4]), part.scoring, part.points);
    expect(r.verdict).toBe('incorrect');
  });

  it('empty selection → incorrect', () => {
    const r = gradeChoice(answer, sub([]), part.scoring, part.points);
    expect(r.verdict).toBe('incorrect');
  });

  it('selection outside the option range breaks set equality', () => {
    const r = gradeChoice(answer, sub([1, 99]), part.scoring, part.points);
    expect(r.verdict).toBe('incorrect');
  });
});

describe('gradeChoice — breakdown per option index', () => {
  it('labels correct-pick / wrong-pick / missed; no note when correctly unselected', () => {
    const r = gradeChoice(answer, sub([1, 2]), part.scoring, part.points);
    expect(r.breakdown).toHaveLength(5);
    expect(note(r.breakdown, '1')).toBe('correct-pick');
    expect(note(r.breakdown, '2')).toBe('wrong-pick');
    expect(note(r.breakdown, '3')).toBe('missed');
    expect(note(r.breakdown, '0')).toBeUndefined();
    expect(note(r.breakdown, '4')).toBeUndefined();
    // note key must be OMITTED for correctly-unselected options, not undefined
    expect('note' in (r.breakdown?.find((x) => x.ref === '0') ?? {})).toBe(false);
  });

  it('breakdown correct flags reflect pick-state agreement', () => {
    const r = gradeChoice(answer, sub([1, 2]), part.scoring, part.points);
    const flags = Object.fromEntries((r.breakdown ?? []).map((b) => [b.ref, b.correct]));
    expect(flags).toEqual({ '0': true, '1': true, '2': false, '3': false, '4': true });
  });
});

describe('gradeChoice — perBlank / tiered use correctly-SELECTED count', () => {
  const perBlank: Scoring = { mode: 'perBlank', pointsPerCorrect: 0.5, max: 1 };

  it('perBlank: one correct pick + one wrong pick → 0.5, partial (wrong pick is no penalty)', () => {
    const r = gradeChoice(answer, sub([1, 2]), perBlank, part.points);
    expect(r).toMatchObject({ verdict: 'partial', correct: false, awardedPoints: 0.5, maxPoints: 1 });
  });

  it('perBlank: both correct picks → full, correct', () => {
    const r = gradeChoice(answer, sub([1, 3]), perBlank, part.points);
    expect(r).toMatchObject({ verdict: 'correct', awardedPoints: 1, maxPoints: 1 });
  });

  it('tiered: single correct pick reaches the first tier', () => {
    const tiered: Scoring = {
      mode: 'tiered',
      tiers: [
        { minCorrect: 1, points: 0.5 },
        { minCorrect: 2, points: 1 },
      ],
    };
    const r = gradeChoice(answer, sub([1]), tiered, part.points);
    expect(r).toMatchObject({ verdict: 'partial', awardedPoints: 0.5, maxPoints: 1 });
  });
});

describe('gradeChoice — missing scoring falls back to points ?? 1', () => {
  it('uses part.points as allOrNothing', () => {
    const r = gradeChoice(answer, sub([1, 3]), undefined, 3);
    expect(r).toMatchObject({ awardedPoints: 3, maxPoints: 3, verdict: 'correct' });
  });

  it('defaults to 1 point without scoring and points', () => {
    const r = gradeChoice(answer, sub([1, 3]), undefined, undefined);
    expect(r).toMatchObject({ awardedPoints: 1, maxPoints: 1 });
  });
});
