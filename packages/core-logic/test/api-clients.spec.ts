import { afterEach, describe, expect, it, vi } from 'vitest';
import { BATCH_CHUNK_SIZE, CoreClient } from '../src/api/core-client.js';
import { ServerClient } from '../src/api/server-client.js';
import { CoreProtocolError, NetworkError } from '../src/api/types.js';

interface RecordedCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal };
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
  vi.useRealTimers();
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

  it('adds a revision cache key without changing the Core asset route', () => {
    expect(client.assetUrl('assets/fig/x.png', 'bank/a b')).toBe(
      'http://core.test/content/assets/fig/x.png?qed2-content=bank%2Fa%20b',
    );
  });

  it('builds an immutable revision asset URL and rejects ambiguous commits', () => {
    const commit = 'a'.repeat(40);
    expect(client.revisionAssetUrl('/assets/pdf/a b/ü.png', commit)).toBe(
      `http://core.test/content/revisions/${commit}/assets/pdf/a%20b/%C3%BC.png`,
    );
    expect(() => client.revisionAssetUrl('x.png', 'main')).toThrow('full lowercase Git SHA');
    expect(() => client.revisionAssetUrl('x.png', 'A'.repeat(40))).toThrow('full lowercase Git SHA');
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
    const calls = stubFetch(() => ({
      id: 'a b',
      parts: [],
      contentHash: 'a'.repeat(64),
      wireHash: 'b'.repeat(64),
    }));
    const result = await new CoreClient('http://core.test').getQuestion('a b');
    expect(calls[0]?.url).toBe('http://core.test/content/questions/a%20b');
    expect(result).toMatchObject({
      question: { id: 'a b', parts: [] },
      contentHash: 'a'.repeat(64),
      wireHash: 'b'.repeat(64),
    });
    expect(result.question).not.toHaveProperty('contentHash');
  });

  it('rejects non-canonical question integrity hashes', async () => {
    stubFetch(() => ({
      id: 'q-1',
      parts: [],
      contentHash: 'A'.repeat(64),
      wireHash: 'b'.repeat(64),
    }));
    await expect(new CoreClient('http://core.test').getQuestion('q-1')).rejects.toMatchObject({
      code: 'CORE_CONTENT_HASH_MISSING',
    });
  });

  it('recommend POSTs the request body as-is', async () => {
    const calls = stubFetch(() => ({ items: [], strategy: 'smart-review' }));
    await new CoreClient('http://core.test').recommend({ userState: {}, count: 5 });
    expect(calls[0]?.url).toBe('http://core.test/content/recommend');
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({ userState: {}, count: 5 });
  });

  it('uses the immutable revision manifest and question routes', async () => {
    const commit = 'c'.repeat(40);
    const calls = stubFetch((call) =>
      call.url.endsWith('/manifest')
        ? { commit, items: { 'q-1': 'a'.repeat(64) } }
        : {
            id: 'q 1',
            parts: [],
            contentHash: 'a'.repeat(64),
            wireHash: 'b'.repeat(64),
          },
    );
    const client = new CoreClient('http://core.test');
    await client.revisionManifest(commit);
    const question = await client.getRevisionQuestion(commit, 'q 1');
    expect(calls.map((call) => call.url)).toEqual([
      `http://core.test/content/revisions/${commit}/manifest`,
      `http://core.test/content/revisions/${commit}/questions/q%201`,
    ]);
    expect(question.contentHash).toBe('a'.repeat(64));
  });

  describe('manifest validation', () => {
    const commit = 'c'.repeat(40);
    const validManifest = { commit, items: { '2019-ht-t1-01': 'a'.repeat(64) } };

    it('accepts valid live and immutable manifests', async () => {
      stubFetch(() => validManifest);
      const client = new CoreClient('http://core.test');

      await expect(client.manifest()).resolves.toEqual(validManifest);
      await expect(client.revisionManifest(commit)).resolves.toEqual(validManifest);
    });

    it.each([
      ['short', 'c'.repeat(39)],
      ['uppercase', 'C'.repeat(40)],
    ])('rejects a %s manifest commit', async (_label, invalidCommit) => {
      stubFetch(() => ({ ...validManifest, commit: invalidCommit }));
      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        name: 'CoreProtocolError',
        code: 'CORE_MANIFEST_INVALID',
      } satisfies Partial<CoreProtocolError>);
    });

    it.each([
      ['short', 'a'.repeat(63)],
      ['uppercase', 'A'.repeat(64)],
    ])('rejects a %s item hash', async (_label, invalidHash) => {
      stubFetch(() => ({ commit, items: { 'q-1': invalidHash } }));
      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        code: 'CORE_MANIFEST_INVALID',
      });
    });

    it.each([null, [], 'not-an-object'])('rejects non-object manifest items', async (items) => {
      stubFetch(() => ({ commit, items }));
      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        code: 'CORE_MANIFEST_INVALID',
      });
    });

    it.each(['__proto__', 'constructor', 'prototype'])('rejects dangerous key %s', async (key) => {
      stubFetch(() => ({ commit, items: { [key]: 'a'.repeat(64) } }));
      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        code: 'CORE_MANIFEST_INVALID',
      });
    });

    it('rejects invalid or oversized question ids', async () => {
      const client = new CoreClient('http://core.test');
      stubFetch(() => ({ commit, items: { '../q': 'a'.repeat(64) } }));
      await expect(client.manifest()).rejects.toMatchObject({ code: 'CORE_MANIFEST_INVALID' });

      stubFetch(() => ({ commit, items: { ['q'.repeat(257)]: 'a'.repeat(64) } }));
      await expect(client.manifest()).rejects.toMatchObject({ code: 'CORE_MANIFEST_INVALID' });
    });

    it('rejects an oversized manifest item map', async () => {
      const items = Object.fromEntries(
        Array.from({ length: 10_001 }, (_, index) => [`q-${index}`, 'a'.repeat(64)]),
      );
      stubFetch(() => ({ commit, items }));
      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        code: 'CORE_MANIFEST_INVALID',
      });
    });

    it('rejects a revision manifest whose commit differs from the requested revision', async () => {
      stubFetch(() => ({ ...validManifest, commit: 'd'.repeat(40) }));
      await expect(
        new CoreClient('http://core.test').revisionManifest(commit),
      ).rejects.toMatchObject({ code: 'CORE_MANIFEST_INVALID' });
    });
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
        questions: req.ids.filter((id) => id.startsWith('q-')).map((id) => ({
          id,
          contentHash: 'a'.repeat(64),
          wireHash: 'b'.repeat(64),
        })),
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
    expect(res.questions[0]?.question.id).toBe('q-1');
    expect(res.questions.at(-1)?.question.id).toBe('q-249');
    expect(res.missing[0]).toBe('missing-0');
    expect(res.missing.at(-1)).toBe('missing-240');
  });

  it('issues no request for an empty id list', async () => {
    const calls = stubFetch(() => ({ questions: [], missing: [] }));
    const res = await new CoreClient('http://core.test').getQuestionsBatch([]);
    expect(calls).toHaveLength(0);
    expect(res).toEqual({ questions: [], missing: [] });
  });

  it('rejects a legacy Core batch that omits authoritative integrity metadata', async () => {
    stubFetch(() => ({ questions: [{ id: 'q-1' }], missing: [] }));
    await expect(
      new CoreClient('http://core.test').getQuestionsBatch(['q-1']),
    ).rejects.toMatchObject({
      name: 'CoreProtocolError',
      code: 'CORE_CONTENT_HASH_MISSING',
    } satisfies Partial<CoreProtocolError>);
  });

  it('sends exactly one request for exactly 200 ids', async () => {
    const calls = stubFetch((call) => {
      const req = JSON.parse(call.init.body ?? '') as { ids: string[] };
      return {
        questions: req.ids.map((id) => ({
          id,
          contentHash: 'a'.repeat(64),
          wireHash: 'b'.repeat(64),
        })),
        missing: [],
      };
    });
    const res = await new CoreClient('http://core.test').getQuestionsBatch(
      Array.from({ length: 200 }, (_, i) => `q-${i}`),
    );
    expect(calls).toHaveLength(1);
    expect(res.questions).toHaveLength(200);
  });

  it('chunks historical batches under the exact revision route', async () => {
    const commit = 'd'.repeat(40);
    const ids = Array.from({ length: BATCH_CHUNK_SIZE + 1 }, (_, index) => `q-${index}`);
    const calls = stubFetch((call) => {
      const request = JSON.parse(call.init.body ?? '') as { ids: string[] };
      return {
        questions: request.ids.map((id) => ({
          id,
          contentHash: 'a'.repeat(64),
          wireHash: 'b'.repeat(64),
        })),
        missing: [],
      };
    });
    const result = await new CoreClient('http://core.test')
      .getRevisionQuestionsBatch(commit, ids);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) =>
      call.url === `http://core.test/content/revisions/${commit}/questions/batch`,
    )).toBe(true);
    expect(result.questions).toHaveLength(ids.length);
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
      contentSource: 'local' as const,
      contentId: 'c'.repeat(40),
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

  it('requests one authenticated, timezone-aware history activity snapshot', async () => {
    const calls = stubFetch(() => ({ activity: { '2026-08-06': 3 } }));
    const result = await new ServerClient('http://server.test', () => 'tok').getHistoryActivity({
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-06T23:59:59.999Z',
      timeZone: 'Europe/Vienna',
    });

    expect(calls[0]?.url).toBe(
      'http://server.test/me/history/activity?since=2026-08-01T00%3A00%3A00.000Z&until=2026-08-06T23%3A59%3A59.999Z&timeZone=Europe%2FVienna',
    );
    expect(calls[0]?.init.headers.Authorization).toBe('Bearer tok');
    expect(result).toEqual({ activity: { '2026-08-06': 3 } });
  });

  it('supports the authenticated leaderboard list, detail and profile lifecycle', async () => {
    const calls = stubFetch((call) => {
      if (call.url.includes('/leaderboard/users/')) return { profileId: 'p/1', nickname: 'Mira' };
      if (call.url.endsWith('/me/leaderboard-profile') && call.init.method === 'GET') {
        return { participating: false, suggestedNickname: 'tester' };
      }
      if (call.init.method === 'PUT') return { participating: true, profileId: 'p1', nickname: 'Mira' };
      if (call.init.method === 'DELETE') return { participating: false };
      return { period: 'week', items: [], page: 2, pageSize: 25, totalParticipants: 0 };
    });
    const client = new ServerClient('http://server.test', () => 'tok');

    await client.getLeaderboard({ period: 'week', page: 2, pageSize: 25 });
    await client.getLeaderboardDetail('p/1');
    await client.getLeaderboardProfile();
    await client.saveLeaderboardProfile('Mira');
    await client.leaveLeaderboard();

    expect(calls[0]?.url).toBe('http://server.test/leaderboard?period=week&page=2&pageSize=25');
    expect(calls[1]?.url).toBe('http://server.test/leaderboard/users/p%2F1');
    expect(calls[2]?.url).toBe('http://server.test/me/leaderboard-profile');
    expect(calls[3]?.init.method).toBe('PUT');
    expect(JSON.parse(calls[3]?.init.body ?? '')).toEqual({ nickname: 'Mira' });
    expect(calls[4]?.init.method).toBe('DELETE');
    for (const call of calls) expect(call.init.headers.Authorization).toBe('Bearer tok');
  });

  it('info and health hit the unprefixed service endpoints', async () => {
    const calls = stubFetch(() => ({ status: 'ok', uptime: 1 }));
    const client = new ServerClient('http://server.test/');
    await client.health();
    await client.info();
    expect(calls[0]?.url).toBe('http://server.test/health');
    expect(calls[1]?.url).toBe('http://server.test/info');
  });

  it('gives bounded AI generation transport grace beyond the server window', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', (_url: string, init: RecordedCall['init']) => {
      receivedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const request = new ServerClient('http://server.test', () => 'tok').aiExplain({
      questionId: 'q1',
      partId: 'q1-a',
      submitted: 'x',
      maxPoints: 1,
      verdict: 'incorrect',
      awardedPoints: 0,
    });
    const rejected = expect(request).rejects.toBeInstanceOf(NetworkError);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(receivedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(receivedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(receivedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(receivedSignal?.aborted).toBe(true);
  });
});
