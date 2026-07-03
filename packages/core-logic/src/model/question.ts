/**
 * Question model — mirrors the bank's authoritative Zod schema
 * (srdpmppr `schema/question.ts`, schemaVersion 2) as consumed through the
 * qed2-core API (contract §1.1 / §3.1). The client never redefines semantics;
 * these types describe what the wire actually carries.
 */
import type { RichText } from './richtext.js';

export type QuestionStatus = 'linked' | 'converted' | 'reviewed' | 'deprecated';

export type Term =
  | 'haupttermin'
  | 'nebentermin-1'
  | 'nebentermin-2'
  | 'herbsttermin'
  | 'wintertermin';

export type ExamPart = 't1' | 't2';

export interface QuestionSource {
  suite: string;
  year: number;
  term: Term;
  part: ExamPart;
  nr: number;
  file: string;
}

export interface Competency {
  code: string; // e.g. "AN 4.3" — categories AG / FA / AN / WS
  description?: string;
  source?: string;
  verifiedAt?: string;
}

/* ------------------------------------------------------------------ *
 * Answers (grading data, public) — dispatch on `kind`.
 * ------------------------------------------------------------------ */

export interface ChoiceAnswer {
  kind: 'choice';
  options: RichText[];
  /** 0-based indices of the correct options. Set comparison, order-free. */
  correct: number[];
  /** How many options must be selected ("2 aus 5" → 2). */
  selectCount: number;
}

export interface MatchingAnswer {
  kind: 'matching';
  left: RichText[];
  right: RichText[];
  /** Correct pairs as [leftIndex, rightIndex]. */
  pairs: [number, number][];
}

export interface NumericBlank {
  id: string;
  value: number;
  /** Accept |input − value| <= tol. */
  tol: number;
  unit?: string;
}

export interface NumericAnswer {
  kind: 'numeric';
  blanks: NumericBlank[];
}

export interface IntervalAnswer {
  kind: 'interval';
  /** null = −∞ */
  lower: number | null;
  /** null = +∞ */
  upper: number | null;
  lowerClosed: boolean;
  upperClosed: boolean;
}

export interface ExpressionAnswer {
  kind: 'expression';
  /**
   * Canonical correct expression. NOTE: the bank stores KaTeX-flavoured
   * source (e.g. "x_n\\cdot 1{,}03" — German decimal comma as `{,}`).
   * The grading engine normalizes this before CAS comparison.
   */
  canonical: string;
  vars: string[];
  checker: 'cas';
}

export interface OpenAnswer {
  kind: 'open';
  rubric: RichText;
  /** v1 always self-assesses; "ai" is reserved (server-side, disabled). */
  grader: 'self' | 'ai';
}

export type Answer =
  | ChoiceAnswer
  | MatchingAnswer
  | NumericAnswer
  | IntervalAnswer
  | ExpressionAnswer
  | OpenAnswer;

export type AnswerKind = Answer['kind'];

/* ------------------------------------------------------------------ *
 * Scoring — dispatch on `mode` (contract §1.1, supplement §7).
 * ------------------------------------------------------------------ */

export interface AllOrNothingScoring {
  mode: 'allOrNothing';
  points: number;
}

export interface PerBlankScoring {
  mode: 'perBlank';
  pointsPerCorrect: number;
  max: number;
}

export interface TieredScoring {
  mode: 'tiered';
  tiers: { minCorrect: number; points: number }[];
}

export interface RubricCriterion {
  desc: RichText;
  points: number;
}

export interface RubricScoring {
  mode: 'rubric';
  criteria: RubricCriterion[];
}

export type Scoring =
  | AllOrNothingScoring
  | PerBlankScoring
  | TieredScoring
  | RubricScoring;

/* ------------------------------------------------------------------ *
 * Figures / solution / parts / question.
 * ------------------------------------------------------------------ */

/** Figure union — image is the norm; other kinds render via their fields. */
export interface ImageFigure {
  kind: 'image';
  src: string;
  alt?: string;
  [key: string]: unknown;
}
export interface OtherFigure {
  kind: string;
  [key: string]: unknown;
}
export type Figure = ImageFigure | OtherFigure;

/**
 * Solution entries as actually served by core: each step/alternative is an
 * object with a RichText `result`, an optional grader `note` and figures.
 */
export interface SolutionEntry {
  result: RichText;
  note?: string;
  figures?: Figure[];
}

export interface QuestionPart {
  id: string;
  label: string;
  /** Official Antwortformat verbatim — display only, never dispatch on it. */
  format?: string;
  competencies: Competency[];
  prompt?: RichText;
  figures?: Figure[];
  answer?: Answer;
  scoring?: Scoring;
  points?: number;
  solution?: SolutionEntry[];
  externalRefs?: unknown[];
}

export interface Question {
  id: string;
  schemaVersion: number;
  status: QuestionStatus;
  lang: string;
  source: QuestionSource;
  title: string;
  rights?: { thirdPartyMaterial: boolean; note?: string };
  assets?: { questionPdf?: string; solutionPdf?: string };
  prompt?: RichText;
  figures?: Figure[];
  parts: QuestionPart[];
  externalRefs?: unknown[];
  /** Provided by core; false/absent answer ⇒ not answerable. */
  playable?: boolean;
}

/* ------------------------------------------------------------------ *
 * List/summary shapes (GET /content/questions).
 * ------------------------------------------------------------------ */

export interface QuestionPartSummary {
  id: string;
  label: string;
  format?: string;
  competencies: Competency[];
  hasFigures: boolean;
}

export interface QuestionSummary {
  id: string;
  title: string;
  source: QuestionSource;
  status: QuestionStatus;
  totalPoints: number;
  playable: boolean;
  parts: QuestionPartSummary[];
}

/** Grundkompetenz top-level category ("AG 1.1" → "AG"). */
export function competencyCategory(code: string): 'AG' | 'FA' | 'AN' | 'WS' | 'other' {
  const cat = code.slice(0, 2).toUpperCase();
  return cat === 'AG' || cat === 'FA' || cat === 'AN' || cat === 'WS' ? cat : 'other';
}
