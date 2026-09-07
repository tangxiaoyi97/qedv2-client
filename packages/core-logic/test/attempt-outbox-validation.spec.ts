import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_OUTBOX_CORRUPT_ROW_PREFIX,
  ATTEMPT_OUTBOX_STORAGE_KEY,
  AttemptOutbox,
  attemptOutboxRowKey,
} from '../src/store/index.js';
import {
  STORAGE,
  type StorageAddress,
  type StorageBatchCommit,
  type StorageBatchCommitResult,
  type StoragePort,
  type StorageVersionedEntry,
} from '../src/ports/index.js';

class AtomicMemoryStorage implements StoragePort {
  private readonly collections = new Map<string, Map<string, unknown>>();
  private readonly revisions = new Map<string, number>();

  private collection(name: string): Map<string, unknown> {
    let collection = this.collections.get(name);
    if (!collection) {
      collection = new Map();
      this.collections.set(name, collection);
    }
    return collection;
  }

  private identity(address: StorageAddress): string {
    return `${address.collection}\0${address.key}`;
  }

  private clone<T>(value: T): T {
    return structuredClone(value);
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    const value = this.collection(collection).get(key);
    return value === undefined ? undefined : this.clone(value) as T;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    this.collection(collection).set(key, this.clone(value));
    const identity = this.identity({ collection, key });
    this.revisions.set(identity, (this.revisions.get(identity) ?? 0) + 1);
  }

  async delete(collection: string, key: string): Promise<void> {
    this.collection(collection).delete(key);
    const identity = this.identity({ collection, key });
    this.revisions.set(identity, (this.revisions.get(identity) ?? 0) + 1);
  }

  async keys(collection: string): Promise<string[]> {
    return [...this.collection(collection).keys()];
  }

  async clear(collection: string): Promise<void> {
    for (const key of await this.keys(collection)) await this.delete(collection, key);
  }

  async readBatch(addresses: readonly StorageAddress[]): Promise<StorageVersionedEntry[]> {
    return addresses.map((address) => {
      const value = this.collection(address.collection).get(address.key);
      return {
        ...address,
        revision: this.revisions.get(this.identity(address)) ?? 0,
        exists: value !== undefined,
        ...(value !== undefined ? { value: this.clone(value) } : {}),
      };
    });
  }

  async commitBatch(request: StorageBatchCommit): Promise<StorageBatchCommitResult> {
    if (request.ifRevisions.some((condition) =>
      (this.revisions.get(this.identity(condition)) ?? 0) !== condition.revision)) {
      return { committed: false };
    }
    for (const mutation of request.mutations) {
      if (mutation.operation === 'set') {
        this.collection(mutation.collection).set(mutation.key, this.clone(mutation.value));
      } else {
        this.collection(mutation.collection).delete(mutation.key);
      }
      const identity = this.identity(mutation);
      this.revisions.set(identity, (this.revisions.get(identity) ?? 0) + 1);
    }
    return { committed: true };
  }
}

const baseAttempt = {
  clientAttemptId: 'attempt-1',
  questionId: 'question-1',
  partId: 'part-1',
  correct: true,
  awardedPoints: 1,
  gradedAt: '2026-08-15T08:00:00.000Z',
};

describe('AttemptOutbox wire validation and corruption isolation', () => {
  it('rejects a malformed new row before any maintenance or storage write', async () => {
    const storage = new AtomicMemoryStorage();
    const outbox = new AttemptOutbox(storage);

    await expect(outbox.enqueue('owner-1', {
      ...baseAttempt,
      elapsedMs: 0.5,
    })).rejects.toThrow('elapsedMs');

    expect(await storage.keys(STORAGE.history)).toEqual([]);
  });

  it('skips a corrupt oldest v2 row, uploads later valid work and never deletes the bad value', async () => {
    const storage = new AtomicMemoryStorage();
    const owner = 'owner-1';
    const badKey = attemptOutboxRowKey(owner, 'bad-oldest');
    const badValue = {
      userId: owner,
      attempt: {
        ...baseAttempt,
        clientAttemptId: 'bad-oldest',
        awardedPoints: Number.NaN,
        gradedAt: '2026-08-15T07:00:00.000Z',
      },
    };
    const good = {
      ...baseAttempt,
      clientAttemptId: 'good-later',
      elapsedMs: null,
      gradedAt: '2026-08-15T09:00:00+02:00',
    };
    await storage.set(STORAGE.history, badKey, badValue);
    await storage.set(STORAGE.history, attemptOutboxRowKey(owner, good.clientAttemptId), {
      userId: owner,
      attempt: good,
    });
    const outbox = new AttemptOutbox(storage);

    expect(await outbox.list(owner)).toEqual([good]);
    expect(await outbox.count(owner)).toBe(1);
    expect(await outbox.corruptCount()).toBe(1);
    expect(await outbox.corruptInventory()).toEqual([expect.objectContaining({
      key: badKey,
      source: 'v2-row',
      value: expect.objectContaining({ userId: owner }),
    })]);

    await outbox.remove(owner, ['bad-oldest', 'good-later']);
    expect(await outbox.count(owner)).toBe(0);
    expect(await storage.get(STORAGE.history, badKey)).toEqual(badValue);
    expect(await outbox.corruptCount()).toBe(1);
  });

  it('atomically migrates a mixed legacy array, preserving poison rows in the export journal', async () => {
    const storage = new AtomicMemoryStorage();
    const invalidDate = new Date(Number.NaN);
    const bad = {
      userId: 'legacy-user',
      poison: invalidDate,
      attempt: {
        ...baseAttempt,
        clientAttemptId: 'legacy-bad',
        partId: '',
      },
    };
    const good = {
      userId: 'legacy-user',
      attempt: {
        ...baseAttempt,
        clientAttemptId: 'legacy-good',
        contentSource: 'local' as const,
        contentId: 'a'.repeat(40),
        elapsedMs: 7 * 24 * 3600 * 1000,
      },
    };
    await storage.set(STORAGE.history, ATTEMPT_OUTBOX_STORAGE_KEY, [bad, good]);
    const outbox = new AttemptOutbox(storage);
    outbox.configureLegacyAccountOwner((userId) => `account-v1-${userId}`);

    await outbox.migrateLegacy();

    expect(await storage.get(STORAGE.history, ATTEMPT_OUTBOX_STORAGE_KEY)).toBeUndefined();
    expect(await outbox.list('account-v1-legacy-user')).toEqual([good.attempt]);
    const inventory = await outbox.corruptInventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      source: 'legacy-journal',
      reason: expect.stringContaining('partId'),
    });
    expect(inventory[0]!.key.startsWith(ATTEMPT_OUTBOX_CORRUPT_ROW_PREFIX)).toBe(true);
    const preserved = inventory[0]!.value as typeof bad;
    expect(preserved.attempt.clientAttemptId).toBe('legacy-bad');
    expect(preserved.poison).toBeInstanceOf(Date);
    expect(Number.isNaN(preserved.poison.getTime())).toBe(true);
  });
});
