import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORAGE } from '@qed2/core-logic';
import { WebStorage } from '../src/platform/web-storage.js';

class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();
  static readonly messages: unknown[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(private readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(value: unknown): void {
    const cloned = structuredClone(value);
    FakeBroadcastChannel.messages.push(cloned);
    for (const peer of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer === this) continue;
      queueMicrotask(() => peer.onmessage?.({ data: structuredClone(cloned) } as MessageEvent));
    }
  }

  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeBroadcastChannel.channels.clear();
  FakeBroadcastChannel.messages.length = 0;
});

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

  it('broadcasts only committed addresses to other tabs and never values', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const writer = new WebStorage();
    const peer = new WebStorage();
    const writerChanges: unknown[] = [];
    const peerChanges: unknown[] = [];
    writer.onChange((change) => writerChanges.push(change));
    peer.onChange((change) => peerChanges.push(change));

    await writer.set(STORAGE.auth, 'broadcast-session', {
      token: 'must-never-leave-indexeddb',
    });
    await Promise.resolve();

    expect(writerChanges).toEqual([]);
    expect(peerChanges).toEqual([{
      collection: STORAGE.auth,
      key: 'broadcast-session',
      operation: 'set',
      revision: 1,
    }]);
    expect(JSON.stringify(FakeBroadcastChannel.messages)).not.toContain('must-never-leave-indexeddb');
    expect(JSON.stringify(FakeBroadcastChannel.messages)).not.toContain('token');
  });

  it('falls back to a metadata-only storage event when BroadcastChannel is unavailable', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const signal = vi.spyOn(Storage.prototype, 'setItem');
    const writer = new WebStorage();
    const peer = new WebStorage();
    const peerChanges: unknown[] = [];
    peer.onChange((change) => peerChanges.push(change));

    await writer.set(STORAGE.auth, 'fallback-session', {
      token: 'must-stay-in-indexeddb',
    });
    const call = signal.mock.calls.find(([key]) => key === '__qed2_storage_signal_v1__');
    expect(call).toBeDefined();
    const payload = String(call?.[1]);
    expect(payload).not.toContain('must-stay-in-indexeddb');
    expect(payload).not.toContain('token');
    globalThis.dispatchEvent(new StorageEvent('storage', {
      key: '__qed2_storage_signal_v1__',
      newValue: payload,
    }));

    expect(peerChanges).toEqual([expect.objectContaining({
      collection: STORAGE.auth,
      key: 'fallback-session',
      operation: 'set',
    })]);
  });

  it('does not broadcast an aborted or conflicted transaction', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const writer = new WebStorage();
    const peer = new WebStorage();
    const peerChanges: unknown[] = [];
    peer.onChange((change) => peerChanges.push(change));
    const address = { collection: STORAGE.app, key: 'broadcast-conflict' };
    const [snapshot] = await writer.readBatch([address]);
    await writer.set(address.collection, address.key, { current: true });
    await Promise.resolve();
    peerChanges.length = 0;
    FakeBroadcastChannel.messages.length = 0;

    await expect(writer.commitBatch({
      ifRevisions: [{ ...address, revision: snapshot!.revision }],
      mutations: [{ ...address, operation: 'set', value: { stale: true } }],
    })).resolves.toEqual({ committed: false });
    await Promise.resolve();

    expect(peerChanges).toEqual([]);
    expect(FakeBroadcastChannel.messages).toEqual([]);
  });
});
