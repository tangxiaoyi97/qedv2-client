import { describe, expect, it } from 'vitest';
import {
  archiveStorageKey,
  ArchiveStore,
  guestLocalProfileId,
  LocalProfileStore,
  LOCAL_PROFILE_STATE_KEY,
  STORAGE,
  userLocalProfileId,
  type LocalArchive,
  type StorageAddress,
  type StorageBatchCommit,
  type StoragePort,
  type StorageVersionedEntry,
} from '../src/index.js';

class AtomicMemoryStorage implements StoragePort {
  readonly values = new Map<string, unknown>();
  readonly revisions = new Map<string, number>();
  beforeCommit: (() => Promise<void>) | undefined;
  afterReadBatch: ((addresses: readonly StorageAddress[]) => Promise<void>) | undefined;

  private id(address: StorageAddress): string {
    return `${address.collection}\0${address.key}`;
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    const value = this.values.get(this.id({ collection, key }));
    return value === undefined ? undefined : structuredClone(value) as T;
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
    const snapshots = addresses.map((address) => {
      const id = this.id(address);
      const value = this.values.get(id);
      return {
        ...address,
        revision: this.revisions.get(id) ?? 0,
        exists: value !== undefined,
        ...(value !== undefined ? { value: structuredClone(value) } : {}),
      };
    });
    const hook = this.afterReadBatch;
    this.afterReadBatch = undefined;
    if (hook) await hook(addresses);
    return snapshots;
  }

  async commitBatch(request: StorageBatchCommit): Promise<{ committed: boolean }> {
    const hook = this.beforeCommit;
    this.beforeCommit = undefined;
    if (hook) await hook();
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

const NOW = new Date('2026-08-15T12:00:00.000Z');

async function guestFixture(): Promise<{
  storage: AtomicMemoryStorage;
  profiles: LocalProfileStore;
  guest: ReturnType<typeof guestLocalProfileId>;
  store: ArchiveStore;
}> {
  const storage = new AtomicMemoryStorage();
  const profiles = new LocalProfileStore(storage);
  const guest = (await profiles.initialize()).guestProfileId;
  const store = new ArchiveStore(storage, guest);
  return { storage, profiles, guest, store };
}

describe('ArchiveStore profile-routing CAS', () => {
  it('retries setStarred against the claimed account instead of recreating the guest archive', async () => {
    const { storage, profiles, guest, store } = await guestFixture();
    await store.setStarred('existing', true, NOW);
    storage.beforeCommit = () => profiles.claimGuestForUser('new-user').then(() => undefined);

    const result = await store.setStarred('racing-star', true, NOW);
    const user = userLocalProfileId('new-user');

    expect(result.content.perPart.map((part) => part.partId)).toEqual([
      'existing',
      'racing-star',
    ]);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(guest))).toBeUndefined();
    expect(await storage.get<LocalArchive>(STORAGE.archive, archiveStorageKey(user)))
      .toEqual(result);
  });

  it('retries setGrading against the claimed account without losing the earlier archive', async () => {
    const { storage, profiles, guest, store } = await guestFixture();
    await store.setStarred('existing', true, NOW);
    storage.beforeCommit = () => profiles.claimGuestForUser('new-user').then(() => undefined);

    const result = await store.setGrading({
      partId: 'racing-grade',
      grading: 'good',
      now: NOW,
    });
    const user = userLocalProfileId('new-user');

    expect(result.content.perPart.map((part) => part.partId)).toEqual([
      'existing',
      'racing-grade',
    ]);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(guest))).toBeUndefined();
    expect(await storage.get<LocalArchive>(STORAGE.archive, archiveStorageKey(user)))
      .toEqual(result);
  });

  it('re-resolves load when a guest claim lands between route and archive reads', async () => {
    const { storage, profiles, guest, store } = await guestFixture();
    const expected = await store.setStarred('kept-after-claim', true, NOW);
    storage.afterReadBatch = async (addresses) => {
      expect(addresses).toEqual([{
        collection: STORAGE.app,
        key: LOCAL_PROFILE_STATE_KEY,
      }]);
      await profiles.claimGuestForUser('new-user');
    };

    await expect(store.load()).resolves.toEqual(expected);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(guest))).toBeUndefined();
    expect(await storage.get<LocalArchive>(
      STORAGE.archive,
      archiveStorageKey(userLocalProfileId('new-user')),
    )).toEqual(expected);
  });

  it('retries saveIfUnchanged when a guest claim wins its archive commit race', async () => {
    const { storage, profiles, guest, store } = await guestFixture();
    const expected = await store.setStarred('before-sync', true, NOW);
    const next: LocalArchive = {
      ...expected,
      baseVersion: expected.baseVersion + 1,
    };
    storage.beforeCommit = () => profiles.claimGuestForUser('new-user').then(() => undefined);

    await expect(store.saveIfUnchanged(expected, next)).resolves.toBe(true);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(guest))).toBeUndefined();
    expect(await storage.get<LocalArchive>(
      STORAGE.archive,
      archiveStorageKey(userLocalProfileId('new-user')),
    )).toEqual(next);
  });

  it('fails closed for a bound profile without valid durable profile state', async () => {
    const storage = new AtomicMemoryStorage();
    const profile = guestLocalProfileId('11111111-1111-4111-8111-111111111111');
    const store = new ArchiveStore(storage, profile);

    await expect(store.load()).rejects.toThrow('Local profile state is missing');
    await storage.set(STORAGE.app, LOCAL_PROFILE_STATE_KEY, { version: 99 });
    await expect(store.setStarred('must-not-write', true, NOW))
      .rejects.toThrow('Local profile state is malformed');
    expect(await storage.keys(STORAGE.archive)).toEqual([]);
  });

  it('keeps the pre-profile archive path available when no profile is bound', async () => {
    const storage = new AtomicMemoryStorage();
    const store = new ArchiveStore(storage);

    const archive = await store.setStarred('legacy-star', true, NOW);

    await expect(store.load()).resolves.toEqual(archive);
    expect(await storage.get(STORAGE.archive, 'current')).toEqual(archive);
  });
});
