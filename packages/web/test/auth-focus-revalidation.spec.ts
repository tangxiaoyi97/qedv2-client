import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { DEFAULT_CONFIG, STORAGE, type AuthSessionSnapshot } from '@qed2/core-logic';
import { authStore as authStorage, localProfileStore, storage } from '../src/services.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const account = {
  token: 'focus-account-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id: 'focus-account', username: 'ada' },
  serverBaseUrl: DEFAULT_CONFIG.serverBaseUrl,
};

function response() {
  return new Response(JSON.stringify(account), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('passive account revalidation', () => {
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
    await useAuthStore().init();
    const progress = useProgressStore();
    await progress.init();
    vi.spyOn(progress, 'reconcileOnLogin').mockResolvedValue(undefined);
    vi.spyOn(progress, 'flushAttemptOutbox').mockResolvedValue(undefined);
  });

  afterEach(() => {
    useProgressStore().cancelCloudRecovery();
    disposePinia(pinia);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not transition or reopen a profile when an idle guest regains focus', async () => {
    const auth = useAuthStore();
    const progress = useProgressStore();
    const activate = vi.spyOn(progress, 'activateGuestProfile');
    const pause = vi.spyOn(progress, 'pauseCloudRecovery');

    await auth.revalidateFromStorage();

    expect(auth.transitioning).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it.each(['login', 'redeem'] as const)('preserves a pending %s through repeated focus probes', async (action) => {
    const auth = useAuthStore();
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal('fetch', fetchMock);
    const pending = action === 'login'
      ? auth.login('ada', 'password123')
      : auth.redeem('QED-FOCUS-TEST', 'ada', 'password123');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    await auth.revalidateFromStorage();
    await auth.revalidateFromStorage();
    expect(auth.transitioning).toBe(true);
    gate.resolve(response());
    await expect(pending).resolves.toBeUndefined();

    expect(auth.isLoggedIn).toBe(true);
    expect(auth.session).toEqual(account);
    expect(await authStorage.getSession()).toEqual(account);
  });

  it('preserves login while its initial durable snapshot is still being read', async () => {
    const auth = useAuthStore();
    const snapshot = await authStorage.snapshot();
    const gate = deferred<AuthSessionSnapshot>();
    vi.spyOn(authStorage, 'snapshot').mockImplementationOnce(() => gate.promise);
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    const pending = auth.login('ada', 'password123');

    await auth.revalidateFromStorage();
    expect(auth.transitioning).toBe(true);
    gate.resolve(snapshot);
    await expect(pending).resolves.toBeUndefined();
    expect(auth.session).toEqual(account);
  });

  it('does not mistake its own committed session for an external login', async () => {
    const auth = useAuthStore();
    const committed = deferred<void>();
    const resume = deferred<void>();
    const write = authStorage.setSessionIfUnchanged.bind(authStorage);
    vi.spyOn(authStorage, 'setSessionIfUnchanged').mockImplementationOnce(async (...args) => {
      const result = await write(...args);
      committed.resolve();
      await resume.promise;
      return result;
    });
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    const pending = auth.login('ada', 'password123');
    await committed.promise;

    await auth.revalidateFromStorage();
    expect(auth.session).toBeUndefined();
    expect(auth.transitioning).toBe(true);
    resume.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(auth.session).toEqual(account);
  });

  it.each(['other-account', 'logout'] as const)(
    'still fences a pending login after an actual external %s',
    async (change) => {
      const auth = useAuthStore();
      const gate = deferred<Response>();
      const fetchMock = vi.fn(() => gate.promise);
      vi.stubGlobal('fetch', fetchMock);
      const pending = auth.login('ada', 'password123');
      const rejected = expect(pending).rejects.toThrow('superseded');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

      const external = {
        ...account,
        token: 'external-token',
        user: { id: 'external-account', username: 'lin' },
      };
      await authStorage.setSession(external);
      // Even missing → another account → missing is a new durable revision,
      // so the old login response cannot revive it after a remote logout.
      if (change === 'logout') await authStorage.clearSession();
      await auth.revalidateFromStorage();
      gate.resolve(response());
      await rejected;

      const expected = change === 'logout' ? undefined : external;
      expect(auth.session).toEqual(expected);
      expect(await authStorage.getSession()).toEqual(expected);
      expect(auth.transitioning).toBe(false);
    },
  );

  it('keeps an unchanged logged-in profile and cloud recovery active', async () => {
    const auth = useAuthStore();
    await authStorage.setSession(account);
    await auth.refreshFromStorage();
    const progress = useProgressStore();
    const activate = vi.spyOn(progress, 'activateProfileForAuth');
    const pause = vi.spyOn(progress, 'pauseCloudRecovery');

    await auth.revalidateFromStorage();

    expect(auth.isLoggedIn).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });
});
