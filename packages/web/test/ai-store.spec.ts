import 'fake-indexeddb/auto';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE,
  type AiCapabilities,
  type AiExplainResponse,
  type AiStatus,
  type GradeResult,
  type Question,
  type QuestionPart,
} from '@qed2/core-logic';
import { aiCache, storage } from '../src/services.js';
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
  promptVersion: 'ai-v2',
  providers: ['openai'],
  poolAvailable: true,
};

function status(overrides: Partial<AiStatus> = {}): AiStatus {
  return {
    byo: { configured: true, provider: 'openai', model: 'gpt-test', last4: '1234' },
    pool: {
      eligible: true,
      provider: 'openai',
      model: 'gpt-pool',
      remaining: { tokens: 1000 },
    },
    active: 'byo',
    features: { explain: true, assess: true },
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

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
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

describe('AI store release guards', () => {
  beforeEach(async () => {
    await storage.clear(STORAGE.aiCache);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    app.config = { ...app.config, aiPreferPool: false };
    await vi.waitFor(() => expect(ai.status).toEqual(poolOnly));

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

    app.config = { ...app.config, aiCustomInstructions: 'Nur einen Hinweis geben.' };
    await ai.explain(explainInput);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'))).toHaveLength(2);

    app.config = { ...app.config, aiCustomInstructions: undefined };
    expect(ai.cached(explainInput)?.markdown).toBe('Erklärung');
    await ai.explain(explainInput);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'))).toHaveLength(2);

    ai.status = {
      ...ai.status!,
      byo: { ...ai.status!.byo, model: 'gpt-new' },
    };
    await ai.explain(explainInput);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'))).toHaveLength(3);

    auth.session = {
      token: 'token-u2',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u2', username: 'user-2' },
    };
    await settle();
    await ai.explain(explainInput);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/ai-explain'))).toHaveLength(4);

    const entries = await storage.get<Array<{ key: string }>>(STORAGE.aiCache, 'answers-v2');
    expect(entries).toHaveLength(4);
    expect(entries?.every((entry) => /^v2:[a-f0-9]{64}$/.test(entry.key))).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('geheimer Rechenweg');
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
    };
    await nextTick();
    release();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await aiCache.size()).toBe(0);
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
    };
    await vi.waitFor(() => expect(ai.status?.features).toEqual(newest.features));
    releaseOld();
    await oldRefresh;
    expect(ai.status?.features).toEqual(newest.features);
  });
});
