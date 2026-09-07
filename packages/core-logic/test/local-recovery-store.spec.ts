import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_GUEST_ATTEMPT_OWNER,
  AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER,
  ATTEMPT_OUTBOX_STORAGE_KEY,
  AttemptOutbox,
  GUEST_CLAIM_STORAGE_KEY,
  GUEST_ATTEMPT_OWNER,
  HistoryLog,
  LocalRecoveryStore,
  LOCAL_PROFILE_STATE_KEY,
  LocalProfileStore,
  STORAGE,
  archiveStorageKey,
  attemptOutboxRowKey,
  historyStorageKey,
  historyEventRowKey,
  type LocalArchive,
  type LocalProfileId,
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
    if (addresses.length > 32) throw new Error('readBatch limit exceeded');
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

class RecoveryReplyLossStorage extends AtomicMemoryStorage {
  private loseReply: 'phase-one' | 'finish' | undefined;

  loseNextRecoveryReply(phase: 'phase-one' | 'finish' = 'phase-one'): void {
    this.loseReply = phase;
  }

  override async commitBatch(request: StorageBatchCommit): Promise<{ committed: boolean }> {
    const result = await super.commitBatch(request);
    if (
      result.committed
      && this.loseReply
      && (this.loseReply === 'phase-one'
        ? request.mutations.some((mutation) =>
          mutation.collection === STORAGE.app && mutation.key === LOCAL_PROFILE_STATE_KEY)
          && request.mutations.some((mutation) =>
            mutation.collection === STORAGE.history && mutation.key === GUEST_CLAIM_STORAGE_KEY)
        : request.mutations.some((mutation) =>
          mutation.collection === STORAGE.history
          && mutation.key === GUEST_CLAIM_STORAGE_KEY
          && mutation.operation === 'set'
          && !(mutation.value as { pending?: unknown }).pending
          && !(mutation.value as { legacyRecovery?: unknown }).legacyRecovery))
    ) {
      this.loseReply = undefined;
      throw new Error('simulated lost native reply');
    }
    return result;
  }
}

class CrashBeforeRecoveryRowsOutbox extends AttemptOutbox {
  private crash = true;

  override async claim(
    sourceUserId: string,
    destinationUserId: string,
    sourceGuestGeneration?: string,
  ): Promise<number> {
    if (this.crash) {
      this.crash = false;
      throw new Error('simulated crash after recovery ownership commit');
    }
    return super.claim(sourceUserId, destinationUserId, sourceGuestGeneration);
  }
}

class TargetArchiveRaceStorage extends AtomicMemoryStorage {
  private injected = false;

  constructor(
    private readonly targetArchiveKey: string,
    private readonly concurrentArchive: LocalArchive,
  ) {
    super();
  }

  override async commitBatch(request: StorageBatchCommit): Promise<{ committed: boolean }> {
    const bindsLegacyRecovery = request.mutations.some((mutation) =>
      mutation.collection === STORAGE.history
      && mutation.key === GUEST_CLAIM_STORAGE_KEY
      && mutation.operation === 'set'
      && !!(mutation.value as { legacyRecovery?: unknown }).legacyRecovery);
    if (bindsLegacyRecovery && !this.injected) {
      this.injected = true;
      await this.set(STORAGE.archive, this.targetArchiveKey, this.concurrentArchive);
    }
    return super.commitBatch(request);
  }
}

class ClaimBindingBarrierStorage extends AtomicMemoryStorage {
  private arrivals = 0;
  private releaseBarrier: (() => void) | undefined;
  private readonly barrier = new Promise<void>((resolve) => {
    this.releaseBarrier = resolve;
  });

  override async commitBatch(request: StorageBatchCommit): Promise<{ committed: boolean }> {
    const bindsLegacyRecovery = request.mutations.some((mutation) =>
      mutation.collection === STORAGE.history
      && mutation.key === GUEST_CLAIM_STORAGE_KEY
      && mutation.operation === 'set'
      && !!(mutation.value as { legacyRecovery?: unknown }).legacyRecovery);
    if (bindsLegacyRecovery) {
      this.arrivals += 1;
      if (this.arrivals === 2) this.releaseBarrier?.();
      await this.barrier;
    }
    return super.commitBatch(request);
  }
}

const recoveryProfile = 'guest:11111111-1111-4111-8111-111111111111' as LocalProfileId;
const guestProfile = 'guest:22222222-2222-4222-8222-222222222222' as LocalProfileId;

function archive(partId = 'q1-a'): LocalArchive {
  return {
    baseVersion: 0,
    content: {
      perPart: [{
        partId,
        grading: 'good',
        starred: false,
        fsrs: {
          due: '2026-08-16T10:00:00.000Z',
          stability: 1,
          difficulty: 5,
          reps: 1,
          lapses: 0,
          lastReview: '2026-08-15T10:00:00.000Z',
        },
        lastResult: {
          correct: true,
          awardedPoints: 1,
          gradedAt: '2026-08-15T10:00:00.000Z',
        },
        updatedAt: '2026-08-15T10:00:00.000Z',
      }],
      perCompetency: [],
    },
  };
}

const history = [{
  clientAttemptId: 'attempt-1',
  partId: 'q1-a',
  questionId: 'q1',
  verdict: 'correct',
  awardedPoints: 1,
  maxPoints: 1,
  grading: 'good',
  gradedAt: '2026-08-15T10:00:00.000Z',
}];

async function seedState(storage: AtomicMemoryStorage): Promise<void> {
  await storage.set(STORAGE.app, LOCAL_PROFILE_STATE_KEY, {
    version: 1,
    activeProfileId: guestProfile,
    guestProfileId: guestProfile,
    routes: [],
    recoveryProfileIds: [recoveryProfile],
    legacyQuarantineProfileId: recoveryProfile,
  });
}

describe('LocalRecoveryStore', () => {
  it('recovers a matching issuer-less 2.1 claim without assigning the fresh guest', async () => {
    const storage = new RecoveryReplyLossStorage();
    const rawUserId = 'raw-user';
    const scopedUserId = 'account-v1-scoped-user';
    const targetProfile = `user:${scopedUserId}` as LocalProfileId;
    const oldGeneration = 'old-guest-generation';
    const freshGeneration = 'fresh-guest-generation';
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: freshGeneration,
      routes: [{ sourceGeneration: oldGeneration, destinationUserId: rawUserId }],
      pending: { sourceGeneration: oldGeneration, destinationUserId: rawUserId },
      legacyOwner: { ownerId: AMBIGUOUS_GUEST_ATTEMPT_OWNER },
    });
    await storage.set(STORAGE.archive, 'current', archive('legacy-account-part'));
    await storage.set(STORAGE.history, 'log', history);
    const rawAttempt = {
      userId: rawUserId,
      attempt: {
        clientAttemptId: 'issuer-less-account-attempt',
        questionId: 'q1',
        partId: 'q1-a',
        correct: true,
        awardedPoints: 1,
        gradedAt: '2026-08-15T10:00:00.000Z',
      },
    };
    const freshAttempt = {
      userId: GUEST_ATTEMPT_OWNER,
      guestGeneration: freshGeneration,
      attempt: {
        ...rawAttempt.attempt,
        clientAttemptId: 'fresh-guest-attempt',
      },
    };
    const oldGuestAttempt = {
      userId: GUEST_ATTEMPT_OWNER,
      guestGeneration: oldGeneration,
      attempt: {
        ...rawAttempt.attempt,
        clientAttemptId: 'old-guest-attempt',
      },
    };
    const existingAmbiguousAttempt = {
      userId: AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER,
      attempt: {
        ...rawAttempt.attempt,
        questionId: 'different-question',
      },
    };
    const legacyArrayAttempt = {
      userId: rawUserId,
      attempt: {
        ...rawAttempt.attempt,
        clientAttemptId: 'legacy-array-account-attempt',
      },
    };
    await storage.set(STORAGE.history, ATTEMPT_OUTBOX_STORAGE_KEY, [legacyArrayAttempt]);
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(rawUserId, rawAttempt.attempt.clientAttemptId),
      rawAttempt,
    );
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(
        AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER,
        existingAmbiguousAttempt.attempt.clientAttemptId,
      ),
      existingAmbiguousAttempt,
    );
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(GUEST_ATTEMPT_OWNER, freshAttempt.attempt.clientAttemptId),
      freshAttempt,
    );
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(GUEST_ATTEMPT_OWNER, oldGuestAttempt.attempt.clientAttemptId),
      oldGuestAttempt,
    );

    // Boot has no issuer for the 2.1 bearer. It must start a fresh guest and
    // quarantine the global documents before a later verified login exists.
    const profiles = new LocalProfileStore(storage);
    const booted = await profiles.initialize();
    const freshGuestProfile = booted.guestProfileId;
    const quarantinedProfile = booted.legacyQuarantineProfileId!;
    expect(booted.activeProfileId).toBe(freshGuestProfile);
    expect(quarantinedProfile).not.toBe(freshGuestProfile);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(quarantinedProfile)))
      .toEqual(archive('legacy-account-part'));

    // A later login proves the same raw remote user under one exact issuer.
    await profiles.activateUser(scopedUserId);
    const outbox = new AttemptOutbox(storage);
    const recovery = new LocalRecoveryStore(storage, outbox);
    const inventory = await recovery.inventory(targetProfile);
    expect(inventory.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'quarantine',
        profileId: quarantinedProfile,
        attemptCount: 1,
        assignment: { safe: true },
      }),
      expect.objectContaining({
        kind: 'unclaimed-guest',
        profileId: freshGuestProfile,
        attemptCount: 1,
        assignment: { safe: false, reason: 'pending-guest-claim' },
      }),
    ]));
    storage.loseNextRecoveryReply();
    await recovery.assignLegacyPendingAccount(
      quarantinedProfile,
      targetProfile,
      {
        legacyUserId: rawUserId,
        scopedUserId,
        sourceGeneration: oldGeneration,
      },
    );

    expect(await storage.get(STORAGE.archive, archiveStorageKey(targetProfile)))
      .toEqual(archive('legacy-account-part'));
    expect(await storage.get(STORAGE.history, historyStorageKey(targetProfile))).toBeUndefined();
    expect(await storage.get(STORAGE.history, historyStorageKey(quarantinedProfile)))
      .toEqual(history);
    const durableProfiles = await storage.get<{
      guestProfileId: LocalProfileId;
      routes: Array<{ sourceProfileId: LocalProfileId; destinationProfileId: LocalProfileId }>;
      recoveryProfileIds?: LocalProfileId[];
      legacyQuarantineProfileId?: LocalProfileId;
    }>(STORAGE.app, LOCAL_PROFILE_STATE_KEY);
    expect(durableProfiles?.guestProfileId).toBe(freshGuestProfile);
    expect(durableProfiles?.routes).not.toContainEqual({
      sourceProfileId: freshGuestProfile,
      destinationProfileId: targetProfile,
    });
    expect(durableProfiles?.routes).toContainEqual({
      sourceProfileId: quarantinedProfile,
      destinationProfileId: targetProfile,
    });
    expect(durableProfiles?.recoveryProfileIds).toBeUndefined();
    expect(durableProfiles?.legacyQuarantineProfileId).toBeUndefined();

    expect(await outbox.pendingGuestClaimRoute()).toBeUndefined();
    expect(await outbox.guestClaimRouteForUser(scopedUserId)).toEqual({
      sourceGeneration: oldGeneration,
      destinationUserId: scopedUserId,
    });
    // A quarantine-key collision preserves both byte-distinct rows. The raw
    // row remains export-only and is still never treated as this Server's row.
    expect(await outbox.count(rawUserId)).toBe(1);
    expect(await outbox.list(scopedUserId)).toEqual([oldGuestAttempt.attempt]);
    expect(await outbox.list(AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER))
      .toEqual(expect.arrayContaining([
        legacyArrayAttempt.attempt,
        existingAmbiguousAttempt.attempt,
      ]));
    expect(await outbox.list(GUEST_ATTEMPT_OWNER)).toEqual([freshAttempt.attempt]);
    const restartedProfiles = new LocalProfileStore(storage);
    await restartedProfiles.initialize(scopedUserId);
    const recoveredHistory = new HistoryLog(storage, () => restartedProfiles.readableProfiles());
    expect(await recoveredHistory.list()).toEqual(history);
    await expect(recovery.export(targetProfile)).resolves.toMatchObject({
      ambiguousAccountAttempts: expect.arrayContaining([
        existingAmbiguousAttempt,
        rawAttempt,
        expect.objectContaining({
          userId: AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER,
          attempt: expect.objectContaining({
            clientAttemptId: legacyArrayAttempt.attempt.clientAttemptId,
          }),
        }),
      ]),
    });

    // Clearing O must release the marker while preserving N for a later invite.
    await outbox.beginGuestClaim('future-account');
    expect(await outbox.pendingGuestClaimRoute()).toEqual({
      sourceGeneration: freshGeneration,
      destinationUserId: 'future-account',
    });
    expect(await outbox.list(GUEST_ATTEMPT_OWNER)).toEqual([freshAttempt.attempt]);
  });

  it('treats a lost Phase 3 reply as an idempotent completed recovery', async () => {
    const storage = new RecoveryReplyLossStorage();
    const rawUserId = 'raw-user';
    const scopedUserId = `account-v1-${'d'.repeat(64)}`;
    const targetProfile = `user:${scopedUserId}` as LocalProfileId;
    const sourceGeneration = 'old-guest-generation';
    await seedState(storage);
    await storage.set(STORAGE.archive, archiveStorageKey(recoveryProfile), archive());
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: 'fresh-guest-generation',
      routes: [{ sourceGeneration, destinationUserId: rawUserId }],
      pending: { sourceGeneration, destinationUserId: rawUserId },
      legacyOwner: { ownerId: AMBIGUOUS_GUEST_ATTEMPT_OWNER },
    });
    storage.loseNextRecoveryReply('finish');
    const outbox = new AttemptOutbox(storage);

    await expect(new LocalRecoveryStore(storage, outbox).assignLegacyPendingAccount(
      recoveryProfile,
      targetProfile,
      { legacyUserId: rawUserId, scopedUserId, sourceGeneration },
    )).resolves.toBeUndefined();

    expect(await outbox.pendingLegacyAccountRecovery()).toBeUndefined();
    expect(await outbox.pendingGuestClaimRoute()).toBeUndefined();
    expect(await outbox.guestClaimRouteForUser(scopedUserId)).toEqual({
      sourceGeneration,
      destinationUserId: scopedUserId,
    });
    await outbox.beginGuestClaim('future-account');
    expect(await outbox.pendingGuestClaim()).toBe('future-account');
  });

  it('keeps the scoped marker and routed documents when an O attempt conflicts', async () => {
    const storage = new AtomicMemoryStorage();
    const rawUserId = 'raw-user';
    const scopedUserId = 'account-v1-scoped-user';
    const targetProfile = `user:${scopedUserId}` as LocalProfileId;
    const sourceGeneration = 'old-guest-generation';
    await seedState(storage);
    await storage.set(STORAGE.archive, archiveStorageKey(recoveryProfile), archive());
    await storage.set(STORAGE.history, historyStorageKey(recoveryProfile), history);
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: 'fresh-guest-generation',
      routes: [{ sourceGeneration, destinationUserId: rawUserId }],
      pending: { sourceGeneration, destinationUserId: rawUserId },
      legacyOwner: { ownerId: AMBIGUOUS_GUEST_ATTEMPT_OWNER },
    });
    const sourceAttempt = {
      userId: GUEST_ATTEMPT_OWNER,
      guestGeneration: sourceGeneration,
      attempt: {
        clientAttemptId: 'same-attempt',
        questionId: 'old-question',
        partId: 'old-part',
        correct: true,
        awardedPoints: 1,
        gradedAt: '2026-08-15T10:00:00.000Z',
      },
    };
    const destinationAttempt = {
      userId: scopedUserId,
      attempt: {
        ...sourceAttempt.attempt,
        questionId: 'different-question',
      },
    };
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(GUEST_ATTEMPT_OWNER, 'same-attempt'),
      sourceAttempt,
    );
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(scopedUserId, 'same-attempt'),
      destinationAttempt,
    );
    const outbox = new AttemptOutbox(storage);
    const recovery = new LocalRecoveryStore(storage, outbox);

    await expect(recovery.assignLegacyPendingAccount(
      recoveryProfile,
      targetProfile,
      { legacyUserId: rawUserId, scopedUserId, sourceGeneration },
    )).rejects.toThrow('without a conflict');

    expect(await outbox.pendingGuestClaimRoute()).toBeUndefined();
    expect(await outbox.pendingLegacyAccountRecovery()).toEqual({
      sourceGeneration,
      sourceProfileId: recoveryProfile,
      legacyUserId: rawUserId,
      scopedUserId,
    });
    expect(await outbox.guestGenerationCount(sourceGeneration)).toBe(1);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(recoveryProfile)))
      .toBeUndefined();
    expect(await storage.get(STORAGE.archive, archiveStorageKey(targetProfile))).toEqual(archive());
    const durableState = await storage.get<{
      routes: Array<{ sourceProfileId: LocalProfileId; destinationProfileId: LocalProfileId }>;
      recoveryProfileIds?: LocalProfileId[];
    }>(STORAGE.app, LOCAL_PROFILE_STATE_KEY);
    expect(durableState?.recoveryProfileIds).toBeUndefined();
    expect(durableState?.routes).toContainEqual({
      sourceProfileId: recoveryProfile,
      destinationProfileId: targetProfile,
    });
    await expect(recovery.inventory(targetProfile)).resolves.toMatchObject({
      profiles: [{
        profileId: recoveryProfile,
        attemptCount: 1,
        assignment: { safe: true },
      }],
    });
  });

  it('resumes a durable scoped binding after a process restart and rejects another scope', async () => {
    const storage = new AtomicMemoryStorage();
    const rawUserId = 'raw-user';
    const scopedA = `account-v1-${'a'.repeat(64)}`;
    const scopedB = `account-v1-${'b'.repeat(64)}`;
    const targetA = `user:${scopedA}` as LocalProfileId;
    const targetB = `user:${scopedB}` as LocalProfileId;
    const sourceGeneration = 'old-guest-generation';
    await seedState(storage);
    await storage.set(STORAGE.archive, archiveStorageKey(recoveryProfile), archive());
    await storage.set(STORAGE.history, historyStorageKey(recoveryProfile), history);
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: 'fresh-guest-generation',
      routes: [{ sourceGeneration, destinationUserId: rawUserId }],
      pending: { sourceGeneration, destinationUserId: rawUserId },
      legacyOwner: { ownerId: AMBIGUOUS_GUEST_ATTEMPT_OWNER },
    });
    const oldAttempt = {
      userId: GUEST_ATTEMPT_OWNER,
      guestGeneration: sourceGeneration,
      attempt: {
        clientAttemptId: 'old-attempt',
        questionId: 'q1',
        partId: 'q1-a',
        correct: true,
        awardedPoints: 1,
        gradedAt: '2026-08-15T10:00:00.000Z',
      },
    };
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(GUEST_ATTEMPT_OWNER, oldAttempt.attempt.clientAttemptId),
      oldAttempt,
    );
    const firstProcessOutbox = new CrashBeforeRecoveryRowsOutbox(storage);
    const firstProcess = new LocalRecoveryStore(storage, firstProcessOutbox);
    await expect(firstProcess.assignLegacyPendingAccount(
      recoveryProfile,
      targetA,
      { legacyUserId: rawUserId, scopedUserId: scopedA, sourceGeneration },
    )).rejects.toThrow('simulated crash');
    expect(await firstProcessOutbox.pendingGuestClaimRoute()).toBeUndefined();
    expect(await firstProcessOutbox.pendingLegacyAccountRecovery()).toEqual({
      sourceGeneration,
      sourceProfileId: recoveryProfile,
      legacyUserId: rawUserId,
      scopedUserId: scopedA,
    });
    expect(await storage.get(STORAGE.archive, archiveStorageKey(recoveryProfile))).toBeUndefined();
    expect(await storage.get(STORAGE.history, historyStorageKey(recoveryProfile))).toEqual(history);

    // Cloud sync or another window may append to the now-owned target before
    // restart. Resumption must never re-run the empty-target transfer or
    // overwrite either write.
    const targetAfterCrash: LocalArchive = {
      baseVersion: 3,
      content: {
        perPart: [
          ...archive().content.perPart,
          ...archive('new-after-bind').content.perPart,
        ],
        perCompetency: [],
      },
    };
    await storage.set(STORAGE.archive, archiveStorageKey(targetA), targetAfterCrash);
    await storage.set(STORAGE.history, historyEventRowKey('target-after-bind', targetA), {
      version: 2,
      profileId: targetA,
      entry: {
        ...history[0],
        clientAttemptId: 'target-after-bind',
        partId: 'new-after-bind',
      },
    });

    // New store instances model a full renderer/process rebuild.
    const sameScope = new LocalRecoveryStore(storage, new AttemptOutbox(storage));
    const otherScope = new LocalRecoveryStore(storage, new AttemptOutbox(storage));
    await expect(sameScope.inventory(targetA)).resolves.toMatchObject({
      profiles: [{ profileId: recoveryProfile, assignment: { safe: true } }],
    });
    await expect(otherScope.inventory(targetB)).resolves.toMatchObject({
      profiles: [{
        profileId: recoveryProfile,
        assignment: { safe: false, reason: 'recovery-bound-other-server' },
      }],
    });
    await expect(otherScope.assignLegacyPendingAccount(
      recoveryProfile,
      targetB,
      { legacyUserId: rawUserId, scopedUserId: scopedB, sourceGeneration },
    )).rejects.toThrow('another Server');
    expect(await new AttemptOutbox(storage).count(scopedB)).toBe(0);

    await sameScope.assignLegacyPendingAccount(
      recoveryProfile,
      targetA,
      { legacyUserId: rawUserId, scopedUserId: scopedA, sourceGeneration },
    );
    const durableOutbox = new AttemptOutbox(storage);
    expect(await durableOutbox.list(scopedA)).toEqual([oldAttempt.attempt]);
    expect(await durableOutbox.count(scopedB)).toBe(0);
    expect(await durableOutbox.pendingLegacyAccountRecovery()).toBeUndefined();
    expect(await storage.get(STORAGE.archive, archiveStorageKey(targetA))).toEqual(targetAfterCrash);
    expect(await storage.get(STORAGE.history, historyStorageKey(recoveryProfile))).toEqual(history);
  });

  it('has zero recovery side effects when the target changes before Phase 1 commits', async () => {
    const rawUserId = 'raw-user';
    const scopedUserId = `account-v1-${'c'.repeat(64)}`;
    const targetProfile = `user:${scopedUserId}` as LocalProfileId;
    const concurrentTarget = archive('concurrent-target');
    const storage = new TargetArchiveRaceStorage(
      archiveStorageKey(targetProfile),
      concurrentTarget,
    );
    const sourceGeneration = 'old-guest-generation';
    await seedState(storage);
    await storage.set(STORAGE.archive, archiveStorageKey(recoveryProfile), archive());
    await storage.set(STORAGE.history, historyStorageKey(recoveryProfile), history);
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: 'fresh-guest-generation',
      routes: [{ sourceGeneration, destinationUserId: rawUserId }],
      pending: { sourceGeneration, destinationUserId: rawUserId },
      legacyOwner: { ownerId: AMBIGUOUS_GUEST_ATTEMPT_OWNER },
    });
    const oldAttempt = {
      userId: GUEST_ATTEMPT_OWNER,
      guestGeneration: sourceGeneration,
      attempt: {
        clientAttemptId: 'old-raced-attempt',
        questionId: 'q1',
        partId: 'q1-a',
        correct: true,
        awardedPoints: 1,
        gradedAt: '2026-08-15T10:00:00.000Z',
      },
    };
    const rawAttempt = {
      userId: rawUserId,
      attempt: { ...oldAttempt.attempt, clientAttemptId: 'raw-raced-attempt' },
    };
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(GUEST_ATTEMPT_OWNER, oldAttempt.attempt.clientAttemptId),
      oldAttempt,
    );
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(rawUserId, rawAttempt.attempt.clientAttemptId),
      rawAttempt,
    );
    const outbox = new AttemptOutbox(storage);
    const recovery = new LocalRecoveryStore(storage, outbox);

    await expect(recovery.assignLegacyPendingAccount(
      recoveryProfile,
      targetProfile,
      { legacyUserId: rawUserId, scopedUserId, sourceGeneration },
    )).rejects.toThrow('not empty');

    expect(await storage.get(STORAGE.archive, archiveStorageKey(targetProfile)))
      .toEqual(concurrentTarget);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(recoveryProfile)))
      .toEqual(archive());
    expect(await storage.get(STORAGE.history, historyStorageKey(recoveryProfile))).toEqual(history);
    expect(await outbox.pendingLegacyAccountRecovery()).toBeUndefined();
    expect(await outbox.pendingGuestClaimRoute()).toEqual({
      sourceGeneration,
      destinationUserId: rawUserId,
    });
    expect(await outbox.guestGenerationCount(sourceGeneration)).toBe(1);
    expect(await outbox.count(rawUserId)).toBe(1);
    expect(await outbox.count(scopedUserId)).toBe(0);
    expect(await outbox.count(AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER)).toBe(0);
    await expect(recovery.inventory(targetProfile)).resolves.toMatchObject({
      profiles: [{ assignment: { safe: false, reason: 'target-not-empty' } }],
    });
  });

  it('lets only one endpoint scope cross the claim-state CAS barrier', async () => {
    const storage = new ClaimBindingBarrierStorage();
    const rawUserId = 'raw-user';
    const scopedA = `account-v1-${'a'.repeat(64)}`;
    const scopedB = `account-v1-${'b'.repeat(64)}`;
    const targetA = `user:${scopedA}` as LocalProfileId;
    const targetB = `user:${scopedB}` as LocalProfileId;
    const sourceGeneration = 'old-guest-generation';
    await seedState(storage);
    await storage.set(STORAGE.archive, archiveStorageKey(recoveryProfile), archive());
    await storage.set(STORAGE.history, historyStorageKey(recoveryProfile), history);
    await storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
      version: 1,
      currentGeneration: 'fresh-guest-generation',
      routes: [{ sourceGeneration, destinationUserId: rawUserId }],
      pending: { sourceGeneration, destinationUserId: rawUserId },
      legacyOwner: { ownerId: AMBIGUOUS_GUEST_ATTEMPT_OWNER },
    });
    const oldAttempt = {
      userId: GUEST_ATTEMPT_OWNER,
      guestGeneration: sourceGeneration,
      attempt: {
        clientAttemptId: 'raced-attempt',
        questionId: 'q1',
        partId: 'q1-a',
        correct: true,
        awardedPoints: 1,
        gradedAt: '2026-08-15T10:00:00.000Z',
      },
    };
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(GUEST_ATTEMPT_OWNER, oldAttempt.attempt.clientAttemptId),
      oldAttempt,
    );
    const recoveryA = new LocalRecoveryStore(storage, new AttemptOutbox(storage));
    const recoveryB = new LocalRecoveryStore(storage, new AttemptOutbox(storage));

    const results = await Promise.allSettled([
      recoveryA.assignLegacyPendingAccount(
        recoveryProfile,
        targetA,
        { legacyUserId: rawUserId, scopedUserId: scopedA, sourceGeneration },
      ),
      recoveryB.assignLegacyPendingAccount(
        recoveryProfile,
        targetB,
        { legacyUserId: rawUserId, scopedUserId: scopedB, sourceGeneration },
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const durableOutbox = new AttemptOutbox(storage);
    const attemptsA = await durableOutbox.list(scopedA);
    const attemptsB = await durableOutbox.list(scopedB);
    expect([attemptsA.length, attemptsB.length].sort()).toEqual([0, 1]);
    expect([...attemptsA, ...attemptsB]).toEqual([oldAttempt.attempt]);
    const winner = attemptsA.length === 1
      ? { scoped: scopedA, target: targetA, loser: targetB }
      : { scoped: scopedB, target: targetB, loser: targetA };
    expect(await durableOutbox.guestClaimRouteForUser(winner.scoped)).toEqual({
      sourceGeneration,
      destinationUserId: winner.scoped,
    });
    expect(await durableOutbox.guestGenerationCount(sourceGeneration)).toBe(0);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(winner.target))).toEqual(archive());
    expect(await storage.get(STORAGE.archive, archiveStorageKey(winner.loser))).toBeUndefined();
    expect(await storage.get(STORAGE.history, historyStorageKey(recoveryProfile))).toEqual(history);
    expect(await storage.get(STORAGE.history, historyStorageKey(winner.target))).toBeUndefined();
    expect(await storage.get(STORAGE.history, historyStorageKey(winner.loser))).toBeUndefined();
  });

  it('inventories and exports isolated profiles plus ambiguous attempts without assigning them', async () => {
    const storage = new AtomicMemoryStorage();
    await seedState(storage);
    await storage.set(STORAGE.archive, archiveStorageKey(recoveryProfile), archive());
    await storage.set(STORAGE.history, historyStorageKey(recoveryProfile), history);
    const ambiguous = {
      userId: AMBIGUOUS_GUEST_ATTEMPT_OWNER,
      attempt: {
        clientAttemptId: 'ambiguous-1',
        questionId: 'q1',
        partId: 'q1-a',
        correct: true,
        awardedPoints: 1,
        gradedAt: '2026-08-15T10:00:00.000Z',
      },
    };
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(AMBIGUOUS_GUEST_ATTEMPT_OWNER, 'ambiguous-1'),
      ambiguous,
    );
    const corruptKey = attemptOutboxRowKey('broken-owner', 'broken-attempt');
    const corruptValue = {
      userId: 'broken-owner',
      attempt: { clientAttemptId: 'broken-attempt', gradedAt: 'not-a-date' },
    };
    await storage.set(STORAGE.history, corruptKey, corruptValue);
    const legacySyncKey = 'sync-mutation/v1/legacy-user/sync/archive';
    const legacySyncValue = { version: 1, clientMutationId: 'unreplayable' };
    await storage.set(STORAGE.app, legacySyncKey, legacySyncValue);

    const recovery = new LocalRecoveryStore(storage);
    await expect(recovery.inventory(guestProfile)).resolves.toMatchObject({
      totalCount: 4,
      profileCount: 1,
      ambiguousAttemptCount: 1,
      ambiguousAccountAttemptCount: 0,
      corruptAttemptCount: 1,
      legacySyncMutationCount: 1,
      orphanedPracticeSessionCount: 0,
      profiles: [{
        profileId: recoveryProfile,
        hasArchive: true,
        historyCount: 1,
        assignment: { safe: true },
      }],
    });
    const exported = await recovery.export();
    expect(exported.format).toBe('qed2-local-recovery.v1');
    expect(exported.profiles[0]).toMatchObject({
      profileId: recoveryProfile,
      archive: archive(),
      history,
    });
    expect(exported.ambiguousAttempts).toEqual([ambiguous]);
    expect(exported.corruptAttempts).toEqual([{
      key: corruptKey,
      source: 'v2-row',
      reason: expect.any(String),
      value: corruptValue,
    }]);
    expect(exported.legacySyncMutations).toEqual([{
      key: legacySyncKey,
      value: legacySyncValue,
    }]);
    expect(JSON.stringify(exported)).not.toContain('token');
  });

  it('atomically moves a valid recovery profile only into an empty target', async () => {
    const storage = new AtomicMemoryStorage();
    await seedState(storage);
    await storage.set(STORAGE.archive, archiveStorageKey(recoveryProfile), archive());
    await storage.set(STORAGE.history, historyStorageKey(recoveryProfile), history);
    const recovery = new LocalRecoveryStore(storage);

    await recovery.assign(recoveryProfile, guestProfile);

    expect(await storage.get(STORAGE.archive, archiveStorageKey(guestProfile))).toEqual(archive());
    expect(await storage.get(STORAGE.history, historyStorageKey(guestProfile))).toEqual(history);
    expect(await storage.get(STORAGE.archive, archiveStorageKey(recoveryProfile))).toBeUndefined();
    expect(await storage.get(STORAGE.history, historyStorageKey(recoveryProfile))).toBeUndefined();
    expect(await storage.get(STORAGE.app, LOCAL_PROFILE_STATE_KEY)).toEqual({
      version: 1,
      activeProfileId: guestProfile,
      guestProfileId: guestProfile,
      routes: [],
    });
  });

  it('preserves the server base version of a logically empty target archive', async () => {
    const storage = new AtomicMemoryStorage();
    await seedState(storage);
    await storage.set(STORAGE.archive, archiveStorageKey(recoveryProfile), archive());
    await storage.set(STORAGE.archive, archiveStorageKey(guestProfile), {
      baseVersion: 9,
      content: { perPart: [], perCompetency: [] },
    });
    const recovery = new LocalRecoveryStore(storage);

    await expect(recovery.inventory(guestProfile)).resolves.toMatchObject({
      profiles: [{ assignment: { safe: true } }],
    });
    await recovery.assign(recoveryProfile, guestProfile);
    expect(await storage.get<LocalArchive>(
      STORAGE.archive,
      archiveStorageKey(guestProfile),
    )).toMatchObject({ baseVersion: 9, content: archive().content });
  });

  it('fails closed when the target already has data', async () => {
    const storage = new AtomicMemoryStorage();
    await seedState(storage);
    await storage.set(STORAGE.archive, archiveStorageKey(recoveryProfile), archive());
    await storage.set(STORAGE.archive, archiveStorageKey(guestProfile), archive('other-a'));
    const recovery = new LocalRecoveryStore(storage);

    await expect(recovery.inventory(guestProfile)).resolves.toMatchObject({
      profiles: [{ assignment: { safe: false, reason: 'target-not-empty' } }],
    });
    await expect(recovery.assign(recoveryProfile, guestProfile)).rejects.toThrow('not empty');
    expect(await storage.get(STORAGE.archive, archiveStorageKey(recoveryProfile))).toEqual(archive());
  });

  it('exports malformed isolated data but never offers assignment', async () => {
    const storage = new AtomicMemoryStorage();
    await seedState(storage);
    await storage.set(STORAGE.archive, archiveStorageKey(recoveryProfile), { broken: true });
    const recovery = new LocalRecoveryStore(storage);

    await expect(recovery.inventory(guestProfile)).resolves.toMatchObject({
      profiles: [{ assignment: { safe: false, reason: 'source-malformed' } }],
    });
    await expect(recovery.export()).resolves.toMatchObject({
      profiles: [{ archive: { broken: true } }],
    });
    await expect(recovery.assign(recoveryProfile, guestProfile)).rejects.toThrow('malformed');
  });

  it('inventories an unclaimed guest after login and exports more than one storage batch', async () => {
    const storage = new AtomicMemoryStorage();
    const account = 'user:account-1' as LocalProfileId;
    await storage.set(STORAGE.app, LOCAL_PROFILE_STATE_KEY, {
      version: 1,
      activeProfileId: account,
      guestProfileId: guestProfile,
      routes: [],
    });
    await storage.set(STORAGE.archive, archiveStorageKey(guestProfile), archive());
    for (let index = 0; index < 40; index += 1) {
      const clientAttemptId = `guest-history-${index}`;
      await storage.set(
        STORAGE.history,
        historyEventRowKey(clientAttemptId, guestProfile),
        {
          version: 2,
          profileId: guestProfile,
          entry: {
            ...history[0],
            clientAttemptId,
          },
        },
      );
    }
    const orphanedPracticeSession = { version: 4, questionId: 'unfinished-question' };
    await storage.set(STORAGE.app, 'practice-session:guest', orphanedPracticeSession);
    for (let index = 0; index < 40; index += 1) {
      await storage.set(
        STORAGE.app,
        `practice-session:guest:window-${index}`,
        { ...orphanedPracticeSession, windowKind: `window-${index}` },
      );
    }
    await storage.set(STORAGE.app, 'practice-session:guest:', { must: 'not-match' });
    await storage.set(STORAGE.app, 'practice-session:guest:main:extra', { must: 'not-match' });
    await storage.set(STORAGE.app, 'practice-session:guestish', { legacyRawUser: true });
    await storage.set(STORAGE.app, 'practice-session:raw-user', { legacyRawUser: true });
    await storage.set(STORAGE.app, 'practice-session:raw-user:main', {
      legacyRawUser: true,
      windowKind: 'main',
    });
    await storage.set(STORAGE.app, 'practice-session/v5/user%3Ascoped', { must: 'not-match' });
    const guestAttempt = {
      userId: GUEST_ATTEMPT_OWNER,
      guestGeneration: 'guest-generation',
      attempt: {
        clientAttemptId: 'guest-outbox-1',
        questionId: 'q1',
        partId: 'q1-a',
        correct: true,
        awardedPoints: 1,
        gradedAt: '2026-08-15T10:00:00.000Z',
      },
    };
    await storage.set(
      STORAGE.history,
      attemptOutboxRowKey(GUEST_ATTEMPT_OWNER, 'guest-outbox-1'),
      guestAttempt,
    );
    for (let index = 0; index < 40; index += 1) {
      await storage.set(
        STORAGE.history,
        attemptOutboxRowKey(AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER, `account-ambiguous-${index}`),
        {
          userId: AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER,
          attempt: {
            ...guestAttempt.attempt,
            clientAttemptId: `account-ambiguous-${index}`,
          },
        },
      );
    }
    const recovery = new LocalRecoveryStore(storage);

    await expect(recovery.inventory(account)).resolves.toMatchObject({
      totalCount: 85,
      ambiguousAccountAttemptCount: 40,
      orphanedPracticeSessionCount: 44,
      profiles: [{
        kind: 'unclaimed-guest',
        profileId: guestProfile,
        historyEventCount: 40,
        attemptCount: 1,
        assignment: { safe: true },
      }],
    });
    const exported = await recovery.export(account);
    expect(exported.profiles).toHaveLength(1);
    expect(exported.profiles[0]?.kind).toBe('unclaimed-guest');
    expect(exported.profiles[0]?.historyEvents).toHaveLength(40);
    expect(exported.unclaimedGuestAttempts).toEqual([guestAttempt]);
    expect(exported.ambiguousAccountAttempts).toHaveLength(40);
    expect(exported.orphanedPracticeSessions).toHaveLength(44);
    expect(exported.orphanedPracticeSessions).toContainEqual({
      key: 'practice-session:guest',
      value: orphanedPracticeSession,
    });
    expect(exported.orphanedPracticeSessions.map((entry) => entry.key)).not.toContain(
      'practice-session:guest:main:extra',
    );
    expect(exported.orphanedPracticeSessions.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([
        'practice-session:guestish',
        'practice-session:raw-user',
        'practice-session:raw-user:main',
      ]),
    );
    await expect(recovery.assign(guestProfile, account)).rejects.toThrow('guest-claim');
  });
});
