import { describe, expect, it } from 'vitest';
import {
  FULL_OVERSHOOT_PX,
  TOP_BAR_RESERVE_PX,
  HALF_MAX_PX,
  HALF_MIN_PX,
  SHEET_FLICK_VELOCITY_PX_S,
  SHEET_FLICK_MIN_DISTANCE_PX,
  SHEET_FLICK_MAX_IDLE_MS,
  resolveDetentHeights,
  resolveSheetRelease,
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

  it('does not stretch a short answer toward a later grading note', () => {
    const short = heights({ answerHeight: 90, noteOffset: 100 });
    expect(short.default).toBe(90);
    expect(short.default).toBeLessThan(HALF_MIN_PX);
    expect(heights({ answerHeight: 90, noteOffset: 80 }).default).toBe(80);
  });

  it.each([36, 90, 140, 179])('opens a measured %ipx answer without a note at its exact height', (answerHeight) => {
    expect(heights({ answerHeight, noteOffset: 0 }).default).toBe(answerHeight);
  });

  it('retains the fallback minimum only until the answer is measured', () => {
    expect(heights({ viewportHeight: 320, answerHeight: 0 }).default).toBe(HALF_MIN_PX);
    expect(heights({ viewportHeight: 320, answerHeight: 90 }).default).toBe(90);
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

describe('solution drawer release intent', () => {
  const detents = { collapsed: 0, default: 420, full: 672 };
  const release = (over: Partial<Parameters<typeof resolveSheetRelease>[0]> = {}) =>
    resolveSheetRelease({
      detent: 'collapsed',
      heights: detents,
      startHeight: 0,
      height: 0,
      velocity: 0,
      ...over,
    });

  it('opens after a short deliberate pull instead of requiring half the drawer', () => {
    expect(release({ height: 36 })).toBe('default');
    expect(release({ detent: 'default', startHeight: 420, height: 384 })).toBe('collapsed');
    expect(release({ detent: 'full', startHeight: 672, height: 636 })).toBe('default');
  });

  it('commits a small fast flick in its direction', () => {
    expect(release({ height: 16, velocity: SHEET_FLICK_VELOCITY_PX_S + 1 })).toBe('default');
    expect(release({
      detent: 'default',
      startHeight: 420,
      height: 404,
      velocity: -(SHEET_FLICK_VELOCITY_PX_S + 1),
    })).toBe('collapsed');
  });

  it('returns a hesitant movement to the current detent', () => {
    expect(release({ detent: 'default', startHeight: 420, height: 400 })).toBe('default');
  });

  it('moves only one stop per gesture so a flick stays predictable', () => {
    expect(release({ height: 500, velocity: 1800 })).toBe('default');
  });

  it.each([0, 1, 6, SHEET_FLICK_MIN_DISTANCE_PX - 1])('does not mistake a %ipx twitch for a fast flick', (distance) => {
    expect(release({ height: distance, velocity: 2400 })).toBe('collapsed');
    expect(release({ detent: 'default', startHeight: 420, height: 420 - distance, velocity: -2400 })).toBe('default');
  });

  it('accepts a genuine flick after the minimum deliberate movement', () => {
    expect(release({ height: SHEET_FLICK_MIN_DISTANCE_PX, velocity: 600 })).toBe('default');
    expect(release({ detent: 'full', startHeight: 672, height: 672 - SHEET_FLICK_MIN_DISTANCE_PX, velocity: -600 })).toBe('default');
  });

  it('does not let a stale velocity reverse the final overall movement', () => {
    expect(release({ detent: 'default', startHeight: 420, height: 384, velocity: 1200 })).toBe('collapsed');
    expect(release({ detent: 'default', startHeight: 420, height: 456, velocity: -1200 })).toBe('full');
  });

  it('uses a deliberate final reversal even when the finger remains beyond its starting position', () => {
    expect(release({
      detent: 'default', startHeight: 420, height: 470,
      recentDisplacement: -36, velocity: 1200,
    })).toBe('collapsed');
    expect(release({
      detent: 'default', startHeight: 420, height: 370,
      recentDisplacement: 36, velocity: -1200,
    })).toBe('full');
  });

  it('treats a shorter final reversal as cancellation instead of committing the earlier pull', () => {
    expect(release({
      detent: 'default', startHeight: 420, height: 520,
      recentDisplacement: -10, velocity: 1200,
    })).toBe('default');
  });

  it('does not let a settling jitter erase a deliberate short pull', () => {
    expect(release({ height: 40, recentDisplacement: -2, velocity: 900 })).toBe('default');
  });

  it('expires flick momentum after a pause but preserves a completed deliberate pull', () => {
    expect(release({ height: 16, recentDisplacement: 16, velocity: 1600, idleMs: SHEET_FLICK_MAX_IDLE_MS })).toBe('collapsed');
    expect(release({ height: 36, recentDisplacement: 36, velocity: 1600, idleMs: 300 })).toBe('default');
    expect(release({ height: 16, recentDisplacement: 16, velocity: 600, idleMs: 20 })).toBe('default');
  });

  it('skips coincident default and full stops when closing a short drawer', () => {
    const short = { collapsed: 0, default: 100, full: 100 };
    expect(release({ detent: 'full', heights: short, startHeight: 100, height: 64 })).toBe('collapsed');
    expect(release({ detent: 'default', heights: short, startHeight: 100, height: 64 })).toBe('collapsed');
    expect(release({ heights: short, height: 36 })).toBe('default');
    expect(release({ detent: 'default', heights: short, startHeight: 100, height: 100, velocity: 1500 })).toBe('default');
  });

  it('skips an empty reading stop and treats near-equal heights as the same position', () => {
    expect(release({ heights: { collapsed: 0, default: 0, full: 100 }, height: 36 })).toBe('full');
    expect(release({ detent: 'full', heights: { collapsed: 0, default: 100, full: 101 }, startHeight: 101, height: 65 })).toBe('collapsed');
    expect(release({ detent: 'full', heights: { collapsed: 0, default: 0, full: 0 }, velocity: -1200, recentDisplacement: -36 })).toBe('full');
  });

  it('can complete a physically short transition without demanding travel beyond its bounds', () => {
    const short = { collapsed: 0, default: 10, full: 10 };
    expect(release({ heights: short, height: 10 })).toBe('default');
    expect(release({ heights: short, height: 1, velocity: 2400 })).toBe('collapsed');
  });

});
