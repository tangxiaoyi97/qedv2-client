import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openSqliteStorageWithRecovery,
  SqliteStorage,
  type StorageCodec,
} from '../src/main/storage.js';

const VALUE_LIMIT_BYTES = 16 * 1024 * 1024;

let temporaryDirectory = '';
const openStores: SqliteStorage[] = [];

function openStorage(fileName = 'qed2.sqlite'): SqliteStorage {
  const storage = new SqliteStorage(join(temporaryDirectory, fileName));
  openStores.push(storage);
  return storage;
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'qed2-desktop-storage-'));
});

afterEach(async () => {
  for (const storage of openStores.splice(0)) storage.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('SqliteStorage', () => {
  it('persists JSON values across close and reopen', () => {
    const first = openStorage();
    const archive = {
      archiveVersion: 7,
      perPart: [{ partId: '2024-ht-t1-01-a', starred: true }],
      nested: { nullable: null, unicode: 'Übung' },
    };

    first.set('archive', 'guest', archive);
    first.close();

    const reopened = openStorage();
    expect(reopened.get('archive', 'guest')).toEqual(archive);
  });

  it('creates a missing private parent directory on first launch', () => {
    const storage = new SqliteStorage(join(temporaryDirectory, 'state', 'nested', 'qed2.sqlite'));
    openStores.push(storage);

    storage.set('app', 'boot', { completed: true });
    expect(storage.get('app', 'boot')).toEqual({ completed: true });
  });

  it('keeps collections isolated and provides deterministic key operations', () => {
    const storage = openStorage();
    storage.set('archive', 'z-user', { value: 1 });
    storage.set('archive', 'a-user', { value: 2 });
    storage.set('config', 'a-user', { value: 3 });

    expect(storage.keys('archive')).toEqual(['a-user', 'z-user']);
    expect(storage.get('config', 'a-user')).toEqual({ value: 3 });

    storage.delete('archive', 'a-user');
    expect(storage.get('archive', 'a-user')).toBeUndefined();
    expect(storage.get('config', 'a-user')).toEqual({ value: 3 });

    storage.clear('archive');
    expect(storage.keys('archive')).toEqual([]);
    expect(storage.keys('config')).toEqual(['a-user']);
  });

  it('rejects invalid collection names and keys at the storage boundary', () => {
    const storage = openStorage();
    const maximumKey = 'k'.repeat(512);

    expect(() => storage.set('ai-cache', maximumKey, true)).not.toThrow();
    expect(storage.get('ai-cache', maximumKey)).toBe(true);
    expect(() => storage.set('../archive', 'guest', {})).toThrow('Invalid storage collection');
    expect(() => storage.set('Archive', 'guest', {})).toThrow('Invalid storage collection');
    expect(() => storage.set('archive', '', {})).toThrow('Invalid storage key');
    expect(() => storage.set('archive', 'k'.repeat(513), {})).toThrow('Invalid storage key');
  });

  it('rejects non-JSON and oversized values without writing a row', () => {
    const storage = openStorage();

    const exactLimit = 'x'.repeat(VALUE_LIMIT_BYTES - 2); // JSON adds the surrounding quotes.
    expect(() => storage.set('app', 'at-limit', exactLimit)).not.toThrow();
    expect(storage.get<string>('app', 'at-limit')).toHaveLength(exactLimit.length);

    expect(() => storage.set('app', 'undefined', undefined)).toThrow(
      'Storage value must be JSON serializable',
    );
    expect(() => storage.set('app', 'too-large', 'x'.repeat(VALUE_LIMIT_BYTES - 1))).toThrow(
      'Storage value exceeds the 16 MiB safety limit',
    );
    expect(storage.get('app', 'undefined')).toBeUndefined();
    expect(storage.get('app', 'too-large')).toBeUndefined();
  });

  it('can checkpoint and close more than once safely', () => {
    const storage = openStorage();
    storage.set('app', 'state', { route: '/practice' });

    expect(() => storage.checkpoint()).not.toThrow();
    expect(() => storage.close()).not.toThrow();
    expect(() => storage.close()).not.toThrow();
  });

  it('preserves a structurally corrupt database and starts with a clean store', async () => {
    const file = join(temporaryDirectory, 'qed2.sqlite');
    await writeFile(file, 'this is not sqlite', 'utf8');

    const recovered = openSqliteStorageWithRecovery(file, undefined, {
      now: new Date('2026-08-07T01:02:03.004Z'),
    });
    openStores.push(recovered.storage);

    expect(recovered.quarantinedPaths).toHaveLength(1);
    expect(await readFile(recovered.quarantinedPaths[0]!, 'utf8')).toBe('this is not sqlite');
    recovered.storage.set('app', 'boot', { recovered: true });
    expect(recovered.storage.get('app', 'boot')).toEqual({ recovered: true });
  });

  it('isolates an undecodable row while preserving its bytes for diagnosis', () => {
    const codec: StorageCodec = {
      encode: (_collection, json) => ({ payload: Buffer.from(json), encoding: 'test' }),
      decode: () => {
        throw new Error('simulated decode failure');
      },
    };
    const file = join(temporaryDirectory, 'qed2.sqlite');
    const storage = new SqliteStorage(file, codec);
    openStores.push(storage);
    storage.set('auth', 'session', { token: 'preserved' });

    expect(storage.get('auth', 'session')).toBeUndefined();
    expect(storage.keys('auth')).toEqual([]);
    storage.close();

    const raw = new DatabaseSync(file, { readOnly: true });
    const row = raw.prepare('SELECT payload, reason FROM quarantined_kv').get() as {
      payload: Uint8Array;
      reason: string;
    };
    expect(Buffer.from(row.payload).toString('utf8')).toContain('preserved');
    expect(row.reason).toContain('simulated decode failure');
    raw.close();
  });

  it('keeps non-persistent codec values in memory only', () => {
    const volatileCodec: StorageCodec = {
      encode: (_collection, json) => ({
        payload: Buffer.from(json),
        encoding: 'volatile',
        persistent: false,
      }),
      decode: (_collection, payload) => Buffer.from(payload).toString('utf8'),
    };
    const file = join(temporaryDirectory, 'qed2.sqlite');
    const storage = new SqliteStorage(file, volatileCodec);
    openStores.push(storage);
    storage.set('auth', 'session', { token: 'memory-only' });
    expect(storage.get('auth', 'session')).toEqual({ token: 'memory-only' });
    storage.close();

    const reopened = openStorage();
    expect(reopened.get('auth', 'session')).toBeUndefined();
  });

  it('retains monotonic revisions across overwrite and deletion', () => {
    const storage = openStorage();
    const address = { collection: 'app', key: 'revision-lifecycle' };
    expect(storage.readBatch([address])).toEqual([{ ...address, revision: 0, exists: false }]);

    storage.set(address.collection, address.key, { value: 1 });
    storage.set(address.collection, address.key, { value: 2 });
    storage.delete(address.collection, address.key);

    expect(storage.readBatch([address])).toEqual([{ ...address, revision: 3, exists: false }]);
  });

  it('atomically commits across collections and rejects a stale second connection', () => {
    const first = openStorage('shared.sqlite');
    const second = openStorage('shared.sqlite');
    const archive = { collection: 'archive', key: 'current' };
    const history = { collection: 'history', key: 'log' };
    const snapshots = first.readBatch([archive, history]);
    const stale = second.readBatch([archive, history]);

    expect(first.commitBatch({
      ifRevisions: snapshots.map(({ collection, key, revision }) => ({ collection, key, revision })),
      mutations: [
        { ...archive, operation: 'set', value: { answer: 'first' } },
        { ...history, operation: 'set', value: [{ id: 'first' }] },
      ],
    })).toEqual({ committed: true });
    expect(second.commitBatch({
      ifRevisions: stale.map(({ collection, key, revision }) => ({ collection, key, revision })),
      mutations: [
        { ...archive, operation: 'set', value: { answer: 'stale' } },
        { ...history, operation: 'set', value: [{ id: 'stale' }] },
      ],
    })).toEqual({ committed: false });
    expect(second.get('archive', 'current')).toEqual({ answer: 'first' });
    expect(second.get('history', 'log')).toEqual([{ id: 'first' }]);
  });

  it('rolls back every value and revision when SQLite rejects one batch mutation', () => {
    const file = join(temporaryDirectory, 'rollback.sqlite');
    const storage = new SqliteStorage(file);
    openStores.push(storage);
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TRIGGER reject_simulated_disk_failure
      BEFORE INSERT ON kv
      WHEN NEW.collection = 'app' AND NEW.key = 'fail'
      BEGIN
        SELECT RAISE(ABORT, 'simulated disk failure');
      END;
    `);
    raw.close();
    const archive = { collection: 'archive', key: 'rollback' };
    const session = { collection: 'app', key: 'fail' };
    const snapshots = storage.readBatch([archive, session]);

    expect(() => storage.commitBatch({
      ifRevisions: snapshots.map(({ collection, key, revision }) => ({ collection, key, revision })),
      mutations: [
        { ...archive, operation: 'set', value: { mustRollback: true } },
        { ...session, operation: 'set', value: { mustFail: true } },
      ],
    })).toThrow('simulated disk failure');
    expect(storage.readBatch([archive, session])).toEqual([
      { ...archive, revision: 0, exists: false },
      { ...session, revision: 0, exists: false },
    ]);
  });
});
