import type { Answer, IntervalSubmission, Submission } from '@qed2/core-logic';
import { parseBoundInput } from '@qed2/core-logic';

export interface AnswerPreview {
  label: string;
  value: string;
  hint?: string;
}

export function answerPreview(answer: Answer, submission: Submission): AnswerPreview | null {
  if (answer.kind === 'interval' && submission.kind === 'interval') {
    return {
      label: 'Ergebnis',
      value: formatIntervalSubmissionPreview(submission),
    };
  }
  return null;
}

export function formatIntervalSubmissionPreview(submission: IntervalSubmission): string {
  const lb = submission.lowerClosed && !isUnbounded(submission.lower) ? '[' : '(';
  const ub = submission.upperClosed && !isUnbounded(submission.upper) ? ']' : ')';
  return `${lb} ${intervalBoundText(submission.lower, 'lower')} ; ${intervalBoundText(submission.upper, 'upper')} ${ub}`;
}

export function intervalBoundText(raw: string, side: 'lower' | 'upper'): string {
  if (isUnbounded(raw)) return side === 'lower' ? '−∞' : '∞';
  return raw.trim();
}

function isUnbounded(raw: string): boolean {
  const parsed = parseBoundInput(raw);
  return 'value' in parsed && parsed.value === null;
}
