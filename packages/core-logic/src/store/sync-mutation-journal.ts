import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalizeArchive, isGrading, normNum } from '../model/archive.js';
import type { ArchiveContent, CompetencyEntry, PartEntry } from '../model/archive.js';
import { hasAtomicStorage, STORAGE, type StoragePort } from '../ports/index.js';
import { stableStringify } from '../sync/checksum.js';

export type SyncMutationOperation = 'sync' | 'resolve';

export interface SyncMutationScope {
  serverBaseUrl: string;
  userId: string;
}

export interface SyncMutationSyncIntent {
  operation: 'sync';
  fingerprint: string;
  baseVersion: number;
  localArchive: ArchiveContent;
}

export interface SyncMutationResolveIntent {
  operation: 'resolve';
  fingerprint: string;
  baseServerVersion: number;
  resolvedArchive: ArchiveContent;
  /** Fingerprint of the local archive that the conflict dialog was based on. */
  expectedLocalFingerprint: string;
}

export type SyncMutationIntent = SyncMutationSyncIntent | SyncMutationResolveIntent;

interface SyncMutationRecordBase {
  version: 2;
  /** SHA-256 of the canonical endpoint/user tuple; neither value is stored. */
  scopeDigest: string;
  operation: SyncMutationOperation;
  fingerprint: string;
  /** Integrity check over operation, fingerprint and the complete intent. */
  intentDigest: string;
  clientMutationId: string;
  createdAt: string;
}

export type SyncMutationRecord =
  | (SyncMutationRecordBase & {
    operation: 'sync';
    intent: {
      baseVersion: number;
      localArchive: ArchiveContent;
    };
  })
  | (SyncMutationRecordBase & {
    operation: 'resolve';
    intent: {
      baseServerVersion: number;
      resolvedArchive: ArchiveContent;
      expectedLocalFingerprint: string;
    };
  });

const KEY_PREFIX = 'sync-mutation/v2/';
export const SYNC_MUTATION_LEGACY_KEY_PREFIX = 'sync-mutation/v1/';
const MAX_CAS_ATTEMPTS = 6;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_IDENTITY_LENGTH = 512;
const MAX_FINGERPRINT_LENGTH = 512;
const MAX_PARTS = 100_000;
const MAX_COMPETENCIES = 20_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

function sha256Hex(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${field} has an invalid shape`);
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} has an invalid shape`);
  }
  return value as Record<string, unknown>;
}

function assertBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || CONTROL_CHARACTER.test(value)
  ) {
    throw new TypeError(`Invalid ${field}`);
  }
}

function assertFingerprint(value: unknown, field = 'sync mutation fingerprint'): asserts value is string {
  assertBoundedString(value, field, MAX_FINGERPRINT_LENGTH);
}

function assertVersion(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Invalid ${field}`);
  }
}

function canonicalServerEndpoint(raw: unknown): string {
  assertBoundedString(raw, 'sync mutation server endpoint', MAX_ENDPOINT_LENGTH);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TypeError('Invalid sync mutation server endpoint');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || !url.hostname
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new TypeError('Invalid sync mutation server endpoint');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

function scopeIdentity(scope: SyncMutationScope): { digest: string; userId: string } {
  const value = asRecord(scope, 'sync mutation scope');
  assertExactKeys(value, ['serverBaseUrl', 'userId'], 'sync mutation scope');
  assertBoundedString(value.userId, 'sync mutation user identity', MAX_IDENTITY_LENGTH);
  const userId = value.userId.trim();
  if (!userId) throw new TypeError('Invalid sync mutation user identity');
  const endpoint = canonicalServerEndpoint(value.serverBaseUrl);
  return {
    digest: sha256Hex(stableStringify(['qed2-sync-scope-v2', endpoint, userId])),
    userId,
  };
}

function fingerprintDigest(operation: SyncMutationOperation, fingerprint: string): string {
  return sha256Hex(stableStringify(['qed2-sync-fingerprint-v2', operation, fingerprint]));
}

function journalKey(
  scopeDigest: string,
  operation: SyncMutationOperation,
  fingerprint: string,
): string {
  return `${KEY_PREFIX}${scopeDigest}/${operation}/${fingerprintDigest(operation, fingerprint)}`;
}

function uuidV4(): string {
  const native = globalThis.crypto?.randomUUID?.();
  if (native && UUID_V4.test(native)) return native;
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.every((value) => value === 0)) {
    throw new Error('Secure random UUID generation is unavailable');
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${field} is invalid`);
  return timestamp.toISOString();
}

function exactCanonicalTimestamp(value: unknown, field: string): string {
  const canonical = canonicalTimestamp(value, field);
  if (canonical !== value) throw new Error(`${field} is not canonical`);
  return canonical;
}

function assertFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} is invalid`);
  }
}

function assertCanonicalNumber(value: unknown, field: string): asserts value is number {
  assertFiniteNumber(value, field);
  if (normNum(value) !== value) throw new Error(`${field} is not canonical`);
}

function assertCounter(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} is invalid`);
  }
}

function validatePartEntry(value: unknown, index: number, canonical: boolean): PartEntry {
  const field = `archive.perPart[${index}]`;
  const entry = asRecord(value, field);
  const hasLastResult = Object.prototype.hasOwnProperty.call(entry, 'lastResult');
  assertExactKeys(
    entry,
    hasLastResult
      ? ['partId', 'grading', 'starred', 'fsrs', 'lastResult', 'updatedAt']
      : ['partId', 'grading', 'starred', 'fsrs', 'updatedAt'],
    field,
  );
  assertBoundedString(entry.partId, `${field}.partId`, 200);
  if (entry.grading !== null && !isGrading(entry.grading)) {
    throw new Error(`${field}.grading is invalid`);
  }
  if (typeof entry.starred !== 'boolean') throw new Error(`${field}.starred is invalid`);

  const fsrs = asRecord(entry.fsrs, `${field}.fsrs`);
  assertExactKeys(
    fsrs,
    ['due', 'stability', 'difficulty', 'reps', 'lapses', 'lastReview'],
    `${field}.fsrs`,
  );
  const due = canonical
    ? exactCanonicalTimestamp(fsrs.due, `${field}.fsrs.due`)
    : canonicalTimestamp(fsrs.due, `${field}.fsrs.due`);
  assertFiniteNumber(fsrs.stability, `${field}.fsrs.stability`);
  assertFiniteNumber(fsrs.difficulty, `${field}.fsrs.difficulty`);
  assertCounter(fsrs.reps, `${field}.fsrs.reps`);
  assertCounter(fsrs.lapses, `${field}.fsrs.lapses`);
  if (canonical) {
    assertCanonicalNumber(fsrs.stability, `${field}.fsrs.stability`);
    assertCanonicalNumber(fsrs.difficulty, `${field}.fsrs.difficulty`);
  }
  const lastReview = fsrs.lastReview === null
    ? null
    : canonical
      ? exactCanonicalTimestamp(fsrs.lastReview, `${field}.fsrs.lastReview`)
      : canonicalTimestamp(fsrs.lastReview, `${field}.fsrs.lastReview`);

  let lastResult: PartEntry['lastResult'];
  if (hasLastResult) {
    const result = asRecord(entry.lastResult, `${field}.lastResult`);
    assertExactKeys(result, ['correct', 'awardedPoints', 'gradedAt'], `${field}.lastResult`);
    if (typeof result.correct !== 'boolean') throw new Error(`${field}.lastResult.correct is invalid`);
    assertFiniteNumber(result.awardedPoints, `${field}.lastResult.awardedPoints`);
    if (canonical) {
      assertCanonicalNumber(result.awardedPoints, `${field}.lastResult.awardedPoints`);
    }
    lastResult = {
      correct: result.correct,
      awardedPoints: result.awardedPoints,
      gradedAt: canonical
        ? exactCanonicalTimestamp(result.gradedAt, `${field}.lastResult.gradedAt`)
        : canonicalTimestamp(result.gradedAt, `${field}.lastResult.gradedAt`),
    };
  }

  return {
    partId: entry.partId,
    grading: entry.grading,
    starred: entry.starred,
    fsrs: {
      due,
      stability: fsrs.stability,
      difficulty: fsrs.difficulty,
      reps: fsrs.reps,
      lapses: fsrs.lapses,
      lastReview,
    },
    ...(lastResult ? { lastResult } : {}),
    updatedAt: canonical
      ? exactCanonicalTimestamp(entry.updatedAt, `${field}.updatedAt`)
      : canonicalTimestamp(entry.updatedAt, `${field}.updatedAt`),
  };
}

function validateCompetencyEntry(value: unknown, index: number, canonical: boolean): CompetencyEntry {
  const field = `archive.perCompetency[${index}]`;
  const entry = asRecord(value, field);
  assertExactKeys(entry, ['code', 'mastery', 'updatedAt'], field);
  assertBoundedString(entry.code, `${field}.code`, 64);
  assertFiniteNumber(entry.mastery, `${field}.mastery`);
  if (canonical) assertCanonicalNumber(entry.mastery, `${field}.mastery`);
  return {
    code: entry.code,
    mastery: entry.mastery,
    updatedAt: canonical
      ? exactCanonicalTimestamp(entry.updatedAt, `${field}.updatedAt`)
      : canonicalTimestamp(entry.updatedAt, `${field}.updatedAt`),
  };
}

function validateArchive(value: unknown, canonical: boolean): ArchiveContent {
  const archive = asRecord(value, 'archive');
  assertExactKeys(archive, ['perPart', 'perCompetency'], 'archive');
  if (!Array.isArray(archive.perPart) || archive.perPart.length > MAX_PARTS) {
    throw new Error('archive.perPart is invalid');
  }
  if (!Array.isArray(archive.perCompetency) || archive.perCompetency.length > MAX_COMPETENCIES) {
    throw new Error('archive.perCompetency is invalid');
  }
  const perPart = archive.perPart.map((entry, index) => validatePartEntry(entry, index, canonical));
  const perCompetency = archive.perCompetency.map(
    (entry, index) => validateCompetencyEntry(entry, index, canonical),
  );
  if (new Set(perPart.map((entry) => entry.partId)).size !== perPart.length) {
    throw new Error('archive.perPart contains duplicate identities');
  }
  if (new Set(perCompetency.map((entry) => entry.code)).size !== perCompetency.length) {
    throw new Error('archive.perCompetency contains duplicate identities');
  }
  if (canonical) {
    for (let index = 1; index < perPart.length; index += 1) {
      if ((perPart[index - 1]?.partId ?? '') >= (perPart[index]?.partId ?? '')) {
        throw new Error('archive.perPart is not canonical');
      }
    }
    for (let index = 1; index < perCompetency.length; index += 1) {
      if ((perCompetency[index - 1]?.code ?? '') >= (perCompetency[index]?.code ?? '')) {
        throw new Error('archive.perCompetency is not canonical');
      }
    }
  }
  return { perPart, perCompetency };
}

function canonicalArchive(value: unknown): ArchiveContent {
  const structurallyValid = validateArchive(value, false);
  const result = canonicalizeArchive(structurallyValid);
  return validateArchive(result, true);
}

function storedCanonicalArchive(value: unknown): ArchiveContent {
  const result = validateArchive(value, true);
  const canonical = canonicalizeArchive(result);
  if (stableStringify(result) !== stableStringify(canonical)) {
    throw new Error('archive is not canonical');
  }
  return result;
}

function normalizeIntent(intent: SyncMutationIntent): SyncMutationIntent {
  const value = asRecord(intent, 'sync mutation intent');
  if (value.operation === 'sync') {
    assertExactKeys(
      value,
      ['operation', 'fingerprint', 'baseVersion', 'localArchive'],
      'sync mutation intent',
    );
    assertFingerprint(value.fingerprint);
    assertVersion(value.baseVersion, 'sync base version');
    return {
      operation: 'sync',
      fingerprint: value.fingerprint,
      baseVersion: value.baseVersion,
      localArchive: canonicalArchive(value.localArchive),
    };
  }
  if (value.operation === 'resolve') {
    assertExactKeys(
      value,
      [
        'operation',
        'fingerprint',
        'baseServerVersion',
        'resolvedArchive',
        'expectedLocalFingerprint',
      ],
      'sync mutation intent',
    );
    assertFingerprint(value.fingerprint);
    assertFingerprint(value.expectedLocalFingerprint, 'expected local archive fingerprint');
    assertVersion(value.baseServerVersion, 'resolve base server version');
    return {
      operation: 'resolve',
      fingerprint: value.fingerprint,
      baseServerVersion: value.baseServerVersion,
      resolvedArchive: canonicalArchive(value.resolvedArchive),
      expectedLocalFingerprint: value.expectedLocalFingerprint,
    };
  }
  throw new TypeError('Invalid sync mutation operation');
}

function recordIntent(record: SyncMutationRecord): SyncMutationIntent {
  if (record.operation === 'sync') {
    return {
      operation: 'sync',
      fingerprint: record.fingerprint,
      baseVersion: record.intent.baseVersion,
      localArchive: record.intent.localArchive,
    };
  }
  return {
    operation: 'resolve',
    fingerprint: record.fingerprint,
    baseServerVersion: record.intent.baseServerVersion,
    resolvedArchive: record.intent.resolvedArchive,
    expectedLocalFingerprint: record.intent.expectedLocalFingerprint,
  };
}

function intentSerialization(intent: SyncMutationIntent): string {
  return stableStringify(intent);
}

function intentDigest(intent: SyncMutationIntent): string {
  return sha256Hex(intentSerialization(intent));
}

function createRecord(
  scopeDigest: string,
  intent: SyncMutationIntent,
  now: Date,
): SyncMutationRecord {
  if (Number.isNaN(now.getTime())) throw new TypeError('Invalid sync mutation timestamp');
  const common = {
    version: 2 as const,
    scopeDigest,
    operation: intent.operation,
    fingerprint: intent.fingerprint,
    intentDigest: intentDigest(intent),
    clientMutationId: uuidV4(),
    createdAt: now.toISOString(),
  };
  if (intent.operation === 'sync') {
    return {
      ...common,
      operation: 'sync',
      intent: {
        baseVersion: intent.baseVersion,
        localArchive: intent.localArchive,
      },
    };
  }
  return {
    ...common,
    operation: 'resolve',
    intent: {
      baseServerVersion: intent.baseServerVersion,
      resolvedArchive: intent.resolvedArchive,
      expectedLocalFingerprint: intent.expectedLocalFingerprint,
    },
  };
}

function parseRecord(value: unknown, expectedScopeDigest?: string): SyncMutationRecord | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, 'sync mutation journal');
  assertExactKeys(
    record,
    [
      'version',
      'scopeDigest',
      'operation',
      'fingerprint',
      'intent',
      'intentDigest',
      'clientMutationId',
      'createdAt',
    ],
    'sync mutation journal',
  );
  if (
    record.version !== 2
    || typeof record.scopeDigest !== 'string'
    || !SHA256_HEX.test(record.scopeDigest)
    || (expectedScopeDigest !== undefined && record.scopeDigest !== expectedScopeDigest)
    || (record.operation !== 'sync' && record.operation !== 'resolve')
  ) {
    throw new Error('Sync mutation journal is malformed');
  }
  assertFingerprint(record.fingerprint);
  if (
    typeof record.intentDigest !== 'string'
    || !SHA256_HEX.test(record.intentDigest)
    || typeof record.clientMutationId !== 'string'
    || !UUID_V4.test(record.clientMutationId)
  ) {
    throw new Error('Sync mutation journal is malformed');
  }
  const createdAt = exactCanonicalTimestamp(record.createdAt, 'sync mutation createdAt');
  const storedIntent = asRecord(record.intent, 'sync mutation journal intent');
  let parsed: SyncMutationRecord;
  if (record.operation === 'sync') {
    assertExactKeys(storedIntent, ['baseVersion', 'localArchive'], 'sync mutation journal intent');
    assertVersion(storedIntent.baseVersion, 'sync base version');
    parsed = {
      version: 2,
      scopeDigest: record.scopeDigest,
      operation: 'sync',
      fingerprint: record.fingerprint,
      intent: {
        baseVersion: storedIntent.baseVersion,
        localArchive: storedCanonicalArchive(storedIntent.localArchive),
      },
      intentDigest: record.intentDigest,
      clientMutationId: record.clientMutationId,
      createdAt,
    };
  } else {
    assertExactKeys(
      storedIntent,
      ['baseServerVersion', 'resolvedArchive', 'expectedLocalFingerprint'],
      'sync mutation journal intent',
    );
    assertVersion(storedIntent.baseServerVersion, 'resolve base server version');
    assertFingerprint(storedIntent.expectedLocalFingerprint, 'expected local archive fingerprint');
    parsed = {
      version: 2,
      scopeDigest: record.scopeDigest,
      operation: 'resolve',
      fingerprint: record.fingerprint,
      intent: {
        baseServerVersion: storedIntent.baseServerVersion,
        resolvedArchive: storedCanonicalArchive(storedIntent.resolvedArchive),
        expectedLocalFingerprint: storedIntent.expectedLocalFingerprint,
      },
      intentDigest: record.intentDigest,
      clientMutationId: record.clientMutationId,
      createdAt,
    };
  }
  if (intentDigest(recordIntent(parsed)) !== parsed.intentDigest) {
    throw new Error('Sync mutation journal intent integrity check failed');
  }
  return parsed;
}

function assertSameIdentity(
  record: SyncMutationRecord,
  scopeDigest: string,
  intent: SyncMutationIntent,
): void {
  if (
    record.scopeDigest !== scopeDigest
    || record.operation !== intent.operation
    || record.fingerprint !== intent.fingerprint
  ) {
    throw new Error('Sync mutation journal identity mismatch');
  }
  if (intentSerialization(recordIntent(record)) !== intentSerialization(intent)) {
    throw new Error('Sync mutation fingerprint is already bound to a different intent');
  }
}

function requireAtomicStorage(storage: StoragePort): asserts storage is StoragePort & Required<Pick<StoragePort, 'readBatch' | 'commitBatch'>> {
  if (!hasAtomicStorage(storage)) {
    throw new Error('Sync mutation journal requires atomic storage');
  }
}

/**
 * Durable idempotency identities for archive writes. The complete wire intent
 * is persisted before a request is sent. A record is removed only by CAS after
 * the semantic response has also been handled durably on the client;
 * ambiguous failures therefore reuse the same lowercase UUID v4 after a
 * restart.
 */
export class SyncMutationJournal {
  constructor(private readonly storage: StoragePort) {}

  async getOrCreate(
    scope: SyncMutationScope,
    rawIntent: SyncMutationIntent,
    now = new Date(),
  ): Promise<SyncMutationRecord> {
    requireAtomicStorage(this.storage);
    const identity = scopeIdentity(scope);
    const intent = normalizeIntent(rawIntent);
    const key = journalKey(identity.digest, intent.operation, intent.fingerprint);

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await this.storage.readBatch([{ collection: STORAGE.app, key }]);
      if (!snapshot) {
        throw new Error('Sync mutation journal read returned no entry');
      }
      const existing = parseRecord(snapshot.value, identity.digest);
      if (existing) {
        assertSameIdentity(existing, identity.digest, intent);
        return existing;
      }
      const created = createRecord(identity.digest, intent, now);
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ collection: STORAGE.app, key, revision: snapshot.revision }],
        mutations: [{ collection: STORAGE.app, key, operation: 'set', value: created }],
      });
      if (committed.committed) {
        const parsed = parseRecord(created, identity.digest);
        if (!parsed) throw new Error('Sync mutation journal record was not created');
        return parsed;
      }
    }
    throw new Error('Sync mutation journal changed too often');
  }

  async listPending(scope: SyncMutationScope): Promise<SyncMutationRecord[]> {
    const identity = scopeIdentity(scope);
    const keys = await this.storage.keys(STORAGE.app);
    const prefix = `${KEY_PREFIX}${identity.digest}/`;
    const records: SyncMutationRecord[] = [];
    for (const key of keys.filter((candidate) => candidate.startsWith(prefix)).sort()) {
      const record = parseRecord(
        await this.storage.get<unknown>(STORAGE.app, key),
        identity.digest,
      );
      // A concurrent acknowledgement may remove a row between keys() and get().
      if (!record) continue;
      if (journalKey(identity.digest, record.operation, record.fingerprint) !== key) {
        throw new Error('Sync mutation journal key does not match its record');
      }
      records.push(record);
    }
    return records.sort((left, right) =>
      compareStrings(left.createdAt, right.createdAt)
      || compareStrings(left.operation, right.operation)
      || compareStrings(left.fingerprint, right.fingerprint)
      || compareStrings(left.clientMutationId, right.clientMutationId));
  }

  async complete(
    scope: SyncMutationScope,
    operation: SyncMutationOperation,
    fingerprint: string,
    clientMutationId: string,
  ): Promise<void> {
    requireAtomicStorage(this.storage);
    const identity = scopeIdentity(scope);
    if (operation !== 'sync' && operation !== 'resolve') {
      throw new TypeError('Invalid sync mutation operation');
    }
    assertFingerprint(fingerprint);
    if (!UUID_V4.test(clientMutationId)) {
      throw new TypeError('Invalid sync mutation client identity');
    }
    const key = journalKey(identity.digest, operation, fingerprint);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await this.storage.readBatch([{ collection: STORAGE.app, key }]);
      if (!snapshot) throw new Error('Sync mutation journal read returned no entry');
      const existing = parseRecord(snapshot.value, identity.digest);
      if (!existing) return;
      if (existing.operation !== operation || existing.fingerprint !== fingerprint) {
        throw new Error('Sync mutation journal identity mismatch');
      }
      if (existing.clientMutationId !== clientMutationId) return;
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ collection: STORAGE.app, key, revision: snapshot.revision }],
        mutations: [{ collection: STORAGE.app, key, operation: 'delete' }],
      });
      if (committed.committed) return;
    }
    throw new Error('Sync mutation journal changed too often');
  }
}
