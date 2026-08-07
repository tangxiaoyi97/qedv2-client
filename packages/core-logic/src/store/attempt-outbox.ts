import type { AttemptRecord } from '../api/types.js';
import { STORAGE, type StoragePort } from '../ports/index.js';

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

interface PendingAttempt {
  userId: string;
  attempt: QueuedAttempt;
}

const OUTBOX_KEY = 'attempt-outbox';
const GUEST_CLAIM_KEY = 'attempt-outbox-guest-claim';

interface GuestClaimRoute {
  sourceGeneration: string;
  destinationUserId: string;
}

type PendingGuestClaim = GuestClaimRoute;

interface GuestClaimState {
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

function isGuestClaimState(value: unknown): value is GuestClaimState {
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
      || (typeof candidate.pending.sourceGeneration === 'string'
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

/**
 * Durable per-account audit outbox. A response can be lost after the server
 * commits, so the stable clientAttemptId is retained until an acknowledged
 * retry; the server's unique key makes that retry harmless.
 */
export class AttemptOutbox {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: StoragePort) {}

  private async read(): Promise<PendingAttempt[]> {
    return (await this.storage.get<PendingAttempt[]>(STORAGE.history, OUTBOX_KEY)) ?? [];
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private mutate(change: (entries: PendingAttempt[]) => void): Promise<void> {
    return this.serialize(async () => {
      const entries = await this.read();
      change(entries);
      await this.storage.set(STORAGE.history, OUTBOX_KEY, entries);
    });
  }

  private async readGuestClaimState(): Promise<GuestClaimState | undefined> {
    const value = await this.storage.get<unknown>(STORAGE.history, GUEST_CLAIM_KEY);
    if (isGuestClaimState(value)) return value;

    // Preview builds briefly stored only `{ destinationUserId }`. Preserve
    // that crash-recovery intent instead of silently treating it as garbage.
    const legacyDestination = value && typeof value === 'object'
      ? (value as Partial<PendingGuestClaim>).destinationUserId
      : undefined;
    if (
      typeof legacyDestination === 'string'
    ) {
      const sourceGeneration = createGuestGeneration();
      const route: GuestClaimRoute = {
        sourceGeneration,
        destinationUserId: legacyDestination,
      };
      const migrated: GuestClaimState = {
        version: 1,
        currentGeneration: createGuestGeneration(),
        routes: [route],
        pending: route,
      };
      await this.storage.set(STORAGE.history, GUEST_CLAIM_KEY, migrated);
      return migrated;
    }
    return undefined;
  }

  /** Capture the generation of a newly-created guest practice session. */
  captureGuestOwner(): Promise<AttemptOwnerSnapshot> {
    return this.serialize(async () => {
      let state = await this.readGuestClaimState();
      if (!state) {
        state = {
          version: 1,
          currentGeneration: createGuestGeneration(),
          routes: [],
        };
        await this.storage.set(STORAGE.history, GUEST_CLAIM_KEY, state);
      }
      return {
        userId: GUEST_ATTEMPT_OWNER,
        guestGeneration: state.currentGeneration,
      };
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
      let userId = captured.userId;
      if (userId === GUEST_ATTEMPT_OWNER && captured.guestGeneration) {
        const state = await this.readGuestClaimState();
        const route = state?.routes.find(
          (candidate) => candidate.sourceGeneration === captured.guestGeneration,
        );
        if (route) userId = route.destinationUserId;
      }

      const entries = await this.read();
      if (
        entries.some(
          (entry) =>
            entry.userId === userId &&
            entry.attempt.clientAttemptId === attempt.clientAttemptId,
        )
      ) {
        return userId;
      }
      entries.push({ userId, attempt });

      const mine = entries.reduce((n, entry) => (entry.userId === userId ? n + 1 : n), 0);
      let toDrop = mine - MAX_PENDING_PER_USER;
      for (let i = 0; i < entries.length && toDrop > 0; ) {
        if (entries[i]?.userId === userId) {
          entries.splice(i, 1);
          toDrop -= 1;
        } else {
          i += 1;
        }
      }
      await this.storage.set(STORAGE.history, OUTBOX_KEY, entries);
      return userId;
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
      const existing = await this.readGuestClaimState();
      const state: GuestClaimState = existing ?? {
        version: 1,
        currentGeneration: createGuestGeneration(),
        routes: [],
      };
      if (state.pending && state.pending.destinationUserId !== destinationUserId) {
        throw new Error('Guest attempts are already pending for another account.');
      }

      // Re-entering the same interrupted claim is idempotent; rotating twice
      // would incorrectly reserve a fresh guest generation for this account.
      if (state.pending) return;

      const sourceGeneration = state.currentGeneration;
      const route: GuestClaimRoute = {
        sourceGeneration,
        destinationUserId,
      };
      state.currentGeneration = createGuestGeneration();
      state.routes = [
        ...state.routes.filter((entry) => entry.sourceGeneration !== sourceGeneration),
        route,
      ];
      state.pending = route;
      await this.storage.set(STORAGE.history, GUEST_CLAIM_KEY, state);
    });
  }

  async pendingGuestClaim(): Promise<string | undefined> {
    await this.mutationTail;
    return (await this.readGuestClaimState())?.pending?.destinationUserId;
  }

  /** Clear only the pending intent; the old-generation route stays durable. */
  async finishGuestClaim(destinationUserId: string): Promise<void> {
    await this.serialize(async () => {
      const state = await this.readGuestClaimState();
      if (state?.pending?.destinationUserId !== destinationUserId) return;
      delete state.pending;
      await this.storage.set(STORAGE.history, GUEST_CLAIM_KEY, state);
    });
  }

  /**
   * Atomically move one owner's pending attempts to another owner. Stable
   * clientAttemptId values make the move idempotent and let us discard a
   * source duplicate when the destination already contains it.
   */
  async claim(sourceUserId: string, destinationUserId: string): Promise<number> {
    if (sourceUserId === destinationUserId) return 0;
    let claimed = 0;
    await this.mutate((entries) => {
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
    });
    return claimed;
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
