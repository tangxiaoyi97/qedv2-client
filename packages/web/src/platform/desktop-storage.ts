/**
 * Desktop-only storage coordination.
 *
 * Every QED2 renderer is served from the same loopback origin, so Chromium's
 * Web Locks API gives all main/practice windows one crash-safe FIFO mutex.
 * The lock is deliberately added in the Web composition root instead of the
 * Electron preload: business stores keep depending on StoragePort and the
 * normal Web/PWA adapter remains byte-for-byte behaviourally unchanged.
 */
import type { StorageChange, StoragePort } from '@qed2/core-logic';

export const DESKTOP_STORAGE_MUTATION_LOCK = 'qed2:desktop-storage-mutation:v1';

interface OriginLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T>;
}

function originLocks(): OriginLockManager | undefined {
  return (globalThis.navigator as Navigator & { locks?: OriginLockManager } | undefined)?.locks;
}

/**
 * Decorates only an Electron-injected StoragePort. A missing Web Locks API is
 * a hard failure: silently falling back to a per-window queue would re-open
 * the last-write-wins corruption this adapter exists to prevent.
 */
export class DesktopCoordinatedStorage implements StoragePort {
  constructor(private readonly delegate: StoragePort) {}

  get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.delegate.get<T>(collection, key);
  }

  set<T>(collection: string, key: string, value: T): Promise<void> {
    return this.delegate.set(collection, key, value);
  }

  delete(collection: string, key: string): Promise<void> {
    return this.delegate.delete(collection, key);
  }

  keys(collection: string): Promise<string[]> {
    return this.delegate.keys(collection);
  }

  clear(collection: string): Promise<void> {
    return this.delegate.clear(collection);
  }

  onChange(callback: (change: StorageChange) => void): () => void {
    return this.delegate.onChange?.(callback) ?? (() => undefined);
  }

  runExclusiveMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const locks = originLocks();
    if (!locks) {
      return Promise.reject(
        new Error('Desktop storage coordination is unavailable; mutation was not attempted.'),
      );
    }
    return locks.request(DESKTOP_STORAGE_MUTATION_LOCK, { mode: 'exclusive' }, mutation);
  }
}

/** Run a local mutation under the desktop mutex when the shell provides it. */
export function runStorageMutation<T>(storage: StoragePort, mutation: () => Promise<T>): Promise<T> {
  return storage.runExclusiveMutation?.(mutation) ?? mutation();
}
