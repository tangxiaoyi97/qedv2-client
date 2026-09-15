import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { installCoreProductionDependencies } from '../scripts/prepare-runtime-dependencies.mjs';

const directories = [];
const runFile = promisify(execFile);
// Exercise the same pnpm that launched the test suite, without registry access.
const pnpm = {
  executable: process.execPath,
  prefix: [process.env.npm_execpath, '--offline'],
};
const override = '  unused-runtime-package@<1.2.3: 1.2.3\n';

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture({ workspace = true, mismatchedLock = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qed2-runtime-dependencies-'));
  directories.push(root);
  const source = join(root, 'source');
  const parent = join(root, 'client');
  const destination = join(parent, '.runtime-stage', 'core');
  await mkdir(source, { recursive: true });
  await mkdir(parent, { recursive: true });
  await writeFile(join(parent, 'pnpm-workspace.yaml'),
    "packages:\n  - '**'\noverrides:\n  unwanted-parent-override: 9.9.9\n");
  await writeFile(join(parent, 'package.json'), JSON.stringify({ name: 'unrelated-client', version: '1.0.0' }));
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'qed2-core',
    version: '1.0.0',
    scripts: {
      postinstall: `node -e "require('node:fs').writeFileSync('lifecycle-ran', 'unexpected')"`,
    },
  }));
  const workspaceText = `allowBuilds:\n  untrusted-script: false\noverrides:\n${override}`;
  if (workspace) await writeFile(join(source, 'pnpm-workspace.yaml'), workspaceText);
  const lock = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n"
    + (workspace ? `\noverrides:\n${mismatchedLock ? '  unused-runtime-package@<1.2.3: 1.2.4\n' : override}` : '')
    + '\nimporters:\n\n  .: {}\n';
  await writeFile(join(source, 'pnpm-lock.yaml'), lock);
  return { root, source, parent, destination, lock, workspaceText };
}

describe('staged Core production dependencies', () => {
  it('uses audited overrides with real frozen pnpm and ignores the enclosing Client workspace', async () => {
    const f = await fixture();
    await installCoreProductionDependencies(f.source, f.destination, pnpm);
    expect(await readFile(join(f.destination, 'pnpm-lock.yaml'), 'utf8')).toBe(f.lock);
    expect(await readFile(join(f.source, 'pnpm-workspace.yaml'), 'utf8')).toBe(f.workspaceText);
    expect(await stat(join(f.destination, 'lifecycle-ran')).catch(() => null)).toBeNull();
    expect(await stat(join(f.parent, 'pnpm-lock.yaml')).catch(() => null)).toBeNull();
    expect(await stat(join(f.destination, 'pnpm-workspace.yaml')).catch(() => null)).toBeNull();
  });

  it('keeps older Core commits without workspace config isolated from Client overrides', async () => {
    const f = await fixture({ workspace: false });
    await installCoreProductionDependencies(f.source, f.destination, pnpm);
    expect(await readFile(join(f.destination, 'pnpm-lock.yaml'), 'utf8')).toBe(f.lock);
    expect(await stat(join(f.destination, 'lifecycle-ran')).catch(() => null)).toBeNull();
    expect(await stat(join(f.destination, 'pnpm-workspace.yaml')).catch(() => null)).toBeNull();
  });

  it('installs the frozen production graph without development dependencies or lifecycle scripts', async () => {
    const f = await fixture();
    const archives = join(f.source, 'archives');
    await mkdir(archives);
    for (const name of ['runtime-dependency', 'development-dependency']) {
      const directory = join(f.root, name);
      await mkdir(directory);
      await writeFile(join(directory, 'package.json'), JSON.stringify({
        name, version: '1.0.0',
        scripts: { postinstall: `node -e "require('node:fs').writeFileSync('lifecycle-ran', 'unexpected')"` },
      }));
      await runFile(pnpm.executable, [pnpm.prefix[0], '--dir', directory, 'pack', '--pack-destination', archives]);
    }
    const packageJson = JSON.parse(await readFile(join(f.source, 'package.json'), 'utf8'));
    packageJson.dependencies = { 'runtime-dependency': 'file:archives/runtime-dependency-1.0.0.tgz' };
    packageJson.devDependencies = { 'development-dependency': 'file:archives/development-dependency-1.0.0.tgz' };
    await writeFile(join(f.source, 'package.json'), JSON.stringify(packageJson));
    await runFile(pnpm.executable, [...pnpm.prefix, '--dir', f.source, 'install', '--lockfile-only', '--ignore-scripts']);
    const frozenLock = await readFile(join(f.source, 'pnpm-lock.yaml'), 'utf8');
    await mkdir(f.destination, { recursive: true });
    await cp(archives, join(f.destination, 'archives'), { recursive: true });
    await installCoreProductionDependencies(f.source, f.destination, pnpm).catch((error) => {
      throw new Error(error.stdout || error.stderr || error.message);
    });
    expect(await readFile(join(f.destination, 'pnpm-lock.yaml'), 'utf8')).toBe(frozenLock);
    expect(JSON.parse(await readFile(join(f.destination, 'node_modules/runtime-dependency/package.json'), 'utf8')).version).toBe('1.0.0');
    expect(await stat(join(f.destination, 'node_modules/development-dependency')).catch(() => null)).toBeNull();
    expect(await stat(join(f.destination, 'node_modules/runtime-dependency/lifecycle-ran')).catch(() => null)).toBeNull();
    expect(await stat(join(f.destination, 'lifecycle-ran')).catch(() => null)).toBeNull();
    // Four real pnpm subprocesses need more than 5 seconds on Windows CI.
  }, 30_000);

  it('rejects a lockfile that differs from the audited overrides without resolving a new graph', async () => {
    const f = await fixture({ mismatchedLock: true });
    await expect(installCoreProductionDependencies(f.source, f.destination, pnpm))
      .rejects.toMatchObject({ stdout: expect.stringContaining('ERR_PNPM_LOCKFILE_CONFIG_MISMATCH') });
    expect(await readFile(join(f.destination, 'pnpm-lock.yaml'), 'utf8')).toBe(f.lock);
    expect(await stat(join(f.destination, 'pnpm-workspace.yaml')).catch(() => null)).toBeNull();
    expect(await stat(join(f.destination, 'lifecycle-ran')).catch(() => null)).toBeNull();
  });

  it('rejects a source configuration symlink before starting installation', async () => {
    const f = await fixture({ workspace: false });
    await symlink(resolve(f.parent, 'pnpm-workspace.yaml'), join(f.source, 'pnpm-workspace.yaml'));
    await expect(installCoreProductionDependencies(f.source, f.destination, pnpm))
      .rejects.toThrow('Core pnpm-workspace.yaml must be a regular file');
    expect(await stat(join(f.destination, 'node_modules')).catch(() => null)).toBeNull();
  });
});
