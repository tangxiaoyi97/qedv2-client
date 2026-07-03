import { describe, expect, it } from 'vitest';
import { MASTERY_ALPHA, masteryLevel, updateMastery } from '../src/fsrs/mastery.js';

describe('updateMastery', () => {
  it('initializes to the ratio on first grade', () => {
    expect(updateMastery(undefined, 0.8)).toBe(0.8);
    expect(updateMastery(undefined, 0)).toBe(0);
    expect(updateMastery(undefined, 1)).toBe(1);
  });

  it('moves by MASTERY_ALPHA toward the new ratio', () => {
    expect(MASTERY_ALPHA).toBe(0.3);
    expect(updateMastery(0.5, 1)).toBeCloseTo(0.65, 12); // 0.5 + 0.3·0.5
    expect(updateMastery(0.5, 0)).toBeCloseTo(0.35, 12);
    expect(updateMastery(0.5, 0.5)).toBeCloseTo(0.5, 12); // fixed point
  });

  it('clamps the result to [0, 1] (init and EMA paths)', () => {
    expect(updateMastery(undefined, 1.5)).toBe(1);
    expect(updateMastery(undefined, -0.2)).toBe(0);
    expect(updateMastery(0.95, 2)).toBe(1); // 0.95 + 0.3·1.05 = 1.265
    expect(updateMastery(0.05, -1)).toBe(0); // 0.05 + 0.3·(−1.05) < 0
  });
});

describe('masteryLevel', () => {
  it('buckets at the 0.4 and 0.7 boundaries', () => {
    expect(masteryLevel(0)).toBe('low');
    expect(masteryLevel(0.39999)).toBe('low');
    expect(masteryLevel(0.4)).toBe('medium');
    expect(masteryLevel(0.69999)).toBe('medium');
    expect(masteryLevel(0.7)).toBe('high');
    expect(masteryLevel(1)).toBe('high');
  });
});
