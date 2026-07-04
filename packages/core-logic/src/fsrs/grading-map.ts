/**
 * Grading → FSRS mapping (grading supplement §1.3, "做法二").
 *
 * WHY THIS MAPPING (required rationale — also in the README):
 * FSRS natively has a single failure grade (Again), but in exam practice a
 * wrong answer has very different severities: a careless slip (the skill IS
 * there) and genuine bafflement need different review pressure. Treating
 * every error as Again would over-repeat careless slips; treating careless
 * as a success (Good) would wrongly stretch the interval — the answer WAS
 * wrong. So:
 *
 *   good     → Good  — normal interval growth.
 *   careless → Hard, NOT counted as a lapse — acknowledges "actually known,
 *              just slipped": a mild stretch instead of a reset, and no
 *              punishment as forgetting (the Hard path in fsrs.ts never
 *              increments lapses and uses the success formula with the w15
 *              penalty).
 *   meh      → Again with a SHORT relearn interval (1–3 days) — genuinely
 *              not retained, come back soon, but not a total blank.
 *   baffled  → Again with a FULL reset — stability collapses to the
 *              first-review 'again' value and the part is due immediately.
 *   excluded → completely frozen: no scheduling at all (supplement §1.4).
 *              Re-grading to any other value thaws it (the next advance
 *              starts from the frozen state).
 *
 * meh and baffled both map to Again (both ARE failures, both lapse), but get
 * distinct comeback intervals — three failure flavors with genuinely
 * different scheduling effects instead of one blunt reset.
 *
 * Auto-defaults after grading a part (supplement §1.2): correct → good,
 * incorrect → baffled. Partial credit is not covered by the supplement; we
 * map partial → meh ("half known") — a manual pick always overrides.
 */
import type { FsrsState, Grading, GradingOrUnseen, PartEntry } from '../model/archive.js';
import type { Verdict } from '../grading/types.js';
import {
  advanceFsrs,
  intervalDays,
  FSRS_WEIGHTS,
  FSRS_MS_PER_DAY,
  fsrsClamp,
  rawInitialDifficulty,
} from './fsrs.js';
import { normNum } from '../model/archive.js';

/** Auto grading derived from the objective grade result (manual overrides win). */
export function verdictToAutoGrading(v: Verdict): Grading {
  return v === 'correct' ? 'good' : v === 'partial' ? 'meh' : 'baffled';
}

/** meh comeback window: standard post-lapse interval clamped to [1, 3] days. */
const MEH_MAX_RELEARN_DAYS = 3;

/**
 * Placeholder FSRS state for entries created WITHOUT a review (starring or
 * excluding a never-practiced part). reps === 0 marks "never actually
 * reviewed" — such entries are skipped by due-counting and by the
 * recommendation userState (they must still count as unseen for core).
 */
export function placeholderFsrs(now: Date): FsrsState {
  return {
    due: now.toISOString(),
    stability: 0.01,
    difficulty: 5,
    reps: 0,
    lapses: 0,
    lastReview: null,
  };
}

/**
 * Advance the FSRS state for one grading event at `now` (supplement §1.3).
 * `prev === undefined` means first contact (new card semantics).
 * excluded freezes: the previous state is returned untouched (or a reps-0
 * placeholder when there is none).
 */
export function advanceFsrsForGrading(
  prev: FsrsState | undefined,
  grading: Grading,
  now: Date,
): FsrsState {
  switch (grading) {
    case 'good':
      return advanceFsrs(prev, 'good', now);
    case 'careless':
      // Hard without lapse — see module header.
      return advanceFsrs(prev, 'hard', now);
    case 'meh': {
      const next = advanceFsrs(prev, 'again', now);
      const days = fsrsClamp(intervalDays(next.stability), 1, MEH_MAX_RELEARN_DAYS);
      return { ...next, due: new Date(now.getTime() + days * FSRS_MS_PER_DAY).toISOString() };
    }
    case 'baffled': {
      // Full reset: stability collapses to the first-review 'again' value,
      // difficulty to its 'again' initialization; due immediately.
      const stability = normNum(FSRS_WEIGHTS[0]!);
      const difficulty = normNum(fsrsClamp(rawInitialDifficulty(1), 1, 10));
      return {
        due: now.toISOString(),
        stability,
        difficulty,
        reps: (prev?.reps ?? 0) + 1,
        lapses: (prev?.lapses ?? 0) + 1,
        lastReview: now.toISOString(),
      };
    }
    case 'excluded':
      // Frozen — no scheduling. Keep state so un-excluding resumes from it.
      return prev ?? placeholderFsrs(now);
  }
}

/** User-facing grading of an entry ('unseen' = no entry / no grading). */
export function gradingOf(entry: PartEntry | undefined): GradingOrUnseen {
  return entry?.grading ?? 'unseen';
}

/** Was this part ever actually reviewed (vs. a starred/excluded placeholder)? */
export function isPracticed(entry: PartEntry): boolean {
  return entry.fsrs.reps > 0 || entry.lastResult != null;
}

/**
 * Due check honoring the excluded freeze (supplement §1.4): excluded parts
 * are NEVER due; reps-0 placeholders are not practiced, hence not due.
 */
export function isPartDue(entry: PartEntry, now: Date): boolean {
  if (entry.grading === 'excluded') return false;
  if (!isPracticed(entry)) return false;
  return now.getTime() >= new Date(entry.fsrs.due).getTime();
}

/**
 * Far-future due stamp used when projecting excluded parts into the
 * recommendation userState: keeps them "practiced" (never offered as new)
 * while guaranteeing core never schedules them as due review. The client
 * additionally filters recommendation RESULTS by excluded partIds.
 */
export const EXCLUDED_DUE_SENTINEL = '9999-12-31T00:00:00.000Z';
