import { describe, expect, it } from 'vitest';
import bank from './fixtures/sample-questions.json';
import {
  grade,
  gradeChoice,
  GradingKindMismatch,
  isIndeterminate,
} from '../src/grading/index.js';
import type { ChoiceAnswer, Question, QuestionPart } from '../src/model/question.js';
import type { GradeResult, Submission } from '../src/grading/types.js';

const questions = (bank as unknown as { questions: Question[] }).questions;
function fixturePart(qid: string, pid: string): QuestionPart {
  const p = questions.find((q) => q.id === qid)?.parts.find((x) => x.id === pid);
  if (!p) throw new Error(`fixture missing ${qid}/${pid}`);
  return p;
}

const choicePart = fixturePart('2019-ht-t1-01', '2019-ht-t1-01-a');

describe('grade — guards', () => {
  it('throws on a part without answer data', () => {
    const { answer: _omitted, ...noAnswer } = choicePart;
    expect(() => grade(noAnswer, { kind: 'choice', selected: [] })).toThrow(
      'part not gradable: no answer data',
    );
  });

  it('throws GradingKindMismatch when submission kind disagrees', () => {
    const wrong: Submission = { kind: 'numeric', values: {} };
    expect(() => grade(choicePart, wrong)).toThrow(GradingKindMismatch);
    expect(() => grade(choicePart, wrong)).toThrow(
      /submission kind "numeric" does not match answer kind "choice"/,
    );
  });
});

describe('grade — dispatches to each grader', () => {
  it('choice: same result as calling gradeChoice directly', () => {
    const submission: Submission = { kind: 'choice', selected: [3, 1] };
    const viaDispatch = grade(choicePart, submission);
    const direct = gradeChoice(
      choicePart.answer as ChoiceAnswer,
      submission,
      choicePart.scoring,
      choicePart.points,
    );
    expect(viaDispatch).toEqual(direct);
    expect(viaDispatch).toMatchObject({ verdict: 'correct', awardedPoints: 1, maxPoints: 1 });
  });

  it('matching: tiered fixture partial (1 of 2 pairs → 0.5)', () => {
    const part = fixturePart('2019-ht-t1-12', '2019-ht-t1-12-a');
    const r = grade(part, { kind: 'matching', matches: [1, null] }) as GradeResult;
    expect(r).toMatchObject({ verdict: 'partial', correct: false, awardedPoints: 0.5, maxPoints: 1 });
  });

  it('numeric: comma decimal against the km/h fixture', () => {
    const part = fixturePart('2019-ht-t1-02', '2019-ht-t1-02-a');
    const r = grade(part, { kind: 'numeric', values: { v: '37,5' } }) as GradeResult;
    expect(r).toMatchObject({ verdict: 'correct', awardedPoints: 1 });
  });

  it('interval: open/open fixture with closed-flag mismatch', () => {
    const part = fixturePart('2019-ht-t1-03', '2019-ht-t1-03-a');
    const r = grade(part, {
      kind: 'interval',
      lower: '-12',
      upper: '-8',
      lowerClosed: false,
      upperClosed: true,
    }) as GradeResult;
    expect(r).toMatchObject({ verdict: 'incorrect', awardedPoints: 0 });
  });

  it('open: rubric self-assessment fixture', () => {
    const part = fixturePart('2019-ht-t2-01', '2019-ht-t2-01-b2');
    const r = grade(part, {
      kind: 'open',
      text: '',
      selfAssessment: { criteriaMet: [true] },
    }) as GradeResult;
    expect(r).toMatchObject({ verdict: 'correct', awardedPoints: 1, maxPoints: 1 });
  });

  it('expression: dispatches without pinning the CAS verdict', () => {
    // expression.ts is owned by another module; only assert dispatch shape so
    // this spec stays green when the placeholder is replaced by the real CAS.
    const part = fixturePart('2019-ht-t2-01', '2019-ht-t2-01-a1');
    const outcome = grade(part, { kind: 'expression', expr: 'p_1*p_2' });
    expect(outcome.maxPoints).toBe(1);
    if (isIndeterminate(outcome)) {
      expect(['cas-parse-error', 'cas-unreliable']).toContain(outcome.reason);
    } else {
      expect(['correct', 'partial', 'incorrect']).toContain(outcome.verdict);
      expect(outcome.correct).toBe(outcome.verdict === 'correct');
    }
  });
});

describe('grade — GradeResult invariants over the whole fixture bank', () => {
  it('correct flag always mirrors the verdict; awarded within [0, max]', () => {
    // Grade every objective part with an intentionally empty/neutral submission.
    const empty: Record<string, Submission> = {
      choice: { kind: 'choice', selected: [] },
      matching: { kind: 'matching', matches: [] },
      numeric: { kind: 'numeric', values: {} },
      interval: { kind: 'interval', lower: '', upper: '', lowerClosed: false, upperClosed: false },
      open: { kind: 'open', text: '', selfAssessment: {} },
    };
    for (const q of questions) {
      for (const part of q.parts) {
        const kind = part.answer?.kind;
        if (!kind || kind === 'expression') continue;
        const submission = empty[kind];
        if (!submission) continue;
        const r = grade(part, submission) as GradeResult;
        expect(r.correct).toBe(r.verdict === 'correct');
        expect(r.awardedPoints).toBeGreaterThanOrEqual(0);
        expect(r.awardedPoints).toBeLessThanOrEqual(r.maxPoints);
        expect(r.maxPoints).toBeGreaterThan(0);
      }
    }
  });
});
