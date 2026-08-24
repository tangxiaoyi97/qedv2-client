import { describe, expect, it } from 'vitest';
import {
  AttemptOutbox,
  LocalProfileStore,
  RegistrationIntentConflictError,
  RegistrationJournal,
  STORAGE,
  type StorageAddress,
  type StorageBatchCommit,
  type StoragePort,
  type StorageVersionedEntry,
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
    return [...this.values.keys()].filter((key) => key.startsWith(prefix))
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

describe('RegistrationJournal', () => {
  it('persists one secret-free mutation id for one endpoint/account guest reservation', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const profile = (await profiles.initialize()).guestProfileId;
    const owner = await new AttemptOutbox(storage).captureGuestOwner();
    const journal = new RegistrationJournal(storage);

    const first = await journal.reserve({
      serverBaseUrl: 'HTTPS://SERVER.EXAMPLE:443/api/',
      username: ' Ada ',
      inviteCode: 'QED-SECRET-CODE',
      sourceProfileId: profile,
      sourceGuestGeneration: owner.guestGeneration!,
    });
    const retry = await journal.reserve({
      serverBaseUrl: 'https://server.example/api',
      username: 'ada',
      inviteCode: 'QED-SECRET-CODE',
      sourceProfileId: profile,
      sourceGuestGeneration: owner.guestGeneration!,
    });

    expect(retry).toEqual(first);
    expect(first.clientMutationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.stringify(first)).not.toContain('QED-SECRET-CODE');
    expect(JSON.stringify(first)).not.toContain('password');

    await expect(journal.reserve({
      serverBaseUrl: 'https://server.example/api',
      username: 'other',
      inviteCode: 'QED-OTHER-CODE',
      sourceProfileId: profile,
      sourceGuestGeneration: owner.guestGeneration!,
    })).rejects.toBeInstanceOf(RegistrationIntentConflictError);

    await journal.complete(first.clientMutationId);
    await expect(journal.pending()).resolves.toBeUndefined();
  });

  it('replays the original bucket after rotation without attaching the next guest', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const profile = (await profiles.initialize()).guestProfileId;
    const outbox = new AttemptOutbox(storage);
    const owner = await outbox.captureGuestOwner();
    const journal = new RegistrationJournal(storage);
    const original = await journal.reserve({
      serverBaseUrl: 'https://server.example',
      username: 'ada',
      inviteCode: 'QED-SECRET-CODE',
      sourceProfileId: profile,
      sourceGuestGeneration: owner.guestGeneration!,
    });
    await profiles.claimGuestForUser('another-account');

    const replay = await journal.reserve({
      serverBaseUrl: 'https://server.example',
      username: 'ada',
      inviteCode: 'QED-SECRET-CODE',
      sourceProfileId: profiles.snapshot().guestProfileId,
      sourceGuestGeneration: (await outbox.captureGuestOwner()).guestGeneration!,
    });

    expect(replay).toEqual(original);
    expect(replay.sourceProfileId).toBe(profile);
    expect(replay.sourceProfileId).not.toBe(profiles.snapshot().guestProfileId);
  });

  it('requires a successful response before an intent can name an account', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const profile = (await profiles.initialize()).guestProfileId;
    const owner = await new AttemptOutbox(storage).captureGuestOwner();
    const journal = new RegistrationJournal(storage);
    const reserved = await journal.reserve({
      serverBaseUrl: 'https://server.example',
      username: 'ada',
      inviteCode: 'QED-SECRET-CODE',
      sourceProfileId: profile,
      sourceGuestGeneration: owner.guestGeneration!,
    });

    expect(reserved.status).toBe('reserved');
    expect(reserved.destinationUserId).toBeUndefined();
    const redeemed = await journal.markRedeemed(reserved.clientMutationId, 'account-1');
    expect(redeemed).toMatchObject({ status: 'redeemed', destinationUserId: 'account-1' });
    await expect(journal.markRedeemed(reserved.clientMutationId, 'account-2'))
      .rejects.toThrow('different account');
  });
});
