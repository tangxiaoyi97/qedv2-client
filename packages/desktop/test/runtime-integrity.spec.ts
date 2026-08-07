import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRuntime, type RuntimeDescriptor } from '../src/main/runtime-layout.js';
import {
  readRuntimeManifest,
  verifyRuntimeIntegrity,
  type RuntimeIntegrityFile,
  type RuntimeManifest,
} from '../src/main/runtime-integrity.js';

const CORE_COMMIT = 'a'.repeat(40);
const BANK_COMMIT = 'b'.repeat(40);
const temporaryDirectories: string[] = [];
const revisionObjectContent = '{"id":"example"}\n';
const revisionObjectSha = createHash('sha256').update(revisionObjectContent).digest('hex');
const revisionCatalog = JSON.stringify({
  formatVersion: 1,
  repository: 'https://github.com/tangxiaoyi97/srdpmppr',
  ref: 'pastpapers',
  pinnedCommit: BANK_COMMIT,
  commitOrder: [BANK_COMMIT],
  commits: {
    [BANK_COMMIT]: { questions: { example: {} }, assets: {} },
  },
  objects: {
    [revisionObjectSha]: {
      kind: 'question',
      bytes: Buffer.byteLength(revisionObjectContent),
      mimeType: 'application/json',
    },
  },
});

const fixtureFiles: Record<string, string> = {
  'core/package.json': JSON.stringify({ name: 'qed2-core', version: '1.9.0' }),
  'core/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'core/dist/main.js': 'console.log("core")\n',
  'core/dist/build-info.json': JSON.stringify({ version: '1.9.0', commit: CORE_COMMIT }),
  'core/node_modules/example/index.js': 'export const example = true\n',
  'bank/content/example.json': JSON.stringify({ id: 'example', schemaVersion: 2 }),
  'bank/assets/example.txt': 'asset\n',
  'bank/schema/question.ts': 'export interface Question {}\n',
  'bank/revisions/revision-catalog.v1.json': revisionCatalog,
  [`bank/revisions/objects/${revisionObjectSha.slice(0, 2)}/${revisionObjectSha.slice(2)}`]:
    revisionObjectContent,
  'bank/VERSION': `${BANK_COMMIT}\n`,
};

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function createFixture(options: { schemaVersions?: number[] } = {}): Promise<{
  resourcesPath: string;
  runtimeRoot: string;
  manifestPath: string;
  manifest: RuntimeManifest;
  descriptor: RuntimeDescriptor;
}> {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'qed2-runtime-integrity-'));
  temporaryDirectories.push(resourcesPath);
  const runtimeRoot = resolve(resourcesPath, 'runtime');
  for (const [path, content] of Object.entries(fixtureFiles)) {
    const absolutePath = resolve(runtimeRoot, ...path.split('/'));
    await mkdir(resolve(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, content);
  }
  const files: RuntimeIntegrityFile[] = [];
  for (const path of Object.keys(fixtureFiles).sort()) {
    const content = await readFile(resolve(runtimeRoot, ...path.split('/')));
    files.push({ path, type: 'file', size: content.byteLength, sha256: digest(content) });
  }
  const manifest: RuntimeManifest = {
    formatVersion: 3,
    createdAt: '2026-08-07T00:00:00.000Z',
    core: { version: '1.9.0', commit: CORE_COMMIT, entry: 'dist/main.js' },
    bank: { commit: BANK_COMMIT, schemaVersions: options.schemaVersions ?? [2] },
    revisions: {
      catalog: 'bank/revisions/revision-catalog.v1.json',
      formatVersion: 1,
      pinnedCommit: BANK_COMMIT,
      commitCount: 1,
      questionRevisionCount: 1,
      objectCount: 1,
      objectBytes: Buffer.byteLength(revisionObjectContent),
    },
    files,
  };
  const manifestPath = resolve(runtimeRoot, 'runtime-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    resourcesPath,
    runtimeRoot,
    manifestPath,
    manifest,
    descriptor: {
      runtimeRoot,
      coreDirectory: resolve(runtimeRoot, 'core'),
      coreEntry: resolve(runtimeRoot, 'core/dist/main.js'),
      bankDirectory: resolve(runtimeRoot, 'bank'),
      manifest,
      source: 'bundled',
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('bundled runtime integrity', () => {
  it('accepts a canonical manifest and verifies both critical anchors and the complete tree', async () => {
    const fixture = await createFixture();

    const runtime = await resolveRuntime({
      packaged: true,
      resourcesPath: fixture.resourcesPath,
      appPath: '/unused',
      env: {},
    });
    const result = await verifyRuntimeIntegrity(runtime, 'full');

    expect(runtime.manifest).toEqual(fixture.manifest);
    expect(result).toMatchObject({ mode: 'full', checkedFiles: Object.keys(fixtureFiles).length });
    expect(result.checkedBytes).toBeGreaterThan(0);
  });

  it('detects same-size tampering in a production dependency before Core launch', async () => {
    const fixture = await createFixture();
    await writeFile(resolve(fixture.runtimeRoot, 'core/node_modules/example/index.js'), 'export const example = null\n');

    await expect(verifyRuntimeIntegrity(fixture.descriptor, 'full')).rejects.toThrow(
      'integrity mismatch',
    );
  });

  it('detects both missing and unmanifested files in protected trees', async () => {
    const missing = await createFixture();
    await rm(resolve(missing.runtimeRoot, 'bank/assets/example.txt'));
    await expect(verifyRuntimeIntegrity(missing.descriptor, 'full')).rejects.toThrow(
      'inventory mismatch',
    );

    const extra = await createFixture();
    await writeFile(resolve(extra.runtimeRoot, 'core/dist/injected.js'), 'malicious\n');
    await expect(verifyRuntimeIntegrity(extra.descriptor, 'full')).rejects.toThrow(
      'inventory mismatch',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a manifest-listed symlink whose target is outside the protected runtime trees',
    async () => {
      const fixture = await createFixture();
      const target = resolve(fixture.runtimeRoot, 'unprotected.js');
      const linkPath = resolve(fixture.runtimeRoot, 'core/node_modules/unprotected-link.js');
      const linkTarget = '../../unprotected.js';
      await writeFile(target, 'module.exports = "not inventoried";\n');
      await symlink(linkTarget, linkPath);
      fixture.manifest.files.push({
        path: 'core/node_modules/unprotected-link.js',
        type: 'symlink',
        size: Buffer.byteLength(linkTarget),
        sha256: digest(Buffer.from(linkTarget)),
      });
      fixture.manifest.files.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );

      await expect(verifyRuntimeIntegrity(fixture.descriptor, 'full')).rejects.toThrow(
        'outside the integrity-protected trees',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects absolute symlinks that would break when the staged runtime is relocated',
    async () => {
      const fixture = await createFixture();
      const linkPath = resolve(fixture.runtimeRoot, 'core/node_modules/absolute-link.js');
      const linkTarget = resolve(fixture.runtimeRoot, 'core/dist/main.js');
      await symlink(linkTarget, linkPath);
      fixture.manifest.files.push({
        path: 'core/node_modules/absolute-link.js',
        type: 'symlink',
        size: Buffer.byteLength(linkTarget),
        sha256: digest(Buffer.from(linkTarget)),
      });
      fixture.manifest.files.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );

      await expect(verifyRuntimeIntegrity(fixture.descriptor, 'full')).rejects.toThrow(
        'non-relocatable absolute target',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a top-level Core directory redirected outside the verified runtime root',
    async () => {
      const fixture = await createFixture();
      const coreDirectory = resolve(fixture.runtimeRoot, 'core');
      const redirectedCore = resolve(fixture.resourcesPath, 'redirected-core');
      await rename(coreDirectory, redirectedCore);
      await symlink('../redirected-core', coreDirectory);

      await expect(verifyRuntimeIntegrity(fixture.descriptor, 'full')).rejects.toThrow(
        'runtime core directory is not a regular directory',
      );
    },
  );

  it('rejects unsafe manifest paths before resolving any bundled entry', async () => {
    const fixture = await createFixture();
    const unsafe = structuredClone(fixture.manifest) as RuntimeManifest;
    unsafe.files[0] = { ...unsafe.files[0]!, path: '../outside.js' };
    await writeFile(fixture.manifestPath, JSON.stringify(unsafe));

    await expect(readRuntimeManifest(fixture.manifestPath)).rejects.toThrow('unsafe or unscoped path');
  });

  it('cross-checks Core and bank commit provenance, not only file hashes', async () => {
    const fixture = await createFixture();
    const falseProvenance = structuredClone(fixture.manifest) as RuntimeManifest;
    falseProvenance.core.commit = 'c'.repeat(40);
    await writeFile(fixture.manifestPath, JSON.stringify(falseProvenance));

    await expect(
      resolveRuntime({
        packaged: true,
        resourcesPath: fixture.resourcesPath,
        appPath: '/unused',
        env: {},
      }),
    ).rejects.toThrow('build provenance');
  });

  it('cross-checks every bank content schema during a full verification', async () => {
    const fixture = await createFixture({ schemaVersions: [3] });

    await expect(verifyRuntimeIntegrity(fixture.descriptor, 'full')).rejects.toThrow(
      'schema versions',
    );
  });

  it('rejects legacy v2 manifests without the immutable revision vault contract', async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({ ...fixture.manifest, formatVersion: 2, revisions: undefined }),
    );

    await expect(readRuntimeManifest(fixture.manifestPath)).rejects.toThrow(
      'unsupported integrity format',
    );
  });
});
