import { describe, expect, it } from 'vitest';
import {
  advanceFsrs,
  advanceFsrsForGrading,
  gradingOf,
  isPartDue,
  isPracticed,
  placeholderFsrs,
  verdictToAutoGrading,
  EXCLUDED_DUE_SENTINEL,
} from '../src/fsrs/index.js';
import type { FsrsState, PartEntry } from '../src/model/archive.js';

const NOW = new Date('2026-07-04T10:00:00.000Z');
const DAY = 86_400_000;

const reviewed: FsrsState = {
  due: '2026-07-10T00:00:00.000Z',
  stability: 5,
  difficulty: 5,
  reps: 3,
  lapses: 1,
  lastReview: '2026-07-01T00:00:00.000Z',
};

describe('verdictToAutoGrading (supplement §1.2 defaults)', () => {
  it('correct→good, partial→meh, incorrect→baffled', () => {
    expect(verdictToAutoGrading('correct')).toBe('good');
    expect(verdictToAutoGrading('partial')).toBe('meh');
    expect(verdictToAutoGrading('incorrect')).toBe('baffled');
  });
});

describe('advanceFsrsForGrading (supplement §1.3 mapping)', () => {
  it('good behaves exactly like the FSRS Good rating', () => {
    expect(advanceFsrsForGrading(reviewed, 'good', NOW)).toEqual(advanceFsrs(reviewed, 'good', NOW));
  });

  it('careless = Hard WITHOUT a lapse, milder stretch than good', () => {
    const careless = advanceFsrsForGrading(reviewed, 'careless', NOW);
    const good = advanceFsrsForGrading(reviewed, 'good', NOW);
    expect(careless.lapses).toBe(reviewed.lapses); // no lapse punishment
    expect(careless.stability).toBeGreaterThan(reviewed.stability); // still a stretch…
    expect(careless.stability).toBeLessThan(good.stability); // …but milder than good
    expect(careless.reps).toBe(reviewed.reps + 1);
  });

  it('meh = Again (lapse) with a short 1–3 day comeback', () => {
    const meh = advanceFsrsForGrading(reviewed, 'meh', NOW);
    expect(meh.lapses).toBe(reviewed.lapses + 1);
    expect(meh.stability).toBeLessThan(reviewed.stability);
    const days = (new Date(meh.due).getTime() - NOW.getTime()) / DAY;
    expect(days).toBeGreaterThanOrEqual(1);
    expect(days).toBeLessThanOrEqual(3);
  });

  it('baffled = Again with FULL reset and immediately due', () => {
    const baffled = advanceFsrsForGrading(reviewed, 'baffled', NOW);
    expect(baffled.lapses).toBe(reviewed.lapses + 1);
    expect(baffled.due).toBe(NOW.toISOString());
    // stability collapses below the meh outcome (complete reset)
    const meh = advanceFsrsForGrading(reviewed, 'meh', NOW);
    expect(baffled.stability).toBeLessThanOrEqual(meh.stability);
    expect(baffled.stability).toBeCloseTo(0.4872, 6); // w0
  });

  it('severity ordering of comeback: baffled sooner than meh, meh sooner than careless', () => {
    const careless = advanceFsrsForGrading(reviewed, 'careless', NOW);
    const meh = advanceFsrsForGrading(reviewed, 'meh', NOW);
    const baffled = advanceFsrsForGrading(reviewed, 'baffled', NOW);
    expect(new Date(baffled.due).getTime()).toBeLessThanOrEqual(new Date(meh.due).getTime());
    expect(new Date(meh.due).getTime()).toBeLessThan(new Date(careless.due).getTime());
  });

  it('excluded freezes the previous state untouched', () => {
    expect(advanceFsrsForGrading(reviewed, 'excluded', NOW)).toEqual(reviewed);
  });

  it('excluded without prior state yields a reps-0 placeholder', () => {
    const frozen = advanceFsrsForGrading(undefined, 'excluded', NOW);
    expect(frozen.reps).toBe(0);
    expect(frozen.lastReview).toBeNull();
  });

  it('first contact works for every non-excluded grading', () => {
    for (const g of ['good', 'careless', 'meh', 'baffled'] as const) {
      const s = advanceFsrsForGrading(undefined, g, NOW);
      expect(s.reps).toBe(1);
      expect(s.stability).toBeGreaterThan(0);
      expect(s.lastReview).toBe(NOW.toISOString());
    }
  });
});

describe('entry helpers', () => {
  const entry = (over: Partial<PartEntry>): PartEntry => ({
    partId: 'p1',
    grading: null,
    starred: false,
    fsrs: reviewed,
    updatedAt: NOW.toISOString(),
    ...over,
  });

  it('gradingOf: unseen for missing entries and null gradings', () => {
    expect(gradingOf(undefined)).toBe('unseen');
    expect(gradingOf(entry({}))).toBe('unseen');
    expect(gradingOf(entry({ grading: 'meh' }))).toBe('meh');
  });

  it('isPracticed: placeholders (reps 0, no lastResult) are not practiced', () => {
    expect(isPracticed(entry({ fsrs: placeholderFsrs(NOW) }))).toBe(false);
    expect(isPracticed(entry({}))).toBe(true);
  });

  it('isPartDue: excluded parts are NEVER due (supplement §1.4)', () => {
    const overdue = entry({ fsrs: { ...reviewed, due: '2026-07-01T00:00:00.000Z' } });
    expect(isPartDue(overdue, NOW)).toBe(true);
    expect(isPartDue({ ...overdue, grading: 'excluded' }, NOW)).toBe(false);
    expect(isPartDue(entry({ fsrs: placeholderFsrs(new Date('2020-01-01')) }), NOW)).toBe(false);
  });

  it('EXCLUDED_DUE_SENTINEL parses to a far-future canonical timestamp', () => {
    expect(new Date(EXCLUDED_DUE_SENTINEL).toISOString()).toBe(EXCLUDED_DUE_SENTINEL);
    expect(new Date(EXCLUDED_DUE_SENTINEL).getTime()).toBeGreaterThan(new Date('2100-01-01').getTime());
  });
});
