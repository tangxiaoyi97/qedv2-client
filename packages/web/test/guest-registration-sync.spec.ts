import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { GUEST_ATTEMPT_OWNER, STORAGE } from '@qed2/core-logic';
import { archiveStore, attemptOutbox, authStore as authStorage, storage } from '../src/services.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('guest registration reconciliation', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
    await storage.clear(STORAGE.auth);
    await storage.clear(STORAGE.archive);
    await storage.clear(STORAGE.history);
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
    expect(await attemptOutbox.count('new-account')).toBe(0);
    expect(progress.cloudHistoryVersion).toBe(1);
  });

  it('does not claim guest attempts during an ordinary login', async () => {
    const auth = useAuthStore();
    await auth.init();
    const progress = useProgressStore();
    await progress.init();
    await progress.queueAttempt({
      clientAttemptId: 'shared-device-guest-attempt',
      questionId: 'q1',
      partId: 'q1-a',
      correct: false,
      awardedPoints: 0,
      gradedAt: '2026-08-07T09:00:00.000Z',
    });
    await progress.beginGuestAttemptClaim('invite-created-account');

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

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
    expect(await attemptOutbox.count('existing-account')).toBe(0);
    expect(await attemptOutbox.pendingGuestClaim()).toBe('invite-created-account');
  });

  it('recovers a persisted invite claim after a crash between session and claim', async () => {
    const progress = useProgressStore();
    await progress.init();
    await progress.queueAttempt({
      clientAttemptId: 'crash-window-attempt',
      questionId: 'q-crash',
      partId: 'q-crash-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-07T10:00:00.000Z',
    });
    await progress.beginGuestAttemptClaim('new-account');
    await authStorage.setSession({
      token: 'persisted-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'new-account', username: 'ada' },
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
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count('new-account')).toBe(1);
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
    await progress.beginGuestAttemptClaim('matching-account');

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
    expect(await attemptOutbox.count('matching-account')).toBe(0);
    expect(await attemptOutbox.pendingGuestClaim()).toBeUndefined();
  });
});
