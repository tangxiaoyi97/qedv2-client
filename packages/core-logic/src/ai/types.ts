/**
 * Wire types for the AI endpoints, shared by every shell.
 *
 * These mirror the server DTOs exactly. They live in core-logic rather than in
 * the web package because a desktop or iOS shell will speak the same protocol
 * — and because building the payload is pure logic worth testing without a
 * browser (see projection.ts).
 */
import type { CoreSourcePreference } from '../ports/index.js';
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
  /** Learner-visible options and input constraints, never the grading answer. */
  answerContext?: string;
  format?: string;
  /** Non-empty means the model is working blind on a figure this question uses. */
  figureAlts?: string[];
  /**
   * True even when a figure has no alt text. This is the safety signal used
   * to keep a vision-less model from silently pre-filling a grade.
   */
  hasFigures?: boolean;
  /** Official solution material contains a figure the text-only model cannot inspect. */
  solutionHasFigures?: boolean;
  submitted: string;
  officialSolution?: string;
  /** Structured official material for 2.3 tasks; legacy servers ignore it. */
  solution?: {
    result?: string;
    steps?: Array<{ id?: string; text: string }>;
    alternatives?: string[];
  };
  gradingNote?: string;
  maxPoints: number;
}

export type AiAttemptPhase = 'first' | 'correction';

export interface AiRequestIdentity {
  clientRequestId: string;
  interactionId: string;
  taskVersion: string;
  contentSource?: CoreSourcePreference;
  contentId?: string;
  attemptPhase?: AiAttemptPhase;
}

/** Hint/diagnosis never run without immutable content and attempt provenance. */
export type AiLearningRequestIdentity = AiRequestContext & Required<Pick<
  AiRequestContext,
  'contentSource' | 'contentId' | 'attemptPhase'
>>;

/** Renderer supplies the persisted interaction; the store derives the paid request id. */
export type AiRequestContext = Omit<AiRequestIdentity, 'clientRequestId'> & {
  clientRequestId?: string;
};

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
  /** Spend pool credit despite having an own key (BOTH entitlements only). */
  preferPool?: boolean;
}

/** Legacy modes remain readable; 2.3 uses progressive hints and diagnosis. */
export type AiExplainMode = 'answer' | 'walkthrough' | 'hint' | 'diagnosis';

export type AiLegacyExplainRequest = AiQuestionContext & AiPromptOptions & Partial<AiRequestIdentity> & ({
  mode?: 'answer';
  verdict: Verdict;
  awardedPoints: number;
} | {
  /** A solution walkthrough does not assess the student's answer. */
  mode: 'walkthrough';
  verdict?: Verdict;
  awardedPoints?: number;
});

export type AiHintRequest = AiQuestionContext & AiPromptOptions & AiLearningRequestIdentity & {
  mode: 'hint';
  hintLevel: 1 | 2 | 3;
  solutionHasFigures: boolean;
};

export type AiDiagnosisRequest = AiQuestionContext & AiPromptOptions & AiLearningRequestIdentity & {
  mode: 'diagnosis';
  solutionHasFigures: boolean;
  verdict: Verdict;
  awardedPoints: number;
};

export type AiExplainRequest = AiLegacyExplainRequest | AiHintRequest | AiDiagnosisRequest;

export type AiDiagnosisCode =
  | 'concept'
  | 'setup'
  | 'algebra'
  | 'arithmetic'
  | 'condition'
  | 'notation-unit'
  | 'incomplete'
  | 'careless'
  | 'unknown';

export interface AiHintResult {
  level: 1 | 2 | 3;
  markdown: string;
  nextAction: string;
  advisoryOnly: true;
}

export interface AiDiagnosisResult {
  errorCode: AiDiagnosisCode;
  evidence: string;
  reason: string;
  correctionPrompt: string;
  confidence: number;
  advisoryOnly: true;
  evidenceVerified: boolean;
}

interface AiResponseBase {
  model: string;
  promptVersion: string;
  source: AiSource;
}

interface AiReceiptMetadata {
  taskVersion: string;
  clientRequestId: string;
  interactionId: string;
  accounting: 'settled' | 'pending';
}

export interface AiLegacyExplainResponse extends AiResponseBase, Partial<AiReceiptMetadata> {
  markdown: string;
  mode?: 'answer' | 'walkthrough';
}

export interface AiHintResponse extends AiResponseBase, AiReceiptMetadata {
  markdown: string;
  mode: 'hint';
  hint: AiHintResult;
}

export interface AiDiagnosisResponse extends AiResponseBase, AiReceiptMetadata {
  markdown: string;
  mode: 'diagnosis';
  diagnosis: AiDiagnosisResult;
}

export type AiExplainResponse =
  | AiLegacyExplainResponse
  | AiHintResponse
  | AiDiagnosisResponse;

type CachedAiResult<T> = T extends unknown
  ? Omit<T, 'clientRequestId' | 'interactionId' | 'accounting'> & { cached: true }
  : never;

/** Receipt ids are request-local and are never replayed from content cache. */
export type AiCachedExplainResponse = CachedAiResult<AiExplainResponse>;
export type AiExplainResult = AiExplainResponse | AiCachedExplainResponse;

/**
 * Account-scoped pointer to paid content in AiCache. It carries no answer
 * text and is safe to keep in a local practice-session snapshot so an offline
 * reload can find content already paid for without making another request.
 */
export interface AiExplainCacheLocator {
  version: 1;
  cacheKey: string;
  /** Version 2 preserves mathematical source and the complete input controls. */
  projectionVersion?: 2;
  /** Public answer context used for the paid reply; absent in legacy locators. */
  answerContextDigest?: string;
  mode: 'hint' | 'diagnosis';
  hintLevel?: 1 | 2 | 3;
  partId: string;
  attemptPhase: AiAttemptPhase;
  taskVersion: string;
  promptVersion: string;
  source: AiSource;
  savedAt: string;
}

/** Opaque account-scoped pointer to an already paid self-assessment comparison. */
export interface AiAssessCacheLocator {
  version: 1;
  cacheKey: string;
  /** Digest of the complete paid provider input, excluding correlation ids. */
  requestDigest: string;
  partId: string;
  attemptPhase: AiAttemptPhase;
  contentSource: CoreSourcePreference;
  contentId: string;
  taskVersion: string;
  promptVersion: string;
  source: AiSource;
  savedAt: string;
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
export interface AiAssessRequest extends AiQuestionContext, AiPromptOptions, Partial<AiRequestIdentity> {
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
  taskVersion?: string;
  clientRequestId?: string;
  interactionId?: string;
  accounting?: 'settled' | 'pending';
  source: AiSource;
}

export type AiCachedAssessResponse = CachedAiResult<AiAssessResponse>;
export type AiAssessResult = AiAssessResponse | AiCachedAssessResponse;

export interface AiCredentialTestRequest extends AiRequestIdentity {
  /** Capability tests must never fall back to the shared pool. */
  preferPool: false;
}

export interface AiCredentialTestResponse {
  ok: true;
  provider: AiProviderId;
  model: string;
  source: 'byo';
  taskVersion: string;
  clientRequestId: string;
  interactionId: string;
  accounting: 'settled' | 'pending';
}

/** `GET /info` capability block. Absent ⇒ this server has no AI at all. */
export interface AiCapabilities {
  explain: boolean;
  assess: boolean;
  walkthrough?: boolean;
  hint?: boolean;
  diagnosis?: boolean;
  credentialTest?: boolean;
  promptVersion: string;
  providers: AiProviderId[];
  poolAvailable: boolean;
  taskVersions?: Partial<Record<AiExplainMode | 'assess' | 'capabilityTest', string>>;
  idempotencyWindowDays?: number;
}

/** `GET /me/ai/status` — what THIS user can currently do. */
export interface AiStatus {
  byo: {
    configured: boolean;
    provider?: AiProviderId;
    model?: string;
    last4?: string;
    lastUsedAt?: string;
    /** Opaque, non-secret credential revision used to invalidate paid test receipts. */
    credentialRevision?: string;
  };
  pool: {
    eligible: boolean;
    /** Resolved pool route; lets local caches stay isolated across model changes. */
    provider?: AiProviderId;
    model?: string;
    remaining?: { tokens?: number; costCents?: number };
    periodEndsAt?: string;
  };
  active: AiSource | 'none';
  features: { explain: boolean; assess: boolean; hint?: boolean; diagnosis?: boolean };
  /** Sources this entitlement permits the user to select. Absent on early RC servers. */
  allowedSources?: AiSource[];
}
