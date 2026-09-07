/**
 * Durable identity for the explicit BYOK connectivity test.
 *
 * The provider may finish after the renderer times out. Reusing the exact
 * request id across a reload is therefore a billing invariant, not merely a
 * convenience. The journal stores only opaque correlation data: never the
 * API key and never the provider response.
 */
import type { AiCredentialTestRequest, AiCredentialTestResponse } from '../ai/types.js';
import {
  STORAGE,
  hasAtomicStorage,
  type StoragePort,
} from '../ports/index.js';

const JOURNAL_PREFIX = 'credential-test-pending/v1/';
const COMPLETED_PREFIX = 'credential-test-completed/v1/';
const MAX_CAS_ATTEMPTS = 16;
export const AI_CREDENTIAL_TEST_REPLAY_TTL_MS = 5 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface PendingAiCredentialTest {
  version: 1;
  /** SHA-256 of account, server and the non-secret credential descriptor. */
  fingerprint: string;
  request: AiCredentialTestRequest;
  createdAt: string;
}

export interface CompletedAiCredentialTest {
  version: 1;
  fingerprint: string;
  response: AiCredentialTestResponse;
  completedAt: string;
}

export function aiCredentialTestJournalKey(fingerprint: string): string {
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
    throw new TypeError('Invalid AI credential-test fingerprint');
  }
  return `${JOURNAL_PREFIX}${fingerprint}`;
}

function completedKey(fingerprint: string): string {
  aiCredentialTestJournalKey(fingerprint);
  return `${COMPLETED_PREFIX}${fingerprint}`;
}

function parseCompleted(value: unknown, fingerprint: string): CompletedAiCredentialTest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Completed AI credential-test journal is malformed');
  }
  const row = value as Partial<CompletedAiCredentialTest> & Record<string, unknown>;
  const response = row.response as Partial<AiCredentialTestResponse> | undefined;
  if (
    Object.keys(row).some((key) => !['version', 'fingerprint', 'response', 'completedAt'].includes(key))
    || row.version !== 1
    || row.fingerprint !== fingerprint
    || !response
    || response.ok !== true
    || (response.provider !== 'openai' && response.provider !== 'gemini')
    || typeof response.model !== 'string'
    || response.model.length === 0
    || response.source !== 'byo'
    || typeof response.taskVersion !== 'string'
    || typeof response.clientRequestId !== 'string'
    || !UUID_V4.test(response.clientRequestId)
    || typeof response.interactionId !== 'string'
    || !UUID_V4.test(response.interactionId)
    || (response.accounting !== 'settled' && response.accounting !== 'pending')
    || typeof row.completedAt !== 'string'
    || Number.isNaN(Date.parse(row.completedAt))
  ) throw new Error('Completed AI credential-test journal is malformed');
  return {
    version: 1,
    fingerprint,
    response: response as AiCredentialTestResponse,
    completedAt: new Date(row.completedAt).toISOString(),
  };
}

export function parsePendingAiCredentialTest(value: unknown): PendingAiCredentialTest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI credential-test journal is malformed');
  }
  const row = value as Partial<PendingAiCredentialTest> & Record<string, unknown>;
  const request = row.request as Partial<AiCredentialTestRequest> | undefined;
  if (
    Object.keys(row).some((key) => !['version', 'fingerprint', 'request', 'createdAt'].includes(key))
    || row.version !== 1
    || typeof row.fingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(row.fingerprint)
    || !request
    || Object.keys(request).some((key) =>
      !['clientRequestId', 'interactionId', 'taskVersion', 'preferPool'].includes(key))
    || typeof request.clientRequestId !== 'string'
    || !UUID_V4.test(request.clientRequestId)
    || typeof request.interactionId !== 'string'
    || !UUID_V4.test(request.interactionId)
    || typeof request.taskVersion !== 'string'
    || request.taskVersion.length === 0
    || request.taskVersion.length > 128
    || request.preferPool !== false
    || typeof row.createdAt !== 'string'
    || Number.isNaN(Date.parse(row.createdAt))
  ) {
    throw new Error('AI credential-test journal is malformed');
  }
  return {
    version: 1,
    fingerprint: row.fingerprint,
    request: {
      clientRequestId: request.clientRequestId,
      interactionId: request.interactionId,
      taskVersion: request.taskVersion,
      preferPool: false,
    },
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function samePending(left: PendingAiCredentialTest, right: PendingAiCredentialTest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class AiCredentialTestJournal {
  constructor(private readonly storage: StoragePort) {}

  async getOrCreate(
    fingerprint: string,
    request: AiCredentialTestRequest,
    now = new Date(),
  ): Promise<PendingAiCredentialTest> {
    const key = aiCredentialTestJournalKey(fingerprint);
    const candidate = parsePendingAiCredentialTest({
      version: 1,
      fingerprint,
      request,
      createdAt: now.toISOString(),
    });
    const address = { collection: STORAGE.aiCache, key } as const;

    const nonAtomic = async (): Promise<PendingAiCredentialTest> => {
      const stored = await this.storage.get<unknown>(STORAGE.aiCache, key);
      if (stored !== undefined) return parsePendingAiCredentialTest(stored);
      await this.storage.set(STORAGE.aiCache, key, candidate);
      return candidate;
    };
    if (!hasAtomicStorage(this.storage)) {
      return this.storage.runExclusiveMutation
        ? this.storage.runExclusiveMutation(nonAtomic)
        : nonAtomic();
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [entry] = await this.storage.readBatch([address]);
      if (!entry) throw new Error('AI credential-test journal read returned no entry');
      if (entry.exists) return parsePendingAiCredentialTest(entry.value);
      try {
        const committed = await this.storage.commitBatch({
          ifRevisions: [{ ...address, revision: entry.revision }],
          mutations: [{ ...address, operation: 'set', value: candidate }],
        });
        if (committed.committed) return candidate;
      } catch (cause) {
        const durable = await this.storage.get<unknown>(STORAGE.aiCache, key).catch(() => undefined);
        if (durable !== undefined) {
          const parsed = parsePendingAiCredentialTest(durable);
          if (samePending(parsed, candidate)) return parsed;
        }
        throw cause;
      }
    }
    throw new Error('AI credential-test journal changed too often');
  }

  /**
   * Advance only the request the UI actually observed as lost. Two windows
   * that both confirm replacement of generation A converge on the same B;
   * neither may silently create C and buy a second provider call.
   */
  async replace(
    fingerprint: string,
    expectedClientRequestId: string,
    request: AiCredentialTestRequest,
    now = new Date(),
  ): Promise<PendingAiCredentialTest> {
    if (!UUID_V4.test(expectedClientRequestId)) {
      throw new TypeError('Invalid expected credential-test request id');
    }
    const key = aiCredentialTestJournalKey(fingerprint);
    const candidate = parsePendingAiCredentialTest({
      version: 1,
      fingerprint,
      request,
      createdAt: now.toISOString(),
    });
    const address = { collection: STORAGE.aiCache, key } as const;
    const replace = async (): Promise<PendingAiCredentialTest> => {
      const stored = await this.storage.get<unknown>(STORAGE.aiCache, key);
      if (stored === undefined) throw new Error('Credential-test receipt is no longer available');
      const current = parsePendingAiCredentialTest(stored);
      if (current.request.clientRequestId !== expectedClientRequestId) return current;
      await this.storage.set(STORAGE.aiCache, key, candidate);
      return candidate;
    };
    if (!hasAtomicStorage(this.storage)) {
      return this.storage.runExclusiveMutation
        ? this.storage.runExclusiveMutation(replace)
        : replace();
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [entry] = await this.storage.readBatch([address]);
      if (!entry?.exists) throw new Error('Credential-test receipt is no longer available');
      const current = parsePendingAiCredentialTest(entry.value);
      if (current.request.clientRequestId !== expectedClientRequestId) return current;
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ ...address, revision: entry.revision }],
        mutations: [{ ...address, operation: 'set', value: candidate }],
      });
      if (committed.committed) return candidate;
    }
    throw new Error('AI credential-test replacement changed too often');
  }

  async completed(
    fingerprint: string,
    now = new Date(),
  ): Promise<AiCredentialTestResponse | undefined> {
    const key = completedKey(fingerprint);
    const address = { collection: STORAGE.aiCache, key } as const;
    const isFresh = (row: CompletedAiCredentialTest): boolean => {
      const age = now.getTime() - new Date(row.completedAt).getTime();
      return Number.isFinite(age) && age >= 0 && age <= AI_CREDENTIAL_TEST_REPLAY_TTL_MS;
    };
    if (!hasAtomicStorage(this.storage)) {
      const read = async (): Promise<AiCredentialTestResponse | undefined> => {
        const value = await this.storage.get<unknown>(STORAGE.aiCache, key);
        if (value === undefined) return undefined;
        const row = parseCompleted(value, fingerprint);
        if (isFresh(row)) return row.response;
        await this.storage.delete(STORAGE.aiCache, key);
        return undefined;
      };
      return this.storage.runExclusiveMutation
        ? this.storage.runExclusiveMutation(read)
        : read();
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [entry] = await this.storage.readBatch([address]);
      if (!entry?.exists) return undefined;
      const row = parseCompleted(entry.value, fingerprint);
      if (isFresh(row)) return row.response;
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ ...address, revision: entry.revision }],
        mutations: [{ ...address, operation: 'delete' }],
      });
      if (committed.committed) return undefined;
    }
    throw new Error('AI credential-test completion changed too often');
  }

  async complete(
    fingerprint: string,
    response: AiCredentialTestResponse,
    now = new Date(),
  ): Promise<void> {
    const pending = aiCredentialTestJournalKey(fingerprint);
    const completed = completedKey(fingerprint);
    const row = parseCompleted({
      version: 1,
      fingerprint,
      response,
      completedAt: now.toISOString(),
    }, fingerprint);
    if (!hasAtomicStorage(this.storage)) {
      const write = async (): Promise<void> => {
        await this.storage.set(STORAGE.aiCache, completed, row);
        await this.storage.delete(STORAGE.aiCache, pending);
      };
      if (this.storage.runExclusiveMutation) await this.storage.runExclusiveMutation(write);
      else await write();
      return;
    }
    const addresses = [
      { collection: STORAGE.aiCache, key: pending },
      { collection: STORAGE.aiCache, key: completed },
    ] as const;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [pendingRow, completedRow] = await this.storage.readBatch(addresses);
      if (!pendingRow || !completedRow) throw new Error('AI credential-test completion read failed');
      if (completedRow.exists) {
        const existing = parseCompleted(completedRow.value, fingerprint);
        if (JSON.stringify(existing.response) !== JSON.stringify(row.response)) {
          throw new Error('AI credential-test completion conflicts with an existing result');
        }
        return;
      }
      const committed = await this.storage.commitBatch({
        ifRevisions: addresses.map((address, index) => ({
          ...address,
          revision: index === 0 ? pendingRow.revision : completedRow.revision,
        })),
        mutations: [
          { ...addresses[1], operation: 'set', value: row },
          { ...addresses[0], operation: 'delete' },
        ],
      });
      if (committed.committed) return;
    }
    throw new Error('AI credential-test completion changed too often');
  }

  async clearAll(): Promise<void> {
    const keys = await this.storage.keys(STORAGE.aiCache);
    const targets = keys.filter((key) =>
      key.startsWith(JOURNAL_PREFIX) || key.startsWith(COMPLETED_PREFIX));
    for (const key of targets) await this.storage.delete(STORAGE.aiCache, key);
  }

  /** Remove only one account/credential identity; never disturb another payer. */
  async clearFingerprint(fingerprint: string): Promise<void> {
    const addresses = [
      { collection: STORAGE.aiCache, key: aiCredentialTestJournalKey(fingerprint) },
      { collection: STORAGE.aiCache, key: completedKey(fingerprint) },
    ] as const;
    const remove = async (): Promise<void> => {
      for (const address of addresses) {
        await this.storage.delete(address.collection, address.key);
      }
    };
    if (!hasAtomicStorage(this.storage)) {
      if (this.storage.runExclusiveMutation) await this.storage.runExclusiveMutation(remove);
      else await remove();
      return;
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const entries = await this.storage.readBatch(addresses);
      if (entries.length !== addresses.length) throw new Error('AI credential-test clear read failed');
      if (entries.every((entry) => !entry.exists)) return;
      const committed = await this.storage.commitBatch({
        ifRevisions: entries.map((entry, index) => ({
          ...addresses[index]!,
          revision: entry.revision,
        })),
        mutations: entries.flatMap((entry, index) => entry.exists
          ? [{ ...addresses[index]!, operation: 'delete' as const }]
          : []),
      });
      if (committed.committed) return;
    }
    throw new Error('AI credential-test clear changed too often');
  }

  async clear(fingerprint: string, clientRequestId: string): Promise<void> {
    const key = aiCredentialTestJournalKey(fingerprint);
    const address = { collection: STORAGE.aiCache, key } as const;
    const remove = async (): Promise<void> => {
      const stored = await this.storage.get<unknown>(STORAGE.aiCache, key);
      if (stored === undefined) return;
      if (parsePendingAiCredentialTest(stored).request.clientRequestId !== clientRequestId) return;
      await this.storage.delete(STORAGE.aiCache, key);
    };
    if (!hasAtomicStorage(this.storage)) {
      if (this.storage.runExclusiveMutation) await this.storage.runExclusiveMutation(remove);
      else await remove();
      return;
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [entry] = await this.storage.readBatch([address]);
      if (!entry?.exists) return;
      if (parsePendingAiCredentialTest(entry.value).request.clientRequestId !== clientRequestId) return;
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ ...address, revision: entry.revision }],
        mutations: [{ ...address, operation: 'delete' }],
      });
      if (committed.committed) return;
    }
    throw new Error('AI credential-test journal changed too often');
  }
}
