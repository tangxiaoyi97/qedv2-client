import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  STORAGE,
  questionContentHash,
  type CoreRuntimePort,
  type LocalArchive,
  type Question,
} from '@qed2/core-logic';
import { archiveStore, ports, storage } from '../src/services.js';
import { usePracticeStore } from '../src/stores/practice.js';

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const RAW_HASH = '5'.repeat(64);
const ASSET_PATH = `/content/revisions/${COMMIT}/assets/fig/q1.png`;
const EMPTY_ARCHIVE: LocalArchive = {
  content: { perPart: [], perCompetency: [] },
  baseVersion: 0,
};
const originalCoreRuntime = ports.coreRuntime;

function question(): Question {
  return {
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
      file: 'q1.pdf',
    },
    title: 'q1',
    playable: true,
    prompt: [{ t: 'fig', src: 'assets/fig/q1.png', alt: 'q1' }],
    parts: [{
      id: 'q1-a',
      label: 'a',
      competencies: [{ code: 'AG 1.1' }],
      answer: {
        kind: 'choice',
        options: [[{ t: 'text', v: 'richtig' }], [{ t: 'text', v: 'falsch' }]],
        correct: [0],
        selectCount: 1,
      },
      scoring: { mode: 'allOrNothing', points: 1 },
      points: 1,
    }],
  };
}

function jsonReply(body: unknown): object {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

interface AssetResponseOverrides {
  contentLength?: string | null;
  contentType?: string | null;
  etag?: string | null;
  etagBytes?: Uint8Array;
}

async function assetReply(
  bytes: Uint8Array,
  overrides: AssetResponseOverrides = {},
): Promise<object> {
  const headers = new Map<string, string>();
  const contentLength = overrides.contentLength === undefined
    ? String(bytes.byteLength)
    : overrides.contentLength;
  const contentType = overrides.contentType === undefined ? 'image/png' : overrides.contentType;
  const etag = overrides.etag === undefined
    ? `"${await sha256(overrides.etagBytes ?? bytes)}"`
    : overrides.etag;
  if (contentLength !== null) headers.set('content-length', contentLength);
  if (contentType !== null) headers.set('content-type', contentType);
  if (etag !== null) headers.set('etag', etag);
  const bodyBytes = new Uint8Array(bytes.byteLength);
  bodyBytes.set(bytes);
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bodyBytes);
        controller.close();
      },
    }),
    blob: async () => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return new Blob([copy.buffer], { type: contentType ?? '' });
    },
  };
}

function stubObjectUrls(): ReturnType<typeof vi.fn> {
  const NativeUrl = URL;
  const createObjectURL = vi.fn(() => 'blob:q1');
  class AssetTestUrl extends NativeUrl {}
  Object.defineProperties(AssetTestUrl, {
    createObjectURL: { value: createObjectURL },
    revokeObjectURL: { value: vi.fn() },
  });
  vi.stubGlobal('URL', AssetTestUrl);
  return createObjectURL;
}

async function startWithAsset(response: object, historical = false): Promise<{
  practice: ReturnType<typeof usePracticeStore>;
  assetRequests: string[];
  createObjectURL: ReturnType<typeof vi.fn>;
}> {
  const q1 = question();
  const assetRequests: string[] = [];
  const createObjectURL = stubObjectUrls();
  vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
    const path = new URL(rawUrl).pathname;
    if (path === '/content/manifest') {
      return jsonReply({ commit: historical ? OTHER_COMMIT : COMMIT, items: { q1: RAW_HASH } });
    }
    if (path === `/content/revisions/${COMMIT}/manifest`) {
      return jsonReply({ commit: COMMIT, items: { q1: RAW_HASH } });
    }
    if (
      path === '/content/questions/batch'
      || path === `/content/revisions/${COMMIT}/questions/batch`
    ) {
      return jsonReply({
        questions: [{ ...q1, contentHash: RAW_HASH, wireHash: questionContentHash(q1) }],
        missing: [],
      });
    }
    if (path === ASSET_PATH) {
      assetRequests.push(path);
      return response;
    }
    throw new Error(`unexpected request ${path}`);
  }));

  setActivePinia(createPinia());
  const practice = usePracticeStore();
  await practice.startQuestions(['q1'], 'remote', historical ? COMMIT : undefined);
  return { practice, assetRequests, createObjectURL };
}

describe('practice asset snapshot integrity', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      storage.clear(STORAGE.app),
      storage.clear(STORAGE.questions),
      storage.clear(STORAGE.archive),
    ]);
    await archiveStore.save(EMPTY_ARCHIVE);
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint: async (source = 'remote') => ({
        baseUrl: 'http://core.integrity.test',
        source,
      }),
    } satisfies CoreRuntimePort;
  });

  afterEach(() => {
    ports.coreRuntime = originalCoreRuntime;
    vi.unstubAllGlobals();
  });

  it.each([
    ['current', false],
    ['historical', true],
  ])('uses the immutable revision asset route for %s content', async (_mode, historical) => {
    const bytes = new TextEncoder().encode('verified-png');
    const result = await startWithAsset(await assetReply(bytes), historical);

    expect(result.practice.phase, result.practice.error).toBe('running');
    expect(result.assetRequests).toEqual([ASSET_PATH]);
    expect(result.practice.assetUrl('assets/fig/q1.png')).toBe('blob:q1');
    expect(result.createObjectURL).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing Content-Length', async (bytes: Uint8Array) => assetReply(bytes, { contentLength: null })],
    ['missing ETag', async (bytes: Uint8Array) => assetReply(bytes, { etag: null })],
    ['weak ETag', async (bytes: Uint8Array) => assetReply(bytes, { etag: `W/"${await sha256(bytes)}"` })],
    ['wrong MIME', async (bytes: Uint8Array) => assetReply(bytes, { contentType: 'image/jpeg' })],
    ['truncated bytes', async (bytes: Uint8Array) => assetReply(bytes, { contentLength: String(bytes.byteLength + 1) })],
    ['same-length tampering', async (bytes: Uint8Array) => {
      const expected = new TextEncoder().encode('trusted-bytes');
      return assetReply(bytes, { etagBytes: expected });
    }],
    ['oversized declaration', async (bytes: Uint8Array) => assetReply(bytes, {
      contentLength: String(32 * 1024 * 1024 + 1),
    })],
  ])('fails closed for %s', async (_label, responseFor) => {
    const bytes = new TextEncoder().encode('altered-bytes');
    const result = await startWithAsset(await responseFor(bytes));

    expect(result.practice.phase).toBe('error');
    expect(result.createObjectURL).not.toHaveBeenCalled();
  });
});
