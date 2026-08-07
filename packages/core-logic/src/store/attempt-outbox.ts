import type { AttemptRecord } from '../api/types.js';
import { hasAtomicStorage, STORAGE, type StoragePort } from '../ports/index.js';

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
}

/**
 * Attempts made before account creation stay durable under a local-only
 * owner. They are claimed only by the explicit registration flow; a normal
 * login on a shared device must never import somebody else's guest history.
 */
export const GUEST_ATTEMPT_OWNER = '__qed2_guest__';

export interface PendingAttempt {
  userId: string;
  attempt: QueuedAttempt;
}

export const ATTEMPT_OUTBOX_STORAGE_KEY = 'attempt-outbox';
export const GUEST_CLAIM_STORAGE_KEY = 'attempt-outbox-guest-claim';

export interface GuestClaimRoute {
  sourceGeneration: string;
  destinationUserId: string;
}

type PendingGuestClaim = GuestClaimRoute;

export interface GuestClaimState {
  version: 1;
  currentGeneration: string;
  routes: GuestClaimRoute[];
  pending?: PendingGuestClaim;
}

function createGuestGeneration(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function cloneGuestClaimState(state: GuestClaimState): GuestClaimState {
  return {
    version: 1,
    currentGeneration: state.currentGeneration,
    routes: state.routes.map((route) => ({ ...route })),
    ...(state.pending ? { pending: { ...state.pending } } : {}),
  };
}

function parseGuestClaimValue(value: unknown): {
  state?: GuestClaimState;
  migrated: boolean;
} {
  if (value === undefined) return { migrated: false };
  if (isGuestClaimState(value)) {
    return { state: cloneGuestClaimState(value), migrated: false };
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
      },
    };
  }
  throw new Error('Guest attempt ownership state is malformed');
}

export function isGuestClaimState(value: unknown): value is GuestClaimState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GuestClaimState>;
  return candidate.version === 1
    && typeof candidate.currentGeneration === 'string'
    && Array.isArray(candidate.routes)
    && candidate.routes.every((route) =>
      route
      && typeof route.sourceGeneration === 'string'
      && typeof route.destinationUserId === 'string')
    && (candidate.pending === undefined
      || (candidate.pending !== null
        && typeof candidate.pending === 'object'
        && typeof candidate.pending.sourceGeneration === 'string'
        && typeof candidate.pending.destinationUserId === 'string'));
}
/**
 * Upper bound PER ACCOUNT. The whole outbox is one IndexedDB document that is
 * read and rewritten on every answer, so an unbounded queue turns each answer
 * into O(n) work — and it only ever grows when the server keeps rejecting a
 * payload, exactly when the device can least afford it. The oldest entries go
 * first; the archive checksum, not this audit trail, is the authoritative
 * progress record.
 *
 * Trimming is scoped to the account being appended to: on a shared device one
 * user's backlog must not evict another user's never-uploaded attempts.
 */
const MAX_PENDING_PER_USER = 2000;
const MAX_OUTBOX_CAS_ATTEMPTS = 6;
const OUTBOX_ADDRESS = {
  collection: STORAGE.history,
  key: ATTEMPT_OUTBOX_STORAGE_KEY,
} as const;
const GUEST_CLAIM_ADDRESS = {
  collection: STORAGE.history,
  key: GUEST_CLAIM_STORAGE_KEY,
} as const;

export function preparePendingAttempts(value: unknown): PendingAttempt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Local attempt outbox is malformed');
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Local attempt outbox contains an invalid row');
    }
    const entry = raw as Partial<PendingAttempt>;
    if (
      typeof entry.userId !== 'string'
      || !entry.attempt
      || typeof entry.attempt !== 'object'
      || typeof entry.attempt.clientAttemptId !== 'string'
    ) {
      throw new Error('Local attempt outbox contains an invalid row');
    }
    return { userId: entry.userId, attempt: { ...entry.attempt } };
  });
}

/** Pure, idempotent enqueue used by the atomic local grade commit. */
export function prepareAttemptEnqueue(
  value: unknown,
  owner: AttemptOwnerSnapshot,
  guestClaimValue: unknown,
  attempt: QueuedAttempt,
): { entries: PendingAttempt[]; ownerId: string } {
  let ownerId = owner.userId;
  if (ownerId === GUEST_ATTEMPT_OWNER && owner.guestGeneration) {
    if (guestClaimValue !== undefined && !isGuestClaimState(guestClaimValue)) {
      throw new Error('Guest attempt ownership state is malformed');
    }
    const route = guestClaimValue?.routes.find(
      (candidate) => candidate.sourceGeneration === owner.guestGeneration,
    );
    if (route) ownerId = route.destinationUserId;
  }
  const entries = preparePendingAttempts(value);
  if (entries.some(
    (entry) => entry.userId === ownerId
      && entry.attempt.clientAttemptId === attempt.clientAttemptId,
  )) {
    return { entries, ownerId };
  }
  entries.push({ userId: ownerId, attempt: { ...attempt } });
  let toDrop = entries.reduce(
    (count, entry) => count + Number(entry.userId === ownerId),
    0,
  ) - MAX_PENDING_PER_USER;
  for (let index = 0; index < entries.length && toDrop > 0;) {
    if (entries[index]?.userId === ownerId) {
      entries.splice(index, 1);
      toDrop -= 1;
    } else {
      index += 1;
    }
  }
  return { entries, ownerId };
}

/**
 * Durable per-account audit outbox. A response can be lost after the server
 * commits, so the stable clientAttemptId is retained until an acknowledged
 * retry; the server's unique key makes that retry harmless.
 */
export class AttemptOutbox {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: StoragePort) {}

  private async read(): Promise<PendingAttempt[]> {
    return preparePendingAttempts(
      await this.storage.get<PendingAttempt[]>(STORAGE.history, ATTEMPT_OUTBOX_STORAGE_KEY),
    );
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private mutate<Result>(change: (entries: PendingAttempt[]) => Result): Promise<Result> {
    return this.serialize(async () => {
      if (!hasAtomicStorage(this.storage)) {
        const entries = await this.read();
        const result = change(entries);
        await this.storage.set(STORAGE.history, ATTEMPT_OUTBOX_STORAGE_KEY, entries);
        return result;
      }
      for (let attempt = 0; attempt < MAX_OUTBOX_CAS_ATTEMPTS; attempt += 1) {
        const [snapshot] = await this.storage.readBatch([OUTBOX_ADDRESS]);
        if (!snapshot) throw new Error('Attempt outbox revision read returned no entry');
        const entries = preparePendingAttempts(snapshot.value);
        const result = change(entries);
        const committed = await this.storage.commitBatch({
          ifRevisions: [{ ...OUTBOX_ADDRESS, revision: snapshot.revision }],
          mutations: [{ ...OUTBOX_ADDRESS, operation: 'set', value: entries }],
        });
        if (committed.committed) return result;
      }
      throw new Error('Attempt outbox changed too often to commit safely');
    });
  }

  private async readGuestClaimState(): Promise<GuestClaimState | undefined> {
    const value = await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY);
    const parsed = parseGuestClaimValue(value);
    if (parsed.migrated && parsed.state) {
      await this.storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, parsed.state);
    }
    return parsed.state;
  }

  /** Capture the generation of a newly-created guest practice session. */
  captureGuestOwner(): Promise<AttemptOwnerSnapshot> {
    return this.serialize(async () => {
      if (!hasAtomicStorage(this.storage)) {
        let state = await this.readGuestClaimState();
        if (!state) {
          state = {
            version: 1,
            currentGeneration: createGuestGeneration(),
            routes: [],
          };
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
        const state = parsed.state ?? {
          version: 1 as const,
          currentGeneration: createGuestGeneration(),
          routes: [],
        };
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
  enqueue(owner: string | AttemptOwnerSnapshot, attempt: QueuedAttempt): Promise<string> {
    const captured = typeof owner === 'string' ? { userId: owner } : owner;
    return this.serialize(async () => {
      if (!hasAtomicStorage(this.storage)) {
        const prepared = prepareAttemptEnqueue(
          await this.read(),
          captured,
          await this.readGuestClaimState(),
          attempt,
        );
        await this.storage.set(STORAGE.history, ATTEMPT_OUTBOX_STORAGE_KEY, prepared.entries);
        return prepared.ownerId;
      }
      for (let casAttempt = 0; casAttempt < MAX_OUTBOX_CAS_ATTEMPTS; casAttempt += 1) {
        const [outboxSnapshot, claimSnapshot] = await this.storage.readBatch([
          OUTBOX_ADDRESS,
          GUEST_CLAIM_ADDRESS,
        ]);
        if (!outboxSnapshot || !claimSnapshot) {
          throw new Error('Attempt ownership revision read returned an incomplete snapshot');
        }
        const parsedClaim = parseGuestClaimValue(claimSnapshot.value);
        const prepared = prepareAttemptEnqueue(
          outboxSnapshot.value,
          captured,
          parsedClaim.state,
          attempt,
        );
        const mutations: Array<
          { collection: string; key: string; operation: 'set'; value: unknown }
        > = [{ ...OUTBOX_ADDRESS, operation: 'set', value: prepared.entries }];
        if (parsedClaim.migrated && parsedClaim.state) {
          mutations.push({ ...GUEST_CLAIM_ADDRESS, operation: 'set', value: parsedClaim.state });
        }
        const committed = await this.storage.commitBatch({
          ifRevisions: [
            { ...OUTBOX_ADDRESS, revision: outboxSnapshot.revision },
            { ...GUEST_CLAIM_ADDRESS, revision: claimSnapshot.revision },
          ],
          mutations,
        });
        if (committed.committed) return prepared.ownerId;
      }
      throw new Error('Attempt ownership changed too often to commit safely');
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
      if (!hasAtomicStorage(this.storage)) {
        const existing = await this.readGuestClaimState();
        const state: GuestClaimState = existing ?? {
          version: 1,
          currentGeneration: createGuestGeneration(),
          routes: [],
        };
        if (state.pending && state.pending.destinationUserId !== destinationUserId) {
          throw new Error('Gastversuche sind bereits für ein anderes Konto vorgemerkt.');
        }
        if (state.pending) return;
        const sourceGeneration = state.currentGeneration;
        const route: GuestClaimRoute = { sourceGeneration, destinationUserId };
        state.currentGeneration = createGuestGeneration();
        state.routes = [
          ...state.routes.filter((entry) => entry.sourceGeneration !== sourceGeneration),
          route,
        ];
        state.pending = route;
        await this.storage.set(STORAGE.history, GUEST_CLAIM_STORAGE_KEY, state);
        return;
      }
      for (let attempt = 0; attempt < MAX_OUTBOX_CAS_ATTEMPTS; attempt += 1) {
        const [snapshot] = await this.storage.readBatch([GUEST_CLAIM_ADDRESS]);
        if (!snapshot) throw new Error('Guest ownership revision read returned no entry');
        const parsed = parseGuestClaimValue(snapshot.value);
        const state: GuestClaimState = parsed.state ?? {
          version: 1,
          currentGeneration: createGuestGeneration(),
          routes: [],
        };
        if (state.pending && state.pending.destinationUserId !== destinationUserId) {
          throw new Error('Gastversuche sind bereits für ein anderes Konto vorgemerkt.');
        }
        if (state.pending && !parsed.migrated) return;
        if (!state.pending) {
          const sourceGeneration = state.currentGeneration;
          const route: GuestClaimRoute = { sourceGeneration, destinationUserId };
          state.currentGeneration = createGuestGeneration();
          state.routes = [
            ...state.routes.filter((entry) => entry.sourceGeneration !== sourceGeneration),
            route,
          ];
          state.pending = route;
        }
        const committed = await this.storage.commitBatch({
          ifRevisions: [{ ...GUEST_CLAIM_ADDRESS, revision: snapshot.revision }],
          mutations: [{ ...GUEST_CLAIM_ADDRESS, operation: 'set', value: state }],
        });
        if (committed.committed) return;
      }
      throw new Error('Guest claim changed too often to begin safely');
    });
  }

  async pendingGuestClaim(): Promise<string | undefined> {
    await this.mutationTail;
    const raw = await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_STORAGE_KEY);
    return parseGuestClaimValue(raw).state?.pending?.destinationUserId;
  }

  /** Clear only the pending intent; the old-generation route stays durable. */
  async finishGuestClaim(destinationUserId: string): Promise<void> {
    await this.serialize(async () => {
      if (!hasAtomicStorage(this.storage)) {
        const state = await this.readGuestClaimState();
        if (state?.pending?.destinationUserId !== destinationUserId) return;
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
  async claim(sourceUserId: string, destinationUserId: string): Promise<number> {
    if (sourceUserId === destinationUserId) return 0;
    return this.mutate((entries) => {
      let claimed = 0;
      const destinationIds = new Set(
        entries
          .filter((entry) => entry.userId === destinationUserId)
          .map((entry) => entry.attempt.clientAttemptId),
      );

      for (let index = 0; index < entries.length; ) {
        const entry = entries[index];
        if (!entry || entry.userId !== sourceUserId) {
          index += 1;
          continue;
        }
        const id = entry.attempt.clientAttemptId;
        if (destinationIds.has(id)) {
          entries.splice(index, 1);
          continue;
        }
        entry.userId = destinationUserId;
        destinationIds.add(id);
        claimed += 1;
        index += 1;
      }

      let destinationCount = entries.reduce(
        (count, entry) => count + Number(entry.userId === destinationUserId),
        0,
      );
      for (let index = 0; index < entries.length && destinationCount > MAX_PENDING_PER_USER; ) {
        if (entries[index]?.userId === destinationUserId) {
          entries.splice(index, 1);
          destinationCount -= 1;
        } else {
          index += 1;
        }
      }
      return claimed;
    });
  }

  async list(userId: string, limit = 1000): Promise<QueuedAttempt[]> {
    await this.mutationTail;
    return (await this.read())
      .filter((entry) => entry.userId === userId)
      .slice(0, limit)
      .map((entry) => entry.attempt);
  }

  remove(userId: string, clientAttemptIds: string[]): Promise<void> {
    const ids = new Set(clientAttemptIds);
    return this.mutate((entries) => {
      const kept = entries.filter(
        (entry) =>
          entry.userId !== userId || !ids.has(entry.attempt.clientAttemptId),
      );
      entries.splice(0, entries.length, ...kept);
    });
  }

  async count(userId: string): Promise<number> {
    await this.mutationTail;
    return (await this.read()).filter((entry) => entry.userId === userId).length;
  }
}
