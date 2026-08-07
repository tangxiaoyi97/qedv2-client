/**
 * Auth store. Contract hard rules honored here:
 *  - login merges local progress into the account via one sync (never wipes),
 *  - logout keeps the local archive untouched,
 *  - guests can do everything except cloud sync.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError, STORAGE, type UserInfo } from '@qed2/core-logic';
import { authStore as authStorage, storage } from '../services.js';
import { runStorageMutation } from '../platform/desktop-storage.js';
import { useAppStore } from './app.js';
import { useProgressStore } from './progress.js';

interface Session {
  token: string;
  expiresAt: string;
  user: UserInfo;
}

export const useAuthStore = defineStore('auth', () => {
  const session = ref<Session | undefined>();
  const checking = ref(false);
  let storageSubscribed = false;
  let externalSessionTail: Promise<void> = Promise.resolve();

  const isLoggedIn = computed(() => session.value !== undefined);
  const username = computed(() => session.value?.user.username);

  function wireTokenProvider(): void {
    const app = useAppStore();
    app.setTokenProvider(() => session.value?.token);
  }

  function subscribeStorageChanges(): void {
    if (storageSubscribed || !storage.onChange) return;
    storageSubscribed = true;
    storage.onChange((change) => {
      if (change.collection !== STORAGE.auth) return;
      // Read-only refresh: it cannot create an IPC broadcast loop. Serialize
      // notifications so an older read can never apply after a newer one.
      const reload = async () => {
        session.value = await authStorage.getSession();
        checking.value = false;
      };
      const run = externalSessionTail.then(reload, reload);
      externalSessionTail = run.catch(() => undefined);
    });
  }

  async function init(): Promise<void> {
    wireTokenProvider();
    subscribeStorageChanges();
    const stored = await authStorage.getSession();
    if (!stored) return;
    session.value = stored;
    checking.value = true;
    const app = useAppStore();
    try {
      if (authStorage.isExpiringSoon(stored, new Date())) {
        const refreshed = await app.serverClient.refresh();
        const next = { ...stored, token: refreshed.token, expiresAt: refreshed.expiresAt };
        await runStorageMutation(storage, () => authStorage.setSession(next));
        session.value = next;
      } else {
        await app.serverClient.me();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // Token no longer valid — back to guest. Local archive is untouched.
        await runStorageMutation(storage, () => authStorage.clearSession());
        session.value = undefined;
      }
      // network errors: keep the session, we are just offline
    } finally {
      checking.value = false;
    }
    // A prior invite redemption may have committed this session immediately
    // before the renderer crashed. Only a marker naming this exact account can
    // claim the guest outbox; ordinary stored sessions remain no-ops.
    if (session.value?.user.id === stored.user.id) {
      await useProgressStore().recoverGuestAttemptClaim(stored.user.id);
    }
  }

  async function afterAuth(
    s: Session,
    options: { claimGuestAttempts?: boolean } = {},
  ): Promise<void> {
    const progress = useProgressStore();
    if (options.claimGuestAttempts) {
      // Write the recovery intent BEFORE the session. If the following auth
      // write or claim is interrupted, init/a later login to this same account
      // can finish it without granting guest data to an unrelated account.
      await progress.beginGuestAttemptClaim(s.user.id);
    }
    await runStorageMutation(storage, () => authStorage.setSession(s));
    session.value = s;
    // Login-time reconciliation (history-and-archive-choice upgrade §2):
    // silent when one side is empty or checksums match; otherwise the
    // archive-choice dialog lets the user pick merge / cloud / local.
    await progress.recoverGuestAttemptClaim(s.user.id);
    await progress.reconcileOnLogin();
    await progress.flushAttemptOutbox();
  }

  async function login(usernameInput: string, password: string): Promise<void> {
    const app = useAppStore();
    const res = await app.serverClient.login(usernameInput, password);
    await afterAuth({ token: res.token, expiresAt: res.expiresAt, user: res.user });
  }

  async function redeem(inviteCode: string, usernameInput: string, password: string): Promise<void> {
    const app = useAppStore();
    const res = await app.serverClient.redeem(inviteCode, usernameInput, password);
    await afterAuth(
      { token: res.token, expiresAt: res.expiresAt, user: res.user },
      { claimGuestAttempts: true },
    );
  }

  async function logout(): Promise<void> {
    const progress = useProgressStore();
    // Best-effort final sync so nothing is stranded locally-only.
    try {
      await progress.flushAttemptOutbox();
      await progress.syncNow({ quiet: true });
    } catch {
      /* offline logout is fine */
    }
    // Clears ONLY the auth collection — local progress stays (contract).
    await runStorageMutation(storage, () => authStorage.clearSession());
    session.value = undefined;
  }

  return { session, checking, isLoggedIn, username, init, login, redeem, logout };
});
