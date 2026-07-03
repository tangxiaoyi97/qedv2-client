/**
 * Auth session store. Sessions are long-lived tokens (contract §4.1); the
 * client warns/refreshes when expiry approaches.
 */
import { STORAGE } from '../ports/index.js';
import type { StoragePort } from '../ports/index.js';
import type { UserInfo } from '../api/types.js';

export interface AuthSession {
  token: string;
  /** ISO 8601 expiry from the auth response. */
  expiresAt: string;
  user: UserInfo;
}

const SESSION_KEY = 'session';

/** Default "expiring soon" window: 72 hours. */
export const DEFAULT_EXPIRY_WINDOW_MS = 72 * 60 * 60 * 1000;

export class AuthStore {
  constructor(private readonly storage: StoragePort) {}

  async getSession(): Promise<AuthSession | undefined> {
    return this.storage.get<AuthSession>(STORAGE.auth, SESSION_KEY);
  }

  async setSession(session: AuthSession): Promise<void> {
    await this.storage.set(STORAGE.auth, SESSION_KEY, session);
  }

  /**
   * Clears ONLY the auth collection. The local archive is NEVER touched by
   * login/logout (iron rule) — guest and account progress share one local
   * document that reconciles via sync.
   */
  async clearSession(): Promise<void> {
    await this.storage.clear(STORAGE.auth);
  }

  /** True when the session expires within `withinMs` of `now` (or already has). */
  isExpiringSoon(session: AuthSession, now: Date, withinMs: number = DEFAULT_EXPIRY_WINDOW_MS): boolean {
    return new Date(session.expiresAt).getTime() - now.getTime() <= withinMs;
  }
}
