import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const COLLECTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_KEY_LENGTH = 512;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;

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

export class SqliteStorage {
  private readonly db: DatabaseSync;
  private readonly getStatement;
  private readonly setStatement;
  private readonly deleteStatement;
  private readonly keysStatement;
  private readonly clearStatement;
  private readonly quarantineStatement;
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
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('Storage value must be JSON serializable');
    if (Buffer.byteLength(json) > MAX_VALUE_BYTES) throw new Error('Storage value exceeds the 16 MiB safety limit');
    const encoded = this.codec.encode(collection, json);
    const address = `${collection}\0${key}`;
    if (encoded.persistent === false) {
      this.deleteStatement.run(collection, key);
      this.volatileRows.set(address, { payload: encoded.payload, encoding: encoded.encoding });
      return;
    }
    this.volatileRows.delete(address);
    this.setStatement.run(collection, key, encoded.payload, encoded.encoding, Date.now());
  }

  delete(collection: string, key: string): void {
    validateAddress(collection, key);
    this.volatileRows.delete(`${collection}\0${key}`);
    this.deleteStatement.run(collection, key);
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
    for (const address of this.volatileRows.keys()) {
      if (address.startsWith(prefix)) this.volatileRows.delete(address);
    }
    this.clearStatement.run(collection);
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

  private quarantineRecord(
    collection: string,
    key: string,
    row: { payload: Uint8Array; encoding: string },
    error: unknown,
  ): void {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.quarantineStatement.run(
        collection,
        key,
        row.payload,
        row.encoding,
        Date.now(),
        reason,
      );
      this.deleteStatement.run(collection, key);
      this.db.exec('COMMIT');
    } catch (quarantineError) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the first quarantine failure; the DB recovery factory will
        // handle structural errors on the next start.
      }
      throw new AggregateError([error, quarantineError], 'Damaged record could not be quarantined');
    }
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
