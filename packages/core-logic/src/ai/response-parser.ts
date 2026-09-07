import type {
  AiAssessRequest,
  AiAssessResponse,
  AiCachedAssessResponse,
  AiCachedExplainResponse,
  AiCredentialTestRequest,
  AiCredentialTestResponse,
  AiDiagnosisCode,
  AiDiagnosisResponse,
  AiExplainRequest,
  AiExplainResponse,
  AiHintResponse,
  AiLegacyExplainResponse,
  AiSource,
} from './types.js';

type JsonObject = Record<string, unknown>;

const DIAGNOSIS_CODES = new Set<AiDiagnosisCode>([
  'concept',
  'setup',
  'algebra',
  'arithmetic',
  'condition',
  'notation-unit',
  'incomplete',
  'careless',
  'unknown',
]);

export class AiProtocolError extends Error {
  override readonly name = 'AiProtocolError';
  readonly code = 'AI_INVALID_RESPONSE';

  constructor(message: string) {
    super(message);
  }
}

function invalid(detail: string): never {
  throw new AiProtocolError(`Ungültige KI-Antwort: ${detail}`);
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(name);
  return value as JsonObject;
}

function string(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) invalid(name);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') invalid(name);
  return value;
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(name);
  return value;
}

function confidence(value: unknown, name: string): number {
  const parsed = number(value, name);
  if (parsed < 0 || parsed > 1) invalid(name);
  return parsed;
}

function source(value: unknown, expected: AiSource | undefined): AiSource {
  if (value !== 'byo' && value !== 'pool') invalid('source');
  if (expected && value !== expected) invalid('source does not match the selected payer');
  return value;
}

function expectedSource(preferPool: boolean | undefined): AiSource | undefined {
  return preferPool === undefined ? undefined : preferPool ? 'pool' : 'byo';
}

function accounting(value: unknown): 'settled' | 'pending' {
  if (value !== 'settled' && value !== 'pending') invalid('accounting');
  return value;
}

function common(
  value: JsonObject,
  expected: AiSource | undefined,
  expectedPromptVersion?: string,
) {
  const promptVersion = string(value.promptVersion, 'promptVersion');
  if (expectedPromptVersion !== undefined && promptVersion !== expectedPromptVersion) {
    invalid('promptVersion does not match the advertised capability');
  }
  return {
    model: string(value.model, 'model'),
    promptVersion,
    source: source(value.source, expected),
  };
}

function strictReceipt(value: JsonObject, request: {
  taskVersion: string;
  clientRequestId: string;
  interactionId: string;
}) {
  const taskVersion = string(value.taskVersion, 'taskVersion');
  const clientRequestId = string(value.clientRequestId, 'clientRequestId');
  const interactionId = string(value.interactionId, 'interactionId');
  if (taskVersion !== request.taskVersion) invalid('taskVersion echo');
  if (clientRequestId !== request.clientRequestId) invalid('clientRequestId echo');
  if (interactionId !== request.interactionId) invalid('interactionId echo');
  return {
    taskVersion,
    clientRequestId,
    interactionId,
    accounting: accounting(value.accounting),
  };
}

function optionalReceipt(value: JsonObject, request: AiAssessRequest | AiExplainRequest) {
  if (!request.taskVersion && !request.clientRequestId && !request.interactionId) return {};
  if (!request.taskVersion || !request.clientRequestId || !request.interactionId) {
    invalid('incomplete request receipt metadata');
  }
  return strictReceipt(value, {
    taskVersion: request.taskVersion,
    clientRequestId: request.clientRequestId,
    interactionId: request.interactionId,
  });
}

function parseHint(
  value: JsonObject,
  request: Extract<AiExplainRequest, { mode: 'hint' }>,
  expectedPromptVersion?: string,
): AiHintResponse {
  if (!request.clientRequestId) invalid('request clientRequestId');
  if (value.mode !== 'hint') invalid('mode');
  const hint = object(value.hint, 'hint');
  if (hint.level !== request.hintLevel) invalid('hint.level');
  if (hint.advisoryOnly !== true) invalid('hint.advisoryOnly');
  const markdown = string(hint.markdown, 'hint.markdown');
  if (string(value.markdown, 'markdown') !== markdown) invalid('markdown echo');
  return {
    ...common(value, expectedSource(request.preferPool), expectedPromptVersion),
    ...strictReceipt(value, {
      taskVersion: request.taskVersion,
      clientRequestId: request.clientRequestId,
      interactionId: request.interactionId,
    }),
    markdown,
    mode: 'hint',
    hint: {
      level: request.hintLevel,
      markdown,
      nextAction: string(hint.nextAction, 'hint.nextAction'),
      advisoryOnly: true,
    },
  };
}

function parseDiagnosis(
  value: JsonObject,
  request: Extract<AiExplainRequest, { mode: 'diagnosis' }>,
  expectedPromptVersion?: string,
): AiDiagnosisResponse {
  if (!request.clientRequestId) invalid('request clientRequestId');
  if (value.mode !== 'diagnosis') invalid('mode');
  const diagnosis = object(value.diagnosis, 'diagnosis');
  if (typeof diagnosis.errorCode !== 'string' || !DIAGNOSIS_CODES.has(diagnosis.errorCode as AiDiagnosisCode)) {
    invalid('diagnosis.errorCode');
  }
  if (diagnosis.advisoryOnly !== true) invalid('diagnosis.advisoryOnly');
  const reason = string(diagnosis.reason, 'diagnosis.reason');
  if (string(value.markdown, 'markdown') !== reason) invalid('markdown echo');
  return {
    ...common(value, expectedSource(request.preferPool), expectedPromptVersion),
    ...strictReceipt(value, {
      taskVersion: request.taskVersion,
      clientRequestId: request.clientRequestId,
      interactionId: request.interactionId,
    }),
    markdown: reason,
    mode: 'diagnosis',
    diagnosis: {
      errorCode: diagnosis.errorCode as AiDiagnosisCode,
      evidence: string(diagnosis.evidence, 'diagnosis.evidence', true),
      reason,
      correctionPrompt: string(diagnosis.correctionPrompt, 'diagnosis.correctionPrompt'),
      confidence: confidence(diagnosis.confidence, 'diagnosis.confidence'),
      advisoryOnly: true,
      evidenceVerified: boolean(diagnosis.evidenceVerified, 'diagnosis.evidenceVerified'),
    },
  };
}

export function parseAiExplainResponse(
  value: unknown,
  request: AiExplainRequest,
  expectedPromptVersion?: string,
): AiExplainResponse {
  const row = object(value, 'response');
  if (request.mode === 'hint') return parseHint(row, request, expectedPromptVersion);
  if (request.mode === 'diagnosis') return parseDiagnosis(row, request, expectedPromptVersion);
  const expectedMode = request.mode ?? 'answer';
  if (row.mode !== undefined && row.mode !== expectedMode) invalid('mode');
  const receipt = optionalReceipt(row, request);
  const parsed: AiLegacyExplainResponse = {
    ...common(row, expectedSource(request.preferPool), expectedPromptVersion),
    ...receipt,
    markdown: string(row.markdown, 'markdown'),
    ...(row.mode === 'answer' || row.mode === 'walkthrough' ? { mode: row.mode } : {}),
  };
  return parsed;
}

function parseCriterion(value: unknown) {
  const row = object(value, 'criteria[]');
  const index = number(row.index, 'criteria[].index');
  if (!Number.isInteger(index) || index < 0) invalid('criteria[].index');
  return {
    index,
    met: boolean(row.met, 'criteria[].met'),
    confidence: confidence(row.confidence, 'criteria[].confidence'),
    quote: string(row.quote, 'criteria[].quote', true),
    reason: string(row.reason, 'criteria[].reason'),
    quoteVerified: boolean(row.quoteVerified, 'criteria[].quoteVerified'),
  };
}

function parseOverall(value: unknown) {
  const row = object(value, 'overall');
  return {
    points: number(row.points, 'overall.points'),
    confidence: confidence(row.confidence, 'overall.confidence'),
    quote: string(row.quote, 'overall.quote', true),
    reason: string(row.reason, 'overall.reason'),
    quoteVerified: boolean(row.quoteVerified, 'overall.quoteVerified'),
  };
}

function parseAssessmentContent(value: JsonObject, request: AiAssessRequest) {
  const criteria = value.criteria === undefined
    ? undefined
    : Array.isArray(value.criteria)
      ? value.criteria.map(parseCriterion)
      : invalid('criteria');
  if (criteria) {
    const ids = new Set(criteria.map((criterion) => criterion.index));
    if (ids.size !== criteria.length) invalid('duplicate criterion index');
  }
  const overall = value.overall === undefined ? undefined : parseOverall(value.overall);
  const expectsCriteria = Array.isArray(request.criteria) && request.criteria.length > 0;
  const expectsOverall = Array.isArray(request.scoreOptions) && request.scoreOptions.length > 0;
  if (expectsCriteria === expectsOverall) invalid('assessment request shape');
  if (expectsCriteria) {
    if (!criteria || criteria.length !== request.criteria!.length || overall) {
      invalid('criteria response shape');
    }
    const expectedIndices = new Set(request.criteria!.map((_, index) => index));
    if (criteria.some((criterion) => !expectedIndices.has(criterion.index))) {
      invalid('criteria[].index outside request');
    }
  } else {
    if (criteria?.length || !overall) invalid('overall response shape');
    if (!request.scoreOptions!.some((points) => Object.is(points, overall.points))) {
      invalid('overall.points outside scoreOptions');
    }
  }
  const advisoryOnly = boolean(value.advisoryOnly, 'advisoryOnly');
  const hasUnverifiedPositive = criteria?.some((criterion) => criterion.met && !criterion.quoteVerified)
    || Boolean(overall && overall.points > 0 && !overall.quoteVerified);
  if (hasUnverifiedPositive && !advisoryOnly) invalid('unverified positive evidence');
  return {
    ...(criteria && criteria.length > 0 ? { criteria } : {}),
    ...(overall ? { overall } : {}),
    advisoryOnly,
  };
}

export function parseAiAssessResponse(
  value: unknown,
  request: AiAssessRequest,
  expectedPromptVersion?: string,
): AiAssessResponse {
  const row = object(value, 'response');
  return {
    ...parseAssessmentContent(row, request),
    ...common(row, expectedSource(request.preferPool), expectedPromptVersion),
    ...optionalReceipt(row, request),
  };
}

export function parseAiCredentialTestResponse(
  value: unknown,
  request: AiCredentialTestRequest,
): AiCredentialTestResponse {
  const row = object(value, 'response');
  if (row.ok !== true) invalid('ok');
  if (row.provider !== 'openai' && row.provider !== 'gemini') invalid('provider');
  const model = string(row.model, 'model');
  source(row.source, 'byo');
  return {
    ok: true,
    provider: row.provider,
    model,
    source: 'byo',
    ...strictReceipt(row, request),
  };
}

/** Cached envelopes contain reusable content, never an old request receipt. */
export function parseCachedAiExplainResponse(
  value: unknown,
  request: AiExplainRequest,
  expectedPromptVersion?: string,
): AiCachedExplainResponse {
  const row = object(value, 'cached response');
  if (row.cached !== true) invalid('cached marker');
  if ('clientRequestId' in row || 'interactionId' in row || 'accounting' in row) {
    invalid('cached receipt metadata');
  }
  const sourceValue = source(row.source, expectedSource(request.preferPool));
  const promptVersion = string(row.promptVersion, 'promptVersion');
  if (expectedPromptVersion !== undefined && promptVersion !== expectedPromptVersion) {
    invalid('cached promptVersion');
  }
  const base = {
    model: string(row.model, 'model'),
    promptVersion,
    source: sourceValue,
    cached: true as const,
  };
  if (request.mode === 'hint') {
    if (row.mode !== 'hint' || row.taskVersion !== request.taskVersion) invalid('cached hint metadata');
    const hint = object(row.hint, 'hint');
    if (hint.level !== request.hintLevel || hint.advisoryOnly !== true) invalid('cached hint');
    const markdown = string(hint.markdown, 'hint.markdown');
    if (row.markdown !== markdown) invalid('cached hint markdown');
    return {
      ...base,
      taskVersion: request.taskVersion,
      mode: 'hint',
      markdown,
      hint: {
        level: request.hintLevel,
        markdown,
        nextAction: string(hint.nextAction, 'hint.nextAction'),
        advisoryOnly: true,
      },
    };
  }
  if (request.mode === 'diagnosis') {
    if (row.mode !== 'diagnosis' || row.taskVersion !== request.taskVersion) invalid('cached diagnosis metadata');
    const diagnosis = object(row.diagnosis, 'diagnosis');
    if (typeof diagnosis.errorCode !== 'string' || !DIAGNOSIS_CODES.has(diagnosis.errorCode as AiDiagnosisCode)) {
      invalid('diagnosis.errorCode');
    }
    if (diagnosis.advisoryOnly !== true) invalid('diagnosis.advisoryOnly');
    const reason = string(diagnosis.reason, 'diagnosis.reason');
    if (row.markdown !== reason) invalid('cached diagnosis markdown');
    return {
      ...base,
      taskVersion: request.taskVersion,
      mode: 'diagnosis',
      markdown: reason,
      diagnosis: {
        errorCode: diagnosis.errorCode as AiDiagnosisCode,
        evidence: string(diagnosis.evidence, 'diagnosis.evidence', true),
        reason,
        correctionPrompt: string(diagnosis.correctionPrompt, 'diagnosis.correctionPrompt'),
        confidence: confidence(diagnosis.confidence, 'diagnosis.confidence'),
        advisoryOnly: true,
        evidenceVerified: boolean(diagnosis.evidenceVerified, 'diagnosis.evidenceVerified'),
      },
    };
  }
  const expectedMode = request.mode ?? 'answer';
  if (row.mode !== undefined && row.mode !== expectedMode) invalid('cached mode');
  if (request.taskVersion && row.taskVersion !== request.taskVersion) invalid('cached taskVersion');
  return {
    ...base,
    markdown: string(row.markdown, 'markdown'),
    ...(row.taskVersion === undefined ? {} : { taskVersion: string(row.taskVersion, 'taskVersion') }),
    ...(row.mode === 'answer' || row.mode === 'walkthrough' ? { mode: row.mode } : {}),
  };
}

export function parseCachedAiAssessResponse(
  value: unknown,
  request: AiAssessRequest,
  expectedPromptVersion?: string,
): AiCachedAssessResponse {
  const row = object(value, 'cached response');
  if (row.cached !== true) invalid('cached marker');
  if ('clientRequestId' in row || 'interactionId' in row || 'accounting' in row) {
    invalid('cached receipt metadata');
  }
  if (request.taskVersion && row.taskVersion !== request.taskVersion) invalid('cached taskVersion');
  return {
    ...parseAssessmentContent(row, request),
    ...common(row, expectedSource(request.preferPool), expectedPromptVersion),
    ...(row.taskVersion === undefined ? {} : { taskVersion: string(row.taskVersion, 'taskVersion') }),
    cached: true,
  };
}

export function cacheableAiExplainResponse(response: AiExplainResponse): AiCachedExplainResponse {
  const { clientRequestId: _request, interactionId: _interaction, accounting: _accounting, ...content } = response;
  return { ...content, cached: true } as AiCachedExplainResponse;
}

export function cacheableAiAssessResponse(response: AiAssessResponse): AiCachedAssessResponse {
  const { clientRequestId: _request, interactionId: _interaction, accounting: _accounting, ...content } = response;
  return { ...content, cached: true } as AiCachedAssessResponse;
}
