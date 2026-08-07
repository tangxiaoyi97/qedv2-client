/**
 * StoragePort adapter: IndexedDB (not localStorage — archives and question
 * caches outgrow it).  Version 3 adds a private revision store used for
 * cross-tab compare-and-swap transactions.  Values keep their existing shape;
 * metadata is separate so upgrades do not rewrite user data.
 */
import {
  STORAGE,
  type StorageAddress,
  type StorageBatchCommit,
  type StorageBatchCommitResult,
  type StoragePort,
  type StorageVersionedEntry,
} from '@qed2/core-logic';

const DB_NAME = 'qed2';
const DB_VERSION = 3;
const META_STORE = '__qed2_storage_revisions__';
const COLLECTIONS = Object.values(STORAGE);
const COLLECTION_SET = new Set<string>(COLLECTIONS);
const MAX_KEY_LENGTH = 512;
const MAX_BATCH_ADDRESSES = 32;

type RevisionKey = [collection: string, key: string];

function revisionKey(address: StorageAddress): RevisionKey {
  return [address.collection, address.key];
}

function validateAddress(address: StorageAddress): void {
  if (!COLLECTION_SET.has(address.collection)) throw new TypeError('Invalid storage collection');
  if (
    typeof address.key !== 'string'
    || address.key.length === 0
    || address.key.length > MAX_KEY_LENGTH
    || address.key.includes('\0')
  ) {
    throw new TypeError('Invalid storage key');
  }
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function currentRevision(value: unknown): number {
  if (value === undefined) return 0;
  if (!validRevision(value)) throw new Error('IndexedDB storage revision is corrupt');
  return value;
}

function addressId(address: StorageAddress): string {
  return `${address.collection}\0${address.key}`;
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
    validateAddress(condition);
    if (!validRevision(condition.revision)) throw new TypeError('Invalid storage revision');
    const id = addressId(condition);
    if (preconditions.has(id)) throw new TypeError('Duplicate storage precondition');
    preconditions.add(id);
  }
  const mutations = new Set<string>();
  for (const mutation of request.mutations) {
    validateAddress(mutation);
    if (mutation.operation !== 'set' && mutation.operation !== 'delete') {
      throw new TypeError('Invalid storage batch operation');
    }
    if (mutation.operation === 'set' && mutation.value === undefined) {
      throw new TypeError('Storage value must be defined');
    }
    const id = addressId(mutation);
    if (!preconditions.has(id)) throw new TypeError('Storage mutation is missing a revision precondition');
    if (mutations.has(id)) throw new TypeError('Duplicate storage mutation');
    mutations.add(id);
  }
}

function transactionFailure(transaction: IDBTransaction, fallback: string): Error {
  return transaction.error ?? new Error(fallback);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of COLLECTIONS) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error('IndexedDB upgrade is blocked by another QED2 window; reload the other window'));
    };
  });
}

export class WebStorage implements StoragePort {
  private db: Promise<IDBDatabase> | undefined;

  private ready(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    validateAddress({ collection, key });
    const db = await this.ready();
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = db.transaction(collection, 'readonly');
      const request = transaction.objectStore(collection).get(key);
      let value: T | undefined;
      request.onsuccess = () => {
        value = request.result as T | undefined;
      };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transactionFailure(transaction, 'IndexedDB read failed'));
      transaction.onabort = () => reject(transactionFailure(transaction, 'IndexedDB read aborted'));
    });
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    validateAddress({ collection, key });
    if (value === undefined) throw new TypeError('Storage value must be defined');
    const db = await this.ready();
    await this.mutateOne(db, collection, key, { operation: 'set', value });
  }

  async delete(collection: string, key: string): Promise<void> {
    validateAddress({ collection, key });
    const db = await this.ready();
    await this.mutateOne(db, collection, key, { operation: 'delete' });
  }

  async keys(collection: string): Promise<string[]> {
    if (!COLLECTION_SET.has(collection)) throw new TypeError('Invalid storage collection');
    const db = await this.ready();
    return await new Promise<string[]>((resolve, reject) => {
      const transaction = db.transaction(collection, 'readonly');
      const request = transaction.objectStore(collection).getAllKeys();
      let keys: string[] = [];
      request.onsuccess = () => {
        keys = request.result.map(String);
      };
      transaction.oncomplete = () => resolve(keys);
      transaction.onerror = () => reject(transactionFailure(transaction, 'IndexedDB key read failed'));
      transaction.onabort = () => reject(transactionFailure(transaction, 'IndexedDB key read aborted'));
    });
  }

  async clear(collection: string): Promise<void> {
    if (!COLLECTION_SET.has(collection)) throw new TypeError('Invalid storage collection');
    const db = await this.ready();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([collection, META_STORE], 'readwrite');
      const store = transaction.objectStore(collection);
      const revisions = transaction.objectStore(META_STORE);
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const rawKey of keys.result) {
          const key = String(rawKey);
          const getRevision = revisions.get([collection, key] satisfies RevisionKey);
          getRevision.onsuccess = () => {
            const revision = currentRevision(getRevision.result);
            if (revision >= Number.MAX_SAFE_INTEGER) {
              transaction.abort();
              return;
            }
            revisions.put(revision + 1, [collection, key] satisfies RevisionKey);
          };
        }
        store.clear();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transactionFailure(transaction, 'IndexedDB clear failed'));
      transaction.onabort = () => reject(transactionFailure(transaction, 'IndexedDB clear aborted'));
    });
  }

  async readBatch(addresses: readonly StorageAddress[]): Promise<StorageVersionedEntry[]> {
    if (!Array.isArray(addresses) || addresses.length > MAX_BATCH_ADDRESSES) {
      throw new TypeError('Invalid storage batch size');
    }
    if (addresses.length === 0) return [];
    for (const address of addresses) validateAddress(address);
    const db = await this.ready();
    const stores = [...new Set([...addresses.map((address) => address.collection), META_STORE])];
    return await new Promise<StorageVersionedEntry[]>((resolve, reject) => {
      const transaction = db.transaction(stores, 'readonly');
      const revisions = transaction.objectStore(META_STORE);
      const values: unknown[] = new Array(addresses.length);
      const versionValues: number[] = new Array(addresses.length);
      addresses.forEach((address, index) => {
        const valueRequest = transaction.objectStore(address.collection).get(address.key);
        valueRequest.onsuccess = () => {
          values[index] = valueRequest.result;
        };
        const revisionRequest = revisions.get(revisionKey(address));
        revisionRequest.onsuccess = () => {
          versionValues[index] = currentRevision(revisionRequest.result);
        };
      });
      transaction.oncomplete = () => resolve(addresses.map((address, index) => {
        const value = values[index];
        return {
          collection: address.collection,
          key: address.key,
          revision: versionValues[index] ?? 0,
          exists: value !== undefined,
          ...(value !== undefined ? { value } : {}),
        };
      }));
      transaction.onerror = () => reject(transactionFailure(transaction, 'IndexedDB batch read failed'));
      transaction.onabort = () => reject(transactionFailure(transaction, 'IndexedDB batch read aborted'));
    });
  }

  async commitBatch(request: StorageBatchCommit): Promise<StorageBatchCommitResult> {
    validateBatch(request);
    const db = await this.ready();
    const stores = [...new Set([
      ...request.ifRevisions.map((condition) => condition.collection),
      ...request.mutations.map((mutation) => mutation.collection),
      META_STORE,
    ])];
    return await new Promise<StorageBatchCommitResult>((resolve, reject) => {
      const transaction = db.transaction(stores, 'readwrite');
      const revisions = transaction.objectStore(META_STORE);
      let pending = request.ifRevisions.length;
      let conflict = false;
      let writesScheduled = false;
      let operationError: unknown;

      const scheduleWrites = (): void => {
        if (writesScheduled || pending !== 0) return;
        writesScheduled = true;
        if (conflict) return;
        const expectedByAddress = new Map(
          request.ifRevisions.map((condition) => [addressId(condition), condition.revision]),
        );
        try {
          for (const mutation of request.mutations) {
            const expected = expectedByAddress.get(addressId(mutation))!;
            if (expected >= Number.MAX_SAFE_INTEGER) throw new Error('Storage revision exhausted');
            const store = transaction.objectStore(mutation.collection);
            if (mutation.operation === 'set') store.put(mutation.value, mutation.key);
            else store.delete(mutation.key);
            revisions.put(expected + 1, revisionKey(mutation));
          }
        } catch (error) {
          operationError = error;
          transaction.abort();
        }
      };

      for (const condition of request.ifRevisions) {
        const revisionRequest = revisions.get(revisionKey(condition));
        revisionRequest.onsuccess = () => {
          try {
            if (currentRevision(revisionRequest.result) !== condition.revision) conflict = true;
          } catch (error) {
            operationError = error;
            transaction.abort();
            return;
          }
          pending -= 1;
          scheduleWrites();
        };
      }

      transaction.oncomplete = () => resolve({ committed: !conflict });
      transaction.onerror = () => reject(transactionFailure(transaction, 'IndexedDB batch commit failed'));
      transaction.onabort = () => reject(
        operationError instanceof Error
          ? operationError
          : transactionFailure(transaction, 'IndexedDB batch commit aborted'),
      );
    });
  }

  private async mutateOne(
    db: IDBDatabase,
    collection: string,
    key: string,
    mutation: { operation: 'set'; value: unknown } | { operation: 'delete' },
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([collection, META_STORE], 'readwrite');
      const revisions = transaction.objectStore(META_STORE);
      const getRevision = revisions.get([collection, key] satisfies RevisionKey);
      getRevision.onsuccess = () => {
        const revision = currentRevision(getRevision.result);
        if (revision >= Number.MAX_SAFE_INTEGER) {
          transaction.abort();
          return;
        }
        const store = transaction.objectStore(collection);
        if (mutation.operation === 'set') store.put(mutation.value, key);
        else store.delete(key);
        revisions.put(revision + 1, [collection, key] satisfies RevisionKey);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transactionFailure(transaction, 'IndexedDB mutation failed'));
      transaction.onabort = () => reject(transactionFailure(transaction, 'IndexedDB mutation aborted'));
    });
  }
}
