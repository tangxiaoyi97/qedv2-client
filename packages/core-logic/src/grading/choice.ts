/**
 * Choice grading (supplement §1): pure set comparison against `correct` —
 * order-free, duplicate selections deduped. A wrong pick carries no penalty;
 * it merely breaks set equality (allOrNothing) and contributes nothing to
 * `correctCount` (perBlank/tiered count correctly SELECTED options only).
 */
import type { ChoiceAnswer, Scoring } from '../model/question.js';
import type { BreakdownItem, ChoiceSubmission, GradeResult } from './types.js';
import { applyScoring, resolveVerdict } from './scoring.js';

export function gradeChoice(
  answer: ChoiceAnswer,
  submission: ChoiceSubmission,
  scoring: Scoring | undefined,
  points: number | undefined,
): GradeResult {
  const correctSet = new Set(answer.correct);
  const selectedSet = new Set(submission.selected);

  const breakdown: BreakdownItem[] = answer.options.map((_, i) => {
    const picked = selectedSet.has(i);
    const shouldPick = correctSet.has(i);
    const item: BreakdownItem = { ref: String(i), correct: picked === shouldPick };
    if (picked && shouldPick) item.note = 'correct-pick';
    else if (picked && !shouldPick) item.note = 'wrong-pick';
    else if (!picked && shouldPick) item.note = 'missed';
    // correctly-unselected options carry no note (key omitted, not undefined)
    return item;
  });

  let correctCount = 0;
  for (const i of selectedSet) if (correctSet.has(i)) correctCount++;

  // Set equality; a selection outside the option range breaks it as well.
  const allCorrect =
    selectedSet.size === correctSet.size && [...selectedSet].every((i) => correctSet.has(i));

  const { awardedPoints, maxPoints } = applyScoring(scoring, {
    correctCount,
    totalCount: correctSet.size,
    allCorrect,
    fallbackPoints: points,
  });
  const verdict = resolveVerdict(awardedPoints, maxPoints, allCorrect);
  return { verdict, correct: verdict === 'correct', awardedPoints, maxPoints, breakdown };
}
