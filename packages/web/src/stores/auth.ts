/**
 * Auth store. Contract hard rules honored here:
 *  - login merges local progress into the account via one sync (never wipes),
 *  - logout keeps the local archive untouched,
 *  - guests can do everything except cloud sync.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError, type UserInfo } from '@qed2/core-logic';
import { authStore as authStorage } from '../services.js';
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

  const isLoggedIn = computed(() => session.value !== undefined);
  const username = computed(() => session.value?.user.username);

  function wireTokenProvider(): void {
    const app = useAppStore();
    app.setTokenProvider(() => session.value?.token);
  }

  async function init(): Promise<void> {
    wireTokenProvider();
    const stored = await authStorage.getSession();
    if (!stored) return;
    session.value = stored;
    checking.value = true;
    const app = useAppStore();
    try {
      if (authStorage.isExpiringSoon(stored, new Date())) {
        const refreshed = await app.serverClient.refresh();
        session.value = { ...stored, token: refreshed.token, expiresAt: refreshed.expiresAt };
        await authStorage.setSession(session.value);
      } else {
        await app.serverClient.me();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // Token no longer valid — back to guest. Local archive is untouched.
        session.value = undefined;
        await authStorage.clearSession();
      }
      // network errors: keep the session, we are just offline
    } finally {
      checking.value = false;
    }
  }

  async function afterAuth(s: Session): Promise<void> {
    session.value = s;
    await authStorage.setSession(s);
    // Contract §8.2: guest progress merges into the account via one sync.
    const progress = useProgressStore();
    await progress.syncNow({ quiet: false });
  }

  async function login(usernameInput: string, password: string): Promise<void> {
    const app = useAppStore();
    const res = await app.serverClient.login(usernameInput, password);
    await afterAuth({ token: res.token, expiresAt: res.expiresAt, user: res.user });
  }

  async function redeem(inviteCode: string, usernameInput: string, password: string): Promise<void> {
    const app = useAppStore();
    const res = await app.serverClient.redeem(inviteCode, usernameInput, password);
    await afterAuth({ token: res.token, expiresAt: res.expiresAt, user: res.user });
  }

  async function logout(): Promise<void> {
    const progress = useProgressStore();
    // Best-effort final sync so nothing is stranded locally-only.
    try {
      await progress.syncNow({ quiet: true });
    } catch {
      /* offline logout is fine */
    }
    session.value = undefined;
    // Clears ONLY the auth collection — local progress stays (contract).
    await authStorage.clearSession();
  }

  return { session, checking, isLoggedIn, username, init, login, redeem, logout };
});
