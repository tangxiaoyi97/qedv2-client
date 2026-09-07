import { describe, expect, it } from 'vitest';
import { AiCache, CACHE_MAX_AGE_MS, MAX_CACHED_ANSWERS } from '../src/store/ai-cache.js';
import {
  AiCredentialTestJournal,
  parsePendingAiCredentialTest,
} from '../src/store/ai-credential-test-journal.js';
import { AiRequestGenerationJournal } from '../src/store/ai-request-generation-journal.js';
import {
  STORAGE,
  type StorageAddress,
  type StorageBatchCommit,
  type StoragePort,
  type StorageVersionedEntry,
} from '../src/ports/index.js';

/** In-memory StoragePort — the cache's only dependency. */
function memoryStorage(): StoragePort {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(ns: string, key: string) => data.get(`${ns}/${key}`) as T | undefined,
    set: async (ns: string, key: string, value: unknown) => {
      data.set(`${ns}/${key}`, value);
    },
    delete: async (ns: string, key: string) => {
      data.delete(`${ns}/${key}`);
    },
    keys: async (ns: string) => [...data.keys()]
      .filter((key) => key.startsWith(`${ns}/`))
      .map((key) => key.slice(ns.length + 1)),
    clear: async () => data.clear(),
  } as unknown as StoragePort;
}

class AtomicMemoryStorage implements StoragePort {
  protected readonly values = new Map<string, unknown>();
  protected readonly revisions = new Map<string, number>();

  protected id(collection: string, key: string): string {
    return `${collection}\0${key}`;
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
    const prefix = `${collection}\0`;
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
        ...(value === undefined ? {} : { value }),
      };
    });
  }
  async commitBatch(request: StorageBatchCommit): Promise<{ committed: boolean }> {
    if (request.ifRevisions.some((condition) =>
      (this.revisions.get(this.id(condition.collection, condition.key)) ?? 0) !== condition.revision)) {
      return { committed: false };
    }
    for (const mutation of request.mutations) {
      if (mutation.operation === 'set') await this.set(mutation.collection, mutation.key, mutation.value);
      else await this.delete(mutation.collection, mutation.key);
    }
    return { committed: true };
  }
}

class PausingPruneStorage extends AtomicMemoryStorage {
  private pause = false;
  private releasePause!: () => void;
  private startedPause!: () => void;
  readonly pruneStarted = new Promise<void>((resolve) => { this.startedPause = resolve; });
  private readonly resume = new Promise<void>((resolve) => { this.releasePause = resolve; });

  pauseNextPrune(): void {
    this.pause = true;
  }

  resumePrune(): void {
    this.releasePause();
  }

  override async keys(collection: string): Promise<string[]> {
    if (collection === STORAGE.aiCache && this.pause) {
      this.pause = false;
      this.startedPause();
      await this.resume;
    }
    return super.keys(collection);
  }
}

class PausingSetStorage extends AtomicMemoryStorage {
  private paused = false;
  private releasePause!: () => void;
  private startedPause!: () => void;
  readonly setStarted = new Promise<void>((resolve) => { this.startedPause = resolve; });
  private readonly resume = new Promise<void>((resolve) => { this.releasePause = resolve; });

  resumeSet(): void {
    this.releasePause();
  }

  override async commitBatch(request: StorageBatchCommit): Promise<{ committed: boolean }> {
    if (!this.paused && request.mutations.some((mutation) => mutation.key.startsWith('answer-v4/'))) {
      this.paused = true;
      this.startedPause();
      await this.resume;
    }
    return super.commitBatch(request);
  }
}

class PausingLegacyMigrationStorage extends AtomicMemoryStorage {
  private pause = false;
  private releasePause!: () => void;
  private startedPause!: () => void;
  readonly migrationStarted = new Promise<void>((resolve) => { this.startedPause = resolve; });
  private readonly resume = new Promise<void>((resolve) => { this.releasePause = resolve; });

  pauseMigration(): void {
    this.pause = true;
  }

  resumeMigration(): void {
    this.releasePause();
  }

  override async get<T>(collection: string, key: string): Promise<T | undefined> {
    if (
      collection === STORAGE.aiCache
      && key.startsWith('answer-cache-meta-v4/')
      && this.pause
    ) {
      this.pause = false;
      this.startedPause();
      await this.resume;
    }
    return super.get<T>(collection, key);
  }
}

class FailFirstBetaDeleteStorage extends AtomicMemoryStorage {
  private failed = false;

  override async delete(collection: string, key: string): Promise<void> {
    if (collection === STORAGE.aiCache && key === 'answers' && !this.failed) {
      this.failed = true;
      throw new Error('transient delete failure');
    }
    await super.delete(collection, key);
  }
}

/**
 * Every AI call costs money and the same question gets revisited. The cache
 * used to be a Map inside the store, so a reload bought the answer again.
 */
describe('AiCache', () => {
  it('returns what it stored', async () => {
    const cache = new AiCache(memoryStorage());
    await cache.set('k', { markdown: 'weil …' });
    expect(await cache.get('k')).toEqual({ markdown: 'weil …' });
  });

  it('misses on an unknown key rather than guessing', async () => {
    expect(await new AiCache(memoryStorage()).get('nope')).toBeUndefined();
  });

  it('replaces rather than duplicating the same key', async () => {
    const cache = new AiCache(memoryStorage());
    await cache.set('k', 'first');
    await cache.set('k', 'second');
    expect(await cache.get('k')).toBe('second');
    expect(await cache.size()).toBe(1);
  });

  it('expires an answer older than the window', async () => {
    // Prompts and models move on; a year-old explanation is not worth replaying.
    const cache = new AiCache(memoryStorage());
    const then = new Date('2026-01-01T00:00:00Z');
    await cache.set('k', 'stale', then);
    const later = new Date(then.getTime() + CACHE_MAX_AGE_MS + 1000);
    expect(await cache.get('k', later)).toBeUndefined();
    expect(await cache.get('k', new Date(then.getTime() + 1000))).toBe('stale');
  });

  it('treats a backwards clock as a miss, not as fresh', async () => {
    const cache = new AiCache(memoryStorage());
    const now = new Date('2026-06-01T00:00:00Z');
    await cache.set('k', 'v', now);
    expect(await cache.get('k', new Date(now.getTime() - 60_000))).toBeUndefined();
  });

  it('stays bounded, dropping the oldest', async () => {
    // One document, rewritten on every miss — unbounded makes each new answer
    // O(n) work.
    const cache = new AiCache(memoryStorage());
    for (let i = 0; i < MAX_CACHED_ANSWERS + 10; i += 1) await cache.set(`k${i}`, i);
    expect(await cache.size()).toBe(MAX_CACHED_ANSWERS);
    expect(await cache.get('k0')).toBeUndefined();
    expect(await cache.get(`k${MAX_CACHED_ANSWERS + 9}`)).toBe(MAX_CACHED_ANSWERS + 9);
  });

  it('forgets everything on request', async () => {
    const cache = new AiCache(memoryStorage());
    await cache.set('k', 'v');
    await cache.clear();
    expect(await cache.size()).toBe(0);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('clears only the selected account scope', async () => {
    const cache = new AiCache(new AtomicMemoryStorage());
    await cache.set('same-request', 'account A', new Date(), 'scope-a');
    await cache.set('same-request', 'account B', new Date(), 'scope-b');

    await cache.clear('scope-a');

    expect(await cache.get('same-request', new Date(), 'scope-a')).toBeUndefined();
    expect(await cache.get('same-request', new Date(), 'scope-b')).toBe('account B');
    expect(await cache.size('scope-a')).toBe(0);
    expect(await cache.size('scope-b')).toBe(1);
  });

  it('keeps the original expiry when an exact v3 entry is migrated into a scope', async () => {
    const storage = new AtomicMemoryStorage();
    const then = new Date('2026-01-01T00:00:00.000Z');
    await storage.set(STORAGE.aiCache, 'answer-cache-meta-v3', { version: 1, epoch: 0 });
    await storage.set(STORAGE.aiCache, 'answer-v3/k', {
      version: 3,
      epoch: 0,
      key: 'k',
      payload: 'paid answer',
      storedAt: then.toISOString(),
    });
    const cache = new AiCache(storage);
    const nearExpiry = new Date(then.getTime() + CACHE_MAX_AGE_MS - 1_000);
    expect(await cache.get('k', nearExpiry, 'scope-a')).toBe('paid answer');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await storage.get(STORAGE.aiCache, 'answer-v4/scope-a/k')) break;
      await Promise.resolve();
    }

    expect(await cache.get(
      'k',
      new Date(then.getTime() + CACHE_MAX_AGE_MS + 1_000),
      'scope-a',
    )).toBeUndefined();
  });

  it('does not migrate a legacy paid answer across a scoped clear', async () => {
    const storage = new PausingLegacyMigrationStorage();
    const then = new Date('2026-08-24T00:00:00.000Z');
    await storage.set(STORAGE.aiCache, 'answer-cache-meta-v3', { version: 1, epoch: 0 });
    await storage.set(STORAGE.aiCache, 'answer-v3/k', {
      version: 3,
      epoch: 0,
      key: 'k',
      payload: 'legacy private answer',
      storedAt: then.toISOString(),
    });
    const oldWindow = new AiCache(storage);
    const clearingWindow = new AiCache(storage);
    storage.pauseMigration();

    await expect(oldWindow.get('k', then, 'scope-a')).resolves.toBe('legacy private answer');
    await storage.migrationStarted;
    await clearingWindow.clear('scope-a');
    storage.resumeMigration();
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();

    await expect(clearingWindow.get('k', then, 'scope-a')).resolves.toBeUndefined();
    await expect(storage.get(STORAGE.aiCache, 'answer-v4/scope-a/k')).resolves.toBeUndefined();
  });

  it('retries beta-cache deletion after a transient storage failure', async () => {
    const storage = new FailFirstBetaDeleteStorage();
    await storage.set(STORAGE.aiCache, 'answers', [{ key: 'legacy-secret' }]);
    const cache = new AiCache(storage);

    await expect(cache.get('k')).rejects.toThrow('transient delete failure');
    await expect(cache.clear()).resolves.toBeUndefined();
    await expect(storage.get(STORAGE.aiCache, 'answers')).resolves.toBeUndefined();
  });

  it('never lets an old prune delete the same key written after clear', async () => {
    const storage = new PausingPruneStorage();
    const oldWindow = new AiCache(storage);
    const newWindow = new AiCache(storage);
    storage.pauseNextPrune();
    const oldWrite = oldWindow.set('same', 'old');
    await storage.pruneStarted;

    await newWindow.clear();
    await newWindow.set('same', 'new');
    storage.resumePrune();
    await oldWrite;

    expect(await newWindow.get('same')).toBe('new');
  });

  it('never lets an in-flight response reappear after clear has completed', async () => {
    const storage = new PausingSetStorage();
    const oldWindow = new AiCache(storage);
    const clearingWindow = new AiCache(storage);
    const oldWrite = oldWindow.set('same', 'private answer', new Date(), 'scope-a');
    await storage.setStarted;

    await clearingWindow.clear('scope-a');
    storage.resumeSet();

    await expect(oldWrite).rejects.toThrow('cache was cleared');
    await expect(clearingWindow.get('same', new Date(), 'scope-a')).resolves.toBeUndefined();
    await expect(clearingWindow.size('scope-a')).resolves.toBe(0);
  });

  it('rejects a response whose provider started before another window cleared', async () => {
    const storage = new AtomicMemoryStorage();
    const requestingWindow = new AiCache(storage);
    const clearingWindow = new AiCache(storage);
    const token = await requestingWindow.captureWriteToken('scope-a');

    await clearingWindow.clear('scope-a');

    await expect(requestingWindow.set(
      'same',
      'late private answer',
      new Date(),
      'scope-a',
      token,
    )).rejects.toThrow('cache was cleared');
    await expect(clearingWindow.get('same', new Date(), 'scope-a')).resolves.toBeUndefined();
  });
});

describe('AiCredentialTestJournal', () => {
  const fingerprint = 'a'.repeat(64);
  const firstRequest = {
    clientRequestId: '3b241101-e2bb-4255-8caf-4136c566a962',
    interactionId: '4c352212-f3cc-4366-9db0-5247d677b073',
    taskVersion: 'capability-test.v1',
    preferPool: false as const,
  };

  it('keeps one opaque identity until that exact request is cleared', async () => {
    const storage = memoryStorage();
    const first = new AiCredentialTestJournal(storage);
    const pending = await first.getOrCreate(fingerprint, firstRequest);
    const afterReload = new AiCredentialTestJournal(storage);
    const reused = await afterReload.getOrCreate(fingerprint, {
      ...firstRequest,
      clientRequestId: '5d463323-a4dd-4477-8ec1-6358e788c184',
    });
    expect(reused.request).toEqual(pending.request);

    await afterReload.clear(fingerprint, pending.request.clientRequestId);
    const next = await afterReload.getOrCreate(fingerprint, {
      ...firstRequest,
      clientRequestId: '5d463323-a4dd-4477-8ec1-6358e788c184',
    });
    expect(next.request.clientRequestId).not.toBe(pending.request.clientRequestId);
  });

  it('rejects secrets or response material in the pending document', () => {
    expect(() => parsePendingAiCredentialTest({
      version: 1,
      fingerprint,
      request: { ...firstRequest, apiKey: 'secret' },
      createdAt: '2026-08-24T00:00:00.000Z',
    })).toThrow('malformed');
  });

  it('clears only one credential fingerprint and preserves another account receipt', async () => {
    const storage = new AtomicMemoryStorage();
    const journal = new AiCredentialTestJournal(storage);
    const otherFingerprint = 'b'.repeat(64);
    await journal.getOrCreate(fingerprint, firstRequest);
    await journal.complete(fingerprint, {
      ok: true,
      provider: 'openai',
      model: 'gpt-test',
      source: 'byo',
      taskVersion: firstRequest.taskVersion,
      clientRequestId: firstRequest.clientRequestId,
      interactionId: firstRequest.interactionId,
      accounting: 'settled',
    });
    const other = await journal.getOrCreate(otherFingerprint, {
      ...firstRequest,
      clientRequestId: '5d463323-a4dd-4477-8ec1-6358e788c184',
    });

    await journal.clearFingerprint(fingerprint);

    await expect(journal.completed(fingerprint)).resolves.toBeUndefined();
    await expect(journal.getOrCreate(otherFingerprint, firstRequest)).resolves.toEqual(other);
  });
});

describe('AiRequestGenerationJournal', () => {
  it('survives reload and converges simultaneous explicit requests on one generation', async () => {
    const storage = new AtomicMemoryStorage();
    const fingerprint = 'b'.repeat(64);
    const first = new AiRequestGenerationJournal(storage);
    const initial = await first.current(fingerprint);
    expect(initial).toMatchObject({ version: 2, generation: 0 });
    const identities = await Promise.all([
      first.advance(fingerprint, 0),
      new AiRequestGenerationJournal(storage).advance(fingerprint, 0),
    ]);
    expect(identities[0]).toEqual(identities[1]);
    expect(identities[0]).toMatchObject({ version: 2, generation: 1 });
    expect(identities[0]!.clientRequestId).not.toBe(initial.clientRequestId);
    expect(await new AiRequestGenerationJournal(storage).current(fingerprint)).toEqual(identities[0]);
  });

  it('requires observing the last generation before a later explicit request', async () => {
    const storage = new AtomicMemoryStorage();
    const fingerprint = 'c'.repeat(64);
    const journal = new AiRequestGenerationJournal(storage);
    await journal.advance(fingerprint, 0);
    await journal.advance(fingerprint, 1);

    await expect(journal.advance(fingerprint, 0)).rejects.toThrow('stale');
    await expect(journal.current(fingerprint)).resolves.toMatchObject({ generation: 2 });
  });

  it('fails closed on a pre-random paid-request journal row', async () => {
    const storage = new AtomicMemoryStorage();
    const fingerprint = 'd'.repeat(64);
    await storage.set(STORAGE.aiCache, `paid-request-generation/v1/${fingerprint}`, {
      version: 1,
      generation: 0,
    });

    await expect(new AiRequestGenerationJournal(storage).current(fingerprint)).rejects.toThrow(
      'identity is malformed',
    );
  });
});
