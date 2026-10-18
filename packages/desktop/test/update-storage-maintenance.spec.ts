import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupExpiredUpdateStorage, inspectUpdateStorage } from '../src/main/update-storage-maintenance.js';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 86_400_000;
const ASSET = 'QED2-2.5.1-mac-arm64.dmg';
const OTHER = 'QED2-2.4.0-linux-x64.AppImage';
let temporary: string;
let directory: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'qed2-update-storage-test-'));
  directory = join(temporary, 'updates');
  await mkdir(directory);
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

async function file(name: string, size: number, ageDays: number): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, Buffer.alloc(size, 'x'));
  const stamp = new Date(NOW - ageDays * DAY);
  await utimes(path, stamp, stamp);
}

describe('update storage maintenance', () => {
  it('cleans only expired known release files while preserving arbitrary data and fresh downloads', async () => {
    await file(`${ASSET}.part`, 100, 15);
    await file(OTHER, 200, 31);
    await file('QED2-2.5.0-win-x64.exe', 300, 29);
    await file('notes.sqlite3', 400, 100);
    await file('download-journal.json.tmp', 50, 100);
    const before = (await readdir(directory)).sort();
    expect(await inspectUpdateStorage(directory, [], NOW)).toEqual({ bytes: 1_050, cleanableBytes: 300 });
    expect((await readdir(directory)).sort()).toEqual(before);
    expect(await cleanupExpiredUpdateStorage(directory, [], NOW)).toBe(300);
    expect((await readdir(directory)).sort()).toEqual([
      'QED2-2.5.0-win-x64.exe', 'download-journal.json.tmp', 'notes.sqlite3',
    ]);
  });

  it('preserves journal-referenced paused or verified files regardless of file or journal age', async () => {
    await file(ASSET, 200, 100);
    await file(`${ASSET}.part`, 100, 100);
    await file(OTHER, 500, 100);
    const journal = JSON.stringify({ assetName: ASSET, state: 'partial', paused: true, updatedAt: '2020-01-01T00:00:00Z' });
    await writeFile(join(directory, 'download-journal.json'), journal);
    expect((await inspectUpdateStorage(directory, [], NOW)).cleanableBytes).toBe(500);
    expect(await cleanupExpiredUpdateStorage(directory, [], NOW)).toBe(500);
    expect(await readFile(join(directory, 'download-journal.json'), 'utf8')).toBe(journal);
    expect((await lstat(join(directory, ASSET))).size).toBe(200);
    expect((await lstat(join(directory, `${ASSET}.part`))).size).toBe(100);
  });

  it('also preserves artifacts protected by the coordinator before a journal exists', async () => {
    await file(ASSET, 200, 100);
    await file(`${ASSET}.part`, 100, 100);
    expect(await cleanupExpiredUpdateStorage(directory, [ASSET], NOW)).toBe(0);
  });

  it.each(['not json', '{}', JSON.stringify({ assetName: '../../backup' }), 'x'.repeat(32 * 1_024 + 1)])(
    'does not alter an invalid recovery journal or any possibly referenced artifact (%#)', async (journal) => {
      await file(ASSET, 200, 100);
      await writeFile(join(directory, 'download-journal.json'), journal);
      expect((await inspectUpdateStorage(directory, [], NOW)).cleanableBytes).toBe(0);
      expect(await cleanupExpiredUpdateStorage(directory, [], NOW)).toBe(0);
      expect(await readFile(join(directory, 'download-journal.json'), 'utf8')).toBe(journal);
      expect((await readdir(directory)).sort()).toEqual([ASSET, 'download-journal.json']);
    },
  );

  it('ages quarantined files from both their last write and quarantine timestamp', async () => {
    const expired = `${ASSET}.part.validator-changed-2026-09-01T01-02-03-004Z`;
    const recent = `${ASSET}.part.invalid-2026-10-08T01-02-03-004Z`;
    const unknown = `${ASSET}.part.unrecognized-2026-09-01T01-02-03-004Z`;
    const journal = 'download-journal.json.journal-2026-09-01T01-02-03-004Z';
    await file(expired, 100, 100);
    await file(recent, 200, 100);
    await file(unknown, 300, 100);
    await file(journal, 50, 100);
    expect(await cleanupExpiredUpdateStorage(directory, [], NOW)).toBe(150);
    expect((await readdir(directory)).sort()).toEqual([recent, unknown].sort());
  });

  it('preserves files on the TTL boundary and timestamps in the future', async () => {
    await file(`${ASSET}.part`, 100, 14);
    await file(OTHER, 200, 30);
    await file(ASSET, 300, -10);
    expect(await cleanupExpiredUpdateStorage(directory, [], NOW)).toBe(0);
  });

  it.each(['symlink', 'hardlink', 'directory'] as const)(
    'fails closed before deleting anything when a %s entry is present', async (kind) => {
      await file(ASSET, 200, 100);
      await writeFile(join(temporary, 'outside'), 'keep outside');
      if (kind === 'symlink') await symlink(join(temporary, 'outside'), join(directory, OTHER));
      else if (kind === 'hardlink') await link(join(temporary, 'outside'), join(directory, OTHER));
      else await mkdir(join(directory, OTHER));
      await expect(cleanupExpiredUpdateStorage(directory, [], NOW)).rejects.toMatchObject({ code: 'ERR_UNSAFE_MANAGED_PATH' });
      expect((await lstat(join(directory, ASSET))).size).toBe(200);
      expect(await readFile(join(temporary, 'outside'), 'utf8')).toBe('keep outside');
    },
  );

  it('refuses a linked journal and a linked storage root without following either', async () => {
    await file(ASSET, 200, 100);
    await writeFile(join(temporary, 'outside'), JSON.stringify({ assetName: ASSET }));
    await symlink(join(temporary, 'outside'), join(directory, 'download-journal.json'));
    await expect(inspectUpdateStorage(directory, [], NOW)).rejects.toMatchObject({ code: 'ERR_UNSAFE_MANAGED_PATH' });
    await symlink(directory, join(temporary, 'alias'), 'dir');
    await expect(cleanupExpiredUpdateStorage(join(temporary, 'alias'), [], NOW)).rejects.toMatchObject({ code: 'ERR_UNSAFE_MANAGED_PATH' });
  });

  it('does not create a missing update directory and validates injected clocks', async () => {
    const missing = join(temporary, 'not-created');
    expect(await inspectUpdateStorage(missing, [], NOW)).toEqual({ bytes: 0, cleanableBytes: 0 });
    expect(await cleanupExpiredUpdateStorage(missing, [], NOW)).toBe(0);
    await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(cleanupExpiredUpdateStorage(directory, [], Number.NaN)).rejects.toThrow('Invalid storage measurement time');
  });
});
