import { describe, expect, it } from 'vitest';
import {
  advanceFsrs,
  intervalDays,
  isDue,
  retrievability,
  verdictToRating,
  type FsrsRating,
} from '../src/fsrs/fsrs.js';
import type { FsrsState } from '../src/model/archive.js';

const MS_PER_DAY = 86_400_000;
const NOW = new Date('2026-07-03T10:00:00.000Z');
const daysLater = (base: Date, d: number): Date => new Date(base.getTime() + d * MS_PER_DAY);

// Published FSRS-4.5 initial stabilities w0..w3 (again, hard, good, easy).
const INITIAL_S: Record<FsrsRating, number> = {
  again: 0.4872,
  hard: 1.4003,
  good: 3.7145,
  easy: 13.8206,
};

describe('verdictToRating', () => {
  it('maps grading verdicts to ratings (easy unused)', () => {
    expect(verdictToRating('correct')).toBe('good');
    expect(verdictToRating('partial')).toBe('hard');
    expect(verdictToRating('incorrect')).toBe('again');
  });
});

describe('intervalDays', () => {
  it('equals S (rounded) at desired retention 0.9 with DECAY=-0.5, FACTOR=19/81', () => {
    expect(intervalDays(10)).toBe(10);
    expect(intervalDays(3.7145)).toBe(4);
    expect(intervalDays(13.8206)).toBe(14);
  });

  it('clamps to [1, 36500] days', () => {
    expect(intervalDays(0.01)).toBe(1);
    expect(intervalDays(0.4872)).toBe(1); // rounds to 0, clamped up
    expect(intervalDays(1_000_000)).toBe(36_500);
  });
});

describe('advanceFsrs — first review', () => {
  const ratings: FsrsRating[] = ['again', 'hard', 'good', 'easy'];

  it.each(ratings)('%s: S = corresponding weight, D in [1,10], due = now + interval(S)', (r) => {
    const s = advanceFsrs(undefined, r, NOW);
    expect(s.stability).toBe(INITIAL_S[r]);
    expect(s.difficulty).toBeGreaterThanOrEqual(1);
    expect(s.difficulty).toBeLessThanOrEqual(10);
    expect(s.reps).toBe(1);
    expect(s.lapses).toBe(r === 'again' ? 1 : 0);
    expect(s.lastReview).toBe(NOW.toISOString());
    expect(s.due).toBe(daysLater(NOW, intervalDays(INITIAL_S[r])).toISOString());
  });

  it('initial difficulty follows D0(g) = w4 - e^(w5*(g-1)) + 1, clamped and 6dp-rounded', () => {
    expect(advanceFsrs(undefined, 'again', NOW).difficulty).toBeCloseTo(5.1618, 10);
    // difficulty is rounded to 6 decimals at write time (checksum spec §5.1)
    expect(advanceFsrs(undefined, 'hard', NOW).difficulty).toBeCloseTo(
      5.1618 - Math.exp(1.2298) + 1,
      5,
    );
    // good/easy raw D0 goes below 1 with these weights → clamped to the floor
    expect(advanceFsrs(undefined, 'good', NOW).difficulty).toBe(1);
    expect(advanceFsrs(undefined, 'easy', NOW).difficulty).toBe(1);
  });
});

describe('advanceFsrs — subsequent reviews', () => {
  it('successful review at due date grows stability', () => {
    const first = advanceFsrs(undefined, 'good', NOW);
    const second = advanceFsrs(first, 'good', new Date(first.due));
    expect(second.stability).toBeGreaterThan(first.stability);
    expect(second.reps).toBe(2);
    expect(second.lapses).toBe(0);
    expect(second.due).toBe(
      daysLater(new Date(first.due), intervalDays(second.stability)).toISOString(),
    );
  });

  it('rating monotonicity at same elapsed: easy > good > hard, all grow S', () => {
    const prev: FsrsState = {
      due: daysLater(NOW, 4).toISOString(),
      stability: 3.7145,
      difficulty: 5,
      reps: 1,
      lapses: 0,
      lastReview: NOW.toISOString(),
    };
    const at = daysLater(NOW, 4);
    const sHard = advanceFsrs(prev, 'hard', at).stability;
    const sGood = advanceFsrs(prev, 'good', at).stability;
    const sEasy = advanceFsrs(prev, 'easy', at).stability;
    expect(sHard).toBeGreaterThan(prev.stability);
    expect(sGood).toBeGreaterThan(sHard);
    expect(sEasy).toBeGreaterThan(sGood);
  });

  it("'again' shrinks stability and increments lapses", () => {
    const first = advanceFsrs(undefined, 'good', NOW);
    const lapsed = advanceFsrs(first, 'again', new Date(first.due));
    expect(lapsed.stability).toBeLessThan(first.stability);
    expect(lapsed.stability).toBeGreaterThan(0);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.reps).toBe(2);
  });

  it("'again' post-lapse stability is capped at the previous stability", () => {
    // Tiny S + long elapsed makes the raw failure formula exceed S → cap applies.
    const prev: FsrsState = {
      due: daysLater(NOW, 1).toISOString(),
      stability: 0.1,
      difficulty: 1,
      reps: 1,
      lapses: 0,
      lastReview: NOW.toISOString(),
    };
    const lapsed = advanceFsrs(prev, 'again', daysLater(NOW, 100));
    expect(lapsed.stability).toBe(0.1);
  });

  it('same-day re-review (t=0, R=1) keeps S unchanged on success', () => {
    const first = advanceFsrs(undefined, 'good', NOW);
    const sameDay = advanceFsrs(first, 'good', NOW);
    expect(sameDay.stability).toBe(first.stability); // multiplier collapses to exactly 1
    expect(sameDay.reps).toBe(2);
    // 'again' at t=0 still shrinks — monotonic in the rating
    expect(advanceFsrs(first, 'again', NOW).stability).toBeLessThan(first.stability);
  });

  it('difficulty stays in [1,10] across long mixed rating sequences', () => {
    const ratings: FsrsRating[] = ['again', 'hard', 'good', 'easy'];
    for (const start of ratings) {
      let state = advanceFsrs(undefined, start, NOW);
      let when = NOW;
      for (let i = 0; i < 40; i++) {
        expect(state.difficulty).toBeGreaterThanOrEqual(1);
        expect(state.difficulty).toBeLessThanOrEqual(10);
        when = new Date(state.due);
        state = advanceFsrs(state, ratings[i % 4]!, when);
      }
    }
  });

  it("'good' (rating−3 = 0) changes D only via mean reversion, drifting down", () => {
    const prev: FsrsState = {
      due: daysLater(NOW, 4).toISOString(),
      stability: 3.7145,
      difficulty: 5,
      reps: 1,
      lapses: 0,
      lastReview: NOW.toISOString(),
    };
    const next = advanceFsrs(prev, 'good', daysLater(NOW, 4));
    expect(next.difficulty).toBeLessThan(prev.difficulty);
    expect(next.difficulty).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic: same inputs produce identical outputs', () => {
    const prev = advanceFsrs(undefined, 'good', NOW);
    const at = daysLater(NOW, 7);
    expect(advanceFsrs(prev, 'hard', at)).toEqual(advanceFsrs(prev, 'hard', at));
    expect(advanceFsrs(undefined, 'easy', NOW)).toEqual(advanceFsrs(undefined, 'easy', NOW));
  });
});

describe('retrievability', () => {
  const state: FsrsState = {
    due: daysLater(NOW, 10).toISOString(),
    stability: 10,
    difficulty: 5,
    reps: 1,
    lapses: 0,
    lastReview: NOW.toISOString(),
  };

  it('is 1 at t=0 and strictly decreasing in t', () => {
    expect(retrievability(state, NOW)).toBe(1);
    const r5 = retrievability(state, daysLater(NOW, 5));
    const r50 = retrievability(state, daysLater(NOW, 50));
    expect(r5).toBeLessThan(1);
    expect(r50).toBeLessThan(r5);
    expect(r50).toBeGreaterThan(0);
  });

  it('is 0.9 at the scheduled interval (desired retention)', () => {
    expect(retrievability(state, daysLater(NOW, intervalDays(state.stability)))).toBeCloseTo(
      0.9,
      12,
    );
  });

  it('clamps negative elapsed time to 0', () => {
    expect(retrievability(state, daysLater(NOW, -3))).toBe(1);
  });

  it('falls back to the due − interval anchor when lastReview is absent', () => {
    // Same schedule, but written without lastReview: anchor = due − interval(S) = NOW.
    const bare: FsrsState = {
      due: daysLater(NOW, 10).toISOString(),
      stability: 10,
      difficulty: 5,
      reps: 1,
      lapses: 0,
      lastReview: null,
    };
    expect(retrievability(bare, NOW)).toBe(1);
    expect(retrievability(bare, daysLater(NOW, 10))).toBeCloseTo(0.9, 12);
  });
});

describe('isDue', () => {
  it('flips exactly at the due timestamp', () => {
    const state = advanceFsrs(undefined, 'good', NOW); // due = NOW + 4d
    const due = new Date(state.due);
    expect(isDue(state, new Date(due.getTime() - 1))).toBe(false);
    expect(isDue(state, due)).toBe(true);
    expect(isDue(state, new Date(due.getTime() + 1))).toBe(true);
  });
});
