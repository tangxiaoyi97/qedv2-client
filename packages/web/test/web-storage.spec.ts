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
});
