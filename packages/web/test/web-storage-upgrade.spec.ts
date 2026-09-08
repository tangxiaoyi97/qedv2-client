import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LearningEventStore,
  STORAGE,
  learningEventStorageKey,
  userLocalProfileId,
  type LearningEvent,
} from '@qed2/core-logic';
import { WebStorage } from '../src/platform/web-storage.js';

const DB_NAME = 'qed2';
const META_STORE = '__qed2_storage_revisions__';
const LEGACY_STORES = ['archive', 'auth', 'config', 'questions', 'history', 'app', 'ai-cache'] as const;
const profile = userLocalProfileId('upgrade-learner');
const learningAddress = { collection: STORAGE.learning, key: learningEventStorageKey(profile) };
const firstEvent: LearningEvent = {
  version: 1,
  partId: 'question-1-a',
  outcome: 'incorrect',
  hintLevel: 2,
  contentId: 'a'.repeat(40),
  at: '2026-09-08T08:00:00.000Z',
};
const historicalEvent: LearningEvent = { ...firstEvent, correctionOutcome: 'correct' };
const legacyEntries = [
  {
    collection: STORAGE.archive,
    key: 'current',
    value: { content: { perPart: [['question-1-a', { score: 1 }]], perCompetency: [] }, baseVersion: 17 },
    revision: 7,
  },
  {
    collection: STORAGE.history,
    key: 'practice-history',
    value: [{ id: 'attempt-before-upgrade', partId: 'question-1-a', answer: 'saved answer' }],
    revision: 11,
  },
  { collection: STORAGE.auth, key: 'session', value: { token: 'preserved-token', userId: 'learner' }, revision: 3 },
  { collection: STORAGE.config, key: 'theme', value: { mode: 'dark', locale: 'zh-CN' }, revision: 5 },
  { collection: STORAGE.app, key: 'last-session', value: { profileId: profile, partIds: ['question-1-a'] }, revision: 13 },
  { collection: STORAGE.aiCache, key: 'paid-answer', value: { answer: 'previously paid response' }, revision: 19 },
  { collection: STORAGE.questions, key: 'question-1', value: { id: 'question-1', parts: [{ id: 'question-1-a' }] }, revision: 23 },
];
const tombstones = [
  { collection: STORAGE.archive, key: 'deleted-archive', revision: 29 },
  { collection: STORAGE.history, key: 'deleted-history', revision: 31 },
];

let factory: IDBFactory;
let openDirectly: IDBFactory['open'];
let connections: Set<IDBDatabase>;
let requests: IDBOpenDBRequest[];

function trackRequest(request: IDBOpenDBRequest): IDBOpenDBRequest {
  requests.push(request);
  request.addEventListener('success', () => connections.add(request.result));
  return request;
}

beforeEach(() => {
  // Each case owns its database factory and every connection, including
  // connections opened internally by WebStorage. Never delete the shared DB.
  factory = new IDBFactory();
  connections = new Set();
  requests = [];
  openDirectly = factory.open.bind(factory);
  vi.spyOn(factory, 'open').mockImplementation((name, version) =>
    trackRequest(openDirectly(name, version)));
  vi.stubGlobal('indexedDB', factory);
  // Cross-tab notification transports are unrelated to schema migration.
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('localStorage', undefined);
  vi.spyOn(globalThis, 'addEventListener').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const connection of connections) connection.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
  });
}

function opened(request: IDBOpenDBRequest): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
}

async function seedLegacy(includeLearning = false): Promise<IDBDatabase> {
  const request = factory.open(DB_NAME, 3);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const name of LEGACY_STORES) db.createObjectStore(name);
    db.createObjectStore(META_STORE);
    if (includeLearning) db.createObjectStore(STORAGE.learning);
  };
  const db = await opened(request);
  const transaction = db.transaction(Array.from(db.objectStoreNames), 'readwrite');
  const done = completed(transaction);
  const revisions = transaction.objectStore(META_STORE);
  for (const { collection, key, value, revision } of legacyEntries) {
    transaction.objectStore(collection).put(value, key);
    revisions.put(revision, [collection, key]);
  }
  for (const { collection, key, revision } of tombstones) {
    revisions.put(revision, [collection, key]);
  }
  if (includeLearning) {
    transaction.objectStore(STORAGE.learning).put({
      version: 1,
      rows: [{ eventId: 'existing-attempt', event: historicalEvent }],
    }, learningAddress.key);
    revisions.put(37, [learningAddress.collection, learningAddress.key]);
  }
  await done;
  return db;
}

type DatabaseSnapshot = Record<string, Array<{ key: IDBValidKey; value: unknown }>>;

async function snapshot(db: IDBDatabase): Promise<DatabaseSnapshot> {
  const names = Array.from(db.objectStoreNames);
  const transaction = db.transaction(names, 'readonly');
  const done = completed(transaction);
  const result: DatabaseSnapshot = {};
  for (const name of names) {
    const store = transaction.objectStore(name);
    const keys = store.getAllKeys();
    const values = store.getAll();
    values.onsuccess = () => {
      result[name] = keys.result.map((key, index) => ({ key, value: values.result[index] }));
    };
  }
  await done;
  return result;
}

function withoutLearning(data: DatabaseSnapshot): DatabaseSnapshot {
  const { [STORAGE.learning]: _learning, ...preserved } = data;
  preserved[META_STORE] = preserved[META_STORE]!.filter(({ key }) =>
    !Array.isArray(key) || key[0] !== STORAGE.learning);
  return preserved;
}

async function expectPreserved(storage: WebStorage, before: DatabaseSnapshot): Promise<IDBDatabase> {
  const preservedEntries = await storage.readBatch([...legacyEntries, ...tombstones]);
  const db = await opened(factory.open(DB_NAME));
  expect(db.version).toBe(4);
  expect(Array.from(db.objectStoreNames).sort()).toEqual([...Object.values(STORAGE), META_STORE].sort());
  expect(withoutLearning(await snapshot(db))).toEqual(withoutLearning(before));
  expect(preservedEntries).toEqual([
    ...legacyEntries.map((entry) => ({ ...entry, exists: true })),
    ...tombstones.map((entry) => ({ ...entry, exists: false })),
  ]);
  return db;
}

describe('WebStorage schema upgrades', () => {
  it('adds learning to an exact legacy v3 database without rewriting any data or CAS/tombstone revisions', async () => {
    const legacy = await seedLegacy();
    expect(Array.from(legacy.objectStoreNames).sort()).toEqual([...LEGACY_STORES, META_STORE].sort());
    const before = await snapshot(legacy);
    legacy.close();
    const deleteDatabase = vi.spyOn(factory, 'deleteDatabase');
    const storage = new WebStorage();
    const learning = new LearningEventStore(storage);

    await expect(learning.recordFirst(profile, 'new-attempt', firstEvent)).resolves.toBeUndefined();
    await expect(learning.recordDiagnosis(profile, 'new-attempt', 'algebra')).resolves.toEqual({
      ...firstEvent,
      errorCode: 'algebra',
    });

    await expectPreserved(storage, before);
    expect(await storage.readBatch([learningAddress])).toEqual([{
      ...learningAddress,
      revision: 2,
      exists: true,
      value: { version: 1, rows: [{ eventId: 'new-attempt', event: { ...firstEvent, errorCode: 'algebra' } }] },
    }]);
    const reloadedLearning = new LearningEventStore(new WebStorage());
    expect(await reloadedLearning.recommendEvents(profile)).toEqual([{
      partId: firstEvent.partId,
      outcome: 'incorrect',
      hintLevel: 2,
      contentId: firstEvent.contentId,
      at: firstEvent.at,
      errorCode: 'algebra',
    }]);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  it('closes an old v3 WebStorage connection on versionchange so another window can upgrade safely', async () => {
    const seeded = await seedLegacy();
    const before = await snapshot(seeded);
    seeded.close();
    // The old release used the same connection lifecycle but opened version 3.
    vi.mocked(factory.open).mockImplementationOnce((name) => trackRequest(openDirectly(name, 3)));
    const oldWindow = new WebStorage();
    expect(await oldWindow.get(STORAGE.auth, 'session')).toEqual(legacyEntries[2]!.value);
    const oldConnection = requests.at(-1)!.result;
    const close = vi.spyOn(oldConnection, 'close');
    const changed = vi.fn();
    oldConnection.addEventListener('versionchange', changed);

    const newWindow = new WebStorage();
    await new LearningEventStore(newWindow).recordFirst(profile, 'new-attempt', firstEvent);

    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0]![0]).toMatchObject({ oldVersion: 3, newVersion: 4 });
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => oldConnection.transaction(STORAGE.auth)).toThrow();
    await expectPreserved(newWindow, before);
    expect(await oldWindow.get(STORAGE.auth, 'session')).toEqual(legacyEntries[2]!.value);
  });

  it('rejects a blocked upgrade without deleting data and retries after the blocking window closes', async () => {
    const blocker = await seedLegacy();
    const before = await snapshot(blocker);
    const deleteDatabase = vi.spyOn(factory, 'deleteDatabase');
    const storage = new WebStorage();
    const learning = new LearningEventStore(storage);

    await expect(learning.recordFirst(profile, 'new-attempt', firstEvent))
      .rejects.toThrow('IndexedDB upgrade is blocked');
    expect(blocker.version).toBe(3);
    expect(await snapshot(blocker)).toEqual(before);
    expect(deleteDatabase).not.toHaveBeenCalled();
    const pendingUpgrade = opened(requests.at(-1)!);
    blocker.close();
    const abandonedConnection = await pendingUpgrade;
    // The request may succeed after its promise rejected; it must not leak a
    // live connection or become the adapter's cached failed open promise.
    expect(() => abandonedConnection.transaction(STORAGE.app)).toThrow();

    await expect(learning.recordFirst(profile, 'new-attempt', firstEvent)).resolves.toBeUndefined();
    await expect(learning.recordDiagnosis(profile, 'new-attempt', 'arithmetic'))
      .resolves.toMatchObject({ errorCode: 'arithmetic' });
    await expectPreserved(storage, before);
    expect((await storage.readBatch([learningAddress]))[0]!.revision).toBe(2);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  it('creates every store on a fresh install and persists first attempts and diagnosis', async () => {
    const storage = new WebStorage();
    const learning = new LearningEventStore(storage);
    await learning.recordFirst(profile, 'fresh-attempt', firstEvent);
    await learning.recordDiagnosis(profile, 'fresh-attempt', 'algebra');

    const db = await opened(factory.open(DB_NAME));
    expect(db.version).toBe(4);
    expect(Array.from(db.objectStoreNames).sort()).toEqual([...Object.values(STORAGE), META_STORE].sort());
    expect(await new LearningEventStore(new WebStorage()).recommendEvents(profile)).toEqual([
      expect.objectContaining({ partId: firstEvent.partId, errorCode: 'algebra' }),
    ]);
    expect((await storage.readBatch([learningAddress]))[0]!.revision).toBe(2);
  });

  it('preserves historical correction data and its revision when v3 already has the learning store', async () => {
    const legacy = await seedLegacy(true);
    const before = await snapshot(legacy);
    legacy.close();
    const storage = new WebStorage();
    const learning = new LearningEventStore(storage);

    const db = await expectPreserved(storage, before);
    expect(await snapshot(db)).toEqual(before);
    expect(await learning.event(profile, 'existing-attempt')).toEqual(historicalEvent);
    await learning.recordFirst(profile, 'existing-attempt', historicalEvent);
    expect((await storage.readBatch([learningAddress]))[0]!.revision).toBe(37);
    await learning.recordDiagnosis(profile, 'existing-attempt', 'algebra');
    expect(await storage.readBatch([learningAddress])).toEqual([{
      ...learningAddress,
      revision: 38,
      exists: true,
      value: { version: 1, rows: [{ eventId: 'existing-attempt', event: { ...historicalEvent, errorCode: 'algebra' } }] },
    }]);
    await expectPreserved(storage, before);
  });
});
