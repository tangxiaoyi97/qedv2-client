import { describe, expect, it } from 'vitest';
import {
  FULL_OVERSHOOT_PX,
  TOP_BAR_RESERVE_PX,
  HALF_MAX_PX,
  HALF_MIN_PX,
  resolveDetentHeights,
} from '../src/practice/sheet-detents.js';

/**
 * These numbers were verified against a real browser (Chromium, 390×844) with
 * short, medium and very long solutions; the cases below encode what that
 * measurement established, since jsdom cannot lay anything out.
 */
const PHONE = 844;

const heights = (over: Partial<Parameters<typeof resolveDetentHeights>[0]> = {}) =>
  resolveDetentHeights({ viewportHeight: PHONE, answerHeight: 0, noteOffset: 0, ...over });

describe('solution drawer detents', () => {
  it('leaves the top bar visible at full screen', () => {
    expect(heights().full).toBe(PHONE - TOP_BAR_RESERVE_PX + FULL_OVERSHOOT_PX);
  });

  it('gives back whatever the bottom bar chrome occupies', () => {
    // Handle + verdict banner + action row are measured, not assumed — a
    // constant went stale the moment the banner was added and the fixed stack
    // started riding over the practice top bar.
    const chrome = 140;
    expect(heights({ chromeHeight: chrome }).full).toBe(
      PHONE - TOP_BAR_RESERVE_PX - chrome + FULL_OVERSHOOT_PX,
    );
  });

  it('keeps the half detent under a chrome-reduced full detent', () => {
    const h = heights({ chromeHeight: 600, answerHeight: 9999 });
    expect(h.default).toBeLessThanOrEqual(h.full);
  });

  it('opens exactly to the end of the answer when it fits', () => {
    // Browser-measured: a two-line solution ends at 126px, its note at 136px.
    expect(heights({ answerHeight: 140, noteOffset: 136 }).default).toBe(136);
  });

  it('stops short of the grading note even when that breaks the minimum', () => {
    // Hiding the assessment outranks HALF_MIN_PX — the note must not peek.
    const short = heights({ answerHeight: 90, noteOffset: 100 });
    expect(short.default).toBe(100);
    expect(short.default).toBeLessThan(HALF_MIN_PX);
  });

  it('applies the minimum when nothing forces it lower', () => {
    expect(heights({ answerHeight: 90, noteOffset: 0 }).default).toBe(HALF_MIN_PX);
  });

  it('caps a long answer instead of letting it swallow the question', () => {
    // Browser-measured: a 40× solution ends at 1054px. Half-open shows 460 and
    // scrolls; that is what the full detent is for.
    const long = heights({ answerHeight: 1068, noteOffset: 1064 });
    expect(long.default).toBe(HALF_MAX_PX);
  });

  it('never lets the half detent outgrow the full one', () => {
    for (const viewportHeight of [200, 320, 480, 844, 1400]) {
      const h = resolveDetentHeights({ viewportHeight, answerHeight: 9999, noteOffset: 0 });
      expect(h.default, `${viewportHeight}px`).toBeLessThanOrEqual(h.full);
    }
  });

  it('keeps the half detent under 60 % of a short viewport', () => {
    const h = resolveDetentHeights({ viewportHeight: 600, answerHeight: 9999, noteOffset: 0 });
    expect(h.default).toBeLessThanOrEqual(Math.round(600 * 0.6));
  });

  it('falls back to a ratio before anything has been measured', () => {
    expect(heights({ answerHeight: 0 }).default).toBe(Math.round(Math.min(PHONE * 0.55, HALF_MAX_PX)));
  });
});
