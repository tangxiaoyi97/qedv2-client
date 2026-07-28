/**
 * Height of each solution-drawer detent, in pixels.
 *
 * Pure on purpose: the rules below are what went wrong repeatedly while this
 * was inline in the component, and they cannot be exercised in a DOM without
 * layout. SolutionSheet supplies the measurements; this decides the sizes.
 */
export type SheetDetent = 'collapsed' | 'default' | 'full';

/** Room left for the practice top bar so full screen never hides it. */
export const FULL_SCREEN_RESERVE_PX = 96;
/** A half-open sheet shorter than this reads as broken rather than compact. */
export const HALF_MIN_PX = 180;
export const HALF_MAX_PX = 460;
export const HALF_MAX_VIEWPORT_RATIO = 0.6;
/** Used until the content has been measured (and where there is no layout). */
export const HALF_FALLBACK_RATIO = 0.55;

export interface DetentInput {
  viewportHeight: number;
  /** Measured height of verdict + title + answer, 0 when not yet measured. */
  answerHeight: number;
  /** Offset of the grading note; 0 when the solution carries none. */
  noteOffset: number;
}

export function resolveDetentHeights(input: DetentInput): Record<SheetDetent, number> {
  const { viewportHeight, answerHeight, noteOffset } = input;
  const full = Math.max(0, viewportHeight - FULL_SCREEN_RESERVE_PX);
  // `full` bounds the ceiling so the half detent can never outgrow the full
  // one on a short viewport, and the floor yields to the ceiling for the same
  // reason.
  const upper = Math.max(0, Math.min(viewportHeight * HALF_MAX_VIEWPORT_RATIO, HALF_MAX_PX, full));
  const lower = Math.min(HALF_MIN_PX, upper);
  const wanted = answerHeight || Math.min(viewportHeight * HALF_FALLBACK_RATIO, HALF_MAX_PX);

  let half = Math.min(Math.max(wanted, lower), upper);
  // Hiding the grading note outranks the minimum height: a short answer that
  // fits in 140px is not a broken sliver, but a note peeking over the fold
  // gives the assessment away before the reader has thought about it.
  if (noteOffset > 0) half = Math.min(half, noteOffset);

  return { collapsed: 0, default: Math.round(half), full };
}
