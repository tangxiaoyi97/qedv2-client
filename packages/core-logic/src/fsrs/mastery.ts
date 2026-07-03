/**
 * Per-competency mastery — exponential moving average over grade ratios
 * (ratio = awardedPoints / maxPoints of the graded part; the caller computes
 * it). Each graded part updates every competency attached to that part.
 */

export const MASTERY_ALPHA = 0.3;

/**
 * EMA step: first grade initializes to the ratio itself, later grades move
 * the estimate by MASTERY_ALPHA toward the new ratio. Result clamped to
 * [0, 1] so malformed ratios can never corrupt the archive.
 */
export function updateMastery(prev: number | undefined, ratio: number): number {
  const next = prev == null ? ratio : prev + MASTERY_ALPHA * (ratio - prev);
  return Math.min(1, Math.max(0, next));
}

/** Coarse bucket for UI labels (gering / mittel / hoch). */
export function masteryLevel(m: number): 'low' | 'medium' | 'high' {
  return m < 0.4 ? 'low' : m < 0.7 ? 'medium' : 'high';
}
