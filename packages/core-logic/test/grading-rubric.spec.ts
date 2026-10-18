import { describe, expect, it } from 'vitest';
import {
  grade, gradeChoice, gradeExpression, gradeInterval, gradeMatching, gradeNumeric,
  gradeSelfAssessment,
} from '../src/grading/index.js';
import type { GradeOutcome, Submission } from '../src/grading/types.js';
import { latexToMathjs } from '../src/grading/latex.js';
import type { QuestionPart, Scoring } from '../src/model/question.js';
import bank from './fixtures/rubric-bank-parts.json';

const records = bank.records as unknown as Array<{ commit: string; part: QuestionPart }>;
const rubric: Scoring = {
  mode: 'rubric',
  criteria: [{ desc: 'Reasoning', points: 1 }, { desc: 'Result with unit', points: 0.5 }],
};

function expectPending(outcome: GradeOutcome, maxPoints: number): void {
  expect(outcome).toEqual({
    verdict: 'indeterminate', reason: 'rubric-requires-self-assessment', maxPoints,
  });
  expect(outcome).not.toHaveProperty('awardedPoints');
  expect(outcome).not.toHaveProperty('correct');
  expect(outcome).not.toHaveProperty('breakdown');
}

describe('authored rubrics require an explicit assessment', () => {
  const cases: Array<{
    kind: string; answer: NonNullable<QuestionPart['answer']>; submission: Submission;
    direct: () => GradeOutcome;
  }> = [
    {
      kind: 'choice', answer: { kind: 'choice', options: [[{ t: 'text', v: 'A' }]], correct: [0], selectCount: 1 },
      submission: { kind: 'choice', selected: [0] },
      direct: () => gradeChoice({ kind: 'choice', options: [[{ t: 'text', v: 'A' }]], correct: [0], selectCount: 1 }, { kind: 'choice', selected: [0] }, rubric, 99),
    },
    {
      kind: 'matching', answer: { kind: 'matching', left: [[{ t: 'text', v: 'A' }]], right: [[{ t: 'text', v: 'B' }]], pairs: [[0, 0]] },
      submission: { kind: 'matching', matches: [0] },
      direct: () => gradeMatching({ kind: 'matching', left: [[{ t: 'text', v: 'A' }]], right: [[{ t: 'text', v: 'B' }]], pairs: [[0, 0]] }, { kind: 'matching', matches: [0] }, rubric, 99),
    },
    {
      kind: 'numeric', answer: { kind: 'numeric', blanks: [{ id: 'n', value: 42, tol: 0 }] },
      submission: { kind: 'numeric', values: { n: '42' } },
      direct: () => gradeNumeric({ kind: 'numeric', blanks: [{ id: 'n', value: 42, tol: 0 }] }, { kind: 'numeric', values: { n: '42' } }, rubric, 99),
    },
    {
      kind: 'interval', answer: { kind: 'interval', lower: 0, upper: 1, lowerClosed: true, upperClosed: true },
      submission: { kind: 'interval', lower: '0', upper: '1', lowerClosed: true, upperClosed: true },
      direct: () => gradeInterval({ kind: 'interval', lower: 0, upper: 1, lowerClosed: true, upperClosed: true }, { kind: 'interval', lower: '0', upper: '1', lowerClosed: true, upperClosed: true }, rubric, 99),
    },
    {
      kind: 'expression', answer: { kind: 'expression', canonical: 'x+1', vars: ['x'], checker: 'cas' },
      submission: { kind: 'expression', expr: 'x+1' },
      direct: () => gradeExpression({ kind: 'expression', canonical: 'x+1', vars: ['x'], checker: 'cas' }, { kind: 'expression', expr: 'x+1' }, rubric, 99),
    },
  ];

  it.each(cases)('$kind preserves the rubric maximum and never invents a score', ({ answer, submission, direct }) => {
    const part: QuestionPart = { id: 'rubric-part', label: 'a', competencies: [], answer, scoring: rubric, points: 99 };
    expectPending(grade(part, submission), 1.5);
    expectPending(direct(), 1.5);
  });

  it('retains each assessed criterion rather than trusting a stale cached point total', () => {
    expect(gradeSelfAssessment(rubric, 99, { criteriaMet: [false, true], awardedPoints: 1.5 })).toEqual({
      verdict: 'partial', correct: false, awardedPoints: 0.5, maxPoints: 1.5,
      breakdown: [
        { ref: '0', correct: false, awardedPoints: 0 },
        { ref: '1', correct: true, awardedPoints: 0.5 },
      ],
    });
  });
});

describe('real current and previously shipped bank contracts', () => {
  it('keeps all affected parts from both immutable commits in the regression fixture', () => {
    expect(records.filter((r) => r.commit === '7a39f243dfe7dc51c938fde26d3e351eb7dc7d97')).toHaveLength(5);
    expect(records.filter((r) => r.commit === 'acfde51773be1463af5624b93dc1392bb354a2db')).toHaveLength(10);
  });

  it.each(records)('$commit / $part.id waits for judgement even when the answer is correct', ({ part }) => {
    if (!part.answer || part.scoring?.mode !== 'rubric') throw new Error('Invalid bank regression fixture');
    let exact: Submission;
    let empty: Submission;
    if (part.answer.kind === 'numeric') {
      exact = { kind: 'numeric', values: Object.fromEntries(part.answer.blanks.map((blank) => [blank.id, String(blank.value)])) };
      empty = { kind: 'numeric', values: {} };
    } else if (part.answer.kind === 'expression') {
      exact = { kind: 'expression', expr: latexToMathjs(part.answer.canonical) };
      empty = { kind: 'expression', expr: '' };
    } else throw new Error('Unexpected bank regression answer kind');
    const maximum = part.scoring.criteria.reduce((sum, criterion) => sum + criterion.points, 0);
    const before = JSON.stringify(part);
    expectPending(grade(part, exact), maximum);
    expectPending(grade(part, empty), maximum);
    const full = gradeSelfAssessment(part.scoring, part.points, { criteriaMet: part.scoring.criteria.map(() => true) });
    expect(full).toMatchObject({ verdict: 'correct', awardedPoints: maximum, maxPoints: maximum });
    expect(full.breakdown).toHaveLength(part.scoring.criteria.length);
    expect(gradeSelfAssessment(part.scoring, part.points, { criteriaMet: part.scoring.criteria.map(() => false) }))
      .toMatchObject({ verdict: 'incorrect', awardedPoints: 0, maxPoints: maximum });
    expect(JSON.stringify(part)).toBe(before);
  });
});
