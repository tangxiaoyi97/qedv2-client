import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { watch } from 'vue';
import {
  STORAGE,
  questionContentHash,
  type CoreRuntimePort,
  type AtomicStoragePort,
  type CoreSourcePreference,
  type Question,
} from '@qed2/core-logic';
import { archiveStore, localProfileStore, ports, storage } from '../src/services.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';
import { practiceSessionStorageKey, usePracticeStore } from '../src/stores/practice.js';

const REVISION_A = 'a'.repeat(40);
const REVISION_B = 'b'.repeat(40);
const CONTENT_HASH = 'd'.repeat(64);
const originalCoreRuntime = ports.coreRuntime;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function question(id: string): Question {
  return {
    id,
    schemaVersion: 3,
    status: 'reviewed',
    lang: 'de',
    source: { suite: 'srdp', year: 2026, term: 'haupttermin', part: 't1', nr: 1, file: `${id}.pdf` },
    title: id,
    playable: true,
    prompt: [{ t: 'fig', src: `assets/fig/${id}.png`, alt: id }],
    parts: [{
      id: `${id}-a`,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function verifiedPng(contents: string): Promise<Response> {
  const bytes = new TextEncoder().encode(contents);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return new Response(bytes, {
    headers: {
      'content-type': 'image/png',
      'content-length': String(bytes.byteLength),
      etag: `"${hash}"`,
    },
  });
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function freshStores() {
  setActivePinia(createPinia());
  const progress = useProgressStore();
  await progress.init();
  return { practice: usePracticeStore(), progress };
}

function remoteBank() {
  let deployment = REVISION_A;
  let assetGate: ReturnType<typeof deferred> | undefined;
  const assetStarted = deferred();
  const created: Array<{ url: string; blob: Blob }> = [];
  const revokeObjectURL = vi.fn();
  const NativeUrl = URL;
  class AssetTestUrl extends NativeUrl {}
  Object.defineProperties(AssetTestUrl, {
    createObjectURL: { value: vi.fn((blob: Blob) => {
      const url = `blob:load-order-${created.length + 1}`;
      created.push({ url, blob });
      return url;
    }) },
    revokeObjectURL: { value: revokeObjectURL },
  });
  vi.stubGlobal('URL', AssetTestUrl);
  const getEndpoint = vi.fn(async (source: CoreSourcePreference = 'remote') => ({ baseUrl: 'http://core.load-order.test', source }));
  ports.coreRuntime = {
    capabilities: { localCore: true },
    getEndpoint,
  } satisfies CoreRuntimePort;
  vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
    const path = new URL(rawUrl).pathname;
    const revision = /\/content\/revisions\/([a-f0-9]+)\//u.exec(path)?.[1] ?? deployment;
    const id = revision === REVISION_A ? 'qa' : 'qb';
    if (path.endsWith('/manifest/v2')) {
      return json({ error: { code: 'NOT_FOUND', message: 'Cannot GET route' } }, 404);
    }
    if (path.endsWith('/manifest')) return json({ commit: revision, items: { [id]: CONTENT_HASH } });
    if (path.endsWith('/questions/batch')) {
      const q = question(id);
      return json({ questions: [{ ...q, contentHash: CONTENT_HASH, wireHash: questionContentHash(q) }], missing: [] });
    }
    if (path.endsWith(`/assets/fig/${id}.png`)) {
      if (revision === REVISION_A && assetGate) {
        assetStarted.resolve();
        await assetGate.promise;
      }
      return verifiedPng(`verified-image-${revision}`);
    }
    return json({});
  }));
  return {
    created,
    revokeObjectURL,
    getEndpoint,
    assetStarted: assetStarted.promise,
    deployB() { deployment = REVISION_B; },
    delayA() { assetGate = deferred(); },
    releaseA() { assetGate?.resolve(); },
  };
}

describe('practice load ordering', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await Promise.all([
      storage.clear(STORAGE.app),
      storage.clear(STORAGE.questions),
      storage.clear(STORAGE.archive),
      storage.clear(STORAGE.history),
      storage.clear(STORAGE.learning),
      storage.clear(STORAGE.auth),
    ]);
    await localProfileStore.initialize();
    await archiveStore.save({ content: { perPart: [], perCompetency: [] }, baseVersion: 0 });
  });

  afterEach(() => {
    ports.coreRuntime = originalCoreRuntime;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('finishes a delayed cold restore before preparing a newer exact selection and its blobs', async () => {
    const bank = remoteBank();
    const seeded = await freshStores();
    const idA = await seeded.practice.startPrepared(['qa'], 'remote', REVISION_A);
    bank.deployB();
    bank.delayA();
    const { practice, progress } = await freshStores();
    const publications: string[] = [];
    const stop = watch(() => practice.current?.question.id, (id) => { if (id) publications.push(id); }, { flush: 'sync' });
    const restoringA = practice.restoreSession('manual', idA);
    await bank.assetStarted;
    const endpointsBeforeB = bank.getEndpoint.mock.calls.length;
    const preparingB = practice.startPrepared(['qb'], 'remote', REVISION_B);
    void preparingB.catch(() => undefined);
    // Flush an independent ownership read: an unqueued B would already have
    // captured its owner and started rebinding the content at this point.
    await progress.captureAttemptOwner();
    await Promise.resolve();
    const endpointsWhileADelayed = bank.getEndpoint.mock.calls.length;
    const revisionWhileADelayed = practice.contentId;
    bank.releaseA();
    await expect(restoringA).resolves.toBe(true);
    const idB = await preparingB;
    stop();

    expect(endpointsWhileADelayed).toBe(endpointsBeforeB);
    expect(revisionWhileADelayed).toBe(REVISION_A);
    expect(idB).not.toBe(idA);
    expect(practice.items.map((item) => item.questionId)).toEqual(['qb']);
    expect(practice.items[0]?.clientAttemptId).toBe(idB);
    expect(practice.contentSource).toBe('remote');
    expect(practice.contentId).toBe(REVISION_B);
    expect(practice.sessionIdentityDurable).toBe(true);
    expect(publications).toEqual(['qa', 'qb']);
    const assetB = practice.assetUrl('assets/fig/qb.png');
    expect(assetB).toMatch(/^blob:load-order-/u);
    await expect(blobText(bank.created.find((entry) => entry.url === assetB)!.blob)).resolves.toBe(`verified-image-${REVISION_B}`);
    expect(bank.revokeObjectURL).not.toHaveBeenCalledWith(assetB);
    const restoredAssetA = bank.created[1]!.url;
    expect(bank.revokeObjectURL).toHaveBeenCalledWith(restoredAssetA);
    await expect(storage.get(STORAGE.app, practiceSessionStorageKey(localProfileStore.current()))).resolves.toMatchObject({
      contentSource: 'remote',
      contentId: REVISION_B,
      items: [expect.objectContaining({ questionId: 'qb', clientAttemptId: idB })],
    });
  });

  it('does not resurrect an aborted cold restore or publish its delayed asset', async () => {
    const bank = remoteBank();
    const seeded = await freshStores();
    const idA = await seeded.practice.startPrepared(['qa'], 'remote', REVISION_A);
    const key = practiceSessionStorageKey(localProfileStore.current());
    bank.deployB();
    bank.delayA();
    const { practice } = await freshStores();
    const restoring = practice.restoreSession('manual', idA);
    await bank.assetStarted;
    const createdBeforeAbort = bank.created.length;
    practice.abort();
    bank.releaseA();
    await Promise.allSettled([restoring]);

    expect(practice.phase).toBe('idle');
    expect(practice.items).toEqual([]);
    expect(practice.current).toBeUndefined();
    expect(practice.contentId).toBeUndefined();
    expect(practice.sessionIdentityDurable).toBe(false);
    expect(bank.created).toHaveLength(createdBeforeAbort);
    await expect(storage.get(STORAGE.app, key)).resolves.toBeUndefined();
  });

  it('cancels a prepared storage revision read before it can replace the durable programme', async () => {
    const bank = remoteBank();
    const { practice } = await freshStores();
    await practice.startPrepared(['qa'], 'remote', REVISION_A);
    const key = practiceSessionStorageKey(localProfileStore.current());
    const saved = await storage.get(STORAGE.app, key);
    bank.deployB();
    const atomic = storage as typeof storage & AtomicStoragePort;
    const read = atomic.readBatch.bind(atomic);
    const entered = deferred();
    const released = deferred();
    let blocked = false;
    vi.spyOn(atomic, 'readBatch').mockImplementation(async (addresses) => {
      if (!blocked && practice.items[0]?.questionId === 'qb'
        && addresses.some((address) => address.collection === STORAGE.app && address.key === key)) {
        blocked = true;
        entered.resolve();
        await released.promise;
      }
      return read(addresses);
    });
    const controller = new AbortController();
    const pending = practice.startPrepared(['qb'], 'remote', REVISION_B, controller.signal)
      .catch((cause: unknown) => cause);
    await entered.promise;
    controller.abort();
    released.resolve();
    await expect(pending).resolves.toMatchObject({ name: 'AbortError' });
    expect(practice.phase).toBe('idle');
    expect(practice.sessionIdentityDurable).toBe(false);
    await expect(storage.get(STORAGE.app, key)).resolves.toEqual(saved);
    expect(bank.revokeObjectURL).toHaveBeenCalledWith(bank.created.at(-1)!.url);
  });

  it('cannot publish a prepared load after its owning profile switches', async () => {
    const bank = remoteBank();
    bank.delayA();
    const { practice, progress } = await freshStores();
    const ownerKey = practiceSessionStorageKey(localProfileStore.current());
    const outcome = practice.startPrepared(['qa'], 'remote', REVISION_A).then(
      () => 'started',
      () => 'rejected',
    );
    await bank.assetStarted;
    await progress.activateUserProfile('profile-b');
    useAuthStore().session = {
      token: 'profile-b-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'profile-b', username: 'profile-b' },
    };
    const switchedKey = practiceSessionStorageKey(localProfileStore.current());
    bank.releaseA();
    await expect(outcome).resolves.toBe('rejected');

    expect(practice.current).toBeUndefined();
    expect(practice.sessionIdentityDurable).toBe(false);
    for (const { url } of bank.created) expect(bank.revokeObjectURL).toHaveBeenCalledWith(url);
    await expect(storage.get(STORAGE.app, ownerKey)).resolves.toBeUndefined();
    await expect(storage.get(STORAGE.app, switchedKey)).resolves.toBeUndefined();
  });
});
