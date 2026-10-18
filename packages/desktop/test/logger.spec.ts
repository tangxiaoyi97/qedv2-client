import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesktopLogger } from '../src/main/logger.js';

let directory: string;
let logger: DesktopLogger;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qed2-logger-test-'));
  logger = new DesktopLogger(join(directory, 'logs'));
});
afterEach(async () => {
  await logger.flush();
  await rm(directory, { recursive: true, force: true });
});

describe('DesktopLogger storage maintenance', () => {
  it('removes only the three managed archives, preserving the active log and unrelated backups', async () => {
    logger.info('keep this');
    await logger.flush();
    for (const [name, contents] of [
      ['desktop.log.1', '123'], ['desktop.log.2', '45'], ['desktop.log.3', '6'],
      ['desktop.log.4', 'old custom log'], ['backup.sqlite3', 'private backup'],
    ]) await writeFile(join(directory, 'logs', name!), contents!);
    expect((await logger.inspectStorage()).cleanableBytes).toBe(6);
    expect(await logger.clearArchivedLogs()).toBe(6);
    expect((await logger.inspectStorage()).cleanableBytes).toBe(0);
    expect(await readdir(join(directory, 'logs'))).toEqual(['backup.sqlite3', 'desktop.log', 'desktop.log.4']);
    expect(await readFile(logger.filePath, 'utf8')).toContain('keep this');
  });

  it('serializes cleanup with rotation and subsequent writes', async () => {
    await mkdir(join(directory, 'logs'));
    await writeFile(logger.filePath, Buffer.alloc(5 * 1_024 * 1_024, 'x'));
    logger.info('before cleanup');
    const clearing = logger.clearArchivedLogs();
    logger.info('after cleanup');
    expect(await clearing).toBe(5 * 1_024 * 1_024);
    await logger.flush();
    const current = await readFile(logger.filePath, 'utf8');
    expect(current).toContain('before cleanup');
    expect(current).toContain('after cleanup');
    expect(await readdir(join(directory, 'logs'))).toEqual(['desktop.log']);
  });

  it.each(['symlink', 'hardlink'] as const)('refuses a %s archive before removing any other archive', async (kind) => {
    await mkdir(join(directory, 'logs'));
    await writeFile(`${logger.filePath}.1`, 'safe archive');
    await writeFile(join(directory, 'personal'), 'personal data');
    if (kind === 'symlink') await symlink(join(directory, 'personal'), `${logger.filePath}.2`);
    else await link(join(directory, 'personal'), `${logger.filePath}.2`);
    await expect(logger.clearArchivedLogs()).rejects.toMatchObject({ code: 'ERR_UNSAFE_MANAGED_PATH' });
    expect(await readFile(`${logger.filePath}.1`, 'utf8')).toBe('safe archive');
    expect(await readFile(join(directory, 'personal'), 'utf8')).toBe('personal data');
  });

  it('refuses linked folders and linked ancestors', async () => {
    await mkdir(join(directory, 'outside', 'nested'), { recursive: true });
    await writeFile(join(directory, 'outside', 'nested', 'desktop.log.1'), 'protected');
    await symlink(join(directory, 'outside'), join(directory, 'alias'), 'dir');
    const linked = new DesktopLogger(join(directory, 'alias', 'nested'));
    await expect(linked.clearArchivedLogs()).rejects.toMatchObject({ code: 'ERR_UNSAFE_MANAGED_PATH' });
    expect(await readFile(join(directory, 'outside', 'nested', 'desktop.log.1'), 'utf8')).toBe('protected');
  });

  it('does not create a missing log folder when inspecting or clearing it', async () => {
    expect(await logger.inspectStorage()).toEqual({ bytes: 0, cleanableBytes: 0 });
    expect(await logger.clearArchivedLogs()).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });
});
