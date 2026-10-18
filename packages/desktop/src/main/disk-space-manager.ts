import { lstatSync } from 'node:fs';
import { opendir, statfs } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  DesktopCleanupResult, DesktopCleanupTarget, DesktopStorageOverview,
} from '@qed2/core-logic';
import type { DesktopLogger } from './logger.js';
import {
  isMissingFile, managedDirectory, managedFile, sameFile, UnsafeManagedPathError,
} from './managed-file-safety.js';

type CleanupItem = DesktopCleanupResult['results'][number];
type StorageCategory = DesktopStorageOverview['categories'][number];
type DownloadCleanup = {
  status: 'cleaned' | 'skipped';
  freedBytes: number;
  reason?: 'download-active' | 'unavailable' | 'unsafe-path';
};

export interface DiskSpaceManagerOptions {
  userDataPath: string;
  databaseDirectory: string;
  logger: Pick<DesktopLogger, 'inspectStorage' | 'clearArchivedLogs'>;
  browserCache?: { getSize(): Promise<number>; clear(): Promise<void> };
  downloads?: {
    inspect(): Promise<{ bytes: number | null; cleanableBytes: number | null; blocked: boolean }>;
    /** The updater owns its maintenance lock and rechecks active work atomically. */
    cleanup(): Promise<DownloadCleanup>;
  };
  now?: () => number;
}

function byteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bigintBytes(value: bigint): number | null {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function containsPath(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** Count the local database plus its sidecars/recovery copies without reading contents. */
async function databaseBytes(directory: string): Promise<number> {
  const root = managedDirectory(directory);
  if (!root) return 0;
  let entries = 0;
  let bytes = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error('Local data directory exceeds inspection depth');
    const folder = managedDirectory(path);
    if (!folder) return;
    if (folder.path !== root.path && !containsPath(root.path, folder.path)) throw new UnsafeManagedPathError();
    const handle = await opendir(folder.path);
    for await (const entry of handle) {
      if (++entries > 10_000) throw new Error('Local data directory exceeds inspection limit');
      // A directory entry can be replaced after readdir: decide from lstat,
      // never follow a link or trust the cached Dirent file type.
      const child = join(folder.path, entry.name);
      let info;
      try { info = lstatSync(child); } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      if (info.isSymbolicLink()) throw new UnsafeManagedPathError();
      if (info.isDirectory()) await visit(child, depth + 1);
      else {
        const file = managedFile(folder.path, entry.name);
        bytes += file?.stat.size ?? 0;
        if (!Number.isSafeInteger(bytes)) throw new Error('Local data size exceeds supported precision');
      }
    }
    const after = managedDirectory(path);
    if (!after || after.path !== folder.path || !sameFile(after.stat, folder.stat)) {
      throw new UnsafeManagedPathError();
    }
  };
  await visit(root.path, 0);
  const after = managedDirectory(directory);
  if (!after || after.path !== root.path || !sameFile(after.stat, root.stat)) throw new UnsafeManagedPathError();
  return bytes;
}

function unavailable(id: StorageCategory['id']): StorageCategory {
  return { id, bytes: null, cleanableBytes: id === 'database' ? 0 : null, blockedReason: 'unavailable' };
}

export class DiskSpaceManager {
  private cleanupQueue: Promise<void> = Promise.resolve();
  private overviewInFlight: Promise<DesktopStorageOverview> | undefined;

  constructor(private readonly options: DiskSpaceManagerOptions) {
    if (!containsPath(resolve(options.userDataPath), resolve(options.databaseDirectory))) {
      throw new UnsafeManagedPathError();
    }
  }

  getOverview(): Promise<DesktopStorageOverview> {
    this.overviewInFlight ??= this.measure().finally(() => { this.overviewInFlight = undefined; });
    return this.overviewInFlight;
  }

  cleanup(targets: DesktopCleanupTarget[]): Promise<DesktopCleanupResult> {
    // Validate the whole request before any mutation, including calls that do
    // not originate in IPC. No arbitrary directory or database target exists.
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 3 ||
        targets.some((target) => !['cache', 'downloads', 'logs'].includes(target)) ||
        new Set(targets).size !== targets.length) {
      return Promise.reject(new TypeError('Invalid local storage cleanup targets'));
    }
    const requested = [...targets];
    const result = this.cleanupQueue.then(async () => {
      const results: CleanupItem[] = [];
      for (const target of requested) results.push(await this.cleanupTarget(target));
      // Do not reuse a pre-cleanup in-flight overview for the resulting state.
      return { results, overview: await this.measure() };
    });
    this.cleanupQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async measure(): Promise<DesktopStorageOverview> {
    const [disk, database, cache, downloads, logs] = await Promise.all([
      statfs(this.options.userDataPath, { bigint: true }).then((info) => ({
        totalBytes: bigintBytes(info.blocks * info.bsize),
        availableBytes: bigintBytes(info.bavail * info.bsize),
      })).catch(() => ({ totalBytes: null, availableBytes: null })),
      databaseBytes(this.options.databaseDirectory).then((bytes): StorageCategory => ({
        id: 'database', bytes, cleanableBytes: 0,
      })).catch(() => unavailable('database')),
      this.measureCache(),
      this.measureDownloads(),
      this.options.logger.inspectStorage().then((value): StorageCategory => ({
        id: 'logs', bytes: byteCount(value.bytes), cleanableBytes: byteCount(value.cleanableBytes),
      })).catch(() => unavailable('logs')),
    ]);
    return {
      measuredAt: new Date((this.options.now ?? Date.now)()).toISOString(),
      disk, categories: [database, cache, downloads, logs],
    };
  }

  private async measureCache(): Promise<StorageCategory> {
    if (!this.options.browserCache) return unavailable('cache');
    try {
      const bytes = byteCount(await this.options.browserCache.getSize());
      return bytes === null ? unavailable('cache') : { id: 'cache', bytes, cleanableBytes: bytes };
    } catch { return unavailable('cache'); }
  }

  private async measureDownloads(): Promise<StorageCategory> {
    if (!this.options.downloads) return unavailable('downloads');
    try {
      const value = await this.options.downloads.inspect();
      const bytes = byteCount(value.bytes);
      const cleanableBytes = value.blocked ? 0 : byteCount(value.cleanableBytes);
      return {
        id: 'downloads', bytes, cleanableBytes,
        ...(value.blocked ? { blockedReason: 'download-active' as const }
          : bytes === null || cleanableBytes === null ? { blockedReason: 'unavailable' as const } : {}),
      };
    } catch { return unavailable('downloads'); }
  }

  private async cleanupTarget(target: DesktopCleanupTarget): Promise<CleanupItem> {
    try {
      if (target === 'logs') {
        return { target, status: 'cleaned', freedBytes: byteCount(await this.options.logger.clearArchivedLogs()) ?? 0 };
      }
      if (target === 'downloads') {
        if (!this.options.downloads) return { target, status: 'skipped', freedBytes: 0, reason: 'unavailable' };
        const result = await this.options.downloads.cleanup();
        return { target, ...result, freedBytes: byteCount(result.freedBytes) ?? 0 };
      }
      const cache = this.options.browserCache;
      if (!cache) return { target, status: 'skipped', freedBytes: 0, reason: 'unavailable' };
      const before = byteCount(await cache.getSize().catch(() => null));
      // Electron owns the live HTTP cache. Never unlink Chromium files or use
      // clearStorageData(), which would remove cookies and persistent user data.
      await cache.clear();
      const after = byteCount(await cache.getSize().catch(() => null));
      return { target, status: 'cleaned', freedBytes: before === null || after === null ? 0 : Math.max(0, before - after) };
    } catch (error) {
      return {
        target, status: 'failed', freedBytes: 0,
        reason: error instanceof UnsafeManagedPathError || (error as NodeJS.ErrnoException)?.code === 'ERR_UNSAFE_MANAGED_PATH'
          ? 'unsafe-path' : 'io-error',
      };
    }
  }
}
