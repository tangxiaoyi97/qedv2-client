import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { STORAGE } from '@qed2/core-logic';
import { WebStorage } from '../src/platform/web-storage.js';

describe('WebStorage (IndexedDB StoragePort adapter)', () => {
  // One shared instance — deleteDatabase would deadlock on the open
  // connection; tests stay independent through distinct keys instead.
  const storage = new WebStorage();

  it('round-trips primitives and objects', async () => {
    await storage.set(STORAGE.app, 'k1', 'value');
    await storage.set(STORAGE.app, 'k2', { nested: { deep: [1, 2, 3] }, flag: true });
    expect(await storage.get(STORAGE.app, 'k1')).toBe('value');
    expect(await storage.get(STORAGE.app, 'k2')).toEqual({ nested: { deep: [1, 2, 3] }, flag: true });
  });

  it('returns undefined for missing keys', async () => {
    expect(await storage.get(STORAGE.app, 'nope')).toBeUndefined();
  });

  it('overwrites on set', async () => {
    await storage.set(STORAGE.config, 'k', 1);
    await storage.set(STORAGE.config, 'k', 2);
    expect(await storage.get(STORAGE.config, 'k')).toBe(2);
  });

  it('deletes keys', async () => {
    await storage.set(STORAGE.auth, 'session', { token: 't' });
    await storage.delete(STORAGE.auth, 'session');
    expect(await storage.get(STORAGE.auth, 'session')).toBeUndefined();
  });

  it('lists keys per collection', async () => {
    await storage.set(STORAGE.questions, 'q1', {});
    await storage.set(STORAGE.questions, 'q2', {});
    expect((await storage.keys(STORAGE.questions)).sort()).toEqual(['q1', 'q2']);
  });

  it('isolates collections (clearing auth must not touch the archive)', async () => {
    await storage.set(STORAGE.archive, 'current', { content: { perPart: [], perCompetency: [] }, baseVersion: 3 });
    await storage.set(STORAGE.auth, 'session', { token: 't' });
    await storage.clear(STORAGE.auth);
    expect(await storage.get(STORAGE.auth, 'session')).toBeUndefined();
    expect(await storage.get(STORAGE.archive, 'current')).toEqual({
      content: { perPart: [], perCompetency: [] },
      baseVersion: 3,
    });
  });

  it('retains monotonic revisions across overwrite and deletion', async () => {
    const address = { collection: STORAGE.app, key: 'revision-lifecycle' };
    expect(await storage.readBatch([address])).toEqual([
      { ...address, revision: 0, exists: false },
    ]);

    await storage.set(address.collection, address.key, { value: 1 });
    expect(await storage.readBatch([address])).toEqual([
      { ...address, revision: 1, exists: true, value: { value: 1 } },
    ]);
    await storage.set(address.collection, address.key, { value: 2 });
    await storage.delete(address.collection, address.key);
    expect(await storage.readBatch([address])).toEqual([
      { ...address, revision: 3, exists: false },
    ]);
  });

  it('atomically commits across object stores and rejects a stale second window', async () => {
    const peer = new WebStorage();
    const archive = { collection: STORAGE.archive, key: 'cas-window' };
    const history = { collection: STORAGE.history, key: 'cas-window' };
    const [archiveSnapshot, historySnapshot] = await storage.readBatch([archive, history]);
    const stale = await peer.readBatch([archive, history]);
    const first = {
      ifRevisions: [
        { ...archive, revision: archiveSnapshot!.revision },
        { ...history, revision: historySnapshot!.revision },
      ],
      mutations: [
        { ...archive, operation: 'set' as const, value: { answer: 'first' } },
        { ...history, operation: 'set' as const, value: [{ id: 'first' }] },
      ],
    };

    await expect(storage.commitBatch(first)).resolves.toEqual({ committed: true });
    await expect(peer.commitBatch({
      ifRevisions: stale.map(({ collection, key, revision }) => ({ collection, key, revision })),
      mutations: [
        { ...archive, operation: 'set', value: { answer: 'stale' } },
        { ...history, operation: 'set', value: [{ id: 'stale' }] },
      ],
    })).resolves.toEqual({ committed: false });
    expect((await storage.readBatch([archive, history])).map((entry) => entry.value)).toEqual([
      { answer: 'first' },
      [{ id: 'first' }],
    ]);
  });

  it('aborts the whole IndexedDB batch when one value cannot be cloned', async () => {
    const archive = { collection: STORAGE.archive, key: 'abort-batch' };
    const session = { collection: STORAGE.app, key: 'abort-batch' };
    const snapshots = await storage.readBatch([archive, session]);

    await expect(storage.commitBatch({
      ifRevisions: snapshots.map(({ collection, key, revision }) => ({ collection, key, revision })),
      mutations: [
        { ...archive, operation: 'set', value: { safe: true } },
        { ...session, operation: 'set', value: { notCloneable: () => undefined } },
      ],
    })).rejects.toThrow();
    expect((await storage.readBatch([archive, session])).map((entry) => entry.exists)).toEqual([
      false,
      false,
    ]);
  });
});
