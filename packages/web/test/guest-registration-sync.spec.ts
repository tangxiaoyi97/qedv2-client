import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  accountStorageIdentity,
  ArchiveStore,
  DEFAULT_CONFIG,
  GUEST_ATTEMPT_OWNER,
  REGISTRATION_INTENT_STORAGE_KEY,
  RegistrationIntentConflictError,
  STORAGE,
  userLocalProfileId,
} from '@qed2/core-logic';
import {
  archiveStore,
  attemptOutbox,
  authStore as authStorage,
  localProfileStore,
  registrationJournal,
  storage,
} from '../src/services.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useAppStore } from '../src/stores/app.js';
import { useProgressStore } from '../src/stores/progress.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const officialOwner = (userId: string): string =>
  accountStorageIdentity(DEFAULT_CONFIG.serverBaseUrl, userId);

describe('guest registration reconciliation', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
    await storage.clear(STORAGE.auth);
    await storage.clear(STORAGE.archive);
    await storage.clear(STORAGE.history);
    await storage.clear(STORAGE.app);
    await storage.clear(STORAGE.config);
    await localProfileStore.initialize();
  });

  it('uploads the guest archive and audit attempts after invite redemption', async () => {
    await archiveStore.applyGrade({
      partId: 'guest-part',
      competencyCodes: ['AG 1.1'],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now: new Date('2026-08-07T08:00:00.000Z'),
    });

    const auth = useAuthStore();
    await auth.init();
    const progress = useProgressStore();
    await progress.init();
    const guestAttempt = {
      clientAttemptId: 'guest-attempt-before-registration',
      questionId: 'guest-question',
      partId: 'guest-part',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-07T08:00:00.000Z',
    };
    await progress.queueAttempt(guestAttempt);

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/auth/redeem')) {
        return json({
          token: 'new-account-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { id: 'new-account', username: 'ada' },
        });
      }
      if (url.endsWith('/me/state')) {
        return json({
          archiveVersion: 0,
          checksum: 'empty',
          perPart: [],
          perCompetency: [],
        });
      }
      if (url.endsWith('/me/sync')) {
        const body = JSON.parse(String(init?.body));
        expect(body.localArchive.perPart).toEqual([
          expect.objectContaining({ partId: 'guest-part' }),
        ]);
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer new-account-token' });
        return json({ result: 'fast-forward', archiveVersion: 1, checksum: 'server-archive' });
      }
      if (url.endsWith('/me/attempts')) {
        expect(JSON.parse(String(init?.body))).toEqual({ attempts: [guestAttempt] });
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer new-account-token' });
        return json({ recorded: 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await auth.redeem('QED2-INVITE', 'ada', 'password123');

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/auth/redeem',
      '/me/state',
      '/me/sync',
      '/me/attempts',
    ]);
    expect(progress.archive.baseVersion).toBe(1);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count(officialOwner('new-account'))).toBe(0);
    expect(progress.cloudHistoryVersion).toBe(1);
  });

  it('does not claim guest attempts during an ordinary login', async () => {
    const auth = useAuthStore();
    await auth.init();
    const progress = useProgressStore();
    await progress.init();
    await archiveStore.applyGrade({
      partId: 'private-guest-part',
      competencyCodes: [],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now: new Date('2026-08-07T08:30:00.000Z'),
    });
    await progress.refresh();
    await progress.queueAttempt({
      clientAttemptId: 'shared-device-guest-attempt',
      questionId: 'q1',
      partId: 'q1-a',
      correct: false,
      awardedPoints: 0,
      gradedAt: '2026-08-07T09:00:00.000Z',
    });
    await progress.beginGuestAttemptClaim(officialOwner('invite-created-account'));

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) {
        return json({
          token: 'existing-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { id: 'existing-account', username: 'lin' },
        });
      }
      if (url.endsWith('/me/state')) {
        return json({ archiveVersion: 0, checksum: 'empty', perPart: [], perCompetency: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await auth.login('lin', 'password123');

    expect(progress.archive.content.perPart).toEqual([]);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
    expect(await attemptOutbox.count('existing-account')).toBe(0);
    expect(await attemptOutbox.pendingGuestClaim()).toBe(officialOwner('invite-created-account'));
    await progress.activateGuestProfile();
    expect(progress.archive.content.perPart).toEqual([]);
    expect((await new ArchiveStore(
      storage,
      userLocalProfileId(officialOwner('invite-created-account')),
    ).load()).content.perPart).toEqual([
      expect.objectContaining({ partId: 'private-guest-part' }),
    ]);
    expect((await new ArchiveStore(
      storage,
      userLocalProfileId(officialOwner('existing-account')),
    ).load()).content.perPart).toEqual([]);
  });

  it('does not retain a boot-preselected account after another window signs out', async () => {
    await localProfileStore.activateUser('boot-user');
    const userArchive = new ArchiveStore(storage, userLocalProfileId('boot-user'));
    await userArchive.applyGrade({
      partId: 'boot-user-private-part',
      competencyCodes: [],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now: new Date('2026-08-07T08:45:00.000Z'),
    });
    // Models main.ts having selected boot-user from its earlier auth read,
    // followed by another window clearing auth before auth.init() reads it.
    await authStorage.clearSession();

    setActivePinia(createPinia());
    const auth = useAuthStore();
    await auth.init();

    expect(auth.session).toBeUndefined();
    expect(localProfileStore.currentIfInitialized()).not.toBe(userLocalProfileId('boot-user'));
    expect(useProgressStore().archive.content.perPart).toEqual([]);
    expect((await userArchive.load()).content.perPart).toEqual([
      expect.objectContaining({ partId: 'boot-user-private-part' }),
    ]);
  });

  it('never sends an issuer-less 2.1 bearer to the currently configured Server', async () => {
    await authStorage.setSession({
      token: 'unscoped-legacy-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'legacy-user', username: 'legacy' },
    });
    const fetchMock = vi.fn(() => Promise.reject(new Error('must not be called')));
    vi.stubGlobal('fetch', fetchMock);

    const auth = useAuthStore();
    await auth.init();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.session).toBeUndefined();
    expect(await authStorage.getSession()).toBeUndefined();
    expect(localProfileStore.current()).toBe(localProfileStore.snapshot().guestProfileId);
  });

  it('clears a malformed persisted session without exposing a token or account profile', async () => {
    await storage.set(STORAGE.auth, 'session', {
      token: 'must-never-leave-this-device',
      expiresAt: '2099-01-01T00:00:00.000Z',
      serverBaseUrl: DEFAULT_CONFIG.serverBaseUrl,
      user: {},
    });
    const fetchMock = vi.fn(() => Promise.reject(new Error('must not be called')));
    vi.stubGlobal('fetch', fetchMock);

    const auth = useAuthStore();
    await expect(auth.init()).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.session).toBeUndefined();
    expect(await storage.get(STORAGE.auth, 'session')).toBeUndefined();
    expect(localProfileStore.current()).toBe(localProfileStore.snapshot().guestProfileId);
  });

  it('signs out before an endpoint change and isolates identical remote user ids', async () => {
    const serverA = 'https://server-a.example';
    const serverB = 'https://server-b.example';
    const ownerA = accountStorageIdentity(serverA, 'same-user');
    const ownerB = accountStorageIdentity(serverB, 'same-user');
    const app = useAppStore();
    app.config = { ...app.config, serverBaseUrl: serverA };
    const auth = useAuthStore();
    await auth.init();
    const progress = useProgressStore();
    await progress.init();

    const calls: Array<{ url: string; authorization?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get('Authorization') ?? undefined });
      if (url === `${serverA}/auth/login`) {
        return json({
          token: 'token-a',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { id: 'same-user', username: 'same' },
        });
      }
      if (url === `${serverB}/auth/login`) {
        return json({
          token: 'token-b',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { id: 'same-user', username: 'same' },
        });
      }
      if (url.endsWith('/me/state')) {
        return json({ archiveVersion: 0, checksum: 'empty', perPart: [], perCompetency: [] });
      }
      if (url.endsWith('/content/info') || url.endsWith('/info')) {
        return json({});
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await auth.login('same', 'password123');
    const archiveA = new ArchiveStore(storage, userLocalProfileId(ownerA));
    await archiveA.applyGrade({
      partId: 'server-a-private-part',
      competencyCodes: [],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now: new Date('2026-08-07T11:00:00.000Z'),
    });
    await attemptOutbox.enqueue(ownerA, {
      clientAttemptId: 'server-a-private-attempt',
      questionId: 'qa',
      partId: 'qa-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-07T11:00:00.000Z',
    });

    await app.updateConfig({ serverBaseUrl: serverB });
    expect(auth.session).toBeUndefined();
    expect(calls.filter((call) => call.url.startsWith(serverB)))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ authorization: 'Bearer token-a' })]));

    await auth.login('same', 'password123');
    expect(localProfileStore.current()).toBe(userLocalProfileId(ownerB));
    expect(progress.archive.content.perPart).toEqual([]);
    expect(await attemptOutbox.count(ownerB)).toBe(0);
    expect(await attemptOutbox.count(ownerA)).toBe(1);
    expect((await archiveA.load()).content.perPart).toEqual([
      expect.objectContaining({ partId: 'server-a-private-part' }),
    ]);
    expect(calls.filter((call) => call.url.startsWith(serverB) && call.authorization))
      .toEqual(expect.arrayContaining([expect.objectContaining({ authorization: 'Bearer token-b' })]));
    expect(calls.some((call) => call.url.startsWith(serverB) && call.authorization === 'Bearer token-a'))
      .toBe(false);
  });

  it('recovers a persisted invite claim after a crash between session and claim', async () => {
    const progress = useProgressStore();
    await progress.init();
    await archiveStore.applyGrade({
      partId: 'crash-window-part',
      competencyCodes: [],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now: new Date('2026-08-07T09:55:00.000Z'),
    });
    await progress.refresh();
    await progress.queueAttempt({
      clientAttemptId: 'crash-window-attempt',
      questionId: 'q-crash',
      partId: 'q-crash-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-07T10:00:00.000Z',
    });
    await progress.beginGuestAttemptClaim(officialOwner('new-account'));
    await authStorage.setSession({
      token: 'persisted-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'new-account', username: 'ada' },
      serverBaseUrl: DEFAULT_CONFIG.serverBaseUrl,
    });

    // New Pinia models a renderer restart after the session write but before
    // the guest outbox was claimed.
    setActivePinia(createPinia());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/auth/me');
      return json({ id: 'new-account', username: 'ada' });
    }));

    const restartedAuth = useAuthStore();
    await restartedAuth.init();

    expect(restartedAuth.session?.user.id).toBe('new-account');
    expect(useProgressStore().archive.content.perPart).toEqual([
      expect.objectContaining({ partId: 'crash-window-part' }),
    ]);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count(officialOwner('new-account'))).toBe(1);
    expect(await attemptOutbox.pendingGuestClaim()).toBeUndefined();
  });

  it('recovers only a matching persisted invite claim during a later login', async () => {
    const auth = useAuthStore();
    await auth.init();
    const progress = useProgressStore();
    await progress.init();
    const attempt = {
      clientAttemptId: 'login-recovery-attempt',
      questionId: 'q-login-recovery',
      partId: 'q-login-recovery-a',
      correct: false,
      awardedPoints: 0,
      gradedAt: '2026-08-07T10:30:00.000Z',
    };
    await progress.queueAttempt(attempt);
    await progress.beginGuestAttemptClaim(officialOwner('matching-account'));

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) {
        return json({
          token: 'matching-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { id: 'matching-account', username: 'ada' },
        });
      }
      if (url.endsWith('/me/state')) {
        return json({ archiveVersion: 0, checksum: 'empty', perPart: [], perCompetency: [] });
      }
      if (url.endsWith('/me/attempts')) {
        expect(JSON.parse(String(init?.body))).toEqual({ attempts: [attempt] });
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer matching-token' });
        return json({ recorded: 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await auth.login('ada', 'password123');

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count(officialOwner('matching-account'))).toBe(0);
    expect(await attemptOutbox.pendingGuestClaim()).toBeUndefined();
  });

  it.each(['endpoint', 'logout'] as const)(
    'discards a slow login response after a concurrent %s change',
    async (supersedingAction) => {
      const serverA = 'https://server-a.example';
      const serverB = 'https://server-b.example';
      const app = useAppStore();
      app.config = { ...app.config, serverBaseUrl: serverA };
      const auth = useAuthStore();
      await auth.init();
      const progress = useProgressStore();
      await progress.init();
      vi.spyOn(progress, 'flushAttemptOutbox').mockResolvedValue(undefined);
      vi.spyOn(progress, 'syncNow').mockResolvedValue('guest');

      const loginResponse = deferred<Response>();
      const requests: Array<{ url: string; authorization: string | null }> = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        if (url === `${serverA}/auth/login`) return loginResponse.promise;
        if (url === `${serverB}/me/state`) {
          return json({ archiveVersion: 0, checksum: 'empty', perPart: [], perCompetency: [] });
        }
        if (url.endsWith('/content/info') || url.endsWith('/info')) return json({});
        throw new Error(`Unexpected request: ${url}`);
      }));

      const slowLogin = auth.login('ada', 'password123');
      await vi.waitFor(() => {
        expect(requests.some((request) => request.url === `${serverA}/auth/login`)).toBe(true);
      });
      if (supersedingAction === 'endpoint') {
        await app.updateConfig({ serverBaseUrl: serverB });
        await app.serverClient.getState();
      } else {
        await auth.logout();
      }
      loginResponse.resolve(json({
        token: 'late-token-a',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: { id: 'late-a', username: 'ada' },
      }));

      await expect(slowLogin).rejects.toThrow('superseded');
      expect(auth.session).toBeUndefined();
      expect(await authStorage.getSession()).toBeUndefined();
      expect(localProfileStore.current()).toBe(localProfileStore.snapshot().guestProfileId);
      expect(requests.some((request) =>
        request.url.startsWith(serverB)
        && request.authorization === 'Bearer late-token-a',
      )).toBe(false);
    },
  );

  it.each(['endpoint', 'logout'] as const)(
    'does not revive a refreshing account after a concurrent %s change',
    async (supersedingAction) => {
      const serverA = 'https://server-a.example';
      const serverB = 'https://server-b.example';
      const app = useAppStore();
      app.config = { ...app.config, serverBaseUrl: serverA };
      await authStorage.setSession({
        token: 'old-token-a',
        expiresAt: '2026-08-15T00:01:00.000Z',
        user: { id: 'refresh-a', username: 'ada' },
        serverBaseUrl: serverA,
      });
      const auth = useAuthStore();
      const progress = useProgressStore();
      vi.spyOn(progress, 'flushAttemptOutbox').mockResolvedValue(undefined);
      vi.spyOn(progress, 'syncNow').mockResolvedValue('guest');

      const refreshResponse = deferred<Response>();
      const requests: Array<{ url: string; authorization: string | null }> = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        if (url === `${serverA}/auth/refresh`) return refreshResponse.promise;
        if (url === `${serverB}/me/state`) {
          return json({ archiveVersion: 0, checksum: 'empty', perPart: [], perCompetency: [] });
        }
        if (url.endsWith('/content/info') || url.endsWith('/info')) return json({});
        throw new Error(`Unexpected request: ${url}`);
      }));

      const initialization = auth.init();
      await vi.waitFor(() => {
        expect(requests.some((request) => request.url === `${serverA}/auth/refresh`)).toBe(true);
      });
      if (supersedingAction === 'endpoint') {
        await app.updateConfig({ serverBaseUrl: serverB });
        await app.serverClient.getState();
      } else {
        await auth.logout();
      }
      refreshResponse.resolve(json({
        token: 'refreshed-token-a',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }));
      await expect(initialization).resolves.toBeUndefined();

      expect(auth.session).toBeUndefined();
      expect(await authStorage.getSession()).toBeUndefined();
      expect(localProfileStore.current()).toBe(localProfileStore.snapshot().guestProfileId);
      expect(requests.some((request) =>
        request.url.startsWith(serverB)
        && request.authorization === 'Bearer old-token-a',
      )).toBe(false);
      expect(requests.some((request) =>
        request.url.startsWith(serverB)
        && request.authorization === 'Bearer refreshed-token-a',
      )).toBe(false);
    },
  );

  it('rolls back a login when durable auth storage rejects the session', async () => {
    const auth = useAuthStore();
    await auth.init();
    const guestProfile = localProfileStore.current();
    vi.spyOn(authStorage, 'setSessionIfUnchanged').mockRejectedValueOnce(
      new Error('simulated safeStorage failure'),
    );
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/auth/login');
      return json({
        token: 'must-not-publish',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: { id: 'storage-failure-user', username: 'ada' },
      });
    }));

    await expect(auth.login('ada', 'password123')).rejects.toThrow('safeStorage failure');

    expect(auth.session).toBeUndefined();
    expect(auth.transitioning).toBe(false);
    expect(localProfileStore.current()).toBe(guestProfile);
    expect(await authStorage.getSession()).toBeUndefined();
  });

  it('keeps the account transition locked when a committed session cannot be re-read', async () => {
    const auth = useAuthStore();
    await auth.init();
    const guestProfile = localProfileStore.current();
    const snapshot = authStorage.snapshot.bind(authStorage);
    let snapshotCalls = 0;
    vi.spyOn(authStorage, 'snapshot').mockImplementation(async () => {
      snapshotCalls += 1;
      if (snapshotCalls === 2) throw new Error('simulated post-commit read failure');
      return snapshot();
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/auth/login');
      return json({
        token: 'committed-but-unverified-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: { id: 'unverified-user', username: 'ada' },
      });
    }));

    await expect(auth.login('ada', 'password123')).rejects.toThrow('post-commit read failure');

    expect(auth.session).toBeUndefined();
    expect(auth.transitioning).toBe(true);
    expect(auth.transitionError).toBe(true);
    expect(auth.checking).toBe(false);
    expect(localProfileStore.current()).toBe(guestProfile);
    expect((await authStorage.getSession())?.token).toBe('committed-but-unverified-token');
  });

  it('rolls durable auth back when the account profile cannot be activated', async () => {
    const auth = useAuthStore();
    await auth.init();
    const progress = useProgressStore();
    await progress.init();
    const guestProfile = localProfileStore.current();
    vi.spyOn(progress, 'activateProfileForAuth').mockRejectedValueOnce(
      new Error('simulated profile activation failure'),
    );
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/auth/login');
      return json({
        token: 'profile-failure-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: { id: 'profile-failure-user', username: 'ada' },
      });
    }));

    await expect(auth.login('ada', 'password123')).rejects.toThrow('profile activation failure');

    expect(auth.session).toBeUndefined();
    expect(auth.transitioning).toBe(false);
    expect(localProfileStore.current()).toBe(guestProfile);
    expect(await authStorage.getSession()).toBeUndefined();
  });

  it('restores the account/profile pair when logout cannot clear durable auth', async () => {
    const session = {
      token: 'durable-account-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'durable-account', username: 'ada' },
      serverBaseUrl: DEFAULT_CONFIG.serverBaseUrl,
    };
    const owner = officialOwner(session.user.id);
    await authStorage.setSession(session);
    await localProfileStore.activateUser(owner);
    const auth = useAuthStore();
    auth.session = session;
    const progress = useProgressStore();
    await progress.init();
    vi.spyOn(progress, 'flushAttemptOutbox').mockResolvedValue(undefined);
    vi.spyOn(progress, 'syncNow').mockResolvedValue('synced');
    vi.spyOn(authStorage, 'clearSessionIfUnchanged').mockRejectedValueOnce(
      new Error('simulated clear failure'),
    );

    await expect(auth.logout()).rejects.toThrow('simulated clear failure');

    expect(auth.session).toEqual(session);
    expect(auth.transitioning).toBe(false);
    expect(localProfileStore.current()).toBe(userLocalProfileId(owner));
    expect(await authStorage.getSession()).toEqual(session);
  });

  it('finishes a persisted registration intent from another renderer refresh', async () => {
    const firstProgress = useProgressStore();
    await firstProgress.init();
    await archiveStore.applyGrade({
      partId: 'renderer-claim-part',
      competencyCodes: [],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now: new Date('2026-08-15T12:00:00.000Z'),
    });
    await firstProgress.refresh();
    await firstProgress.queueAttempt({
      clientAttemptId: 'renderer-claim-attempt',
      questionId: 'renderer-question',
      partId: 'renderer-claim-part',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-15T12:00:00.000Z',
    });
    const intent = await firstProgress.reserveInviteRegistration(
      DEFAULT_CONFIG.serverBaseUrl,
      'QED2-INVITE',
      'Ada',
    );
    await registrationJournal.markRedeemed(intent.clientMutationId, 'renderer-account');
    expect((await new ArchiveStore(storage, intent.sourceProfileId).load()).content.perPart)
      .toEqual([expect.objectContaining({ partId: 'renderer-claim-part' })]);

    // A second renderer has already booted as guest. The first renderer then
    // commits only the session and crashes before moving local ownership.
    setActivePinia(createPinia());
    const secondAuth = useAuthStore();
    await secondAuth.init();
    await authStorage.setSession({
      token: 'persisted-registration-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'renderer-account', username: 'ada' },
      serverBaseUrl: DEFAULT_CONFIG.serverBaseUrl,
    });
    await secondAuth.refreshFromStorage();

    const owner = officialOwner('renderer-account');
    expect(secondAuth.session?.user.id).toBe('renderer-account');
    expect(localProfileStore.current()).toBe(userLocalProfileId(owner));
    expect((await new ArchiveStore(storage, userLocalProfileId(owner)).load()).content.perPart)
      .toEqual([expect.objectContaining({ partId: 'renderer-claim-part' })]);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count(owner)).toBe(1);
    expect(await attemptOutbox.pendingGuestClaim()).toBeUndefined();
    expect(await storage.get(STORAGE.app, REGISTRATION_INTENT_STORAGE_KEY)).toBeUndefined();
    expect(intent.clientMutationId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('preserves a redeemed marker when another renderer reserves a different username', async () => {
    const piniaA = createPinia();
    setActivePinia(piniaA);
    const authA = useAuthStore();
    await authA.init();
    const progressA = useProgressStore();
    await progressA.init();
    await archiveStore.applyGrade({
      partId: 'renderer-a-redeemed-part',
      competencyCodes: [],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now: new Date('2026-08-15T13:00:00.000Z'),
    });
    await progressA.refresh();
    const sourceProfile = localProfileStore.current();

    const marked = deferred<void>();
    const releaseMarked = deferred<void>();
    const markRedeemed = registrationJournal.markRedeemed.bind(registrationJournal);
    vi.spyOn(registrationJournal, 'markRedeemed').mockImplementation(async (...args) => {
      const intent = await markRedeemed(...args);
      marked.resolve(undefined);
      await releaseMarked.promise;
      return intent;
    });
    let rendererBRedeemCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/redeem')) {
        const body = JSON.parse(String(init?.body)) as { username: string };
        if (body.username === 'ada') {
          return json({
            token: 'renderer-a-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
            user: { id: 'renderer-a-account', username: 'ada' },
          });
        }
        rendererBRedeemCalls += 1;
        return new Response(JSON.stringify({
          error: { code: 'INVITE_INVALID', message: 'renderer B must not reach the Server' },
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/me/state')) {
        return json({ archiveVersion: 0, checksum: 'empty', perPart: [], perCompetency: [] });
      }
      if (url.endsWith('/me/sync')) {
        return json({ result: 'fast-forward', archiveVersion: 1, checksum: 'renderer-a-archive' });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const rendererA = authA.redeem('QED2-A', 'ada', 'password123');
    await marked.promise;
    const redeemed = await registrationJournal.pending();
    expect(redeemed).toMatchObject({
      status: 'redeemed',
      usernameKey: 'ada',
      destinationUserId: 'renderer-a-account',
      sourceProfileId: sourceProfile,
    });

    const piniaB = createPinia();
    setActivePinia(piniaB);
    const authB = useAuthStore();
    const rendererBError = await authB.redeem('QED2-B', 'bea', 'password123').then(
      () => undefined,
      (error: unknown) => error,
    );
    const markerAfterB = await registrationJournal.pending();

    setActivePinia(piniaA);
    releaseMarked.resolve(undefined);
    const rendererAError = await rendererA.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rendererBError).toBeInstanceOf(RegistrationIntentConflictError);
    expect(rendererBRedeemCalls).toBe(0);
    expect(markerAfterB).toEqual(redeemed);
    expect(rendererAError).toBeUndefined();
    const ownerA = officialOwner('renderer-a-account');
    expect(authA.session?.user.id).toBe('renderer-a-account');
    expect(localProfileStore.current()).toBe(userLocalProfileId(ownerA));
    expect((await new ArchiveStore(storage, userLocalProfileId(ownerA)).load()).content.perPart)
      .toEqual([expect.objectContaining({ partId: 'renderer-a-redeemed-part' })]);
    expect(await registrationJournal.pending()).toBeUndefined();
  });

  it.each([
    { code: 'INVITE_INVALID', status: 400 },
    { code: 'USERNAME_TAKEN', status: 409 },
  ])(
    'clears a rejected $code reservation so a later ordinary login cannot claim the guest',
    async ({ code, status }) => {
      const auth = useAuthStore();
      await auth.init();
      const progress = useProgressStore();
      await progress.init();
      const guestProfile = localProfileStore.current();
      await archiveStore.applyGrade({
        partId: `rejected-${code.toLowerCase()}-part`,
        competencyCodes: [],
        verdict: 'correct',
        awardedPoints: 1,
        maxPoints: 1,
        now: new Date('2026-08-15T12:30:00.000Z'),
      });
      await progress.refresh();
      await progress.queueAttempt({
        clientAttemptId: `rejected-${code.toLowerCase()}-attempt`,
        questionId: 'rejected-registration-question',
        partId: `rejected-${code.toLowerCase()}-part`,
        correct: true,
        awardedPoints: 1,
        gradedAt: '2026-08-15T12:30:00.000Z',
      });

      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/redeem')) {
          return new Response(JSON.stringify({
            error: { code, message: 'registration rejected' },
          }), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/auth/login')) {
          return json({
            token: 'ordinary-login-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
            user: { id: 'ordinary-existing-account', username: 'ada' },
          });
        }
        if (url.endsWith('/me/state')) {
          return json({ archiveVersion: 0, checksum: 'empty', perPart: [], perCompetency: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }));

      await expect(auth.redeem('QED2-REJECTED', 'ada', 'password123'))
        .rejects.toMatchObject({ code });
      expect(await registrationJournal.pending()).toBeUndefined();
      expect(localProfileStore.current()).toBe(guestProfile);
      expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);

      await auth.login('ada', 'password123');

      const owner = officialOwner('ordinary-existing-account');
      expect(localProfileStore.current()).toBe(userLocalProfileId(owner));
      expect(progress.archive.content.perPart).toEqual([]);
      expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
      expect(await attemptOutbox.count(owner)).toBe(0);
      expect((await new ArchiveStore(storage, guestProfile).load()).content.perPart)
        .toEqual([expect.objectContaining({ partId: `rejected-${code.toLowerCase()}-part` })]);
    },
  );
});
