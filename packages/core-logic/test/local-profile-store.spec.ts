import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_GUEST_ATTEMPT_OWNER,
  archiveStorageKey,
  AttemptOutbox,
  historyStorageKey,
  HISTORY_EVENT_ROW_PREFIX,
  HistoryLog,
  GUEST_CLAIM_STORAGE_KEY,
  GUEST_ATTEMPT_OWNER,
  LOCAL_PROFILE_STATE_KEY,
  LocalProfileStore,
  STORAGE,
  userLocalProfileId,
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

class PrependingHistoryStorage extends AtomicMemoryStorage {
  private pendingPrepend: { key: string; row: unknown } | undefined;
  observedEventKeysBeforeRetry: string[] = [];

  prependWhenDeleting(key: string, row: unknown): void {
    this.pendingPrepend = { key, row };
  }

  override async commitBatch(request: StorageBatchCommit): Promise<{ committed: boolean }> {
    const pending = this.pendingPrepend;
    if (pending && request.mutations.some((mutation) =>
      mutation.collection === STORAGE.history
      && mutation.key === pending.key
      && mutation.operation === 'delete')) {
      this.pendingPrepend = undefined;
      this.observedEventKeysBeforeRetry = (await this.keys(STORAGE.history))
        .filter((key) => key.startsWith(HISTORY_EVENT_ROW_PREFIX));
      const current = await this.get<unknown[]>(STORAGE.history, pending.key);
      await this.set(STORAGE.history, pending.key, [pending.row, ...(current ?? [])]);
    }
    return super.commitBatch(request);
  }
}

describe('LocalProfileStore', () => {
  const validArchive = (
    entries: Array<{ partId: string; updatedAt: string; grading?: 'good' | 'meh' }> = [],
  ) => ({
    baseVersion: 4,
    content: {
      perPart: entries.map((entry) => ({
        partId: entry.partId,
        grading: entry.grading ?? 'good',
        starred: false,
        fsrs: {
          due: entry.updatedAt,
          stability: 1,
          difficulty: 5,
          reps: 1,
          lapses: 0,
          lastReview: entry.updatedAt,
        },
        updatedAt: entry.updatedAt,
      })),
      perCompetency: [],
    },
  });

  const validHistory = (clientAttemptId: string, gradedAt: string) => ({
    clientAttemptId,
    partId: `${clientAttemptId}-part`,
    questionId: `${clientAttemptId}-question`,
    verdict: 'correct' as const,
    awardedPoints: 1,
    maxPoints: 1,
    grading: 'good' as const,
    gradedAt,
  });

  it('atomically migrates the pre-2.2 shared documents to a guest profile', async () => {
    const storage = new AtomicMemoryStorage();
    const archive = { content: { perPart: [], perCompetency: [] }, baseVersion: 7 };
    const history = [{ clientAttemptId: 'attempt-1' }];
    await storage.set(STORAGE.archive, 'current', archive);
    await storage.set(STORAGE.history, 'log', history);

    const profiles = new LocalProfileStore(storage);
    const state = await profiles.initialize();

    expect(state.activeProfileId).toBe(state.guestProfileId);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(state.guestProfileId))).toEqual(archive);
    expect(await storage.get(STORAGE.history, historyStorageKey(state.guestProfileId))).toEqual(history);
    expect(await storage.get(STORAGE.archive, 'current')).toBeUndefined();
    expect(await storage.get(STORAGE.history, 'log')).toBeUndefined();
  });

  it('assigns an upgraded signed-in installation to that account', async () => {
    const storage = new AtomicMemoryStorage();
    await storage.set(STORAGE.archive, 'current', { marker: 'legacy' });
    const profiles = new LocalProfileStore(storage);

    const state = await profiles.initialize('account-1');
    expect(state.activeProfileId).toBe(userLocalProfileId('account-1'));
    expect(await storage.get(STORAGE.archive, archiveStorageKey(state.activeProfileId))).toEqual({
      marker: 'legacy',
    });

    await profiles.activateGuest();
    expect(await storage.get(STORAGE.archive, archiveStorageKey(profiles.current()))).toBeUndefined();
    await profiles.activateUser('account-1');
    expect(await storage.get(STORAGE.archive, archiveStorageKey(profiles.current()))).toEqual({
      marker: 'legacy',
    });
  });

  it('keeps ordinary account selection isolated and claims only explicitly', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const initial = await profiles.initialize();
    await storage.set(STORAGE.archive, archiveStorageKey(initial.guestProfileId), { marker: 'guest' });
    await storage.set(STORAGE.history, historyStorageKey(initial.guestProfileId), [{ marker: 'guest' }]);

    await profiles.activateUser('existing-account');
    expect(await storage.get(STORAGE.archive, archiveStorageKey(profiles.current()))).toBeUndefined();
    await profiles.activateGuest();
    expect(await storage.get(STORAGE.archive, archiveStorageKey(profiles.current()))).toEqual({
      marker: 'guest',
    });

    const claimed = await profiles.claimGuestForUser('new-account');
    expect(claimed.activeProfileId).toBe(userLocalProfileId('new-account'));
    expect(await storage.get(STORAGE.archive, archiveStorageKey(claimed.activeProfileId))).toEqual({
      marker: 'guest',
    });
    expect(await storage.get(STORAGE.history, historyStorageKey(initial.guestProfileId))).toEqual([
      { marker: 'guest' },
    ]);
    expect(await storage.get(
      STORAGE.history,
      historyStorageKey(claimed.activeProfileId),
    )).toBeUndefined();
    expect(claimed.guestProfileId).not.toBe(initial.guestProfileId);
    expect(profiles.resolve(initial.guestProfileId)).toBe(claimed.activeProfileId);
    expect(profiles.readableProfiles(claimed.activeProfileId)).toContain(initial.guestProfileId);
    await profiles.activateGuest();
    expect(await storage.get(STORAGE.archive, archiveStorageKey(profiles.current()))).toBeUndefined();
  });

  it('fails closed when a legacy migration destination already contains data', async () => {
    const storage = new AtomicMemoryStorage();
    const destination = userLocalProfileId('account-1');
    await storage.set(STORAGE.archive, 'current', { marker: 'legacy' });
    await storage.set(STORAGE.archive, archiveStorageKey(destination), { marker: 'existing' });

    const profiles = new LocalProfileStore(storage);
    await expect(profiles.initialize('account-1')).rejects.toThrow('destination is not empty');
    expect(await storage.get(STORAGE.archive, 'current')).toEqual({ marker: 'legacy' });
    expect(profiles.currentIfInitialized()).toBeUndefined();
  });

  it('recovers an invite claim after boot already selected the new account', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const guest = (await profiles.initialize()).guestProfileId;
    await storage.set(STORAGE.archive, archiveStorageKey(guest), { marker: 'guest' });

    await profiles.activateUser('new-account');
    const claimed = await profiles.claimGuestForUser('new-account');

    expect(await storage.get(STORAGE.archive, archiveStorageKey(claimed.activeProfileId))).toEqual({
      marker: 'guest',
    });
    expect(profiles.resolve(guest)).toBe(claimed.activeProfileId);
  });

  it('claims guest progress into a logically empty account archive without losing its server base', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const guest = (await profiles.initialize()).guestProfileId;
    const source = validArchive([{
      partId: 'q1-a',
      updatedAt: '2026-08-15T10:00:00.000Z',
    }]);
    await storage.set(STORAGE.archive, archiveStorageKey(guest), source);
    const account = userLocalProfileId('new-account');
    await storage.set(STORAGE.archive, archiveStorageKey(account), {
      baseVersion: 12,
      content: { perPart: [], perCompetency: [] },
    });
    await profiles.activateUser('new-account');

    await profiles.claimGuestForUser('new-account');

    expect(await storage.get<any>(STORAGE.archive, archiveStorageKey(account))).toMatchObject({
      baseVersion: 12,
      content: source.content,
    });
    expect(profiles.resolve(guest)).toBe(account);
  });

  it('does not let an older route to the same account block a later explicit guest claim', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const firstGuest = (await profiles.initialize()).guestProfileId;
    await profiles.claimGuestForUser('same-account');
    await new AttemptOutbox(storage).finishGuestClaim('same-account');
    expect(profiles.resolve(firstGuest)).toBe(userLocalProfileId('same-account'));

    await profiles.activateGuest();
    const secondGuest = profiles.current();
    const source = validArchive([{
      partId: 'second-guest-part',
      updatedAt: '2026-08-15T11:00:00.000Z',
    }]);
    await storage.set(STORAGE.archive, archiveStorageKey(secondGuest), source);
    await profiles.activateUser('same-account');

    await profiles.claimGuestForUser('same-account');

    expect(profiles.resolve(secondGuest)).toBe(userLocalProfileId('same-account'));
    expect(await storage.get(
      STORAGE.archive,
      archiveStorageKey(userLocalProfileId('same-account')),
    )).toMatchObject({ content: source.content });
  });

  it('does not rotate a second guest profile while the same claim is still pending', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const firstGuest = (await profiles.initialize()).guestProfileId;
    await storage.set(STORAGE.archive, archiveStorageKey(firstGuest), { marker: 'first' });
    const firstClaim = await profiles.claimGuestForUser('same-account');
    const nextGuest = firstClaim.guestProfileId;
    await storage.set(STORAGE.archive, archiveStorageKey(nextGuest), { marker: 'next' });

    const repeated = await profiles.claimGuestForUser('same-account');

    expect(repeated.guestProfileId).toBe(nextGuest);
    expect(repeated.routes).toEqual(firstClaim.routes);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(nextGuest)))
      .toEqual({ marker: 'next' });
  });

  it('does not claim a different guest generation than the one the user confirmed', async () => {
    const storage = new AtomicMemoryStorage();
    const first = new LocalProfileStore(storage);
    const expectedGuest = (await first.initialize()).guestProfileId;
    await storage.set(STORAGE.archive, archiveStorageKey(expectedGuest), { marker: 'expected' });
    const second = new LocalProfileStore(storage);
    await second.initialize();
    await second.claimGuestForUser('other-account');

    await expect(first.claimGuestForUser('wanted-account', expectedGuest))
      .rejects.toThrow('Guest profile changed');
    expect(second.resolve(expectedGuest)).toBe(userLocalProfileId('other-account'));
    expect(await storage.get(
      STORAGE.archive,
      archiveStorageKey(userLocalProfileId('wanted-account')),
    )).toBeUndefined();
  });

  it('quarantines an uncertain registration and rotates both guest identities', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const sourceProfileId = (await profiles.initialize()).guestProfileId;
    await storage.set(
      STORAGE.archive,
      archiveStorageKey(sourceProfileId),
      validArchive([{ partId: 'reserved-part', updatedAt: '2026-08-15T12:00:00.000Z' }]),
    );
    const outbox = new AttemptOutbox(storage);
    const owner = await outbox.captureGuestOwner();
    await outbox.enqueue(owner, {
      clientAttemptId: 'reserved-attempt',
      questionId: 'q1',
      partId: 'q1-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-08-15T12:00:00.000Z',
    });

    const next = await profiles.quarantineGuest(sourceProfileId, owner.guestGeneration!);
    expect(next.guestProfileId).not.toBe(sourceProfileId);
    expect(next.activeProfileId).toBe(next.guestProfileId);
    expect(next.recoveryProfileIds).toContain(sourceProfileId);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(sourceProfileId)))
      .toMatchObject({ content: { perPart: [expect.objectContaining({ partId: 'reserved-part' })] } });

    await outbox.claim(
      GUEST_ATTEMPT_OWNER,
      AMBIGUOUS_GUEST_ATTEMPT_OWNER,
      owner.guestGeneration,
    );
    await outbox.finishGuestClaim(AMBIGUOUS_GUEST_ATTEMPT_OWNER);
    expect(await outbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await outbox.count(AMBIGUOUS_GUEST_ATTEMPT_OWNER)).toBe(1);

    const repeated = await profiles.quarantineGuest(sourceProfileId, owner.guestGeneration!);
    expect(repeated.guestProfileId).toBe(next.guestProfileId);
  });

  it('keeps row history isolated while a claimed guest remains readable by its account', async () => {
    const storage = new AtomicMemoryStorage();
    const guest = (await new LocalProfileStore(storage).initialize()).guestProfileId;
    const account = userLocalProfileId('account-1');
    const other = userLocalProfileId('account-2');
    const entry = {
      clientAttemptId: 'history-profile-attempt',
      partId: 'part-1',
      questionId: 'question-1',
      verdict: 'correct' as const,
      awardedPoints: 1,
      maxPoints: 1,
      grading: 'good' as const,
      gradedAt: '2026-08-15T10:00:00.000Z',
    };
    await new HistoryLog(storage, guest).append(entry);

    await expect(new HistoryLog(storage, account).list()).resolves.toEqual([]);
    await expect(new HistoryLog(storage, other).list()).resolves.toEqual([]);
    await expect(new HistoryLog(storage, () => [account, guest]).list()).resolves.toEqual([entry]);
  });

  it('preserves byte-identical legacy attempts under strong occurrence identities', async () => {
    const storage = new AtomicMemoryStorage();
    const profile = userLocalProfileId('history-migration');
    const { clientAttemptId: _ignored, ...legacyEntry } = validHistory(
      'legacy-duplicate',
      '2026-08-15T10:00:00.000Z',
    );
    await storage.set(
      STORAGE.history,
      historyStorageKey(profile),
      [legacyEntry, legacyEntry, legacyEntry],
    );

    const log = new HistoryLog(storage, profile);
    await expect(log.list()).resolves.toEqual([legacyEntry, legacyEntry, legacyEntry]);
    const firstKeys = (await storage.keys(STORAGE.history))
      .filter((key) => key.startsWith(HISTORY_EVENT_ROW_PREFIX))
      .sort();
    expect(firstKeys).toHaveLength(3);
    expect(firstKeys.map((key) => decodeURIComponent(key.slice(key.lastIndexOf('/') + 1))))
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/^legacy-[0-9a-f]{64}-0000000000000000$/),
        expect.stringMatching(/^legacy-[0-9a-f]{64}-0000000000000001$/),
        expect.stringMatching(/^legacy-[0-9a-f]{64}-0000000000000002$/),
      ]));

    await expect(log.count()).resolves.toBe(3);
    expect((await storage.keys(STORAGE.history))
      .filter((key) => key.startsWith(HISTORY_EVENT_ROW_PREFIX))
      .sort()).toEqual(firstKeys);
  });

  it('keeps legacy identities stable when a 2.1 writer prepends during CAS migration', async () => {
    const storage = new PrependingHistoryStorage();
    const profile = userLocalProfileId('history-prepend-race');
    const sourceKey = historyStorageKey(profile);
    const { clientAttemptId: _ignored, ...legacyEntry } = validHistory(
      'legacy-race',
      '2026-08-15T10:00:00.000Z',
    );
    await storage.set(STORAGE.history, sourceKey, [legacyEntry, legacyEntry]);
    storage.prependWhenDeleting(sourceKey, legacyEntry);

    const log = new HistoryLog(storage, profile);
    await expect(log.list()).resolves.toEqual([legacyEntry, legacyEntry, legacyEntry]);
    const finalKeys = (await storage.keys(STORAGE.history))
      .filter((key) => key.startsWith(HISTORY_EVENT_ROW_PREFIX));
    expect(storage.observedEventKeysBeforeRetry).toHaveLength(2);
    expect(finalKeys).toHaveLength(3);
    expect(storage.observedEventKeysBeforeRetry.every((key) => finalKeys.includes(key))).toBe(true);
    expect(await storage.get(STORAGE.history, sourceKey)).toBeUndefined();

    await expect(log.count()).resolves.toBe(3);
    expect((await storage.keys(STORAGE.history))
      .filter((key) => key.startsWith(HISTORY_EVENT_ROW_PREFIX)).sort())
      .toEqual([...finalKeys].sort());
  });

  it('does not expose another tab profile before that tab observes the auth change', async () => {
    const storage = new AtomicMemoryStorage();
    const first = new LocalProfileStore(storage);
    const initial = await first.initialize();
    const second = new LocalProfileStore(storage);
    await second.initialize();

    await first.activateUser('account-1');
    await second.refresh();

    expect(first.current()).toBe(userLocalProfileId('account-1'));
    expect(second.current()).toBe(initial.guestProfileId);
  });

  it('quarantines ambiguous legacy documents when a 2.1 guest claim was interrupted', async () => {
    const storage = new AtomicMemoryStorage();
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: 'new-guest-generation',
      routes: [{ sourceGeneration: 'old-guest-generation', destinationUserId: 'new-account' }],
      pending: { sourceGeneration: 'old-guest-generation', destinationUserId: 'new-account' },
    });
    await storage.set(STORAGE.archive, 'current', { marker: 'mixed-legacy' });
    await storage.set(STORAGE.history, 'log', [{ marker: 'mixed-legacy' }]);

    const profiles = new LocalProfileStore(storage);
    const state = await profiles.initialize();
    expect(state.recoveryProfileIds).toHaveLength(1);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(state.guestProfileId)))
      .toBeUndefined();
    const recovery = state.recoveryProfileIds![0]!;
    expect(await storage.get(STORAGE.archive, archiveStorageKey(recovery)))
      .toEqual({ marker: 'mixed-legacy' });

    const claimed = await profiles.claimGuestForUser('new-account');
    expect(await storage.get(STORAGE.archive, archiveStorageKey(claimed.activeProfileId)))
      .toBeUndefined();
    expect(claimed.recoveryProfileIds).toContain(recovery);
  });

  it('assigns legacy documents when a verified stored account exactly matches the pending claim', async () => {
    const storage = new AtomicMemoryStorage();
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: 'new-guest-generation',
      routes: [{
        sourceGeneration: 'old-guest-generation',
        destinationUserId: 'scoped-account',
      }],
      pending: {
        sourceGeneration: 'old-guest-generation',
        destinationUserId: 'scoped-account',
      },
    });
    await storage.set(STORAGE.archive, 'current', { marker: 'verified-account' });

    const state = await new LocalProfileStore(storage).initialize('scoped-account');

    expect(state.activeProfileId).toBe(userLocalProfileId('scoped-account'));
    expect(state.recoveryProfileIds).toBeUndefined();
    expect(await storage.get(
      STORAGE.archive,
      archiveStorageKey(userLocalProfileId('scoped-account')),
    )).toEqual({ marker: 'verified-account' });
    expect(await storage.get(STORAGE.archive, 'current')).toBeUndefined();
  });

  it('quarantines legacy documents when the pending claim names a different account', async () => {
    const storage = new AtomicMemoryStorage();
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: 'new-guest-generation',
      routes: [{
        sourceGeneration: 'old-guest-generation',
        destinationUserId: 'other-account',
      }],
      pending: {
        sourceGeneration: 'old-guest-generation',
        destinationUserId: 'other-account',
      },
    });
    await storage.set(STORAGE.archive, 'current', { marker: 'must-not-cross-account' });

    const state = await new LocalProfileStore(storage).initialize('verified-account');

    expect(state.activeProfileId).toBe(userLocalProfileId('verified-account'));
    expect(state.recoveryProfileIds).toHaveLength(1);
    expect(await storage.get(
      STORAGE.archive,
      archiveStorageKey(userLocalProfileId('verified-account')),
    )).toBeUndefined();
    expect(await storage.get(
      STORAGE.archive,
      archiveStorageKey(state.recoveryProfileIds![0]!),
    )).toEqual({ marker: 'must-not-cross-account' });
  });

  it('preserves late 2.1 writes in a new recovery profile instead of the active account', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    const initial = await profiles.initialize('account-1');
    await storage.set(STORAGE.archive, 'current', { marker: 'late-old-tab' });
    await storage.set(STORAGE.history, 'log', [{ marker: 'late-old-tab' }]);

    const refreshed = await profiles.refresh();
    expect(await storage.get(STORAGE.archive, archiveStorageKey(initial.activeProfileId)))
      .toBeUndefined();
    expect(refreshed.recoveryProfileIds).toHaveLength(1);
    expect(await storage.get(
      STORAGE.archive,
      archiveStorageKey(refreshed.recoveryProfileIds![0]!),
    )).toEqual({ marker: 'late-old-tab' });
    expect(await storage.get(STORAGE.archive, 'current')).toBeUndefined();
    expect(await storage.get(STORAGE.history, 'log')).toBeUndefined();
  });

  it('compacts repeated late 2.1 snapshots into one durable quarantine profile', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    await profiles.initialize('account-1');
    const firstHistory = validHistory('old-1', '2026-08-15T10:00:00.000Z');
    await storage.set(STORAGE.archive, 'current', validArchive([{
      partId: 'q1-a',
      updatedAt: '2026-08-15T10:00:00.000Z',
    }]));
    await storage.set(STORAGE.history, 'log', [firstHistory]);

    const first = await profiles.refresh();
    const quarantine = first.legacyQuarantineProfileId!;
    const secondHistory = validHistory('old-2', '2026-08-15T11:00:00.000Z');
    await storage.set(STORAGE.archive, 'current', validArchive([
      {
        partId: 'q1-a',
        updatedAt: '2026-08-15T11:00:00.000Z',
        grading: 'meh',
      },
      { partId: 'q2-a', updatedAt: '2026-08-15T11:00:00.000Z' },
    ]));
    await storage.set(STORAGE.history, 'log', [secondHistory, firstHistory]);

    const second = await profiles.refresh();
    expect(second.recoveryProfileIds).toEqual([quarantine]);
    expect(second.legacyQuarantineProfileId).toBe(quarantine);
    expect(await storage.get<any>(STORAGE.archive, archiveStorageKey(quarantine))).toMatchObject({
      baseVersion: 0,
      content: {
        perPart: [
          { partId: 'q1-a', grading: 'meh' },
          { partId: 'q2-a', grading: 'good' },
        ],
      },
    });
    expect(await storage.get(STORAGE.history, historyStorageKey(quarantine)))
      .toEqual([secondHistory, firstHistory]);

    for (let index = 0; index < 130; index += 1) {
      await storage.set(STORAGE.history, 'log', [secondHistory, firstHistory]);
      await profiles.refresh();
    }
    expect(profiles.snapshot().recoveryProfileIds).toEqual([quarantine]);
  });

  it('keeps the maximum legacy history multiplicity across cumulative snapshots', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    await profiles.initialize('account-1');
    const { clientAttemptId: _firstId, ...repeated } = validHistory(
      'repeated',
      '2026-08-15T10:00:00.000Z',
    );
    const { clientAttemptId: _secondId, ...newest } = validHistory(
      'newest',
      '2026-08-15T11:00:00.000Z',
    );
    await storage.set(STORAGE.history, 'log', [repeated, repeated]);
    const first = await profiles.refresh();
    const quarantine = first.legacyQuarantineProfileId!;

    await storage.set(STORAGE.history, 'log', [newest, repeated, repeated, repeated]);
    await profiles.refresh();
    expect(await storage.get(STORAGE.history, historyStorageKey(quarantine)))
      .toEqual([newest, repeated, repeated, repeated]);

    // A stale cumulative writer with fewer copies must neither shrink the
    // retained maximum nor add its overlap again.
    await storage.set(STORAGE.history, 'log', [newest, repeated, repeated]);
    await profiles.refresh();
    expect(await storage.get(STORAGE.history, historyStorageKey(quarantine)))
      .toEqual([newest, repeated, repeated, repeated]);
  });

  it('leaves conflicting history identities on the legacy key', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    await profiles.initialize('account-1');
    const original = validHistory('same-attempt', '2026-08-15T10:00:00.000Z');
    await storage.set(STORAGE.history, 'log', [original]);
    const state = await profiles.refresh();
    const conflict = { ...original, questionId: 'different-question' };
    await storage.set(STORAGE.history, 'log', [conflict]);

    await expect(profiles.refresh()).rejects.toThrow('attempt:same-attempt conflicts');
    expect(await storage.get(STORAGE.history, 'log')).toEqual([conflict]);
    expect(await storage.get(
      STORAGE.history,
      historyStorageKey(state.legacyQuarantineProfileId!),
    )).toEqual([original]);
  });

  it('leaves a conflicting late archive on the legacy key instead of overwriting quarantine', async () => {
    const storage = new AtomicMemoryStorage();
    const profiles = new LocalProfileStore(storage);
    await profiles.initialize('account-1');
    const original = validArchive([{
      partId: 'q1-a',
      updatedAt: '2026-08-15T10:00:00.000Z',
      grading: 'good',
    }]);
    await storage.set(STORAGE.archive, 'current', original);
    const state = await profiles.refresh();
    const conflict = validArchive([{
      partId: 'q1-a',
      updatedAt: '2026-08-15T10:00:00.000Z',
      grading: 'meh',
    }]);
    await storage.set(STORAGE.archive, 'current', conflict);

    await expect(profiles.refresh()).rejects.toThrow('conflicts at the same timestamp');
    expect(await storage.get(STORAGE.archive, 'current')).toEqual(conflict);
    expect(await storage.get(
      STORAGE.archive,
      archiveStorageKey(state.legacyQuarantineProfileId!),
    )).toEqual({ ...original, baseVersion: 0 });
  });

  it('fails closed on conflicting profile routes', async () => {
    const storage = new AtomicMemoryStorage();
    const guest = 'guest:11111111-1111-4111-8111-111111111111' as const;
    await storage.set(STORAGE.app, LOCAL_PROFILE_STATE_KEY, {
      version: 1,
      activeProfileId: 'user:account-1',
      guestProfileId: 'guest:22222222-2222-4222-8222-222222222222',
      routes: [
        { sourceProfileId: guest, destinationProfileId: 'user:account-1' },
        { sourceProfileId: guest, destinationProfileId: 'user:account-2' },
      ],
    });

    await expect(new LocalProfileStore(storage).initialize('account-1'))
      .rejects.toThrow('malformed');
  });

  it('refuses a 129th recovery profile without consuming the late legacy source', async () => {
    const storage = new AtomicMemoryStorage();
    const recoveryProfileIds = Array.from({ length: 128 }, (_, index) =>
      `guest:00000000-0000-4000-8000-${String(index).padStart(12, '0')}` as const);
    await storage.set(STORAGE.app, LOCAL_PROFILE_STATE_KEY, {
      version: 1,
      activeProfileId: 'user:account-1',
      guestProfileId: 'guest:ffffffff-ffff-4fff-8fff-ffffffffffff',
      routes: [],
      recoveryProfileIds,
    });
    await storage.set(STORAGE.archive, 'current', { marker: 'must-survive' });

    await expect(new LocalProfileStore(storage).initialize('account-1'))
      .rejects.toThrow('Too many preserved legacy profiles');
    expect(await storage.get(STORAGE.archive, 'current')).toEqual({ marker: 'must-survive' });
    expect(await storage.get<{ recoveryProfileIds: unknown[] }>(
      STORAGE.app,
      LOCAL_PROFILE_STATE_KEY,
    )).toMatchObject({ recoveryProfileIds });
  });

  it('rejects a recovery profile that aliases the active guest', async () => {
    const storage = new AtomicMemoryStorage();
    const guest = 'guest:11111111-1111-4111-8111-111111111111';
    await storage.set(STORAGE.app, LOCAL_PROFILE_STATE_KEY, {
      version: 1,
      activeProfileId: guest,
      guestProfileId: guest,
      routes: [],
      recoveryProfileIds: [guest],
    });

    await expect(new LocalProfileStore(storage).initialize()).rejects.toThrow('malformed');
  });
});
