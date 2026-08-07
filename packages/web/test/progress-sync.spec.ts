import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { archiveChecksum, GUEST_ATTEMPT_OWNER, STORAGE, type LocalArchive } from '@qed2/core-logic';
import { archiveStore, attemptOutbox, storage } from '../src/services.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

const EMPTY: LocalArchive = {
  content: { perPart: [], perCompetency: [] },
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
  await archiveStore.save(EMPTY);
  const auth = useAuthStore();
  auth.session = {
    token: 'test-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
    user: { id: 'u1', username: 'tester' },
  };
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
    expect(await attemptOutbox.count('u1')).toBe(1);
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
    expect(await attemptOutbox.count('u1')).toBe(0);
    expect(progress.attemptUploadStatus).toEqual({ state: 'idle', pendingCount: 0 });
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

    expect(await attemptOutbox.count('u1')).toBe(1);
    expect(progress.attemptUploadStatus).toEqual({
      state: 'pending',
      pendingCount: 1,
      message: '1 Antwort wartet auf eine Verbindung.',
    });
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
    }, 'u1');
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
      };
      progress.cancelCloudRecovery();
      releaseUpload();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

      expect(requests).toEqual([{
        path: '/me/attempts',
        authorization: 'Bearer test-token',
      }]);
      expect(archiveLoad).not.toHaveBeenCalled();
      expect(await attemptOutbox.count('u1')).toBe(1);
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

    expect(await attemptOutbox.count('u1')).toBe(1);
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
    };
    const attemptB = {
      clientAttemptId: 'attempt-b',
      questionId: 'q-b',
      partId: 'q-b-1',
      correct: false,
      awardedPoints: 0,
      gradedAt: '2026-08-07T11:01:00.000Z',
    };
    await progress.queueAttempt(attemptB);

    expect(await attemptOutbox.count('u2')).toBe(0);
    expect(await attemptOutbox.count('u1')).toBe(1);
    expect(requests.find((request) => request.id === 'attempt-b')?.authorization).toBe('Bearer token-b');

    releaseA();
    await flushingA;
    expect(await attemptOutbox.count('u1')).toBe(1);
    expect(requests[0]).toEqual({ id: 'attempt-a', authorization: 'Bearer test-token' });

    auth.session = {
      token: 'test-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'tester' },
    };
    await progress.flushAttemptOutbox();
    expect(await attemptOutbox.count('u1')).toBe(0);
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
    };
    await progress.queueAttempt({
      clientAttemptId: 'captured-owner-attempt',
      questionId: 'q-owner',
      partId: 'q-owner-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-07T11:05:00.000Z',
    }, 'u1');

    expect(await attemptOutbox.count('u1')).toBe(1);
    expect(await attemptOutbox.count('u2')).toBe(0);
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
    };
    await expect(progress.claimGuestAttempts('new-user')).resolves.toBe(1);

    vi.stubGlobal('fetch', vi.fn(async () => json({ recorded: 1 })));
    await progress.flushAttemptOutbox();

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count('new-user')).toBe(0);
    expect(progress.cloudHistoryVersion).toBe(1);
  });
});
