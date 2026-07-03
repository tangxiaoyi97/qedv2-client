/**
 * Scoring resolution (supplement §7): maps a grader's raw counts onto the
 * part's `scoring` block. The four modes are exhaustive — no penalty or
 * deduction rules exist and none may be invented. A part without `scoring`
 * behaves as allOrNothing with `points ?? 1`.
 */
import type { Scoring } from '../model/question.js';
import type { Verdict } from './types.js';

export interface ScoringContext {
  /** Correctly answered items (blanks / pairs / correctly-selected options). */
  correctCount: number;
  /** Total gradable items (informational; no mode derives points from it). */
  totalCount: number;
  /** Whole part answered perfectly (drives allOrNothing). */
  allCorrect: boolean;
  /** `part.points`, used only when `scoring` is absent. */
  fallbackPoints: number | undefined;
  /** Per-criterion flags — only meaningful for rubric scoring. */
  criteriaMet?: boolean[];
}

export interface AppliedScore {
  awardedPoints: number;
  maxPoints: number;
}

/** Comparison slack so IEEE-754 sums (e.g. 0.1+0.2) cannot flip a verdict. */
const EPS = 1e-9;

export function applyScoring(scoring: Scoring | undefined, opts: ScoringContext): AppliedScore {
  if (scoring === undefined) {
    const pts = opts.fallbackPoints ?? 1;
    return { awardedPoints: opts.allCorrect ? pts : 0, maxPoints: pts };
  }
  switch (scoring.mode) {
    case 'allOrNothing':
      return { awardedPoints: opts.allCorrect ? scoring.points : 0, maxPoints: scoring.points };
    case 'perBlank':
      return {
        awardedPoints: Math.min(opts.correctCount * scoring.pointsPerCorrect, scoring.max),
        maxPoints: scoring.max,
      };
    case 'tiered': {
      // Highest tier whose threshold is met; robust to unsorted tier arrays.
      let awarded = 0;
      let max = 0;
      for (const tier of scoring.tiers) {
        if (tier.points > max) max = tier.points;
        if (tier.minCorrect <= opts.correctCount && tier.points > awarded) awarded = tier.points;
      }
      return { awardedPoints: awarded, maxPoints: max };
    }
    case 'rubric': {
      const met = opts.criteriaMet ?? [];
      let awarded = 0;
      let max = 0;
      scoring.criteria.forEach((criterion, i) => {
        max += criterion.points;
        if (met[i] === true) awarded += criterion.points;
      });
      return { awardedPoints: awarded, maxPoints: max };
    }
  }
}

/**
 * Shared verdict rule: full points AND nothing wrong → correct; zero points
 * without a perfect answer → incorrect; anything in between → partial.
 * `GradeResult.correct` must always equal `verdict === 'correct'`.
 */
export function resolveVerdict(
  awardedPoints: number,
  maxPoints: number,
  allCorrect: boolean,
): Verdict {
  if (allCorrect && awardedPoints >= maxPoints - EPS) return 'correct';
  if (awardedPoints <= EPS && !allCorrect) return 'incorrect';
  return 'partial';
}
