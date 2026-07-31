/**
 * Wire types for the AI endpoints, shared by every shell.
 *
 * These mirror the server DTOs exactly. They live in core-logic rather than in
 * the web package because a desktop or iOS shell will speak the same protocol
 * — and because building the payload is pure logic worth testing without a
 * browser (see projection.ts).
 */
import type { Verdict } from '../grading/types.js';

export type AiProviderId = 'openai' | 'gemini';

/** Which key paid for a call. Surfaced in the UI so the user is never surprised. */
export type AiSource = 'byo' | 'pool';

/**
 * The question material an AI request carries.
 *
 * All of it comes from the CLIENT: the server never calls qed2-core (its
 * contract forbids it), and the client already holds the whole `Question`
 * because it rendered the thing.
 */
export interface AiQuestionContext {
  questionId: string;
  partId: string;
  questionPrompt?: string;
  partPrompt?: string;
  format?: string;
  /** Non-empty means the model is working blind on a figure this question uses. */
  figureAlts?: string[];
  submitted: string;
  officialSolution?: string;
  gradingNote?: string;
  maxPoints: number;
}

/**
 * Per-user prompt preferences, sent with every request.
 *
 * Stateless on purpose: they are settings the client already owns, and two
 * strings do not justify a server table plus a migration.
 */
export interface AiPromptOptions {
  /**
   * Output language, as the user typed it — free text, not a tag. The model
   * reads it, so "Kroatisch, Fachbegriffe auf Deutsch" works and no list has
   * to be maintained.
   */
  language?: string;
  /** Free text from the settings page — the rules always take precedence. */
  customInstructions?: string;
}

/** `answer` = why mine is wrong. `walkthrough` = how the question is done. */
export type AiExplainMode = 'answer' | 'walkthrough';

export interface AiExplainRequest extends AiQuestionContext, AiPromptOptions {
  mode?: AiExplainMode;
  verdict: Verdict;
  awardedPoints: number;
}

export interface AiExplainResponse {
  markdown: string;
  mode?: AiExplainMode;
  model: string;
  promptVersion: string;
  source: AiSource;
}

export interface AiRubricCriterion {
  index: number;
  desc: string;
  points: number;
}

/**
 * Two shapes, one endpoint.
 *
 * Rubric parts send `criteria` and get a verdict each. All-or-nothing and
 * tiered parts have nothing to decompose, so they send the point values the
 * part allows and get one decision back.
 */
export interface AiAssessRequest extends AiQuestionContext, AiPromptOptions {
  criteria?: AiRubricCriterion[];
  scoreOptions?: number[];
  /** The part's rubric prose — guidance even when it is not scored criteria. */
  rubricText?: string;
}

export interface AiAssessedCriterion {
  index: number;
  met: boolean;
  /** 0..1, already clamped server-side. */
  confidence: number;
  quote: string;
  reason: string;
  /** False when the quote could not be found in the submitted answer. */
  quoteVerified: boolean;
}

export interface AiOverallAssessment {
  points: number;
  confidence: number;
  quote: string;
  reason: string;
  quoteVerified: boolean;
}

export interface AiAssessResponse {
  /** Present for rubric parts. */
  criteria?: AiAssessedCriterion[];
  /** Present for all-or-nothing / tiered parts. */
  overall?: AiOverallAssessment;
  /**
   * The server refuses to vouch for this reply — a figure it could not see, a
   * skipped criterion, or an unevidenced positive. The UI must show the
   * reasoning but tick nothing.
   */
  advisoryOnly: boolean;
  model: string;
  promptVersion: string;
  source: AiSource;
}

/** `GET /info` capability block. Absent ⇒ this server has no AI at all. */
export interface AiCapabilities {
  explain: boolean;
  assess: boolean;
  promptVersion: string;
  providers: AiProviderId[];
  poolAvailable: boolean;
}

/** `GET /me/ai/status` — what THIS user can currently do. */
export interface AiStatus {
  byo: {
    configured: boolean;
    provider?: AiProviderId;
    model?: string;
    last4?: string;
    lastUsedAt?: string;
  };
  pool: {
    eligible: boolean;
    remaining?: { tokens?: number; costCents?: number };
    periodEndsAt?: string;
  };
  active: AiSource | 'none';
  features: { explain: boolean; assess: boolean };
}
