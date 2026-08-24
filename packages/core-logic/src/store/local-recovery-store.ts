import {
  hasAtomicStorage,
  STORAGE,
  type StorageAddress,
  type StorageBatchMutation,
  type StoragePort,
  type StorageVersionedEntry,
} from '../ports/index.js';
import { canonicalizeArchive, isGrading, type ArchiveContent, type LocalArchive } from '../model/archive.js';
import {
  AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER,
  AMBIGUOUS_GUEST_ATTEMPT_OWNER,
  AttemptOutbox,
  ATTEMPT_OUTBOX_STORAGE_KEY,
  ATTEMPT_OUTBOX_ROW_PREFIX,
  GUEST_CLAIM_STORAGE_KEY,
  GUEST_ATTEMPT_OWNER,
  parseGuestClaimStateValue,
  type CorruptAttemptInventoryRow,
  type LegacyAccountRecoveryBinding,
} from './attempt-outbox.js';
import {
  HISTORY_EVENT_ROW_PREFIX,
  prepareHistoryLog,
  type HistoryEntry,
} from './history-log.js';
import {
  archiveStorageKey,
  historyStorageKey,
  isLocalProfileId,
  LOCAL_PROFILE_STATE_KEY,
  parseLocalProfileState,
  userLocalProfileId,
  type LocalProfileId,
  type LocalProfileState,
} from './local-profile-store.js';
import { SYNC_MUTATION_LEGACY_KEY_PREFIX } from './sync-mutation-journal.js';

const MAX_CAS_ATTEMPTS = 6;
const STATE_ADDRESS = { collection: STORAGE.app, key: LOCAL_PROFILE_STATE_KEY } as const;
const LEGACY_ARCHIVE_ADDRESS = { collection: STORAGE.archive, key: 'current' } as const;
const LEGACY_HISTORY_ADDRESS = { collection: STORAGE.history, key: 'log' } as const;
const LEGACY_OUTBOX_ADDRESS = {
  collection: STORAGE.history,
  key: ATTEMPT_OUTBOX_STORAGE_KEY,
} as const;
const GUEST_CLAIM_ADDRESS = {
  collection: STORAGE.history,
  key: GUEST_CLAIM_STORAGE_KEY,
} as const;
const LEGACY_PRACTICE_PREFIX = 'practice-session:';

export type LocalRecoveryBlockReason =
  | 'source-empty'
  | 'source-malformed'
  | 'source-has-event-rows'
  | 'target-not-empty'
  | 'legacy-write-pending'
  | 'pending-guest-claim'
  | 'recovery-bound-other-server'
  | 'atomic-storage-required';

export interface LocalRecoveryProfileInventory {
  kind: 'quarantine' | 'unclaimed-guest';
  profileId: LocalProfileId;
  hasArchive: boolean;
  historyCount: number;
  historyEventCount: number;
  attemptCount: number;
  assignment: {
    safe: boolean;
    reason?: LocalRecoveryBlockReason;
  };
}

export interface LocalRecoveryInventory {
  totalCount: number;
  profileCount: number;
  ambiguousAttemptCount: number;
  ambiguousAccountAttemptCount: number;
  corruptAttemptCount: number;
  legacySyncMutationCount: number;
  orphanedPracticeSessionCount: number;
  profiles: LocalRecoveryProfileInventory[];
}

export interface LocalRecoveryExport {
  format: 'qed2-local-recovery.v1';
  exportedAt: string;
  profiles: Array<{
    kind: 'quarantine' | 'unclaimed-guest';
    profileId: LocalProfileId;
    archive?: unknown;
    history?: unknown;
    historyEvents: unknown[];
  }>;
  ambiguousAttempts: unknown[];
  ambiguousAccountAttempts: unknown[];
  corruptAttempts: CorruptAttemptInventoryRow[];
  legacySyncMutations: Array<{ key: string; value: unknown }>;
  unclaimedGuestAttempts: unknown[];
  orphanedPracticeSessions: Array<{ key: string; value: unknown }>;
}

export interface LegacyPendingAccountRecovery {
  legacyUserId: string;
  scopedUserId: string;
  sourceGeneration: string;
}

interface ProfileDocuments {
  archive: StorageVersionedEntry;
  history: StorageVersionedEntry;
}

function profileAddresses(profileId: LocalProfileId): [StorageAddress, StorageAddress] {
  return [
    { collection: STORAGE.archive, key: archiveStorageKey(profileId) },
    { collection: STORAGE.history, key: historyStorageKey(profileId) },
  ];
}

function historyEventPrefix(profileId: LocalProfileId): string {
  return `${HISTORY_EVENT_ROW_PREFIX}${encodeURIComponent(profileId)}/`;
}

function ambiguousAttemptPrefix(): string {
  return `${ATTEMPT_OUTBOX_ROW_PREFIX}${encodeURIComponent(AMBIGUOUS_GUEST_ATTEMPT_OWNER)}/`;
}

function ambiguousAccountAttemptPrefix(): string {
  return `${ATTEMPT_OUTBOX_ROW_PREFIX}${encodeURIComponent(AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER)}/`;
}

function isIssuerlessAccountAttemptKey(key: string): boolean {
  if (!key.startsWith(ATTEMPT_OUTBOX_ROW_PREFIX)) return false;
  const encodedOwner = key.slice(ATTEMPT_OUTBOX_ROW_PREFIX.length).split('/', 1)[0];
  if (!encodedOwner) return false;
  let owner: string;
  try {
    owner = decodeURIComponent(encodedOwner);
  } catch {
    return false;
  }
  return owner !== GUEST_ATTEMPT_OWNER
    && owner !== AMBIGUOUS_GUEST_ATTEMPT_OWNER
    && owner !== AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER
    && !/^account-v1-[0-9a-f]{64}$/.test(owner);
}

function guestAttemptPrefix(): string {
  return `${ATTEMPT_OUTBOX_ROW_PREFIX}${encodeURIComponent(GUEST_ATTEMPT_OWNER)}/`;
}

function isLegacyPracticeKey(key: string): boolean {
  if (!key.startsWith(LEGACY_PRACTICE_PREFIX)) return false;
  // 2.1 wrote `practice-session:<raw user id>[:<desktop window>]` without
  // escaping either segment. We cannot prove the Server issuer now, so every
  // exact old-shape key is export-only. New scoped keys use `/v5/` and cannot
  // match this colon-delimited namespace.
  const segments = key.slice(LEGACY_PRACTICE_PREFIX.length).split(':');
  return segments.length >= 1
    && segments.length <= 2
    && segments.every((segment) =>
      segment.length > 0 && segment.length <= 256 && !segment.includes('\0'));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRecoveryBinding(
  left: LegacyAccountRecoveryBinding | undefined,
  right: LegacyAccountRecoveryBinding,
): boolean {
  return !!left
    && left.sourceGeneration === right.sourceGeneration
    && left.sourceProfileId === right.sourceProfileId
    && left.legacyUserId === right.legacyUserId
    && left.scopedUserId === right.scopedUserId;
}

function validateArchive(value: unknown): LocalArchive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Recovery archive is malformed');
  }
  const archive = value as Partial<LocalArchive>;
  if (
    !Number.isSafeInteger(archive.baseVersion)
    || (archive.baseVersion ?? -1) < 0
    || !archive.content
    || typeof archive.content !== 'object'
    || Array.isArray(archive.content)
  ) throw new Error('Recovery archive is malformed');
  const content = archive.content as Partial<ArchiveContent>;
  if (!Array.isArray(content.perPart) || !Array.isArray(content.perCompetency)) {
    throw new Error('Recovery archive is malformed');
  }
  const canonical = canonicalizeArchive(content as ArchiveContent);
  if (
    new Set(canonical.perPart.map((entry) => entry.partId)).size !== canonical.perPart.length
    || new Set(canonical.perCompetency.map((entry) => entry.code)).size
      !== canonical.perCompetency.length
  ) throw new Error('Recovery archive contains duplicate identities');
  return { content: canonical, baseVersion: archive.baseVersion! };
}

function validateHistoryEntry(entry: HistoryEntry): void {
  if (
    typeof entry.partId !== 'string'
    || typeof entry.questionId !== 'string'
    || !['correct', 'partial', 'incorrect'].includes(entry.verdict)
    || typeof entry.awardedPoints !== 'number'
    || !Number.isFinite(entry.awardedPoints)
    || typeof entry.maxPoints !== 'number'
    || !Number.isFinite(entry.maxPoints)
    || !isGrading(entry.grading)
    || typeof entry.gradedAt !== 'string'
    || Number.isNaN(Date.parse(entry.gradedAt))
  ) throw new Error('Recovery history is malformed');
}

function validateHistory(value: unknown): HistoryEntry[] {
  const entries = prepareHistoryLog(value);
  for (const entry of entries) validateHistoryEntry(entry);
  const attempts = entries
    .map((entry) => entry.clientAttemptId)
    .filter((id): id is string => id !== undefined);
  if (new Set(attempts).size !== attempts.length) {
    throw new Error('Recovery history contains duplicate attempt identities');
  }
  return entries;
}

function isEmptyArchive(value: unknown): boolean {
  const archive = validateArchive(value);
  return archive.content.perPart.length === 0 && archive.content.perCompetency.length === 0;
}

function isEmptyHistory(value: unknown): boolean {
  return validateHistory(value).length === 0;
}

async function readValues(
  storage: StoragePort,
  addresses: readonly StorageAddress[],
): Promise<StorageVersionedEntry[]> {
  if (hasAtomicStorage(storage)) {
    const entries: StorageVersionedEntry[] = [];
    for (let offset = 0; offset < addresses.length; offset += 32) {
      entries.push(...await storage.readBatch(addresses.slice(offset, offset + 32)));
    }
    return entries;
  }
  return Promise.all(addresses.map(async (address) => {
    const value = await storage.get<unknown>(address.collection, address.key);
    return {
      ...address,
      revision: 0,
      exists: value !== undefined,
      ...(value !== undefined ? { value } : {}),
    };
  }));
}

/**
 * Read/export explicitly quarantined 2.1 data. Nothing in this store guesses
 * ownership or uploads a recovered document. Assignment is offered only when
 * a single atomic move into an empty local profile can be proven safe.
 */
export class LocalRecoveryStore {
  constructor(
    private readonly storage: StoragePort,
    private readonly attemptOutbox: Pick<
      AttemptOutbox,
      'claim' | 'corruptInventory' | 'guestGenerationCount'
    > = new AttemptOutbox(storage),
  ) {}

  private async durableState(): Promise<LocalProfileState | undefined> {
    return parseLocalProfileState(
      await this.storage.get<unknown>(STORAGE.app, LOCAL_PROFILE_STATE_KEY),
    );
  }

  private async profileDocuments(profileId: LocalProfileId): Promise<ProfileDocuments> {
    const [archive, history] = await readValues(this.storage, profileAddresses(profileId));
    if (!archive || !history) throw new Error('Recovery profile read was incomplete');
    return { archive, history };
  }

  private async historyEventKeys(profileId: LocalProfileId): Promise<string[]> {
    const prefix = historyEventPrefix(profileId);
    return (await this.storage.keys(STORAGE.history)).filter((key) => key.startsWith(prefix));
  }

  private async assignmentStatus(
    profileId: LocalProfileId,
    targetProfileId: LocalProfileId | undefined,
    documents: ProfileDocuments,
    sourceEventKeys: readonly string[],
    options: {
      unclaimedGuest: boolean;
      attemptCount: number;
      pendingGuestClaim: boolean;
      legacyRecovery?: LegacyAccountRecoveryBinding;
      phaseOneCommitted: boolean;
    },
  ): Promise<LocalRecoveryProfileInventory['assignment']> {
    if (!hasAtomicStorage(this.storage)) return { safe: false, reason: 'atomic-storage-required' };
    if (
      options.legacyRecovery
      && (options.legacyRecovery.sourceProfileId !== profileId
        || userLocalProfileId(options.legacyRecovery.scopedUserId) !== targetProfileId)
    ) return { safe: false, reason: 'recovery-bound-other-server' };
    // Phase 1 already linearized ownership and moved the only cumulative
    // document that can conflict (the archive). Later target writes must not
    // make a crash-resume impossible; source history remains readable through
    // the durable profile route.
    if (options.phaseOneCommitted) return { safe: true };
    if (
      !documents.archive.exists
      && !documents.history.exists
      && sourceEventKeys.length === 0
      && options.attemptCount === 0
    ) {
      return { safe: false, reason: 'source-empty' };
    }
    try {
      if (documents.archive.exists) validateArchive(documents.archive.value);
      if (documents.history.exists) validateHistory(documents.history.value);
    } catch {
      return { safe: false, reason: 'source-malformed' };
    }
    if (!options.unclaimedGuest && sourceEventKeys.length > 0) {
      return { safe: false, reason: 'source-has-event-rows' };
    }
    if (!targetProfileId || !isLocalProfileId(targetProfileId) || targetProfileId === profileId) {
      return { safe: false, reason: 'target-not-empty' };
    }
    if (options.unclaimedGuest && !targetProfileId.startsWith('user:')) {
      return { safe: false, reason: 'target-not-empty' };
    }
    if (options.unclaimedGuest && options.pendingGuestClaim) {
      return { safe: false, reason: 'pending-guest-claim' };
    }
    const target = await this.profileDocuments(targetProfileId);
    try {
      if (
        (target.archive.exists && !isEmptyArchive(target.archive.value))
        || (target.history.exists && !isEmptyHistory(target.history.value))
        || (await this.historyEventKeys(targetProfileId)).length > 0
      ) return { safe: false, reason: 'target-not-empty' };
    } catch {
      return { safe: false, reason: 'target-not-empty' };
    }
    const [legacyArchive, legacyHistory] = await readValues(this.storage, [
      LEGACY_ARCHIVE_ADDRESS,
      LEGACY_HISTORY_ADDRESS,
    ]);
    if (legacyArchive?.exists || legacyHistory?.exists) {
      return { safe: false, reason: 'legacy-write-pending' };
    }
    return { safe: true };
  }

  async inventory(targetProfileId?: LocalProfileId): Promise<LocalRecoveryInventory> {
    const state = await this.durableState();
    const recoveryProfileIds = state?.recoveryProfileIds ?? [];
    const claimState = parseGuestClaimStateValue(
      await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY),
    );
    const currentGuestAttemptCount = claimState
      ? await this.attemptOutbox.guestGenerationCount(claimState.currentGeneration)
      : (await this.storage.keys(STORAGE.history))
        .filter((key) => key.startsWith(guestAttemptPrefix())).length;
    const pendingGuestAttemptCount = claimState?.pending
      ? await this.attemptOutbox.guestGenerationCount(claimState.pending.sourceGeneration)
      : 0;
    const boundRecoveryProfileId = claimState?.legacyRecovery?.sourceProfileId;
    const includeUnclaimedGuest = !!state
      && !!targetProfileId?.startsWith('user:')
      && state.guestProfileId !== targetProfileId
      && !state.routes.some((route) => route.sourceProfileId === state.guestProfileId);
    const quarantineCandidates = recoveryProfileIds.map((profileId) => ({
      profileId,
      kind: 'quarantine' as const,
    }));
    if (
      boundRecoveryProfileId
      && !quarantineCandidates.some(({ profileId }) => profileId === boundRecoveryProfileId)
    ) {
      quarantineCandidates.push({
        profileId: boundRecoveryProfileId,
        kind: 'quarantine' as const,
      });
    }
    const candidates = [
      ...quarantineCandidates,
      ...(includeUnclaimedGuest
        ? [{ profileId: state.guestProfileId, kind: 'unclaimed-guest' as const }]
        : []),
    ];
    const profiles = (await Promise.all(candidates.map(async ({ profileId, kind }) => {
      const documents = await this.profileDocuments(profileId);
      const sourceEventKeys = await this.historyEventKeys(profileId);
      const attemptCount = kind === 'unclaimed-guest'
        ? currentGuestAttemptCount
        : profileId === state?.legacyQuarantineProfileId
          || profileId === boundRecoveryProfileId
          ? pendingGuestAttemptCount
          : 0;
      const binding = claimState?.legacyRecovery?.sourceProfileId === profileId
        ? claimState.legacyRecovery
        : undefined;
      const boundTarget = binding ? userLocalProfileId(binding.scopedUserId) : undefined;
      const phaseOneCommitted = !!state
        && !!binding
        && !!boundTarget
        && this.phaseOneCommitted(state, claimState, profileId, boundTarget, binding);
      let historyCount = 0;
      if (documents.history.exists) {
        try {
          historyCount = validateHistory(documents.history.value).length;
        } catch {
          historyCount = Array.isArray(documents.history.value)
            ? documents.history.value.length
            : 0;
        }
      }
      return {
        kind,
        profileId,
        hasArchive: documents.archive.exists,
        historyCount,
        historyEventCount: sourceEventKeys.length,
        attemptCount,
        assignment: await this.assignmentStatus(
          profileId,
          targetProfileId,
          documents,
          sourceEventKeys,
          {
            unclaimedGuest: kind === 'unclaimed-guest',
            attemptCount,
            pendingGuestClaim: !!claimState?.pending,
            phaseOneCommitted,
            ...(binding ? { legacyRecovery: binding } : {}),
          },
        ),
      } satisfies LocalRecoveryProfileInventory;
    }))).filter((profile) =>
      profile.profileId === boundRecoveryProfileId
      || profile.hasArchive
      || profile.historyCount > 0
      || profile.historyEventCount > 0
      || profile.attemptCount > 0);
    const corruptAttempts = await this.attemptOutbox.corruptInventory();
    const corruptKeys = new Set(corruptAttempts.map((row) => row.key));
    const ambiguousAttemptCount = (
      await this.storage.keys(STORAGE.history)
    ).filter((key) => key.startsWith(ambiguousAttemptPrefix())).length;
    const ambiguousAccountAttemptCount = (
      await this.storage.keys(STORAGE.history)
    ).filter((key) =>
      !corruptKeys.has(key)
      && (key.startsWith(ambiguousAccountAttemptPrefix())
        || isIssuerlessAccountAttemptKey(key))).length;
    const corruptAttemptCount = corruptAttempts.length;
    const legacySyncMutationCount = (await this.storage.keys(STORAGE.app))
      .filter((key) => key.startsWith(SYNC_MUTATION_LEGACY_KEY_PREFIX)).length;
    const orphanedPracticeSessionCount = (await this.storage.keys(STORAGE.app))
      .filter(isLegacyPracticeKey).length;
    return {
      totalCount: profiles.length
        + ambiguousAttemptCount
        + ambiguousAccountAttemptCount
        + corruptAttemptCount
        + legacySyncMutationCount
        + orphanedPracticeSessionCount,
      profileCount: profiles.length,
      ambiguousAttemptCount,
      ambiguousAccountAttemptCount,
      corruptAttemptCount,
      legacySyncMutationCount,
      orphanedPracticeSessionCount,
      profiles,
    };
  }

  async export(targetProfileId?: LocalProfileId): Promise<LocalRecoveryExport> {
    const state = await this.durableState();
    const claimState = parseGuestClaimStateValue(
      await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY),
    );
    const includeUnclaimedGuest = !!state
      && !!targetProfileId?.startsWith('user:')
      && state.guestProfileId !== targetProfileId
      && !state.routes.some((route) => route.sourceProfileId === state.guestProfileId);
    const profileIds = [...new Set([
      ...(state?.recoveryProfileIds ?? []),
      ...(claimState?.legacyRecovery ? [claimState.legacyRecovery.sourceProfileId] : []),
      ...(includeUnclaimedGuest ? [state.guestProfileId] : []),
    ])];
    const profiles = await Promise.all(profileIds.map(async (profileId) => {
      const documents = await this.profileDocuments(profileId);
      const eventKeys = await this.historyEventKeys(profileId);
      const eventValues = await readValues(
        this.storage,
        eventKeys.map((key) => ({ collection: STORAGE.history, key })),
      );
      const historyEvents = eventValues
        .filter((entry) => entry.exists)
        .map((entry) => entry.value);
      return {
        kind: includeUnclaimedGuest && profileId === state?.guestProfileId
          ? 'unclaimed-guest' as const
          : 'quarantine' as const,
        profileId,
        ...(documents.archive.exists ? { archive: documents.archive.value } : {}),
        ...(documents.history.exists ? { history: documents.history.value } : {}),
        historyEvents,
      };
    }));
    const attemptKeys = (await this.storage.keys(STORAGE.history))
      .filter((key) => key.startsWith(ambiguousAttemptPrefix()));
    const attemptValues = await readValues(
      this.storage,
      attemptKeys.map((key) => ({ collection: STORAGE.history, key })),
    );
    const ambiguousAttempts = attemptValues
      .filter((entry) => entry.exists)
      .map((entry) => entry.value);
    const corruptAttempts = await this.attemptOutbox.corruptInventory();
    const corruptKeys = new Set(corruptAttempts.map((row) => row.key));
    const ambiguousAccountAttemptKeys = (await this.storage.keys(STORAGE.history))
      .filter((key) =>
        !corruptKeys.has(key)
        && (key.startsWith(ambiguousAccountAttemptPrefix())
          || isIssuerlessAccountAttemptKey(key)));
    const ambiguousAccountAttemptValues = await readValues(
      this.storage,
      ambiguousAccountAttemptKeys.map((key) => ({ collection: STORAGE.history, key })),
    );
    const guestAttemptKeys = includeUnclaimedGuest
      ? (await this.storage.keys(STORAGE.history))
        .filter((key) => key.startsWith(guestAttemptPrefix()))
      : [];
    const guestAttemptValues = await readValues(
      this.storage,
      guestAttemptKeys.map((key) => ({ collection: STORAGE.history, key })),
    );
    const orphanedPracticeSessionKeys = (await this.storage.keys(STORAGE.app))
      .filter(isLegacyPracticeKey);
    const orphanedPracticeSessionValues = await readValues(
      this.storage,
      orphanedPracticeSessionKeys.map((key) => ({ collection: STORAGE.app, key })),
    );
    const legacySyncMutationKeys = (await this.storage.keys(STORAGE.app))
      .filter((key) => key.startsWith(SYNC_MUTATION_LEGACY_KEY_PREFIX));
    const legacySyncMutationValues = await readValues(
      this.storage,
      legacySyncMutationKeys.map((key) => ({ collection: STORAGE.app, key })),
    );
    return {
      format: 'qed2-local-recovery.v1',
      exportedAt: new Date().toISOString(),
      profiles,
      ambiguousAttempts,
      ambiguousAccountAttempts: ambiguousAccountAttemptValues
        .filter((entry) => entry.exists)
        .map((entry) => entry.value),
      corruptAttempts,
      legacySyncMutations: legacySyncMutationValues
        .filter((entry) => entry.exists)
        .map((entry) => ({ key: entry.key, value: entry.value })),
      unclaimedGuestAttempts: guestAttemptValues
        .filter((entry) => entry.exists)
        .map((entry) => entry.value),
      orphanedPracticeSessions: orphanedPracticeSessionValues
        .filter((entry) => entry.exists)
        .map((entry) => ({ key: entry.key, value: entry.value })),
    };
  }

  private phaseOneCommitted(
    state: LocalProfileState,
    claimState: ReturnType<typeof parseGuestClaimStateValue>,
    profileId: LocalProfileId,
    targetProfileId: LocalProfileId,
    binding: LegacyAccountRecoveryBinding,
  ): boolean {
    return !!claimState
      && sameRecoveryBinding(claimState.legacyRecovery, binding)
      && claimState.pending?.sourceGeneration === binding.sourceGeneration
      && claimState.pending.destinationUserId === binding.scopedUserId
      && claimState.routes.some((route) =>
        route.sourceGeneration === binding.sourceGeneration
        && route.destinationUserId === binding.scopedUserId)
      && state.routes.some((route) =>
        route.sourceProfileId === profileId
        && route.destinationProfileId === targetProfileId)
      && !(state.recoveryProfileIds ?? []).includes(profileId)
      && state.legacyQuarantineProfileId !== profileId;
  }

  /**
   * Phase 1 is the ownership linearization point. The claim's endpoint scope,
   * the profile route and the archive move share one CAS over every legacy,
   * source and target document revision. No outbox row moves before this.
   */
  private async bindAndAssignLegacyProfile(
    profileId: LocalProfileId,
    targetProfileId: LocalProfileId,
    binding: LegacyAccountRecoveryBinding,
  ): Promise<void> {
    const atomicStorage = this.storage;
    if (!hasAtomicStorage(atomicStorage)) {
      throw new Error('Atomic storage is required to bind legacy recovery safely');
    }
    const sourceAddresses = profileAddresses(profileId);
    const targetAddresses = profileAddresses(targetProfileId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const addresses = [
        STATE_ADDRESS,
        GUEST_CLAIM_ADDRESS,
        ...sourceAddresses,
        ...targetAddresses,
        LEGACY_ARCHIVE_ADDRESS,
        LEGACY_HISTORY_ADDRESS,
        LEGACY_OUTBOX_ADDRESS,
      ];
      const snapshots = await atomicStorage.readBatch(addresses);
      if (snapshots.length !== addresses.length) {
        throw new Error('Legacy recovery binding read was incomplete');
      }
      const state = parseLocalProfileState(snapshots[0]?.value);
      const claimState = parseGuestClaimStateValue(snapshots[1]?.value);
      if (!state || !claimState) throw new Error('Legacy recovery ownership is missing');
      if (this.phaseOneCommitted(state, claimState, profileId, targetProfileId, binding)) return;
      if (
        (await this.historyEventKeys(profileId)).length > 0
        || (await this.historyEventKeys(targetProfileId)).length > 0
      ) throw new Error('Recovery history rows prevent a safe assignment');
      if (claimState.legacyRecovery) {
        throw new Error('Legacy guest claim is already bound to another Server');
      }
      const sourceArchive = snapshots[2]!;
      const sourceHistory = snapshots[3]!;
      const targetArchive = snapshots[4]!;
      const targetHistory = snapshots[5]!;
      const pending = claimState.pending;
      const claimRoute = claimState.routes.find((route) =>
        route.sourceGeneration === binding.sourceGeneration);
      if (
        !(state.recoveryProfileIds ?? []).includes(profileId)
        || state.legacyQuarantineProfileId !== profileId
        || state.routes.some((route) => route.sourceProfileId === profileId)
        || claimState.currentGeneration === binding.sourceGeneration
        || claimState.legacyMigration
        || !pending
        || pending.sourceGeneration !== binding.sourceGeneration
        || (pending.destinationUserId !== binding.legacyUserId
          && pending.destinationUserId !== binding.scopedUserId)
        || !claimRoute
        || claimRoute.destinationUserId !== pending.destinationUserId
      ) throw new Error('Legacy guest claim no longer matches the verified account');
      if (snapshots[6]?.exists || snapshots[7]?.exists) {
        throw new Error('A legacy renderer is still writing; retry recovery later');
      }
      if (
        (targetArchive.exists && !isEmptyArchive(targetArchive.value))
        || (targetHistory.exists && !isEmptyHistory(targetHistory.value))
      ) throw new Error('Recovery target is not empty');
      const sourceArchiveValue = sourceArchive.exists
        ? validateArchive(sourceArchive.value)
        : undefined;
      if (sourceHistory.exists) validateHistory(sourceHistory.value);
      if (state.routes.length >= 128) {
        throw new Error('Too many completed profile claims; local ownership maintenance is required');
      }
      const remaining = (state.recoveryProfileIds ?? []).filter((id) => id !== profileId);
      const nextState: LocalProfileState = {
        ...state,
        routes: [
          ...state.routes,
          { sourceProfileId: profileId, destinationProfileId: targetProfileId },
        ],
        ...(remaining.length > 0 ? { recoveryProfileIds: remaining } : {}),
      };
      if (remaining.length === 0) delete nextState.recoveryProfileIds;
      delete nextState.legacyQuarantineProfileId;
      const nextClaimState = {
        ...claimState,
        routes: claimState.routes.map((route) =>
          route.sourceGeneration === binding.sourceGeneration
            ? { ...route, destinationUserId: binding.scopedUserId }
            : { ...route }),
        pending: {
          sourceGeneration: binding.sourceGeneration,
          destinationUserId: binding.scopedUserId,
        },
        legacyRecovery: { ...binding },
      };
      if (!parseGuestClaimStateValue(nextClaimState)) {
        throw new Error('Legacy recovery binding would create invalid ownership state');
      }
      const mutations: StorageBatchMutation[] = [
        { ...STATE_ADDRESS, operation: 'set', value: nextState },
        { ...GUEST_CLAIM_ADDRESS, operation: 'set', value: nextClaimState },
      ];
      if (sourceArchive.exists) {
        const destinationArchive: LocalArchive = {
          content: sourceArchiveValue!.content,
          baseVersion: targetArchive.exists
            ? validateArchive(targetArchive.value).baseVersion
            : sourceArchiveValue!.baseVersion,
        };
        mutations.push({ ...targetAddresses[0], operation: 'set', value: destinationArchive });
        mutations.push({ ...sourceAddresses[0], operation: 'delete' });
      }
      try {
        const committed = await atomicStorage.commitBatch({
          ifRevisions: snapshots.map(({ collection, key, revision }) => ({
            collection,
            key,
            revision,
          })),
          mutations,
        });
        if (committed.committed) return;
      } catch (cause) {
        const durableState = await this.durableState();
        const durableClaim = parseGuestClaimStateValue(
          await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY),
        );
        if (
          durableState
          && this.phaseOneCommitted(
            durableState,
            durableClaim,
            profileId,
            targetProfileId,
            binding,
          )
        ) return;
        throw cause;
      }
    }
    throw new Error('Legacy recovery ownership changed too often to bind safely');
  }

  private async finishLegacyRecoveryClaim(
    binding: LegacyAccountRecoveryBinding,
  ): Promise<void> {
    const atomicStorage = this.storage;
    if (!hasAtomicStorage(atomicStorage)) {
      throw new Error('Atomic storage is required to finish legacy recovery safely');
    }
    const completed = (claimState: ReturnType<typeof parseGuestClaimStateValue>): boolean =>
      !!claimState
      && claimState.legacyRecovery === undefined
      && claimState.pending?.sourceGeneration !== binding.sourceGeneration
      && claimState.routes.some((route) =>
        route.sourceGeneration === binding.sourceGeneration
        && route.destinationUserId === binding.scopedUserId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await atomicStorage.readBatch([GUEST_CLAIM_ADDRESS]);
      if (!snapshot) throw new Error('Legacy recovery marker read was incomplete');
      const claimState = parseGuestClaimStateValue(snapshot.value);
      if (completed(claimState)) return;
      if (
        !claimState
        || !sameRecoveryBinding(claimState.legacyRecovery, binding)
        || claimState.pending?.sourceGeneration !== binding.sourceGeneration
        || claimState.pending.destinationUserId !== binding.scopedUserId
        || !claimState.routes.some((route) =>
          route.sourceGeneration === binding.sourceGeneration
          && route.destinationUserId === binding.scopedUserId)
        || claimState.legacyMigration
      ) throw new Error('Legacy recovery marker no longer matches its owner');
      const nextClaimState = {
        ...claimState,
        routes: claimState.routes.map((route) => ({ ...route })),
      };
      delete nextClaimState.pending;
      delete nextClaimState.legacyRecovery;
      try {
        const committed = await atomicStorage.commitBatch({
          ifRevisions: [{ ...GUEST_CLAIM_ADDRESS, revision: snapshot.revision }],
          mutations: [{ ...GUEST_CLAIM_ADDRESS, operation: 'set', value: nextClaimState }],
        });
        if (committed.committed) return;
      } catch (cause) {
        const durable = parseGuestClaimStateValue(
          await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY),
        );
        if (completed(durable)) return;
        throw cause;
      }
    }
    throw new Error('Legacy recovery marker changed too often to finish safely');
  }

  /**
   * Explicitly recover the archive/history tied to one interrupted 2.1 invite
   * claim. The raw remote user is accepted only after the UI has verified the
   * same user on one Server origin and derived `scopedUserId` from that origin.
   *
   * Phase 1 atomically binds the endpoint scope, routes the preserved profile
   * and moves its archive. Phase 2 then moves only O's rows; Phase 3 clears the
   * marker. The current guest profile/generation are deliberately absent, so
   * work created after the upgrade remains available for a later invite.
   * Issuer-less account rows stay export-only under quarantine ownership.
   */
  async assignLegacyPendingAccount(
    profileId: LocalProfileId,
    targetProfileId: LocalProfileId,
    recovery: LegacyPendingAccountRecovery,
  ): Promise<void> {
    if (!isLocalProfileId(profileId) || !isLocalProfileId(targetProfileId)) {
      throw new TypeError('Invalid recovery profile identity');
    }
    if (profileId === targetProfileId) {
      throw new Error('Recovery source and target must be different');
    }
    if (targetProfileId !== userLocalProfileId(recovery.scopedUserId)) {
      throw new Error('Verified recovery account does not match the target profile');
    }
    if (
      !recovery.legacyUserId
      || recovery.legacyUserId.length > 256
      || recovery.legacyUserId.includes('\0')
      || !recovery.sourceGeneration
      || recovery.sourceGeneration.length > 256
      || recovery.sourceGeneration.includes('\0')
    ) throw new TypeError('Invalid legacy account recovery identity');
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic storage is required to assign recovery data safely');
    }

    const binding: LegacyAccountRecoveryBinding = {
      sourceGeneration: recovery.sourceGeneration,
      sourceProfileId: profileId,
      legacyUserId: recovery.legacyUserId,
      scopedUserId: recovery.scopedUserId,
    };

    // Ownership, profile visibility and the archive move share one CAS. Until
    // it commits, neither raw nor guest-generation rows are touched.
    await this.bindAndAssignLegacyProfile(profileId, targetProfileId, binding);

    // Raw v2 rows cannot prove an issuer, so keep them export-only. The
    // exclusive Phase-1 binding exists before this or any O row mutation;
    // two endpoint scopes can therefore never copy the same row.
    await this.attemptOutbox.claim(
      recovery.legacyUserId,
      AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER,
    );
    // O is proven by the persisted pending route. Move only that generation;
    // N remains under the fresh guest owner and can be claimed by a later
    // invite without ever being attributed to this legacy account.
    await this.attemptOutbox.claim(
      GUEST_ATTEMPT_OWNER,
      recovery.scopedUserId,
      recovery.sourceGeneration,
    );
    if (await this.attemptOutbox.guestGenerationCount(recovery.sourceGeneration) !== 0) {
      // A conflicting destination attempt is preserved under O for export.
      // Keep the binding/pending marker so the same verified scope can retry
      // explicitly; another endpoint can never consume the remainder.
      throw new Error('Legacy guest attempts could not be assigned without a conflict');
    }
    await this.finishLegacyRecoveryClaim(binding);
  }

  async assign(profileId: LocalProfileId, targetProfileId: LocalProfileId): Promise<void> {
    if (!isLocalProfileId(profileId) || !isLocalProfileId(targetProfileId)) {
      throw new TypeError('Invalid recovery profile identity');
    }
    if (profileId === targetProfileId) {
      throw new Error('Recovery source and target must be different');
    }
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic storage is required to assign recovery data safely');
    }
    const initialState = await this.durableState();
    if (!(initialState?.recoveryProfileIds ?? []).includes(profileId)) {
      throw new Error('This source requires the explicit guest-claim workflow');
    }
    const sourceAddresses = profileAddresses(profileId);
    const targetAddresses = profileAddresses(targetProfileId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      if (
        (await this.historyEventKeys(profileId)).length > 0
        || (await this.historyEventKeys(targetProfileId)).length > 0
      ) throw new Error('Recovery history rows prevent a safe assignment');
      const addresses = [
        STATE_ADDRESS,
        ...sourceAddresses,
        ...targetAddresses,
        LEGACY_ARCHIVE_ADDRESS,
        LEGACY_HISTORY_ADDRESS,
      ];
      const snapshots = await this.storage.readBatch(addresses);
      if (snapshots.length !== addresses.length) {
        throw new Error('Recovery assignment read was incomplete');
      }
      const state = parseLocalProfileState(snapshots[0]?.value);
      if (!state) throw new Error('Local profile state is missing');
      if (!(state.recoveryProfileIds ?? []).includes(profileId)) {
        throw new Error('This source requires the explicit guest-claim workflow');
      }
      const sourceArchive = snapshots[1]!;
      const sourceHistory = snapshots[2]!;
      const targetArchive = snapshots[3]!;
      const targetHistory = snapshots[4]!;
      if (snapshots[5]?.exists || snapshots[6]?.exists) {
        throw new Error('A legacy renderer is still writing; retry recovery later');
      }
      if (!sourceArchive.exists && !sourceHistory.exists) {
        throw new Error('Recovery source is empty');
      }
      if (
        (targetArchive.exists && !isEmptyArchive(targetArchive.value))
        || (targetHistory.exists && !isEmptyHistory(targetHistory.value))
      ) {
        throw new Error('Recovery target is not empty');
      }
      const sourceArchiveValue = sourceArchive.exists
        ? validateArchive(sourceArchive.value)
        : undefined;
      if (sourceHistory.exists) validateHistory(sourceHistory.value);
      const remaining = (state.recoveryProfileIds ?? []).filter((id) => id !== profileId);
      const next: LocalProfileState = {
        ...state,
        ...(remaining.length > 0 ? { recoveryProfileIds: remaining } : {}),
      };
      if (remaining.length === 0) delete next.recoveryProfileIds;
      if (next.legacyQuarantineProfileId === profileId) {
        delete next.legacyQuarantineProfileId;
      }
      const mutations: StorageBatchMutation[] = [
        { ...STATE_ADDRESS, operation: 'set', value: next },
      ];
      if (sourceArchive.exists) {
        const destinationArchive: LocalArchive = {
          content: sourceArchiveValue!.content,
          baseVersion: targetArchive.exists
            ? validateArchive(targetArchive.value).baseVersion
            : sourceArchiveValue!.baseVersion,
        };
        mutations.push({ ...targetAddresses[0], operation: 'set', value: destinationArchive });
        mutations.push({ ...sourceAddresses[0], operation: 'delete' });
      }
      if (sourceHistory.exists) {
        mutations.push({ ...targetAddresses[1], operation: 'set', value: sourceHistory.value });
        mutations.push({ ...sourceAddresses[1], operation: 'delete' });
      }
      try {
        const committed = await this.storage.commitBatch({
          ifRevisions: snapshots.map(({ collection, key, revision }) => ({ collection, key, revision })),
          mutations,
        });
        if (committed.committed) return;
      } catch (cause) {
        // A native IPC reply may be lost after the transaction committed.
        const durable = await this.durableState();
        const target = await this.profileDocuments(targetProfileId);
        if (
          durable
          && !(durable.recoveryProfileIds ?? []).includes(profileId)
          && (!sourceArchive.exists || sameValue(
            target.archive.value,
            {
              content: sourceArchiveValue!.content,
              baseVersion: targetArchive.exists
                ? validateArchive(targetArchive.value).baseVersion
                : sourceArchiveValue!.baseVersion,
            },
          ))
          && (!sourceHistory.exists || sameValue(target.history.value, sourceHistory.value))
        ) return;
        throw cause;
      }
    }
    throw new Error('Recovery data changed too often to assign safely');
  }
}
