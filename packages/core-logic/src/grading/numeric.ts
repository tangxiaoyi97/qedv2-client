/**
 * Numeric grading (supplement §3): each blank compares a locale-tolerant
 * parse of the raw user string against `value` within `tol`. German users
 * type decimal commas, so both "37,5" and "37.5" are accepted; a typed unit
 * suffix (the blank's own unit) is stripped before parsing.
 */
import type { NumericAnswer, Scoring } from '../model/question.js';
import type { BreakdownItem, GradeResult, NumericSubmission } from './types.js';
import { applyScoring, resolveVerdict } from './scoring.js';

/**
 * Absolute guard added on top of `tol` so IEEE-754 noise cannot reject an
 * exact tolerance-edge answer (e.g. |0.94 − 0.935| evaluates to 0.005000…04).
 */
const TOL_GUARD = 1e-12;

/**
 * Strict "simple number" parser: optional sign (ASCII or U+2212 minus),
 * digits, at most ONE decimal separator — comma or point. No thousands
 * grouping and no exponent, so locale-ambiguous inputs like "1.234,5" or
 * "1,234.5" are rejected rather than silently misread.
 */
export function parseDecimalInput(raw: string): number | undefined {
  const s = raw.trim().replace(/−/g, '-');
  if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(s)) return undefined;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

/** Drop the blank's own unit if the user typed it as a suffix ("38 km/h"). */
function stripUnitSuffix(input: string, unit: string | undefined): string {
  if (!unit) return input;
  const u = unit.trim();
  if (u.length === 0 || input.length < u.length) return input;
  if (input.slice(-u.length).toLowerCase() !== u.toLowerCase()) return input;
  return input.slice(0, input.length - u.length).trim();
}

export function gradeNumeric(
  answer: NumericAnswer,
  submission: NumericSubmission,
  scoring: Scoring | undefined,
  points: number | undefined,
): GradeResult {
  const perBlankPts = scoring?.mode === 'perBlank' ? scoring.pointsPerCorrect : undefined;

  const breakdown: BreakdownItem[] = [];
  let correctCount = 0;

  for (const blank of answer.blanks) {
    const raw = submission.values[blank.id];
    const trimmed = raw?.trim() ?? '';

    let ok = false;
    let note: string | undefined;
    if (raw === undefined || trimmed === '') {
      note = 'missing';
    } else {
      const v = parseDecimalInput(stripUnitSuffix(trimmed, blank.unit));
      if (v === undefined) note = 'unparseable';
      else if (Math.abs(v - blank.value) <= blank.tol + TOL_GUARD) ok = true;
      else note = 'out-of-tolerance';
    }
    if (ok) correctCount++;

    const item: BreakdownItem = { ref: blank.id, correct: ok };
    if (note !== undefined) item.note = note;
    if (perBlankPts !== undefined) item.awardedPoints = ok ? perBlankPts : 0;
    breakdown.push(item);
  }

  const allCorrect = correctCount === answer.blanks.length;
  const { awardedPoints, maxPoints } = applyScoring(scoring, {
    correctCount,
    totalCount: answer.blanks.length,
    allCorrect,
    fallbackPoints: points,
  });
  const verdict = resolveVerdict(awardedPoints, maxPoints, allCorrect);
  return { verdict, correct: verdict === 'correct', awardedPoints, maxPoints, breakdown };
}
