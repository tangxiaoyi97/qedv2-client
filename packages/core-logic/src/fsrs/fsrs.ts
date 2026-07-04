/**
 * Hand-rolled long-term FSRS scheduler (FSRS-4.5/5 style).
 *
 * Why not wrap ts-fsrs: the sync contract stores EXACTLY
 * {due, stability, difficulty, reps, lapses, lastReview} per part (see
 * model/archive.ts) — ts-fsrs' Card carries extra state (state machine,
 * scheduled_days, elapsed_days, learning steps) that cannot round-trip
 * through the archive. The long-term variant (no learning steps) needs only
 * the archived fields, so we implement it directly against FsrsState.
 *
 * Purity: `now` is always a parameter — no Date.now() — and all timestamps
 * are emitted via Date#toISOString() (archive canonical form).
 */
import { normNum } from '../model/archive.js';
import type { FsrsState } from '../model/archive.js';
import type { Verdict } from '../grading/types.js';

export type FsrsRating = 'again' | 'hard' | 'good' | 'easy';

/** Published FSRS-4.5 default weights w0..w18. */
const W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461,
  2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755, 0.0563, 0.9,
] as const;

const DECAY = -0.5;
const FACTOR = 19 / 81;
const DESIRED_RETENTION = 0.9;
const MS_PER_DAY = 86_400_000;

/** Numeric grade used by the formulas: again=1, hard=2, good=3, easy=4. */
const RATING_VALUE: Record<FsrsRating, 1 | 2 | 3 | 4> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};

/** Grade verdict → FSRS rating (contract: Easy is unused by grading). */
export function verdictToRating(v: Verdict): FsrsRating {
  return v === 'correct' ? 'good' : v === 'partial' ? 'hard' : 'again';
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** D0(g) = w4 − e^(w5·(g−1)) + 1, unclamped (mean-reversion target uses raw D0(4)). */
const rawInitialDifficulty = (g: number): number => W[4]! - Math.exp(W[5]! * (g - 1)) + 1;

/**
 * Interval for desired retention 0.9: S · (0.9^(1/DECAY) − 1) / FACTOR
 * (which equals S exactly for DECAY=−0.5, FACTOR=19/81), rounded and
 * clamped to [1, 36500] days.
 */
export function intervalDays(stability: number): number {
  const interval = (stability * (Math.pow(DESIRED_RETENTION, 1 / DECAY) - 1)) / FACTOR;
  return clamp(Math.round(interval), 1, 36_500);
}

/**
 * Elapsed days since the last review, clamped to >= 0. When lastReview is
 * absent (state written by another client), anchor at due − interval(S):
 * the point the schedule was computed from.
 */
function elapsedDays(state: FsrsState, now: Date): number {
  const anchor =
    state.lastReview != null
      ? new Date(state.lastReview).getTime()
      : new Date(state.due).getTime() - intervalDays(state.stability) * MS_PER_DAY;
  return Math.max(0, (now.getTime() - anchor) / MS_PER_DAY);
}

/** Forgetting curve R(t, S) = (1 + FACTOR·t/S)^DECAY; R(0, S) = 1. */
export function retrievability(state: FsrsState, now: Date): number {
  const t = elapsedDays(state, now);
  return Math.pow(1 + (FACTOR * t) / state.stability, DECAY);
}

export function isDue(state: FsrsState, now: Date): boolean {
  return now.getTime() >= new Date(state.due).getTime();
}

/**
 * Advance the scheduler state for one review at `now`.
 *
 * Same-day re-review (elapsed t = 0) applies the same formulas with R = 1:
 * the success stability multiplier collapses to 1 (e^(w10·(1−1)) − 1 = 0), so
 * repeated 'good'/'hard'/'easy' grading on the same day keeps S unchanged
 * (idempotent-ish, never decreases S), while 'again' still shrinks it —
 * monotonic in the rating.
 */
export function advanceFsrs(prev: FsrsState | undefined, rating: FsrsRating, now: Date): FsrsState {
  const g = RATING_VALUE[rating];

  let stability: number;
  let difficulty: number;
  let reps: number;
  let lapses: number;

  if (prev === undefined) {
    // First review: S and D initialized from the rating alone.
    stability = W[g - 1]!;
    difficulty = clamp(rawInitialDifficulty(g), 1, 10);
    reps = 1;
    lapses = rating === 'again' ? 1 : 0;
  } else {
    const S = prev.stability;
    const D = prev.difficulty;
    const R = retrievability(prev, now);

    if (rating === 'again') {
      // Post-lapse stability, never above the previous stability.
      const sFail =
        W[11]! * Math.pow(D, -W[12]!) * (Math.pow(S + 1, W[13]!) - 1) * Math.exp(W[14]! * (1 - R));
      stability = Math.min(sFail, S);
    } else {
      const hardPenalty = rating === 'hard' ? W[15]! : 1;
      const easyBonus = rating === 'easy' ? W[16]! : 1;
      stability =
        S *
        (1 +
          Math.exp(W[8]!) *
            (11 - D) *
            Math.pow(S, -W[9]!) *
            (Math.exp(W[10]! * (1 - R)) - 1) *
            hardPenalty *
            easyBonus);
    }

    // Difficulty update + mean reversion toward raw D0(4).
    const dPrime = D - W[6]! * (g - 3);
    difficulty = clamp(W[7]! * rawInitialDifficulty(4) + (1 - W[7]!) * dPrime, 1, 10);

    reps = prev.reps + 1;
    lapses = prev.lapses + (rating === 'again' ? 1 : 0);
  }

  // 6-decimal rounding at write time (checksum spec §5.1) so both sync sides
  // serialize identical floats.
  stability = normNum(stability);
  difficulty = normNum(difficulty);

  return {
    due: new Date(now.getTime() + intervalDays(stability) * MS_PER_DAY).toISOString(),
    stability,
    difficulty,
    reps,
    lapses,
    lastReview: now.toISOString(),
  };
}

/** Exported for the grading map (initial-state formulas). */
export const FSRS_WEIGHTS = W;
export const FSRS_MS_PER_DAY = MS_PER_DAY;
export { clamp as fsrsClamp, rawInitialDifficulty };
