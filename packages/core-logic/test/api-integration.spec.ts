/**
 * Integration tests against the REAL local services (no mocks):
 *   core   http://localhost:8787
 *   server http://localhost:8080
 * Each suite is skipped when its service is unreachable. Read-only and
 * anonymous throughout — no accounts are created and no credentials assumed.
 */
import { describe, expect, it } from 'vitest';
import { CoreClient } from '../src/api/core-client.js';
import { ServerClient } from '../src/api/server-client.js';
import { ApiError } from '../src/api/types.js';

const CORE_URL = 'http://localhost:8787';
const SERVER_URL = 'http://localhost:8080';

// core-logic compiles without DOM/Node libs, so the platform globals used by
// this Node-run spec are accessed through a structurally-typed alias.
const g = globalThis as unknown as {
  fetch: (url: string, init?: { signal?: unknown }) => Promise<{ ok: boolean; status: number }>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  AbortController: new () => { signal: unknown; abort(): void };
};

async function reachable(baseUrl: string): Promise<boolean> {
  const ctl = new g.AbortController();
  const timer = g.setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await g.fetch(`${baseUrl}/health`, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    g.clearTimeout(timer);
  }
}

const coreUp = await reachable(CORE_URL);
const serverUp = await reachable(SERVER_URL);

/** Depth-first search for the first figure src in a question document. */
function findFigSrc(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findFigSrc(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;
    if ((obj['t'] === 'fig' || obj['kind'] === 'image') && typeof obj['src'] === 'string') {
      return obj['src'];
    }
    for (const value of Object.values(obj)) {
      const found = findFigSrc(value);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

describe.skipIf(!coreUp)(`core integration (${CORE_URL})`, () => {
  const core = new CoreClient(CORE_URL);

  it('info reports a schemaVersionSupported range covering v2', async () => {
    const info = await core.info();
    // The bank schema evolves (v3 added candidateGroups); the client supports
    // 2..3, so pin only what we rely on instead of the service's exact max.
    expect(info.schemaVersionSupported.min).toBe(2);
    expect(info.schemaVersionSupported.max).toBeGreaterThanOrEqual(3);
    expect(info.service).toBe('qed2-core');
  });

  it('health responds ok', async () => {
    const health = await core.health();
    expect(health.status).toBe('ok');
  });

  it('listQuestions({kind:"interval"}) finds at least one question', async () => {
    const res = await core.listQuestions({ kind: 'interval' });
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.items.length).toBeGreaterThanOrEqual(1);
  });

  it('getQuestion(2019-ht-t1-01) is a choice part', async () => {
    const q = await core.getQuestion('2019-ht-t1-01');
    expect(q.id).toBe('2019-ht-t1-01');
    expect(q.parts[0]?.answer?.kind).toBe('choice');
  });

  it('rubric criteria follow the preview bank schema (plain desc strings)', async () => {
    const q = await core.getQuestion('2019-nt1-t1-11');
    const scoring = q.parts[0]?.scoring;
    expect(scoring?.mode).toBe('rubric');
    if (scoring?.mode !== 'rubric') throw new Error('expected rubric scoring');
    expect(typeof scoring.criteria[0]?.desc).toBe('string');
  });

  it('batch reports unknown ids in missing and returns the rest', async () => {
    const res = await core.getQuestionsBatch(['2019-ht-t1-01', 'zz-does-not-exist']);
    expect(res.questions.map((q) => q.id)).toContain('2019-ht-t1-01');
    expect(res.missing).toContain('zz-does-not-exist');
  });

  it('getQuestion for an unknown id raises the contract error envelope', async () => {
    const err = await core.getQuestion('zz-does-not-exist').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe('QUESTION_NOT_FOUND');
  });

  it('recommend with empty userState returns count coldstart items', async () => {
    const res = await core.recommend({ userState: {}, count: 5 });
    expect(res.items).toHaveLength(5);
    for (const item of res.items) expect(item.reason).toBe('coldstart');
  });

  it('recommend surfaces a due part as due-review', async () => {
    const partId = '2019-ht-t1-01-a';
    const res = await core.recommend({
      userState: {
        perPart: [
          {
            partId,
            fsrs: {
              due: '2020-01-01T00:00:00.000Z', // long overdue
              stability: 1,
              difficulty: 5,
              reps: 1,
              lapses: 0,
              lastReview: '2019-12-01T00:00:00.000Z',
            },
          },
        ],
        perCompetency: [],
      },
      count: 5,
    });
    const due = res.items.find((i) => i.partId === partId);
    expect(due?.reason).toBe('due-review');
  });

  it('assetUrl resolves a real figure src to a fetchable URL', async () => {
    // Find any question that actually carries figures, then fetch one.
    const list = await core.listQuestions({ pageSize: 100 });
    const withFigures = list.items.find((q) => q.parts.some((p) => p.hasFigures));
    expect(withFigures).toBeDefined();
    const question = await core.getQuestion(withFigures!.id);
    const src = findFigSrc(question);
    expect(src).toBeDefined();
    const res = await g.fetch(core.assetUrl(src!));
    expect(res.ok).toBe(true);
  });
});

describe.skipIf(!serverUp)(`server integration (${SERVER_URL})`, () => {
  it('health responds ok', async () => {
    const health = await new ServerClient(SERVER_URL).health();
    expect(health.status).toBe('ok');
  });

  it('login with wrong credentials raises ApiError 401', async () => {
    const server = new ServerClient(SERVER_URL);
    const err = await server
      .login('no-such-user-integration-probe', 'definitely-wrong-password')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).code).not.toBe('');
  });

  it('getState without a token raises ApiError 401', async () => {
    const server = new ServerClient(SERVER_URL); // default provider: no token
    const err = await server.getState().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });
});
