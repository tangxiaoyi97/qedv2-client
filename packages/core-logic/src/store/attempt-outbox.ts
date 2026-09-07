import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { AttemptRecord } from '../api/types.js';
import { validateQueuedAttempt } from '../api/attempt-validation.js';
import { hasAtomicStorage, STORAGE, type StoragePort } from '../ports/index.js';
import type { LocalProfileId } from './local-profile-store.js';

export type QueuedAttempt = AttemptRecord & { clientAttemptId: string };

/**
 * Ownership is captured when a practice session starts, not when an async
 * answer commit eventually reaches the outbox. Guest generations let an
 * invite claim route already-open guest sessions without claiming later guest
 * sessions on the same shared device.
 */
export interface AttemptOwnerSnapshot {
  userId: string;
  guestGeneration?: string;
  /** Profile captured with the practice session; prevents account-switch races. */
  localProfileId?: LocalProfileId;
}

/**
 * Attempts made before account creation stay durable under a local-only
 * owner. They are claimed only by the explicit registration flow; a normal
 * login on a shared device must never import somebody else's guest history.
 */
export const GUEST_ATTEMPT_OWNER = '__qed2_guest__';
/** Preserved but intentionally neither displayed nor uploaded automatically. */
export const AMBIGUOUS_GUEST_ATTEMPT_OWNER = '__qed2_guest_unresolved__';
/** Pre-2.2 authenticated row whose Server issuer cannot be proven. */
export const AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER = '__qed2_account_unresolved__';

export interface PendingAttempt {
  userId: string;
  /** Present while the row belongs to one exact guest generation. */
  guestGeneration?: string;
  attempt: QueuedAttempt;
}

export const ATTEMPT_OUTBOX_STORAGE_KEY = 'attempt-outbox';
export const GUEST_CLAIM_STORAGE_KEY = 'attempt-outbox-guest-claim';
/** Export-only journal for malformed rows found in the pre-2.2 array. */
export const ATTEMPT_OUTBOX_CORRUPT_ROW_PREFIX = 'attempt-outbox/corrupt/v1/';

export interface CorruptAttemptJournalRow {
  version: 1;
  source: 'legacy-array';
  sourceKey: typeof ATTEMPT_OUTBOX_STORAGE_KEY;
  /** Occurrence among byte-equivalent values; preserves duplicate bad rows. */
  occurrence: number;
  reason: string;
  value: unknown;
}

export interface CorruptAttemptInventoryRow {
  key: string;
  source: 'legacy-journal' | 'v2-row';
  reason: string;
  value: unknown;
}

export interface GuestClaimRoute {
  sourceGeneration: string;
  destinationUserId: string;
}

type PendingGuestClaim = GuestClaimRoute;

interface LegacyAttemptMigration {
  ownerId: typeof GUEST_ATTEMPT_OWNER | typeof AMBIGUOUS_GUEST_ATTEMPT_OWNER;
  guestGeneration?: string;
}

export interface PreparedGuestClaim {
  state: GuestClaimState;
  route: GuestClaimRoute;
  changed: boolean;
}

export interface LegacyAccountRecoveryBinding {
  sourceGeneration: string;
  sourceProfileId: LocalProfileId;
  legacyUserId: string;
  scopedUserId: string;
}

export interface GuestClaimState {
  version: 1;
  currentGeneration: string;
  routes: GuestClaimRoute[];
  pending?: PendingGuestClaim;
  /** Permanent classification for generationless writes from a still-open 2.1 renderer. */
  legacyOwner?: LegacyAttemptMigration;
  /** Fixed ownership while the pre-2.2 array is copied in bounded chunks. */
  legacyMigration?: LegacyAttemptMigration;
  /**
   * Exclusive endpoint-scoped owner of an explicit 2.1 recovery. While this
   * exists, generic auth recovery must not consume or clear `pending`.
   */
  legacyRecovery?: LegacyAccountRecoveryBinding;
}

function createGuestGeneration(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function initialGuestClaimState(): GuestClaimState {
  const currentGeneration = createGuestGeneration();
  return {
    version: 1,
    currentGeneration,
    routes: [],
    legacyOwner: { ownerId: GUEST_ATTEMPT_OWNER, guestGeneration: currentGeneration },
  };
}

function inferredLegacyOwner(state: GuestClaimState): LegacyAttemptMigration {
  return state.legacyOwner
    ? { ...state.legacyOwner }
    : state.pending || state.routes.length > 0
      ? { ownerId: AMBIGUOUS_GUEST_ATTEMPT_OWNER }
      : { ownerId: GUEST_ATTEMPT_OWNER, guestGeneration: state.currentGeneration };
}

function cloneGuestClaimState(state: GuestClaimState): GuestClaimState {
  return {
    version: 1,
    currentGeneration: state.currentGeneration,
    routes: state.routes.map((route) => ({ ...route })),
    ...(state.pending ? { pending: { ...state.pending } } : {}),
    ...(state.legacyOwner ? { legacyOwner: { ...state.legacyOwner } } : {}),
    ...(state.legacyMigration ? { legacyMigration: { ...state.legacyMigration } } : {}),
    ...(state.legacyRecovery ? { legacyRecovery: { ...state.legacyRecovery } } : {}),
  };
}

function parseGuestClaimValue(value: unknown): {
  state?: GuestClaimState;
  migrated: boolean;
} {
  if (value === undefined) return { migrated: false };
  if (isGuestClaimState(value)) {
    const state = cloneGuestClaimState(value);
    if (!state.legacyOwner) {
      state.legacyOwner = inferredLegacyOwner(state);
      return { state, migrated: true };
    }
    return { state, migrated: false };
  }
  // Preview builds briefly stored only `{ destinationUserId }`. Preserve the
  // crash-recovery intent, but convert it under the caller's CAS.
  const legacyDestination = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Partial<PendingGuestClaim>).destinationUserId
    : undefined;
  if (typeof legacyDestination === 'string') {
    const sourceGeneration = createGuestGeneration();
    const route: GuestClaimRoute = {
      sourceGeneration,
      destinationUserId: legacyDestination,
    };
    return {
      migrated: true,
      state: {
        version: 1,
        currentGeneration: createGuestGeneration(),
        routes: [route],
        pending: route,
        legacyOwner: { ownerId: AMBIGUOUS_GUEST_ATTEMPT_OWNER },
      },
    };
  }
  throw new Error('Guest attempt ownership state is malformed');
}

export function parseGuestClaimStateValue(value: unknown): GuestClaimState | undefined {
  return parseGuestClaimValue(value).state;
}

/** Pure reservation used by the cross-store profile/outbox claim transaction. */
export function prepareGuestClaim(
  value: unknown,
  destinationUserId: string,
): PreparedGuestClaim {
  if (!destinationUserId || destinationUserId.length > 256 || destinationUserId.includes('\0')) {
    throw new TypeError('Invalid guest claim destination');
  }
  const parsed = parseGuestClaimValue(value);
  const state: GuestClaimState = parsed.state ?? initialGuestClaimState();
  if (state.legacyMigration) {
    throw new Error('Legacy attempts are still being assigned; retry the account claim');
  }
  if (state.legacyRecovery) {
    throw new Error('Legacy account recovery must finish before another guest claim');
  }
  if (state.pending && state.pending.destinationUserId !== destinationUserId) {
    throw new Error('Gastversuche sind bereits für ein anderes Konto vorgemerkt.');
  }
  if (state.pending) {
    return { state, route: { ...state.pending }, changed: parsed.migrated };
  }
  if (state.routes.length >= 128) {
    throw new Error('Too many completed guest claims; local ownership maintenance is required');
  }
  const sourceGeneration = state.currentGeneration;
  const route: GuestClaimRoute = { sourceGeneration, destinationUserId };
  const next: GuestClaimState = {
    version: 1,
    currentGeneration: createGuestGeneration(),
    routes: [
      ...state.routes.filter((entry) => entry.sourceGeneration !== sourceGeneration),
      route,
    ],
    pending: route,
    legacyOwner: { ownerId: AMBIGUOUS_GUEST_ATTEMPT_OWNER },
  };
  return { state: next, route, changed: true };
}

export function isGuestClaimState(value: unknown): value is GuestClaimState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GuestClaimState>;
  if (
    candidate.version !== 1
    || typeof candidate.currentGeneration !== 'string'
    || candidate.currentGeneration.length === 0
    || candidate.currentGeneration.length > 256
    || !Array.isArray(candidate.routes)
    || candidate.routes.length > 128
  ) {
    return false;
  }
  const validRoute = (route: unknown): route is GuestClaimRoute => {
    if (!route || typeof route !== 'object' || Array.isArray(route)) return false;
    const parsed = route as Partial<GuestClaimRoute>;
    return typeof parsed.sourceGeneration === 'string'
      && parsed.sourceGeneration.length > 0
      && parsed.sourceGeneration.length <= 256
      && typeof parsed.destinationUserId === 'string'
      && parsed.destinationUserId.length > 0
      && parsed.destinationUserId.length <= 256
      && !parsed.destinationUserId.includes('\0');
  };
  if (!candidate.routes.every(validRoute)) return false;
  const sources = new Set(candidate.routes.map((route) => route.sourceGeneration));
  if (sources.size !== candidate.routes.length || sources.has(candidate.currentGeneration)) {
    return false;
  }
  if (candidate.pending !== undefined && !validRoute(candidate.pending)) return false;
  if (candidate.pending !== undefined && candidate.routes.filter((route) =>
    route.sourceGeneration === candidate.pending!.sourceGeneration
    && route.destinationUserId === candidate.pending!.destinationUserId).length !== 1) {
    return false;
  }
  const validLegacyOwnership = (ownership: unknown): ownership is LegacyAttemptMigration => {
    if (!ownership || typeof ownership !== 'object' || Array.isArray(ownership)) return false;
    const parsed = ownership as Partial<LegacyAttemptMigration>;
    if (parsed.ownerId === AMBIGUOUS_GUEST_ATTEMPT_OWNER) {
      return parsed.guestGeneration === undefined;
    }
    return parsed.ownerId === GUEST_ATTEMPT_OWNER
      && typeof parsed.guestGeneration === 'string'
      && parsed.guestGeneration.length > 0
      && parsed.guestGeneration.length <= 256;
  };
  if (candidate.legacyOwner !== undefined && !validLegacyOwnership(candidate.legacyOwner)) {
    return false;
  }
  if (candidate.legacyOwner !== undefined) {
    const hasPriorGuest = candidate.routes.length > 0 || candidate.pending !== undefined;
    if (hasPriorGuest && candidate.legacyOwner.ownerId !== AMBIGUOUS_GUEST_ATTEMPT_OWNER) {
      return false;
    }
    if (
      !hasPriorGuest
      && (candidate.legacyOwner.ownerId !== GUEST_ATTEMPT_OWNER
        || candidate.legacyOwner.guestGeneration !== candidate.currentGeneration)
    ) {
      return false;
    }
  }
  if (
    candidate.legacyMigration !== undefined
    && (!validLegacyOwnership(candidate.legacyMigration)
      || candidate.legacyOwner === undefined
      || candidate.legacyMigration.ownerId !== candidate.legacyOwner.ownerId
      || candidate.legacyMigration.guestGeneration !== candidate.legacyOwner.guestGeneration)
  ) return false;
  if (candidate.legacyRecovery === undefined) return true;
  const recovery = candidate.legacyRecovery as Partial<LegacyAccountRecoveryBinding>;
  const validSegment = (segment: unknown): segment is string => typeof segment === 'string'
    && segment.length > 0
    && segment.length <= 256
    && !segment.includes('\0');
  return validSegment(recovery.sourceGeneration)
    && validSegment(recovery.legacyUserId)
    && validSegment(recovery.scopedUserId)
    && recovery.scopedUserId.length <= 128
    && recovery.legacyUserId !== recovery.scopedUserId
    && typeof recovery.sourceProfileId === 'string'
    && /^guest:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      recovery.sourceProfileId,
    )
    && candidate.pending?.sourceGeneration === recovery.sourceGeneration
    && candidate.pending.destinationUserId === recovery.scopedUserId
    && candidate.routes.some((route) =>
      route.sourceGeneration === recovery.sourceGeneration
      && route.destinationUserId === recovery.scopedUserId);
}
/**
 * Unacknowledged attempts are never evicted. Storage quota failures are
 * surfaced by the atomic grade transaction; they must never be disguised as
 * successful answers or converted into implicit retention.
 */
const MAX_OUTBOX_CAS_ATTEMPTS = 6;
export const ATTEMPT_OUTBOX_ROW_PREFIX = 'attempt-outbox/v2/';
const GUEST_CLAIM_ADDRESS = {
  collection: STORAGE.history,
  key: GUEST_CLAIM_STORAGE_KEY,
} as const;
const LEGACY_OUTBOX_ADDRESS = {
  collection: STORAGE.history,
  key: ATTEMPT_OUTBOX_STORAGE_KEY,
} as const;

export function preparePendingAttempts(value: unknown): PendingAttempt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Local attempt outbox is malformed');
  return value.map(parsePendingAttempt);
}

function parsePendingAttempt(raw: unknown): PendingAttempt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Local attempt outbox contains an invalid row');
  }
  const entry = raw as Partial<PendingAttempt>;
  if (typeof entry.userId !== 'string') {
    throw new Error('Local attempt outbox contains an invalid owner');
  }
  validateRowSegment(entry.userId, 'attempt owner');
  if (
    entry.guestGeneration !== undefined
    && (typeof entry.guestGeneration !== 'string'
      || entry.guestGeneration.length === 0
      || entry.guestGeneration.length > 256
      || entry.guestGeneration.includes('\0'))
  ) {
    throw new Error('Local attempt outbox contains an invalid guest generation');
  }
  if (entry.guestGeneration !== undefined && entry.userId !== GUEST_ATTEMPT_OWNER) {
    throw new Error('Local attempt outbox contains an invalid guest owner');
  }
  return {
    userId: entry.userId,
    ...(entry.guestGeneration ? { guestGeneration: entry.guestGeneration } : {}),
    attempt: validateQueuedAttempt(entry.attempt),
  };
}

export interface ResolvedAttemptOwnership {
  ownerId: string;
  guestGeneration?: string;
}

export function resolveAttemptOwnership(
  owner: AttemptOwnerSnapshot,
  guestClaimValue: unknown,
): ResolvedAttemptOwnership {
  if (owner.userId !== GUEST_ATTEMPT_OWNER || !owner.guestGeneration) {
    return { ownerId: owner.userId };
  }
  if (guestClaimValue !== undefined && !isGuestClaimState(guestClaimValue)) {
    throw new Error('Guest attempt ownership state is malformed');
  }
  const route = guestClaimValue?.routes.find(
    (candidate) => candidate.sourceGeneration === owner.guestGeneration,
  );
  return route
    ? { ownerId: route.destinationUserId }
    : { ownerId: owner.userId, guestGeneration: owner.guestGeneration };
}

/** Pure, idempotent enqueue used by the atomic local grade commit. */
export function prepareAttemptEnqueue(
  value: unknown,
  owner: AttemptOwnerSnapshot,
  guestClaimValue: unknown,
  attempt: QueuedAttempt,
): { entries: PendingAttempt[]; ownerId: string } {
  const validatedAttempt = validateQueuedAttempt(attempt);
  const ownership = resolveAttemptOwnership(owner, guestClaimValue);
  const ownerId = ownership.ownerId;
  const entries = preparePendingAttempts(value);
  if (entries.some(
    (entry) => entry.userId === ownerId
      && entry.guestGeneration === ownership.guestGeneration
      && entry.attempt.clientAttemptId === validatedAttempt.clientAttemptId,
  )) {
    return { entries, ownerId };
  }
  entries.push({
    userId: ownerId,
    ...(ownership.guestGeneration ? { guestGeneration: ownership.guestGeneration } : {}),
    attempt: validatedAttempt,
  });
  return { entries, ownerId };
}

export function resolveAttemptOwner(
  owner: AttemptOwnerSnapshot,
  guestClaimValue: unknown,
): string {
  return resolveAttemptOwnership(owner, guestClaimValue).ownerId;
}

function validateRowSegment(value: string, label: string): void {
  if (!value || value.length > 256 || value.includes('\0')) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function ownerPrefix(userId: string): string {
  validateRowSegment(userId, 'attempt owner');
  return `${ATTEMPT_OUTBOX_ROW_PREFIX}${encodeURIComponent(userId)}/`;
}

export function attemptOutboxRowKey(userId: string, clientAttemptId: string): string {
  if (!clientAttemptId || clientAttemptId.length > 100 || clientAttemptId.includes('\0')) {
    throw new TypeError('Invalid client attempt identity');
  }
  return `${ownerPrefix(userId)}${encodeURIComponent(clientAttemptId)}`;
}

function parsePendingRow(value: unknown): PendingAttempt {
  return parsePendingAttempt(value);
}

function errorReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Local attempt row is malformed';
}

function canonicalCorruptValue(value: unknown, seen = new Map<object, number>()): unknown {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN'];
    if (value === Number.POSITIVE_INFINITY) return ['number', 'Infinity'];
    if (value === Number.NEGATIVE_INFINITY) return ['number', '-Infinity'];
    if (Object.is(value, -0)) return ['number', '-0'];
    return value;
  }
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'symbol') return ['symbol', value.description ?? ''];
  if (typeof value === 'function') return ['function', value.name];
  if (value === null || typeof value !== 'object') return value;
  const known = seen.get(value);
  if (known !== undefined) return ['reference', known];
  seen.set(value, seen.size);
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? ['date', value.toISOString()] : ['date', 'invalid'];
  }
  if (Array.isArray(value)) return ['array', value.map((entry) => canonicalCorruptValue(entry, seen))];
  if (value instanceof Map) {
    return ['map', [...value.entries()].map(([key, entry]) => [
      canonicalCorruptValue(key, seen),
      canonicalCorruptValue(entry, seen),
    ])];
  }
  if (value instanceof Set) {
    return ['set', [...value.values()].map((entry) => canonicalCorruptValue(entry, seen))];
  }
  const record = value as Record<string, unknown>;
  return ['object', Object.keys(record).sort().map((key) => [
    key,
    canonicalCorruptValue(record[key], seen),
  ])];
}

function corruptFingerprint(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonicalCorruptValue(value)))));
}

function corruptJournalKey(value: unknown, occurrence: number): string {
  return `${ATTEMPT_OUTBOX_CORRUPT_ROW_PREFIX}legacy/${corruptFingerprint(value)}/${occurrence}`;
}

function parseCorruptJournalRow(value: unknown): CorruptAttemptJournalRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Corrupt attempt journal row is malformed');
  }
  const row = value as Partial<CorruptAttemptJournalRow>;
  if (
    row.version !== 1
    || row.source !== 'legacy-array'
    || row.sourceKey !== ATTEMPT_OUTBOX_STORAGE_KEY
    || !Number.isSafeInteger(row.occurrence)
    || (row.occurrence ?? -1) < 0
    || typeof row.reason !== 'string'
    || row.reason.length < 1
    || row.reason.length > 500
    || !Object.prototype.hasOwnProperty.call(row, 'value')
  ) {
    throw new Error('Corrupt attempt journal row is malformed');
  }
  return row as CorruptAttemptJournalRow;
}

function samePending(left: PendingAttempt, right: PendingAttempt): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class AttemptIdentityConflictError extends Error {
  constructor() {
    super('Client attempt identity was reused with different data');
    this.name = 'AttemptIdentityConflictError';
  }
}

/**
 * Durable per-account audit outbox. A response can be lost after the server
 * commits, so the stable clientAttemptId is retained until an acknowledged
 * retry; the server's unique key makes that retry harmless.
 */
export class AttemptOutbox {
  private mutationTail: Promise<void> = Promise.resolve();
  private legacyAccountOwner: (userId: string) => string = () => AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER;

  constructor(private readonly storage: StoragePort) {}

  /** Configure the one-time 2.1 array migration before any outbox access. */
  configureLegacyAccountOwner(resolver: (userId: string) => string): void {
    this.legacyAccountOwner = resolver;
  }

  /** Finish the rolling 2.1 array migration under the currently configured scope. */
  migrateLegacy(): Promise<void> {
    return this.serialize(() => this.migrateLegacyUnlocked());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async putCorruptIfAbsent(
    value: unknown,
    occurrence: number,
    rawReason: string,
  ): Promise<void> {
    const key = corruptJournalKey(value, occurrence);
    const row: CorruptAttemptJournalRow = {
      version: 1,
      source: 'legacy-array',
      sourceKey: ATTEMPT_OUTBOX_STORAGE_KEY,
      occurrence,
      reason: rawReason.slice(0, 500) || 'Local attempt row is malformed',
      value,
    };
    const same = (existing: unknown): boolean => {
      try {
        const parsed = parseCorruptJournalRow(existing);
        return corruptFingerprint(parsed) === corruptFingerprint(row);
      } catch {
        return false;
      }
    };
    if (!hasAtomicStorage(this.storage)) {
      const existing = await this.storage.get<unknown>(STORAGE.history, key);
      if (existing === undefined) await this.storage.set(STORAGE.history, key, row);
      else if (!same(existing)) throw new Error('Corrupt attempt journal identity collision');
      return;
    }
    for (let attempt = 0; attempt < MAX_OUTBOX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await this.storage.readBatch([{ collection: STORAGE.history, key }]);
      if (!snapshot) throw new Error('Corrupt attempt journal read returned no entry');
      if (snapshot.exists) {
        if (!same(snapshot.value)) throw new Error('Corrupt attempt journal identity collision');
        return;
      }
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ collection: STORAGE.history, key, revision: snapshot.revision }],
        mutations: [{ collection: STORAGE.history, key, operation: 'set', value: row }],
      });
      if (committed.committed) return;
    }
    throw new Error('Corrupt attempt journal changed too often');
  }

  private async migrateLegacyUnlocked(): Promise<void> {
    const normalize = (
      row: PendingAttempt,
      migration: LegacyAttemptMigration,
    ): PendingAttempt => {
      if (row.userId !== GUEST_ATTEMPT_OWNER) {
        if (
          row.userId === AMBIGUOUS_GUEST_ATTEMPT_OWNER
          || row.userId === AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER
        ) return row;
        return parsePendingAttempt({
          ...row,
          userId: row.userId.startsWith('account-v1-')
            ? row.userId
            : this.legacyAccountOwner(row.userId),
        });
      }
      if (row.guestGeneration) return row;
      if (migration.ownerId === AMBIGUOUS_GUEST_ATTEMPT_OWNER) {
        return { userId: AMBIGUOUS_GUEST_ATTEMPT_OWNER, attempt: { ...row.attempt } };
      }
      return {
        ...row,
        ...(migration.guestGeneration ? { guestGeneration: migration.guestGeneration } : {}),
      };
    };

    interface LegacyCandidate {
      value: unknown;
      occurrence: number;
      row: PendingAttempt;
    }
    const copyLegacy = async (legacyValue: unknown, migration: LegacyAttemptMigration): Promise<void> => {
      const sourceMalformed = !Array.isArray(legacyValue);
      const rawRows = sourceMalformed ? [legacyValue] : legacyValue;
      const occurrences = new Map<string, number>();
      const candidates: LegacyCandidate[] = [];
      const corrupt: Array<Omit<LegacyCandidate, 'row'> & { reason: string }> = [];
      for (const value of rawRows) {
        const fingerprint = corruptFingerprint(value);
        const occurrence = occurrences.get(fingerprint) ?? 0;
        occurrences.set(fingerprint, occurrence + 1);
        if (sourceMalformed) {
          corrupt.push({ value, occurrence, reason: 'Local attempt outbox is not an array' });
          continue;
        }
        try {
          candidates.push({
            value,
            occurrence,
            row: normalize(parsePendingAttempt(value), migration),
          });
        } catch (cause) {
          corrupt.push({ value, occurrence, reason: errorReason(cause) });
        }
      }

      const groups = new Map<string, LegacyCandidate[]>();
      for (const candidate of candidates) {
        const key = attemptOutboxRowKey(
          candidate.row.userId,
          candidate.row.attempt.clientAttemptId,
        );
        const group = groups.get(key) ?? [];
        group.push(candidate);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const first = group[0]!;
        if (group.some((candidate) => !samePending(candidate.row, first.row))) {
          corrupt.push(...group.map(({ value, occurrence }) => ({
            value,
            occurrence,
            reason: 'Client attempt identity was reused with different data',
          })));
          continue;
        }
        try {
          await this.putIfAbsent(first.row);
        } catch (cause) {
          if (!(cause instanceof AttemptIdentityConflictError)) throw cause;
          corrupt.push(...group.map(({ value, occurrence }) => ({
            value,
            occurrence,
            reason: cause.message,
          })));
        }
      }
      for (const entry of corrupt) {
        await this.putCorruptIfAbsent(entry.value, entry.occurrence, entry.reason);
      }
    };

    if (!hasAtomicStorage(this.storage)) {
      const legacy = await this.storage.get<unknown>(STORAGE.history, ATTEMPT_OUTBOX_STORAGE_KEY);
      if (legacy === undefined || (Array.isArray(legacy) && legacy.length === 0)) return;
      const owner = await this.captureGuestOwnerUnlocked();
      const state = await this.readGuestClaimState();
      if (!state || !owner.guestGeneration) throw new Error('Guest ownership state is missing');
      const migration = inferredLegacyOwner(state);
      await copyLegacy(legacy, migration);
      // A non-atomic adapter cannot prove no old renderer appended after our
      // read. Keep the source journal for a future idempotent pass.
      return;
    }

    // Ensure the generation record exists before copying any row. Its own CAS
    // makes this harmless when another renderer initializes it first.
    await this.captureGuestOwnerUnlocked();
    for (let attempt = 0; attempt < MAX_OUTBOX_CAS_ATTEMPTS; attempt += 1) {
      const [legacySnapshot, claimSnapshot] = await this.storage.readBatch([
        LEGACY_OUTBOX_ADDRESS,
        GUEST_CLAIM_ADDRESS,
      ]);
      if (!legacySnapshot || !claimSnapshot) {
        throw new Error('Legacy attempt migration returned an incomplete snapshot');
      }
      const legacyValue = legacySnapshot.value;
      const legacyEmpty = !legacySnapshot.exists
        || (Array.isArray(legacyValue) && legacyValue.length === 0);
      const parsedClaim = parseGuestClaimValue(claimSnapshot.value);
      if (!parsedClaim.state || parsedClaim.migrated) continue;
      const claimState = parsedClaim.state;
      if (legacyEmpty) {
        if (!claimState.legacyMigration) return;
        const cleared = cloneGuestClaimState(claimState);
        delete cleared.legacyMigration;
        const committed = await this.storage.commitBatch({
          ifRevisions: [
            { ...LEGACY_OUTBOX_ADDRESS, revision: legacySnapshot.revision },
            { ...GUEST_CLAIM_ADDRESS, revision: claimSnapshot.revision },
          ],
          mutations: [{ ...GUEST_CLAIM_ADDRESS, operation: 'set', value: cleared }],
        });
        if (committed.committed) return;
        continue;
      }
      if (!claimState.legacyMigration) {
        const reserved = cloneGuestClaimState(claimState);
        reserved.legacyMigration = inferredLegacyOwner(claimState);
        const committed = await this.storage.commitBatch({
          ifRevisions: [
            { ...LEGACY_OUTBOX_ADDRESS, revision: legacySnapshot.revision },
            { ...GUEST_CLAIM_ADDRESS, revision: claimSnapshot.revision },
          ],
          mutations: [{ ...GUEST_CLAIM_ADDRESS, operation: 'set', value: reserved }],
        });
        if (committed.committed) continue;
        continue;
      }
      const migration = claimState.legacyMigration;
      await copyLegacy(legacyValue, migration);
      // The bounded row copies above are idempotent. Delete only if neither
      // the legacy writer nor the migration marker changed since our snapshot.
      // Claims are refused while the marker exists, so a retry can never
      // reclassify old rows into a later guest generation.
      const finished = cloneGuestClaimState(claimState);
      delete finished.legacyMigration;
      const committed = await this.storage.commitBatch({
        ifRevisions: [
          { ...LEGACY_OUTBOX_ADDRESS, revision: legacySnapshot.revision },
          { ...GUEST_CLAIM_ADDRESS, revision: claimSnapshot.revision },
        ],
        mutations: [
          { ...LEGACY_OUTBOX_ADDRESS, operation: 'delete' },
          { ...GUEST_CLAIM_ADDRESS, operation: 'set', value: finished },
        ],
      });
      if (committed.committed) return;
    }
    throw new Error('Legacy attempt journal kept changing during migration');
  }

  private async putIfAbsent(row: PendingAttempt): Promise<void> {
    const key = attemptOutboxRowKey(row.userId, row.attempt.clientAttemptId);
    if (!hasAtomicStorage(this.storage)) {
      const current = await this.storage.get<unknown>(STORAGE.history, key);
      if (current !== undefined) {
        try {
          if (!samePending(parsePendingRow(current), row)) throw new AttemptIdentityConflictError();
        } catch (cause) {
          if (cause instanceof AttemptIdentityConflictError) throw cause;
          throw new AttemptIdentityConflictError();
        }
        return;
      }
      await this.storage.set(STORAGE.history, key, row);
      return;
    }
    for (let attempt = 0; attempt < MAX_OUTBOX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await this.storage.readBatch([{ collection: STORAGE.history, key }]);
      if (!snapshot) throw new Error('Attempt outbox row read returned no entry');
      if (snapshot.exists) {
        try {
          if (!samePending(parsePendingRow(snapshot.value), row)) throw new AttemptIdentityConflictError();
        } catch (cause) {
          if (cause instanceof AttemptIdentityConflictError) throw cause;
          throw new AttemptIdentityConflictError();
        }
        return;
      }
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ collection: STORAGE.history, key, revision: snapshot.revision }],
        mutations: [{ collection: STORAGE.history, key, operation: 'set', value: row }],
      });
      if (committed.committed) return;
    }
    throw new Error('Attempt outbox row changed too often to commit safely');
  }

  private async putCapturedGuest(
    owner: AttemptOwnerSnapshot,
    attempt: QueuedAttempt,
  ): Promise<string> {
    if (!hasAtomicStorage(this.storage)) {
      const ownership = resolveAttemptOwnership(owner, await this.readGuestClaimState());
      await this.putIfAbsent({
        userId: ownership.ownerId,
        ...(ownership.guestGeneration ? { guestGeneration: ownership.guestGeneration } : {}),
        attempt: { ...attempt },
      });
      return ownership.ownerId;
    }
    for (let retry = 0; retry < MAX_OUTBOX_CAS_ATTEMPTS; retry += 1) {
      const [claimBefore] = await this.storage.readBatch([GUEST_CLAIM_ADDRESS]);
      if (!claimBefore) throw new Error('Guest ownership read returned no entry');
      const parsedBefore = parseGuestClaimValue(claimBefore.value);
      if (!parsedBefore.state || parsedBefore.migrated) {
        await this.captureGuestOwnerUnlocked();
        continue;
      }
      const ownership = resolveAttemptOwnership(owner, parsedBefore.state);
      const row: PendingAttempt = {
        userId: ownership.ownerId,
        ...(ownership.guestGeneration ? { guestGeneration: ownership.guestGeneration } : {}),
        attempt: { ...attempt },
      };
      const rowAddress = {
        collection: STORAGE.history,
        key: attemptOutboxRowKey(ownership.ownerId, attempt.clientAttemptId),
      } as const;
      const [claimSnapshot, rowSnapshot] = await this.storage.readBatch([
        GUEST_CLAIM_ADDRESS,
        rowAddress,
      ]);
      if (!claimSnapshot || !rowSnapshot) {
        throw new Error('Guest attempt commit returned an incomplete snapshot');
      }
      if (claimSnapshot.revision !== claimBefore.revision) continue;
      if (rowSnapshot.exists) {
        if (!samePending(parsePendingRow(rowSnapshot.value), row)) {
          throw new Error('Client attempt identity was reused with different data');
        }
        return ownership.ownerId;
      }
      try {
        const committed = await this.storage.commitBatch({
          ifRevisions: [
            { ...GUEST_CLAIM_ADDRESS, revision: claimSnapshot.revision },
            { ...rowAddress, revision: rowSnapshot.revision },
          ],
          mutations: [{ ...rowAddress, operation: 'set', value: row }],
        });
        if (committed.committed) return ownership.ownerId;
      } catch (cause) {
        // IPC may lose the reply after committing. Confirm either the old
        // address or the now-routed destination before surfacing an error.
        const latestClaim = parseGuestClaimValue(
          await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY),
        ).state;
        const latestOwnership = latestClaim
          ? resolveAttemptOwnership(owner, latestClaim)
          : ownership;
        const candidates = new Set([ownership.ownerId, latestOwnership.ownerId]);
        for (const ownerId of candidates) {
          const durable = await this.storage.get<unknown>(
            STORAGE.history,
            attemptOutboxRowKey(ownerId, attempt.clientAttemptId),
          );
          if (durable === undefined) continue;
          const expected: PendingAttempt = {
            userId: ownerId,
            ...(ownerId === ownership.ownerId && ownership.guestGeneration
              ? { guestGeneration: ownership.guestGeneration }
              : ownerId === latestOwnership.ownerId && latestOwnership.guestGeneration
                ? { guestGeneration: latestOwnership.guestGeneration }
                : {}),
            attempt: { ...attempt },
          };
          if (samePending(parsePendingRow(durable), expected)) return latestOwnership.ownerId;
        }
        throw cause;
      }
    }
    throw new Error('Guest ownership changed too often to queue the attempt safely');
  }

  private async rowsForOwner(userId: string): Promise<Array<{ key: string; row: PendingAttempt }>> {
    const prefix = ownerPrefix(userId);
    const keys = (await this.storage.keys(STORAGE.history)).filter((key) => key.startsWith(prefix));
    const values = new Map<string, unknown>();
    if (hasAtomicStorage(this.storage)) {
      for (let offset = 0; offset < keys.length; offset += 32) {
        const entries = await this.storage.readBatch(
          keys.slice(offset, offset + 32).map((key) => ({ collection: STORAGE.history, key })),
        );
        for (const entry of entries) if (entry.exists) values.set(entry.key, entry.value);
      }
    } else {
      await Promise.all(keys.map(async (key) => {
        const value = await this.storage.get<unknown>(STORAGE.history, key);
        if (value !== undefined) values.set(key, value);
      }));
    }
    const rows: Array<{ key: string; row: PendingAttempt }> = [];
    for (const key of keys) {
      const value = values.get(key);
      if (value === undefined) continue;
      try {
        const row = parsePendingRow(value);
        if (row.userId !== userId || attemptOutboxRowKey(userId, row.attempt.clientAttemptId) !== key) {
          continue;
        }
        rows.push({ key, row });
      } catch {
        // Persisted bad rows remain byte-for-byte at their original address.
        // Read paths skip them so an older corrupt answer cannot block later
        // valid work; corruptInventory() is the explicit export seam.
      }
    }
    return rows
      .sort((left, right) =>
        left.row.attempt.gradedAt.localeCompare(right.row.attempt.gradedAt)
        || left.row.attempt.clientAttemptId.localeCompare(right.row.attempt.clientAttemptId));
  }

  private async readGuestClaimState(): Promise<GuestClaimState | undefined> {
    const value = await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY);
    const parsed = parseGuestClaimValue(value);
    if (parsed.migrated && parsed.state) {
      await this.storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, parsed.state);
    }
    return parsed.state;
  }

  private async captureGuestOwnerUnlocked(): Promise<AttemptOwnerSnapshot> {
    if (!hasAtomicStorage(this.storage)) {
      let state = await this.readGuestClaimState();
      if (!state) {
        state = initialGuestClaimState();
        await this.storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, state);
      }
      return {
        userId: GUEST_ATTEMPT_OWNER,
        guestGeneration: state.currentGeneration,
      };
    }
    for (let attempt = 0; attempt < MAX_OUTBOX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await this.storage.readBatch([GUEST_CLAIM_ADDRESS]);
      if (!snapshot) throw new Error('Guest ownership revision read returned no entry');
      const parsed = parseGuestClaimValue(snapshot.value);
      if (parsed.state && !parsed.migrated) {
        return {
          userId: GUEST_ATTEMPT_OWNER,
          guestGeneration: parsed.state.currentGeneration,
        };
      }
      const state = parsed.state ?? initialGuestClaimState();
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ ...GUEST_CLAIM_ADDRESS, revision: snapshot.revision }],
        mutations: [{ ...GUEST_CLAIM_ADDRESS, operation: 'set', value: state }],
      });
      if (committed.committed) {
        return {
          userId: GUEST_ATTEMPT_OWNER,
          guestGeneration: state.currentGeneration,
        };
      }
    }
    throw new Error('Guest ownership changed too often to capture safely');
  }

  /** Capture the generation of a newly-created guest practice session. */
  captureGuestOwner(): Promise<AttemptOwnerSnapshot> {
    return this.serialize(() => this.captureGuestOwnerUnlocked());
  }

  /**
   * Migrates the pre-2.2 journal before the atomic profile/outbox reservation.
   * This step does not rotate either identity, so a crash here is harmless.
   */
  prepareForGuestClaim(): Promise<void> {
    return this.serialize(async () => {
      await this.migrateLegacyUnlocked();
      await this.captureGuestOwnerUnlocked();
    });
  }

  /**
   * Enqueue under the owner captured at session creation. A completed invite
   * claim leaves a durable route for that one guest generation, so an answer
   * that reaches the outbox after the claim's marker was cleared still lands
   * in the created account. The rotated current generation remains local.
   *
   * Returns the resolved owner, which may be the destination of a generation
   * route and is therefore the only account a caller may attempt to flush.
   */
  async enqueue(owner: string | AttemptOwnerSnapshot, attempt: QueuedAttempt): Promise<string> {
    // Reject before migration or any other storage mutation: an invalid new
    // answer must never look durably accepted merely because maintenance ran.
    const validatedAttempt = validateQueuedAttempt(attempt);
    const initial = typeof owner === 'string' ? { userId: owner } : owner;
    return this.serialize(async () => {
      await this.migrateLegacyUnlocked();
      const captured = initial.userId === GUEST_ATTEMPT_OWNER && !initial.guestGeneration
        ? { ...initial, ...(await this.captureGuestOwnerUnlocked()) }
        : initial;
      if (captured.userId === GUEST_ATTEMPT_OWNER) {
        return this.putCapturedGuest(captured, validatedAttempt);
      }
      const ownership = resolveAttemptOwnership(captured, await this.readGuestClaimState());
      await this.putIfAbsent({
        userId: ownership.ownerId,
        ...(ownership.guestGeneration ? { guestGeneration: ownership.guestGeneration } : {}),
        attempt: validatedAttempt,
      });
      return ownership.ownerId;
    });
  }

  /**
   * Persist the destination of an invite-redemption claim before auth state is
   * committed. A crash after the session write can then finish the hand-off on
   * the next boot or on a later login to the same account. A marker belonging
   * to another account is never overwritten: the one guest bucket cannot be
   * safely promised to two people on a shared device.
   */
  async beginGuestClaim(destinationUserId: string): Promise<void> {
    await this.serialize(async () => {
      if (
        !hasAtomicStorage(this.storage)
        && await this.storage.get<unknown>(STORAGE.history, ATTEMPT_OUTBOX_STORAGE_KEY) !== undefined
      ) {
        throw new Error('Atomic storage is required to assign legacy guest attempts safely');
      }
      // Stamp the pre-2.2 array with the still-current generation before the
      // marker rotates it. Migrating after rotation would make old answers
      // look like work created by the next person using this device.
      await this.migrateLegacyUnlocked();
      if (!hasAtomicStorage(this.storage)) {
        const prepared = prepareGuestClaim(
          await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY),
          destinationUserId,
        );
        if (prepared.changed) {
          await this.storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, prepared.state);
        }
        return;
      }
      for (let attempt = 0; attempt < MAX_OUTBOX_CAS_ATTEMPTS; attempt += 1) {
        const [snapshot] = await this.storage.readBatch([GUEST_CLAIM_ADDRESS]);
        if (!snapshot) throw new Error('Guest ownership revision read returned no entry');
        const prepared = prepareGuestClaim(snapshot.value, destinationUserId);
        if (!prepared.changed) return;
        const committed = await this.storage.commitBatch({
          ifRevisions: [{ ...GUEST_CLAIM_ADDRESS, revision: snapshot.revision }],
          mutations: [{ ...GUEST_CLAIM_ADDRESS, operation: 'set', value: prepared.state }],
        });
        if (committed.committed) return;
      }
      throw new Error('Guest claim changed too often to begin safely');
    });
  }

  async pendingGuestClaim(): Promise<string | undefined> {
    return (await this.pendingGuestClaimRoute())?.destinationUserId;
  }

  async pendingGuestClaimRoute(): Promise<GuestClaimRoute | undefined> {
    await this.mutationTail;
    const raw = await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY);
    const state = parseGuestClaimValue(raw).state;
    const pending = state?.legacyRecovery ? undefined : state?.pending;
    return pending ? { ...pending } : undefined;
  }

  async pendingLegacyAccountRecovery(): Promise<LegacyAccountRecoveryBinding | undefined> {
    await this.mutationTail;
    const raw = await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY);
    const binding = parseGuestClaimValue(raw).state?.legacyRecovery;
    return binding ? { ...binding } : undefined;
  }

  /**
   * Upgrade only the guest-claim destination written before Server origins
   * became part of local identity. Raw account-owned rows cannot prove their
   * issuer, even when the raw user id matches the newly verified account, so
   * they are moved to export-only quarantine instead of to that account.
   */
  async migrateLegacyAccountIdentity(
    legacyUserId: string,
    scopedUserId: string,
  ): Promise<void> {
    validateRowSegment(legacyUserId, 'legacy account identity');
    validateRowSegment(scopedUserId, 'scoped account identity');
    if (legacyUserId === scopedUserId) return;

    await this.serialize(async () => {
      await this.migrateLegacyUnlocked();
      if (!hasAtomicStorage(this.storage)) {
        const state = await this.readGuestClaimState();
        if (!state) return;
        let changed = false;
        const routes = state.routes.map((route) => {
          if (route.destinationUserId !== legacyUserId) return route;
          changed = true;
          return { ...route, destinationUserId: scopedUserId };
        });
        const pending = state.pending?.destinationUserId === legacyUserId
          ? { ...state.pending, destinationUserId: scopedUserId }
          : state.pending;
        if (pending !== state.pending) changed = true;
        if (changed) {
          await this.storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, {
            ...state,
            routes,
            ...(pending ? { pending } : {}),
          });
        }
        return;
      }

      for (let attempt = 0; attempt < MAX_OUTBOX_CAS_ATTEMPTS; attempt += 1) {
        const [snapshot] = await this.storage.readBatch([GUEST_CLAIM_ADDRESS]);
        if (!snapshot) throw new Error('Guest ownership revision read returned no entry');
        const parsed = parseGuestClaimValue(snapshot.value);
        const state = parsed.state;
        if (!state) return;
        let changed = parsed.migrated;
        const routes = state.routes.map((route) => {
          if (route.destinationUserId !== legacyUserId) return route;
          changed = true;
          return { ...route, destinationUserId: scopedUserId };
        });
        const pending = state.pending?.destinationUserId === legacyUserId
          ? { ...state.pending, destinationUserId: scopedUserId }
          : state.pending;
        if (pending !== state.pending) changed = true;
        if (!changed) return;
        const next: GuestClaimState = {
          ...state,
          routes,
          ...(pending ? { pending } : {}),
        };
        const committed = await this.storage.commitBatch({
          ifRevisions: [{ ...GUEST_CLAIM_ADDRESS, revision: snapshot.revision }],
          mutations: [{ ...GUEST_CLAIM_ADDRESS, operation: 'set', value: next }],
        });
        if (committed.committed) return;
      }
      throw new Error('Guest claim identity changed too often to migrate safely');
    });

    // Preview renderers may already have emitted v2 rows under the raw account
    // id. Their Server origin is unknowable; never upload them to the current
    // endpoint merely because its user id happens to match.
    await this.claim(legacyUserId, AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER);
  }

  /** Read-only recovery seam for a persisted session created before profile keys existed. */
  async guestClaimRouteForUser(destinationUserId: string): Promise<GuestClaimRoute | undefined> {
    await this.mutationTail;
    const raw = await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY);
    const state = parseGuestClaimValue(raw).state;
    if (state?.pending?.destinationUserId === destinationUserId) {
      return { ...state.pending };
    }
    const route = [...(state?.routes ?? [])]
      .reverse()
      .find((candidate) => candidate.destinationUserId === destinationUserId);
    return route ? { ...route } : undefined;
  }

  /** Clear only the pending intent; the old-generation route stays durable. */
  async finishGuestClaim(destinationUserId: string): Promise<void> {
    await this.serialize(async () => {
      if (!hasAtomicStorage(this.storage)) {
        const state = await this.readGuestClaimState();
        if (state?.pending?.destinationUserId !== destinationUserId) return;
        if (state.legacyRecovery) {
          throw new Error('Legacy account recovery must clear its marker atomically');
        }
        if (state.legacyMigration) {
          throw new Error('Legacy attempts are still being assigned; retry guest recovery');
        }
        delete state.pending;
        await this.storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, state);
        return;
      }
      for (let attempt = 0; attempt < MAX_OUTBOX_CAS_ATTEMPTS; attempt += 1) {
        const [snapshot] = await this.storage.readBatch([GUEST_CLAIM_ADDRESS]);
        if (!snapshot) throw new Error('Guest ownership revision read returned no entry');
        const parsed = parseGuestClaimValue(snapshot.value);
        const state = parsed.state;
        if (state?.pending?.destinationUserId !== destinationUserId) return;
        if (state.legacyRecovery) {
          throw new Error('Legacy account recovery must clear its marker atomically');
        }
        if (state.legacyMigration) {
          throw new Error('Legacy attempts are still being assigned; retry guest recovery');
        }
        delete state.pending;
        const committed = await this.storage.commitBatch({
          ifRevisions: [{ ...GUEST_CLAIM_ADDRESS, revision: snapshot.revision }],
          mutations: [{ ...GUEST_CLAIM_ADDRESS, operation: 'set', value: state }],
        });
        if (committed.committed) return;
      }
      throw new Error('Guest claim changed too often to finish safely');
    });
  }

  /**
   * Atomically move one owner's pending attempts to another owner. Stable
   * clientAttemptId values make the move idempotent and let us discard a
   * source duplicate when the destination already contains it.
   */
  async claim(
    sourceUserId: string,
    destinationUserId: string,
    sourceGuestGeneration?: string,
  ): Promise<number> {
    if (sourceUserId === destinationUserId) return 0;
    if (sourceUserId === GUEST_ATTEMPT_OWNER && !sourceGuestGeneration) {
      throw new TypeError('A guest generation is required to claim attempts safely');
    }
    return this.serialize(async () => {
      await this.migrateLegacyUnlocked();
      let claimed = 0;
      for (const { key, row } of await this.rowsForOwner(sourceUserId)) {
        if (
          sourceUserId === GUEST_ATTEMPT_OWNER
          && row.guestGeneration !== sourceGuestGeneration
        ) {
          continue;
        }
        const destination: PendingAttempt = {
          userId: destinationUserId,
          attempt: { ...row.attempt },
        };
        const destinationKey = attemptOutboxRowKey(
          destinationUserId,
          destination.attempt.clientAttemptId,
        );
        const existing = await this.storage.get<unknown>(STORAGE.history, destinationKey);
        if (existing === undefined) {
          try {
            await this.putIfAbsent(destination);
          } catch (cause) {
            if (cause instanceof AttemptIdentityConflictError) continue;
            throw cause;
          }
          claimed += 1;
        } else {
          try {
            if (!samePending(parsePendingRow(existing), destination)) continue;
          } catch {
            continue;
          }
        }
        await this.storage.delete(STORAGE.history, key);
      }
      return claimed;
    });
  }

  /**
   * Read-only export seam for malformed v2 rows and isolated legacy values.
   * Merely inspecting recovery data never rewrites, deletes or reclassifies it.
   */
  async corruptInventory(): Promise<CorruptAttemptInventoryRow[]> {
    await this.mutationTail;
    const keys = (await this.storage.keys(STORAGE.history)).filter((key) =>
      key.startsWith(ATTEMPT_OUTBOX_ROW_PREFIX)
      || key.startsWith(ATTEMPT_OUTBOX_CORRUPT_ROW_PREFIX));
    const values = new Map<string, unknown>();
    if (hasAtomicStorage(this.storage)) {
      for (let offset = 0; offset < keys.length; offset += 32) {
        const entries = await this.storage.readBatch(
          keys.slice(offset, offset + 32).map((key) => ({ collection: STORAGE.history, key })),
        );
        for (const entry of entries) if (entry.exists) values.set(entry.key, entry.value);
      }
    } else {
      await Promise.all(keys.map(async (key) => {
        const value = await this.storage.get<unknown>(STORAGE.history, key);
        if (value !== undefined) values.set(key, value);
      }));
    }

    const corrupt: CorruptAttemptInventoryRow[] = [];
    for (const key of keys) {
      const value = values.get(key);
      if (value === undefined) continue;
      if (key.startsWith(ATTEMPT_OUTBOX_CORRUPT_ROW_PREFIX)) {
        try {
          const row = parseCorruptJournalRow(value);
          corrupt.push({ key, source: 'legacy-journal', reason: row.reason, value: row.value });
        } catch (cause) {
          corrupt.push({ key, source: 'legacy-journal', reason: errorReason(cause), value });
        }
        continue;
      }
      try {
        const row = parsePendingRow(value);
        if (attemptOutboxRowKey(row.userId, row.attempt.clientAttemptId) === key) continue;
        corrupt.push({
          key,
          source: 'v2-row',
          reason: 'Local attempt outbox row identity is malformed',
          value,
        });
      } catch (cause) {
        corrupt.push({ key, source: 'v2-row', reason: errorReason(cause), value });
      }
    }
    return corrupt.sort((left, right) => left.key.localeCompare(right.key));
  }

  async corruptCount(): Promise<number> {
    return (await this.corruptInventory()).length;
  }

  /** Read-only count for one exact guest generation used by recovery UI. */
  async guestGenerationCount(sourceGeneration: string): Promise<number> {
    validateRowSegment(sourceGeneration, 'guest generation');
    await this.mutationTail;
    return (await this.rowsForOwner(GUEST_ATTEMPT_OWNER))
      .filter(({ row }) => row.guestGeneration === sourceGeneration)
      .length;
  }

  async list(userId: string, limit = 1000): Promise<QueuedAttempt[]> {
    await this.mutationTail;
    await this.migrateLegacyUnlocked();
    return (await this.rowsForOwner(userId))
      .slice(0, limit)
      .map(({ row }) => row.attempt);
  }

  remove(userId: string, clientAttemptIds: string[]): Promise<void> {
    return this.serialize(async () => {
      await this.migrateLegacyUnlocked();
      for (const id of clientAttemptIds) {
        const key = attemptOutboxRowKey(userId, id);
        if (!hasAtomicStorage(this.storage)) {
          const value = await this.storage.get<unknown>(STORAGE.history, key);
          if (value === undefined) continue;
          try {
            const row = parsePendingRow(value);
            if (row.userId !== userId || attemptOutboxRowKey(userId, row.attempt.clientAttemptId) !== key) {
              continue;
            }
          } catch {
            continue;
          }
          await this.storage.delete(STORAGE.history, key);
          continue;
        }
        for (let attempt = 0; attempt < MAX_OUTBOX_CAS_ATTEMPTS; attempt += 1) {
          const [snapshot] = await this.storage.readBatch([{ collection: STORAGE.history, key }]);
          if (!snapshot || !snapshot.exists) break;
          try {
            const row = parsePendingRow(snapshot.value);
            if (row.userId !== userId || attemptOutboxRowKey(userId, row.attempt.clientAttemptId) !== key) {
              break;
            }
          } catch {
            break;
          }
          const committed = await this.storage.commitBatch({
            ifRevisions: [{ collection: STORAGE.history, key, revision: snapshot.revision }],
            mutations: [{ collection: STORAGE.history, key, operation: 'delete' }],
          });
          if (committed.committed) break;
        }
      }
    });
  }

  async count(userId: string): Promise<number> {
    await this.mutationTail;
    await this.migrateLegacyUnlocked();
    return (await this.rowsForOwner(userId)).length;
  }
}
