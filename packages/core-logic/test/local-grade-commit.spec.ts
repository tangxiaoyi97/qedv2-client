import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_OUTBOX_STORAGE_KEY,
  ArchiveStore,
  AttemptOutbox,
  GUEST_ATTEMPT_OWNER,
  GUEST_CLAIM_STORAGE_KEY,
  HISTORY_STORAGE_KEY,
  LocalGradeCommitStore,
  STORAGE,
  type LocalGradeCommitInput,
  type AttemptOwnerSnapshot,
  type StorageAddress,
  type StorageBatchCommit,
  type StoragePort,
  type StorageVersionedEntry,
} from '../src/index.js';

class AtomicMemoryStorage implements StoragePort {
  readonly values = new Map<string, unknown>();
  readonly revisions = new Map<string, number>();
  beforeCommit: (() => Promise<void>) | undefined;
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
    if (this.throwAfterCommit) {
      this.throwAfterCommit = false;
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

  it('publishes outbox, archive, history and session in one commit', async () => {
    const storage = new AtomicMemoryStorage();
    const result = await new LocalGradeCommitStore(storage).commit(input('event-1', 'session-1'));

    expect(result.recovered).toBe(false);
    expect(result.ownerId).toBe('user-1');
    expect(await storage.get(STORAGE.archive, 'current')).toEqual(result.archive);
    expect(await storage.get<Array<{ clientAttemptId: string }>>(STORAGE.history, HISTORY_STORAGE_KEY))
      .toEqual([expect.objectContaining({ clientAttemptId: 'event-1' })]);
    expect(await storage.get<Array<{ attempt: { clientAttemptId: string } }>>(
      STORAGE.history,
      ATTEMPT_OUTBOX_STORAGE_KEY,
    )).toEqual([expect.objectContaining({ attempt: expect.objectContaining({ clientAttemptId: 'event-1' }) })]);
    expect(await storage.get(STORAGE.app, 'session-1')).toEqual({ version: 4, graded: ['event-1'] });
  });

  it('retries a cross-window CAS conflict without losing either answer', async () => {
    const storage = new AtomicMemoryStorage();
    const first = new LocalGradeCommitStore(storage);
    const second = new LocalGradeCommitStore(storage);

    await Promise.all([
      first.commit(input('event-a', 'session-a', { userId: 'user-1' }, 'shared-part')),
      second.commit(input('event-b', 'session-b', { userId: 'user-1' }, 'shared-part')),
    ]);

    const history = await storage.get<Array<{ clientAttemptId: string }>>(
      STORAGE.history,
      HISTORY_STORAGE_KEY,
    );
    expect(new Set(history?.map((entry) => entry.clientAttemptId))).toEqual(
      new Set(['event-a', 'event-b']),
    );
    const outbox = await storage.get<Array<{ attempt: { clientAttemptId: string } }>>(
      STORAGE.history,
      ATTEMPT_OUTBOX_STORAGE_KEY,
    );
    expect(new Set(outbox?.map((entry) => entry.attempt.clientAttemptId))).toEqual(
      new Set(['event-a', 'event-b']),
    );
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
    expect(await storage.get(STORAGE.history, HISTORY_STORAGE_KEY)).toEqual([
      expect.objectContaining({ clientAttemptId: 'event-star' }),
    ]);
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
    storage.beforeCommit = async () => {
      await new LocalGradeCommitStore(storage).commit(input('graded-during-ack', 'session-ack'));
    };

    await outbox.remove('user-1', ['uploaded-old']);

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
      currentGeneration: 'fresh-generation',
      routes: [{ sourceGeneration: generation, destinationUserId: 'claimed-user' }],
    });
    await outbox.enqueue(GUEST_ATTEMPT_OWNER, input('guest-before-claim', 'unused').attempt);
    storage.beforeCommit = async () => {
      await new LocalGradeCommitStore(storage).commit(input(
        'grade-during-claim',
        'session-claim-race',
        { userId: GUEST_ATTEMPT_OWNER, guestGeneration: generation },
      ));
    };

    await expect(outbox.claim(GUEST_ATTEMPT_OWNER, 'claimed-user')).resolves.toBe(1);

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
    expect(await storage.get(STORAGE.history, ATTEMPT_OUTBOX_STORAGE_KEY)).toEqual([
      expect.objectContaining({ userId: 'claimed-user' }),
    ]);
  });

  it('recognizes a COMMIT whose IPC response was lost and never duplicates it', async () => {
    const storage = new AtomicMemoryStorage();
    storage.throwAfterCommit = true;
    const store = new LocalGradeCommitStore(storage);
    const event = input('event-uncertain', 'session-uncertain');

    await expect(store.commit(event)).resolves.toMatchObject({ recovered: true });
    await expect(store.commit(event)).resolves.toMatchObject({ recovered: true });
    expect(await storage.get<Array<unknown>>(STORAGE.history, HISTORY_STORAGE_KEY)).toHaveLength(1);
    expect(await storage.get<Array<unknown>>(STORAGE.history, ATTEMPT_OUTBOX_STORAGE_KEY)).toHaveLength(1);
  });
});
