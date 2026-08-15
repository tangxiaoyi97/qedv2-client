import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  accountStorageIdentity,
  archiveChecksum,
  attemptOutboxRowKey,
  DEFAULT_CONFIG,
  GUEST_ATTEMPT_OWNER,
  STORAGE,
  type AtomicStoragePort,
  type LocalArchive,
  type StorageBatchCommit,
} from '@qed2/core-logic';
import {
  archiveStore,
  attemptOutbox,
  localProfileStore,
  storage,
  syncMutationJournal,
} from '../src/services.js';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

const SERVER = DEFAULT_CONFIG.serverBaseUrl;
const OWNER_U1 = accountStorageIdentity(SERVER, 'u1');
const OWNER_U2 = accountStorageIdentity(SERVER, 'u2');
const OWNER_NEW_USER = accountStorageIdentity(SERVER, 'new-user');

const EMPTY: LocalArchive = {
  content: { perPart: [], perCompetency: [] },
  baseVersion: 0,
};

const EVOLVED_F1: LocalArchive = {
  content: {
    perPart: [],
    perCompetency: [{
      code: 'AG 1.1',
      mastery: 0.4,
      updatedAt: '2026-08-15T10:00:00.000Z',
    }],
  },
  baseVersion: 0,
};

const EVOLVED_F2: LocalArchive = {
  content: {
    perPart: [],
    perCompetency: [{
      code: 'AG 1.1',
      mastery: 0.8,
      updatedAt: '2026-08-15T10:01:00.000Z',
    }],
  },
  baseVersion: 0,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function setup(): Promise<ReturnType<typeof useProgressStore>> {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.session = {
    token: 'test-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
    user: { id: 'u1', username: 'tester' },
    serverBaseUrl: SERVER,
  };
  await localProfileStore.initialize(OWNER_U1);
  await archiveStore.save(EMPTY);
  const progress = useProgressStore();
  await progress.init();
  return progress;
}

describe('progress sync orchestration', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await storage.clear(STORAGE.auth);
    await storage.clear(STORAGE.history);
    await storage.clear(STORAGE.archive);
    await storage.clear(STORAGE.app);
  });

  it('compares checksums before recommendations and skips POST when equal', async () => {
    const progress = await setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/me/state');
      return json({
        archiveVersion: 7,
        checksum: archiveChecksum(EMPTY.content),
        perPart: [],
        perCompetency: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(progress.syncBeforeRecommendation()).resolves.toBe('in-sync');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(progress.archive.baseVersion).toBe(7);
    expect(await syncMutationJournal.listPending({
      serverBaseUrl: useAppStore().config.serverBaseUrl,
      userId: 'u1',
    })).toEqual([]);
  });

  it('serializes a grade behind an in-flight sync so the newer progress survives', async () => {
    const progress = await setup();
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain('/me/sync');
      expect(init?.method).toBe('POST');
      await syncGate;
      return json({ result: 'fast-forward', archiveVersion: 1, checksum: 'server-checksum' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const syncing = progress.syncNow({ quiet: true });
    const grading = progress.applyGrade({
      partId: 'q1-a',
      questionId: 'q1',
      competencyCodes: ['AG 1.1'],
      result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseSync();
    await Promise.all([syncing, grading]);

    expect(progress.archive.baseVersion).toBe(1);
    expect(progress.archive.content.perPart.map((part) => part.partId)).toEqual(['q1-a']);
    expect(progress.archive.content.perPart[0]?.grading).toBe('good');
  });

  it('retries a network sync instead of overwriting a mutation from another window', async () => {
    const progress = await setup();
    let releaseFirstSync!: () => void;
    const firstSyncGate = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });
    let requestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/me/sync');
      requestCount += 1;
      if (requestCount === 1) await firstSyncGate;
      return json({
        result: 'fast-forward',
        archiveVersion: requestCount,
        checksum: `server-${requestCount}`,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const syncing = progress.syncNow({ quiet: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Simulates a commit made by the practice renderer while this renderer is
    // awaiting the server. It must survive the first response.
    await archiveStore.setStarred('q2-a', true, new Date('2026-07-23T12:00:00.000Z'));
    releaseFirstSync();

    await expect(syncing).resolves.toBe('synced');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progress.archive.baseVersion).toBe(2);
    expect(progress.archive.content.perPart).toEqual([
      expect.objectContaining({ partId: 'q2-a', starred: true }),
    ]);
  });

  it('replays the same receipt after the server responds but the local archive commit fails', async () => {
    const progress = await setup();
    const ids: string[] = [];
    const receipts = new Map<string, { result: 'fast-forward'; archiveVersion: number; checksum: string }>();
    let serverVersion = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith('/me/state')) {
        return json({
          archiveVersion: serverVersion,
          checksum: archiveChecksum(EMPTY.content),
          perPart: [],
          perCompetency: [],
        });
      }
      const body = JSON.parse(String(init?.body)) as { clientMutationId: string };
      ids.push(body.clientMutationId);
      let response = receipts.get(body.clientMutationId);
      if (!response) {
        serverVersion += 1;
        response = {
          result: 'fast-forward',
          archiveVersion: serverVersion,
          checksum: archiveChecksum(EMPTY.content),
        };
        receipts.set(body.clientMutationId, response);
      }
      return json(response);
    }));
    const atomicStorage = storage as AtomicStoragePort;
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    let failArchiveCommit = true;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request: StorageBatchCommit) => {
      if (
        failArchiveCommit
        && request.mutations.some((mutation) => mutation.collection === STORAGE.archive)
      ) {
        failArchiveCommit = false;
        throw new Error('simulated archive commit failure');
      }
      return commit(request);
    });

    await expect(progress.syncNow({ quiet: true })).resolves.toBe('error');
    expect(ids).toHaveLength(1);
    await expect(progress.syncNow({ quiet: true })).resolves.toBe('synced');
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(serverVersion).toBe(1);
    expect(progress.archive.baseVersion).toBe(1);
    expect(await syncMutationJournal.listPending({
      serverBaseUrl: useAppStore().config.serverBaseUrl,
      userId: 'u1',
    })).toEqual([]);
  });

  it.each([
    {
      name: 'stops after two replays when the authoritative state is F2',
      firstReplayVersion: 1,
      secondReplayVersion: 2,
      authoritativeArchive: EVOLVED_F2,
      authoritativeVersion: 2,
      expectedPosts: 2,
      expectedBaseVersion: 2,
    },
    {
      name: 'adds one fresh sync when reverse receipt versions leave the server at F1',
      firstReplayVersion: 2,
      secondReplayVersion: 1,
      authoritativeArchive: EVOLVED_F1,
      authoritativeVersion: 2,
      expectedPosts: 3,
      expectedBaseVersion: 3,
    },
  ])('$name', async ({
    firstReplayVersion,
    secondReplayVersion,
    authoritativeArchive,
    authoritativeVersion,
    expectedPosts,
    expectedBaseVersion,
  }) => {
    const progress = await setup();
    const scope = {
      serverBaseUrl: useAppStore().config.serverBaseUrl,
      userId: 'u1',
    };

    // Two renderers created response-ambiguous writes while the durable local
    // archive advanced from F1 to F2. Creation time, not key enumeration, is
    // the replay order promised by SyncMutationJournal.listPending().
    await archiveStore.save(EVOLVED_F1);
    const f1 = await syncMutationJournal.getOrCreate(scope, {
      operation: 'sync',
      fingerprint: `v1-0-${archiveChecksum(EVOLVED_F1.content)}`,
      baseVersion: 0,
      localArchive: EVOLVED_F1.content,
    }, new Date('2026-08-15T10:00:00.000Z'));
    await archiveStore.save(EVOLVED_F2);
    const f2 = await syncMutationJournal.getOrCreate(scope, {
      operation: 'sync',
      fingerprint: `v1-0-${archiveChecksum(EVOLVED_F2.content)}`,
      baseVersion: 0,
      localArchive: EVOLVED_F2.content,
    }, new Date('2026-08-15T10:01:00.000Z'));

    const posts: Array<{
      clientMutationId: string;
      baseVersion: number;
      localArchive: LocalArchive['content'];
    }> = [];
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith('/me/state')) {
        return json({
          archiveVersion: authoritativeVersion,
          checksum: archiveChecksum(authoritativeArchive.content),
          perPart: authoritativeArchive.content.perPart,
          perCompetency: authoritativeArchive.content.perCompetency,
        });
      }
      if (!path.endsWith('/me/sync')) throw new Error(`Unexpected request: ${path}`);
      const body = JSON.parse(String(init?.body)) as typeof posts[number];
      posts.push(body);
      if (posts.length === 1) {
        return json({
          result: 'fast-forward',
          archiveVersion: firstReplayVersion,
          checksum: archiveChecksum(EVOLVED_F1.content),
        });
      }
      if (posts.length === 2) {
        return json({
          result: 'fast-forward',
          archiveVersion: secondReplayVersion,
          checksum: archiveChecksum(EVOLVED_F2.content),
        });
      }
      return json({
        result: 'fast-forward',
        archiveVersion: 3,
        checksum: archiveChecksum(EVOLVED_F2.content),
      });
    }));

    await expect(progress.syncNow({ quiet: true })).resolves.toBe('synced');

    expect(posts).toHaveLength(expectedPosts);
    expect(posts[0]?.clientMutationId).toBe(f1.clientMutationId);
    expect(posts[1]?.clientMutationId).toBe(f2.clientMutationId);
    expect(posts[0]).toMatchObject({ baseVersion: 0, localArchive: EVOLVED_F1.content });
    expect(posts[1]).toMatchObject({ baseVersion: 0, localArchive: EVOLVED_F2.content });
    expect(paths.slice(0, 3)).toEqual(['/me/sync', '/me/sync', '/me/state']);
    if (expectedPosts === 2) {
      // The final GET is authoritative: matching F2 calibrates its baseVersion
      // without manufacturing a third mutation identity.
      expect(paths).toEqual(['/me/sync', '/me/sync', '/me/state']);
    } else {
      expect(paths).toEqual(['/me/sync', '/me/sync', '/me/state', '/me/sync']);
      expect(posts[2]).toMatchObject({
        baseVersion: secondReplayVersion,
        localArchive: EVOLVED_F2.content,
      });
      expect(posts[2]?.clientMutationId).not.toBe(f1.clientMutationId);
      expect(posts[2]?.clientMutationId).not.toBe(f2.clientMutationId);
    }
    expect(progress.archive.content).toEqual(EVOLVED_F2.content);
    expect(progress.archive.baseVersion).toBe(expectedBaseVersion);
    expect(await syncMutationJournal.listPending(scope)).toEqual([]);
  });

  it('recovers an acknowledged conflict resolution without leaving a stale dialog', async () => {
    const progress = await setup();
    const ids: string[] = [];
    let resolveAccepted = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/me/state')) {
        return json({
          archiveVersion: 7,
          checksum: archiveChecksum(EMPTY.content),
          perPart: [],
          perCompetency: [],
        });
      }
      const body = JSON.parse(String(init?.body)) as { clientMutationId: string };
      ids.push(body.clientMutationId);
      if (path.endsWith('/me/sync')) {
        return json({
          result: 'conflict',
          serverVersion: 6,
          serverChecksum: 'server-conflict',
          conflicts: [],
          autoMergeable: { perPart: [], perCompetency: [] },
        });
      }
      if (!path.endsWith('/me/sync/resolve')) throw new Error(`Unexpected request: ${path}`);
      if (!resolveAccepted) {
        resolveAccepted = true;
        throw new TypeError('response lost after commit');
      }
      return json({ result: 'resolved', archiveVersion: 7, checksum: 'resolved' });
    }));

    await expect(progress.syncNow({ quiet: true })).resolves.toBe('conflict');
    expect(progress.conflict).toBeDefined();
    await expect(progress.resolveConflict({})).rejects.toThrow();
    expect(progress.conflict).toBeDefined();

    await expect(progress.syncNow({ quiet: true })).resolves.toBe('synced');
    expect(progress.conflict).toBeUndefined();
    expect(progress.syncStatus.state).toBe('synced');
    expect(progress.archive.baseVersion).toBe(7);
    expect(ids).toHaveLength(3);
    expect(ids[2]).toBe(ids[1]);
  });

  it('keeps audit attempts durably queued offline and removes them after an acknowledged retry', async () => {
    const progress = await setup();
    const attempt = {
      clientAttemptId: 'durable-attempt-1',
      questionId: 'q1',
      partId: 'q1-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-07-23T12:00:00.000Z',
    };

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await progress.queueAttempt(attempt);
    expect(await attemptOutbox.count(OWNER_U1)).toBe(1);
    expect(progress.attemptUploadStatus).toEqual({
      state: 'pending',
      pendingCount: 1,
      message: '1 Antwort wartet auf eine Verbindung.',
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ attempts: [attempt] });
      return json({ recorded: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await progress.flushAttemptOutbox();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await attemptOutbox.count(OWNER_U1)).toBe(0);
    expect(progress.attemptUploadStatus).toEqual({ state: 'idle', pendingCount: 0 });
  });

  it('uploads a valid later attempt while preserving an older corrupt v2 row for export', async () => {
    const progress = await setup();
    const badKey = attemptOutboxRowKey(OWNER_U1, 'bad-oldest');
    const badValue = {
      userId: OWNER_U1,
      attempt: {
        clientAttemptId: 'bad-oldest',
        questionId: 'q-bad',
        partId: 'q-bad-a',
        correct: true,
        awardedPoints: Number.NaN,
        gradedAt: '2026-07-23T11:00:00.000Z',
      },
    };
    const good = {
      clientAttemptId: 'good-later',
      questionId: 'q-good',
      partId: 'q-good-a',
      correct: true,
      awardedPoints: 1,
      elapsedMs: 0,
      gradedAt: '2026-07-23T12:00:00.000Z',
    };
    await storage.set(STORAGE.history, badKey, badValue);
    await storage.set(STORAGE.history, attemptOutboxRowKey(OWNER_U1, good.clientAttemptId), {
      userId: OWNER_U1,
      attempt: good,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ attempts: [good] });
      return json({ recorded: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await progress.flushAttemptOutbox();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await attemptOutbox.count(OWNER_U1)).toBe(0);
    expect(await attemptOutbox.corruptCount()).toBe(1);
    expect(await storage.get(STORAGE.history, badKey)).toEqual(badValue);
  });

  it('keeps attempts pending for automatic recovery after a transient server failure', async () => {
    const progress = await setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'TEMPORARY_FAILURE', message: 'try later' },
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })));

    await progress.queueAttempt({
      clientAttemptId: 'server-error-attempt',
      questionId: 'q-error',
      partId: 'q-error-a',
      correct: false,
      awardedPoints: 0,
      gradedAt: '2026-08-07T10:45:00.000Z',
    });

    expect(await attemptOutbox.count(OWNER_U1)).toBe(1);
    expect(progress.attemptUploadStatus).toEqual({
      state: 'pending',
      pendingCount: 1,
      message: '1 Antwort wartet auf eine Verbindung.',
    });
  });

  it('keeps an acknowledged attempt and signs out when the server endpoint changes in flight', async () => {
    const progress = await setup();
    const app = useAppStore();
    const auth = useAuthStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return json({ recorded: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const uploading = progress.queueAttempt({
      clientAttemptId: 'endpoint-switch-attempt',
      questionId: 'q-endpoint',
      partId: 'q-endpoint-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-07T10:44:30.000Z',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await app.updateConfig({ serverBaseUrl: 'https://server-b.example' });
    release();
    await uploading;

    expect(await attemptOutbox.count(OWNER_U1)).toBe(1);
    await vi.waitFor(() => expect(auth.session).toBeUndefined());
    // The row remains scoped to the old account. With no active account the
    // global status intentionally becomes idle instead of exposing that
    // account's pending work on a shared device.
    expect(progress.attemptUploadStatus).toEqual({ state: 'idle', pendingCount: 0 });
  });

  it('never lets a recovery timer captured by A sync the newly active account B', async () => {
    const progress = await setup();
    const auth = useAuthStore();
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json({
      result: 'fast-forward',
      archiveVersion: 1,
      checksum: 'unexpected-recovery',
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      progress.scheduleCloudRecovery(true);
      auth.session = {
        token: 'token-b',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: { id: 'u2', username: 'second' },
        serverBaseUrl: SERVER,
      };

      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      progress.cancelCloudRecovery();
      vi.useRealTimers();
    }
  });

  it('finishes an in-flight A upload with A credentials and stops before syncing B', async () => {
    const progress = await setup();
    const auth = useAuthStore();
    await progress.stageAttempt({
      clientAttemptId: 'recovery-owned-by-a',
      questionId: 'q-recovery-a',
      partId: 'q-recovery-a-1',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-07T12:00:00.000Z',
    }, OWNER_U1);
    const archiveLoad = vi.spyOn(archiveStore, 'load');
    archiveLoad.mockClear();
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let uploadStarted!: () => void;
    const uploadStart = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const requests: Array<{ path: string; authorization?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      if (path.endsWith('/me/attempts')) {
        uploadStarted();
        await uploadGate;
        return json({ recorded: 1 });
      }
      throw new Error(`Old recovery reached a later sync request: ${path}`);
    }));

    try {
      progress.scheduleCloudRecovery(true);
      await uploadStart;
      auth.session = {
        token: 'token-b',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: { id: 'u2', username: 'second' },
        serverBaseUrl: SERVER,
      };
      progress.cancelCloudRecovery();
      releaseUpload();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

      expect(requests).toEqual([{
        path: '/me/attempts',
        authorization: 'Bearer test-token',
      }]);
      expect(archiveLoad).not.toHaveBeenCalled();
      expect(await attemptOutbox.count(OWNER_U1)).toBe(1);
    } finally {
      releaseUpload();
      progress.cancelCloudRecovery();
    }
  });

  it('cancels an old-account timer before the new account login reconciliation', async () => {
    const progress = await setup();
    const auth = useAuthStore();
    let releaseState!: () => void;
    const stateGate = new Promise<void>((resolve) => {
      releaseState = resolve;
    });
    let stateStarted!: () => void;
    const stateStart = new Promise<void>((resolve) => {
      stateStarted = resolve;
    });
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith('/auth/login')) {
        return json({
          token: 'token-b',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { id: 'u2', username: 'second' },
        });
      }
      if (path.endsWith('/me/state')) {
        stateStarted();
        await stateGate;
        return json({ archiveVersion: 0, checksum: 'empty', perPart: [], perCompetency: [] });
      }
      throw new Error(`Unexpected recovery request: ${path}`);
    }));

    try {
      progress.scheduleCloudRecovery(true);
      const loggingIn = auth.login('second', 'password123');
      await stateStart;

      // If afterAuth had not invalidated A's timer before reconcileOnLogin,
      // this would queue a second, B-credentialed sync behind reconciliation.
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      releaseState();
      await loggingIn;

      expect(paths).toEqual(['/auth/login', '/me/state']);
    } finally {
      releaseState();
      progress.cancelCloudRecovery();
    }
  });

  it('catches storage failures in detached recovery and retries with bounded backoff', async () => {
    const progress = await setup();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.spyOn(attemptOutbox, 'count').mockRejectedValueOnce(new Error('sqlite temporarily busy'));

    try {
      progress.scheduleCloudRecovery(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 15_000);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      progress.cancelCloudRecovery();
      vi.useRealTimers();
    }
  });

  it('retains attempts but requires a fresh login after authentication expires', async () => {
    const progress = await setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'UNAUTHORIZED', message: 'expired' },
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })));

    await progress.queueAttempt({
      clientAttemptId: 'expired-session-attempt',
      questionId: 'q-auth',
      partId: 'q-auth-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-07T10:46:00.000Z',
    });

    expect(await attemptOutbox.count(OWNER_U1)).toBe(1);
    expect(progress.attemptUploadStatus).toEqual({
      state: 'error',
      pendingCount: 1,
      message: 'Der Antwortverlauf wartet auf eine erneute Anmeldung.',
    });
  });

  it('binds concurrent flushes to their owner/token and never lets B reuse A', async () => {
    const progress = await setup();
    const auth = useAuthStore();
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aCalls = 0;
    const requests: Array<{ id: string; authorization: string | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { attempts: Array<{ clientAttemptId: string }> };
      const id = body.attempts[0]!.clientAttemptId;
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      requests.push({ id, authorization });
      if (id === 'attempt-a') {
        aCalls += 1;
        if (aCalls === 1) await aGate;
      }
      return json({ recorded: 1 });
    }));

    const attemptA = {
      clientAttemptId: 'attempt-a',
      questionId: 'q-a',
      partId: 'q-a-1',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-07T11:00:00.000Z',
    };
    const flushingA = progress.queueAttempt(attemptA);
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    auth.session = {
      token: 'token-b',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u2', username: 'second' },
      serverBaseUrl: SERVER,
    };
    await localProfileStore.activateUser(OWNER_U2);
    const attemptB = {
      clientAttemptId: 'attempt-b',
      questionId: 'q-b',
      partId: 'q-b-1',
      correct: false,
      awardedPoints: 0,
      gradedAt: '2026-08-07T11:01:00.000Z',
    };
    await progress.queueAttempt(attemptB);

    expect(await attemptOutbox.count(OWNER_U2)).toBe(0);
    expect(await attemptOutbox.count(OWNER_U1)).toBe(1);
    expect(requests.find((request) => request.id === 'attempt-b')?.authorization).toBe('Bearer token-b');

    releaseA();
    await flushingA;
    expect(await attemptOutbox.count(OWNER_U1)).toBe(1);
    expect(requests[0]).toEqual({ id: 'attempt-a', authorization: 'Bearer test-token' });

    auth.session = {
      token: 'test-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'tester' },
      serverBaseUrl: SERVER,
    };
    await localProfileStore.activateUser(OWNER_U1);
    await progress.flushAttemptOutbox();
    expect(await attemptOutbox.count(OWNER_U1)).toBe(0);
    expect(aCalls).toBe(2);
  });

  it('keeps an answer with its captured owner when the active session changes before enqueue', async () => {
    const progress = await setup();
    const auth = useAuthStore();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    auth.session = {
      token: 'token-b',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u2', username: 'second' },
      serverBaseUrl: SERVER,
    };
    await progress.queueAttempt({
      clientAttemptId: 'captured-owner-attempt',
      questionId: 'q-owner',
      partId: 'q-owner-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-07T11:05:00.000Z',
    }, OWNER_U1);

    expect(await attemptOutbox.count(OWNER_U1)).toBe(1);
    expect(await attemptOutbox.count(OWNER_U2)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps guest attempts, claims them for registration and invalidates cloud history after ack', async () => {
    setActivePinia(createPinia());
    const progress = useProgressStore();
    await progress.init();
    const attempt = {
      clientAttemptId: 'guest-registration-attempt',
      questionId: 'q-guest',
      partId: 'q-guest-a',
      correct: false,
      awardedPoints: 0,
      gradedAt: '2026-08-07T09:00:00.000Z',
    };

    await progress.queueAttempt(attempt);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);

    const auth = useAuthStore();
    auth.session = {
      token: 'new-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'new-user', username: 'new-user' },
      serverBaseUrl: SERVER,
    };
    await expect(progress.claimGuestAttempts(OWNER_NEW_USER)).resolves.toBe(1);

    vi.stubGlobal('fetch', vi.fn(async () => json({ recorded: 1 })));
    await progress.flushAttemptOutbox();

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count(OWNER_NEW_USER)).toBe(0);
    expect(progress.cloudHistoryVersion).toBe(1);
  });
});
