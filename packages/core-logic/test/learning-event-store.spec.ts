import { describe, expect, it } from 'vitest';
import {
  LearningEventStore,
  MAX_LEARNING_EVENTS_PER_PROFILE,
  STORAGE,
  learningEventStorageKey,
  parseLearningEvent,
  userLocalProfileId,
  type StorageAddress,
  type StorageBatchCommit,
  type StoragePort,
  type StorageVersionedEntry,
} from '../src/index.js';

class AtomicMemoryStorage implements StoragePort {
  protected readonly values = new Map<string, unknown>();
  protected readonly revisions = new Map<string, number>();

  protected id(collection: string, key: string): string {
    return collection + '\0' + key;
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.values.get(this.id(collection, key)) as T | undefined;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    const id = this.id(collection, key);
    this.values.set(id, value);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }

  async delete(collection: string, key: string): Promise<void> {
    const id = this.id(collection, key);
    this.values.delete(id);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }

  async keys(collection: string): Promise<string[]> {
    const prefix = collection + '\0';
    return [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  async clear(collection: string): Promise<void> {
    for (const key of await this.keys(collection)) await this.delete(collection, key);
  }

  async readBatch(addresses: readonly StorageAddress[]): Promise<StorageVersionedEntry[]> {
    return addresses.map((address) => {
      const id = this.id(address.collection, address.key);
      const value = this.values.get(id);
      return {
        ...address,
        revision: this.revisions.get(id) ?? 0,
        exists: value !== undefined,
        ...(value !== undefined ? { value } : {}),
      };
    });
  }

  async commitBatch(request: StorageBatchCommit): Promise<{ committed: boolean }> {
    if (request.ifRevisions.some((condition) =>
      (this.revisions.get(this.id(condition.collection, condition.key)) ?? 0)
        !== condition.revision)) {
      return { committed: false };
    }
    for (const mutation of request.mutations) {
      if (mutation.operation === 'set') {
        await this.set(mutation.collection, mutation.key, mutation.value);
      } else {
        await this.delete(mutation.collection, mutation.key);
      }
    }
    return { committed: true };
  }
}

class LostResponseStorage extends AtomicMemoryStorage {
  loseNextResponse = false;

  override async commitBatch(request: StorageBatchCommit): Promise<{ committed: boolean }> {
    const result = await super.commitBatch(request);
    if (result.committed && this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error('response lost');
    }
    return result;
  }
}

const profile = userLocalProfileId('learner');
const revision = 'a'.repeat(40);

function event(partId: string, at = '2026-08-24T10:00:00.000Z') {
  return {
    version: 1 as const,
    partId,
    outcome: 'incorrect' as const,
    contentId: revision,
    at,
  };
}

describe('LearningEventStore', () => {
  it('keeps the schema minimal and the Bank identity unambiguous', () => {
    expect(parseLearningEvent(event('q1-a'))).toEqual(event('q1-a'));
    expect(() => parseLearningEvent({ ...event('q1-a'), answer: 'secret' }))
      .toThrow('non-minimal');
    expect(() => parseLearningEvent({ ...event('q1-a'), contentId: 'b'.repeat(64) }))
      .toThrow('malformed');
  });

  it('atomically converges on a hard 500-row bound under concurrent writers', async () => {
    const storage = new AtomicMemoryStorage();
    const key = learningEventStorageKey(profile);
    const rows = Array.from({ length: MAX_LEARNING_EVENTS_PER_PROFILE - 1 }, (_, index) => ({
      eventId: String(index).padStart(4, '0'),
      event: event('part-' + index),
    }));
    await storage.set(STORAGE.learning, key, { version: 1, rows });
    const storeA = new LearningEventStore(storage);
    const storeB = new LearningEventStore(storage);

    await Promise.all([
      storeA.recordFirst(profile, 'zzzz', event('part-z')),
      storeB.recordFirst(profile, 'yyyy', event('part-y')),
    ]);

    const durable = await storage.get<{ rows: Array<{ eventId: string }> }>(STORAGE.learning, key);
    expect(durable?.rows).toHaveLength(MAX_LEARNING_EVENTS_PER_PROFILE);
    expect(durable?.rows.some((row) => row.eventId === 'yyyy')).toBe(true);
    expect(durable?.rows.some((row) => row.eventId === 'zzzz')).toBe(false);
    expect(await storage.keys(STORAGE.learning)).toEqual([key]);
  });

  it('confirms correction and diagnosis after a committed response is lost', async () => {
    const storage = new LostResponseStorage();
    const store = new LearningEventStore(storage);
    await store.recordFirst(profile, 'attempt-1', event('q1-a'));

    storage.loseNextResponse = true;
    await expect(store.recordCorrection(profile, 'attempt-1', 'correct'))
      .resolves.toMatchObject({ correctionOutcome: 'correct' });
    storage.loseNextResponse = true;
    await expect(store.recordDiagnosis(profile, 'attempt-1', 'algebra'))
      .resolves.toMatchObject({ errorCode: 'algebra' });

    expect(await store.recommendEvents(profile)).toEqual([
      expect.objectContaining({
        partId: 'q1-a',
        outcome: 'incorrect',
        correctionOutcome: 'correct',
        errorCode: 'algebra',
        contentId: revision,
      }),
    ]);
  });

  it('is idempotent but rejects reuse for different learning evidence', async () => {
    const storage = new AtomicMemoryStorage();
    const store = new LearningEventStore(storage);
    await store.recordFirst(profile, 'attempt-1', event('q1-a'));
    await expect(store.recordFirst(profile, 'attempt-1', event('q1-a'))).resolves.toBeUndefined();
    await expect(store.recordFirst(profile, 'attempt-1', event('q2-a')))
      .rejects.toThrow('identity was reused');
  });
});
