import { describe, expect, it } from 'vitest';
import {
  AiProtocolError,
  cacheableAiExplainResponse,
  parseAiAssessResponse,
  parseAiCredentialTestResponse,
  parseAiExplainResponse,
  parseCachedAiExplainResponse,
  type AiAssessRequest,
  type AiHintRequest,
} from '../src/index.js';

const identity = {
  clientRequestId: '3b241101-e2bb-4255-8caf-4136c566a962',
  interactionId: '4c352212-f3cc-4366-9db0-5247d677b073',
  taskVersion: 'hint.v1',
  contentSource: 'remote' as const,
  contentId: 'a'.repeat(40),
  attemptPhase: 'first' as const,
};

const hintRequest: AiHintRequest = {
  questionId: 'q1',
  partId: 'q1-a',
  submitted: '',
  maxPoints: 1,
  solutionHasFigures: false,
  preferPool: false,
  mode: 'hint',
  hintLevel: 1,
  ...identity,
};

function hintResponse(overrides: Record<string, unknown> = {}) {
  return {
    markdown: 'Beginne mit dem Ansatz.',
    mode: 'hint',
    hint: {
      level: 1,
      markdown: 'Beginne mit dem Ansatz.',
      nextAction: 'Schreibe die erste Gleichung.',
      advisoryOnly: true,
    },
    model: 'gpt-test',
    promptVersion: 'ai-v2',
    source: 'byo',
    taskVersion: identity.taskVersion,
    clientRequestId: identity.clientRequestId,
    interactionId: identity.interactionId,
    accounting: 'settled',
    ...overrides,
  };
}

describe('AI response protocol validation', () => {
  it('accepts a complete hint echo and strips receipt ids from cache', () => {
    const parsed = parseAiExplainResponse(hintResponse(), hintRequest);
    expect(parsed).toMatchObject({ mode: 'hint', source: 'byo' });
    const cached = cacheableAiExplainResponse(parsed);
    expect(cached).not.toHaveProperty('clientRequestId');
    expect(cached).not.toHaveProperty('interactionId');
    expect(cached).not.toHaveProperty('accounting');
    expect(parseCachedAiExplainResponse(cached, hintRequest)).toEqual(cached);
  });

  it.each([
    ['wrong payer', { source: 'pool' }],
    ['wrong task', { taskVersion: 'hint.v0' }],
    ['wrong request id', { clientRequestId: '5d463323-a4dd-4477-8ec1-6358e788c184' }],
    ['missing accounting', { accounting: undefined }],
    ['wrong mode', { mode: 'diagnosis' }],
  ])('fails closed on %s', (_label, override) => {
    expect(() => parseAiExplainResponse(hintResponse(override), hintRequest)).toThrow(AiProtocolError);
  });

  it('rejects a hint level or markdown that does not echo its structured body', () => {
    expect(() => parseAiExplainResponse(hintResponse({
      hint: { level: 2, markdown: 'Andere Stufe', nextAction: 'Weiter', advisoryOnly: true },
    }), hintRequest)).toThrow(AiProtocolError);
    expect(() => parseAiExplainResponse(hintResponse({ markdown: 'Abweichend' }), hintRequest)).toThrow(
      AiProtocolError,
    );
  });

  it('validates assessment receipt, payer and evidence shape', () => {
    const request: AiAssessRequest = {
      questionId: 'q1',
      partId: 'q1-a',
      submitted: 'x=4',
      maxPoints: 1,
      scoreOptions: [0, 1],
      preferPool: true,
      clientRequestId: identity.clientRequestId,
      interactionId: identity.interactionId,
      taskVersion: 'assess.v1',
    };
    const response = {
      overall: {
        points: 1,
        confidence: 0.8,
        quote: 'x=4',
        reason: 'Das Ergebnis stimmt.',
        quoteVerified: true,
      },
      advisoryOnly: false,
      model: 'gpt-pool',
      promptVersion: 'ai-v2',
      source: 'pool',
      clientRequestId: identity.clientRequestId,
      interactionId: identity.interactionId,
      taskVersion: 'assess.v1',
      accounting: 'settled',
    };
    expect(parseAiAssessResponse(response, request).overall?.points).toBe(1);
    expect(() => parseAiAssessResponse({ ...response, source: 'byo' }, request)).toThrow(AiProtocolError);
    expect(() => parseAiAssessResponse({ ...response, overall: { ...response.overall, confidence: 2 } }, request))
      .toThrow(AiProtocolError);
  });

  it('accepts the exact credential-test wire without inventing promptVersion', () => {
    const request = {
      clientRequestId: identity.clientRequestId,
      interactionId: identity.interactionId,
      taskVersion: 'capability-test.v1',
      preferPool: false as const,
    };
    expect(parseAiCredentialTestResponse({
      ok: true,
      provider: 'openai',
      model: 'gpt-test',
      source: 'byo',
      taskVersion: request.taskVersion,
      clientRequestId: request.clientRequestId,
      interactionId: request.interactionId,
      accounting: 'settled',
    }, request)).toMatchObject({ ok: true, provider: 'openai' });
  });
});
