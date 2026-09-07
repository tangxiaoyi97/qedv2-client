import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { BATCH_CHUNK_SIZE, CoreClient } from '../src/api/core-client.js';
import { ServerClient } from '../src/api/server-client.js';
import { CoreProtocolError, NetworkError } from '../src/api/types.js';

interface RecordedCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal };
}

interface StubResponse {
  __response: true;
  status: number;
  body: unknown;
}

interface ManifestV2WireFixture {
  formatVersion: number;
  wireContractVersion: number;
  bank: {
    commit: string;
    rootSha256: string;
    schema: { path: string; sha256: string };
    immutableAssetBaseUrl: string;
  };
  questions: Record<string, {
    path: string;
    rawSha256: string;
    wireSha256: string;
    assets: string[];
  }>;
  assets: Record<string, {
    path: string;
    bytes: number;
    mimeType: string;
    sha256: string;
  }>;
}

function response(status: number, body: unknown = {}): StubResponse {
  return { __response: true, status, body };
}

/** Stub fetch with a per-call responder; records every invocation. */
function stubFetch(respond: (call: RecordedCall) => unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', (url: string, init: RecordedCall['init']) => {
    const call = { url, init };
    calls.push(call);
    const value = respond(call);
    const reply = isStubResponse(value) ? value : response(200, value);
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: reply.status === 404 ? 'Not Found' : reply.status >= 500 ? 'Server Error' : '',
      text: () => Promise.resolve(JSON.stringify(reply.body)),
    });
  });
  return calls;
}

function isStubResponse(value: unknown): value is StubResponse {
  return !!value && typeof value === 'object' && (value as { __response?: unknown }).__response === true;
}

function canonicalJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input !== null && typeof input === 'object') {
      const source = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(source).sort().filter((key) => source[key] !== undefined)
          .map((key) => [key, canonicalize(source[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(canonicalize(value));
}

function manifestV2(options: { withAsset?: boolean } = {}): ManifestV2WireFixture {
  const commit = 'c'.repeat(40);
  const schema = { path: 'schema/question.ts', sha256: 'd'.repeat(64) };
  const assets = options.withAsset
    ? {
        'fig/q-1.png': {
          path: 'assets/fig/q-1.png',
          bytes: 128,
          mimeType: 'image/png',
          sha256: 'e'.repeat(64),
        },
      }
    : {};
  const questions = {
    'q-1': {
      path: 'content/suite/q-1.json',
      rawSha256: 'a'.repeat(64),
      wireSha256: 'b'.repeat(64),
      assets: options.withAsset ? ['fig/q-1.png'] : [],
    },
  };
  const rootSha256 = bytesToHex(sha256(utf8ToBytes(canonicalJson({
    wireContractVersion: 1,
    schema,
    questions,
    assets,
  }))));
  return {
    formatVersion: 2,
    wireContractVersion: 1,
    bank: {
      commit,
      rootSha256,
      schema,
      immutableAssetBaseUrl: `/content/banks/${commit}/assets`,
    },
    questions,
    assets,
  };
}

function stubLegacyManifest(body: unknown): RecordedCall[] {
  return stubFetch((call) => (
    call.url.endsWith('/content/manifest/v2')
      ? response(404, { error: { code: 'NOT_FOUND', message: 'Cannot GET route' } })
      : body
  ));
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

  it('uses only the advertised immutable current-bank base for its matching commit', async () => {
    const wire = manifestV2({ withAsset: true });
    stubFetch(() => wire);
    const v2Client = new CoreClient('http://core.test/');
    const manifest = await v2Client.manifest();

    expect(v2Client.assetUrl('assets/fig/q-1.png')).toBe(
      `http://core.test/content/banks/${manifest.commit}/assets/fig/q-1.png`,
    );
    expect(v2Client.assetUrl('assets/fig/q-1.png', manifest.commit)).toBe(
      `http://core.test/content/banks/${manifest.commit}/assets/fig/q-1.png`,
    );
    expect(v2Client.assetUrl('assets/fig/q-1.png', 'f'.repeat(40))).toBe(
      `http://core.test/content/assets/fig/q-1.png?qed2-content=${'f'.repeat(40)}`,
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
      stubLegacyManifest(validManifest);
      const client = new CoreClient('http://core.test');

      await expect(client.manifest()).resolves.toEqual(validManifest);
      await expect(client.revisionManifest(commit)).resolves.toEqual(validManifest);
    });

    it.each([
      ['short', 'c'.repeat(39)],
      ['uppercase', 'C'.repeat(40)],
    ])('rejects a %s manifest commit', async (_label, invalidCommit) => {
      stubLegacyManifest({ ...validManifest, commit: invalidCommit });
      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        name: 'CoreProtocolError',
        code: 'CORE_MANIFEST_INVALID',
      } satisfies Partial<CoreProtocolError>);
    });

    it.each([
      ['short', 'a'.repeat(63)],
      ['uppercase', 'A'.repeat(64)],
    ])('rejects a %s item hash', async (_label, invalidHash) => {
      stubLegacyManifest({ commit, items: { 'q-1': invalidHash } });
      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        code: 'CORE_MANIFEST_INVALID',
      });
    });

    it.each([null, [], 'not-an-object'])('rejects non-object manifest items', async (items) => {
      stubLegacyManifest({ commit, items });
      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        code: 'CORE_MANIFEST_INVALID',
      });
    });

    it.each(['__proto__', 'constructor', 'prototype'])('rejects dangerous key %s', async (key) => {
      stubLegacyManifest({ commit, items: { [key]: 'a'.repeat(64) } });
      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        code: 'CORE_MANIFEST_INVALID',
      });
    });

    it('rejects invalid or oversized question ids', async () => {
      const client = new CoreClient('http://core.test');
      stubLegacyManifest({ commit, items: { '../q': 'a'.repeat(64) } });
      await expect(client.manifest()).rejects.toMatchObject({ code: 'CORE_MANIFEST_INVALID' });

      stubLegacyManifest({ commit, items: { ['q'.repeat(257)]: 'a'.repeat(64) } });
      await expect(client.manifest()).rejects.toMatchObject({ code: 'CORE_MANIFEST_INVALID' });
    });

    it('rejects an oversized manifest item map', async () => {
      const items = Object.fromEntries(
        Array.from({ length: 10_001 }, (_, index) => [`q-${index}`, 'a'.repeat(64)]),
      );
      stubLegacyManifest({ commit, items });
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

    it('strictly validates and exposes Manifest v2 while preserving raw-hash items', async () => {
      const wire = manifestV2({ withAsset: true });
      stubFetch(() => wire);

      const manifest = await new CoreClient('http://core.test').manifest();

      expect(manifest).toMatchObject({
        commit: 'c'.repeat(40),
        formatVersion: 2,
        wireContractVersion: 1,
        items: { 'q-1': 'a'.repeat(64) },
        questions: {
          'q-1': {
            rawSha256: 'a'.repeat(64),
            wireSha256: 'b'.repeat(64),
            assets: ['fig/q-1.png'],
          },
        },
        assets: {
          'fig/q-1.png': {
            bytes: 128,
            mimeType: 'image/png',
            sha256: 'e'.repeat(64),
          },
        },
      });
    });

    const invalidV2Cases: Array<[string, (wire: ManifestV2WireFixture) => void]> = [
      ['format', (wire) => { wire.formatVersion = 3; }],
      ['commit', (wire) => { wire.bank.commit = 'C'.repeat(40); }],
      ['root', (wire) => { wire.bank.rootSha256 = '0'.repeat(64); }],
      ['schema', (wire) => { wire.bank.schema.path = 'schema/other.ts'; }],
      ['raw hash', (wire) => { wire.questions['q-1']!.rawSha256 = 'A'.repeat(64); }],
      ['wire hash', (wire) => { wire.questions['q-1']!.wireSha256 = 'B'.repeat(64); }],
      ['asset bytes', (wire) => { wire.assets['fig/q-1.png']!.bytes = 0; }],
      ['asset MIME', (wire) => { wire.assets['fig/q-1.png']!.mimeType = 'image/jpeg'; }],
      ['asset SHA', (wire) => { wire.assets['fig/q-1.png']!.sha256 = 'E'.repeat(64); }],
      ['asset base', (wire) => { wire.bank.immutableAssetBaseUrl = '/content/assets'; }],
    ];
    it.each(invalidV2Cases)('rejects invalid v2 %s without requesting the legacy route', async (_label, mutate) => {
      const wire = manifestV2({ withAsset: true });
      mutate(wire);
      const calls = stubFetch(() => wire);

      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        code: 'CORE_MANIFEST_INVALID',
      });
      expect(calls.map((call) => call.url)).toEqual(['http://core.test/content/manifest/v2']);
    });

    it('falls back to v1 only when Manifest v2 explicitly returns 404', async () => {
      const calls = stubLegacyManifest(validManifest);

      await expect(new CoreClient('http://core.test').manifest()).resolves.toEqual(validManifest);
      expect(calls.map((call) => call.url)).toEqual([
        'http://core.test/content/manifest/v2',
        'http://core.test/content/manifest',
      ]);
    });

    it('does not fall back after a v2 service failure or network failure', async () => {
      const serviceCalls = stubFetch(() => response(503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'unavailable' },
      }));
      await expect(new CoreClient('http://core.test').manifest()).rejects.toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
      expect(serviceCalls).toHaveLength(1);

      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
      await expect(new CoreClient('http://core.test').manifest()).rejects.toBeInstanceOf(NetworkError);
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce();
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
    await new ServerClient('http://server.test', () => 'tok').redeem(
      'CODE1',
      'u',
      'pw',
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(calls[0]?.url).toBe('http://server.test/auth/redeem');
    expect(calls[0]?.init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({
      inviteCode: 'CODE1',
      username: 'u',
      password: 'pw',
      clientMutationId: '123e4567-e89b-42d3-a456-426614174000',
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
      clientAttemptId: 'attempt-1',
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

  it('validates the complete queued-attempt contract before opening the network', async () => {
    const calls = stubFetch(() => ({ recorded: 1 }));
    const base = {
      clientAttemptId: 'a',
      questionId: 'q',
      partId: 'p',
      correct: false,
      awardedPoints: Number.MAX_VALUE,
      elapsedMs: 7 * 24 * 3600 * 1000,
      gradedAt: '2026-08-15T12:34:56.123456789+02:30',
    };
    await new ServerClient('http://server.test', () => 'tok').recordAttempts([{
      ...base,
      clientAttemptId: 'a'.repeat(100),
      questionId: 'q'.repeat(200),
      partId: 'p'.repeat(200),
      contentSource: 'remote',
      contentId: 'f'.repeat(64),
      extra: 'stripped like the Server Zod object',
    } as typeof base & { contentSource: 'remote'; contentId: string }]);
    expect(JSON.parse(calls[0]?.init.body ?? '').attempts[0]).not.toHaveProperty('extra');

    const invalid = [
      { ...base, clientAttemptId: '' },
      { ...base, clientAttemptId: 'a'.repeat(101) },
      { ...base, questionId: '' },
      { ...base, questionId: 'q'.repeat(201) },
      { ...base, partId: '' },
      { ...base, partId: 'p'.repeat(201) },
      { ...base, correct: 1 },
      { ...base, awardedPoints: Number.POSITIVE_INFINITY },
      { ...base, elapsedMs: -1 },
      { ...base, elapsedMs: 1.5 },
      { ...base, elapsedMs: 7 * 24 * 3600 * 1000 + 1 },
      { ...base, gradedAt: '2026-08-15T12:34:56' },
      { ...base, gradedAt: '2026-13-99T12:34:56Z' },
      { ...base, contentSource: 'local' },
      { ...base, contentId: 'a'.repeat(40) },
      { ...base, contentSource: 'local', contentId: 'A'.repeat(40) },
      { ...base, contentSource: 'local', contentId: 'a'.repeat(41) },
    ];
    for (const attempt of invalid) {
      await expect(new ServerClient('http://server.test').recordAttempts([attempt as never]))
        .rejects.toThrow(TypeError);
    }
    await expect(new ServerClient('http://server.test').recordAttempts([])).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(1);
  });

  it('uses an opaque history cursor without also sending an offset page', async () => {
    const calls = stubFetch(() => ({
      items: [],
      pageSize: 50,
      hasMore: false,
    }));
    await new ServerClient('http://server.test', () => 'tok').getHistory({
      cursor: 'opaque.cursor/value',
      page: 9,
      pageSize: 50,
      partId: 'part-1',
    });
    expect(calls[0]?.url).toBe(
      'http://server.test/me/history?cursor=opaque.cursor%2Fvalue&pageSize=50&partId=part-1',
    );
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
