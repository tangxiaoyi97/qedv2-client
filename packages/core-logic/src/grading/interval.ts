/**
 * Interval grading (supplement §4): both bounds AND both closedness flags
 * must match. `null` bounds mean ±∞; users may type '', '-inf', '∞', '-oo'
 * etc. (case-insensitive, optional sign) for an unbounded endpoint. When a
 * bound is null its closed flag is ignored — an infinite endpoint is
 * inherently open, so UIs may leave the flag in any state.
 */
import type { IntervalAnswer, Scoring } from '../model/question.js';
import type { BreakdownItem, GradeResult, IntervalSubmission } from './types.js';
import { applyScoring, resolveVerdict } from './scoring.js';
import { parseDecimalInput } from './numeric.js';

/** Numeric bound comparison epsilon (values come from short exam decimals). */
const BOUND_EPS = 1e-9;

const UNBOUNDED_RE = /^[+\-−]?(?:inf|oo|∞)$/i;

/** Parsed bound: a finite number, null (= unbounded), or a parse failure. */
export function parseBoundInput(raw: string): { value: number | null } | { error: 'unparseable' } {
  const s = raw.trim();
  if (s === '' || UNBOUNDED_RE.test(s)) return { value: null };
  const v = parseDecimalInput(s);
  return v === undefined ? { error: 'unparseable' } : { value: v };
}

function checkBound(
  expected: number | null,
  expectedClosed: boolean,
  raw: string,
  submittedClosed: boolean,
): { ok: boolean; note?: string } {
  const parsed = parseBoundInput(raw);
  if ('error' in parsed) return { ok: false, note: 'unparseable' };
  if (expected === null || parsed.value === null) {
    // Closedness flags do not participate when either side is infinite.
    return expected === parsed.value ? { ok: true } : { ok: false, note: 'wrong-bound' };
  }
  if (Math.abs(parsed.value - expected) > BOUND_EPS) return { ok: false, note: 'wrong-bound' };
  if (submittedClosed !== expectedClosed) return { ok: false, note: 'closedness-mismatch' };
  return { ok: true };
}

export function gradeInterval(
  answer: IntervalAnswer,
  submission: IntervalSubmission,
  scoring: Scoring | undefined,
  points: number | undefined,
): GradeResult {
  const lower = checkBound(answer.lower, answer.lowerClosed, submission.lower, submission.lowerClosed);
  const upper = checkBound(answer.upper, answer.upperClosed, submission.upper, submission.upperClosed);

  const breakdown: BreakdownItem[] = [
    { ref: 'lower', correct: lower.ok },
    { ref: 'upper', correct: upper.ok },
  ];
  if (lower.note !== undefined) breakdown[0]!.note = lower.note;
  if (upper.note !== undefined) breakdown[1]!.note = upper.note;

  const correctCount = (lower.ok ? 1 : 0) + (upper.ok ? 1 : 0);
  const allCorrect = lower.ok && upper.ok;
  const { awardedPoints, maxPoints } = applyScoring(scoring, {
    correctCount,
    totalCount: 2,
    allCorrect,
    fallbackPoints: points,
  });
  const verdict = resolveVerdict(awardedPoints, maxPoints, allCorrect);
  return { verdict, correct: verdict === 'correct', awardedPoints, maxPoints, breakdown };
}
