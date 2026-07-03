/**
 * Grading entry point (brief §4): `grade(part, submission)` is a PURE
 * function — no I/O, no clock, no side effects. Dispatch happens on
 * `part.answer.kind`; the submission kind must agree (a mismatch is a
 * programmer error in the calling UI, hence a thrown GradingKindMismatch).
 */
import type { QuestionPart } from '../model/question.js';
import type {
  ChoiceSubmission,
  ExpressionSubmission,
  GradeOutcome,
  IntervalSubmission,
  MatchingSubmission,
  NumericSubmission,
  OpenSubmission,
  Submission,
} from './types.js';
import { GradingKindMismatch } from './types.js';
import { gradeChoice } from './choice.js';
import { gradeMatching } from './matching.js';
import { gradeNumeric } from './numeric.js';
import { gradeInterval } from './interval.js';
import { gradeExpression } from './expression.js';
import { gradeOpen } from './open.js';

export function grade(part: QuestionPart, submission: Submission): GradeOutcome {
  const answer = part.answer;
  // Non-playable parts must be filtered out upstream (Question.playable).
  if (!answer) throw new Error('part not gradable: no answer data');
  if (submission.kind !== answer.kind) throw new GradingKindMismatch(answer.kind, submission.kind);

  // The kind equality above guarantees each cast; TS cannot correlate the
  // two independent discriminated unions on its own.
  switch (answer.kind) {
    case 'choice':
      return gradeChoice(answer, submission as ChoiceSubmission, part.scoring, part.points);
    case 'matching':
      return gradeMatching(answer, submission as MatchingSubmission, part.scoring, part.points);
    case 'numeric':
      return gradeNumeric(answer, submission as NumericSubmission, part.scoring, part.points);
    case 'interval':
      return gradeInterval(answer, submission as IntervalSubmission, part.scoring, part.points);
    case 'expression':
      return gradeExpression(answer, submission as ExpressionSubmission, part.scoring, part.points);
    case 'open':
      return gradeOpen(answer, submission as OpenSubmission, part.scoring, part.points);
  }
}

export * from './types.js';
export * from './scoring.js';
export * from './choice.js';
export * from './matching.js';
export * from './numeric.js';
export * from './interval.js';
export * from './expression.js';
export * from './open.js';
