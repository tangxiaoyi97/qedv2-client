import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  StorageAddress,
  StorageBatchCommit,
  StorageBatchCommitResult,
  StorageVersionedEntry,
} from '@qed2/core-logic';

const COLLECTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_KEY_LENGTH = 512;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_ADDRESSES = 32;

export interface StorageCodec {
  encode(collection: string, json: string): {
    payload: Uint8Array;
    encoding: string;
    /** False keeps the value in memory for this process only. */
    persistent?: boolean;
  };
  decode(collection: string, payload: Uint8Array, encoding: string): string;
}

export interface StorageRecoveryNotice {
  kind: 'record-quarantined' | 'database-quarantined';
  message: string;
  collection?: string;
  key?: string;
  paths?: string[];
  error: unknown;
}

export interface SqliteStorageOptions {
  onRecovery?: (notice: StorageRecoveryNotice) => void;
}

export interface RecoveredSqliteStorage {
  storage: SqliteStorage;
  quarantinedPaths: string[];
  recoveryError?: unknown;
}

export const plainStorageCodec: StorageCodec = {
  encode: (_collection, json) => ({ payload: Buffer.from(json, 'utf8'), encoding: 'json' }),
  decode: (_collection, payload, encoding) => {
    if (encoding !== 'json') throw new Error(`Unsupported storage encoding: ${encoding}`);
    return Buffer.from(payload).toString('utf8');
  },
};

function validateAddress(collection: string, key?: string): void {
  if (!COLLECTION_PATTERN.test(collection)) throw new Error('Invalid storage collection');
  if (key !== undefined && (key.length === 0 || key.length > MAX_KEY_LENGTH)) {
    throw new Error('Invalid storage key');
  }
}

function addressId(address: StorageAddress): string {
  return `${address.collection}\0${address.key}`;
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateBatch(request: StorageBatchCommit): void {
  if (
    !Array.isArray(request.ifRevisions)
    || request.ifRevisions.length === 0
    || request.ifRevisions.length > MAX_BATCH_ADDRESSES
    || !Array.isArray(request.mutations)
    || request.mutations.length === 0
    || request.mutations.length > MAX_BATCH_ADDRESSES
  ) {
    throw new TypeError('Invalid storage batch size');
  }
  const preconditions = new Set<string>();
  for (const condition of request.ifRevisions) {
    validateAddress(condition.collection, condition.key);
    if (!validRevision(condition.revision)) throw new TypeError('Invalid storage revision');
    const id = addressId(condition);
    if (preconditions.has(id)) throw new TypeError('Duplicate storage precondition');
    preconditions.add(id);
  }
  const mutations = new Set<string>();
  for (const mutation of request.mutations) {
    validateAddress(mutation.collection, mutation.key);
    if (mutation.operation !== 'set' && mutation.operation !== 'delete') {
      throw new TypeError('Invalid storage batch operation');
    }
    const id = addressId(mutation);
    if (!preconditions.has(id)) throw new TypeError('Storage mutation is missing a revision precondition');
    if (mutations.has(id)) throw new TypeError('Duplicate storage mutation');
    mutations.add(id);
  }
}

export class SqliteStorage {
  private readonly db: DatabaseSync;
  private readonly getStatement;
  private readonly setStatement;
  private readonly deleteStatement;
  private readonly keysStatement;
  private readonly clearStatement;
  private readonly quarantineStatement;
  private readonly getRevisionStatement;
  private readonly setRevisionStatement;
  private readonly volatileRows = new Map<string, { payload: Uint8Array; encoding: string }>();

  constructor(
    readonly filePath: string,
    private readonly codec: StorageCodec = plainStorageCodec,
    private readonly options: SqliteStorageOptions = {},
  ) {
    // DatabaseSync opens immediately, so the private parent directory must
    // exist before construction (first launch otherwise failed with ENOENT).
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath, { timeout: 5_000, defensive: true });
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        CREATE TABLE IF NOT EXISTS kv (
          collection TEXT NOT NULL,
          key TEXT NOT NULL,
          payload BLOB NOT NULL,
          encoding TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (collection, key)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS quarantined_kv (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          collection TEXT NOT NULL,
          key TEXT NOT NULL,
          payload BLOB NOT NULL,
          encoding TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL,
          reason TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kv_revisions (
          collection TEXT NOT NULL,
          key TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          PRIMARY KEY (collection, key)
        ) WITHOUT ROWID;
        INSERT OR IGNORE INTO kv_revisions (collection, key, revision)
          SELECT collection, key, 1 FROM kv;
      `);
      const check = this.db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      if (check?.quick_check !== 'ok') {
        throw new Error(`Local data integrity check failed: ${check?.quick_check ?? 'unknown'}`);
      }
      this.getStatement = this.db.prepare('SELECT payload, encoding FROM kv WHERE collection = ? AND key = ?');
      this.setStatement = this.db.prepare(`
        INSERT INTO kv (collection, key, payload, encoding, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(collection, key) DO UPDATE SET
          payload = excluded.payload,
          encoding = excluded.encoding,
          updated_at = excluded.updated_at
      `);
      this.deleteStatement = this.db.prepare('DELETE FROM kv WHERE collection = ? AND key = ?');
      this.keysStatement = this.db.prepare('SELECT key FROM kv WHERE collection = ? ORDER BY key');
      this.clearStatement = this.db.prepare('DELETE FROM kv WHERE collection = ?');
      this.quarantineStatement = this.db.prepare(`
        INSERT INTO quarantined_kv
          (collection, key, payload, encoding, quarantined_at, reason)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      this.getRevisionStatement = this.db.prepare(
        'SELECT revision FROM kv_revisions WHERE collection = ? AND key = ?',
      );
      this.setRevisionStatement = this.db.prepare(`
        INSERT INTO kv_revisions (collection, key, revision)
        VALUES (?, ?, ?)
        ON CONFLICT(collection, key) DO UPDATE SET revision = excluded.revision
      `);
    } catch (error) {
      if (this.db.isOpen) this.db.close();
      throw error;
    }
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Windows and some network file systems do not implement POSIX modes.
      // The app's private userData ACL remains the platform protection there.
    }
  }

  get<T>(collection: string, key: string): T | undefined {
    validateAddress(collection, key);
    const address = `${collection}\0${key}`;
    const volatile = this.volatileRows.get(address);
    const row = volatile ?? (this.getStatement.get(collection, key) as {
      payload: Uint8Array;
      encoding: string;
    } | undefined);
    if (!row) return undefined;
    try {
      return JSON.parse(this.codec.decode(collection, row.payload, row.encoding)) as T;
    } catch (error) {
      if (volatile) {
        this.volatileRows.delete(address);
      } else {
        this.quarantineRecord(collection, key, row, error);
      }
      this.options.onRecovery?.({
        kind: 'record-quarantined',
        collection,
        key,
        error,
        message: 'A damaged local record was isolated; the rest of the database remains available.',
      });
      return undefined;
    }
  }

  set(collection: string, key: string, value: unknown): void {
    validateAddress(collection, key);
    const encoded = this.encodeValue(collection, value);
    const address = `${collection}\0${key}`;
    const nextRevision = this.nextRevision(collection, key);
    this.immediateTransaction(() => {
      if (encoded.persistent === false) this.deleteStatement.run(collection, key);
      else this.setStatement.run(collection, key, encoded.payload, encoded.encoding, Date.now());
      this.setRevisionStatement.run(collection, key, nextRevision);
    });
    if (encoded.persistent === false) {
      this.volatileRows.set(address, { payload: encoded.payload, encoding: encoded.encoding });
    } else {
      this.volatileRows.delete(address);
    }
  }

  delete(collection: string, key: string): void {
    validateAddress(collection, key);
    const nextRevision = this.nextRevision(collection, key);
    this.immediateTransaction(() => {
      this.deleteStatement.run(collection, key);
      this.setRevisionStatement.run(collection, key, nextRevision);
    });
    this.volatileRows.delete(`${collection}\0${key}`);
  }

  keys(collection: string): string[] {
    validateAddress(collection);
    const keys = new Set(
      (this.keysStatement.all(collection) as Array<{ key: string }>).map((row) => row.key),
    );
    const prefix = `${collection}\0`;
    for (const address of this.volatileRows.keys()) {
      if (address.startsWith(prefix)) keys.add(address.slice(prefix.length));
    }
    return [...keys].sort();
  }

  clear(collection: string): void {
    validateAddress(collection);
    const prefix = `${collection}\0`;
    const keys = new Set(
      (this.keysStatement.all(collection) as Array<{ key: string }>).map((row) => row.key),
    );
    for (const address of this.volatileRows.keys()) {
      if (address.startsWith(prefix)) keys.add(address.slice(prefix.length));
    }
    const revisions = [...keys].map((key) => ({ key, revision: this.nextRevision(collection, key) }));
    this.immediateTransaction(() => {
      this.clearStatement.run(collection);
      for (const entry of revisions) {
        this.setRevisionStatement.run(collection, entry.key, entry.revision);
      }
    });
    for (const address of this.volatileRows.keys()) {
      if (address.startsWith(prefix)) this.volatileRows.delete(address);
    }
  }

  readBatch(addresses: readonly StorageAddress[]): StorageVersionedEntry[] {
    if (!Array.isArray(addresses) || addresses.length > MAX_BATCH_ADDRESSES) {
      throw new TypeError('Invalid storage batch size');
    }
    return addresses.map((address) => {
      validateAddress(address.collection, address.key);
      const value = this.get<unknown>(address.collection, address.key);
      const revision = this.revision(address.collection, address.key);
      return {
        collection: address.collection,
        key: address.key,
        revision,
        exists: value !== undefined,
        ...(value !== undefined ? { value } : {}),
      };
    });
  }

  commitBatch(request: StorageBatchCommit): StorageBatchCommitResult {
    validateBatch(request);
    const prepared = request.mutations.map((mutation) => {
      if (mutation.operation === 'delete') return mutation;
      const encoded = this.encodeValue(mutation.collection, mutation.value);
      if (encoded.persistent === false) {
        throw new Error('Atomic storage batches require durable values');
      }
      return { ...mutation, encoded };
    });
    let committed = false;
    this.immediateTransaction(() => {
      for (const condition of request.ifRevisions) {
        if (this.revision(condition.collection, condition.key) !== condition.revision) return;
      }
      const revisionByAddress = new Map(
        request.ifRevisions.map((condition) => [addressId(condition), condition.revision]),
      );
      for (const mutation of prepared) {
        const revision = revisionByAddress.get(addressId(mutation))!;
        if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Storage revision exhausted');
        if (mutation.operation === 'set') {
          this.setStatement.run(
            mutation.collection,
            mutation.key,
            mutation.encoded.payload,
            mutation.encoded.encoding,
            Date.now(),
          );
        } else {
          this.deleteStatement.run(mutation.collection, mutation.key);
        }
        this.setRevisionStatement.run(mutation.collection, mutation.key, revision + 1);
      }
      committed = true;
    });
    if (committed) {
      for (const mutation of request.mutations) {
        this.volatileRows.delete(`${mutation.collection}\0${mutation.key}`);
      }
    }
    return { committed };
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    if (!this.db.isOpen) return;
    this.volatileRows.clear();
    this.checkpoint();
    this.db.close();
  }

  private encodeValue(collection: string, value: unknown): ReturnType<StorageCodec['encode']> {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('Storage value must be JSON serializable');
    if (Buffer.byteLength(json) > MAX_VALUE_BYTES) {
      throw new Error('Storage value exceeds the 16 MiB safety limit');
    }
    return this.codec.encode(collection, json);
  }

  private revision(collection: string, key: string): number {
    const row = this.getRevisionStatement.get(collection, key) as { revision: number } | undefined;
    if (!row) return 0;
    if (!validRevision(row.revision)) throw new Error('SQLite storage revision is corrupt');
    return row.revision;
  }

  private nextRevision(collection: string, key: string): number {
    const revision = this.revision(collection, key);
    if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Storage revision exhausted');
    return revision + 1;
  }

  private immediateTransaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      operation();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the first failure. Structural recovery runs on next open.
      }
      throw error;
    }
  }

  private quarantineRecord(
    collection: string,
    key: string,
    row: { payload: Uint8Array; encoding: string },
    error: unknown,
  ): void {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
    this.immediateTransaction(() => {
      this.quarantineStatement.run(
        collection,
        key,
        row.payload,
        row.encoding,
        Date.now(),
        reason,
      );
      this.deleteStatement.run(collection, key);
      this.setRevisionStatement.run(collection, key, this.nextRevision(collection, key));
    });
  }
}

function isDatabaseCorruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /integrity check failed|database disk image is malformed|file is not a database|database corruption/i.test(message);
}

function quarantineDatabaseFiles(filePath: string, now: Date): string[] {
  const recoveryDirectory = resolve(dirname(filePath), 'recovery');
  mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 17);
  const targetBase = resolve(
    recoveryDirectory,
    `${basename(filePath)}.corrupt-${stamp}-${process.pid}`,
  );
  const moved: string[] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${filePath}${suffix}`;
    if (!existsSync(source)) continue;
    const destination = `${targetBase}${suffix}`;
    renameSync(source, destination);
    try {
      chmodSync(destination, 0o600);
    } catch {
      // Windows ACLs protect the private userData directory instead.
    }
    moved.push(destination);
  }
  return moved;
}

/**
 * Opens the durable store, preserving a structurally damaged database and its
 * WAL sidecars before atomically starting with a fresh primary file.
 */
export function openSqliteStorageWithRecovery(
  filePath: string,
  codec: StorageCodec = plainStorageCodec,
  options: SqliteStorageOptions & { now?: Date } = {},
): RecoveredSqliteStorage {
  try {
    return { storage: new SqliteStorage(filePath, codec, options), quarantinedPaths: [] };
  } catch (error) {
    if (!isDatabaseCorruption(error)) throw error;
    const quarantinedPaths = quarantineDatabaseFiles(filePath, options.now ?? new Date());
    try {
      const storage = new SqliteStorage(filePath, codec, options);
      options.onRecovery?.({
        kind: 'database-quarantined',
        error,
        paths: quarantinedPaths,
        message: 'The damaged local database was preserved and a clean database was opened.',
      });
      return { storage, quarantinedPaths, recoveryError: error };
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'Local database recovery failed after preserving the damaged files',
      );
    }
  }
}
