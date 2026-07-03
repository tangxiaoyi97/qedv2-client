import { describe, expect, it } from 'vitest';
import bank from './fixtures/sample-questions.json';
import { gradeOpen } from '../src/grading/open.js';
import type { OpenAnswer, Question, QuestionPart, Scoring } from '../src/model/question.js';
import type { OpenSubmission, SelfAssessment } from '../src/grading/types.js';

const questions = (bank as unknown as { questions: Question[] }).questions;
function fixturePart(qid: string, pid: string): QuestionPart {
  const p = questions.find((q) => q.id === qid)?.parts.find((x) => x.id === pid);
  if (!p) throw new Error(`fixture missing ${qid}/${pid}`);
  return p;
}

// 2019-ht-t2-01-b2: open, grader "ai" (treated as self), rubric with one
// 1-point criterion.
const part = fixturePart('2019-ht-t2-01', '2019-ht-t2-01-b2');
const answer = part.answer as OpenAnswer;
const sub = (selfAssessment: SelfAssessment, text = 'auf Papier'): OpenSubmission => ({
  kind: 'open',
  text,
  selfAssessment,
});

describe('gradeOpen — rubric self-assessment (real fixture, 1 criterion)', () => {
  it('criterion met → full points, correct', () => {
    const r = gradeOpen(answer, sub({ criteriaMet: [true] }), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 });
    expect(r.breakdown).toEqual([{ ref: '0', correct: true, awardedPoints: 1 }]);
  });

  it('criterion not met → 0, incorrect', () => {
    const r = gradeOpen(answer, sub({ criteriaMet: [false] }), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 });
  });

  it('missing criteriaMet array → everything unmet', () => {
    const r = gradeOpen(answer, sub({}), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'incorrect', awardedPoints: 0, maxPoints: 1 });
  });

  it('empty text is allowed ("answered on paper")', () => {
    const r = gradeOpen(answer, sub({ criteriaMet: [true] }, ''), part.scoring, part.points);
    expect(r.verdict).toBe('correct');
  });

  it('overall is ignored when scoring is rubric', () => {
    const r = gradeOpen(answer, sub({ overall: 'full' }), part.scoring, part.points);
    expect(r).toMatchObject({ verdict: 'incorrect', awardedPoints: 0 });
  });
});

describe('gradeOpen — multi-criterion rubric sums', () => {
  const rubric: Scoring = {
    mode: 'rubric',
    criteria: [
      { desc: [{ t: 'text', v: 'Ansatz' }], points: 2 },
      { desc: [{ t: 'text', v: 'Rechnung' }], points: 1 },
      { desc: [{ t: 'text', v: 'Interpretation' }], points: 1 },
    ],
  };

  it('partial subset met → summed points, partial verdict, per-criterion breakdown', () => {
    const r = gradeOpen(answer, sub({ criteriaMet: [true, false, true] }), rubric, undefined);
    expect(r).toMatchObject({ verdict: 'partial', correct: false, awardedPoints: 3, maxPoints: 4 });
    expect(r.breakdown).toEqual([
      { ref: '0', correct: true, awardedPoints: 2 },
      { ref: '1', correct: false, awardedPoints: 0 },
      { ref: '2', correct: true, awardedPoints: 1 },
    ]);
  });

  it('short criteriaMet array → trailing criteria treated unmet', () => {
    const r = gradeOpen(answer, sub({ criteriaMet: [true] }), rubric, undefined);
    expect(r).toMatchObject({ verdict: 'partial', awardedPoints: 2, maxPoints: 4 });
  });

  it('all met → correct with full sum', () => {
    const r = gradeOpen(answer, sub({ criteriaMet: [true, true, true] }), rubric, undefined);
    expect(r).toMatchObject({ verdict: 'correct', awardedPoints: 4, maxPoints: 4 });
  });

  it('none met → incorrect', () => {
    const r = gradeOpen(answer, sub({ criteriaMet: [false, false, false] }), rubric, undefined);
    expect(r).toMatchObject({ verdict: 'incorrect', awardedPoints: 0, maxPoints: 4 });
  });
});

describe('gradeOpen — overall self-assessment (non-rubric)', () => {
  const allOrNothing: Scoring = { mode: 'allOrNothing', points: 2 };

  it('full → maxPoints, correct', () => {
    const r = gradeOpen(answer, sub({ overall: 'full' }), allOrNothing, undefined);
    expect(r).toMatchObject({ verdict: 'correct', correct: true, awardedPoints: 2, maxPoints: 2 });
    expect(r.breakdown).toBeUndefined();
  });

  it('partial → half of maxPoints, partial', () => {
    const r = gradeOpen(answer, sub({ overall: 'partial' }), allOrNothing, undefined);
    expect(r).toMatchObject({ verdict: 'partial', correct: false, awardedPoints: 1, maxPoints: 2 });
  });

  it('none → 0, incorrect', () => {
    const r = gradeOpen(answer, sub({ overall: 'none' }), allOrNothing, undefined);
    expect(r).toMatchObject({ verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 2 });
  });

  it('missing overall counts as none', () => {
    const r = gradeOpen(answer, sub({}), allOrNothing, undefined);
    expect(r).toMatchObject({ verdict: 'incorrect', awardedPoints: 0 });
  });

  it('no scoring: falls back to points ?? 1; partial gives 0.5', () => {
    const r = gradeOpen(answer, sub({ overall: 'partial' }), undefined, undefined);
    expect(r).toMatchObject({ verdict: 'partial', awardedPoints: 0.5, maxPoints: 1 });
  });

  it('half points are rounded to 2 decimals (0.25 → 0.13)', () => {
    const r = gradeOpen(answer, sub({ overall: 'partial' }), undefined, 0.25);
    expect(r).toMatchObject({ verdict: 'partial', awardedPoints: 0.13, maxPoints: 0.25 });
  });

  it('odd maxPoints halve cleanly (5 → 2.5)', () => {
    const r = gradeOpen(answer, sub({ overall: 'partial' }), { mode: 'allOrNothing', points: 5 }, undefined);
    expect(r).toMatchObject({ verdict: 'partial', awardedPoints: 2.5, maxPoints: 5 });
  });
});
