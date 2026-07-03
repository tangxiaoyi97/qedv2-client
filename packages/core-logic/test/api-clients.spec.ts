import { afterEach, describe, expect, it, vi } from 'vitest';
import { BATCH_CHUNK_SIZE, CoreClient } from '../src/api/core-client.js';
import { ServerClient } from '../src/api/server-client.js';

interface RecordedCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}

/** Stub fetch with a per-call responder; records every invocation. */
function stubFetch(respond: (call: RecordedCall) => unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', (url: string, init: RecordedCall['init']) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: '',
      text: () => Promise.resolve(JSON.stringify(respond(call))),
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CoreClient.assetUrl', () => {
  const client = new CoreClient('http://core.test/');

  it('strips the bank-root "assets/" prefix (live-core-verified §3.4 semantics)', () => {
    // The bank's fig src is bank-root-relative ('assets/pdf/...') while the
    // core route serves the assets/ subtree — the doubled form 404s live.
    expect(client.assetUrl('assets/pdf/x.png')).toBe('http://core.test/content/assets/pdf/x.png');
  });

  it('accepts already-relative paths unchanged', () => {
    expect(client.assetUrl('pdf/haupttermin-2019/fig/a.png')).toBe(
      'http://core.test/content/assets/pdf/haupttermin-2019/fig/a.png',
    );
  });

  it('never produces double slashes and encodes segments but not separators', () => {
    expect(client.assetUrl('/assets/pdf/a b/ü.png')).toBe(
      'http://core.test/content/assets/pdf/a%20b/%C3%BC.png',
    );
  });

  it('only strips one leading assets/ segment', () => {
    expect(client.assetUrl('assets/assets/x.png')).toBe(
      'http://core.test/content/assets/assets/x.png',
    );
  });
});

describe('CoreClient requests', () => {
  it('listQuestions maps the filter to query params and skips undefined', async () => {
    const calls = stubFetch(() => ({ items: [], page: 1, pageSize: 20, total: 0 }));
    const client = new CoreClient('http://core.test');
    // Filter keys not present must not appear in the URL (page, gk, ...).
    await client.listQuestions({ kind: 'interval', year: 2019 });
    expect(calls[0]?.url).toBe('http://core.test/content/questions?year=2019&kind=interval');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('getQuestion URL-encodes the id', async () => {
    const calls = stubFetch(() => ({ id: 'a b', parts: [] }));
    await new CoreClient('http://core.test').getQuestion('a b');
    expect(calls[0]?.url).toBe('http://core.test/content/questions/a%20b');
  });

  it('recommend POSTs the request body as-is', async () => {
    const calls = stubFetch(() => ({ items: [], strategy: 'smart-review' }));
    await new CoreClient('http://core.test').recommend({ userState: {}, count: 5 });
    expect(calls[0]?.url).toBe('http://core.test/content/recommend');
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({ userState: {}, count: 5 });
  });
});

describe('CoreClient.getQuestionsBatch chunking', () => {
  it('splits >200 ids into two requests and merges questions + missing', async () => {
    const ids = Array.from({ length: 250 }, (_, i) =>
      i % 10 === 0 ? `missing-${i}` : `q-${i}`,
    );
    const calls = stubFetch((call) => {
      const req = JSON.parse(call.init.body ?? '') as { ids: string[] };
      return {
        questions: req.ids.filter((id) => id.startsWith('q-')).map((id) => ({ id })),
        missing: req.ids.filter((id) => id.startsWith('missing-')),
      };
    });

    const res = await new CoreClient('http://core.test').getQuestionsBatch(ids);

    expect(calls).toHaveLength(2);
    const first = JSON.parse(calls[0]?.init.body ?? '') as { ids: string[] };
    const second = JSON.parse(calls[1]?.init.body ?? '') as { ids: string[] };
    expect(first.ids).toHaveLength(BATCH_CHUNK_SIZE);
    expect(second.ids).toHaveLength(50);
    expect(first.ids[0]).toBe('missing-0');
    expect(second.ids[0]).toBe('missing-200');

    expect(res.questions).toHaveLength(225);
    expect(res.missing).toHaveLength(25);
    // Merge preserves request order across chunks.
    expect(res.questions[0]?.id).toBe('q-1');
    expect(res.questions.at(-1)?.id).toBe('q-249');
    expect(res.missing[0]).toBe('missing-0');
    expect(res.missing.at(-1)).toBe('missing-240');
  });

  it('issues no request for an empty id list', async () => {
    const calls = stubFetch(() => ({ questions: [], missing: [] }));
    const res = await new CoreClient('http://core.test').getQuestionsBatch([]);
    expect(calls).toHaveLength(0);
    expect(res).toEqual({ questions: [], missing: [] });
  });

  it('sends exactly one request for exactly 200 ids', async () => {
    const calls = stubFetch((call) => {
      const req = JSON.parse(call.init.body ?? '') as { ids: string[] };
      return { questions: req.ids.map((id) => ({ id })), missing: [] };
    });
    const res = await new CoreClient('http://core.test').getQuestionsBatch(
      Array.from({ length: 200 }, (_, i) => `q-${i}`),
    );
    expect(calls).toHaveLength(1);
    expect(res.questions).toHaveLength(200);
  });
});

describe('ServerClient auth wiring', () => {
  it('login sends no Authorization header even when a token exists', async () => {
    const calls = stubFetch(() => ({ token: 't', expiresAt: 'x', user: { id: '1', username: 'u' } }));
    const client = new ServerClient('http://server.test', () => 'stale-token');
    await client.login('u', 'pw');
    expect(calls[0]?.url).toBe('http://server.test/auth/login');
    expect(calls[0]?.init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({ username: 'u', password: 'pw' });
  });

  it('redeem sends inviteCode + credentials without Authorization', async () => {
    const calls = stubFetch(() => ({ token: 't', expiresAt: 'x', user: { id: '1', username: 'u' } }));
    await new ServerClient('http://server.test', () => 'tok').redeem('CODE1', 'u', 'pw');
    expect(calls[0]?.url).toBe('http://server.test/auth/redeem');
    expect(calls[0]?.init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({
      inviteCode: 'CODE1',
      username: 'u',
      password: 'pw',
    });
  });

  it('authenticated endpoints read the token per call from the provider', async () => {
    let token: string | undefined = 'tok-1';
    const calls = stubFetch(() => ({
      archiveVersion: 0,
      checksum: 'c',
      updatedAt: 'x',
      perPart: [],
      perCompetency: [],
    }));
    const client = new ServerClient('http://server.test', () => token);
    await client.getState();
    token = 'tok-2';
    await client.getState();
    expect(calls[0]?.init.headers['Authorization']).toBe('Bearer tok-1');
    expect(calls[1]?.init.headers['Authorization']).toBe('Bearer tok-2');
  });

  it('sends unauthenticated when the provider yields undefined (server decides)', async () => {
    const calls = stubFetch(() => ({}));
    await new ServerClient('http://server.test').getState();
    expect(calls[0]?.init.headers).not.toHaveProperty('Authorization');
  });

  it('sync POSTs to /me/sync with token and body', async () => {
    const calls = stubFetch(() => ({ result: 'fast-forward', archiveVersion: 1, checksum: 'c' }));
    const req = { baseVersion: 0, localArchive: { perPart: [], perCompetency: [] } };
    await new ServerClient('http://server.test', () => 'tok').sync(req);
    expect(calls[0]?.url).toBe('http://server.test/me/sync');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['Authorization']).toBe('Bearer tok');
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual(req);
  });

  it('resolve POSTs to /me/sync/resolve', async () => {
    const calls = stubFetch(() => ({ result: 'resolved', archiveVersion: 2, checksum: 'c' }));
    await new ServerClient('http://server.test', () => 'tok').resolve({
      baseServerVersion: 1,
      resolvedArchive: { perPart: [], perCompetency: [] },
    });
    expect(calls[0]?.url).toBe('http://server.test/me/sync/resolve');
  });

  it('recordAttempts wraps the array in {attempts} (contract §4.2)', async () => {
    const calls = stubFetch(() => ({ recorded: 1 }));
    const attempt = {
      questionId: 'q1',
      partId: 'q1-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-07-03T00:00:00.000Z',
    };
    await new ServerClient('http://server.test', () => 'tok').recordAttempts([attempt]);
    expect(calls[0]?.url).toBe('http://server.test/me/attempts');
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({ attempts: [attempt] });
  });

  it('info and health hit the unprefixed service endpoints', async () => {
    const calls = stubFetch(() => ({ status: 'ok', uptime: 1 }));
    const client = new ServerClient('http://server.test/');
    await client.health();
    await client.info();
    expect(calls[0]?.url).toBe('http://server.test/health');
    expect(calls[1]?.url).toBe('http://server.test/info');
  });
});
