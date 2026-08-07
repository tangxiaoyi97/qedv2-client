import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const workspaceRoot = resolve(desktopRoot, '../..');
const coreSource = resolve(process.env.QED2_CORE_SOURCE ?? resolve(workspaceRoot, '../qedv2-core'));
const bankSource = resolve(process.env.QED2_BANK_SOURCE ?? resolve(workspaceRoot, '../srdpmppr'));
const target = resolve(desktopRoot, 'runtime');
const stage = resolve(desktopRoot, `.runtime-stage-${process.pid}`);
const backup = resolve(desktopRoot, '.runtime-previous');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const MAX_RUNTIME_ENTRIES = 100_000;
const HASH_CONCURRENCY = 8;

const INTEGRITY_ROOTS = [
  'core/dist',
  'core/node_modules',
  'bank/content',
  'bank/assets',
  'bank/schema',
];
const INTEGRITY_FILES = ['core/package.json', 'core/pnpm-lock.yaml', 'bank/VERSION'];

async function mustDirectory(path, label) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${label} is missing: ${path}`);
}

function gitCommit(path, overrideName) {
  const override = process.env[overrideName]?.trim();
  if (override) return override;
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function assertCleanGitCheckout(repositoryPath, label) {
  const status = execFileSync(
    'git',
    ['-C', repositoryPath, 'status', '--porcelain=v1', '--untracked-files=all'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ).trim();
  if (status) {
    throw new Error(`${label} checkout contains uncommitted files and cannot represent an immutable commit`);
  }
}

function trackedBankFiles() {
  const output = execFileSync(
    'git',
    [
      '-C',
      bankSource,
      'ls-files',
      '-z',
      '--',
      'content',
      'assets',
      'schema',
      'LICENSE',
      'README.md',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return output.split('\0').filter(Boolean);
}

async function collectJsonFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collectJsonFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.json')) result.push(path);
  }
  return result;
}

async function bankSchemaVersions(contentDirectory) {
  const versions = new Set();
  for (const path of await collectJsonFiles(contentDirectory)) {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!Number.isInteger(value.schemaVersion)) throw new Error(`Missing schemaVersion: ${path}`);
    versions.add(value.schemaVersion);
  }
  return [...versions].sort((a, b) => a - b);
}

async function copyBank(destination, commit) {
  await mkdir(destination, { recursive: true });
  for (const name of ['content', 'assets', 'schema']) {
    await mustDirectory(resolve(bankSource, name), `Question bank ${name}`);
  }
  const trackedFiles = trackedBankFiles();
  for (const requiredRoot of ['content/', 'assets/', 'schema/']) {
    if (!trackedFiles.some((file) => file.startsWith(requiredRoot))) {
      throw new Error(`Question bank has no tracked files under ${requiredRoot}`);
    }
  }
  for (const relativePath of trackedFiles) {
    if (
      isAbsolute(relativePath) ||
      relativePath.includes('\\') ||
      relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error(`Question bank contains an unsafe tracked path: ${relativePath}`);
    }
    const source = resolve(bankSource, ...relativePath.split('/'));
    const destinationPath = resolve(destination, ...relativePath.split('/'));
    if (!isWithin(bankSource, source) || !isWithin(destination, destinationPath)) {
      throw new Error(`Question bank path escaped its allowed root: ${relativePath}`);
    }
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Question bank tracked entry is not a regular file: ${relativePath}`);
    }
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(source, destinationPath, { force: false, errorOnExist: true });
  }
  // qed2-core reads VERSION when the packaged bank intentionally has no .git.
  await writeFile(resolve(destination, 'VERSION'), `${commit}\n`, 'utf8');
}

function portablePath(path) {
  return path.split(sep).join('/');
}

function isWithin(root, candidate) {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function isCoveredPath(path) {
  return INTEGRITY_FILES.includes(path) || INTEGRITY_ROOTS.some((root) => path.startsWith(`${root}/`));
}

async function mapLimit(values, concurrency, worker) {
  const result = new Array(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        result[index] = await worker(values[index]);
      }
    }),
  );
  return result;
}

async function collectIntegrityCandidates(runtimeRoot) {
  const candidates = [];
  const visit = async (absolutePath, manifestPath) => {
    const info = await lstat(absolutePath);
    if (info.isDirectory()) {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const entry of entries) {
        await visit(resolve(absolutePath, entry.name), `${manifestPath}/${entry.name}`);
      }
      return;
    }
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`Unsupported runtime entry type: ${manifestPath}`);
    }
    candidates.push({ absolutePath, path: manifestPath, info });
    if (candidates.length > MAX_RUNTIME_ENTRIES) {
      throw new Error(`Runtime contains more than ${MAX_RUNTIME_ENTRIES} integrity entries`);
    }
  };

  for (const manifestPath of ['core', 'bank']) {
    const info = await lstat(resolve(runtimeRoot, manifestPath));
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Required runtime directory is not regular: ${manifestPath}`);
    }
  }

  for (const manifestPath of INTEGRITY_ROOTS) {
    const absolutePath = resolve(runtimeRoot, ...manifestPath.split('/'));
    const info = await lstat(absolutePath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Required runtime tree is not a regular directory: ${manifestPath}`);
    }
    await visit(absolutePath, manifestPath);
  }
  for (const manifestPath of INTEGRITY_FILES) {
    const absolutePath = resolve(runtimeRoot, ...manifestPath.split('/'));
    const info = await lstat(absolutePath);
    if (!info.isFile()) throw new Error(`Required runtime file is not regular: ${manifestPath}`);
    candidates.push({ absolutePath, path: manifestPath, info });
  }
  candidates.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return candidates;
}

async function integrityRecord(runtimeRealRoot, candidate) {
  if (candidate.info.isSymbolicLink()) {
    const target = await readlink(candidate.absolutePath);
    if (isAbsolute(target)) {
      throw new Error(`Runtime symlink uses a non-relocatable absolute target: ${candidate.path}`);
    }
    const resolvedTarget = await realpath(candidate.absolutePath).catch(() => undefined);
    if (!resolvedTarget || !isWithin(runtimeRealRoot, resolvedTarget)) {
      throw new Error(`Runtime symlink escapes the staged runtime: ${candidate.path} -> ${target}`);
    }
    const targetPath = portablePath(relative(runtimeRealRoot, resolvedTarget));
    if (!isCoveredPath(targetPath)) {
      throw new Error(`Runtime symlink points outside integrity-protected trees: ${candidate.path}`);
    }
    const bytes = Buffer.from(target, 'utf8');
    return {
      path: portablePath(candidate.path),
      type: 'symlink',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  const content = await readFile(candidate.absolutePath);
  return {
    path: portablePath(candidate.path),
    type: 'file',
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

async function createIntegrityInventory(runtimeRoot) {
  const candidates = await collectIntegrityCandidates(runtimeRoot);
  const runtimeRealRoot = await realpath(runtimeRoot);
  return await mapLimit(candidates, HASH_CONCURRENCY, (candidate) =>
    integrityRecord(runtimeRealRoot, candidate),
  );
}

function sameIntegrityInventory(expected, actual) {
  return (
    expected.length === actual.length &&
    expected.every(
      (file, index) =>
        file.path === actual[index]?.path &&
        file.type === actual[index]?.type &&
        file.size === actual[index]?.size &&
        file.sha256 === actual[index]?.sha256,
    )
  );
}

async function recoverInterruptedSwap() {
  const [current, previous] = await Promise.all([
    stat(target).catch(() => undefined),
    stat(backup).catch(() => undefined),
  ]);
  if (!current && previous?.isDirectory()) {
    await rename(backup, target);
    console.warn('Recovered the previous complete QED2 runtime after an interrupted swap');
  }
}

async function main() {
  await recoverInterruptedSwap();
  await Promise.all([
    mustDirectory(coreSource, 'Core source checkout'),
    mustDirectory(bankSource, 'Question bank checkout'),
  ]);
  assertCleanGitCheckout(coreSource, 'Core source');
  assertCleanGitCheckout(bankSource, 'Question bank');
  const corePackage = JSON.parse(await readFile(resolve(coreSource, 'package.json'), 'utf8'));
  if (corePackage.name !== 'qed2-core') throw new Error(`Unexpected core package: ${corePackage.name}`);
  const coreCommit = gitCommit(coreSource, 'QED2_CORE_COMMIT');
  const bankCommit = gitCommit(bankSource, 'QED2_BANK_COMMIT');
  if (!/^[0-9a-f]{40,64}$/i.test(coreCommit) || !/^[0-9a-f]{40,64}$/i.test(bankCommit)) {
    throw new Error('Full core and bank commits are required for a traceable desktop runtime');
  }

  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    if (process.env.QED2_SKIP_CORE_BUILD !== '1') {
      await runFile(pnpm, ['--dir', coreSource, 'build'], {
        env: { ...process.env, QED_BUILD_COMMIT: coreCommit },
        maxBuffer: 16 * 1024 * 1024,
      });
    }
    const stagedCore = resolve(stage, 'core');
    await mkdir(stagedCore, { recursive: true });
    await Promise.all([
      cp(resolve(coreSource, 'package.json'), resolve(stagedCore, 'package.json')),
      cp(resolve(coreSource, 'pnpm-lock.yaml'), resolve(stagedCore, 'pnpm-lock.yaml')),
    ]);
    await runFile(
      pnpm,
      [
        '--dir',
        stagedCore,
        'install',
        '--prod',
        '--frozen-lockfile',
        '--ignore-workspace',
        '--ignore-scripts',
        // A self-contained hoisted graph avoids relocatability problems from
        // platform-specific pnpm junctions in signed application resources.
        '--config.node-linker=hoisted',
        '--config.package-import-method=copy',
      ],
      { env: process.env, maxBuffer: 16 * 1024 * 1024 },
    );
    // Copy only the just-built, traceable output plus its production graph.
    // No Git, package manager or build tool is needed on an end-user machine.
    await cp(resolve(coreSource, 'dist'), resolve(stage, 'core/dist'), {
      recursive: true,
      force: true,
    });
    await stat(resolve(stage, 'core/dist/main.js'));
    await copyBank(resolve(stage, 'bank'), bankCommit);

    const schemaVersions = await bankSchemaVersions(resolve(stage, 'bank/content'));
    if (schemaVersions.some((version) => version < 2 || version > 3)) {
      throw new Error(`Bundled bank schema is incompatible with this Core: ${schemaVersions.join(', ')}`);
    }
    const stagedBuildInfo = JSON.parse(
      await readFile(resolve(stage, 'core/dist/build-info.json'), 'utf8'),
    );
    if (stagedBuildInfo.version !== corePackage.version || stagedBuildInfo.commit !== coreCommit) {
      throw new Error('Staged Core build provenance does not match its source commit and package version');
    }
    const stagedBankCommit = (await readFile(resolve(stage, 'bank/VERSION'), 'utf8')).trim();
    if (stagedBankCommit !== bankCommit) {
      throw new Error('Staged question-bank provenance does not match its source commit');
    }
    const files = await createIntegrityInventory(stage);
    const manifest = {
      formatVersion: 2,
      createdAt: new Date().toISOString(),
      core: { version: corePackage.version, commit: coreCommit, entry: 'dist/main.js' },
      bank: { commit: bankCommit, schemaVersions },
      files,
    };
    await writeFile(resolve(stage, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    // Re-read every protected byte after manifest creation. This is deliberately
    // independent from the first pass so a concurrent mutation or incomplete
    // copy can never be promoted merely because an inventory was emitted.
    const verifiedFiles = await createIntegrityInventory(stage);
    if (!sameIntegrityInventory(files, verifiedFiles)) {
      throw new Error('Staged runtime changed during integrity preparation');
    }

    // The old complete runtime remains in place until every new artifact and
    // manifest has been prepared. A failed preparation is therefore harmless.
    await rm(backup, { recursive: true, force: true });
    if (await stat(target).catch(() => undefined)) await rename(target, backup);
    try {
      await rename(stage, target);
    } catch (error) {
      if (await stat(backup).catch(() => undefined)) await rename(backup, target);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    console.log(
      `Prepared QED2 runtime: core ${corePackage.version} (${coreCommit.slice(0, 12)}), ` +
        `bank ${bankCommit.slice(0, 12)}, schemas ${schemaVersions.join('/')}`,
    );
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

await main();
