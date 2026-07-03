/**
 * Grading contracts (webclient brief §4, supplement §0–§7).
 *
 * Grading is a PURE FUNCTION of (part, submitted answer) — no side effects,
 * no clock, no I/O — so it is testable and reusable across platforms.
 */
import type { AnswerKind } from '../model/question.js';

/* ------------------------------------------------------------------ *
 * What the user submits, per answer kind. Raw user input is kept as
 * strings where locale parsing matters (decimal comma vs point).
 * ------------------------------------------------------------------ */

export interface ChoiceSubmission {
  kind: 'choice';
  /** Selected option indices (0-based). */
  selected: number[];
}

export interface MatchingSubmission {
  kind: 'matching';
  /** For each left index: chosen right index, or null if unassigned. */
  matches: (number | null)[];
}

export interface NumericSubmission {
  kind: 'numeric';
  /** blank id → raw user input ("3,14" and "3.14" both accepted). */
  values: Record<string, string>;
}

export interface IntervalSubmission {
  kind: 'interval';
  /** Raw bound inputs; '' | '-inf' | '∞' etc. mean unbounded (see grader). */
  lower: string;
  upper: string;
  lowerClosed: boolean;
  upperClosed: boolean;
}

export interface ExpressionSubmission {
  kind: 'expression';
  /** Raw expression input (mathjs-flavoured syntax, tolerant parsing). */
  expr: string;
}

/**
 * Self-assessment for `open` parts and for `expression` parts that fell back
 * to self-assessment. Exactly one of the fields is used:
 *  - `criteriaMet` when scoring.mode === 'rubric' (one flag per criterion)
 *  - `overall` otherwise (maps to full / half / zero points)
 */
export interface SelfAssessment {
  criteriaMet?: boolean[];
  overall?: 'full' | 'partial' | 'none';
}

export interface OpenSubmission {
  kind: 'open';
  /** The user's written answer ('' allowed — "answered on paper"). */
  text: string;
  selfAssessment: SelfAssessment;
}

export type Submission =
  | ChoiceSubmission
  | MatchingSubmission
  | NumericSubmission
  | IntervalSubmission
  | ExpressionSubmission
  | OpenSubmission;

/* ------------------------------------------------------------------ *
 * Grade results.
 * ------------------------------------------------------------------ */

export type Verdict = 'correct' | 'partial' | 'incorrect';

/** Per-item detail (per option / pair / blank / criterion). */
export interface BreakdownItem {
  /** Index or blank-id this item refers to. */
  ref: string;
  correct: boolean;
  awardedPoints?: number;
  /** Machine-readable note, e.g. 'missed' | 'wrong-pick' | 'out-of-tolerance'. */
  note?: string;
}

export interface GradeResult {
  verdict: Verdict;
  /** True iff verdict === 'correct' (kept for archive LastResult.correct). */
  correct: boolean;
  awardedPoints: number;
  maxPoints: number;
  breakdown?: BreakdownItem[];
}

/**
 * `expression` grading may be indeterminate: the CAS cannot reliably decide
 * equivalence (contract & supplement §5: never hard-fail the user — fall back
 * to self-assessment against the displayed correct answer).
 */
export interface IndeterminateResult {
  verdict: 'indeterminate';
  reason: 'cas-parse-error' | 'cas-unreliable';
  maxPoints: number;
}

export type GradeOutcome = GradeResult | IndeterminateResult;

export function isIndeterminate(o: GradeOutcome): o is IndeterminateResult {
  return o.verdict === 'indeterminate';
}

/** Kind-mismatch guard error thrown by the dispatcher on programmer error. */
export class GradingKindMismatch extends Error {
  constructor(expected: AnswerKind | 'unknown', got: string) {
    super(`grading: submission kind "${got}" does not match answer kind "${expected}"`);
  }
}
