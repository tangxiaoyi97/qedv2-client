import type { LocalArchive, FsrsState, Grading } from '../model/archive.js';
import { validateQueuedAttempt } from '../api/attempt-validation.js';
import {
  STORAGE,
  hasAtomicStorage,
  type StorageAddress,
  type StoragePort,
  type StorageVersionedEntry,
} from '../ports/index.js';
import {
  prepareArchiveGrade,
  type ApplyGradeInput,
} from './archive-store.js';
import {
  GUEST_CLAIM_STORAGE_KEY,
  attemptOutboxRowKey,
  preparePendingAttempts,
  resolveAttemptOwnership,
  type AttemptOwnerSnapshot,
  type PendingAttempt,
  type QueuedAttempt,
  type ResolvedAttemptOwnership,
} from './attempt-outbox.js';
import {
  historyEventRowKey,
  parseStoredHistoryEvent,
  prepareStoredHistoryEvent,
  type HistoryEntry,
} from './history-log.js';
import {
  archiveStorageKey,
  LOCAL_PROFILE_STATE_KEY,
  parseLocalProfileState,
  resolveLocalProfileId,
  type LocalProfileId,
} from './local-profile-store.js';

const MAX_CAS_ATTEMPTS = 6;

const GUEST_CLAIM_ADDRESS = { collection: STORAGE.history, key: GUEST_CLAIM_STORAGE_KEY } as const;
const PROFILE_STATE_ADDRESS = { collection: STORAGE.app, key: LOCAL_PROFILE_STATE_KEY } as const;

interface ProfileAddresses {
  archive: StorageAddress;
  history: StorageAddress;
  /** Immutable session source; claimed accounts keep reading this row. */
  historyProfileId?: LocalProfileId;
  /** Current durable archive destination after resolving guest claims. */
  profileId?: LocalProfileId;
}

export interface LocalGradeSessionMutation {
  address: StorageAddress;
  /** Pure function; called again after every CAS conflict. */
  prepare(current: unknown): unknown;
  /** Durable idempotency marker used after an uncertain commit response. */
  containsAttempt(current: unknown, clientAttemptId: string): boolean;
  /** Confirms that the durable marker belongs to this exact graded payload. */
  matchesAttempt(current: unknown, attempt: QueuedAttempt): boolean;
}

export interface LocalGradeCommitInput {
  owner: AttemptOwnerSnapshot;
  attempt: QueuedAttempt;
  grade: ApplyGradeInput;
  session: LocalGradeSessionMutation;
}

export interface LocalGradeCommitResult {
  ownerId: string;
  /** Durable profile whose archive/history received this event. */
  profileId?: LocalProfileId;
  archive: LocalArchive;
  historyEntry: HistoryEntry;
  grading: Grading;
  previousFsrs?: FsrsState;
  session: unknown;
  /** True when a rejected/duplicate call was confirmed from durable markers. */
  recovered: boolean;
}

interface PreparedCommit extends LocalGradeCommitResult {
  preconditions: Array<{ collection: string; key: string; revision: number }>;
  mutations: Array<
    { collection: string; key: string; operation: 'set'; value: unknown }
  >;
}

function snapshotMap(entries: StorageVersionedEntry[]): Map<string, StorageVersionedEntry> {
  return new Map(entries.map((entry) => [`${entry.collection}\0${entry.key}`, entry]));
}

function valueOf(
  snapshots: Map<string, StorageVersionedEntry>,
  address: StorageAddress,
): unknown {
  return snapshots.get(`${address.collection}\0${address.key}`)?.value;
}

function historyEntryFor(
  attempt: QueuedAttempt,
  grade: ApplyGradeInput,
  grading: Grading,
): HistoryEntry {
  const entry: HistoryEntry = {
    clientAttemptId: attempt.clientAttemptId,
    partId: attempt.partId,
    questionId: attempt.questionId,
    verdict: grade.verdict,
    awardedPoints: grade.awardedPoints,
    maxPoints: grade.maxPoints,
    grading,
    gradedAt: attempt.gradedAt,
  };
  if (attempt.elapsedMs != null) entry.elapsedMs = attempt.elapsedMs;
  if (attempt.contentSource !== undefined) entry.contentSource = attempt.contentSource;
  if (attempt.contentId !== undefined) entry.contentId = attempt.contentId;
  return entry;
}

function validateInput(input: LocalGradeCommitInput): void {
  validateQueuedAttempt(input.attempt);
  if (
    input.attempt.partId !== input.grade.partId
    || input.attempt.awardedPoints !== input.grade.awardedPoints
    || input.attempt.correct !== (input.grade.verdict === 'correct')
    || input.attempt.gradedAt !== input.grade.now.toISOString()
  ) {
    throw new TypeError('Attempt, grade and history identities do not match');
  }
  if (input.session.address.collection !== STORAGE.app) {
    throw new TypeError('Practice session commits must use app storage');
  }
  if (!input.session.address.key || input.session.address.key.length > 512) {
    throw new TypeError('Invalid practice session key');
  }
}

function samePending(left: PendingAttempt, right: PendingAttempt): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Commits one answer as an all-or-nothing local event.  The existing cloud
 * outbox remains the delivery journal; this store deliberately adds no second
 * replay protocol.  CAS makes preparation safe across tabs/windows and normal
 * sync writes, while the shared clientAttemptId resolves an IPC response lost
 * after COMMIT.
 */
export class LocalGradeCommitStore {
  constructor(
    private readonly storage: StoragePort,
    private readonly profileId?: LocalProfileId | (() => LocalProfileId | undefined),
    private readonly resolveProfile: (profileId: LocalProfileId) => LocalProfileId = (value) => value,
  ) {}

  private capturedProfile(input: LocalGradeCommitInput): LocalProfileId | undefined {
    const configured = typeof this.profileId === 'function' ? this.profileId() : this.profileId;
    return input.owner.localProfileId ?? configured;
  }

  private addresses(
    captured: LocalProfileId | undefined,
    profileStateValue: unknown,
    clientAttemptId: string,
  ): ProfileAddresses {
    const durableState = parseLocalProfileState(profileStateValue);
    const profileId = captured
      ? durableState
        ? resolveLocalProfileId(durableState, captured)
        : this.resolveProfile(captured)
      : undefined;
    return {
      archive: { collection: STORAGE.archive, key: archiveStorageKey(profileId) },
      history: {
        collection: STORAGE.history,
        key: historyEventRowKey(clientAttemptId, captured),
      },
      ...(captured ? { historyProfileId: captured } : {}),
      ...(profileId ? { profileId } : {}),
    };
  }

  async commit(input: LocalGradeCommitInput): Promise<LocalGradeCommitResult> {
    validateInput(input);
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic local grade storage is unavailable; answer was not recorded');
    }
    const capturedProfile = this.capturedProfile(input);
    let lastPrepared: PreparedCommit | undefined;
    let lastCommitError: unknown;

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const previewAddresses = [
        GUEST_CLAIM_ADDRESS,
        ...(capturedProfile ? [PROFILE_STATE_ADDRESS] : []),
      ];
      const previewEntries = await this.storage.readBatch(previewAddresses);
      if (previewEntries.length !== previewAddresses.length) {
        throw new Error('Ownership read returned an incomplete snapshot');
      }
      const previewSnapshots = snapshotMap(previewEntries);
      const previewOwnership = resolveAttemptOwnership(
        input.owner,
        valueOf(previewSnapshots, GUEST_CLAIM_ADDRESS),
      );
      const profileAddresses = this.addresses(
        capturedProfile,
        capturedProfile ? valueOf(previewSnapshots, PROFILE_STATE_ADDRESS) : undefined,
        input.attempt.clientAttemptId,
      );
      const outboxAddress: StorageAddress = {
        collection: STORAGE.history,
        key: attemptOutboxRowKey(previewOwnership.ownerId, input.attempt.clientAttemptId),
      };
      const addresses = [
        profileAddresses.archive,
        profileAddresses.history,
        outboxAddress,
        GUEST_CLAIM_ADDRESS,
        ...(capturedProfile ? [PROFILE_STATE_ADDRESS] : []),
        input.session.address,
      ];
      const entries = await this.storage.readBatch(addresses);
      if (entries.length !== addresses.length) {
        throw new Error('Atomic storage returned an incomplete snapshot');
      }
      const snapshots = snapshotMap(entries);
      const ownership = resolveAttemptOwnership(
        input.owner,
        valueOf(snapshots, GUEST_CLAIM_ADDRESS),
      );
      const currentProfileAddresses = this.addresses(
        capturedProfile,
        capturedProfile ? valueOf(snapshots, PROFILE_STATE_ADDRESS) : undefined,
        input.attempt.clientAttemptId,
      );
      if (
        ownership.ownerId !== previewOwnership.ownerId
        || ownership.guestGeneration !== previewOwnership.guestGeneration
        || currentProfileAddresses.archive.key !== profileAddresses.archive.key
        || currentProfileAddresses.history.key !== profileAddresses.history.key
        || currentProfileAddresses.profileId !== profileAddresses.profileId
      ) {
        continue;
      }
      const already = this.confirmFromSnapshots(
        input,
        snapshots,
        profileAddresses,
        outboxAddress,
        lastPrepared,
      );
      if (already) return already;
      const prepared = this.prepare(
        input,
        entries,
        snapshots,
        profileAddresses,
        outboxAddress,
        ownership,
      );
      lastPrepared = prepared;
      try {
        const result = await this.storage.commitBatch({
          ifRevisions: prepared.preconditions,
          mutations: prepared.mutations,
        });
        if (result.committed) return prepared;
      } catch (error) {
        // The database may have committed before IPC/process delivery failed.
        // Read durable history+session markers before deciding it is safe to
        // expose an error or retry with a new event.
        const confirmationEntries = await this.storage.readBatch(addresses).catch(() => undefined);
        if (confirmationEntries) {
          const confirmed = this.confirmFromSnapshots(
            input,
            snapshotMap(confirmationEntries),
            profileAddresses,
            outboxAddress,
            prepared,
          );
          if (confirmed) return confirmed;
        }
        // A profile claim can move the committed archive between our failed
        // IPC response and this confirmation read. Re-resolve both durable
        // ownership maps once more before exposing an error.
        lastCommitError = error;
      }
    }
    if (lastCommitError instanceof Error) throw lastCommitError;
    throw new Error('Local progress changed repeatedly; answer was not recorded');
  }

  private prepare(
    input: LocalGradeCommitInput,
    entries: StorageVersionedEntry[],
    snapshots: Map<string, StorageVersionedEntry>,
    profileAddresses: ProfileAddresses,
    outboxAddress: StorageAddress,
    ownership: ResolvedAttemptOwnership,
  ): PreparedCommit {
    const archiveResult = prepareArchiveGrade(
      valueOf(snapshots, profileAddresses.archive) as LocalArchive | undefined,
      input.grade,
    );
    const historyEntry = historyEntryFor(input.attempt, input.grade, archiveResult.grading);
    const history = prepareStoredHistoryEvent(profileAddresses.historyProfileId, historyEntry);
    const existingHistory = valueOf(snapshots, profileAddresses.history);
    if (
      existingHistory !== undefined
      && JSON.stringify(parseStoredHistoryEvent(existingHistory)) !== JSON.stringify(history)
    ) {
      throw new Error('Client attempt identity was reused with different history data');
    }
    const pending: PendingAttempt = {
      userId: ownership.ownerId,
      ...(ownership.guestGeneration ? { guestGeneration: ownership.guestGeneration } : {}),
      attempt: { ...input.attempt },
    };
    const existingOutbox = valueOf(snapshots, outboxAddress);
    if (existingOutbox !== undefined) {
      const [existing] = preparePendingAttempts([existingOutbox]);
      if (!existing || !samePending(existing, pending)) {
        throw new Error('Client attempt identity was reused with different data');
      }
    }
    const session = input.session.prepare(valueOf(snapshots, input.session.address));
    if (!input.session.containsAttempt(session, input.attempt.clientAttemptId)) {
      throw new Error('Prepared practice session is missing its attempt identity');
    }
    if (!input.session.matchesAttempt(session, input.attempt)) {
      throw new Error('Prepared practice session does not match its graded attempt');
    }
    const result: PreparedCommit = {
      ownerId: ownership.ownerId,
      ...(profileAddresses.profileId ? { profileId: profileAddresses.profileId } : {}),
      archive: archiveResult.archive,
      historyEntry,
      grading: archiveResult.grading,
      ...(archiveResult.previousFsrs ? { previousFsrs: archiveResult.previousFsrs } : {}),
      session,
      recovered: false,
      preconditions: entries.map(({ collection, key, revision }) => ({ collection, key, revision })),
      mutations: [
        { ...profileAddresses.archive, operation: 'set', value: archiveResult.archive },
        ...(existingHistory === undefined
          ? [{ ...profileAddresses.history, operation: 'set' as const, value: history }]
          : []),
        ...(existingOutbox === undefined
          ? [{ ...outboxAddress, operation: 'set' as const, value: pending }]
          : []),
        { ...input.session.address, operation: 'set', value: session },
      ],
    };
    return result;
  }

  private confirmFromSnapshots(
    input: LocalGradeCommitInput,
    snapshots: Map<string, StorageVersionedEntry>,
    profileAddresses: ProfileAddresses,
    outboxAddress: StorageAddress,
    prepared?: PreparedCommit,
  ): LocalGradeCommitResult | undefined {
    const historyValue = valueOf(snapshots, profileAddresses.history);
    const historyEntry = historyValue === undefined
      ? undefined
      : parseStoredHistoryEvent(historyValue).entry;
    const session = valueOf(snapshots, input.session.address);
    if (!historyEntry || !input.session.containsAttempt(session, input.attempt.clientAttemptId)) {
      return undefined;
    }
    const expectedHistory = historyEntryFor(
      input.attempt,
      input.grade,
      historyEntry.grading,
    );
    if (JSON.stringify(historyEntry) !== JSON.stringify(expectedHistory)) {
      throw new Error('Client attempt identity was reused with different history data');
    }
    if (!input.session.matchesAttempt(session, input.attempt)) {
      throw new Error('Client attempt identity was reused with different session data');
    }
    const archive = valueOf(snapshots, profileAddresses.archive) as LocalArchive | undefined;
    if (!archive) return undefined;
    const ownership = resolveAttemptOwnership(
      input.owner,
      valueOf(snapshots, GUEST_CLAIM_ADDRESS),
    );
    const pendingValue = valueOf(snapshots, outboxAddress);
    if (pendingValue !== undefined) {
      const [pending] = preparePendingAttempts([pendingValue]);
      const expectedPending: PendingAttempt = {
        userId: ownership.ownerId,
        ...(ownership.guestGeneration ? { guestGeneration: ownership.guestGeneration } : {}),
        attempt: { ...input.attempt },
      };
      if (!pending || !samePending(pending, expectedPending)) {
        throw new Error('Client attempt identity was reused with different upload data');
      }
    }
    return {
      ownerId: ownership.ownerId,
      ...(profileAddresses.profileId ? { profileId: profileAddresses.profileId } : {}),
      archive,
      historyEntry,
      grading: historyEntry.grading,
      ...(prepared?.previousFsrs ? { previousFsrs: prepared.previousFsrs } : {}),
      session,
      recovered: true,
    };
  }
}
