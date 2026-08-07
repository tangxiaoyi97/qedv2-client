import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const MARKER_FORMAT_VERSION = 1;

export interface PreloadCodeCacheMarker {
  formatVersion: typeof MARKER_FORMAT_VERSION;
  electronVersion: string;
  preloadSha256: string;
}

export interface PreloadCodeCacheMigrationOptions {
  electronVersion: string;
  preloadPath: string;
  markerPath: string;
  resetCodeCaches: () => Promise<void>;
}

export interface PreloadCodeCacheMigrationResult {
  migrated: boolean;
  marker: PreloadCodeCacheMarker;
}

interface CachePathStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface PreloadCodeCacheIo {
  lstat(path: string): Promise<CachePathStat>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface ResetPreloadCodeCachesOptions {
  userDataPath: string;
  clearSessionCodeCaches: () => Promise<void>;
  onCleanupError?: (error: unknown, stalePath: string) => void;
  io?: PreloadCodeCacheIo;
}

const defaultCacheIo: PreloadCodeCacheIo = {
  lstat,
  rename,
  remove: (path) => rm(path, { recursive: true, force: true }),
};

async function optionalLstat(io: PreloadCodeCacheIo, path: string): Promise<CachePathStat | undefined> {
  try {
    return await io.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function resetPreloadCodeCaches(
  options: ResetPreloadCodeCachesOptions,
): Promise<void> {
  const io = options.io ?? defaultCacheIo;
  const userDataPath = resolve(options.userDataPath);
  const codeCachePath = resolve(userDataPath, 'Code Cache');
  const preloadCachePath = resolve(codeCachePath, 'electron-preload');
  const contained = relative(userDataPath, preloadCachePath);
  if (
    contained === '' ||
    contained === '..' ||
    contained.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    resolve(dirname(preloadCachePath)) !== codeCachePath
  ) {
    throw new Error('Electron preload cache path escaped the expected userData/Code Cache directory');
  }

  const parent = await optionalLstat(io, codeCachePath);
  if (!parent) {
    await options.clearSessionCodeCaches();
    return;
  }
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error('Refusing to rotate Electron preload cache through an unsafe Code Cache parent');
  }
  const cache = await optionalLstat(io, preloadCachePath);
  if (cache && (cache.isSymbolicLink() || !cache.isDirectory())) {
    throw new Error('Refusing to rotate an unsafe Electron preload cache path');
  }

  // Clear Chromium-managed code caches through Electron's public API only
  // after all existing paths have passed validation. Electron's own preload
  // cache is separate, so it is narrowly rotated below.
  await options.clearSessionCodeCaches();
  if (!cache) return;

  // Re-check after the async Session operation: a future Electron release may
  // remove this directory itself, and a local filesystem change must not turn
  // the validated target into a symlink before rename.
  const parentAfterSessionClear = await optionalLstat(io, codeCachePath);
  if (!parentAfterSessionClear) return;
  if (parentAfterSessionClear.isSymbolicLink() || !parentAfterSessionClear.isDirectory()) {
    throw new Error('Electron Code Cache parent became unsafe before preload-cache rotation');
  }
  const cacheAfterSessionClear = await optionalLstat(io, preloadCachePath);
  if (!cacheAfterSessionClear) return;
  if (cacheAfterSessionClear.isSymbolicLink() || !cacheAfterSessionClear.isDirectory()) {
    throw new Error('Electron preload cache became unsafe before rotation');
  }

  const stalePath = resolve(
    codeCachePath,
    `electron-preload.stale-${Date.now()}-${process.pid}-${randomUUID()}`,
  );
  if (dirname(stalePath) !== codeCachePath) {
    throw new Error('Electron preload stale-cache path escaped its expected parent');
  }
  // rename within one parent is atomic. Any sharing/permission failure, in
  // particular a Windows directory lock, must abort migration without a marker.
  await io.rename(preloadCachePath, stalePath);
  void io.remove(stalePath).catch((error: unknown) => {
    try {
      options.onCleanupError?.(error, stalePath);
    } catch {
      // Cache cleanup and its diagnostic hook are both non-critical after the
      // successful atomic rotation; neither may destabilize the main process.
    }
  });
}

export class PreloadCodeCacheRuntimeRecovery {
  private clearInFlight: Promise<void> | undefined;
  private readonly recoveries = new Map<number, Promise<void>>();

  constructor(private readonly resetCodeCaches: () => Promise<void>) {}

  recover(contentsId: number, afterClearAttempt: (error?: unknown) => void): Promise<void> {
    const existing = this.recoveries.get(contentsId);
    if (existing) return existing;
    const recovery = (async () => {
      let clearError: unknown;
      try {
        this.clearInFlight ??= this.resetCodeCaches().finally(() => {
          this.clearInFlight = undefined;
        });
        await this.clearInFlight;
      } catch (error) {
        clearError = error;
      }
      afterClearAttempt(clearError);
    })().finally(() => {
      this.recoveries.delete(contentsId);
    });
    this.recoveries.set(contentsId, recovery);
    return recovery;
  }
}

function isMarker(value: unknown): value is PreloadCodeCacheMarker {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PreloadCodeCacheMarker>;
  return (
    candidate.formatVersion === MARKER_FORMAT_VERSION &&
    typeof candidate.electronVersion === 'string' &&
    candidate.electronVersion.length > 0 &&
    typeof candidate.preloadSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.preloadSha256)
  );
}

async function readMarker(markerPath: string): Promise<PreloadCodeCacheMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
    return isMarker(parsed) ? parsed : undefined;
  } catch {
    // A missing, truncated, or otherwise damaged marker is deliberately
    // treated as stale. Repeating the cache clear is safer than trusting it.
    return undefined;
  }
}

async function writeMarkerAtomically(
  markerPath: string,
  marker: PreloadCodeCacheMarker,
): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  const backupPath = `${markerPath}.${process.pid}.${randomUUID()}.old`;
  let movedPriorMarker = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporaryPath, markerPath);
    } catch (error) {
      // rename() replaces atomically on POSIX. Windows can reject replacing an
      // existing destination, so atomically move the old marker aside first.
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EACCES', 'EEXIST', 'EPERM'].includes(code ?? '')) throw error;
      await rename(markerPath, backupPath);
      movedPriorMarker = true;
      try {
        await rename(temporaryPath, markerPath);
      } catch (replacementError) {
        await rename(backupPath, markerPath).catch(() => undefined);
        movedPriorMarker = false;
        throw replacementError;
      }
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (movedPriorMarker) await rm(backupPath, { force: true }).catch(() => undefined);
  }
}

function sameMarker(
  left: PreloadCodeCacheMarker | undefined,
  right: PreloadCodeCacheMarker,
): boolean {
  return (
    left?.formatVersion === right.formatVersion &&
    left.electronVersion === right.electronVersion &&
    left.preloadSha256 === right.preloadSha256
  );
}

export async function migratePreloadCodeCache(
  options: PreloadCodeCacheMigrationOptions,
): Promise<PreloadCodeCacheMigrationResult> {
  const preload = await readFile(options.preloadPath);
  const marker: PreloadCodeCacheMarker = {
    formatVersion: MARKER_FORMAT_VERSION,
    electronVersion: options.electronVersion,
    preloadSha256: createHash('sha256').update(preload).digest('hex'),
  };
  const existing = await readMarker(options.markerPath);
  if (sameMarker(existing, marker)) return { migrated: false, marker };

  // Reset both Electron's Session-managed caches and its narrowly scoped
  // application-level preload cache before committing successful migration.
  await options.resetCodeCaches();
  // The marker is committed only after Electron confirms the clear. A failed
  // clear therefore retries on the next launch instead of recording success.
  await writeMarkerAtomically(options.markerPath, marker);
  return { migrated: true, marker };
}
