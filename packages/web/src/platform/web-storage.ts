/**
 * StoragePort adapter: IndexedDB (not localStorage — archives and question
 * caches outgrow it, brief §2). One database, one object store per
 * well-known collection.
 */
import { STORAGE, type StoragePort } from '@qed2/core-logic';

const DB_NAME = 'qed2';
// v2: added the 'history' object store (onupgradeneeded creates any missing
// collection, so bumping the version is all a migration needs).
const DB_VERSION = 2;
const COLLECTIONS = Object.values(STORAGE);

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of COLLECTIONS) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = run(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export class WebStorage implements StoragePort {
  private db: Promise<IDBDatabase> | undefined;

  private ready(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    const db = await this.ready();
    const value = await tx<unknown>(db, collection, 'readonly', (s) => s.get(key));
    return value as T | undefined;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    const db = await this.ready();
    await tx(db, collection, 'readwrite', (s) => s.put(value as unknown as object, key));
  }

  async delete(collection: string, key: string): Promise<void> {
    const db = await this.ready();
    await tx(db, collection, 'readwrite', (s) => s.delete(key));
  }

  async keys(collection: string): Promise<string[]> {
    const db = await this.ready();
    const ks = await tx<IDBValidKey[]>(db, collection, 'readonly', (s) => s.getAllKeys());
    return ks.map(String);
  }

  async clear(collection: string): Promise<void> {
    const db = await this.ready();
    await tx(db, collection, 'readwrite', (s) => s.clear());
  }
}
