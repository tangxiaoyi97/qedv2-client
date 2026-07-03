import { describe, expect, it } from 'vitest';
import { applyScoring, resolveVerdict } from '../src/grading/scoring.js';
import type { Scoring, RubricCriterion } from '../src/model/question.js';

const base = { correctCount: 0, totalCount: 0, allCorrect: false, fallbackPoints: undefined };

const criterion = (points: number): RubricCriterion => ({ desc: [{ t: 'text', v: 'c' }], points });

describe('applyScoring — no scoring given (allOrNothing fallback)', () => {
  it('uses fallbackPoints when all correct', () => {
    expect(applyScoring(undefined, { ...base, allCorrect: true, fallbackPoints: 2 })).toEqual({
      awardedPoints: 2,
      maxPoints: 2,
    });
  });

  it('defaults to 1 point when fallbackPoints is undefined', () => {
    expect(applyScoring(undefined, { ...base, allCorrect: true })).toEqual({
      awardedPoints: 1,
      maxPoints: 1,
    });
  });

  it('awards 0 when not all correct, max still shown', () => {
    expect(applyScoring(undefined, { ...base, correctCount: 3, fallbackPoints: 4 })).toEqual({
      awardedPoints: 0,
      maxPoints: 4,
    });
  });
});

describe('applyScoring — allOrNothing', () => {
  const scoring: Scoring = { mode: 'allOrNothing', points: 2 };

  it('full points on allCorrect', () => {
    expect(applyScoring(scoring, { ...base, allCorrect: true })).toEqual({
      awardedPoints: 2,
      maxPoints: 2,
    });
  });

  it('zero otherwise, regardless of correctCount', () => {
    expect(applyScoring(scoring, { ...base, correctCount: 5, totalCount: 6 })).toEqual({
      awardedPoints: 0,
      maxPoints: 2,
    });
  });
});

describe('applyScoring — perBlank', () => {
  const scoring: Scoring = { mode: 'perBlank', pointsPerCorrect: 0.5, max: 2 };

  it('multiplies correct count', () => {
    expect(applyScoring(scoring, { ...base, correctCount: 2 })).toEqual({
      awardedPoints: 1,
      maxPoints: 2,
    });
  });

  it('clamps at max', () => {
    expect(applyScoring(scoring, { ...base, correctCount: 7 })).toEqual({
      awardedPoints: 2,
      maxPoints: 2,
    });
  });

  it('zero correct gives zero', () => {
    expect(applyScoring(scoring, { ...base })).toEqual({ awardedPoints: 0, maxPoints: 2 });
  });
});

describe('applyScoring — tiered', () => {
  // Real bank shape (2019-ht-t1-12 matching part).
  const scoring: Scoring = {
    mode: 'tiered',
    tiers: [
      { minCorrect: 1, points: 0.5 },
      { minCorrect: 2, points: 1 },
    ],
  };

  it('below every tier → 0, maxPoints = highest tier', () => {
    expect(applyScoring(scoring, { ...base, correctCount: 0 })).toEqual({
      awardedPoints: 0,
      maxPoints: 1,
    });
  });

  it('picks the highest tier whose minCorrect is met', () => {
    expect(applyScoring(scoring, { ...base, correctCount: 1 })).toEqual({
      awardedPoints: 0.5,
      maxPoints: 1,
    });
    expect(applyScoring(scoring, { ...base, correctCount: 2 })).toEqual({
      awardedPoints: 1,
      maxPoints: 1,
    });
  });

  it('correctCount above every tier still yields the top tier', () => {
    expect(applyScoring(scoring, { ...base, correctCount: 5 })).toEqual({
      awardedPoints: 1,
      maxPoints: 1,
    });
  });

  it('is robust to unsorted tier arrays', () => {
    const unsorted: Scoring = {
      mode: 'tiered',
      tiers: [
        { minCorrect: 2, points: 1 },
        { minCorrect: 1, points: 0.5 },
      ],
    };
    expect(applyScoring(unsorted, { ...base, correctCount: 1 })).toEqual({
      awardedPoints: 0.5,
      maxPoints: 1,
    });
  });
});

describe('applyScoring — rubric', () => {
  const scoring: Scoring = { mode: 'rubric', criteria: [criterion(2), criterion(1), criterion(1)] };

  it('sums met criteria; maxPoints sums all criteria', () => {
    expect(
      applyScoring(scoring, { ...base, criteriaMet: [true, false, true] }),
    ).toEqual({ awardedPoints: 3, maxPoints: 4 });
  });

  it('missing criteriaMet array → nothing met', () => {
    expect(applyScoring(scoring, { ...base })).toEqual({ awardedPoints: 0, maxPoints: 4 });
  });

  it('short criteriaMet array → missing entries treated false', () => {
    expect(applyScoring(scoring, { ...base, criteriaMet: [true] })).toEqual({
      awardedPoints: 2,
      maxPoints: 4,
    });
  });

  it('all met → full points', () => {
    expect(applyScoring(scoring, { ...base, criteriaMet: [true, true, true] })).toEqual({
      awardedPoints: 4,
      maxPoints: 4,
    });
  });
});

describe('resolveVerdict', () => {
  it('full points + all correct → correct', () => {
    expect(resolveVerdict(1, 1, true)).toBe('correct');
  });

  it('zero points + not all correct → incorrect', () => {
    expect(resolveVerdict(0, 1, false)).toBe('incorrect');
  });

  it('anything in between → partial', () => {
    expect(resolveVerdict(0.5, 1, false)).toBe('partial');
  });

  it('full points but something wrong (clamped perBlank) → partial', () => {
    expect(resolveVerdict(2, 2, false)).toBe('partial');
  });

  it('all correct but points below max (tier gap) → partial', () => {
    expect(resolveVerdict(0, 1, true)).toBe('partial');
  });

  it('zero-point part answered perfectly → correct', () => {
    expect(resolveVerdict(0, 0, true)).toBe('correct');
  });

  it('tolerates IEEE-754 sum noise at the max boundary', () => {
    expect(resolveVerdict(0.1 + 0.2, 0.3, true)).toBe('correct');
    expect(resolveVerdict(0.3, 0.1 + 0.2, true)).toBe('correct');
  });
});
