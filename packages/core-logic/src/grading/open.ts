/**
 * Open-part grading (supplement §6): v1 is self-assessment only — the rubric
 * text is display material and `grader:"ai"` is treated as self. Points come
 * exclusively from the user's own judgement:
 *   - rubric scoring: one checkbox per criterion → sum of met criteria
 *   - otherwise: overall full / partial (half, rounded to 2 dp) / none.
 */
import type { OpenAnswer, Scoring } from '../model/question.js';
import type { BreakdownItem, GradeResult, OpenSubmission } from './types.js';
import { applyScoring, resolveVerdict } from './scoring.js';

const EPS = 1e-9;

function roundPoints(points: number): number {
  return Math.round(points * 100) / 100;
}

function maxPointsFor(scoring: Scoring | undefined, fallbackPoints: number | undefined): number {
  if (scoring === undefined) return fallbackPoints ?? 1;
  switch (scoring.mode) {
    case 'allOrNothing':
      return scoring.points;
    case 'perBlank':
      return scoring.max;
    case 'tiered':
      return scoring.tiers.reduce((max, tier) => Math.max(max, tier.points), 0);
    case 'rubric':
      return scoring.criteria.reduce((sum, criterion) => sum + criterion.points, 0);
  }
}

export function gradeOpen(
  answer: OpenAnswer,
  submission: OpenSubmission,
  scoring: Scoring | undefined,
  points: number | undefined,
): GradeResult {
  void answer; // rubric RichText + grader flag are presentation-only in v1
  const manualPoints = submission.selfAssessment.awardedPoints;
  if (typeof manualPoints === 'number' && Number.isFinite(manualPoints)) {
    const maxPoints = maxPointsFor(scoring, points);
    const awardedPoints = roundPoints(Math.min(Math.max(manualPoints, 0), maxPoints));
    const full = awardedPoints >= maxPoints - EPS;
    const verdict = resolveVerdict(awardedPoints, maxPoints, full);
    return { verdict, correct: verdict === 'correct', awardedPoints, maxPoints };
  }

  if (scoring?.mode === 'rubric') {
    const met = submission.selfAssessment.criteriaMet ?? [];
    // Missing array entries (or a missing array) read as "not met".
    const flags = scoring.criteria.map((_, i) => met[i] === true);
    const allMet = flags.every(Boolean);

    const { awardedPoints, maxPoints } = applyScoring(scoring, {
      correctCount: flags.filter(Boolean).length,
      totalCount: scoring.criteria.length,
      allCorrect: allMet,
      fallbackPoints: points,
      criteriaMet: flags,
    });

    const breakdown: BreakdownItem[] = scoring.criteria.map((criterion, i) => ({
      ref: String(i),
      correct: flags[i] === true,
      awardedPoints: flags[i] === true ? criterion.points : 0,
    }));

    const verdict = resolveVerdict(awardedPoints, maxPoints, allMet);
    return { verdict, correct: verdict === 'correct', awardedPoints, maxPoints, breakdown };
  }

  // Non-rubric: derive the displayable max from whatever scoring is present
  // (allOrNothing points, or the points ?? 1 fallback), then apply overall.
  const { maxPoints } = applyScoring(scoring, {
    correctCount: 1,
    totalCount: 1,
    allCorrect: true,
    fallbackPoints: points,
  });

  const overall = submission.selfAssessment.overall ?? 'none';
  const awardedPoints =
    overall === 'full'
      ? maxPoints
      : overall === 'partial'
        ? Math.round((maxPoints / 2) * 100) / 100
        : 0;

  const verdict = resolveVerdict(awardedPoints, maxPoints, overall === 'full');
  return { verdict, correct: verdict === 'correct', awardedPoints, maxPoints };
}
