import { describe, expect, it } from 'vitest';
import {
  STORAGE,
  SyncMutationJournal,
  type ArchiveContent,
  type StorageAddress,
  type StorageBatchCommit,
  type StoragePort,
  type StorageVersionedEntry,
  type SyncMutationIntent,
  type SyncMutationScope,
} from '../src/index.js';

class AtomicMemoryStorage implements StoragePort {
  private readonly values = new Map<string, unknown>();
  private readonly revisions = new Map<string, number>();

  private id(address: StorageAddress): string {
    return `${address.collection}\0${address.key}`;
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.values.get(this.id({ collection, key })) as T | undefined;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    const id = this.id({ collection, key });
    this.values.set(id, value);
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
    return addresses.map((address) => {
      const id = this.id(address);
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
    if (request.ifRevisions.some(
      (condition) => (this.revisions.get(this.id(condition)) ?? 0) !== condition.revision,
    )) return { committed: false };
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

const SCOPE: SyncMutationScope = {
  serverBaseUrl: 'https://sync.example.test/api',
  userId: 'user-1',
};

const EMPTY: ArchiveContent = { perPart: [], perCompetency: [] };

function syncIntent(
  fingerprint = 'v1-2-deadbeef',
  baseVersion = 2,
  localArchive: ArchiveContent = EMPTY,
): SyncMutationIntent {
  return { operation: 'sync', fingerprint, baseVersion, localArchive };
}

function resolveIntent(
  fingerprint = 'v1-7-resolved',
  expectedLocalFingerprint = 'v1-4-local',
): SyncMutationIntent {
  return {
    operation: 'resolve',
    fingerprint,
    baseServerVersion: 7,
    resolvedArchive: EMPTY,
    expectedLocalFingerprint,
  };
}

describe('SyncMutationJournal v2', () => {
  it('survives response loss and a process restart with the exact wire intent', async () => {
    const storage = new AtomicMemoryStorage();
    const firstProcess = new SyncMutationJournal(storage);
    const first = await firstProcess.getOrCreate(
      { serverBaseUrl: 'HTTPS://SYNC.EXAMPLE.TEST:443/api/', userId: 'user-1' },
      syncIntent(),
      new Date('2026-08-15T12:00:00.000Z'),
    );

    const restartedProcess = new SyncMutationJournal(storage);
    const retry = await restartedProcess.getOrCreate(SCOPE, syncIntent());
    expect(retry).toEqual(first);
    expect(retry).toMatchObject({
      version: 2,
      operation: 'sync',
      fingerprint: 'v1-2-deadbeef',
      intent: { baseVersion: 2, localArchive: EMPTY },
      createdAt: '2026-08-15T12:00:00.000Z',
    });
    expect(first.clientMutationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await restartedProcess.listPending(SCOPE)).toEqual([first]);

    await restartedProcess.complete(
      SCOPE,
      'sync',
      first.fingerprint,
      first.clientMutationId,
    );
    expect(await restartedProcess.listPending(SCOPE)).toEqual([]);
    const next = await restartedProcess.getOrCreate(SCOPE, syncIntent());
    expect(next.clientMutationId).not.toBe(first.clientMutationId);
  });

  it('isolates canonical server endpoints and users without leaking identities in keys', async () => {
    const storage = new AtomicMemoryStorage();
    const journal = new SyncMutationJournal(storage);
    const primary = await journal.getOrCreate(SCOPE, syncIntent());
    const canonicalAlias = await journal.getOrCreate(
      { serverBaseUrl: 'HTTPS://SYNC.EXAMPLE.TEST:443/api/', userId: 'user-1' },
      syncIntent(),
    );
    const otherEndpoint = await journal.getOrCreate(
      { serverBaseUrl: 'https://other.example.test/api', userId: 'user-1' },
      syncIntent(),
    );
    const otherUser = await journal.getOrCreate(
      { serverBaseUrl: SCOPE.serverBaseUrl, userId: 'user-2' },
      syncIntent(),
    );

    expect(canonicalAlias.clientMutationId).toBe(primary.clientMutationId);
    expect(new Set([
      primary.clientMutationId,
      otherEndpoint.clientMutationId,
      otherUser.clientMutationId,
    ])).toHaveLength(3);
    const keys = await storage.keys(STORAGE.app);
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).toMatch(/^sync-mutation\/v2\/[0-9a-f]{64}\/sync\/[0-9a-f]{64}$/);
      expect(key).not.toContain('user-');
      expect(key).not.toContain('example');
      expect(key).not.toContain('deadbeef');
    }
  });

  it('fails closed when one fingerprint is reused for a different exact intent', async () => {
    const journal = new SyncMutationJournal(new AtomicMemoryStorage());
    await journal.getOrCreate(SCOPE, syncIntent('same-fingerprint', 2));
    await expect(journal.getOrCreate(SCOPE, syncIntent('same-fingerprint', 3))).rejects.toThrow(
      'already bound to a different intent',
    );

    await journal.getOrCreate(SCOPE, resolveIntent('same-resolve', 'local-a'));
    await expect(
      journal.getOrCreate(SCOPE, resolveIntent('same-resolve', 'local-b')),
    ).rejects.toThrow('already bound to a different intent');
  });

  it('persists canonical archive bytes and rejects malformed archive intent', async () => {
    const journal = new SyncMutationJournal(new AtomicMemoryStorage());
    const unsorted: ArchiveContent = {
      perPart: [{
        partId: 'part-b',
        grading: 'good',
        starred: false,
        fsrs: {
          due: '2026-08-15T14:00:00+02:00',
          stability: 1.12345678,
          difficulty: 2,
          reps: 1,
          lapses: 0,
          lastReview: null,
        },
        updatedAt: '2026-08-15T14:00:00+02:00',
      }, {
        partId: 'part-a',
        grading: null,
        starred: true,
        fsrs: {
          due: '2026-08-15T12:00:00Z',
          stability: 1,
          difficulty: 2,
          reps: 0,
          lapses: 0,
          lastReview: null,
        },
        updatedAt: '2026-08-15T12:00:00Z',
      }],
      perCompetency: [],
    };
    const record = await journal.getOrCreate(SCOPE, syncIntent('canonical', 4, unsorted));
    expect(record.operation).toBe('sync');
    if (record.operation !== 'sync') throw new Error('expected sync record');
    expect(record.intent.localArchive.perPart.map((entry) => entry.partId)).toEqual([
      'part-a',
      'part-b',
    ]);
    expect(record.intent.localArchive.perPart[1]?.fsrs.stability).toBe(1.123457);
    expect(record.intent.localArchive.perPart[1]?.updatedAt).toBe('2026-08-15T12:00:00.000Z');

    await expect(journal.getOrCreate(SCOPE, {
      operation: 'sync',
      fingerprint: 'malformed',
      baseVersion: 0,
      localArchive: {
        perPart: [{ partId: 'missing-fields' }] as unknown as ArchiveContent['perPart'],
        perCompetency: [],
      },
    })).rejects.toThrow('invalid shape');
  });

  it('lists only one scope in a stable createdAt/operation/fingerprint order', async () => {
    const journal = new SyncMutationJournal(new AtomicMemoryStorage());
    await journal.getOrCreate(
      SCOPE,
      syncIntent('z-last'),
      new Date('2026-08-15T12:00:02.000Z'),
    );
    await journal.getOrCreate(
      SCOPE,
      syncIntent('z-sync'),
      new Date('2026-08-15T12:00:01.000Z'),
    );
    await journal.getOrCreate(
      SCOPE,
      resolveIntent('a-resolve'),
      new Date('2026-08-15T12:00:01.000Z'),
    );
    await journal.getOrCreate(
      { ...SCOPE, userId: 'someone-else' },
      syncIntent('not-listed'),
      new Date('2026-08-15T11:00:00.000Z'),
    );

    expect((await journal.listPending(SCOPE)).map((record) => record.fingerprint)).toEqual([
      'a-resolve',
      'z-sync',
      'z-last',
    ]);
  });

  it('keeps completion compare-and-swap safe against a stale acknowledgement', async () => {
    const journal = new SyncMutationJournal(new AtomicMemoryStorage());
    const current = await journal.getOrCreate(SCOPE, syncIntent('archive'));
    await journal.complete(
      SCOPE,
      'sync',
      current.fingerprint,
      '00000000-0000-4000-8000-000000000000',
    );
    expect(await journal.getOrCreate(SCOPE, syncIntent('archive'))).toEqual(current);
  });

  it('detects persisted intent corruption before reusing or listing a mutation', async () => {
    const storage = new AtomicMemoryStorage();
    const journal = new SyncMutationJournal(storage);
    await journal.getOrCreate(SCOPE, syncIntent('tamper-check', 2));
    const [key] = await storage.keys(STORAGE.app);
    if (!key) throw new Error('missing journal key');
    const stored = await storage.get<Record<string, unknown>>(STORAGE.app, key);
    if (!stored) throw new Error('missing journal record');
    await storage.set(STORAGE.app, key, {
      ...stored,
      intent: { baseVersion: 3, localArchive: EMPTY },
    });

    await expect(journal.getOrCreate(SCOPE, syncIntent('tamper-check', 2))).rejects.toThrow(
      'integrity check failed',
    );
    await expect(journal.listPending(SCOPE)).rejects.toThrow('integrity check failed');
  });

  it('preserves ambiguous v1 records for recovery without blocking v2 reconciliation', async () => {
    const storage = new AtomicMemoryStorage();
    await storage.set(
      STORAGE.app,
      'sync-mutation/v1/user-1/sync/v1-2-deadbeef',
      {
        version: 1,
        operation: 'sync',
        fingerprint: 'v1-2-deadbeef',
        clientMutationId: '00000000-0000-4000-8000-000000000000',
        createdAt: '2026-08-15T12:00:00.000Z',
      },
    );
    const journal = new SyncMutationJournal(storage);
    await expect(journal.listPending(SCOPE)).resolves.toEqual([]);
    const current = await journal.getOrCreate(SCOPE, syncIntent());
    expect(current.version).toBe(2);
    expect(await storage.get(
      STORAGE.app,
      'sync-mutation/v1/user-1/sync/v1-2-deadbeef',
    )).toBeDefined();
  });
});
