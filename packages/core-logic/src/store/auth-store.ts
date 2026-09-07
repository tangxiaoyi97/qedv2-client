/**
 * Auth session store. Sessions are long-lived tokens (contract §4.1); the
 * client warns/refreshes when expiry approaches.
 */
import { hasAtomicStorage, STORAGE } from '../ports/index.js';
import type { StoragePort } from '../ports/index.js';
import type { UserInfo } from '../api/types.js';

export interface AuthSession {
  token: string;
  /** ISO 8601 expiry from the auth response. */
  expiresAt: string;
  user: UserInfo;
  /** Canonical qed2-server identity that issued this bearer token. */
  serverBaseUrl?: string;
}

export const AUTH_SESSION_STORAGE_KEY = 'session';

export type AuthSessionInspection =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'valid'; session: AuthSession };

export interface AuthSessionSnapshot {
  inspection: AuthSessionInspection;
  /** Present for adapters that can fence a later auth mutation with CAS. */
  revision?: number;
}

export function parseAuthSession(value: unknown): AuthSession | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const user = candidate.user;
  if (!user || typeof user !== 'object' || Array.isArray(user)) return undefined;
  const identity = user as Record<string, unknown>;
  if (
    typeof candidate.token !== 'string'
    || candidate.token.length === 0
    || candidate.token.length > 16_384
    || candidate.token.includes('\0')
    || typeof candidate.expiresAt !== 'string'
    || candidate.expiresAt.length > 64
    || !/(?:[zZ]|[+-]\d{2}:\d{2})$/u.test(candidate.expiresAt)
    || !Number.isFinite(Date.parse(candidate.expiresAt))
    || typeof identity.id !== 'string'
    || identity.id.length === 0
    || identity.id.length > 128
    || identity.id.includes('\0')
    || typeof identity.username !== 'string'
    || identity.username.length === 0
    || identity.username.length > 128
    || identity.username.includes('\0')
    || (candidate.serverBaseUrl !== undefined
      && (typeof candidate.serverBaseUrl !== 'string'
        || candidate.serverBaseUrl.length === 0
        || candidate.serverBaseUrl.length > 4096
        || candidate.serverBaseUrl.includes('\0')))
  ) return undefined;
  return {
    token: candidate.token,
    expiresAt: candidate.expiresAt,
    user: { id: identity.id, username: identity.username },
    ...(typeof candidate.serverBaseUrl === 'string'
      ? { serverBaseUrl: candidate.serverBaseUrl }
      : {}),
  };
}

/** Default "expiring soon" window: 72 hours. */
export const DEFAULT_EXPIRY_WINDOW_MS = 72 * 60 * 60 * 1000;

export class AuthStore {
  constructor(private readonly storage: StoragePort) {}

  async getSession(): Promise<AuthSession | undefined> {
    const inspected = await this.inspectSession();
    return inspected.status === 'valid' ? inspected.session : undefined;
  }

  async inspectSession(): Promise<AuthSessionInspection> {
    const raw = await this.storage.get<unknown>(STORAGE.auth, AUTH_SESSION_STORAGE_KEY);
    if (raw === undefined) return { status: 'missing' };
    const session = parseAuthSession(raw);
    return session ? { status: 'valid', session } : { status: 'malformed' };
  }

  async setSession(session: AuthSession): Promise<void> {
    const parsed = parseAuthSession(session);
    if (!parsed) throw new TypeError('Auth session is malformed');
    await this.storage.set(STORAGE.auth, AUTH_SESSION_STORAGE_KEY, parsed);
  }

  async snapshot(): Promise<AuthSessionSnapshot> {
    if (!hasAtomicStorage(this.storage)) return { inspection: await this.inspectSession() };
    const [entry] = await this.storage.readBatch([
      { collection: STORAGE.auth, key: AUTH_SESSION_STORAGE_KEY },
    ]);
    if (!entry) throw new Error('Auth session snapshot was incomplete');
    if (!entry.exists) return { inspection: { status: 'missing' }, revision: entry.revision };
    const session = parseAuthSession(entry.value);
    return {
      inspection: session ? { status: 'valid', session } : { status: 'malformed' },
      revision: entry.revision,
    };
  }

  async setSessionIfUnchanged(
    session: AuthSession,
    expected: AuthSessionSnapshot,
  ): Promise<boolean> {
    const parsed = parseAuthSession(session);
    if (!parsed) throw new TypeError('Auth session is malformed');
    if (!hasAtomicStorage(this.storage) || expected.revision === undefined) {
      await this.storage.set(STORAGE.auth, AUTH_SESSION_STORAGE_KEY, parsed);
      return true;
    }
    return (await this.storage.commitBatch({
      ifRevisions: [{
        collection: STORAGE.auth,
        key: AUTH_SESSION_STORAGE_KEY,
        revision: expected.revision,
      }],
      mutations: [{
        collection: STORAGE.auth,
        key: AUTH_SESSION_STORAGE_KEY,
        operation: 'set',
        value: parsed,
      }],
    })).committed;
  }

  async clearSessionIfUnchanged(expected: AuthSessionSnapshot): Promise<boolean> {
    if (!hasAtomicStorage(this.storage) || expected.revision === undefined) {
      await this.storage.delete(STORAGE.auth, AUTH_SESSION_STORAGE_KEY);
      return true;
    }
    return (await this.storage.commitBatch({
      ifRevisions: [{
        collection: STORAGE.auth,
        key: AUTH_SESSION_STORAGE_KEY,
        revision: expected.revision,
      }],
      mutations: [{
        collection: STORAGE.auth,
        key: AUTH_SESSION_STORAGE_KEY,
        operation: 'delete',
      }],
    })).committed;
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
