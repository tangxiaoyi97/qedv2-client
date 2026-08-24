import {
  hasAtomicStorage,
  STORAGE,
  type StorageAddress,
  type StoragePort,
} from '../ports/index.js';
import {
  AMBIGUOUS_GUEST_ATTEMPT_OWNER,
  GUEST_CLAIM_STORAGE_KEY,
  parseGuestClaimStateValue,
  prepareGuestClaim,
} from './attempt-outbox.js';
import { canonicalizeArchive, type ArchiveContent, type LocalArchive } from '../model/archive.js';

export type LocalProfileId = `guest:${string}` | `user:${string}`;

export interface LocalProfileState {
  version: 1;
  activeProfileId: LocalProfileId;
  guestProfileId: LocalProfileId;
  routes: Array<{
    sourceProfileId: LocalProfileId;
    destinationProfileId: LocalProfileId;
  }>;
  /** Ambiguous rolling-upgrade documents preserved for explicit recovery. */
  recoveryProfileIds?: LocalProfileId[];
  /**
   * One stable bucket for writes from a still-open 2.1 renderer. Reusing it
   * prevents every refresh from retaining another copy of the same snapshot.
   */
  legacyQuarantineProfileId?: LocalProfileId;
}

export const LOCAL_PROFILE_STATE_KEY = 'local-profiles/v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CAS_ATTEMPTS = 6;
const MAX_PROFILE_ROUTES = 128;
const MAX_RECOVERY_PROFILES = 128;

const STATE_ADDRESS = { collection: STORAGE.app, key: LOCAL_PROFILE_STATE_KEY } as const;
const LEGACY_ARCHIVE_ADDRESS = { collection: STORAGE.archive, key: 'current' } as const;
const LEGACY_HISTORY_ADDRESS = { collection: STORAGE.history, key: 'log' } as const;
const GUEST_CLAIM_ADDRESS = {
  collection: STORAGE.history,
  key: GUEST_CLAIM_STORAGE_KEY,
} as const;

function uuidV4(): string {
  const native = globalThis.crypto?.randomUUID?.();
  if (native && UUID_V4.test(native)) return native;
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.every((value) => value === 0)) {
    throw new Error('Secure random profile generation is unavailable');
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function guestLocalProfileId(id = uuidV4()): LocalProfileId {
  if (!UUID_V4.test(id)) throw new TypeError('Invalid guest profile identity');
  return `guest:${id}`;
}

export function userLocalProfileId(userId: string): LocalProfileId {
  if (!userId || userId.length > 128 || userId.includes('\0')) {
    throw new TypeError('Invalid user profile identity');
  }
  return `user:${userId}`;
}

export function isLocalProfileId(value: unknown): value is LocalProfileId {
  if (typeof value !== 'string') return false;
  if (value.startsWith('guest:')) return UUID_V4.test(value.slice('guest:'.length));
  return value.startsWith('user:')
    && value.length > 'user:'.length
    && value.length <= 'user:'.length + 128
    && !value.includes('\0');
}

export function parseLocalProfileState(value: unknown): LocalProfileState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Local profile state is malformed');
  }
  const state = value as Partial<LocalProfileState>;
  const routes = state.routes ?? [];
  const recoveryProfileIds = state.recoveryProfileIds ?? [];
  const routeSources = new Set(
    routes.flatMap((route) => route && typeof route === 'object'
      ? [(route as { sourceProfileId?: unknown }).sourceProfileId]
      : []),
  );
  if (
    state.version !== 1
    || !isLocalProfileId(state.activeProfileId)
    || !isLocalProfileId(state.guestProfileId)
    || !state.guestProfileId.startsWith('guest:')
    || !Array.isArray(routes)
    || routes.length > MAX_PROFILE_ROUTES
    || !Array.isArray(recoveryProfileIds)
    || recoveryProfileIds.length > MAX_RECOVERY_PROFILES
    || recoveryProfileIds.some((profileId) =>
      !isLocalProfileId(profileId) || !profileId.startsWith('guest:'))
    || routes.some((route) =>
      !route
      || !isLocalProfileId(route.sourceProfileId)
      || !route.sourceProfileId.startsWith('guest:')
      || !isLocalProfileId(route.destinationProfileId)
      || !route.destinationProfileId.startsWith('user:'))
    || routeSources.size !== routes.length
    || routeSources.has(state.guestProfileId)
    || routeSources.has(state.activeProfileId)
    || new Set(recoveryProfileIds).size !== recoveryProfileIds.length
    || recoveryProfileIds.includes(state.guestProfileId)
    || recoveryProfileIds.includes(state.activeProfileId)
    || recoveryProfileIds.some((profileId) => routeSources.has(profileId))
    || (state.legacyQuarantineProfileId !== undefined
      && (!isLocalProfileId(state.legacyQuarantineProfileId)
        || !state.legacyQuarantineProfileId.startsWith('guest:')
        || !recoveryProfileIds.includes(state.legacyQuarantineProfileId)))
  ) {
    throw new Error('Local profile state is malformed');
  }
  return {
    ...(state as LocalProfileState),
    routes: routes.map((route) => ({ ...route })),
    ...(recoveryProfileIds.length > 0 ? { recoveryProfileIds: [...recoveryProfileIds] } : {}),
    ...(state.legacyQuarantineProfileId
      ? { legacyQuarantineProfileId: state.legacyQuarantineProfileId }
      : {}),
  };
}

export function resolveLocalProfileId(
  state: LocalProfileState,
  profileId: LocalProfileId,
): LocalProfileId {
  return state.routes.find((route) => route.sourceProfileId === profileId)
    ?.destinationProfileId ?? profileId;
}

function encodedProfile(profileId: LocalProfileId): string {
  if (!isLocalProfileId(profileId)) throw new TypeError('Invalid local profile identity');
  return encodeURIComponent(profileId);
}

export function archiveStorageKey(profileId?: LocalProfileId): string {
  return profileId ? `profile/v1/${encodedProfile(profileId)}/current` : 'current';
}

export function historyStorageKey(profileId?: LocalProfileId): string {
  return profileId ? `profile/v1/${encodedProfile(profileId)}/log` : 'log';
}

function profileAddresses(profileId: LocalProfileId): {
  archive: StorageAddress;
  history: StorageAddress;
} {
  return {
    archive: { collection: STORAGE.archive, key: archiveStorageKey(profileId) },
    history: { collection: STORAGE.history, key: historyStorageKey(profileId) },
  };
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function parseCompactArchive(value: unknown): LocalArchive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Legacy recovery archive is malformed');
  }
  const archive = value as Partial<LocalArchive>;
  if (
    !Number.isSafeInteger(archive.baseVersion)
    || (archive.baseVersion ?? -1) < 0
    || !archive.content
    || typeof archive.content !== 'object'
    || Array.isArray(archive.content)
    || !Array.isArray((archive.content as Partial<ArchiveContent>).perPart)
    || !Array.isArray((archive.content as Partial<ArchiveContent>).perCompetency)
  ) {
    throw new Error('Legacy recovery archive is malformed');
  }
  const content = canonicalizeArchive(archive.content as ArchiveContent);
  if (
    new Set(content.perPart.map((entry) => entry.partId)).size !== content.perPart.length
    || new Set(content.perCompetency.map((entry) => entry.code)).size
      !== content.perCompetency.length
  ) {
    throw new Error('Legacy recovery archive contains duplicate identities');
  }
  return { content, baseVersion: archive.baseVersion! };
}

function mergeByTimestamp<T extends { updatedAt: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  identity: (entry: T) => string,
): T[] {
  const merged = new Map<string, T>();
  for (const entry of [...existing, ...incoming]) {
    const id = identity(entry);
    const prior = merged.get(id);
    if (!prior || prior.updatedAt < entry.updatedAt) {
      merged.set(id, entry);
      continue;
    }
    if (prior.updatedAt === entry.updatedAt && stableJson(prior) !== stableJson(entry)) {
      throw new Error(`Legacy recovery entry ${id} conflicts at the same timestamp`);
    }
  }
  return [...merged.values()];
}

/**
 * Compact cumulative 2.1 archive snapshots entry-by-entry. The isolated data
 * is never synced automatically, so reset its account-specific base version.
 */
function compactLegacyArchive(existing: unknown, incoming: unknown): unknown {
  if (existing === undefined) {
    try {
      const archive = parseCompactArchive(incoming);
      return { content: archive.content, baseVersion: 0 } satisfies LocalArchive;
    } catch {
      // Preserve malformed legacy data byte-for-byte for export. A later,
      // different snapshot cannot be compacted into it and will fail closed.
      return incoming;
    }
  }
  if (stableJson(existing) === stableJson(incoming)) return existing;
  const left = parseCompactArchive(existing);
  const right = parseCompactArchive(incoming);
  return {
    content: canonicalizeArchive({
      perPart: mergeByTimestamp(left.content.perPart, right.content.perPart, (entry) => entry.partId),
      perCompetency: mergeByTimestamp(
        left.content.perCompetency,
        right.content.perCompetency,
        (entry) => entry.code,
      ),
    }),
    baseVersion: 0,
  } satisfies LocalArchive;
}

function archiveForEmptyTarget(source: unknown, target: unknown): unknown {
  if (target === undefined) return source;
  const sourceArchive = parseCompactArchive(source);
  const targetArchive = parseCompactArchive(target);
  if (
    targetArchive.content.perPart.length > 0
    || targetArchive.content.perCompetency.length > 0
  ) throw new Error('Destination account already has local progress');
  return {
    content: sourceArchive.content,
    baseVersion: targetArchive.baseVersion,
  } satisfies LocalArchive;
}

/**
 * Merge cumulative newest-first snapshots without summing the overlap. For
 * byte-equivalent rows, retain the greatest count observed in either
 * snapshot. A Set/Map would silently erase repeated attempts that predate
 * clientAttemptId.
 */
function compactLegacyHistory(existing: unknown, incoming: unknown): unknown {
  if (existing === undefined) return incoming;
  if (stableJson(existing) === stableJson(incoming)) return existing;
  if (!Array.isArray(existing) || !Array.isArray(incoming)) {
    throw new Error('Legacy recovery history is malformed');
  }
  const attemptValues = new Map<string, string>();
  const inspect = (rows: readonly unknown[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = stableJson(row);
      counts.set(value, (counts.get(value) ?? 0) + 1);
      const clientAttemptId = row && typeof row === 'object' && !Array.isArray(row)
        ? (row as { clientAttemptId?: unknown }).clientAttemptId
        : undefined;
      if (typeof clientAttemptId !== 'string' || clientAttemptId.length === 0) continue;
      const prior = attemptValues.get(clientAttemptId);
      if (prior !== undefined && prior !== value) {
        throw new Error(`Legacy recovery history attempt:${clientAttemptId} conflicts`);
      }
      attemptValues.set(clientAttemptId, value);
    }
    return counts;
  };
  const existingCounts = inspect(existing);
  const incomingCounts = inspect(incoming);
  const required = new Map<string, number>();
  for (const [value, count] of [...existingCounts, ...incomingCounts]) {
    required.set(value, Math.max(required.get(value) ?? 0, count));
  }

  const result = [...incoming];
  const included = new Map(incomingCounts);
  for (const row of existing) {
    const value = stableJson(row);
    if ((included.get(value) ?? 0) >= (required.get(value) ?? 0)) continue;
    result.push(row);
    included.set(value, (included.get(value) ?? 0) + 1);
  }
  return result;
}

/**
 * Selects one durable local profile without ever conflating an ordinary login
 * with guest-data ownership. The first 2.2 boot moves the old shared archive
 * and history atomically to the account that was already signed in, or to a
 * fresh guest generation when no stored session exists.
 */
export class LocalProfileStore {
  private state: LocalProfileState | undefined;
  /** Renderer-local selection; durable state is only a restart hint. */
  private selectedProfileId: LocalProfileId | undefined;

  constructor(private readonly storage: StoragePort) {}

  current(): LocalProfileId {
    if (!this.state || !this.selectedProfileId) {
      throw new Error('Local profiles have not been initialized');
    }
    return this.selectedProfileId;
  }

  /** Compatibility seam for isolated store tests and pre-initialization reads. */
  currentIfInitialized(): LocalProfileId | undefined {
    return this.selectedProfileId;
  }

  snapshot(): LocalProfileState {
    if (!this.state) throw new Error('Local profiles have not been initialized');
    return {
      ...this.state,
      activeProfileId: this.current(),
      routes: this.state.routes.map((route) => ({ ...route })),
      ...(this.state.recoveryProfileIds
        ? { recoveryProfileIds: [...this.state.recoveryProfileIds] }
        : {}),
    };
  }

  resolve(profileId: LocalProfileId): LocalProfileId {
    if (!this.state) throw new Error('Local profiles have not been initialized');
    return resolveLocalProfileId(this.state, profileId);
  }

  readableProfiles(profileId = this.current()): LocalProfileId[] {
    if (!this.state) throw new Error('Local profiles have not been initialized');
    return [
      profileId,
      ...this.state.routes
        .filter((route) => route.destinationProfileId === profileId)
        .map((route) => route.sourceProfileId),
    ];
  }

  async refresh(): Promise<LocalProfileState> {
    let state = parseLocalProfileState(
      await this.storage.get<unknown>(STORAGE.app, LOCAL_PROFILE_STATE_KEY),
    );
    if (!state) throw new Error('Local profile state is missing');
    state = await this.absorbLateLegacyWrites(state);
    const selected = this.selectedProfileId;
    this.state = state;
    this.selectedProfileId = selected && state.routes.some(
      (route) => route.sourceProfileId === selected,
    )
      ? state.guestProfileId
      : selected ?? state.activeProfileId;
    return this.snapshot();
  }

  /**
   * A 2.1 renderer may keep writing the old global keys after a 2.2 tab has
   * established profile isolation. Their account ownership is unknowable, so
   * preserve each late document under an unreachable recovery profile rather
   * than merging it into whichever account happens to be active now.
   */
  private async absorbLateLegacyWrites(
    expectedState: LocalProfileState,
  ): Promise<LocalProfileState> {
    const legacyArchive = await this.storage.get<unknown>(STORAGE.archive, 'current');
    const legacyHistory = await this.storage.get<unknown>(STORAGE.history, 'log');
    if (legacyArchive === undefined && legacyHistory === undefined) return expectedState;
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic storage is required to preserve late legacy progress safely');
    }
    const newRecoveryProfileId = guestLocalProfileId();
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const expectedRecoveryProfileId = expectedState.legacyQuarantineProfileId
        ?? newRecoveryProfileId;
      const recovery = profileAddresses(expectedRecoveryProfileId);
      const addresses = [
        STATE_ADDRESS,
        LEGACY_ARCHIVE_ADDRESS,
        LEGACY_HISTORY_ADDRESS,
        recovery.archive,
        recovery.history,
      ];
      const snapshots = await this.storage.readBatch(addresses);
      if (snapshots.length !== addresses.length) {
        throw new Error('Late legacy progress read returned an incomplete snapshot');
      }
      const durable = parseLocalProfileState(snapshots[0]?.value);
      if (!durable) throw new Error('Local profile state disappeared');
      const recoveryProfileId = durable.legacyQuarantineProfileId ?? newRecoveryProfileId;
      if (recoveryProfileId !== expectedRecoveryProfileId) {
        expectedState = durable;
        continue;
      }
      const sourceArchive = snapshots[1]?.value;
      const sourceHistory = snapshots[2]?.value;
      if (sourceArchive === undefined && sourceHistory === undefined) return durable;
      const isNewRecovery = durable.legacyQuarantineProfileId === undefined;
      if (
        isNewRecovery
        && (durable.recoveryProfileIds?.length ?? 0) >= MAX_RECOVERY_PROFILES
      ) {
        throw new Error('Too many preserved legacy profiles; recovery is required before continuing');
      }
      const compactedArchive = sourceArchive === undefined
        ? snapshots[3]?.value
        : compactLegacyArchive(snapshots[3]?.value, sourceArchive);
      const compactedHistory = sourceHistory === undefined
        ? snapshots[4]?.value
        : compactLegacyHistory(snapshots[4]?.value, sourceHistory);
      const next: LocalProfileState = {
        ...durable,
        recoveryProfileIds: isNewRecovery
          ? [...(durable.recoveryProfileIds ?? []), recoveryProfileId]
          : [...(durable.recoveryProfileIds ?? [])],
        legacyQuarantineProfileId: recoveryProfileId,
      };
      const mutations: Array<
        StorageAddress & ({ operation: 'set'; value: unknown } | { operation: 'delete' })
      > = [{ ...STATE_ADDRESS, operation: 'set', value: next }];
      if (sourceArchive !== undefined) {
        mutations.push({ ...recovery.archive, operation: 'set', value: compactedArchive });
        mutations.push({ ...LEGACY_ARCHIVE_ADDRESS, operation: 'delete' });
      }
      if (sourceHistory !== undefined) {
        mutations.push({ ...recovery.history, operation: 'set', value: compactedHistory });
        mutations.push({ ...LEGACY_HISTORY_ADDRESS, operation: 'delete' });
      }
      const committed = await this.storage.commitBatch({
        ifRevisions: snapshots.map(({ collection, key, revision }) => ({ collection, key, revision })),
        mutations,
      });
      if (committed.committed) return next;
    }
    throw new Error('Late legacy progress kept changing during preservation');
  }

  async initialize(storedUserId?: string): Promise<LocalProfileState> {
    const desiredUser = storedUserId ? userLocalProfileId(storedUserId) : undefined;
    const existing = parseLocalProfileState(
      await this.storage.get<unknown>(STORAGE.app, LOCAL_PROFILE_STATE_KEY),
    );
    if (existing) {
      this.state = await this.absorbLateLegacyWrites(existing);
      const desired = desiredUser ?? this.state.guestProfileId;
      this.selectedProfileId = desired;
      if (this.state.activeProfileId !== desired) await this.activate(desired);
      return this.snapshot();
    }

    const guestProfileId = guestLocalProfileId();
    const recoveryProfileId = guestLocalProfileId();
    const destination = desiredUser ?? guestProfileId;
    const legacyArchive = await this.storage.get<unknown>(STORAGE.archive, 'current');
    const legacyHistory = await this.storage.get<unknown>(STORAGE.history, 'log');
    if (!hasAtomicStorage(this.storage)) {
      if (legacyArchive !== undefined || legacyHistory !== undefined) {
        throw new Error('Atomic storage is required to migrate local progress safely');
      }
      const initial: LocalProfileState = {
        version: 1,
        activeProfileId: destination,
        guestProfileId,
        routes: [],
      };
      await this.storage.set(STORAGE.app, LOCAL_PROFILE_STATE_KEY, initial);
      this.state = initial;
      this.selectedProfileId = destination;
      return this.snapshot();
    }

    const destinationAddresses = profileAddresses(destination);
    const recoveryAddresses = profileAddresses(recoveryProfileId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const addresses = [
        STATE_ADDRESS,
        LEGACY_ARCHIVE_ADDRESS,
        LEGACY_HISTORY_ADDRESS,
        destinationAddresses.archive,
        destinationAddresses.history,
        recoveryAddresses.archive,
        recoveryAddresses.history,
        GUEST_CLAIM_ADDRESS,
      ];
      const snapshots = await this.storage.readBatch(addresses);
      if (snapshots.length !== addresses.length) {
        throw new Error('Local profile migration returned an incomplete snapshot');
      }
      const concurrent = parseLocalProfileState(snapshots[0]?.value);
      if (concurrent) {
        this.state = await this.absorbLateLegacyWrites(concurrent);
        const desired = desiredUser ?? this.state.guestProfileId;
        this.selectedProfileId = desired;
        if (this.state.activeProfileId !== desired) await this.activate(desired);
        return this.snapshot();
      }
      const sourceArchive = snapshots[1]?.value;
      const sourceHistory = snapshots[2]?.value;
      const claimState = parseGuestClaimStateValue(snapshots[7]?.value);
      const quarantine = !!claimState?.pending
        && claimState.pending.destinationUserId !== storedUserId
        && (sourceArchive !== undefined || sourceHistory !== undefined);
      const targetAddresses = quarantine ? recoveryAddresses : destinationAddresses;
      const targetArchive = quarantine ? snapshots[5] : snapshots[3];
      const targetHistory = quarantine ? snapshots[6] : snapshots[4];
      if (sourceArchive !== undefined && targetArchive?.exists) {
        throw new Error('Local archive migration destination is not empty');
      }
      if (sourceHistory !== undefined && targetHistory?.exists) {
        throw new Error('Local history migration destination is not empty');
      }
      const initial: LocalProfileState = {
        version: 1,
        activeProfileId: destination,
        guestProfileId,
        routes: [],
        ...(quarantine
          ? {
              recoveryProfileIds: [recoveryProfileId],
              legacyQuarantineProfileId: recoveryProfileId,
            }
          : {}),
      };
      const mutations: Array<
        StorageAddress & ({ operation: 'set'; value: unknown } | { operation: 'delete' })
      > = [{ ...STATE_ADDRESS, operation: 'set', value: initial }];
      if (sourceArchive !== undefined) {
        mutations.push({ ...targetAddresses.archive, operation: 'set', value: sourceArchive });
        mutations.push({ ...LEGACY_ARCHIVE_ADDRESS, operation: 'delete' });
      }
      if (sourceHistory !== undefined) {
        mutations.push({ ...targetAddresses.history, operation: 'set', value: sourceHistory });
        mutations.push({ ...LEGACY_HISTORY_ADDRESS, operation: 'delete' });
      }
      const committed = await this.storage.commitBatch({
        ifRevisions: snapshots.map(({ collection, key, revision }) => ({ collection, key, revision })),
        mutations,
      });
      if (committed.committed) {
        this.state = initial;
        this.selectedProfileId = destination;
        return this.snapshot();
      }
    }
    throw new Error('Local profile migration changed too often');
  }

  activateUser(userId: string): Promise<LocalProfileState> {
    return this.activate(userLocalProfileId(userId));
  }

  async activateGuest(): Promise<LocalProfileState> {
    if (!this.state) throw new Error('Local profiles have not been initialized');
    await this.refresh();
    return this.activate(this.state!.guestProfileId);
  }

  /**
   * Abandon an uncertain invite registration without giving its guest data to
   * the next account. The exact guest profile remains in the recovery list,
   * while the exact attempt generation is durably routed to export-only
   * quarantine. A fresh empty guest identity becomes active immediately.
   */
  async quarantineGuest(
    expectedGuestProfileId: LocalProfileId,
    expectedGuestGeneration: string,
  ): Promise<LocalProfileState> {
    if (!this.state) throw new Error('Local profiles have not been initialized');
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic storage is required to quarantine guest progress safely');
    }
    if (
      !isLocalProfileId(expectedGuestProfileId)
      || !expectedGuestProfileId.startsWith('guest:')
      || expectedGuestGeneration.length === 0
      || expectedGuestGeneration.length > 256
      || expectedGuestGeneration.includes('\0')
    ) throw new TypeError('Invalid guest registration ownership');

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshots = await this.storage.readBatch([STATE_ADDRESS, GUEST_CLAIM_ADDRESS]);
      if (snapshots.length !== 2) {
        throw new Error('Guest quarantine returned an incomplete snapshot');
      }
      const durable = parseLocalProfileState(snapshots[0]?.value);
      const claims = parseGuestClaimStateValue(snapshots[1]?.value);
      if (!durable || !claims) throw new Error('Guest ownership state disappeared');
      const alreadyQuarantined = durable.recoveryProfileIds?.includes(expectedGuestProfileId)
        && claims.routes.some((route) =>
          route.sourceGeneration === expectedGuestGeneration
          && route.destinationUserId === AMBIGUOUS_GUEST_ATTEMPT_OWNER);
      if (alreadyQuarantined) {
        this.state = durable;
        this.selectedProfileId = durable.guestProfileId;
        return this.snapshot();
      }
      if (
        durable.guestProfileId !== expectedGuestProfileId
        || claims.currentGeneration !== expectedGuestGeneration
        || claims.pending
      ) {
        throw new Error('Guest registration ownership changed before it could be quarantined');
      }
      if ((durable.recoveryProfileIds?.length ?? 0) >= MAX_RECOVERY_PROFILES) {
        throw new Error('Too many preserved guest profiles; recovery is required before continuing');
      }
      const prepared = prepareGuestClaim(
        snapshots[1]?.value,
        AMBIGUOUS_GUEST_ATTEMPT_OWNER,
      );
      if (prepared.route.sourceGeneration !== expectedGuestGeneration) {
        throw new Error('Guest attempt generation changed before quarantine');
      }
      const nextGuestProfileId = guestLocalProfileId();
      const next: LocalProfileState = {
        ...durable,
        activeProfileId: durable.activeProfileId === expectedGuestProfileId
          ? nextGuestProfileId
          : durable.activeProfileId,
        guestProfileId: nextGuestProfileId,
        recoveryProfileIds: [
          ...(durable.recoveryProfileIds ?? []),
          expectedGuestProfileId,
        ],
      };
      const committed = await this.storage.commitBatch({
        ifRevisions: snapshots.map(({ collection, key, revision }) => ({ collection, key, revision })),
        mutations: [
          { ...STATE_ADDRESS, operation: 'set', value: next },
          { ...GUEST_CLAIM_ADDRESS, operation: 'set', value: prepared.state },
        ],
      });
      if (committed.committed) {
        this.state = next;
        this.selectedProfileId = nextGuestProfileId;
        return this.snapshot();
      }
    }
    throw new Error('Guest registration ownership changed too often to quarantine');
  }

  /** Explicit invite-registration hand-off; ordinary login never calls this. */
  async claimGuestForUser(
    userId: string,
    expectedGuestProfileId?: LocalProfileId,
    expectedGuestGeneration?: string,
  ): Promise<LocalProfileState> {
    if (!this.state) throw new Error('Local profiles have not been initialized');
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic storage is required to claim guest progress safely');
    }
    if (
      expectedGuestProfileId !== undefined
      && (!isLocalProfileId(expectedGuestProfileId) || !expectedGuestProfileId.startsWith('guest:'))
    ) throw new TypeError('Invalid expected guest profile identity');
    if (
      expectedGuestGeneration !== undefined
      && (expectedGuestGeneration.length === 0
        || expectedGuestGeneration.length > 256
        || expectedGuestGeneration.includes('\0'))
    ) throw new TypeError('Invalid expected guest attempt generation');
    const destination = userLocalProfileId(userId);
    const newRecoveryProfileId = guestLocalProfileId();
    const initialSourceProfileId = expectedGuestProfileId ?? this.state.guestProfileId;
    if (
      expectedGuestGeneration === undefined
      && this.state.routes.some((route) =>
        route.sourceProfileId === initialSourceProfileId
        && route.destinationProfileId === destination)
    ) {
      this.selectedProfileId = destination;
      return this.snapshot();
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const currentState = this.state;
      const sourceProfileId = expectedGuestProfileId ?? currentState.guestProfileId;
      const source = profileAddresses(sourceProfileId);
      const target = profileAddresses(destination);
      const expectedRecoveryProfileId = currentState.legacyQuarantineProfileId
        ?? newRecoveryProfileId;
      const recovery = profileAddresses(expectedRecoveryProfileId);
      const addresses = [
        STATE_ADDRESS,
        GUEST_CLAIM_ADDRESS,
        source.archive,
        source.history,
        target.archive,
        target.history,
        LEGACY_ARCHIVE_ADDRESS,
        LEGACY_HISTORY_ADDRESS,
        recovery.archive,
        recovery.history,
      ];
      const snapshots = await this.storage.readBatch(addresses);
      if (snapshots.length !== addresses.length) {
        throw new Error('Guest profile claim returned an incomplete snapshot');
      }
      const durableState = parseLocalProfileState(snapshots[0]?.value);
      if (!durableState) throw new Error('Local profile state disappeared during guest claim');
      const claimState = parseGuestClaimStateValue(snapshots[1]?.value);
      if (
        durableState.routes.some((route) =>
          route.sourceProfileId === sourceProfileId
          && route.destinationProfileId === destination)
      ) {
        if (
          expectedGuestGeneration !== undefined
          && !claimState?.routes.some((route) =>
            route.sourceGeneration === expectedGuestGeneration
            && route.destinationUserId === userId)
        ) throw new Error('Claimed guest attempt generation does not match the registration');
        this.state = durableState;
        this.selectedProfileId = destination;
        return this.snapshot();
      }
      if (
        claimState?.pending?.destinationUserId === userId
        && durableState.routes.some((route) => route.destinationProfileId === destination)
      ) {
        // The profile rotation committed and only the matching attempt move is
        // still pending. Treat this as the same claim, not as permission to
        // rotate and assign the newly-created guest generation as well.
        this.state = durableState;
        this.selectedProfileId = destination;
        return this.snapshot();
      }
      if (
        expectedGuestProfileId !== undefined
        && durableState.guestProfileId !== expectedGuestProfileId
      ) {
        throw new Error('Guest profile changed; inspect recovery data again');
      }
      if (
        expectedGuestGeneration !== undefined
        && claimState?.currentGeneration !== expectedGuestGeneration
      ) {
        throw new Error('Guest attempt generation changed; inspect recovery data again');
      }
      if (durableState.guestProfileId !== currentState.guestProfileId) {
        this.state = durableState;
        continue;
      }
      const recoveryProfileId = durableState.legacyQuarantineProfileId
        ?? newRecoveryProfileId;
      if (recoveryProfileId !== expectedRecoveryProfileId) {
        this.state = durableState;
        continue;
      }
      const attemptClaim = prepareGuestClaim(snapshots[1]?.value, userId);
      const destinationArchive = snapshots[2]?.exists
        ? archiveForEmptyTarget(snapshots[2].value, snapshots[4]?.value)
        : undefined;
      const hasLateLegacy = !!snapshots[6]?.exists || !!snapshots[7]?.exists;
      const isNewRecovery = hasLateLegacy
        && durableState.legacyQuarantineProfileId === undefined;
      if (durableState.routes.length >= MAX_PROFILE_ROUTES) {
        throw new Error('Too many completed guest claims; local profile maintenance is required');
      }
      if (
        isNewRecovery
        && (durableState.recoveryProfileIds?.length ?? 0) >= MAX_RECOVERY_PROFILES
      ) {
        throw new Error('Too many preserved legacy profiles; recovery is required before continuing');
      }
      const next: LocalProfileState = {
        version: 1,
        activeProfileId: destination,
        guestProfileId: guestLocalProfileId(),
        routes: [
          ...durableState.routes.filter(
            (route) => route.sourceProfileId !== durableState.guestProfileId,
          ),
          {
            sourceProfileId: durableState.guestProfileId,
            destinationProfileId: destination,
          },
        ],
        ...(isNewRecovery
          ? {
              recoveryProfileIds: [
                ...(durableState.recoveryProfileIds ?? []),
                recoveryProfileId,
              ],
              legacyQuarantineProfileId: recoveryProfileId,
            }
          : {
              ...(durableState.recoveryProfileIds
                ? { recoveryProfileIds: [...durableState.recoveryProfileIds] }
                : {}),
              ...(durableState.legacyQuarantineProfileId
                ? { legacyQuarantineProfileId: durableState.legacyQuarantineProfileId }
                : {}),
            }),
      };
      const mutations: Array<
        StorageAddress & ({ operation: 'set'; value: unknown } | { operation: 'delete' })
      > = [
        { ...STATE_ADDRESS, operation: 'set', value: next },
        { ...GUEST_CLAIM_ADDRESS, operation: 'set', value: attemptClaim.state },
      ];
      if (snapshots[2]?.exists) {
        mutations.push({ ...target.archive, operation: 'set', value: destinationArchive });
        mutations.push({ ...source.archive, operation: 'delete' });
      }
      // Keep the guest legacy history document at its source profile. The
      // durable route makes it readable by the destination, and avoids a
      // cross-window migration splitting one clientAttemptId across G and U.
      if (snapshots[6]?.exists) {
        mutations.push({
          ...recovery.archive,
          operation: 'set',
          value: compactLegacyArchive(snapshots[8]?.value, snapshots[6].value),
        });
        mutations.push({ ...LEGACY_ARCHIVE_ADDRESS, operation: 'delete' });
      }
      if (snapshots[7]?.exists) {
        mutations.push({
          ...recovery.history,
          operation: 'set',
          value: compactLegacyHistory(snapshots[9]?.value, snapshots[7].value),
        });
        mutations.push({ ...LEGACY_HISTORY_ADDRESS, operation: 'delete' });
      }
      const committed = await this.storage.commitBatch({
        ifRevisions: snapshots.map(({ collection, key, revision }) => ({ collection, key, revision })),
        mutations,
      });
      if (committed.committed) {
        this.state = next;
        this.selectedProfileId = destination;
        return this.snapshot();
      }
    }
    throw new Error('Guest profile claim changed too often');
  }

  private async activate(profileId: LocalProfileId): Promise<LocalProfileState> {
    if (!this.state) throw new Error('Local profiles have not been initialized');
    if (this.selectedProfileId === profileId && this.state.activeProfileId === profileId) {
      return this.snapshot();
    }
    if (!hasAtomicStorage(this.storage)) {
      const next = { ...this.state, activeProfileId: profileId };
      await this.storage.set(STORAGE.app, LOCAL_PROFILE_STATE_KEY, next);
      this.state = next;
      this.selectedProfileId = profileId;
      return this.snapshot();
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await this.storage.readBatch([STATE_ADDRESS]);
      if (!snapshot) throw new Error('Local profile state read returned no entry');
      const durable = parseLocalProfileState(snapshot.value);
      if (!durable) throw new Error('Local profile state disappeared');
      if (resolveLocalProfileId(durable, profileId) !== profileId) {
        throw new Error('A claimed local profile cannot be activated directly');
      }
      const next: LocalProfileState = { ...durable, activeProfileId: profileId };
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ ...STATE_ADDRESS, revision: snapshot.revision }],
        mutations: [{ ...STATE_ADDRESS, operation: 'set', value: next }],
      });
      if (committed.committed) {
        this.state = next;
        this.selectedProfileId = profileId;
        return this.snapshot();
      }
    }
    throw new Error('Local profile state changed too often');
  }
}
