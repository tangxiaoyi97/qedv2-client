import { canonicalServiceBaseUrl } from '../config/index.js';
import { hasAtomicStorage, STORAGE, type StoragePort } from '../ports/index.js';
import {
  LOCAL_PROFILE_STATE_KEY,
  isLocalProfileId,
  parseLocalProfileState,
  type LocalProfileId,
} from './local-profile-store.js';
import {
  GUEST_CLAIM_STORAGE_KEY,
  parseGuestClaimStateValue,
} from './attempt-outbox.js';

export const REGISTRATION_INTENT_STORAGE_KEY = 'registration-intent/v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CAS_ATTEMPTS = 6;

export interface RegistrationIntent {
  version: 1;
  /**
   * `reserved` only proves that the request was durably prepared locally.
   * Guest data may be claimed only after a successful Server response has
   * bound this intent to the returned account id.
   */
  status: 'reserved' | 'redeemed';
  clientMutationId: string;
  serverBaseUrl: string;
  usernameKey: string;
  sourceProfileId: LocalProfileId;
  sourceGuestGeneration: string;
  destinationUserId?: string;
  createdAt: string;
}

export class RegistrationIntentConflictError extends Error {
  constructor(public readonly existing: RegistrationIntent) {
    super('A different invite registration is already awaiting recovery');
    this.name = 'RegistrationIntentConflictError';
  }
}

function createUuidV4(): string {
  const value = globalThis.crypto?.randomUUID?.();
  if (!value || !UUID_V4.test(value)) {
    throw new Error('Secure registration mutation IDs are unavailable');
  }
  return value;
}

function normalizeUsernameKey(username: string): string {
  const value = username.trim().toLowerCase();
  if (value.length === 0 || value.length > 200 || value.includes('\0')) {
    throw new TypeError('Invalid registration username');
  }
  return value;
}

function validateInviteCode(inviteCode: string): void {
  if (inviteCode.length === 0 || inviteCode.length > 512 || inviteCode.includes('\0')) {
    throw new TypeError('Invalid invite code');
  }
}

function parseRegistrationIntent(value: unknown): RegistrationIntent | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Registration recovery intent is malformed');
  }
  const candidate = value as Partial<RegistrationIntent>;
  let serverBaseUrl: string;
  try {
    serverBaseUrl = canonicalServiceBaseUrl(candidate.serverBaseUrl ?? '');
  } catch {
    throw new Error('Registration recovery intent is malformed');
  }
  if (
    candidate.version !== 1
    || (candidate.status !== undefined
      && candidate.status !== 'reserved'
      && candidate.status !== 'redeemed')
    || typeof candidate.clientMutationId !== 'string'
    || !UUID_V4.test(candidate.clientMutationId)
    || candidate.serverBaseUrl !== serverBaseUrl
    || typeof candidate.usernameKey !== 'string'
    || candidate.usernameKey.length === 0
    || candidate.usernameKey.length > 200
    || candidate.usernameKey !== candidate.usernameKey.trim().toLowerCase()
    || candidate.usernameKey.includes('\0')
    || !isLocalProfileId(candidate.sourceProfileId)
    || !candidate.sourceProfileId.startsWith('guest:')
    || typeof candidate.sourceGuestGeneration !== 'string'
    || candidate.sourceGuestGeneration.length === 0
    || candidate.sourceGuestGeneration.length > 256
    || typeof candidate.createdAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.createdAt))
    || (candidate.destinationUserId !== undefined
      && (typeof candidate.destinationUserId !== 'string'
        || candidate.destinationUserId.length === 0
        || candidate.destinationUserId.length > 128
        || candidate.destinationUserId.includes('\0')))
    || ((candidate.status ?? 'reserved') === 'redeemed'
      && candidate.destinationUserId === undefined)
    || ((candidate.status ?? 'reserved') === 'reserved'
      && candidate.destinationUserId !== undefined)
  ) {
    throw new Error('Registration recovery intent is malformed');
  }
  return {
    version: 1,
    // Early local 2.2 previews wrote no phase. Treat those records as an
    // unproven reservation: they are safe to replay, never safe to claim.
    status: candidate.status ?? 'reserved',
    clientMutationId: candidate.clientMutationId!,
    serverBaseUrl,
    usernameKey: candidate.usernameKey!,
    sourceProfileId: candidate.sourceProfileId!,
    sourceGuestGeneration: candidate.sourceGuestGeneration!,
    ...(candidate.destinationUserId
      ? { destinationUserId: candidate.destinationUserId }
      : {}),
    createdAt: candidate.createdAt!,
  };
}

/**
 * Durable preflight for invite redemption. It contains no invite code,
 * password, invite code or token: only the endpoint/account name and exact
 * local guest profile/generation that may be claimed after a proven response.
 */
export class RegistrationJournal {
  constructor(private readonly storage: StoragePort) {}

  async pending(): Promise<RegistrationIntent | undefined> {
    return parseRegistrationIntent(
      await this.storage.get<unknown>(STORAGE.app, REGISTRATION_INTENT_STORAGE_KEY),
    );
  }

  async reserve(input: {
    serverBaseUrl: string;
    username: string;
    inviteCode: string;
    sourceProfileId: LocalProfileId;
    sourceGuestGeneration: string;
  }): Promise<RegistrationIntent> {
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic storage is required for crash-safe invite registration');
    }
    const serverBaseUrl = canonicalServiceBaseUrl(input.serverBaseUrl);
    const usernameKey = normalizeUsernameKey(input.username);
    validateInviteCode(input.inviteCode);
    if (!isLocalProfileId(input.sourceProfileId) || !input.sourceProfileId.startsWith('guest:')) {
      throw new TypeError('Invite registration requires a guest profile');
    }
    if (
      input.sourceGuestGeneration.length === 0
      || input.sourceGuestGeneration.length > 256
      || input.sourceGuestGeneration.includes('\0')
    ) throw new TypeError('Invalid guest attempt generation');

    const address = { collection: STORAGE.app, key: REGISTRATION_INTENT_STORAGE_KEY } as const;
    const profileAddress = { collection: STORAGE.app, key: LOCAL_PROFILE_STATE_KEY } as const;
    const claimAddress = { collection: STORAGE.history, key: GUEST_CLAIM_STORAGE_KEY } as const;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshots = await this.storage.readBatch([address, profileAddress, claimAddress]);
      if (snapshots.length !== 3) throw new Error('Registration reservation read was incomplete');
      const existing = parseRegistrationIntent(snapshots[0]?.value);
      const profiles = parseLocalProfileState(snapshots[1]?.value);
      const claims = parseGuestClaimStateValue(snapshots[2]?.value);
      if (existing) {
        if (
          existing.serverBaseUrl === serverBaseUrl
          && existing.usernameKey === usernameKey
        ) return existing;
        throw new RegistrationIntentConflictError(existing);
      }
      if (
        !profiles
        || profiles.guestProfileId !== input.sourceProfileId
        || profiles.routes.some((route) => route.sourceProfileId === input.sourceProfileId)
        || !claims
        || claims.currentGeneration !== input.sourceGuestGeneration
        || claims.pending
      ) {
        throw new Error('Guest ownership changed before invite registration was reserved');
      }
      const intent: RegistrationIntent = {
        version: 1,
        status: 'reserved',
        clientMutationId: createUuidV4(),
        serverBaseUrl,
        usernameKey,
        sourceProfileId: input.sourceProfileId,
        sourceGuestGeneration: input.sourceGuestGeneration,
        createdAt: new Date().toISOString(),
      };
      const committed = await this.storage.commitBatch({
        ifRevisions: snapshots.map(({ collection, key, revision }) => ({ collection, key, revision })),
        mutations: [{ ...address, operation: 'set', value: intent }],
      });
      if (committed.committed) return intent;
    }
    throw new Error('Guest ownership changed too often to reserve invite registration');
  }

  /** Bind a successful redemption response to its exact durable account. */
  async markRedeemed(clientMutationId: string, destinationUserId: string): Promise<RegistrationIntent> {
    if (!UUID_V4.test(clientMutationId)) throw new TypeError('Invalid registration mutation ID');
    if (
      destinationUserId.length === 0
      || destinationUserId.length > 128
      || destinationUserId.includes('\0')
    ) throw new TypeError('Invalid registration destination');
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic storage is required for crash-safe invite registration');
    }
    const address = { collection: STORAGE.app, key: REGISTRATION_INTENT_STORAGE_KEY } as const;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await this.storage.readBatch([address]);
      if (!snapshot) throw new Error('Registration recovery read was incomplete');
      const current = parseRegistrationIntent(snapshot.value);
      if (!current || current.clientMutationId !== clientMutationId) {
        throw new Error('Registration recovery intent changed before the response was recorded');
      }
      if (current.status === 'redeemed') {
        if (current.destinationUserId !== destinationUserId) {
          throw new Error('Registration response named a different account');
        }
        return current;
      }
      const next: RegistrationIntent = {
        ...current,
        status: 'redeemed',
        destinationUserId,
      };
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ ...address, revision: snapshot.revision }],
        mutations: [{ ...address, operation: 'set', value: next }],
      });
      if (committed.committed) return next;
    }
    throw new Error('Registration response changed too often to record safely');
  }

  async complete(clientMutationId: string): Promise<void> {
    if (!UUID_V4.test(clientMutationId)) throw new TypeError('Invalid registration mutation ID');
    if (!hasAtomicStorage(this.storage)) {
      const current = await this.pending();
      if (current?.clientMutationId === clientMutationId) {
        await this.storage.delete(STORAGE.app, REGISTRATION_INTENT_STORAGE_KEY);
      }
      return;
    }
    const address = { collection: STORAGE.app, key: REGISTRATION_INTENT_STORAGE_KEY } as const;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await this.storage.readBatch([address]);
      if (!snapshot) throw new Error('Registration recovery read was incomplete');
      const current = parseRegistrationIntent(snapshot.value);
      if (!current || current.clientMutationId !== clientMutationId) return;
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ ...address, revision: snapshot.revision }],
        mutations: [{ ...address, operation: 'delete' }],
      });
      if (committed.committed) return;
    }
    throw new Error('Registration recovery intent changed too often to complete');
  }
}
