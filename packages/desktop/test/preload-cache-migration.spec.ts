import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  migratePreloadCodeCache,
  PreloadCodeCacheRuntimeRecovery,
  resetPreloadCodeCaches,
  type PreloadCodeCacheIo,
} from '../src/main/preload-cache-migration.js';

const temporaryDirectories: string[] = [];

async function createFixture(preload = 'globalThis.qed2 = true;\n') {
  const directory = await mkdtemp(join(tmpdir(), 'qed2-preload-cache-'));
  temporaryDirectories.push(directory);
  const preloadPath = join(directory, 'preload.cjs');
  const markerPath = join(directory, 'state', 'preload-code-cache.json');
  await writeFile(preloadPath, preload);
  return { directory, preloadPath, markerPath, preload };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Electron preload code-cache migration', () => {
  it('clears once and atomically records the Electron version and actual preload digest', async () => {
    const fixture = await createFixture();
    const clearCodeCaches = vi.fn(async () => undefined);

    const first = await migratePreloadCodeCache({
      electronVersion: '43.3.0',
      preloadPath: fixture.preloadPath,
      markerPath: fixture.markerPath,
      resetCodeCaches: clearCodeCaches,
    });
    const second = await migratePreloadCodeCache({
      electronVersion: '43.3.0',
      preloadPath: fixture.preloadPath,
      markerPath: fixture.markerPath,
      resetCodeCaches: clearCodeCaches,
    });

    expect(first.migrated).toBe(true);
    expect(second.migrated).toBe(false);
    expect(clearCodeCaches).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual({
      formatVersion: 1,
      electronVersion: '43.3.0',
      preloadSha256: createHash('sha256').update(fixture.preload).digest('hex'),
    });
    expect((await readdir(join(fixture.directory, 'state'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('clears again when either Electron or the bundled preload changes', async () => {
    const fixture = await createFixture();
    const clearCodeCaches = vi.fn(async () => undefined);
    const migrate = (electronVersion: string) =>
      migratePreloadCodeCache({
        electronVersion,
        preloadPath: fixture.preloadPath,
        markerPath: fixture.markerPath,
        resetCodeCaches: clearCodeCaches,
      });

    await migrate('43.3.0');
    await migrate('43.3.1');
    await writeFile(fixture.preloadPath, 'globalThis.qed2 = false;\n');
    await migrate('43.3.1');

    expect(clearCodeCaches).toHaveBeenCalledTimes(3);
  });

  it('fails safe for a damaged marker and repairs it only after a successful clear', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.directory, 'state'));
    await writeFile(fixture.markerPath, '{truncated');
    const clearCodeCaches = vi.fn(async () => undefined);

    const result = await migratePreloadCodeCache({
      electronVersion: '43.3.0',
      preloadPath: fixture.preloadPath,
      markerPath: fixture.markerPath,
      resetCodeCaches: clearCodeCaches,
    });

    expect(result.migrated).toBe(true);
    expect(clearCodeCaches).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual(result.marker);
  });

  it('does not write a success marker when Electron fails to clear its cache', async () => {
    const fixture = await createFixture();
    const previous = '{"damaged":true}\n';
    await mkdir(join(fixture.directory, 'state'));
    await writeFile(fixture.markerPath, previous);

    await expect(
      migratePreloadCodeCache({
        electronVersion: '43.3.0',
        preloadPath: fixture.preloadPath,
        markerPath: fixture.markerPath,
        resetCodeCaches: async () => {
          throw new Error('clear failed');
        },
      }),
    ).rejects.toThrow('clear failed');

    expect(await readFile(fixture.markerPath, 'utf8')).toBe(previous);
    expect((await readdir(join(fixture.directory, 'state'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('uses the official API and succeeds when the narrow preload cache does not exist', async () => {
    const fixture = await createFixture();
    const clearSessionCodeCaches = vi.fn(async () => undefined);
    await mkdir(join(fixture.directory, 'Code Cache'));

    await resetPreloadCodeCaches({ userDataPath: fixture.directory, clearSessionCodeCaches });

    expect(clearSessionCodeCaches).toHaveBeenCalledOnce();
    expect(await readdir(join(fixture.directory, 'Code Cache'))).toEqual([]);
  });

  it('atomically rotates only electron-preload and leaves neighboring data untouched', async () => {
    const fixture = await createFixture();
    const codeCache = join(fixture.directory, 'Code Cache');
    const preloadCache = join(codeCache, 'electron-preload');
    await mkdir(preloadCache, { recursive: true });
    await writeFile(join(preloadCache, 'old.cache'), 'stale');
    await mkdir(join(codeCache, 'js'));
    await writeFile(join(codeCache, 'js', 'keep.cache'), 'keep');
    await writeFile(join(fixture.directory, 'qed2.sqlite3'), 'business data');
    let releaseRemoval!: () => void;
    let stalePath = '';
    const io: PreloadCodeCacheIo = {
      lstat,
      rename: async (source, destination) => {
        stalePath = destination;
        await rename(source, destination);
      },
      remove: () => new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      }),
    };

    await resetPreloadCodeCaches({
      userDataPath: fixture.directory,
      clearSessionCodeCaches: async () => undefined,
      io,
    });

    expect(stalePath).toMatch(/electron-preload\.stale-/);
    expect(await readFile(join(stalePath, 'old.cache'), 'utf8')).toBe('stale');
    expect(await readFile(join(codeCache, 'js', 'keep.cache'), 'utf8')).toBe('keep');
    expect(await readFile(join(fixture.directory, 'qed2.sqlite3'), 'utf8')).toBe('business data');
    releaseRemoval();
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked cache parent without renaming anything', async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), 'qed2-preload-outside-'));
    temporaryDirectories.push(outside);
    await symlink(outside, join(fixture.directory, 'Code Cache'));
    const renameCache = vi.fn(async () => undefined);
    const clearSessionCodeCaches = vi.fn(async () => undefined);

    await expect(
      resetPreloadCodeCaches({
        userDataPath: fixture.directory,
        clearSessionCodeCaches,
        io: { lstat, rename: renameCache, remove: async () => undefined },
      }),
    ).rejects.toThrow('unsafe Code Cache parent');
    expect(renameCache).not.toHaveBeenCalled();
    expect(clearSessionCodeCaches).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked preload-cache target', async () => {
    const fixture = await createFixture();
    const codeCache = join(fixture.directory, 'Code Cache');
    const outside = await mkdtemp(join(tmpdir(), 'qed2-preload-target-'));
    temporaryDirectories.push(outside);
    await mkdir(codeCache);
    await symlink(outside, join(codeCache, 'electron-preload'));
    const clearSessionCodeCaches = vi.fn(async () => undefined);

    await expect(
      resetPreloadCodeCaches({ userDataPath: fixture.directory, clearSessionCodeCaches }),
    ).rejects.toThrow('unsafe Electron preload cache path');
    expect(clearSessionCodeCaches).not.toHaveBeenCalled();
  });

  it('revalidates the cache parent after the asynchronous Session clear', async () => {
    const fixture = await createFixture();
    let parentChecks = 0;
    const directory = { isDirectory: () => true, isSymbolicLink: () => false };
    const symlink = { isDirectory: () => false, isSymbolicLink: () => true };
    const renameCache = vi.fn(async () => undefined);
    const io: PreloadCodeCacheIo = {
      lstat: vi.fn(async (path) => {
        if (path.endsWith('Code Cache')) {
          parentChecks += 1;
          return parentChecks === 1 ? directory : symlink;
        }
        return directory;
      }),
      rename: renameCache,
      remove: async () => undefined,
    };

    await expect(
      resetPreloadCodeCaches({
        userDataPath: fixture.directory,
        clearSessionCodeCaches: async () => undefined,
        io,
      }),
    ).rejects.toThrow('parent became unsafe');
    expect(renameCache).not.toHaveBeenCalled();
  });

  it('fails closed on an occupied/failed rename so migration cannot record success', async () => {
    const fixture = await createFixture();
    const codeCache = join(fixture.directory, 'Code Cache');
    await mkdir(join(codeCache, 'electron-preload'), { recursive: true });
    const markerReset = () =>
      resetPreloadCodeCaches({
        userDataPath: fixture.directory,
        clearSessionCodeCaches: async () => undefined,
        io: {
          lstat,
          rename: async () => {
            throw Object.assign(new Error('directory is occupied'), { code: 'EPERM' });
          },
          remove: async () => undefined,
        },
      });

    await expect(
      migratePreloadCodeCache({
        electronVersion: '43.3.0',
        preloadPath: fixture.preloadPath,
        markerPath: fixture.markerPath,
        resetCodeCaches: markerReset,
      }),
    ).rejects.toThrow('directory is occupied');
    await expect(readFile(fixture.markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(codeCache)).toEqual(['electron-preload']);
  });

  it('coalesces concurrent runtime preload failures before allowing bounded window recovery', async () => {
    let releaseClear!: () => void;
    const clearCodeCaches = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClear = resolve;
        }),
    );
    const coordinator = new PreloadCodeCacheRuntimeRecovery(clearCodeCaches);
    const firstWindow = vi.fn();
    const secondWindow = vi.fn();

    const first = coordinator.recover(1, firstWindow);
    const duplicate = coordinator.recover(1, firstWindow);
    const second = coordinator.recover(2, secondWindow);
    await Promise.resolve();

    expect(duplicate).toBe(first);
    expect(clearCodeCaches).toHaveBeenCalledOnce();
    expect(firstWindow).not.toHaveBeenCalled();
    expect(secondWindow).not.toHaveBeenCalled();
    releaseClear();
    await Promise.all([first, duplicate, second]);
    expect(firstWindow).toHaveBeenCalledOnce();
    expect(secondWindow).toHaveBeenCalledOnce();
  });

  it('reports a runtime clear failure before permitting the existing recovery circuit to reload', async () => {
    const failure = new Error('runtime clear failed');
    const coordinator = new PreloadCodeCacheRuntimeRecovery(async () => {
      throw failure;
    });
    const afterClearAttempt = vi.fn();

    await coordinator.recover(7, afterClearAttempt);

    expect(afterClearAttempt).toHaveBeenCalledWith(failure);
  });
});
