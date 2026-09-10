import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { accountStorageIdentity, type LeaderboardProfile, type LeaderboardResponse } from '@qed2/core-logic';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';

interface ListScope { owner: string; token: string; revision: number }

export const useLeaderboardStore = defineStore('leaderboard', () => {
  const profile = ref<LeaderboardProfile | undefined>();
  const loadingProfile = ref(false);
  const profileError = ref('');
  const auth = useAuthStore();
  const app = useAppStore();
  let generation = 0;
  let controller: AbortController | undefined;
  let refresh: Promise<LeaderboardProfile | undefined> | undefined;
  const mutations = new Map<string, Promise<void>>();
  // One short-lived first page avoids replacing a warm route with a loader.
  // It is never persisted or shared across authentication scopes.
  let listSnapshot: { owner: string; token: string; savedAt: number; response: LeaderboardResponse } | undefined;
  let listRevision = 0;
  const listMutationRevision = ref(0);

  async function waitForListMutation(): Promise<boolean> {
    const owner = currentOwner();
    const token = auth.session?.token;
    if (!owner || !token) return false;
    let pending: Promise<void> | undefined;
    while ((pending = mutations.get(owner))) {
      // A failed write can also have reached the server; reread afterwards.
      await pending.catch(() => undefined);
      if (currentOwner() !== owner || auth.session?.token !== token) return false;
    }
    return currentOwner() === owner && auth.session?.token === token;
  }

  function captureListScope(): ListScope | undefined {
    const owner = currentOwner();
    const token = auth.session?.token;
    return owner && token && !mutations.has(owner) ? { owner, token, revision: listRevision } : undefined;
  }

  function cachedList(): LeaderboardResponse | undefined {
    if (!listSnapshot || listSnapshot.owner !== currentOwner() || listSnapshot.token !== auth.session?.token
      || Date.now() - listSnapshot.savedAt >= 60_000) return undefined;
    return listSnapshot.response;
  }

  function rememberList(response: LeaderboardResponse, scope: ListScope): void {
    if (scope.revision !== listRevision || scope.owner !== currentOwner()
      || mutations.has(scope.owner) || scope.token !== auth.session?.token || response.page !== 1) return;
    listSnapshot = { owner: scope.owner, token: scope.token, savedAt: Date.now(), response: { ...response, items: [...response.items] } };
  }

  function currentOwner(): string | undefined {
    const session = auth.session;
    return auth.isLoggedIn && session
      ? accountStorageIdentity(app.config.serverBaseUrl, session.user.id)
      : undefined;
  }

  function clear(): void {
    generation += 1;
    controller?.abort();
    controller = undefined;
    refresh = undefined;
    loadingProfile.value = false;
    profile.value = undefined;
    profileError.value = '';
    listSnapshot = undefined;
    listRevision += 1;
    // Clearing displayed data cannot cancel an already sent write. Keep its
    // owner lock until it settles, even across token refreshes or sign-out.
  }

  // A different user/token/origin must never inherit a late public profile.
  watch(() => [auth.session?.user.id, auth.session?.token, app.config.serverBaseUrl, auth.isLoggedIn], clear, { flush: 'sync' });

  function refreshProfile(): Promise<LeaderboardProfile | undefined> {
    const owner = currentOwner();
    if (!owner) {
      clear();
      return Promise.resolve(undefined);
    }
    if (refresh) return refresh;
    const pending = mutations.get(owner);
    if (pending) {
      const request = generation;
      loadingProfile.value = true;
      profileError.value = '';
      const afterMutation = () => {
        if (currentOwner() !== owner) return undefined;
        // Another waiter may already have started this owner's fresh read.
        if (refresh) return refresh;
        return request === generation ? refreshProfile() : undefined;
      };
      return pending.then(afterMutation, afterMutation);
    }
    const request = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    loadingProfile.value = true;
    profileError.value = '';
    refresh = app.serverClient.getLeaderboardProfile({ signal }).then((next) => {
      if (request !== generation) return undefined;
      profile.value = next;
      return next;
    }).catch(() => {
      if (request === generation) profileError.value = 'Die Teilnahme konnte nicht geladen werden.';
      return undefined;
    }).finally(() => {
      if (request === generation) {
        loadingProfile.value = false;
        refresh = undefined;
        controller = undefined;
      }
    });
    return refresh;
  }

  function beginMutation(): { request: number; owner: string } {
    const owner = currentOwner();
    if (!owner) throw new Error('Bitte melde dich erneut an.');
    if (mutations.has(owner)) throw new Error('Eine Änderung wird bereits gespeichert.');
    listSnapshot = undefined;
    listRevision += 1;
    generation += 1;
    controller?.abort();
    controller = undefined;
    refresh = undefined;
    loadingProfile.value = false;
    return { request: generation, owner };
  }

  function trackMutation(owner: string, operation: Promise<void>): Promise<void> {
    const pending = operation.finally(() => {
      if (mutations.get(owner) === pending) {
        mutations.delete(owner);
        if (currentOwner() === owner) {
          listSnapshot = undefined;
          listRevision += 1;
          listMutationRevision.value += 1;
        }
      }
    });
    mutations.set(owner, pending);
    return pending;
  }

  async function saveNickname(nickname: string): Promise<void> {
    const { request, owner } = beginMutation();
    await trackMutation(owner, app.serverClient.saveLeaderboardProfile(nickname).then((next) => {
      if (request !== generation) return;
      profile.value = next;
      profileError.value = '';
    }));
  }

  async function leave(): Promise<void> {
    const { request, owner } = beginMutation();
    await trackMutation(owner, app.serverClient.leaveLeaderboard().then(() => {
      if (request !== generation) return;
      profile.value = {
        participating: false,
        suggestedNickname: auth.username ?? '',
      };
      profileError.value = '';
    }));
  }

  return {
    profile, loadingProfile, profileError, refreshProfile, saveNickname, leave, clear,
    cachedList, captureListScope, rememberList, waitForListMutation, listMutationRevision,
  };
});
