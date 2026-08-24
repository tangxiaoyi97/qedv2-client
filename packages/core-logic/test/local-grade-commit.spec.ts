import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_GUEST_ATTEMPT_OWNER,
  attemptOutboxRowKey,
  archiveStorageKey,
  ArchiveStore,
  AttemptOutbox,
  GUEST_ATTEMPT_OWNER,
  GUEST_CLAIM_STORAGE_KEY,
  historyEventRowKey,
  guestLocalProfileId,
  LocalGradeCommitStore,
  LocalProfileStore,
  STORAGE,
  type LocalGradeCommitInput,
  type AttemptOwnerSnapshot,
  type StorageAddress,
  type StorageBatchCommit,
  type StoragePort,
  type StorageVersionedEntry,
  userLocalProfileId,
} from '../src/index.js';

class AtomicMemoryStorage implements StoragePort {
  readonly values = new Map<string, unknown>();
  readonly revisions = new Map<string, number>();
  beforeCommit: (() => Promise<void>) | undefined;
  afterCommitBeforeResponse: (() => Promise<void>) | undefined;
  throwAfterCommit = false;

  private id(address: StorageAddress): string {
    return `${address.collection}\0${address.key}`;
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.values.get(this.id({ collection, key })) as T | undefined;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    const id = this.id({ collection, key });
    this.values.set(id, structuredClone(value));
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }

  async delete(collection: string, key: string): Promise<void> {
    const id = this.id({ collection, key });
    this.values.delete(id);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }

  async keys(collection: string): Promise<string[]> {
    const prefix = `${collection}\0`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  async clear(collection: string): Promise<void> {
    for (const key of await this.keys(collection)) await this.delete(collection, key);
  }

  async readBatch(addresses: readonly StorageAddress[]): Promise<StorageVersionedEntry[]> {
    if (addresses.length > 32) throw new TypeError('test storage batch exceeds 32 addresses');
    // Yield once so independently created window stores can observe the same
    // snapshot before either reaches commitBatch.
    await Promise.resolve();
    return addresses.map((address) => {
      const id = this.id(address);
      const value = this.values.get(id);
      return {
        ...address,
        revision: this.revisions.get(id) ?? 0,
        exists: value !== undefined,
        ...(value !== undefined ? { value: structuredClone(value) } : {}),
      };
    });
  }

  async commitBatch(request: StorageBatchCommit): Promise<{ committed: boolean }> {
    if (request.ifRevisions.length > 32 || request.mutations.length > 32) {
      throw new TypeError('test storage batch exceeds 32 addresses');
    }
    const hook = this.beforeCommit;
    this.beforeCommit = undefined;
    if (hook) await hook();
    for (const condition of request.ifRevisions) {
      if ((this.revisions.get(this.id(condition)) ?? 0) !== condition.revision) {
        return { committed: false };
      }
    }
    const nextValues = new Map(this.values);
    const nextRevisions = new Map(this.revisions);
    for (const mutation of request.mutations) {
      const id = this.id(mutation);
      if (mutation.operation === 'set') nextValues.set(id, structuredClone(mutation.value));
      else nextValues.delete(id);
      nextRevisions.set(id, (nextRevisions.get(id) ?? 0) + 1);
    }
    this.values.clear();
    for (const [key, value] of nextValues) this.values.set(key, value);
    this.revisions.clear();
    for (const [key, value] of nextRevisions) this.revisions.set(key, value);
    const afterCommit = this.afterCommitBeforeResponse;
    this.afterCommitBeforeResponse = undefined;
    const throwAfterCommit = this.throwAfterCommit;
    this.throwAfterCommit = false;
    if (afterCommit) await afterCommit();
    if (throwAfterCommit) {
      throw new Error('simulated IPC response loss');
    }
    return { committed: true };
  }
}

const NOW = new Date('2026-08-08T08:00:00.000Z');

function input(
  id: string,
  sessionKey: string,
  owner: AttemptOwnerSnapshot = { userId: 'user-1' },
  partId = `part-${id}`,
): LocalGradeCommitInput {
  return {
    owner,
    attempt: {
      clientAttemptId: id,
      contentSource: 'local',
      contentId: 'a'.repeat(40),
      questionId: `question-${id}`,
      partId,
      correct: true,
      awardedPoints: 2,
      elapsedMs: 800,
      gradedAt: NOW.toISOString(),
    },
    grade: {
      partId,
      competencyCodes: ['AN 1.1'],
      verdict: 'correct',
      awardedPoints: 2,
      maxPoints: 2,
      now: NOW,
    },
    session: {
      address: { collection: STORAGE.app, key: sessionKey },
      prepare(current) {
        const graded = current && typeof current === 'object' && Array.isArray((current as { graded?: unknown }).graded)
          ? [...(current as { graded: string[] }).graded]
          : [];
        if (!graded.includes(id)) graded.push(id);
        return { version: 4, graded };
      },
      containsAttempt(current, attemptId) {
        return !!current
          && typeof current === 'object'
          && Array.isArray((current as { graded?: unknown }).graded)
          && (current as { graded: string[] }).graded.includes(attemptId);
      },
      matchesAttempt(current, attempt) {
        return !!current
          && typeof current === 'object'
          && Array.isArray((current as { graded?: unknown }).graded)
          && (current as { graded: string[] }).graded.includes(attempt.clientAttemptId);
      },
    },
  };
}

describe('LocalGradeCommitStore', () => {
  it('gives concurrent tabs the same durable guest generation', async () => {
    const storage = new AtomicMemoryStorage();
    const first = new AttemptOutbox(storage);
    const second = new AttemptOutbox(storage);

    const [left, right] = await Promise.all([
      first.captureGuestOwner(),
      second.captureGuestOwner(),
    ]);

    expect(left).toEqual(right);
    expect(left.guestGeneration).toBeTruthy();
  });

  it('migrates a large legacy outbox in bounded atomic chunks', async () => {
    const storage = new AtomicMemoryStorage();
    const legacy = Array.from({ length: 65 }, (_, index) => ({
      userId: GUEST_ATTEMPT_OWNER,
      attempt: {
        clientAttemptId: `legacy-${index}`,
        questionId: `q-${index}`,
        partId: `p-${index}`,
        correct: true,
        awardedPoints: 1,
        gradedAt: '2026-08-08T08:00:00.000Z',
      },
    }));
    await storage.set(STORAGE.history, 'attempt-outbox', legacy);

    const outbox = new AttemptOutbox(storage);
    expect(await outbox.count(GUEST_ATTEMPT_OWNER)).toBe(65);
    expect(await storage.get(STORAGE.history, 'attempt-outbox')).toBeUndefined();
  });

  it('quarantines generationless guest rows from an interrupted 2.1 claim', async () => {
    const storage = new AtomicMemoryStorage();
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: 'new-generation',
      routes: [{ sourceGeneration: 'old-generation', destinationUserId: 'new-user' }],
      pending: { sourceGeneration: 'old-generation', destinationUserId: 'new-user' },
    });
    await storage.set(STORAGE.history, 'attempt-outbox', [{
      userId: GUEST_ATTEMPT_OWNER,
      attempt: {
        clientAttemptId: 'ambiguous-legacy',
        questionId: 'q',
        partId: 'p',
        correct: false,
        awardedPoints: 0,
        gradedAt: '2026-08-08T08:00:00.000Z',
      },
    }]);

    const outbox = new AttemptOutbox(storage);
    expect(await outbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await outbox.count(AMBIGUOUS_GUEST_ATTEMPT_OWNER)).toBe(1);
  });

  it('keeps a late 2.1 write unresolved after an empty journal was claimed and finished', async () => {
    const storage = new AtomicMemoryStorage();
    const outbox = new AttemptOutbox(storage);
    await outbox.captureGuestOwner();
    await outbox.beginGuestClaim('new-user');
    await outbox.finishGuestClaim('new-user');

    await storage.set(STORAGE.history, 'attempt-outbox', [{
      userId: GUEST_ATTEMPT_OWNER,
      attempt: {
        clientAttemptId: 'late-legacy',
        questionId: 'q-late',
        partId: 'p-late',
        correct: true,
        awardedPoints: 1,
        gradedAt: '2026-08-08T08:00:00.000Z',
      },
    }]);

    expect(await outbox.count(AMBIGUOUS_GUEST_ATTEMPT_OWNER)).toBe(1);
    expect(await outbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await outbox.count('new-user')).toBe(0);
  });

  it('resumes a chunk migration after the marker commit response is lost', async () => {
    const storage = new AtomicMemoryStorage();
    const first = new AttemptOutbox(storage);
    await first.captureGuestOwner();
    await storage.set(STORAGE.history, 'attempt-outbox', [{
      userId: GUEST_ATTEMPT_OWNER,
      attempt: {
        clientAttemptId: 'marker-recovery',
        questionId: 'q-marker',
        partId: 'p-marker',
        correct: false,
        awardedPoints: 0,
        gradedAt: '2026-08-08T08:00:00.000Z',
      },
    }]);
    storage.throwAfterCommit = true;

    await expect(first.count(GUEST_ATTEMPT_OWNER)).rejects.toThrow('simulated IPC response loss');
    const restarted = new AttemptOutbox(storage);
    expect(await restarted.count(GUEST_ATTEMPT_OWNER)).toBe(1);
    expect(await storage.get(STORAGE.history, 'attempt-outbox')).toBeUndefined();
    expect(await storage.get<{ legacyMigration?: unknown }>(
      STORAGE.history,
      GUEST_CLAIM_STORAGE_KEY,
    )).not.toHaveProperty('legacyMigration');
  });

  it('publishes outbox, archive, history and session in one commit', async () => {
    const storage = new AtomicMemoryStorage();
    const result = await new LocalGradeCommitStore(storage).commit(input('event-1', 'session-1'));

    expect(result.recovered).toBe(false);
    expect(result.ownerId).toBe('user-1');
    expect(await storage.get(STORAGE.archive, 'current')).toEqual(result.archive);
    expect(await storage.get<{ entry: { clientAttemptId: string } }>(
      STORAGE.history,
      historyEventRowKey('event-1'),
    )).toEqual(expect.objectContaining({
      entry: expect.objectContaining({ clientAttemptId: 'event-1' }),
    }));
    expect(await storage.get<{ attempt: { clientAttemptId: string } }>(
      STORAGE.history,
      attemptOutboxRowKey('user-1', 'event-1'),
    )).toEqual(expect.objectContaining({
      attempt: expect.objectContaining({ clientAttemptId: 'event-1' }),
    }));
    expect(await storage.get(STORAGE.app, 'session-1')).toEqual({ version: 4, graded: ['event-1'] });
  });

  it('replaces the automatic FSRS grade with the manual judgement atomically', async () => {
    const storage = new AtomicMemoryStorage();
    const event = input('event-manual', 'session-manual');
    event.manualGrading = 'baffled';

    const result = await new LocalGradeCommitStore(storage).commit(event);

    expect(result.grading).toBe('baffled');
    expect(result.historyEntry.grading).toBe('baffled');
    expect(result.archive.content.perPart).toEqual([
      expect.objectContaining({
        partId: event.attempt.partId,
        grading: 'baffled',
        fsrs: expect.objectContaining({ reps: 1, lapses: 1 }),
      }),
    ]);
  });

  it('retries a cross-window CAS conflict without losing either answer', async () => {
    const storage = new AtomicMemoryStorage();
    const first = new LocalGradeCommitStore(storage);
    const second = new LocalGradeCommitStore(storage);

    await Promise.all([
      first.commit(input('event-a', 'session-a', { userId: 'user-1' }, 'shared-part')),
      second.commit(input('event-b', 'session-b', { userId: 'user-1' }, 'shared-part')),
    ]);

    await expect(storage.get(STORAGE.history, historyEventRowKey('event-a')))
      .resolves.toBeDefined();
    await expect(storage.get(STORAGE.history, historyEventRowKey('event-b')))
      .resolves.toBeDefined();
    await expect(storage.get(STORAGE.history, attemptOutboxRowKey('user-1', 'event-a')))
      .resolves.toBeDefined();
    await expect(storage.get(STORAGE.history, attemptOutboxRowKey('user-1', 'event-b')))
      .resolves.toBeDefined();
    expect(await storage.get(STORAGE.app, 'session-a')).toEqual({ version: 4, graded: ['event-a'] });
    expect(await storage.get(STORAGE.app, 'session-b')).toEqual({ version: 4, graded: ['event-b'] });
  });

  it('does not let a concurrent bookmark write overwrite an atomic answer', async () => {
    const storage = new AtomicMemoryStorage();
    const grade = new LocalGradeCommitStore(storage);
    const archive = new ArchiveStore(storage);

    await Promise.all([
      grade.commit(input('event-star', 'session-star', { userId: 'user-1' }, 'shared-part')),
      archive.setStarred('shared-part', true, NOW),
    ]);

    const saved = await archive.load();
    expect(saved.content.perPart).toEqual([
      expect.objectContaining({
        partId: 'shared-part',
        starred: true,
        lastResult: expect.objectContaining({ correct: true }),
      }),
    ]);
    expect(await storage.get(STORAGE.history, historyEventRowKey('event-star')))
      .toEqual(expect.objectContaining({
        entry: expect.objectContaining({ clientAttemptId: 'event-star' }),
      }));
  });

  it('rejects a stale sync archive after another window commits progress', async () => {
    const storage = new AtomicMemoryStorage();
    const archive = new ArchiveStore(storage);
    const expected = await archive.load();
    await new LocalGradeCommitStore(storage).commit(
      input('event-newer', 'session-newer', { userId: 'user-1' }, 'newer-part'),
    );

    const staleServerResult = { ...expected, baseVersion: 1 };
    await expect(archive.saveIfUnchanged(expected, staleServerResult)).resolves.toBe(false);
    expect((await archive.load()).content.perPart).toEqual([
      expect.objectContaining({ partId: 'newer-part' }),
    ]);
  });

  it('keeps a newly graded attempt when an acknowledged upload removes an older batch', async () => {
    const storage = new AtomicMemoryStorage();
    const outbox = new AttemptOutbox(storage);
    await outbox.enqueue('user-1', input('uploaded-old', 'unused').attempt);
    await Promise.all([
      outbox.remove('user-1', ['uploaded-old']),
      new LocalGradeCommitStore(storage).commit(input('graded-during-ack', 'session-ack')),
    ]);

    expect((await outbox.list('user-1')).map((attempt) => attempt.clientAttemptId)).toEqual([
      'graded-during-ack',
    ]);
  });

  it('keeps a routed grade when guest claiming races the outbox move', async () => {
    const storage = new AtomicMemoryStorage();
    const outbox = new AttemptOutbox(storage);
    const generation = 'claim-race-generation';
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: generation,
      routes: [],
    });
    const oldGuest = await outbox.captureGuestOwner();
    await outbox.enqueue(oldGuest, input('guest-before-claim', 'unused').attempt);
    await outbox.beginGuestClaim('claimed-user');
    storage.beforeCommit = async () => {
      await new LocalGradeCommitStore(storage).commit(input(
        'grade-during-claim',
        'session-claim-race',
        { userId: GUEST_ATTEMPT_OWNER, guestGeneration: generation },
      ));
    };

    await expect(outbox.claim(
      GUEST_ATTEMPT_OWNER,
      'claimed-user',
      generation,
    )).resolves.toBe(1);

    expect(await outbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(new Set(
      (await outbox.list('claimed-user')).map((attempt) => attempt.clientAttemptId),
    )).toEqual(new Set(['guest-before-claim', 'grade-during-claim']));
  });

  it('re-resolves guest ownership when a claim races the first CAS attempt', async () => {
    const storage = new AtomicMemoryStorage();
    const generation = 'guest-generation';
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: generation,
      routes: [],
    });
    storage.beforeCommit = async () => {
      await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
        version: 1,
        currentGeneration: 'new-generation',
        routes: [{ sourceGeneration: generation, destinationUserId: 'claimed-user' }],
      });
    };

    const result = await new LocalGradeCommitStore(storage).commit(
      input('event-claim', 'session-claim', {
        userId: GUEST_ATTEMPT_OWNER,
        guestGeneration: generation,
      }),
    );
    expect(result.ownerId).toBe('claimed-user');
    expect(await storage.get(
      STORAGE.history,
      attemptOutboxRowKey('claimed-user', 'event-claim'),
    )).toEqual(expect.objectContaining({ userId: 'claimed-user' }));
  });

  it('does not strand a direct enqueue when claim enumerates before its row commit', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    await profiles.initialize();
    const first = new AttemptOutbox(storage);
    const claimant = new AttemptOutbox(storage);
    const owner = await first.captureGuestOwner();
    storage.beforeCommit = async () => {
      await profiles.claimGuestForUser('claimed-user');
      await claimant.claim(GUEST_ATTEMPT_OWNER, 'claimed-user', owner.guestGeneration);
      await claimant.finishGuestClaim('claimed-user');
    };

    const resolved = await first.enqueue(owner, {
      clientAttemptId: 'direct-enqueue-claim-race',
      questionId: 'q-race',
      partId: 'p-race',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-08T08:00:00.000Z',
    });

    expect(resolved).toBe('claimed-user');
    expect(await first.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await first.count('claimed-user')).toBe(1);
  });

  it('recognizes a COMMIT whose IPC response was lost and never duplicates it', async () => {
    const storage = new AtomicMemoryStorage();
    storage.throwAfterCommit = true;
    const store = new LocalGradeCommitStore(storage);
    const event = input('event-uncertain', 'session-uncertain');

    await expect(store.commit(event)).resolves.toMatchObject({ recovered: true });
    await expect(store.commit(event)).resolves.toMatchObject({ recovered: true });
    expect(await storage.get(STORAGE.history, historyEventRowKey('event-uncertain'))).toBeDefined();
    expect(await storage.get(
      STORAGE.history,
      attemptOutboxRowKey('user-1', 'event-uncertain'),
    )).toBeDefined();
  });

  it('recovers a lost response without losing or re-applying the manual judgement', async () => {
    const storage = new AtomicMemoryStorage();
    storage.throwAfterCommit = true;
    const event = input('event-manual-uncertain', 'session-manual-uncertain');
    event.manualGrading = 'careless';
    const store = new LocalGradeCommitStore(storage);

    const recovered = await store.commit(event);
    const retried = await store.commit(event);

    expect(recovered).toMatchObject({ recovered: true, grading: 'careless' });
    expect(retried).toMatchObject({ recovered: true, grading: 'careless' });
    const archive = await storage.get<{ content: { perPart: Array<{ fsrs: { reps: number } }> } }>(
      STORAGE.archive,
      'current',
    );
    expect(archive?.content.perPart[0]?.fsrs.reps).toBe(1);
  });

  it('rejects reuse of one attempt identity with a different payload', async () => {
    const storage = new AtomicMemoryStorage();
    const store = new LocalGradeCommitStore(storage);
    const original = input('event-reused', 'session-reused');
    await store.commit(original);
    const changed = input('event-reused', 'session-reused');
    changed.attempt.questionId = 'different-question';

    await expect(store.commit(changed)).rejects.toThrow('different history data');
  });

  it('rejects reuse of one attempt identity with a different manual judgement', async () => {
    const storage = new AtomicMemoryStorage();
    const store = new LocalGradeCommitStore(storage);
    const original = input('event-manual-reused', 'session-manual-reused');
    original.manualGrading = 'good';
    await store.commit(original);
    const changed = input('event-manual-reused', 'session-manual-reused');
    changed.manualGrading = 'baffled';

    await expect(store.commit(changed)).rejects.toThrow('different history data');
  });

  it('re-resolves both profile and outbox after a committed response is lost during claim', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    await profiles.initialize();
    const outbox = new AttemptOutbox(storage);
    const captured = await outbox.captureGuestOwner();
    const guest = profiles.current();
    const event = input('event-claim-after-commit', 'session-claim-after-commit', {
      ...captured,
      localProfileId: guest,
    });
    const store = new LocalGradeCommitStore(
      storage,
      guest,
      (profileId) => profiles.resolve(profileId),
    );
    storage.throwAfterCommit = true;
    storage.afterCommitBeforeResponse = async () => {
      await profiles.claimGuestForUser('claimed-user');
      const route = await outbox.pendingGuestClaimRoute();
      if (!route) throw new Error('claim route was not persisted');
      await outbox.claim(GUEST_ATTEMPT_OWNER, 'claimed-user', route.sourceGeneration);
    };

    await expect(store.commit(event)).resolves.toMatchObject({
      recovered: true,
      ownerId: 'claimed-user',
      profileId: userLocalProfileId('claimed-user'),
    });
    expect(await storage.get(STORAGE.archive, archiveStorageKey(guest))).toBeUndefined();
    expect(await storage.get(
      STORAGE.history,
      attemptOutboxRowKey('claimed-user', event.attempt.clientAttemptId),
    )).toBeDefined();
  });

  it('routes a late guest-session grade into the explicitly claimed local profile', async () => {
    const storage = new AtomicMemoryStorage();
    const guest = guestLocalProfileId('11111111-1111-4111-8111-111111111111');
    const user = userLocalProfileId('claimed-user');
    const store = new LocalGradeCommitStore(
      storage,
      undefined,
      (profileId) => profileId === guest ? user : profileId,
    );

    await store.commit(input('event-profile-route', 'session-profile-route', {
      userId: 'claimed-user',
      localProfileId: guest,
    }));

    expect(await storage.get(STORAGE.archive, archiveStorageKey(guest))).toBeUndefined();
    expect(await storage.get(STORAGE.archive, archiveStorageKey(user))).toBeDefined();
    expect(await storage.get<{ profileId: string }>(
      STORAGE.history,
      historyEventRowKey('event-profile-route', guest),
    )).toMatchObject({ profileId: guest });
  });

  it('retries against the claimed profile when a profile hand-off wins the CAS race', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    await profiles.initialize();
    const guest = profiles.current();
    const user = userLocalProfileId('claimed-user');
    const grade = new LocalGradeCommitStore(
      storage,
      guest,
      (profileId) => profiles.resolve(profileId),
    );
    storage.beforeCommit = () => profiles.claimGuestForUser('claimed-user').then(() => undefined);

    const result = await grade.commit(input('event-profile-race', 'session-profile-race', {
      userId: 'claimed-user',
      localProfileId: guest,
    }));

    expect(result.ownerId).toBe('claimed-user');
    expect(await storage.get(STORAGE.archive, archiveStorageKey(guest))).toBeUndefined();
    expect(await storage.get(STORAGE.archive, archiveStorageKey(user))).toEqual(result.archive);
    expect(await storage.get<{ profileId: string }>(
      STORAGE.history,
      historyEventRowKey('event-profile-race', guest),
    )).toMatchObject({ profileId: guest });
  });

  it('confirms a lost grade response after claim moves archive and outbox but not history', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const guest = (await profiles.initialize()).guestProfileId;
    const outbox = new AttemptOutbox(storage);
    const owner = await outbox.captureGuestOwner();
    const grade = new LocalGradeCommitStore(storage, guest);
    storage.afterCommitBeforeResponse = async () => {
      await profiles.claimGuestForUser('claimed-user');
      await outbox.claim(GUEST_ATTEMPT_OWNER, 'claimed-user', owner.guestGeneration);
    };
    storage.throwAfterCommit = true;

    const result = await grade.commit(input('event-claim-response-loss', 'session-claim-loss', {
      ...owner,
      localProfileId: guest,
    }));

    expect(result).toMatchObject({ recovered: true, profileId: 'user:claimed-user' });
    expect(result.archive.content.perPart[0]?.fsrs.reps).toBe(1);
    expect(await storage.get(
      STORAGE.history,
      historyEventRowKey('event-claim-response-loss', guest),
    )).toBeDefined();
    expect(await storage.get(
      STORAGE.history,
      historyEventRowKey('event-claim-response-loss', userLocalProfileId('claimed-user')),
    )).toBeUndefined();
    expect(await outbox.count('claimed-user')).toBe(1);
  });
});
