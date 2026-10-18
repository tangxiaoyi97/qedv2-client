import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiskSpaceManager, type DiskSpaceManagerOptions } from '../src/main/disk-space-manager.js';
import { DesktopLogger } from '../src/main/logger.js';
import { UnsafeManagedPathError } from '../src/main/managed-file-safety.js';
import { SqliteStorage } from '../src/main/storage.js';

let directory: string;
let logger: DesktopLogger;
let cacheSize: number;
let options: DiskSpaceManagerOptions;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qed2-disk-space-test-'));
  logger = new DesktopLogger(join(directory, 'logs'));
  cacheSize = 1_024;
  options = {
    userDataPath: directory, databaseDirectory: join(directory, 'data'), logger,
    browserCache: {
      getSize: vi.fn(async () => cacheSize),
      clear: vi.fn(async () => { cacheSize = 0; }),
    },
    downloads: {
      inspect: vi.fn(async () => ({ bytes: 512, cleanableBytes: 128, blocked: false })),
      cleanup: vi.fn(async () => ({ status: 'cleaned' as const, freedBytes: 128 })),
    },
    now: () => Date.parse('2026-10-09T12:00:00Z'),
  };
});

afterEach(async () => {
  await logger.flush();
  await rm(directory, { recursive: true, force: true });
});

describe('DiskSpaceManager', () => {
  it('measures the real filesystem, database sidecars and protected recovery copies without changing them', async () => {
    await mkdir(join(directory, 'data', 'recovery'), { recursive: true });
    await writeFile(join(directory, 'data', 'qed2.sqlite3'), Buffer.alloc(100));
    await writeFile(join(directory, 'data', 'qed2.sqlite3-wal'), Buffer.alloc(20));
    await writeFile(join(directory, 'data', 'qed2.sqlite3-shm'), Buffer.alloc(10));
    await writeFile(join(directory, 'data', 'recovery', 'saved.sqlite3'), Buffer.alloc(200));
    logger.info('current');
    await logger.flush();
    await writeFile(`${logger.filePath}.1`, 'old logs');
    const overview = await new DiskSpaceManager(options).getOverview();
    expect(overview.measuredAt).toBe('2026-10-09T12:00:00.000Z');
    expect(overview.disk.totalBytes).toBeGreaterThan(0);
    expect(overview.disk.availableBytes).toBeGreaterThanOrEqual(0);
    expect(overview.categories).toEqual([
      { id: 'database', bytes: 330, cleanableBytes: 0 },
      { id: 'cache', bytes: 1_024, cleanableBytes: 1_024 },
      { id: 'downloads', bytes: 512, cleanableBytes: 128 },
      { id: 'logs', bytes: (await stat(logger.filePath)).size + 8, cleanableBytes: 8 },
    ]);
    expect(await readFile(join(directory, 'data', 'recovery', 'saved.sqlite3'))).toEqual(Buffer.alloc(200));
    expect(options.browserCache!.clear).not.toHaveBeenCalled();
    expect(options.downloads!.cleanup).not.toHaveBeenCalled();
  });

  it('keeps accounts, progress, backup files and the active log intact when every supported target is cleaned', async () => {
    const storage = new SqliteStorage(join(options.databaseDirectory, 'qed2.sqlite3'));
    try {
      storage.set('auth', 'account', { id: 'local-account', token: 'private' });
      storage.set('archive', 'guest', { progress: 42, starred: true });
      await writeFile(join(options.databaseDirectory, 'backup.sqlite3'), 'precious backup');
      logger.info('keep current log');
      await logger.flush();
      await writeFile(`${logger.filePath}.1`, 'archive');
      const result = await new DiskSpaceManager(options).cleanup(['cache', 'downloads', 'logs']);
      expect(result.results).toEqual([
        { target: 'cache', status: 'cleaned', freedBytes: 1_024 },
        { target: 'downloads', status: 'cleaned', freedBytes: 128 },
        { target: 'logs', status: 'cleaned', freedBytes: 7 },
      ]);
      expect(storage.get('auth', 'account')).toEqual({ id: 'local-account', token: 'private' });
      expect(storage.get('archive', 'guest')).toEqual({ progress: 42, starred: true });
      expect(await readFile(join(options.databaseDirectory, 'backup.sqlite3'), 'utf8')).toBe('precious backup');
      expect(await readFile(logger.filePath, 'utf8')).toContain('keep current log');
      expect(result.overview.categories.find((item) => item.id === 'cache')?.bytes).toBe(0);
    } finally { storage.close(); }
  });

  it('does not create any folders or files while measuring an empty installation', async () => {
    const before = await readdir(directory);
    await new DiskSpaceManager(options).getOverview();
    expect(await readdir(directory)).toEqual(before);
  });

  it('delegates download exclusion to the updater and exposes blocked cleanup without cancelling it', async () => {
    options.downloads = {
      inspect: async () => ({ bytes: 5_000, cleanableBytes: 4_000, blocked: true }),
      cleanup: vi.fn(async () => ({ status: 'skipped' as const, freedBytes: 0, reason: 'download-active' as const })),
    };
    const result = await new DiskSpaceManager(options).cleanup(['downloads']);
    expect(result.results).toEqual([{ target: 'downloads', status: 'skipped', freedBytes: 0, reason: 'download-active' }]);
    expect(result.overview.categories.find((item) => item.id === 'downloads')).toEqual({
      id: 'downloads', bytes: 5_000, cleanableBytes: 0, blockedReason: 'download-active',
    });
  });

  it('validates the complete cleanup request before taking any action', async () => {
    const manager = new DiskSpaceManager(options);
    for (const invalid of [[], ['cache', 'cache'], ['cache', 'database'], ['../data'], null]) {
      await expect(manager.cleanup(invalid as never)).rejects.toThrow('Invalid local storage cleanup targets');
    }
    expect(options.browserCache!.clear).not.toHaveBeenCalled();
    expect(options.downloads!.cleanup).not.toHaveBeenCalled();
  });

  it('serializes overlapping cleanup requests and keeps the queue usable after an error', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const clear = vi.fn().mockImplementationOnce(async () => { await blocked; throw new Error('disk unavailable'); })
      .mockImplementationOnce(async () => { cacheSize = 0; });
    options.browserCache!.clear = clear;
    const manager = new DiskSpaceManager(options);
    const first = manager.cleanup(['cache']);
    const second = manager.cleanup(['cache']);
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    release();
    expect((await first).results[0]).toMatchObject({ status: 'failed', reason: 'io-error' });
    expect((await second).results[0]).toMatchObject({ status: 'cleaned', freedBytes: 1_024 });
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent overview requests', async () => {
    const manager = new DiskSpaceManager(options);
    const first = manager.getOverview();
    const second = manager.getOverview();
    expect(second).toBe(first);
    await first;
    expect(options.browserCache!.getSize).toHaveBeenCalledTimes(1);
  });

  it('reports missing integrations and measurement errors as unknown, never as zero free space', async () => {
    delete options.browserCache;
    delete options.downloads;
    options.userDataPath = join(directory, 'missing');
    options.databaseDirectory = join(options.userDataPath, 'data');
    const manager = new DiskSpaceManager(options);
    const result = await manager.cleanup(['cache', 'downloads']);
    expect(result.results.every((item) => item.status === 'skipped' && item.reason === 'unavailable')).toBe(true);
    expect(result.overview.disk).toEqual({ totalBytes: null, availableBytes: null });
    expect(result.overview.categories.find((item) => item.id === 'cache')).toEqual({
      id: 'cache', bytes: null, cleanableBytes: null, blockedReason: 'unavailable',
    });
  });

  it('rejects invalid cache measurements and never reports negative reclaimed space', async () => {
    cacheSize = Number.NaN;
    const manager = new DiskSpaceManager(options);
    expect((await manager.getOverview()).categories.find((item) => item.id === 'cache')?.bytes).toBeNull();
    cacheSize = 50;
    options.browserCache!.clear = async () => { cacheSize = 100; };
    expect((await manager.cleanup(['cache'])).results[0]?.freedBytes).toBe(0);
  });

  it('does not follow a database link or permit a database directory outside app data', async () => {
    await mkdir(join(directory, 'outside'));
    await writeFile(join(directory, 'outside', 'data.sqlite3'), 'keep');
    await symlink(join(directory, 'outside'), options.databaseDirectory, 'dir');
    const result = await new DiskSpaceManager(options).getOverview();
    expect(result.categories[0]).toEqual({ id: 'database', bytes: null, cleanableBytes: 0, blockedReason: 'unavailable' });
    expect((await lstat(options.databaseDirectory)).isSymbolicLink()).toBe(true);
    expect(() => new DiskSpaceManager({ ...options, databaseDirectory: join(directory, '..', 'other') }))
      .toThrow(UnsafeManagedPathError);
  });

  it('reports a refused path separately while continuing other selected safe targets', async () => {
    options.logger = {
      inspectStorage: async () => { throw new UnsafeManagedPathError(); },
      clearArchivedLogs: async () => { throw new UnsafeManagedPathError(); },
    };
    const result = await new DiskSpaceManager(options).cleanup(['logs', 'cache']);
    expect(result.results).toEqual([
      { target: 'logs', status: 'failed', freedBytes: 0, reason: 'unsafe-path' },
      { target: 'cache', status: 'cleaned', freedBytes: 1_024 },
    ]);
  });
});
