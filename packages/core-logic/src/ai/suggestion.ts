/**
 * Pure policy for turning an AI assessment into a proposed self-assessment.
 *
 * The model never commits a grade. This function only prepares the same
 * SelfAssessment shape a person can select, and the UI still requires the
 * explicit „Bewertung übernehmen“ action before progress/FSRS is written.
 */
import type { SelfAssessment } from '../grading/types.js';
import type { AiAssessResponse } from './types.js';

export const AI_SUGGESTION_CONFIDENCE_FLOOR = 0.75;

export function suggestedSelfAssessment(input: {
  answer: AiAssessResponse;
  current: SelfAssessment;
  maxPoints: number;
  criterionCount: number;
  allowedPoints?: readonly number[];
  confidenceFloor?: number;
}): SelfAssessment | null {
  const { answer, current, maxPoints, criterionCount } = input;
  if (answer.advisoryOnly) return null;
  const floor = input.confidenceFloor ?? AI_SUGGESTION_CONFIDENCE_FLOOR;

  if (answer.overall) {
    const { points, confidence, quoteVerified } = answer.overall;
    if (!Number.isFinite(points) || points < 0 || points > maxPoints) return null;
    if (input.allowedPoints && !input.allowedPoints.some((allowed) => Math.abs(allowed - points) < 1e-9)) {
      return null;
    }
    // A zero needs no quote: having nothing to cite is itself the finding.
    if (confidence < floor || (points > 0 && !quoteVerified)) return null;
    return {
      ...current,
      awardedPoints: points,
      overall: points >= maxPoints ? 'full' : points > 0 ? 'partial' : 'none',
    };
  }

  if (!answer.criteria || criterionCount <= 0) return null;
  const criteriaMet = Array.from({ length: criterionCount }, (_, index) => {
    const verdict = answer.criteria?.find((criterion) => criterion.index === index);
    return Boolean(
      verdict?.met && verdict.confidence >= floor && verdict.quoteVerified,
    );
  });
  return { ...current, criteriaMet };
}
