/**
 * Submission scaffolding shared by the answer controls and the practice flow.
 */
import type { Answer } from '@qed2/core-logic';
import type { Submission } from '@qed2/core-logic';

export function emptySubmission(answer: Answer): Submission {
  switch (answer.kind) {
    case 'choice':
      return { kind: 'choice', selected: [] };
    case 'matching':
      return { kind: 'matching', matches: answer.left.map(() => null) };
    case 'numeric': {
      const values: Record<string, string> = {};
      for (const b of answer.blanks) values[b.id] = '';
      return { kind: 'numeric', values };
    }
    case 'interval':
      return { kind: 'interval', lower: '', upper: '', lowerClosed: true, upperClosed: true };
    case 'expression':
      return { kind: 'expression', expr: '' };
    case 'open':
      return { kind: 'open', text: '', selfAssessment: {} };
  }
}

/** Enough input present to allow "Überprüfen"? (Not a correctness check.) */
export function isSubmissionComplete(answer: Answer, submission: Submission): boolean {
  switch (submission.kind) {
    case 'choice':
      return answer.kind === 'choice' && submission.selected.length === answer.selectCount;
    case 'matching':
      return submission.matches.every((m) => m !== null);
    case 'numeric':
      return Object.values(submission.values).every((v) => v.trim() !== '');
    case 'interval':
      // empty bound is legal (= unbounded); at least one bound must be present
      return submission.lower.trim() !== '' || submission.upper.trim() !== '';
    case 'expression':
      return submission.expr.trim() !== '';
    case 'open':
      // "answered on paper" is allowed — an empty text may still proceed
      return true;
  }
}
