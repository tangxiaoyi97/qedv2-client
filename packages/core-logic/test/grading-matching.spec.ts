import { describe, expect, it } from 'vitest';
import bank from './fixtures/sample-questions.json';
import { gradeMatching } from '../src/grading/matching.js';
import type { MatchingAnswer, Question, QuestionPart } from '../src/model/question.js';
import type { BreakdownItem, MatchingSubmission } from '../src/grading/types.js';

const questions = (bank as unknown as { questions: Question[] }).questions;
function fixturePart(qid: string, pid: string): QuestionPart {
  const p = questions.find((q) => q.id === qid)?.parts.find((x) => x.id === pid);
  if (!p) throw new Error(`fixture missing ${qid}/${pid}`);
  return p;
}

// 2019-ht-t1-12-a: 2 left, 6 right, pairs [[0,1],[1,4]],
// tiered [{minCorrect:1, points:0.5}, {minCorrect:2, points:1}].
const part = fixturePart('2019-ht-t1-12', '2019-ht-t1-12-a');
const answer = part.answer as MatchingAnswer;
const sub = (matches: (number | null)[]): MatchingSubmission => ({ kind: 'matching', matches });
const item = (b: BreakdownItem[] | undefined, ref: string): BreakdownItem | undefined =>
  b?.find((x) => x.ref === ref);

describe('gradeMatching — real tiered fixture', () => {
  it('both pairs matched → 1 point, correct', () => {
    const r = gradeMatching(answer, sub([1, 4]), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 });
  });

  it('1 of 2 pairs → tier 1 → 0.5 points, partial', () => {
    const r = gradeMatching(answer, sub([1, 2]), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'partial', correct: false, awardedPoints: 0.5, maxPoints: 1 });
    expect(item(r.breakdown, '0')?.correct).toBe(true);
    expect(item(r.breakdown, '1')).toMatchObject({ correct: false, note: 'wrong-match' });
  });

  it('unassigned pair (null) is wrong but the other still scores a tier', () => {
    const r = gradeMatching(answer, sub([1, null]), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'partial', awardedPoints: 0.5, maxPoints: 1 });
    expect(item(r.breakdown, '1')).toMatchObject({ correct: false, note: 'unassigned' });
  });

  it('no pair matched → 0 points, incorrect', () => {
    const r = gradeMatching(answer, sub([2, 0]), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 });
  });

  it('everything unassigned → incorrect with unassigned notes', () => {
    const r = gradeMatching(answer, sub([null, null]), part.scoring, part.points);
    expect(r.verdict).toBe('incorrect');
    expect(r.breakdown?.every((b) => b.note === 'unassigned')).toBe(true);
  });

  it('matches array shorter than left list → missing entries count as unassigned', () => {
    const r = gradeMatching(answer, sub([1]), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'partial', awardedPoints: 0.5 });
    expect(item(r.breakdown, '1')).toMatchObject({ correct: false, note: 'unassigned' });
  });

  it('swapped rights are simply two wrong matches', () => {
    const r = gradeMatching(answer, sub([4, 1]), part.scoring, part.points);
    expect(r.verdict).toBe('incorrect');
    expect(r.breakdown?.map((b) => b.note)).toEqual(['wrong-match', 'wrong-match']);
  });

  it('breakdown refs are left indices as strings', () => {
    const r = gradeMatching(answer, sub([1, 4]), part.scoring, part.points);
    expect(r.breakdown?.map((b) => b.ref)).toEqual(['0', '1']);
  });
});

describe('gradeMatching — scoring fallbacks', () => {
  it('no scoring → allOrNothing on points ?? 1: perfect', () => {
    const r = gradeMatching(answer, sub([1, 4]), undefined, undefined);
    expect(r).toMatchObject({ verdict: 'correct', awardedPoints: 1, maxPoints: 1 });
  });

  it('no scoring → allOrNothing: one wrong pair kills all points', () => {
    const r = gradeMatching(answer, sub([1, 2]), undefined, 2);
    expect(r).toMatchObject({ verdict: 'incorrect', awardedPoints: 0, maxPoints: 2 });
  });

  it('perBlank counts exactly-matched pairs', () => {
    const r = gradeMatching(
      answer,
      sub([1, 0]),
      { mode: 'perBlank', pointsPerCorrect: 1, max: 2 },
      part.points,
    );
    expect(r).toMatchObject({ verdict: 'partial', awardedPoints: 1, maxPoints: 2 });
  });
});
