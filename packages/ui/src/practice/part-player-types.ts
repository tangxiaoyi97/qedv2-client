/**
 * PartPlayer ⇄ shell contract for chromeless mode: the shell (PracticeView's
 * sticky bottom bar) renders the primary action, feedback pill and solution
 * sheet; PartPlayer reports its state and exposes imperative triggers.
 */
import type { GradeResult } from '@qed2/core-logic';
import type { AnswerPreview } from '../question/submission-preview.js';
import type { SelfAssessmentUiState } from './self-assessment.js';

export interface PartPlayerState {
  phase: 'answering' | 'self-assessing' | 'reviewed';
  /** Enough input to allow Überprüfen (answering phase only). */
  canSubmit: boolean;
  /** Final result once reviewed. */
  result: GradeResult | null;
  /** Expression fell back to self-assessment (CAS indeterminate). */
  indeterminate: boolean;
  /** Part is not answerable at all (no answer data). */
  unplayable: boolean;
  /** Live user-answer preview for controls that expose one. */
  answerPreview: AnswerPreview | null;
  /** Supported manual assessment choices while phase === 'self-assessing'. */
  selfAssessment: SelfAssessmentUiState | null;
}
