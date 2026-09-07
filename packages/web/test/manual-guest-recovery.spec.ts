import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  accountStorageIdentity,
  archiveChecksum,
  ArchiveStore,
  GUEST_ATTEMPT_OWNER,
  HistoryLog,
  LocalRecoveryStore,
  STORAGE,
  userLocalProfileId,
} from '@qed2/core-logic';
import {
  archiveStore,
  attemptOutbox,
  localProfileStore,
  storage,
} from '../src/services.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('explicit recovery after an ordinary login', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
    for (const collection of [STORAGE.auth, STORAGE.archive, STORAGE.history, STORAGE.app]) {
      await storage.clear(collection);
    }
    await localProfileStore.initialize();
  });

  it('claims guest archive, history and outbox into a logically empty account', async () => {
    const auth = useAuthStore();
    await auth.init();
    const progress = useProgressStore();
    await progress.init();
    await progress.applyGrade({
      partId: 'guest-part',
      questionId: 'guest-question',
      competencyCodes: ['AG 1.1'],
      result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
      gradedAt: '2026-08-15T10:00:00.000Z',
    });
    const guestAttempt = {
      clientAttemptId: 'guest-attempt',
      questionId: 'guest-question',
      partId: 'guest-part',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-15T10:00:00.000Z',
    };
    await progress.queueAttempt(guestAttempt);
    const guestProfile = localProfileStore.current();

    const emptyChecksum = archiveChecksum({ perPart: [], perCompetency: [] });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith('/auth/login')) {
        return json({
          token: 'existing-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { id: 'existing-account', username: 'lin' },
        });
      }
      if (path.endsWith('/me/state')) {
        return json({
          archiveVersion: 7,
          checksum: emptyChecksum,
          perPart: [],
          perCompetency: [],
          updatedAt: '2026-08-15T10:00:00.000Z',
        });
      }
      if (path.endsWith('/me/attempts')) {
        expect(JSON.parse(String(init?.body))).toEqual({ attempts: [guestAttempt] });
        return json({ recorded: 1 });
      }
      if (path.endsWith('/me/sync')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          baseVersion: 7,
          localArchive: { perPart: [expect.objectContaining({ partId: 'guest-part' })] },
        });
        return json({ result: 'fast-forward', archiveVersion: 8, checksum: 'synced' });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await auth.login('lin', 'password123');
    const session = auth.session!;
    const ownerId = accountStorageIdentity(session.serverBaseUrl!, session.user.id);
    const accountProfile = userLocalProfileId(ownerId);
    expect(localProfileStore.current()).toBe(accountProfile);
    expect((await new ArchiveStore(storage, accountProfile).load()).content.perPart).toEqual([]);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);

    const recovery = await new LocalRecoveryStore(storage).inventory(accountProfile);
    expect(recovery.profiles).toContainEqual(expect.objectContaining({
      kind: 'unclaimed-guest',
      profileId: guestProfile,
      assignment: { safe: true },
    }));

    await progress.claimGuestAttempts(ownerId);
    await progress.flushAttemptOutbox();
    await progress.syncNow({ quiet: true });

    expect((await new ArchiveStore(storage, accountProfile).load())).toMatchObject({
      baseVersion: 8,
      content: { perPart: [expect.objectContaining({ partId: 'guest-part' })] },
    });
    expect(await new HistoryLog(
      storage,
      () => localProfileStore.readableProfiles(accountProfile),
    ).count()).toBe(1);
    expect(localProfileStore.resolve(guestProfile)).toBe(accountProfile);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count(ownerId)).toBe(0);
    expect(progress.cloudHistoryVersion).toBe(1);
    expect(calls).toEqual([
      '/auth/login',
      '/me/state',
      '/me/attempts',
      '/me/sync',
    ]);
  });
});
