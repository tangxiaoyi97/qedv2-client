import { describe, expect, it } from 'vitest';
import {
  formatScore,
  formatScoreRatio,
  localDayRange,
  parseLocalDayKey,
  roundScore,
} from '../src/model/format.js';

/**
 * These helpers replaced per-view reimplementations. The German decimal comma
 * in particular used to be pinned only by component specs that were deleted
 * when their components were superseded, leaving the rendering rule untested.
 */
describe('score formatting', () => {
  it('writes halves with a decimal COMMA, not a point', () => {
    expect(formatScore(0.5)).toBe('0,5');
    expect(formatScore(1.5)).toBe('1,5');
    expect(formatScore(2.25)).toBe('2,25');
  });

  it('writes whole points without a decimal part at all', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(1)).toBe('1');
    expect(formatScore(12)).toBe('12');
  });

  it('rounds float noise away at two decimals', () => {
    expect(roundScore(0.1 + 0.2)).toBe(0.3);
    expect(formatScore(0.1 + 0.2)).toBe('0,3');
    expect(formatScore(1 / 3)).toBe('0,33');
  });

  it('spells a ratio the one way the whole app spells it', () => {
    expect(formatScoreRatio(0, 1)).toBe('0 / 1 P');
    expect(formatScoreRatio(0.5, 2)).toBe('0,5 / 2 P');
  });

  it('does not group thousands — points are never that large', () => {
    // Guards the swap away from toLocaleString: '1.234,5' would be wrong here.
    expect(formatScore(1234.5)).toBe('1234,5');
  });
});

describe('local day keys', () => {
  it('parses a key as LOCAL midnight, not UTC', () => {
    // `new Date('2026-07-28')` is UTC and lands on the 27th west of Greenwich.
    const day = parseLocalDayKey('2026-07-28');
    expect(day.getFullYear()).toBe(2026);
    expect(day.getMonth()).toBe(6); // July
    expect(day.getDate()).toBe(28);
    expect(day.getHours()).toBe(0);
  });

  it('spans a full local day, end inclusive', () => {
    const { since, until } = localDayRange('2026-07-28');
    const start = new Date(since);
    const end = new Date(until);
    expect(start.getDate()).toBe(28);
    expect(start.getHours()).toBe(0);
    expect(end.getDate()).toBe(28);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it('survives a malformed key instead of producing an Invalid Date', () => {
    const day = parseLocalDayKey('nonsense');
    expect(Number.isNaN(day.getTime())).toBe(false);
  });
});
