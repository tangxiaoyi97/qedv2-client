import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import {
  accountStorageIdentity,
  ArchiveStore,
  DEFAULT_CONFIG,
  STORAGE,
  userLocalProfileId,
} from '@qed2/core-logic';
import { authStore as authStorage, localProfileStore, storage } from '../src/services.js';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

const account = {
  token: 'offline-account-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id: 'offline-account', username: 'ada' },
  serverBaseUrl: DEFAULT_CONFIG.serverBaseUrl,
};
const accountProfile = userLocalProfileId(accountStorageIdentity(account.serverBaseUrl, account.user.id));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('offline account startup and recovery', () => {
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pinia = createPinia();
    setActivePinia(pinia);
    for (const collection of [STORAGE.auth, STORAGE.archive, STORAGE.history, STORAGE.app, STORAGE.config]) {
      await storage.clear(collection);
    }
    await localProfileStore.initialize();
    useAppStore().online = false;
    await new ArchiveStore(storage, accountProfile).applyGrade({
      partId: 'offline-private-part',
      competencyCodes: [],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now: new Date('2026-08-07T08:00:00.000Z'),
    });
  });

  afterEach(() => {
    useProgressStore().cancelCloudRecovery();
    disposePinia(pinia);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function startWithExpiringSession() {
    const stored = { ...account, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await authStorage.setSession(stored);
    const auth = useAuthStore();
    await auth.init();
    useAppStore().online = true;
    return { auth, stored };
  }

  it.each(['2099-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z'])(
    'opens the isolated local account without HTTP when offline (expiry %s)',
    async (expiresAt) => {
      const stored = { ...account, expiresAt };
      await authStorage.setSession(stored);
      const fetchMock = vi.fn(async () => { throw new Error('offline'); });
      vi.stubGlobal('fetch', fetchMock);

      const auth = useAuthStore();
      await auth.init();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(auth.isLoggedIn).toBe(true);
      expect(auth.checking).toBe(false);
      expect(auth.transitioning).toBe(false);
      expect(auth.session).toEqual(stored);
      expect(await authStorage.getSession()).toEqual(stored);
      expect(localProfileStore.current()).toBe(accountProfile);
      expect(useProgressStore().archive.content.perPart).toEqual([
        expect.objectContaining({ partId: 'offline-private-part' }),
      ]);
    },
  );

  it('does not open a different Server account just because the app is offline', async () => {
    await authStorage.setSession({ ...account, serverBaseUrl: 'https://other-server.example' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const auth = useAuthStore();
    await auth.init();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.isLoggedIn).toBe(false);
    expect(await authStorage.getSession()).toBeUndefined();
    expect(localProfileStore.current()).toBe(localProfileStore.snapshot().guestProfileId);
    expect(useProgressStore().archive.content.perPart).toEqual([]);
  });

  it('skips recovery HTTP for a healthy token and refuses recovery while offline', async () => {
    await authStorage.setSession(account);
    const auth = useAuthStore();
    await auth.init();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await auth.refreshSessionForRecovery()).toBe(false);
    useAppStore().online = true;
    expect(await auth.refreshSessionForRecovery()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes once for concurrent retries while leaving the local account usable', async () => {
    const { auth } = await startWithExpiringSession();
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal('fetch', fetchMock);
    const first = auth.refreshSessionForRecovery();
    const second = auth.refreshSessionForRecovery();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    expect(auth.isLoggedIn).toBe(true);
    expect(auth.transitioning).toBe(false);
    expect(localProfileStore.current()).toBe(accountProfile);
    expect(fetchMock.mock.calls[0]).toEqual([
      `${account.serverBaseUrl}/auth/refresh`,
      expect.objectContaining({ headers: { Authorization: `Bearer ${account.token}` } }),
    ]);
    gate.resolve(response({ token: 'refreshed-token', expiresAt: account.expiresAt }));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(auth.session?.token).toBe('refreshed-token');
    expect(await authStorage.getSession()).toEqual({ ...account, token: 'refreshed-token' });
    expect(localProfileStore.current()).toBe(accountProfile);
  });

  it('does not treat its own token refresh as another window login during a focus probe', async () => {
    const { auth } = await startWithExpiringSession();
    const committed = deferred<void>();
    const resume = deferred<void>();
    const write = authStorage.setSessionIfUnchanged.bind(authStorage);
    vi.spyOn(authStorage, 'setSessionIfUnchanged').mockImplementationOnce(async (...args) => {
      const result = await write(...args);
      committed.resolve();
      await resume.promise;
      return result;
    });
    const cancel = vi.spyOn(useProgressStore(), 'cancelCloudRecovery');
    vi.stubGlobal('fetch', vi.fn(async () => response({
      token: 'focus-refresh-token', expiresAt: account.expiresAt,
    })));
    const pending = auth.refreshSessionForRecovery();
    await committed.promise;

    await auth.revalidateFromStorage();
    expect(auth.transitioning).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    resume.resolve();
    expect(await pending).toBe(true);
    expect(auth.session?.token).toBe('focus-refresh-token');
  });

  it('preserves the local profile and rebinds recovery after another window refreshes the same account', async () => {
    const { auth } = await startWithExpiringSession();
    const progress = useProgressStore();
    const activate = vi.spyOn(progress, 'activateProfileForAuth');
    const cancel = vi.spyOn(progress, 'cancelCloudRecovery');
    const rebind = vi.spyOn(progress, 'rebindCloudRecoverySession');
    const refreshed = { ...account, token: 'other-window-refresh-token' };
    await authStorage.setSession(refreshed);

    await auth.refreshFromStorage();

    expect(auth.session).toEqual(refreshed);
    expect(auth.transitioning).toBe(false);
    expect(activate).toHaveBeenCalledWith(accountStorageIdentity(account.serverBaseUrl, account.user.id), true);
    expect(cancel).not.toHaveBeenCalled();
    expect(rebind).toHaveBeenCalledWith(account.token);
    expect(localProfileStore.current()).toBe(accountProfile);
    expect(progress.archive.content.perPart).toEqual([
      expect.objectContaining({ partId: 'offline-private-part' }),
    ]);
  });

  it.each(['network', 'server'] as const)('retains local data after a %s failure and retries later', async (failure) => {
    const { auth, stored } = await startWithExpiringSession();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        if (failure === 'network') throw new Error('connection refused');
        return response({ error: { code: 'UNAVAILABLE', message: 'Try again' } }, 503);
      })
      .mockResolvedValueOnce(response({ token: 'retry-token', expiresAt: account.expiresAt }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await auth.refreshSessionForRecovery()).toBe(false);
    expect(auth.session).toEqual(stored);
    expect(await authStorage.getSession()).toEqual(stored);
    expect(localProfileStore.current()).toBe(accountProfile);
    expect(auth.transitioning).toBe(false);
    expect(await auth.refreshSessionForRecovery()).toBe(true);
    expect(auth.session?.token).toBe('retry-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('signs out a rejected token without deleting the account archive', async () => {
    const { auth } = await startWithExpiringSession();
    vi.stubGlobal('fetch', vi.fn(async () => response({
      error: { code: 'UNAUTHENTICATED', message: 'Token expired' },
    }, 401)));

    expect(await auth.refreshSessionForRecovery()).toBe(false);
    expect(auth.session).toBeUndefined();
    expect(await authStorage.getSession()).toBeUndefined();
    expect(auth.transitioning).toBe(false);
    expect(localProfileStore.current()).toBe(localProfileStore.snapshot().guestProfileId);
    expect(useProgressStore().archive.content.perPart).toEqual([]);
    expect((await new ArchiveStore(storage, accountProfile).load()).content.perPart).toEqual([
      expect.objectContaining({ partId: 'offline-private-part' }),
    ]);
  });

  it.each([200, 401])('does not overwrite another window account after a late HTTP %s refresh', async (status) => {
    const { auth } = await startWithExpiringSession();
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal('fetch', fetchMock);
    const pending = auth.refreshSessionForRecovery();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const external = {
      ...account,
      token: 'other-account-token',
      user: { id: 'other-account', username: 'lin' },
    };
    await authStorage.setSession(external);
    gate.resolve(status === 200
      ? response({ token: 'late-token', expiresAt: account.expiresAt })
      : response({ error: { code: 'UNAUTHENTICATED', message: 'Revoked' } }, 401));

    expect(await pending).toBe(false);
    expect(auth.session).toEqual(external);
    expect(await authStorage.getSession()).toEqual(external);
    expect(localProfileStore.current()).toBe(userLocalProfileId(
      accountStorageIdentity(account.serverBaseUrl, external.user.id),
    ));
  });

  it.each([200, 401])('preserves recovery when another window refreshed this account before HTTP %s arrived', async (status) => {
    const { auth } = await startWithExpiringSession();
    const progress = useProgressStore();
    const cancel = vi.spyOn(progress, 'cancelCloudRecovery');
    const rebind = vi.spyOn(progress, 'rebindCloudRecoverySession');
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal('fetch', fetchMock);
    const pending = auth.refreshSessionForRecovery();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const external = { ...account, token: 'newer-account-token' };
    await authStorage.setSession(external);
    gate.resolve(status === 200
      ? response({ token: 'late-token', expiresAt: account.expiresAt })
      : response({ error: { code: 'UNAUTHENTICATED', message: 'Revoked' } }, 401));

    expect(await pending).toBe(false);
    expect(auth.session).toEqual(external);
    expect(await authStorage.getSession()).toEqual(external);
    expect(cancel).not.toHaveBeenCalled();
    expect(rebind).toHaveBeenCalledWith(account.token);
    expect(localProfileStore.current()).toBe(accountProfile);
  });

  it('does not revive an account signed out while its refresh was in flight', async () => {
    const { auth } = await startWithExpiringSession();
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal('fetch', fetchMock);
    const pending = auth.refreshSessionForRecovery();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await authStorage.clearSession();
    await auth.refreshFromStorage();
    gate.resolve(response({ token: 'late-token', expiresAt: account.expiresAt }));

    expect(await pending).toBe(false);
    expect(auth.session).toBeUndefined();
    expect(await authStorage.getSession()).toBeUndefined();
    expect(localProfileStore.current()).toBe(localProfileStore.snapshot().guestProfileId);
  });
});
