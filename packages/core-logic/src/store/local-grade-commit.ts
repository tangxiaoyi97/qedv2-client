import type { LocalArchive, FsrsState, Grading } from '../model/archive.js';
import {
  STORAGE,
  hasAtomicStorage,
  type StorageAddress,
  type StoragePort,
  type StorageVersionedEntry,
} from '../ports/index.js';
import {
  ARCHIVE_STORAGE_KEY,
  prepareArchiveGrade,
  type ApplyGradeInput,
} from './archive-store.js';
import {
  ATTEMPT_OUTBOX_STORAGE_KEY,
  GUEST_CLAIM_STORAGE_KEY,
  prepareAttemptEnqueue,
  type AttemptOwnerSnapshot,
  type QueuedAttempt,
} from './attempt-outbox.js';
import {
  HISTORY_STORAGE_KEY,
  prepareHistoryAppend,
  prepareHistoryLog,
  type HistoryEntry,
} from './history-log.js';

const MAX_CAS_ATTEMPTS = 6;

const ARCHIVE_ADDRESS = { collection: STORAGE.archive, key: ARCHIVE_STORAGE_KEY } as const;
const HISTORY_ADDRESS = { collection: STORAGE.history, key: HISTORY_STORAGE_KEY } as const;
const OUTBOX_ADDRESS = { collection: STORAGE.history, key: ATTEMPT_OUTBOX_STORAGE_KEY } as const;
const GUEST_CLAIM_ADDRESS = { collection: STORAGE.history, key: GUEST_CLAIM_STORAGE_KEY } as const;

export interface LocalGradeSessionMutation {
  address: StorageAddress;
  /** Pure function; called again after every CAS conflict. */
  prepare(current: unknown): unknown;
  /** Durable idempotency marker used after an uncertain commit response. */
  containsAttempt(current: unknown, clientAttemptId: string): boolean;
}

export interface LocalGradeCommitInput {
  owner: AttemptOwnerSnapshot;
  attempt: QueuedAttempt;
  grade: ApplyGradeInput;
  session: LocalGradeSessionMutation;
}

export interface LocalGradeCommitResult {
  ownerId: string;
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
  if (attempt.elapsedMs !== undefined) entry.elapsedMs = attempt.elapsedMs;
  if (attempt.contentSource !== undefined) entry.contentSource = attempt.contentSource;
  if (attempt.contentId !== undefined) entry.contentId = attempt.contentId;
  return entry;
}

function validateInput(input: LocalGradeCommitInput): void {
  const id = input.attempt.clientAttemptId;
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
    throw new TypeError('Invalid client attempt identity');
  }
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

/**
 * Commits one answer as an all-or-nothing local event.  The existing cloud
 * outbox remains the delivery journal; this store deliberately adds no second
 * replay protocol.  CAS makes preparation safe across tabs/windows and normal
 * sync writes, while the shared clientAttemptId resolves an IPC response lost
 * after COMMIT.
 */
export class LocalGradeCommitStore {
  constructor(private readonly storage: StoragePort) {}

  async commit(input: LocalGradeCommitInput): Promise<LocalGradeCommitResult> {
    validateInput(input);
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic local grade storage is unavailable; answer was not recorded');
    }
    const addresses = [
      ARCHIVE_ADDRESS,
      HISTORY_ADDRESS,
      OUTBOX_ADDRESS,
      GUEST_CLAIM_ADDRESS,
      input.session.address,
    ];
    let lastPrepared: PreparedCommit | undefined;

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const entries = await this.storage.readBatch(addresses);
      const snapshots = snapshotMap(entries);
      const already = this.confirmFromSnapshots(input, snapshots, lastPrepared);
      if (already) return already;
      const prepared = this.prepare(input, entries, snapshots);
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
            prepared,
          );
          if (confirmed) return confirmed;
        }
        throw error;
      }
    }
    throw new Error('Local progress changed repeatedly; answer was not recorded');
  }

  private prepare(
    input: LocalGradeCommitInput,
    entries: StorageVersionedEntry[],
    snapshots: Map<string, StorageVersionedEntry>,
  ): PreparedCommit {
    if (entries.length !== 5) throw new Error('Atomic storage returned an incomplete snapshot');
    const archiveResult = prepareArchiveGrade(
      valueOf(snapshots, ARCHIVE_ADDRESS) as LocalArchive | undefined,
      input.grade,
    );
    const historyEntry = historyEntryFor(input.attempt, input.grade, archiveResult.grading);
    const history = prepareHistoryAppend(valueOf(snapshots, HISTORY_ADDRESS), historyEntry);
    const outbox = prepareAttemptEnqueue(
      valueOf(snapshots, OUTBOX_ADDRESS),
      input.owner,
      valueOf(snapshots, GUEST_CLAIM_ADDRESS),
      input.attempt,
    );
    const session = input.session.prepare(valueOf(snapshots, input.session.address));
    if (!input.session.containsAttempt(session, input.attempt.clientAttemptId)) {
      throw new Error('Prepared practice session is missing its attempt identity');
    }
    const result: PreparedCommit = {
      ownerId: outbox.ownerId,
      archive: archiveResult.archive,
      historyEntry,
      grading: archiveResult.grading,
      ...(archiveResult.previousFsrs ? { previousFsrs: archiveResult.previousFsrs } : {}),
      session,
      recovered: false,
      preconditions: entries.map(({ collection, key, revision }) => ({ collection, key, revision })),
      mutations: [
        { ...ARCHIVE_ADDRESS, operation: 'set', value: archiveResult.archive },
        { ...HISTORY_ADDRESS, operation: 'set', value: history },
        { ...OUTBOX_ADDRESS, operation: 'set', value: outbox.entries },
        { ...input.session.address, operation: 'set', value: session },
      ],
    };
    return result;
  }

  private confirmFromSnapshots(
    input: LocalGradeCommitInput,
    snapshots: Map<string, StorageVersionedEntry>,
    prepared?: PreparedCommit,
  ): LocalGradeCommitResult | undefined {
    const history = prepareHistoryLog(valueOf(snapshots, HISTORY_ADDRESS));
    const historyEntry = history.find(
      (entry) => entry.clientAttemptId === input.attempt.clientAttemptId,
    );
    const session = valueOf(snapshots, input.session.address);
    if (!historyEntry || !input.session.containsAttempt(session, input.attempt.clientAttemptId)) {
      return undefined;
    }
    const archive = valueOf(snapshots, ARCHIVE_ADDRESS) as LocalArchive | undefined;
    if (!archive) throw new Error('Committed answer is missing its local archive');
    const owner = prepareAttemptEnqueue(
      valueOf(snapshots, OUTBOX_ADDRESS),
      input.owner,
      valueOf(snapshots, GUEST_CLAIM_ADDRESS),
      input.attempt,
    );
    return {
      ownerId: owner.ownerId,
      archive,
      historyEntry,
      grading: historyEntry.grading,
      ...(prepared?.previousFsrs ? { previousFsrs: prepared.previousFsrs } : {}),
      session,
      recovered: true,
    };
  }
}
