import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { localProfileStore } from '../src/services.js';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useLeaderboardStore } from '../src/stores/leaderboard.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
const privateProfile = { participating: false, suggestedNickname: 'Tester' };
const publicProfile = { participating: true, profileId: 'public-1', nickname: 'Mira', createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z' };
function signIn(id = 'user-1') {
  const app = useAppStore();
  const auth = useAuthStore();
  auth.session = { token: `test-${id}`, expiresAt: '2099-01-01T00:00:00Z', user: { id, username: id }, serverBaseUrl: app.config.serverBaseUrl };
  app.setTokenProvider(() => auth.session?.token);
}
let pinia: ReturnType<typeof createPinia>;
beforeEach(async () => {
  // Real auth endpoint changes also switch the local profile. Match app boot
  // before exercising them, and do not leave that async transition in teardown.
  await localProfileStore.initialize();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(async () => {
  await vi.waitFor(() => expect(useAuthStore().transitioning).toBe(false));
  disposePinia(pinia);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('leaderboard profile request isolation', () => {
  it('coalesces simultaneous reads and clears loading on a recoverable failure', async () => {
    signIn();
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(json(privateProfile));
    vi.stubGlobal('fetch', fetch);
    const store = useLeaderboardStore();
    const first = store.refreshProfile();
    const second = store.refreshProfile();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.loadingProfile).toBe(true);
    pending.reject(new TypeError('offline'));
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(store.profile).toBeUndefined();
    expect(store.loadingProfile).toBe(false);
    expect(store.profileError).toBe('Die Teilnahme konnte nicht geladen werden.');
    expect(await store.refreshProfile()).toEqual(privateProfile);
    expect(store.profileError).toBe('');
  });

  it.each(['logout', 'switch-user', 'switch-server', 'clear'] as const)('does not publish a pending profile after %s', async (change) => {
    signIn();
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init) => { signal = init.signal; return pending.promise; }));
    const store = useLeaderboardStore();
    const loading = store.refreshProfile();
    if (change === 'logout') useAuthStore().session = undefined;
    else if (change === 'switch-user') signIn('user-2');
    else if (change === 'switch-server') useAppStore().config.serverBaseUrl = 'https://different.test';
    else store.clear();
    expect(signal?.aborted).toBe(true);
    pending.resolve(json(publicProfile));
    await loading;
    expect(store.profile).toBeUndefined();
    expect(store.loadingProfile).toBe(false);
    expect(store.profileError).toBe('');
  });

  it('does not let an old refresh overwrite a successful nickname change', async () => {
    signIn();
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((_url, init) => init.method === 'PUT'
      ? Promise.resolve(json(publicProfile)) : pending.promise));
    const store = useLeaderboardStore();
    const loading = store.refreshProfile();
    await store.saveNickname('Mira');
    pending.resolve(json(privateProfile));
    await loading;
    expect(store.profile).toEqual(publicProfile);
  });

  it.each(['save', 'leave'] as const)('does not publish a late %s result into a new account', async (action) => {
    signIn();
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const store = useLeaderboardStore();
    const operation = action === 'save' ? store.saveNickname('Mira') : store.leave();
    signIn('user-2');
    pending.resolve(json(action === 'save' ? publicProfile : { participating: false }));
    await operation;
    expect(store.profile).toBeUndefined();
  });

  it('sends no profile request or mutation without a signed-in user', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const store = useLeaderboardStore();
    expect(await store.refreshProfile()).toBeUndefined();
    await expect(store.saveNickname('Mira')).rejects.toThrow();
    await expect(store.leave()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('waits for an in-flight nickname save before refreshing its profile', async () => {
    signIn();
    const pending = deferred<Response>();
    const fetch = vi.fn((_url, init) => init.method === 'PUT' ? pending.promise : Promise.resolve(json(publicProfile)));
    vi.stubGlobal('fetch', fetch);
    const store = useLeaderboardStore();
    const saving = store.saveNickname('Mira');
    const refreshing = store.refreshProfile();
    const secondRefresh = store.refreshProfile();
    expect(fetch).toHaveBeenCalledTimes(1);
    pending.resolve(json(publicProfile));
    await saving;
    expect(await refreshing).toEqual(publicProfile);
    expect(await secondRefresh).toEqual(publicProfile);
    expect(store.profile).toEqual(publicProfile);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['token-refresh', 'clear', 'switch-away-and-back'] as const)(
    'keeps same-account writes serialized across %s', async (change) => {
      signIn();
      const pending = deferred<Response>();
      const fetch = vi.fn((_url, init) => init.method === 'PUT' ? pending.promise : Promise.resolve(json(publicProfile)));
      vi.stubGlobal('fetch', fetch);
      const store = useLeaderboardStore();
      const saving = store.saveNickname('Mira');
      if (change === 'token-refresh') useAuthStore().session!.token = 'refreshed-token';
      else if (change === 'clear') store.clear();
      else { signIn('user-2'); signIn(); }
      await expect(store.leave()).rejects.toThrow();
      const refreshing = store.refreshProfile();
      expect(fetch).toHaveBeenCalledTimes(1);
      pending.resolve(json(publicProfile));
      await saving;
      expect(await refreshing).toEqual(publicProfile);
      await store.leave();
      expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual(['PUT', 'GET', 'DELETE']);
      expect(store.profile?.participating).toBe(false);
    },
  );

  it('allows another account to leave without waiting for the previous owner\'s pending save', async () => {
    signIn();
    const pending = deferred<Response>();
    const fetch = vi.fn((_url, init) => init.method === 'PUT' ? pending.promise : Promise.resolve(json({ participating: false })));
    vi.stubGlobal('fetch', fetch);
    const store = useLeaderboardStore();
    const saving = store.saveNickname('Mira');
    signIn('user-2');
    await store.leave();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.profile?.participating).toBe(false);
    pending.resolve(json(publicProfile));
    await saving;
    expect(store.profile?.participating).toBe(false);
  });
});
