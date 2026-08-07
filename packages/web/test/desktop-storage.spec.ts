import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageChange, StoragePort } from '@qed2/core-logic';
import {
  DESKTOP_STORAGE_MUTATION_LOCK,
  DesktopCoordinatedStorage,
  runStorageMutation,
} from '../src/platform/desktop-storage.js';

function memoryStorage(): StoragePort & {
  emit(change: StorageChange): void;
} {
  const values = new Map<string, unknown>();
  const listeners = new Set<(change: StorageChange) => void>();
  const address = (collection: string, key: string) => `${collection}\0${key}`;
  return {
    async get<T>(collection: string, key: string) {
      return values.get(address(collection, key)) as T | undefined;
    },
    async set(collection, key, value) {
      values.set(address(collection, key), value);
    },
    async delete(collection, key) {
      values.delete(address(collection, key));
    },
    async keys(collection) {
      const prefix = `${collection}\0`;
      return [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    },
    async clear(collection) {
      const prefix = `${collection}\0`;
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    },
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emit(change) {
      for (const listener of listeners) listener(change);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DesktopCoordinatedStorage', () => {
  it('serializes mutations through one origin-wide exclusive Web Lock', async () => {
    let lockTail: Promise<void> = Promise.resolve();
    const requested: string[] = [];
    const locks = {
      request<T>(name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
        requested.push(name);
        const run = lockTail.then(callback, callback);
        lockTail = run.then(() => undefined, () => undefined);
        return run;
      },
    };
    vi.stubGlobal('navigator', { locks });

    const storage = new DesktopCoordinatedStorage(memoryStorage());
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = storage.runExclusiveMutation(async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
    });
    const second = storage.runExclusiveMutation(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(requested).toEqual([
      DESKTOP_STORAGE_MUTATION_LOCK,
      DESKTOP_STORAGE_MUTATION_LOCK,
    ]);
  });

  it('delegates external change subscriptions without writing back', () => {
    const delegate = memoryStorage();
    const storage = new DesktopCoordinatedStorage(delegate);
    const received: StorageChange[] = [];
    const unsubscribe = storage.onChange((change) => received.push(change));

    delegate.emit({ collection: 'archive', key: 'current', operation: 'set' });
    unsubscribe();
    delegate.emit({ collection: 'archive', operation: 'clear' });

    expect(received).toEqual([{ collection: 'archive', key: 'current', operation: 'set' }]);
  });

  it('leaves ordinary Web/PWA storage mutations uncoordinated', async () => {
    const raw = memoryStorage();
    const lockRequest = vi.fn();
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });

    await runStorageMutation(raw, async () => raw.set('app', 'key', 'value'));

    expect(await raw.get('app', 'key')).toBe('value');
    expect(lockRequest).not.toHaveBeenCalled();
  });

  it('fails closed when a desktop runtime unexpectedly lacks Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const storage = new DesktopCoordinatedStorage(memoryStorage());
    const mutation = vi.fn(async () => undefined);

    await expect(storage.runExclusiveMutation(mutation)).rejects.toThrow(
      'mutation was not attempted',
    );
    expect(mutation).not.toHaveBeenCalled();
  });
});
