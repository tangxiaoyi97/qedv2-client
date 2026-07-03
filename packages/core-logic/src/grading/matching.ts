/**
 * Matching grading (supplement §2): the user assigns one right item per left
 * item; `submission.matches[i]` is the chosen right index for left index `i`
 * (null = unassigned = wrong). `correctCount` counts pairs matched exactly,
 * which feeds tiered scoring (the mode the bank actually uses here).
 */
import type { MatchingAnswer, Scoring } from '../model/question.js';
import type { BreakdownItem, GradeResult, MatchingSubmission } from './types.js';
import { applyScoring, resolveVerdict } from './scoring.js';

export function gradeMatching(
  answer: MatchingAnswer,
  submission: MatchingSubmission,
  scoring: Scoring | undefined,
  points: number | undefined,
): GradeResult {
  const expectedByLeft = new Map<number, number>();
  for (const [l, r] of answer.pairs) expectedByLeft.set(l, r);

  const breakdown: BreakdownItem[] = [];
  let correctCount = 0;

  for (let i = 0; i < answer.left.length; i++) {
    const expected = expectedByLeft.get(i);
    // Short/absent matches entries count as unassigned.
    const chosen = submission.matches[i] ?? null;

    let ok: boolean;
    let note: string | undefined;
    if (expected === undefined) {
      // Left item without a defined pair: only "leave it unassigned" is right.
      ok = chosen === null;
      if (!ok) note = 'wrong-match';
    } else if (chosen === null) {
      ok = false;
      note = 'unassigned';
    } else if (chosen === expected) {
      ok = true;
      correctCount++; // pairs matched exactly
    } else {
      ok = false;
      note = 'wrong-match';
    }

    const item: BreakdownItem = { ref: String(i), correct: ok };
    if (note !== undefined) item.note = note;
    breakdown.push(item);
  }

  const allCorrect = breakdown.every((b) => b.correct);
  const { awardedPoints, maxPoints } = applyScoring(scoring, {
    correctCount,
    totalCount: answer.pairs.length,
    allCorrect,
    fallbackPoints: points,
  });
  const verdict = resolveVerdict(awardedPoints, maxPoints, allCorrect);
  return { verdict, correct: verdict === 'correct', awardedPoints, maxPoints, breakdown };
}
