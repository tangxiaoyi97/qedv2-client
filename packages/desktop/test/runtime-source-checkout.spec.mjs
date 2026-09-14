import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCleanGitCheckout, formatGitStatusDiagnostic } from '../scripts/runtime-source-checkout.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qed2-source-checkout-'));
  directories.push(directory);
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: 'pipe' });
  git('init');
  git('config', 'user.name', 'Runtime test');
  git('config', 'user.email', 'runtime@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(directory, 'absent-hooks'));
  await writeFile(join(directory, 'tracked.txt'), 'committed content\n');
  git('add', 'tracked.txt');
  git('commit', '-m', 'fixture');
  return { directory, git };
}

describe('immutable runtime source checkout', () => {
  it('accepts an unchanged checkout and rejects tracked or untracked changes without logging contents', async () => {
    const { directory } = await fixture();
    expect(() => assertCleanGitCheckout(directory, 'Core source')).not.toThrow();
    const content = 'private file content must not enter the diagnostic';
    await writeFile(join(directory, 'tracked.txt'), content);
    await writeFile(join(directory, 'new path α.json'), content);
    let failure;
    try { assertCleanGitCheckout(directory, 'Core source'); } catch (error) { failure = error; }
    expect(failure?.message).toContain('cannot represent an immutable commit');
    expect(failure?.message).toContain(JSON.stringify(' M tracked.txt'));
    expect(failure?.message).toContain(JSON.stringify('?? new path α.json'));
    expect(failure?.message).not.toContain(content);
    expect(await readFile(join(directory, 'tracked.txt'), 'utf8')).toBe(content);
  });

  it('reports both paths of a staged rename', async () => {
    const { directory, git } = await fixture();
    git('mv', 'tracked.txt', 'renamed file.txt');
    expect(() => assertCleanGitCheckout(directory, 'Question bank'))
      .toThrow(/"R  renamed file\.txt"\n"tracked\.txt"/);
  });

  it('escapes filename control characters so they cannot inject log lines or terminal commands', () => {
    const diagnostic = formatGitStatusDiagnostic('?? line\nwith\rcontrols\u001b[2J"name\0');
    expect(diagnostic.split('\n')).toHaveLength(2);
    expect(diagnostic).toContain(JSON.stringify('?? line\nwith\rcontrols\u001b[2J"name'));
    expect(diagnostic).not.toContain('\u001b');
  });

  it('bounds entry count, individual names, and total UTF-8 diagnostic bytes', () => {
    const many = formatGitStatusDiagnostic(Array.from({ length: 100 }, (_, i) => `?? path-${i}\0`).join(''));
    expect(many.split('\n').filter((line) => line.startsWith('"'))).toHaveLength(20);
    expect(many).toContain('Additional paths omitted.');
    const long = formatGitStatusDiagnostic(Array.from({ length: 100 }, () => `?? ${'界'.repeat(10_000)}\0`).join(''));
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(4096);
    expect(long).toContain('…');
    expect(long).toContain('Additional paths omitted.');
  });
});
