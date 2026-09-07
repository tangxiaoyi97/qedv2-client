/** Durable escape hatch for a paid request whose successful body was lost. */
import { STORAGE, hasAtomicStorage, type StoragePort } from '../ports/index.js';
import { secureRandomUuidV4 } from '../ai/cache-key.js';

const PREFIX = 'paid-request-generation/v1/';
const MAX_CAS_ATTEMPTS = 24;

export interface AiPaidRequestIdentity {
  version: 2;
  generation: number;
  clientRequestId: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function storageKey(fingerprint: string): string {
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) throw new TypeError('Invalid paid-request fingerprint');
  return `${PREFIX}${fingerprint}`;
}

function parse(value: unknown): AiPaidRequestIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Paid-request identity is malformed');
  }
  const row = value as Partial<AiPaidRequestIdentity> & Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !['version', 'generation', 'clientRequestId'].includes(key))
    || row.version !== 2
    || !Number.isSafeInteger(row.generation)
    || (row.generation as number) < 0
    || typeof row.clientRequestId !== 'string'
    || !UUID_V4.test(row.clientRequestId)
  ) throw new Error('Paid-request identity is malformed');
  return {
    version: 2,
    generation: row.generation as number,
    clientRequestId: row.clientRequestId,
  };
}

function candidate(generation: number): AiPaidRequestIdentity {
  return { version: 2, generation, clientRequestId: secureRandomUuidV4() };
}

export class AiRequestGenerationJournal {
  constructor(private readonly storage: StoragePort) {}

  async current(fingerprint: string): Promise<AiPaidRequestIdentity> {
    const key = storageKey(fingerprint);
    const address = { collection: STORAGE.aiCache, key } as const;
    const initial = candidate(0);
    const nonAtomic = async (): Promise<AiPaidRequestIdentity> => {
      const stored = await this.storage.get<unknown>(STORAGE.aiCache, key);
      if (stored !== undefined) return parse(stored);
      await this.storage.set(STORAGE.aiCache, key, initial);
      return initial;
    };
    if (!hasAtomicStorage(this.storage)) {
      return this.storage.runExclusiveMutation
        ? this.storage.runExclusiveMutation(nonAtomic)
        : nonAtomic();
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [row] = await this.storage.readBatch([address]);
      if (!row) throw new Error('Paid-request identity read returned no entry');
      if (row.exists) return parse(row.value);
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ ...address, revision: row.revision }],
        mutations: [{ ...address, operation: 'set', value: initial }],
      });
      if (committed.committed) return initial;
    }
    throw new Error('Paid-request identity changed too often');
  }

  /**
   * Advances exactly the generation the caller observed. Two windows that
   * both saw generation N converge on N+1 instead of buying N+1 and N+2.
   * A genuinely later retry must first observe N+1 and explicitly advance
   * that generation.
   */
  async advance(fingerprint: string, expectedGeneration: number): Promise<AiPaidRequestIdentity> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new TypeError('Invalid expected paid-request generation');
    }
    if (expectedGeneration >= Number.MAX_SAFE_INTEGER) throw new Error('Paid-request generation exhausted');
    const key = storageKey(fingerprint);
    const address = { collection: STORAGE.aiCache, key } as const;
    const next = candidate(expectedGeneration + 1);
    const nonAtomic = async (): Promise<AiPaidRequestIdentity> => {
      const stored = await this.storage.get<unknown>(STORAGE.aiCache, key);
      if (stored === undefined) {
        if (expectedGeneration !== 0) throw new Error('Paid-request generation is stale');
        await this.storage.set(STORAGE.aiCache, key, next);
        return next;
      }
      const current = parse(stored);
      if (current.generation === expectedGeneration + 1) return current;
      if (current.generation !== expectedGeneration) {
        throw new Error('Paid-request generation is stale');
      }
      await this.storage.set(STORAGE.aiCache, key, next);
      return next;
    };
    if (!hasAtomicStorage(this.storage)) {
      return this.storage.runExclusiveMutation
        ? this.storage.runExclusiveMutation(nonAtomic)
        : nonAtomic();
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [row] = await this.storage.readBatch([address]);
      if (!row) throw new Error('Paid-request generation read returned no entry');
      if (!row.exists) {
        if (expectedGeneration !== 0) throw new Error('Paid-request generation is stale');
        const committed = await this.storage.commitBatch({
          ifRevisions: [{ ...address, revision: row.revision }],
          mutations: [{ ...address, operation: 'set', value: next }],
        });
        if (committed.committed) return next;
        continue;
      }
      const current = parse(row.value);
      if (current.generation === expectedGeneration + 1) return current;
      if (current.generation !== expectedGeneration) {
        throw new Error('Paid-request generation is stale');
      }
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ ...address, revision: row.revision }],
        mutations: [{ ...address, operation: 'set', value: next }],
      });
      if (committed.committed) return next;
    }
    throw new Error('Paid-request generation changed too often');
  }
}
