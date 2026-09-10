/**
 * Height of each solution-drawer detent, in pixels.
 *
 * Pure on purpose: the rules below are what went wrong repeatedly while this
 * was inline in the component, and they cannot be exercised in a DOM without
 * layout. SolutionSheet supplies the measurements; this decides the sizes.
 */
export type SheetDetent = 'collapsed' | 'default' | 'full';
const DETENT_ORDER: readonly SheetDetent[] = ['collapsed', 'default', 'full'];

/** A deliberate short pull should be enough; distance is capped so a tall
 * phone never asks the thumb to travel half the screen. */
export const SHEET_SWIPE_DISTANCE_PX = 36;
/** A quick flick commits after enough movement to distinguish it from a tap. */
export const SHEET_FLICK_VELOCITY_PX_S = 320;
export const SHEET_FLICK_MIN_DISTANCE_PX = 12;
/** A small settling jitter must not reverse an otherwise deliberate pull. */
export const SHEET_REVERSAL_DISTANCE_PX = 8;
/** Momentum expires when the finger pauses, even if older samples were fast. */
export const SHEET_FLICK_MAX_IDLE_MS = 100;
/** Coincident stops are one visible position, including measurement rounding. */
const DISTINCT_DETENT_PX = 2;
/** Short momentum look-ahead, used only to decide which side of a snap point
 * the gesture was heading toward. */
export const SHEET_PROJECTION_MS = 180;

/**
 * Room left above the sheet at full screen: the practice top bar (56px plus
 * whatever the notch adds) with a little breathing space. Everything BELOW
 * the sheet inside the same fixed stack — the grab handle, the verdict
 * banner, the action row — is measured and passed in as `chromeHeight`,
 * because a constant for it went stale the moment the banner was added and
 * the bar started riding over the top bar.
 */
export const TOP_BAR_RESERVE_PX = 72;
/**
 * The full-screen target deliberately aims a few pixels PAST the available
 * space. The bar's CSS `max-height` is the real boundary (see
 * PracticeBottomBar), so overshooting cannot cause an overlap — but it does
 * absorb the rounding in this arithmetic and in the measured chrome, which
 * otherwise left a 2px stripe of page background between the sheet and the
 * top bar. Aim past the wall; let the wall decide.
 */
export const FULL_OVERSHOOT_PX = 6;
/** Minimum estimate before the official answer has a measured height. */
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
  /**
   * Everything in the fixed bottom stack that is NOT the sheet — handle,
   * banner, action row. Measured by the sheet; 0 before first layout.
   */
  chromeHeight?: number;
  /**
   * Room to keep clear above the sheet. Defaults to TOP_BAR_RESERVE_PX, but
   * the practice shell measures its real top bar (56px plus the notch) and
   * passes that instead — no constant here can know the safe-area inset.
   */
  topReserve?: number;
}

export interface SheetReleaseInput {
  detent: SheetDetent;
  heights: Record<SheetDetent, number>;
  startHeight: number;
  height: number;
  /** Positive grows the sheet (an upward finger movement), in px/s. */
  velocity: number;
  /** Signed travel in the last same-direction segment, reset on reversal.
   * This disambiguates the final intent from a velocity averaged before it. */
  recentDisplacement?: number;
  /** Time since the last actual movement, excluding stationary release samples. */
  idleMs?: number;
}

/**
 * Resolve one drag into one adjacent detent.
 *
 * Distance alone made a phone user pull the drawer most of the way before it
 * would move. This decision combines intent, release velocity and a short
 * momentum projection. One gesture advances at most one stop, keeping a
 * small flick predictable instead of unexpectedly swallowing the question.
 * Stops with the same visible height are skipped. The latest deliberate
 * directional segment wins over velocity collected before a reversal.
 */
export function resolveSheetRelease(input: SheetReleaseInput): SheetDetent {
  const currentIndex = DETENT_ORDER.indexOf(input.detent);
  const displacement = input.height - input.startHeight;
  const recent = input.recentDisplacement ?? displacement;
  const reversed = Math.sign(recent) !== Math.sign(displacement)
    && Math.abs(recent) >= SHEET_REVERSAL_DISTANCE_PX;
  const directedDistance = reversed ? recent : displacement;
  const intent = Math.sign(directedDistance);
  if (intent === 0) return input.detent;

  // A shortened viewport can put default and full at the same height. Skip
  // such labels rather than consuming the gesture without visibly moving.
  let next: SheetDetent | undefined;
  for (let index = currentIndex + intent; index >= 0 && index < DETENT_ORDER.length; index += intent) {
    const candidate = DETENT_ORDER[index]!;
    if ((input.heights[candidate] - input.heights[input.detent]) * intent > DISTINCT_DETENT_PX) {
      next = candidate;
      break;
    }
  }
  if (!next) return input.detent;

  // Velocity may confirm the final direction, never override it. Requiring
  // real final-segment travel also blocks a noisy high-speed tap or a stale
  // flick sampled before a pause. A completed short pull still commits even
  // when held still before release.
  const velocity = Math.sign(input.velocity) === intent
    && Math.sign(recent) === intent
    && Math.abs(recent) >= SHEET_FLICK_MIN_DISTANCE_PX
    && (input.idleMs ?? 0) < SHEET_FLICK_MAX_IDLE_MS
      ? input.velocity
      : 0;
  const gap = Math.abs(input.heights[next] - input.heights[input.detent]);
  const distanceThreshold = Math.min(SHEET_SWIPE_DISTANCE_PX, Math.max(18, gap * 0.16), gap);
  const projected = input.height + velocity * (SHEET_PROJECTION_MS / 1000);
  const midpoint = (input.heights[input.detent] + input.heights[next]) / 2;
  const crossesProjectedMidpoint = intent > 0 ? projected >= midpoint : projected <= midpoint;
  const committed =
    Math.abs(directedDistance) >= distanceThreshold ||
    Math.abs(velocity) >= SHEET_FLICK_VELOCITY_PX_S ||
    crossesProjectedMidpoint;

  return committed ? next : input.detent;
}

export function resolveDetentHeights(input: DetentInput): Record<SheetDetent, number> {
  const {
    viewportHeight,
    answerHeight,
    noteOffset,
    chromeHeight = 0,
    topReserve = TOP_BAR_RESERVE_PX,
  } = input;
  const full = Math.max(0, viewportHeight - topReserve - chromeHeight + FULL_OVERSHOOT_PX);
  // `full` bounds the ceiling so the half detent can never outgrow the full
  // one on a short viewport, and the floor yields to the ceiling for the same
  // reason.
  const upper = Math.max(0, Math.min(viewportHeight * HALF_MAX_VIEWPORT_RATIO, HALF_MAX_PX, full));
  const lower = Math.min(HALF_MIN_PX, upper);
  const measured = answerHeight > 0;
  const wanted = measured ? answerHeight : Math.min(viewportHeight * HALF_FALLBACK_RATIO, HALF_MAX_PX);

  // Once measured, stop at the answer even if it is shorter than the estimate.
  // The rest of the solution stays in the scrollable content below the fold.
  let half = Math.min(measured ? wanted : Math.max(wanted, lower), upper);
  // An earlier detail boundary also caps the initial reading height.
  if (noteOffset > 0) half = Math.min(half, noteOffset);

  return { collapsed: 0, default: Math.round(half), full };
}
