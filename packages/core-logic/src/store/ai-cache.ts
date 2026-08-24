/**
 * Durable, local-only cache for provider responses already paid for.
 *
 * Each answer has its own revisioned key. A single JSON map made two tabs do
 * read/modify/write over one document, so the later writer could erase a paid
 * response from the other tab. The epoch metadata coordinates clear() with
 * concurrent writes without clearing unrelated AI journals.
 */
import {
  STORAGE,
  hasAtomicStorage,
  type StoragePort,
} from '../ports/index.js';

export interface CachedAiAnswer<T = unknown> {
  key: string;
  payload: T;
  storedAt: string;
}

interface CacheMeta {
  version: 1;
  epoch: number;
}

interface CacheEntry<T = unknown> extends CachedAiAnswer<T> {
  version: 4;
  epoch: number;
  scope: string;
}

export const AI_CACHE_META_KEY = 'answer-cache-meta-v4/';
const ENTRY_PREFIX = 'answer-v4/';
const LEGACY_ENTRY_PREFIX = 'answer-v3/';
const LEGACY_META_KEY = 'answer-cache-meta-v3';
const LEGACY_CACHE_KEY = 'answers-v2';
const BETA_CACHE_KEY = 'answers';
const MAX_CAS_ATTEMPTS = 24;

export const MAX_CACHED_ANSWERS = 120;
export const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export class AiCacheWriteInvalidatedError extends Error {
  constructor() {
    super('AI cache was cleared while this response was being stored');
    this.name = 'AiCacheWriteInvalidatedError';
  }
}

function parseMeta(value: unknown): CacheMeta {
  if (value === undefined) return { version: 1, epoch: 0 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI cache metadata is malformed');
  const row = value as Partial<CacheMeta> & Record<string, unknown>;
  if (
    Object.keys(row).some((key) => key !== 'version' && key !== 'epoch')
    || row.version !== 1
    || !Number.isSafeInteger(row.epoch)
    || (row.epoch as number) < 0
  ) throw new Error('AI cache metadata is malformed');
  return { version: 1, epoch: row.epoch as number };
}

function validateOpaqueKey(key: string): string {
  if (!key || key.length > 256 || key.includes('\0') || key.includes('/')) {
    throw new TypeError('Invalid AI cache key');
  }
  return key;
}

function validateScope(scope: string): string {
  if (!scope || scope.length > 256 || scope.includes('\0') || scope.includes('/')) {
    throw new TypeError('Invalid AI cache scope');
  }
  return scope;
}

function metaKey(scope: string): string {
  return `${AI_CACHE_META_KEY}${validateScope(scope)}`;
}

function scopeEntryPrefix(scope: string): string {
  return `${ENTRY_PREFIX}${validateScope(scope)}/`;
}

function entryKey(key: string, scope: string): string {
  return `${scopeEntryPrefix(scope)}${validateOpaqueKey(key)}`;
}

function parseEntry<T>(
  value: unknown,
  expectedKey?: string,
  expectedScope?: string,
): CacheEntry<T> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI cache entry is malformed');
  const row = value as Partial<CacheEntry<T>> & Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !['version', 'epoch', 'scope', 'key', 'payload', 'storedAt'].includes(key))
    || row.version !== 4
    || !Number.isSafeInteger(row.epoch)
    || (row.epoch as number) < 0
    || typeof row.key !== 'string'
    || (expectedKey !== undefined && row.key !== expectedKey)
    || typeof row.scope !== 'string'
    || (expectedScope !== undefined && row.scope !== expectedScope)
    || row.payload === undefined
    || typeof row.storedAt !== 'string'
    || Number.isNaN(Date.parse(row.storedAt))
  ) throw new Error('AI cache entry is malformed');
  validateOpaqueKey(row.key);
  validateScope(row.scope);
  return {
    version: 4,
    epoch: row.epoch as number,
    scope: row.scope,
    key: row.key,
    payload: row.payload as T,
    storedAt: new Date(row.storedAt).toISOString(),
  };
}

function parseLegacyEntry<T>(value: unknown, expectedKey: string): CacheEntry<T> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 3
    || !Number.isSafeInteger(row.epoch)
    || typeof row.key !== 'string'
    || row.key !== expectedKey
    || row.payload === undefined
    || typeof row.storedAt !== 'string'
    || Number.isNaN(Date.parse(row.storedAt))
  ) return undefined;
  return {
    version: 4,
    epoch: row.epoch as number,
    scope: '__legacy__',
    key: row.key,
    payload: row.payload as T,
    storedAt: new Date(row.storedAt).toISOString(),
  };
}

function fresh<T>(entry: CacheEntry<T> | undefined, epoch: number, now: Date): entry is CacheEntry<T> {
  if (!entry || entry.epoch !== epoch) return false;
  const age = now.getTime() - new Date(entry.storedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= CACHE_MAX_AGE_MS;
}

function sameEntry(left: CacheEntry, right: CacheEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class AiCache {
  private betaCleared = false;

  constructor(private readonly storage: StoragePort) {}

  private async clearBetaKey(): Promise<void> {
    if (this.betaCleared) return;
    await this.storage.delete(STORAGE.aiCache, BETA_CACHE_KEY);
    this.betaCleared = true;
  }

  private async readCurrent<T>(key: string, scope: string): Promise<{ meta: CacheMeta; entry?: CacheEntry<T> }> {
    const metaAddress = { collection: STORAGE.aiCache, key: metaKey(scope) } as const;
    const rowAddress = { collection: STORAGE.aiCache, key: entryKey(key, scope) } as const;
    if (hasAtomicStorage(this.storage)) {
      const [metaRow, entryRow] = await this.storage.readBatch([metaAddress, rowAddress]);
      if (!metaRow || !entryRow) throw new Error('AI cache read returned incomplete data');
      const entry = parseEntry<T>(entryRow.exists ? entryRow.value : undefined, key, scope);
      return {
        meta: parseMeta(metaRow.exists ? metaRow.value : undefined),
        ...(entry ? { entry } : {}),
      };
    }
    const meta = parseMeta(await this.storage.get<unknown>(STORAGE.aiCache, metaAddress.key));
    const entry = parseEntry<T>(await this.storage.get<unknown>(STORAGE.aiCache, rowAddress.key), key, scope);
    return { meta, ...(entry ? { entry } : {}) };
  }

  private async legacyGet<T>(key: string, scope: string, now: Date): Promise<T | undefined> {
    const legacyMeta = parseMeta(await this.storage.get<unknown>(STORAGE.aiCache, LEGACY_META_KEY));
    const legacyEntry = parseLegacyEntry<T>(
      await this.storage.get<unknown>(STORAGE.aiCache, `${LEGACY_ENTRY_PREFIX}${key}`),
      key,
    );
    if (fresh(legacyEntry, legacyMeta.epoch, now)) {
      // The scoped cache was observed at epoch zero by get(). Keep that
      // observation attached to the background migration: a clear in another
      // renderer must not let old private content enter the new epoch.
      void this.set(key, legacyEntry.payload, new Date(legacyEntry.storedAt), scope, 0)
        .catch(() => undefined);
      return legacyEntry.payload;
    }
    const rows = await this.storage.get<unknown>(STORAGE.aiCache, LEGACY_CACHE_KEY);
    if (!Array.isArray(rows)) return undefined;
    const hit = rows.find((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      return (candidate as { key?: unknown }).key === key;
    }) as CachedAiAnswer<T> | undefined;
    if (!hit || typeof hit.storedAt !== 'string') return undefined;
    const age = now.getTime() - new Date(hit.storedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > CACHE_MAX_AGE_MS) return undefined;
    void this.set(key, hit.payload, new Date(hit.storedAt), scope, 0).catch(() => undefined);
    return hit.payload;
  }

  async get<T>(key: string, now = new Date(), scope = 'global'): Promise<T | undefined> {
    validateScope(scope);
    await this.clearBetaKey();
    const current = await this.readCurrent<T>(key, scope);
    if (fresh(current.entry, current.meta.epoch, now)) return current.entry.payload;
    // A scoped clear increments only this profile's epoch. Legacy rows are
    // unscoped, so they may be imported exactly once before that first clear.
    return current.meta.epoch === 0 ? this.legacyGet<T>(key, scope, now) : undefined;
  }

  /**
   * Captures the clear epoch before a paid network request starts. Passing the
   * token back to set() prevents a response that predates clear() from being
   * admitted into the new cache epoch.
   */
  async captureWriteToken(scope = 'global'): Promise<number> {
    validateScope(scope);
    await this.clearBetaKey();
    return parseMeta(await this.storage.get<unknown>(STORAGE.aiCache, metaKey(scope))).epoch;
  }

  async set<T>(
    key: string,
    payload: T,
    now = new Date(),
    scope = 'global',
    expectedEpoch?: number,
  ): Promise<void> {
    validateScope(scope);
    await this.clearBetaKey();
    if (payload === undefined) throw new TypeError('AI cache payload must be defined');
    if (expectedEpoch !== undefined && (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0)) {
      throw new TypeError('Invalid AI cache write token');
    }
    const storageKey = entryKey(key, scope);
    const startingMeta = parseMeta(await this.storage.get<unknown>(STORAGE.aiCache, metaKey(scope)));
    if (expectedEpoch !== undefined && startingMeta.epoch !== expectedEpoch) {
      throw new AiCacheWriteInvalidatedError();
    }
    const nonAtomic = async (): Promise<void> => {
      const meta = parseMeta(await this.storage.get<unknown>(STORAGE.aiCache, metaKey(scope)));
      if (meta.epoch !== startingMeta.epoch) {
        throw new AiCacheWriteInvalidatedError();
      }
      const entry: CacheEntry<T> = {
        version: 4,
        epoch: meta.epoch,
        scope,
        key,
        payload,
        storedAt: now.toISOString(),
      };
      await this.storage.set(STORAGE.aiCache, metaKey(scope), meta);
      await this.storage.set(STORAGE.aiCache, storageKey, entry);
    };
    if (!hasAtomicStorage(this.storage)) {
      if (this.storage.runExclusiveMutation) await this.storage.runExclusiveMutation(nonAtomic);
      else await nonAtomic();
      await this.prune(scope);
      return;
    }

    const metaAddress = { collection: STORAGE.aiCache, key: metaKey(scope) } as const;
    const rowAddress = { collection: STORAGE.aiCache, key: storageKey } as const;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [metaRow, entryRow] = await this.storage.readBatch([metaAddress, rowAddress]);
      if (!metaRow || !entryRow) throw new Error('AI cache read returned incomplete data');
      const meta = parseMeta(metaRow.exists ? metaRow.value : undefined);
      if (meta.epoch !== startingMeta.epoch) {
        throw new AiCacheWriteInvalidatedError();
      }
      const candidate: CacheEntry<T> = {
        version: 4,
        epoch: meta.epoch,
        scope,
        key,
        payload,
        storedAt: now.toISOString(),
      };
      try {
        const committed = await this.storage.commitBatch({
          ifRevisions: [
            { ...metaAddress, revision: metaRow.revision },
            { ...rowAddress, revision: entryRow.revision },
          ],
          mutations: [
            { ...metaAddress, operation: 'set', value: meta },
            { ...rowAddress, operation: 'set', value: candidate },
          ],
        });
        if (committed.committed) {
          await this.prune(scope);
          return;
        }
      } catch (cause) {
        const confirmed = await this.readCurrent<T>(key, scope).catch(() => undefined);
        if (confirmed?.entry && confirmed.meta.epoch === candidate.epoch && sameEntry(confirmed.entry, candidate)) {
          await this.prune(scope);
          return;
        }
        throw cause;
      }
    }
    throw new Error('AI cache changed too often');
  }

  async clear(scope = 'global'): Promise<void> {
    validateScope(scope);
    await this.clearBetaKey();
    const nonAtomic = async (): Promise<void> => {
      const current = parseMeta(await this.storage.get<unknown>(STORAGE.aiCache, metaKey(scope)));
      if (current.epoch >= Number.MAX_SAFE_INTEGER) throw new Error('AI cache epoch exhausted');
      await this.storage.set(STORAGE.aiCache, metaKey(scope), { version: 1, epoch: current.epoch + 1 });
    };
    if (!hasAtomicStorage(this.storage)) {
      if (this.storage.runExclusiveMutation) await this.storage.runExclusiveMutation(nonAtomic);
      else await nonAtomic();
      await this.prune(scope);
      return;
    }

    const metaAddress = { collection: STORAGE.aiCache, key: metaKey(scope) } as const;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [metaRow] = await this.storage.readBatch([metaAddress]);
      if (!metaRow) throw new Error('AI cache clear read returned incomplete data');
      const current = parseMeta(metaRow.exists ? metaRow.value : undefined);
      if (current.epoch >= Number.MAX_SAFE_INTEGER) throw new Error('AI cache epoch exhausted');
      const committed = await this.storage.commitBatch({
        ifRevisions: [
          { ...metaAddress, revision: metaRow.revision },
        ],
        mutations: [
          { ...metaAddress, operation: 'set', value: { version: 1, epoch: current.epoch + 1 } },
        ],
      });
      if (committed.committed) {
        await this.prune(scope);
        return;
      }
    }
    throw new Error('AI cache changed too often');
  }

  async size(scope = 'global'): Promise<number> {
    await this.clearBetaKey();
    return (await this.currentEntries(scope)).length;
  }

  private async currentEntries(scope: string): Promise<Array<{ storageKey: string; row: CacheEntry }>> {
    const meta = parseMeta(await this.storage.get<unknown>(STORAGE.aiCache, metaKey(scope)));
    const prefix = scopeEntryPrefix(scope);
    const keys = (await this.storage.keys(STORAGE.aiCache)).filter((key) => key.startsWith(prefix));
    const rows = await Promise.all(keys.map(async (storageKey) => {
      const key = storageKey.slice(prefix.length);
      try {
        const row = parseEntry(await this.storage.get<unknown>(STORAGE.aiCache, storageKey), key);
        return row?.scope === scope && row.epoch === meta.epoch ? { storageKey, row } : undefined;
      } catch {
        return undefined;
      }
    }));
    return rows.filter((row): row is NonNullable<typeof row> => row !== undefined);
  }

  private async deleteExact(storageKey: string, expected: CacheEntry): Promise<void> {
    if (!hasAtomicStorage(this.storage)) {
      const row = parseEntry(await this.storage.get<unknown>(STORAGE.aiCache, storageKey));
      if (row && sameEntry(row, expected)) await this.storage.delete(STORAGE.aiCache, storageKey);
      return;
    }
    const address = { collection: STORAGE.aiCache, key: storageKey } as const;
    const [snapshot] = await this.storage.readBatch([address]);
    if (!snapshot?.exists) return;
    const row = parseEntry(snapshot.value);
    if (!row || !sameEntry(row, expected)) return;
    await this.storage.commitBatch({
      ifRevisions: [{ ...address, revision: snapshot.revision }],
      mutations: [{ ...address, operation: 'delete' }],
    });
  }

  private async prune(scope: string): Promise<void> {
    const scopedMetaKey = metaKey(scope);
    const meta = parseMeta(await this.storage.get<unknown>(STORAGE.aiCache, scopedMetaKey));
    const prefix = scopeEntryPrefix(scope);
    const allKeys = (await this.storage.keys(STORAGE.aiCache)).filter((key) => key.startsWith(prefix));
    const current: Array<{ storageKey: string; row: CacheEntry }> = [];
    for (const storageKey of allKeys) {
      try {
        const key = storageKey.slice(prefix.length);
        const row = parseEntry(await this.storage.get<unknown>(STORAGE.aiCache, storageKey), key, scope);
        if (row && row.scope === scope && row.epoch !== meta.epoch) {
          const latest = parseMeta(await this.storage.get<unknown>(STORAGE.aiCache, scopedMetaKey));
          if (latest.epoch !== meta.epoch) return;
          await this.deleteExact(storageKey, row);
        }
        else if (row?.scope === scope) current.push({ storageKey, row });
      } catch {
        // Corrupt rows are never replayed and cannot erase a valid paid row.
      }
    }
    current.sort((left, right) => {
      const byTime = right.row.storedAt.localeCompare(left.row.storedAt);
      return byTime !== 0 ? byTime : left.storageKey.localeCompare(right.storageKey);
    });
    for (const row of current.slice(MAX_CACHED_ANSWERS)) {
      const latest = parseMeta(await this.storage.get<unknown>(STORAGE.aiCache, scopedMetaKey));
      if (latest.epoch !== meta.epoch) return;
      await this.deleteExact(row.storageKey, row.row);
    }
  }
}
