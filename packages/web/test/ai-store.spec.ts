import 'fake-indexeddb/auto';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountStorageIdentity,
  AI_CACHE_META_KEY,
  deterministicAiRequestId,
  STORAGE,
  type AiCapabilities,
  type AiExplainResponse,
  type AiStatus,
  type GradeResult,
  type Question,
  type QuestionPart,
  type StorageChange,
  type StoragePort,
} from '@qed2/core-logic';
import {
  aiCache,
  aiCredentialTestJournal,
  aiRequestGenerationJournal,
  localProfileStore,
  storage,
} from '../src/services.js';
import { useAiStore } from '../src/stores/ai.js';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const capabilities: AiCapabilities = {
  explain: true,
  assess: true,
  hint: true,
  diagnosis: true,
  credentialTest: true,
  promptVersion: 'ai-v2',
  providers: ['openai'],
  poolAvailable: true,
  taskVersions: {
    answer: 'answer.v1',
    walkthrough: 'walkthrough.v1',
    hint: 'hint.v1',
    diagnosis: 'diagnosis.v1',
    assess: 'assess.v1',
    capabilityTest: 'capability-test.v1',
  },
  idempotencyWindowDays: 400,
};

function status(overrides: Partial<AiStatus> = {}): AiStatus {
  return {
    byo: {
      configured: true,
      provider: 'openai',
      model: 'gpt-test',
      last4: '1234',
      credentialRevision: '2026-08-24T00:00:00.000Z',
    },
    pool: {
      eligible: true,
      provider: 'openai',
      model: 'gpt-pool',
      remaining: { tokens: 1000 },
    },
    active: 'byo',
    features: { explain: true, assess: true, hint: true, diagnosis: true },
    allowedSources: ['byo', 'pool'],
    ...overrides,
  };
}

const part: QuestionPart = {
  id: 'q1-a',
  label: 'a',
  competencies: [],
  answer: { kind: 'open', rubric: [{ t: 'text', v: 'Begründung' }], grader: 'ai' },
  scoring: { mode: 'allOrNothing', points: 1 },
  points: 1,
};

const question: Question = {
  id: 'q1',
  schemaVersion: 3,
  status: 'reviewed',
  lang: 'de',
  source: {
    suite: 'srdp',
    year: 2026,
    term: 'haupttermin',
    part: 't1',
    nr: 1,
    file: 'q1.yaml',
  },
  title: 'Testfrage',
  parts: [part],
};

const result: GradeResult = {
  verdict: 'incorrect',
  correct: false,
  awardedPoints: 0,
  maxPoints: 1,
};

const explainInput = {
  question,
  part,
  submitted: 'mein geheimer Rechenweg',
  result,
};

const learningIdentity = {
  interactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
  taskVersion: 'hint.v1',
  contentSource: 'remote' as const,
  contentId: 'a'.repeat(40),
  attemptPhase: 'first' as const,
};

const paidHintInput = {
  question,
  part,
  submitted: '',
  mode: 'hint' as const,
  hintLevel: 1 as const,
  identity: learningIdentity,
};

const paidAssessInput = {
  question,
  part,
  submitted: explainInput.submitted,
  maxPoints: 1,
  scoreOptions: [0, 1],
  identity: { ...learningIdentity, taskVersion: 'assess.v1' },
};

function installLearningResponses(): { hintCalls: () => number; assessCalls: () => number } {
  let hintCalls = 0;
  let assessCalls = 0;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/me/ai/status')) return json(status());
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/me/ai-explain')) {
      hintCalls += 1;
      const marker = hintCalls === 1 ? 'Erster Hinweis.' : 'Neuer Hinweis.';
      return json({
        markdown: marker,
        mode: 'hint',
        hint: {
          level: 1,
          markdown: marker,
          nextAction: 'Ordne die bekannten Größen.',
          advisoryOnly: true,
        },
        model: 'gpt-test',
        promptVersion: 'ai-v2',
        taskVersion: body.taskVersion,
        clientRequestId: body.clientRequestId,
        interactionId: body.interactionId,
        accounting: 'settled',
        source: 'byo',
      });
    }
    if (url.endsWith('/me/ai-grade')) {
      assessCalls += 1;
      return json({
        overall: {
          points: 1,
          confidence: 0.8,
          quote: paidAssessInput.submitted,
          reason: assessCalls === 1 ? 'Erste Bewertung.' : 'Neue Bewertung.',
          quoteVerified: true,
        },
        advisoryOnly: false,
        model: 'gpt-test',
        promptVersion: 'ai-v2',
        taskVersion: body.taskVersion,
        clientRequestId: body.clientRequestId,
        interactionId: body.interactionId,
        accounting: 'settled',
        source: 'byo',
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
  return { hintCalls: () => hintCalls, assessCalls: () => assessCalls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function switchAccount(
  auth: ReturnType<typeof useAuthStore>,
  userId: string,
): Promise<void> {
  await localProfileStore.activateUser(accountStorageIdentity('https://server-a.test', userId));
  auth.session = {
    token: `token-${userId}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    user: { id: userId, username: userId },
    serverBaseUrl: 'https://server-a.test',
  };
  await settle();
}

function setup(statusResponse: AiStatus = status()): {
  ai: ReturnType<typeof useAiStore>;
  app: ReturnType<typeof useAppStore>;
  auth: ReturnType<typeof useAuthStore>;
} {
  setActivePinia(createPinia());
  const app = useAppStore();
  app.config = { ...app.config, serverBaseUrl: 'https://server-a.test' };
  app.serverInfo = {
    service: 'qed2-server',
    version: '2.0.0',
    commit: 'server-commit-a',
    sourceRepo: 'repo',
    buildTime: '2026-08-06T00:00:00.000Z',
    auth: 'jwt',
    ai: capabilities,
  };
  const auth = useAuthStore();
  auth.session = {
    token: 'token-u1',
    expiresAt: '2099-01-01T00:00:00.000Z',
    user: { id: 'u1', username: 'user-1' },
    serverBaseUrl: 'https://server-a.test',
  };
  app.setTokenProvider(() => auth.session?.token);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/me/ai/status')) return json(statusResponse);
    if (url.endsWith('/me/ai-explain')) {
      const request = JSON.parse(String(init?.body)) as { preferPool?: boolean };
      const source = request.preferPool === true ? 'pool' : 'byo';
      return json({
        markdown: 'Erklärung',
        model: source === 'pool' ? 'gpt-pool' : 'gpt-test',
        promptVersion: 'ai-v2',
        source,
      } satisfies AiExplainResponse);
    }
    throw new Error(`unexpected request ${url}`);
  }));
  return { ai: useAiStore(), app, auth };
}

function captureRemoteCacheChanges(): { emit(change: StorageChange): void } {
  const observable = storage as StoragePort & {
    onChange(callback: (change: StorageChange) => void): () => void;
  };
  const original = observable.onChange.bind(observable);
  let listener: ((change: StorageChange) => void) | undefined;
  vi.spyOn(observable, 'onChange').mockImplementation((callback: (change: StorageChange) => void) => {
    listener = callback;
    return original(callback);
  });
  return {
    emit(change) {
      if (!listener) throw new Error('AI store did not subscribe to storage changes');
      listener(change);
    },
  };
}

async function activeAiCacheScope(): Promise<string> {
  const keys = await storage.keys(STORAGE.aiCache);
  const metaKeys = keys.filter((key) => key.startsWith(AI_CACHE_META_KEY));
  expect(metaKeys).toHaveLength(1);
  return metaKeys[0]!.slice(AI_CACHE_META_KEY.length);
}

describe('AI store release guards', () => {
  beforeEach(async () => {
    await storage.clear(STORAGE.aiCache);
    await storage.clear(STORAGE.config);
    await localProfileStore.initialize(accountStorageIdentity('https://server-a.test', 'u1'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    { name: 'authorized pool without a personal key', policy: ['pool'], eligible: true, ownKey: false, active: 'pool', ready: true, setup: false },
    { name: 'new BYO-only account', policy: ['byo'], eligible: false, ownKey: false, active: 'none', ready: false, setup: true },
    { name: 'BYO-only account with a key', policy: ['byo'], eligible: false, ownKey: true, active: 'byo', ready: true, setup: false },
    { name: 'exhausted POOL-only account', policy: ['pool'], eligible: false, ownKey: true, active: 'none', ready: false, setup: false },
    { name: 'BOTH account uses authorized pool before key setup', policy: ['byo', 'pool'], eligible: true, ownKey: false, active: 'pool', ready: true, setup: false },
  ] as const)('separates readiness from setup: $name', async (entry) => {
    const { ai } = setup(status({
      allowedSources: [...entry.policy],
      active: entry.active,
      byo: { configured: entry.ownKey },
      pool: { eligible: entry.eligible, provider: 'openai', model: 'gpt-pool' },
    }));
    await vi.waitFor(() => expect(ai.profilePreferencesReady && ai.status !== null).toBe(true));
    expect(ai.hintOffered).toBe(true);
    expect(ai.diagnosisOffered).toBe(true);
    expect(ai.walkthroughOffered).toBe(true);
    expect(ai.assessmentOffered(part, question)).toBe(true);
    expect(ai.canHint).toBe(entry.ready);
    expect(ai.canDiagnose).toBe(entry.ready);
    expect(ai.canWalkthrough).toBe(entry.ready);
    expect(ai.canAssess(part, question)).toBe(entry.ready);
    expect(ai.needsSourceSetup).toBe(entry.setup);
    if (entry.ready && !entry.ownKey) {
      await ai.explain(explainInput);
      const paid = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/me/ai-explain'));
      expect(JSON.parse(String(paid?.[1]?.body)).preferPool).toBe(true);
    }
  });

  it('requests and replays a solution walkthrough before the learner chooses a score', async () => {
    const { ai, app } = setup();
    await vi.waitFor(() => expect(ai.canWalkthrough).toBe(true));
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/me/ai/status')) return json(status());
      const request = JSON.parse(String(init?.body));
      return json({
        markdown: 'Erklärung', mode: 'walkthrough', model: 'gpt-test', source: 'byo',
        promptVersion: 'ai-v2', taskVersion: request.taskVersion,
        clientRequestId: request.clientRequestId, interactionId: request.interactionId,
        accounting: 'settled',
      });
    });
    const input = {
      question, part, submitted: explainInput.submitted, mode: 'walkthrough' as const,
      identity: { ...learningIdentity, taskVersion: 'walkthrough.v1' },
    };
    const first = await ai.explain(input);
    expect(first.markdown).toBe('Erklärung');
    await expect(ai.explain(input)).resolves.toMatchObject({
      markdown: first.markdown, mode: 'walkthrough', taskVersion: 'walkthrough.v1', cached: true,
    });
    const requests = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'));
    expect(requests).toHaveLength(1);
    const body = JSON.parse(String(requests[0]?.[1]?.body));
    expect(body).toMatchObject({
      mode: 'walkthrough', taskVersion: 'walkthrough.v1', submitted: explainInput.submitted,
      interactionId: learningIdentity.interactionId,
    });
    expect(body).not.toHaveProperty('verdict');
    expect(body).not.toHaveProperty('awardedPoints');
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);

    const { walkthrough: _walkthrough, ...taskVersions } = capabilities.taskVersions!;
    app.serverInfo = { ...app.serverInfo!, ai: { ...capabilities, taskVersions } };
    expect(ai.canWalkthrough).toBe(false);
    expect(ai.walkthroughOffered).toBe(false);
    expect(ai.canExplain).toBe(true);
    await expect(ai.explain(input)).rejects.toThrow('nicht verfügbar');
  });

  it('permits an explicitly selected usable BYO route even when the default active route is none', async () => {
    const { ai } = setup(status({ active: 'none', pool: { eligible: false } }));
    await vi.waitFor(() => expect(ai.profilePreferencesReady && ai.status !== null).toBe(true));
    await ai.setMode('pool');
    expect(ai.canExplain).toBe(false);
    expect(ai.needsSourceSetup).toBe(true);
    expect(ai.needsCredentialSetup).toBe(false);
    await ai.setMode('byo');
    expect(ai.status?.active).toBe('none');
    expect(ai.canExplain).toBe(true);
    expect(ai.canAssess(part, question)).toBe(true);
    await ai.explain(explainInput);
    const paid = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/me/ai-explain'));
    expect(JSON.parse(String(paid?.[1]?.body)).preferPool).toBe(false);
  });

  it('hides every AI capability for guests and globally disabled servers, even with cached ready status', async () => {
    const { ai, app, auth } = setup();
    await vi.waitFor(() => expect(ai.canHint).toBe(true));
    const enabled = app.serverInfo!;
    app.serverInfo = { ...enabled, ai: undefined };
    ai.status = status();
    expect(ai.available).toBe(false);
    expect(ai.canHint).toBe(false);
    expect(ai.canDiagnose).toBe(false);
    expect(ai.canExplain).toBe(false);
    expect(ai.canAssess(part, question)).toBe(false);
    expect(ai.needsSourceSetup).toBe(false);
    expect(ai.byoOffered).toBe(false);
    await expect(ai.explain(explainInput)).rejects.toThrow('nicht verfügbar');
    await expect(ai.assess(paidAssessInput)).rejects.toThrow('nicht verfügbar');
    app.serverInfo = enabled;
    auth.session = undefined;
    ai.status = status();
    expect(ai.available).toBe(false);
    expect(ai.poolOffered).toBe(false);
    expect(ai.needsSourceSetup).toBe(false);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => /ai-explain|ai-grade/u.test(String(url)))).toHaveLength(0);
  });

  it('does not expose hint or diagnosis setup when only assessment is enabled', async () => {
    const { ai, app } = setup(status({ active: 'none', byo: { configured: false }, allowedSources: ['byo'] }));
    await vi.waitFor(() => expect(ai.needsSourceSetup).toBe(true));
    app.serverInfo = { ...app.serverInfo!, ai: { ...capabilities, explain: false, hint: false, diagnosis: false } };
    await vi.waitFor(() => expect(ai.status !== null).toBe(true));
    expect(ai.hintOffered).toBe(false);
    expect(ai.diagnosisOffered).toBe(false);
    expect(ai.assessmentOffered(part, question)).toBe(true);
  });

  it('lets a fresh all-disabled user status veto stale enabled public capabilities', async () => {
    const { ai, app } = setup();
    await vi.waitFor(() => expect(ai.canHint).toBe(true));
    const info = app.serverInfo;
    const disabled = status({ features: { explain: false, assess: false, hint: false, diagnosis: false } });
    vi.mocked(fetch).mockResolvedValueOnce(json(disabled));
    await ai.refreshStatus();
    expect(app.serverInfo).toBe(info);
    expect(ai.status).toEqual(disabled);
    expect(ai.available).toBe(false);
    expect(ai.canExplain).toBe(false);
    expect(ai.canHint).toBe(false);
    expect(ai.canDiagnose).toBe(false);
    expect(ai.canAssess(part, question)).toBe(false);
    expect(ai.needsSourceSetup).toBe(false);
    expect(ai.poolOffered).toBe(false);
    expect(ai.byoOffered).toBe(false);
    await expect(ai.explain(explainInput)).rejects.toThrow('nicht verfügbar');
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => /ai-explain|ai-grade/u.test(String(url)))).toHaveLength(0);
  });

  it('rechecks a feature disabled during durable request preparation before sending content', async () => {
    const { ai, app } = setup();
    await vi.waitFor(() => expect(ai.canHint).toBe(true));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(aiRequestGenerationJournal, 'current').mockImplementationOnce(async () => {
      await gate;
      return { version: 2, generation: 0, clientRequestId: '11111111-1111-4111-8111-111111111111' };
    });
    const pending = ai.explain(paidHintInput);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    app.serverInfo = { ...app.serverInfo!, ai: undefined };
    release();
    await expect(pending).rejects.toThrow();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'))).toHaveLength(0);
  });

  it('honours feature flags and forbids a stored BYO key under a POOL-only entitlement', async () => {
    const poolOnly = status({
      pool: {
        eligible: true,
        provider: 'openai',
        model: 'gpt-pool',
        remaining: { tokens: 1000 },
      },
      active: 'pool',
      allowedSources: ['pool'],
    });
    const { ai, app } = setup(poolOnly);
    await vi.waitFor(() => expect(ai.status).toEqual(poolOnly));
    await vi.waitFor(() => expect(ai.profilePreferencesReady).toBe(true));

    expect(ai.status?.byo.configured).toBe(true);
    expect(ai.mode).toBe('pool');
    expect(ai.byoOffered).toBe(false);
    expect(ai.canExplain).toBe(true);
    expect(ai.canAssess(part)).toBe(true);
    await ai.explain(explainInput);
    const poolRequest = vi.mocked(fetch).mock.calls.find(([url]) =>
      String(url).endsWith('/me/ai-explain'))?.[1];
    expect(JSON.parse(String(poolRequest?.body)).preferPool).toBe(true);

    ai.status = { ...poolOnly, features: { explain: false, assess: false } };
    expect(ai.canExplain).toBe(false);
    expect(ai.canAssess(part)).toBe(false);
  });

  it('uses opaque full-request keys, separates preferences and scopes entries by account', async () => {
    const { ai, app, auth } = setup();
    await vi.waitFor(() => expect(ai.status?.active).toBe('byo'));
    expect(ai.mode).toBe('byo');
    const fetchMock = vi.mocked(fetch);

    await ai.explain(explainInput);
    await ai.explain(explainInput);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'))).toHaveLength(1);
    const byoRequest = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/me/ai-explain'))?.[1];
    expect(JSON.parse(String(byoRequest?.body)).preferPool).toBe(false);

    await ai.savePromptPreferences({ customInstructions: 'Nur einen Hinweis geben.' });
    await ai.explain(explainInput);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'))).toHaveLength(2);

    await ai.savePromptPreferences({ customInstructions: '' });
    expect(ai.cached(explainInput)?.markdown).toBe('Erklärung');
    await ai.explain(explainInput);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'))).toHaveLength(2);

    ai.status = {
      ...ai.status!,
      byo: { ...ai.status!.byo, model: 'gpt-new' },
    };
    await ai.explain(explainInput);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'))).toHaveLength(3);

    await switchAccount(auth, 'u2');
    await vi.waitFor(() => expect(ai.canExplain).toBe(true));
    await ai.explain(explainInput);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'))).toHaveLength(4);

    const keys = (await storage.keys(STORAGE.aiCache)).filter((key) => key.startsWith('answer-v4/'));
    expect(keys).toHaveLength(4);
    expect(keys.every((key) => /^answer-v4\/v2:[a-f0-9]{64}\/v2:[a-f0-9]{64}$/.test(key))).toBe(true);
    const entries = await Promise.all(keys.map((key) => storage.get(STORAGE.aiCache, key)));
    expect(JSON.stringify(entries)).not.toContain('geheimer Rechenweg');
  });

  it('never derives the server-visible paid id from a low-entropy student answer', async () => {
    const { ai } = setup();
    await vi.waitFor(() => expect(ai.canHint).toBe(true));
    const bodies: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (!url.endsWith('/me/ai-explain')) throw new Error(`unexpected request ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return json({
        markdown: 'Vergleiche die eingesetzten Werte.',
        mode: 'diagnosis',
        diagnosis: {
          errorCode: 'careless',
          evidence: String(body.submitted),
          reason: 'Vergleiche die eingesetzten Werte.',
          correctionPrompt: 'Rechne den Schritt noch einmal.',
          confidence: 0.7,
          advisoryOnly: true,
          evidenceVerified: true,
        },
        model: 'gpt-test',
        promptVersion: 'ai-v2',
        taskVersion: body.taskVersion,
        clientRequestId: body.clientRequestId,
        interactionId: body.interactionId,
        accounting: 'settled',
        source: 'byo',
      });
    });
    const identity = {
      interactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
      taskVersion: 'diagnosis.v1',
      contentSource: 'remote' as const,
      contentId: 'a'.repeat(40),
      attemptPhase: 'first' as const,
    };
    for (const submitted of ['0', '1']) {
      await ai.explain({ question, part, submitted, result, mode: 'diagnosis', identity });
    }

    expect(new Set(bodies.map((body) => body.clientRequestId))).toHaveLength(2);
    for (const body of bodies) {
      const { clientRequestId, ...withoutId } = body;
      expect(clientRequestId).not.toBe(deterministicAiRequestId({
        interactionId: body.interactionId,
        request: withoutId,
        generation: 0,
      }));
    }
  });

  it('drops an in-flight response when its account scope changes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { ai, auth } = setup();
    await vi.waitFor(() => expect(ai.status?.active).toBe('byo'));
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (url.endsWith('/me/ai-explain')) {
        await gate;
        return json({
          markdown: 'alte Antwort',
          model: 'gpt-test',
          promptVersion: 'ai-v2',
          source: 'byo',
        } satisfies AiExplainResponse);
      }
      throw new Error(`unexpected request ${url}`);
    });

    const pending = ai.explain(explainInput);
    await vi.waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/me/ai-explain'))).toBe(true);
    });
    auth.session = {
      token: 'token-u2',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u2', username: 'user-2' },
      serverBaseUrl: 'https://server-a.test',
    };
    await nextTick();
    release();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect((await storage.keys(STORAGE.aiCache)).filter((key) => key.startsWith('answer-v4/'))).toHaveLength(1);
    expect(ai.cached(explainInput)).toBeUndefined();
  });

  it('keeps the newest status response when account refreshes overlap', async () => {
    const { ai, auth } = setup();
    await vi.waitFor(() => expect(ai.status?.active).toBe('byo'));

    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const newest = status({ features: { explain: false, assess: true } });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith('/me/ai/status')) throw new Error(`unexpected request ${url}`);
      if ((init?.headers as Record<string, string> | undefined)?.Authorization === 'Bearer token-u1') {
        await oldGate;
        return json(status({ features: { explain: true, assess: false } }));
      }
      return json(newest);
    });

    const oldRefresh = ai.refreshStatus();
    auth.session = {
      token: 'token-u2',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u2', username: 'user-2' },
      serverBaseUrl: 'https://server-a.test',
    };
    await vi.waitFor(() => expect(ai.status?.features).toEqual(newest.features));
    releaseOld();
    await oldRefresh;
    expect(ai.status?.features).toEqual(newest.features);
  });

  it('reuses one paid request id to confirm a lost response, then requires an explicit paid replacement', async () => {
    const { ai } = setup();
    await vi.waitFor(() => expect(ai.canHint).toBe(true));
    const requests: Array<Record<string, unknown>> = [];
    const completed = new Set<string>();
    let providerCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (!url.endsWith('/me/ai-explain')) throw new Error(`unexpected request ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      const requestId = String(body.clientRequestId);
      if (completed.has(requestId)) {
        return new Response(JSON.stringify({
          error: { code: 'AI_REQUEST_ALREADY_COMPLETED', message: 'receipt exists' },
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      completed.add(requestId);
      providerCalls += 1;
      if (providerCalls === 1) throw new Error('connection lost after provider response');
      const level = body.hintLevel as 1 | 2 | 3;
      return json({
        markdown: 'Hinweis ' + level,
        mode: 'hint',
        hint: {
          level,
          markdown: 'Hinweis ' + level,
          nextAction: 'Weiter',
          advisoryOnly: true,
        },
        model: 'gpt-test',
        promptVersion: 'ai-v2',
        taskVersion: 'hint.v1',
        clientRequestId: body.clientRequestId,
        interactionId: body.interactionId,
        accounting: 'settled',
        source: 'byo',
      });
    });
    const identity = {
      interactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
      taskVersion: 'hint.v1',
      contentSource: 'remote' as const,
      contentId: 'a'.repeat(40),
      attemptPhase: 'first' as const,
    };
    const firstHint = { question, part, submitted: '', mode: 'hint' as const, hintLevel: 1 as const, identity };

    await expect(ai.explain(firstHint)).rejects.toThrow('request failed');
    const confirmed = await ai.explain(firstHint).catch((error: unknown) => error);
    expect(confirmed).toMatchObject({
      code: 'AI_REQUEST_ALREADY_COMPLETED',
      paidRequestGeneration: 0,
    });
    await expect(ai.explain(firstHint, undefined, {
      newRequest: true,
      expectedGeneration: 0,
    })).resolves.toMatchObject({ mode: 'hint' });

    expect(requests[0]?.clientRequestId).toBe(requests[1]?.clientRequestId);
    expect(requests[2]?.clientRequestId).not.toBe(requests[1]?.clientRequestId);
    expect(providerCalls).toBe(2);
    expect(requests.every((request) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(String(request.clientRequestId)))).toBe(true);
  });

  it('converges two windows explicitly replacing the same lost request on one provider call', async () => {
    const first = setup();
    await vi.waitFor(() => expect(first.ai.canHint).toBe(true));
    const second = setup();
    await vi.waitFor(() => expect(second.ai.canHint).toBe(true));
    const requests: Array<Record<string, unknown>> = [];
    let providerCalls = 0;
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let activeRequestId: string | undefined;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (!url.endsWith('/me/ai-explain')) throw new Error(`unexpected request ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      const requestId = String(body.clientRequestId);
      if (activeRequestId !== undefined) {
        return new Response(JSON.stringify({
          error: { code: 'AI_REQUEST_IN_PROGRESS', message: 'request in progress' },
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      activeRequestId = requestId;
      providerCalls += 1;
      await providerGate;
      return json({
        markdown: 'Hinweis 1',
        mode: 'hint',
        hint: { level: 1, markdown: 'Hinweis 1', nextAction: 'Weiter', advisoryOnly: true },
        model: 'gpt-test',
        promptVersion: 'ai-v2',
        taskVersion: body.taskVersion,
        clientRequestId: body.clientRequestId,
        interactionId: body.interactionId,
        accounting: 'settled',
        source: 'byo',
      });
    });
    const replacement = {
      question,
      part,
      submitted: '',
      mode: 'hint' as const,
      hintLevel: 1 as const,
      identity: {
        interactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
        taskVersion: 'hint.v1',
        contentSource: 'remote' as const,
        contentId: 'a'.repeat(40),
        attemptPhase: 'first' as const,
      },
    };

    const outcomes = Promise.allSettled([
      first.ai.explain(replacement, undefined, { newRequest: true, expectedGeneration: 0 }),
      second.ai.explain(replacement, undefined, { newRequest: true, expectedGeneration: 0 }),
    ]);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    releaseProvider();
    const settled = await outcomes;

    expect(new Set(requests.map((request) => request.clientRequestId))).toHaveLength(1);
    expect(providerCalls).toBe(1);
    expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((outcome) => outcome.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'AI_REQUEST_IN_PROGRESS' }) }),
    ]);
  });

  it('derives idempotency from final payer and prompt preferences', async () => {
    const { ai, app } = setup();
    await vi.waitFor(() => expect(ai.canHint).toBe(true));
    const bodies: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (!url.endsWith('/me/ai-explain')) throw new Error(`unexpected request ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const payer = body.preferPool === true ? 'pool' : 'byo';
      return json({
        markdown: 'Hinweis',
        mode: 'hint',
        hint: { level: 1, markdown: 'Hinweis', nextAction: 'Weiter', advisoryOnly: true },
        model: payer === 'pool' ? 'gpt-pool' : 'gpt-test',
        promptVersion: 'ai-v2',
        source: payer,
        taskVersion: body.taskVersion,
        clientRequestId: body.clientRequestId,
        interactionId: body.interactionId,
        accounting: 'settled',
      });
    });
    const input = {
      question,
      part,
      submitted: '',
      mode: 'hint' as const,
      hintLevel: 1 as const,
      identity: {
        interactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
        taskVersion: 'hint.v1',
        contentSource: 'remote' as const,
        contentId: 'a'.repeat(40),
        attemptPhase: 'first' as const,
      },
    };
    await ai.explain(input);
    app.config = { ...app.config, aiLanguage: 'English' };
    await ai.explain(input);
    await ai.setMode('pool');
    await ai.explain(input);

    expect(new Set(bodies.map((body) => body.clientRequestId))).toHaveLength(3);
  });

  it('reuses the credential-test identity after a renderer reload and tombstones success', async () => {
    const first = setup();
    await vi.waitFor(() => expect(first.ai.canTestCredential).toBe(true));
    const requests: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (!url.endsWith('/me/ai/credential/test')) throw new Error(`unexpected request ${url}`);
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      throw new Error('connection reset after provider response');
    });

    await expect(first.ai.testCredential()).rejects.toThrow('request failed');

    const second = setup();
    await vi.waitFor(() => expect(second.ai.canTestCredential).toBe(true));
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (!url.endsWith('/me/ai/credential/test')) throw new Error(`unexpected request ${url}`);
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      return json({
        ok: true,
        provider: 'openai',
        model: 'gpt-test',
        source: 'byo',
        taskVersion: 'capability-test.v1',
        clientRequestId: request.clientRequestId,
        interactionId: request.interactionId,
        accounting: 'settled',
      });
    });

    await expect(second.ai.testCredential()).resolves.toMatchObject({ ok: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.clientRequestId).toBe(requests[0]?.clientRequestId);
    expect(requests[1]?.interactionId).toBe(requests[0]?.interactionId);
    expect((await storage.keys(STORAGE.aiCache)).some((key) =>
      key.startsWith('credential-test-pending/'))).toBe(false);
    expect((await storage.keys(STORAGE.aiCache)).some((key) =>
      key.startsWith('credential-test-completed/'))).toBe(true);

    const third = setup();
    await vi.waitFor(() => expect(third.ai.canTestCredential).toBe(true));
    await expect(third.ai.testCredential()).resolves.toMatchObject({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it('does not buy a second credential test after another window completed it', async () => {
    const first = setup();
    await vi.waitFor(() => expect(first.ai.canTestCredential).toBe(true));
    const second = setup();
    await vi.waitFor(() => expect(second.ai.canTestCredential).toBe(true));
    let providerCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = false;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (!url.endsWith('/me/ai/credential/test')) throw new Error(`unexpected request ${url}`);
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (active) {
        return new Response(JSON.stringify({
          error: { code: 'AI_REQUEST_IN_PROGRESS', message: 'request in progress' },
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      active = true;
      providerCalls += 1;
      await gate;
      return json({
        ok: true,
        provider: 'openai',
        model: 'gpt-test',
        source: 'byo',
        taskVersion: 'capability-test.v1',
        clientRequestId: request.clientRequestId,
        interactionId: request.interactionId,
        accounting: 'settled',
      });
    });

    const outcomes = Promise.allSettled([first.ai.testCredential(), second.ai.testCredential()]);
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) =>
      String(url).endsWith('/me/ai/credential/test'))).toHaveLength(2));
    release();
    const settled = await outcomes;
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(providerCalls).toBe(1);

    await expect(second.ai.testCredential()).resolves.toMatchObject({ ok: true });
    expect(providerCalls).toBe(1);
  });

  it('keeps a completed-but-lost credential receipt until an explicit paid replacement', async () => {
    const { ai } = setup();
    await vi.waitFor(() => expect(ai.canTestCredential).toBe(true));
    const requests: Array<Record<string, unknown>> = [];
    const completed = new Set<string>();
    let providerCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (!url.endsWith('/me/ai/credential/test')) throw new Error(`unexpected request ${url}`);
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      const id = String(request.clientRequestId);
      if (completed.has(id)) {
        return new Response(JSON.stringify({
          error: { code: 'AI_REQUEST_ALREADY_COMPLETED', message: 'receipt exists' },
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      completed.add(id);
      providerCalls += 1;
      if (providerCalls === 1) throw new Error('connection lost after provider response');
      return json({
        ok: true,
        provider: 'openai',
        model: 'gpt-test',
        source: 'byo',
        taskVersion: request.taskVersion,
        clientRequestId: request.clientRequestId,
        interactionId: request.interactionId,
        accounting: 'settled',
      });
    });

    await expect(ai.testCredential()).rejects.toThrow('request failed');
    const firstReceipt = requests[0]?.clientRequestId as string;
    await expect(ai.testCredential()).rejects.toMatchObject({
      code: 'AI_REQUEST_ALREADY_COMPLETED',
      credentialRequestId: firstReceipt,
    });
    await expect(ai.testCredential()).rejects.toMatchObject({
      code: 'AI_REQUEST_ALREADY_COMPLETED',
      credentialRequestId: firstReceipt,
    });
    expect(new Set(requests.slice(0, 3).map((request) => request.clientRequestId))).toEqual(new Set([firstReceipt]));
    expect(providerCalls).toBe(1);

    await expect(ai.testCredential({
      newRequest: true,
      expectedClientRequestId: firstReceipt,
    })).resolves.toMatchObject({ ok: true });
    expect(requests[3]?.clientRequestId).not.toBe(firstReceipt);
    expect(providerCalls).toBe(2);
  });

  it('invalidates a completed credential probe when a same-last4 key is replaced', async () => {
    const { ai } = setup();
    await vi.waitFor(() => expect(ai.canTestCredential).toBe(true));
    let currentStatus = status();
    let providerCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(currentStatus);
      if (url.endsWith('/me/ai/credential') && init?.method === 'PUT') {
        currentStatus = {
          ...currentStatus,
          byo: { ...currentStatus.byo, last4: '1234', credentialRevision: 'opaque-revision-b' },
        };
        return json(currentStatus);
      }
      if (!url.endsWith('/me/ai/credential/test')) throw new Error(`unexpected request ${url}`);
      providerCalls += 1;
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        ok: true,
        provider: 'openai',
        model: 'gpt-test',
        source: 'byo',
        taskVersion: request.taskVersion,
        clientRequestId: request.clientRequestId,
        interactionId: request.interactionId,
        accounting: 'settled',
      });
    });

    await ai.testCredential();
    await ai.testCredential();
    expect(providerCalls).toBe(1);
    await ai.saveCredential({ provider: 'openai', apiKey: 'new-secret-with-1234' });
    await ai.testCredential();
    expect(providerCalls).toBe(2);
  });

  it('does not replay a completed credential result from a legacy status without a revision', async () => {
    const legacy = status();
    delete legacy.byo.credentialRevision;
    const { ai } = setup(legacy);
    await vi.waitFor(() => expect(ai.canTestCredential).toBe(true));
    let providerCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(legacy);
      if (!url.endsWith('/me/ai/credential/test')) throw new Error(`unexpected request ${url}`);
      providerCalls += 1;
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        ok: true,
        provider: 'openai',
        model: 'gpt-test',
        source: 'byo',
        taskVersion: request.taskVersion,
        clientRequestId: request.clientRequestId,
        interactionId: request.interactionId,
        accounting: 'settled',
      });
    });

    await ai.testCredential();
    await ai.testCredential();
    expect(providerCalls).toBe(2);
  });

  it('aborts a credential test before networking when the account changes during journal recovery', async () => {
    const { ai, auth } = setup();
    await vi.waitFor(() => expect(ai.canTestCredential).toBe(true));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const completed = vi.spyOn(aiCredentialTestJournal, 'completed').mockImplementationOnce(async () => {
      await gate;
      return undefined;
    });

    const pending = ai.testCredential();
    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    await switchAccount(auth, 'u2');
    release();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) =>
      String(url).endsWith('/me/ai/credential/test'))).toHaveLength(0);
  });

  it.each(['hint', 'assess'] as const)(
    'never sends account A %s content with account B after a generation-journal wait',
    async (kind) => {
      const { ai, auth } = setup();
      await vi.waitFor(() => expect(ai.profilePreferencesReady).toBe(true));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const current = vi.spyOn(aiRequestGenerationJournal, 'current').mockImplementationOnce(async () => {
        await gate;
        return {
          version: 2,
          generation: 0,
          clientRequestId: '11111111-1111-4111-8111-111111111111',
        };
      });
      const identity = {
        interactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
        taskVersion: kind === 'hint' ? 'hint.v1' : 'assess.v1',
        contentSource: 'remote' as const,
        contentId: 'a'.repeat(40),
        attemptPhase: 'first' as const,
      };
      const pending = kind === 'hint'
        ? ai.explain({ question, part, submitted: '', mode: 'hint', hintLevel: 1, identity })
        : ai.assess({
            question,
            part,
            submitted: 'A: privater Lösungsweg',
            maxPoints: 1,
            scoreOptions: [0, 1],
            identity,
          });
      await vi.waitFor(() => expect(current).toHaveBeenCalledTimes(1));
      await switchAccount(auth, 'u2');
      release();

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(vi.mocked(fetch).mock.calls.filter(([url]) =>
        String(url).endsWith('/me/ai-explain') || String(url).endsWith('/me/ai-grade'))).toHaveLength(0);
    },
  );

  it('keeps payer and private prompt preferences isolated per local account', async () => {
    const { ai, auth } = setup();
    await vi.waitFor(() => expect(ai.profilePreferencesReady).toBe(true));
    await ai.setMode('pool');
    await ai.savePromptPreferences({ customInstructions: 'Nur für Konto A.' });
    expect(ai.mode).toBe('pool');
    expect(ai.customInstructions).toBe('Nur für Konto A.');

    await switchAccount(auth, 'u2');
    await vi.waitFor(() => expect(ai.profilePreferencesReady).toBe(true));
    expect(ai.mode).toBe('byo');
    expect(ai.customInstructions).toBe('');
    await ai.savePromptPreferences({ customInstructions: 'Nur für Konto B.' });

    await switchAccount(auth, 'u1');
    await vi.waitFor(() => expect(ai.customInstructions).toBe('Nur für Konto A.'));
    expect(ai.mode).toBe('pool');
  });

  it('clears only the active account paid cache', async () => {
    const { ai, auth } = setup();
    await vi.waitFor(() => expect(ai.profilePreferencesReady).toBe(true));
    const calls = () => vi.mocked(fetch).mock.calls.filter(([url]) =>
      String(url).endsWith('/me/ai-explain')).length;
    await ai.explain(explainInput);
    expect(calls()).toBe(1);

    await switchAccount(auth, 'u2');
    await vi.waitFor(() => expect(ai.profilePreferencesReady).toBe(true));
    await ai.explain(explainInput);
    expect(calls()).toBe(2);
    await ai.clearCache();

    await switchAccount(auth, 'u1');
    await vi.waitFor(() => expect(ai.profilePreferencesReady).toBe(true));
    await ai.explain(explainInput);
    expect(calls()).toBe(2);

    await switchAccount(auth, 'u2');
    await vi.waitFor(() => expect(ai.profilePreferencesReady).toBe(true));
    await ai.explain(explainInput);
    expect(calls()).toBe(3);
  });

  it('replays paid hint and self-assessment content offline without another provider call', async () => {
    const { ai, app } = setup();
    await vi.waitFor(() => expect(ai.canHint).toBe(true));
    const requests: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      requests.push(url);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith('/me/ai-explain')) {
        return json({
          markdown: 'Ordne zuerst die Terme.',
          mode: 'hint',
          hint: {
            level: 1,
            markdown: 'Ordne zuerst die Terme.',
            nextAction: 'Schreibe den ersten Umformungsschritt.',
            advisoryOnly: true,
          },
          model: 'gpt-test',
          promptVersion: 'ai-v2',
          taskVersion: body.taskVersion,
          clientRequestId: body.clientRequestId,
          interactionId: body.interactionId,
          accounting: 'settled',
          source: 'byo',
        });
      }
      if (url.endsWith('/me/ai-grade')) {
        return json({
          overall: {
            points: 1,
            confidence: 0.8,
            quote: 'mein geheimer Rechenweg',
            reason: 'Die Begründung ist schlüssig.',
            quoteVerified: true,
          },
          advisoryOnly: false,
          model: 'gpt-test',
          promptVersion: 'ai-v2',
          taskVersion: body.taskVersion,
          clientRequestId: body.clientRequestId,
          interactionId: body.interactionId,
          accounting: 'settled',
          source: 'byo',
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const identity = {
      interactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
      taskVersion: 'hint.v1',
      contentSource: 'remote' as const,
      contentId: 'a'.repeat(40),
      attemptPhase: 'first' as const,
    };
    const hintInput = {
      question,
      part,
      submitted: '',
      mode: 'hint' as const,
      hintLevel: 1 as const,
      identity,
    };
    const hint = await ai.explain(hintInput);
    const hintLocator = ai.explainCacheLocator(hintInput, hint)!;
    const assessInput = {
      question,
      part,
      submitted: explainInput.submitted,
      maxPoints: 1,
      scoreOptions: [0, 1],
      identity: { ...identity, taskVersion: 'assess.v1' },
    };
    const assessment = await ai.assess(assessInput);
    const assessmentLocator = ai.assessCacheLocator(assessInput, assessment!)!;
    expect(requests).toHaveLength(2);

    app.serverInfo = { ...app.serverInfo!, ai: undefined };
    ai.status = null;
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    await expect(ai.replayExplain(hintLocator, part)).resolves.toMatchObject({ mode: 'hint' });
    await expect(ai.replayAssess(assessmentLocator, assessInput)).resolves.toMatchObject({
      overall: { points: 1 },
    });
    await expect(ai.replayAssess(assessmentLocator, {
      ...assessInput,
      submitted: 'korrigierte andere Antwort',
      identity: { ...assessInput.identity, attemptPhase: 'correction' },
    })).rejects.toThrow('no longer matches this answer');
    expect(requests).toHaveLength(2);
  });

  it('returns a paid result when persistent cache reads or writes fail', async () => {
    const { ai } = setup();
    await vi.waitFor(() => expect(ai.status?.active).toBe('byo'));
    vi.spyOn(aiCache, 'get').mockRejectedValueOnce(new Error('corrupt cache'));
    vi.spyOn(aiCache, 'set').mockRejectedValueOnce(new Error('quota'));

    await expect(ai.explain(explainInput)).resolves.toMatchObject({ markdown: 'Erklärung' });
    expect(ai.cached(explainInput)?.markdown).toBe('Erklärung');
    expect(vi.mocked(fetch).mock.calls.filter(([url]) =>
      String(url).endsWith('/me/ai-explain'))).toHaveLength(1);
  });

  it('does not restore memory after a remote clear lands while paid writes resolve', async () => {
    const remote = captureRemoteCacheChanges();
    const { ai } = setup();
    await vi.waitFor(() => expect(ai.canHint && ai.canAssess(part)).toBe(true));
    installLearningResponses();
    const originalSet = aiCache.set.bind(aiCache);
    let persisted = 0;
    let markPersisted!: () => void;
    const bothPersisted = new Promise<void>((resolve) => { markPersisted = resolve; });
    let release!: () => void;
    const delayedResolution = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(aiCache, 'set').mockImplementation(async (...args) => {
      await originalSet(...args);
      persisted += 1;
      if (persisted === 2) markPersisted();
      await delayedResolution;
    });

    const pendingHint = ai.explain(paidHintInput);
    const pendingAssessment = ai.assess(paidAssessInput);
    await bothPersisted;
    const scope = await activeAiCacheScope();
    await aiCache.clear(scope);
    remote.emit({
      collection: STORAGE.aiCache,
      key: `${AI_CACHE_META_KEY}${scope}`,
      operation: 'set',
    });
    release();
    const [hint, assessment] = await Promise.all([pendingHint, pendingAssessment]);

    expect(ai.cached(paidHintInput)).toBeUndefined();
    await expect(ai.replayExplain(ai.explainCacheLocator(paidHintInput, hint)!, part))
      .resolves.toBeUndefined();
    await expect(ai.replayAssess(ai.assessCacheLocator(paidAssessInput, assessment!)!, paidAssessInput))
      .resolves.toBeUndefined();
  });

  it('ignores persistent hits read before a remote clear and obtains fresh paid results', async () => {
    const remote = captureRemoteCacheChanges();
    const { ai } = setup();
    await vi.waitFor(() => expect(ai.canHint && ai.canAssess(part)).toBe(true));
    const calls = installLearningResponses();
    await Promise.all([ai.explain(paidHintInput), ai.assess(paidAssessInput)]);
    remote.emit({ collection: STORAGE.aiCache, key: `${AI_CACHE_META_KEY}memory`, operation: 'set' });

    const originalGet = aiCache.get.bind(aiCache);
    let reads = 0;
    let markRead!: () => void;
    const bothRead = new Promise<void>((resolve) => { markRead = resolve; });
    let release!: () => void;
    const delayedReads = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(aiCache, 'get').mockImplementation(async (...args) => {
      const candidate = await originalGet(...args);
      reads += 1;
      if (reads === 2) markRead();
      await delayedReads;
      return candidate;
    });

    const pendingHint = ai.explain(paidHintInput);
    const pendingAssessment = ai.assess(paidAssessInput);
    await bothRead;
    const scope = await activeAiCacheScope();
    await aiCache.clear(scope);
    remote.emit({
      collection: STORAGE.aiCache,
      key: `${AI_CACHE_META_KEY}${scope}`,
      operation: 'set',
    });
    release();
    const [hint, assessment] = await Promise.all([pendingHint, pendingAssessment]);

    expect(hint).toMatchObject({ hint: { markdown: 'Neuer Hinweis.' } });
    expect(assessment).toMatchObject({ overall: { reason: 'Neue Bewertung.' } });
    expect(calls.hintCalls()).toBe(2);
    expect(calls.assessCalls()).toBe(2);
  });

  it('does not replay persistent help read before a remote clear', async () => {
    const remote = captureRemoteCacheChanges();
    const { ai } = setup();
    await vi.waitFor(() => expect(ai.canHint && ai.canAssess(part)).toBe(true));
    const calls = installLearningResponses();
    const [hint, assessment] = await Promise.all([
      ai.explain(paidHintInput),
      ai.assess(paidAssessInput),
    ]);
    const hintLocator = ai.explainCacheLocator(paidHintInput, hint)!;
    const assessLocator = ai.assessCacheLocator(paidAssessInput, assessment!)!;
    remote.emit({ collection: STORAGE.aiCache, key: `${AI_CACHE_META_KEY}memory`, operation: 'set' });

    const originalGet = aiCache.get.bind(aiCache);
    let reads = 0;
    let markRead!: () => void;
    const bothRead = new Promise<void>((resolve) => { markRead = resolve; });
    let release!: () => void;
    const delayedReads = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(aiCache, 'get').mockImplementation(async (...args) => {
      const candidate = await originalGet(...args);
      reads += 1;
      if (reads === 2) markRead();
      await delayedReads;
      return candidate;
    });

    const pendingHint = ai.replayExplain(hintLocator, part);
    const pendingAssessment = ai.replayAssess(assessLocator, paidAssessInput);
    await bothRead;
    const scope = await activeAiCacheScope();
    await aiCache.clear(scope);
    remote.emit({
      collection: STORAGE.aiCache,
      key: `${AI_CACHE_META_KEY}${scope}`,
      operation: 'set',
    });
    release();

    await expect(pendingHint).resolves.toBeUndefined();
    await expect(pendingAssessment).resolves.toBeUndefined();
    expect(calls.hintCalls()).toBe(1);
    expect(calls.assessCalls()).toBe(1);
  });

  it('does not resurrect a delayed paid hint after cache clear completes', async () => {
    const { ai } = setup();
    await vi.waitFor(() => expect(ai.canHint).toBe(true));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (!url.endsWith('/me/ai-explain')) throw new Error(`unexpected request ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      markStarted();
      await delayed;
      return json({
        markdown: 'Ordne zuerst die Terme.',
        mode: 'hint',
        hint: {
          level: 1,
          markdown: 'Ordne zuerst die Terme.',
          nextAction: 'Schreibe den ersten Umformungsschritt.',
          advisoryOnly: true,
        },
        model: 'gpt-test',
        promptVersion: 'ai-v2',
        taskVersion: body.taskVersion,
        clientRequestId: body.clientRequestId,
        interactionId: body.interactionId,
        accounting: 'settled',
        source: 'byo',
      });
    });
    const hintInput = {
      question,
      part,
      submitted: '',
      mode: 'hint' as const,
      hintLevel: 1 as const,
      identity: {
        interactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
        taskVersion: 'hint.v1',
        contentSource: 'remote' as const,
        contentId: 'a'.repeat(40),
        attemptPhase: 'first' as const,
      },
    };

    const pending = ai.explain(hintInput);
    await started;
    await ai.clearCache();
    release();
    const answer = await pending;

    expect(answer).toMatchObject({ mode: 'hint' });
    expect(ai.cached(hintInput)).toBeUndefined();
    const locator = ai.explainCacheLocator(hintInput, answer)!;
    await expect(ai.replayExplain(locator, part)).resolves.toBeUndefined();
  });

  it('does not resurrect a delayed paid assessment after cache clear completes', async () => {
    const { ai } = setup();
    await vi.waitFor(() => expect(ai.canAssess(part)).toBe(true));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/ai/status')) return json(status());
      if (!url.endsWith('/me/ai-grade')) throw new Error(`unexpected request ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      markStarted();
      await delayed;
      return json({
        overall: {
          points: 1,
          confidence: 0.8,
          quote: explainInput.submitted,
          reason: 'Die Begründung ist schlüssig.',
          quoteVerified: true,
        },
        advisoryOnly: false,
        model: 'gpt-test',
        promptVersion: 'ai-v2',
        taskVersion: body.taskVersion,
        clientRequestId: body.clientRequestId,
        interactionId: body.interactionId,
        accounting: 'settled',
        source: 'byo',
      });
    });
    const assessInput = {
      question,
      part,
      submitted: explainInput.submitted,
      maxPoints: 1,
      scoreOptions: [0, 1],
      identity: {
        interactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
        taskVersion: 'assess.v1',
        contentSource: 'remote' as const,
        contentId: 'a'.repeat(40),
        attemptPhase: 'first' as const,
      },
    };

    const pending = ai.assess(assessInput);
    await started;
    await ai.clearCache();
    release();
    const answer = await pending;

    expect(answer).toMatchObject({ overall: { points: 1 } });
    const locator = ai.assessCacheLocator(assessInput, answer!)!;
    await expect(ai.replayAssess(locator, assessInput)).resolves.toBeUndefined();
  });
});
