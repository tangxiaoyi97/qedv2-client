import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type { RuntimeDescriptor } from './runtime-layout.js';

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_BANK_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_ENTRIES = 100_000;
const HASH_CONCURRENCY = 8;
const STREAM_HASH_THRESHOLD_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/i;
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REVISION_CATALOG_PATH = 'bank/revisions/revision-catalog.v1.json';
const BANK_MANIFEST_PATH = 'bank/manifest.v2.json';
const BANK_MANIFEST_FORMAT = 2;
const BANK_WIRE_CONTRACT_VERSION = 1;

const INTEGRITY_ROOTS = [
  'core/dist',
  'core/node_modules',
  'bank/content',
  'bank/assets',
  'bank/schema',
  'bank/revisions',
] as const;
const OPTIONAL_INTEGRITY_ROOTS: readonly string[] = ['bank/reference'];
const INTEGRITY_FILES = [
  'core/package.json',
  'core/pnpm-lock.yaml',
  'bank/VERSION',
  BANK_MANIFEST_PATH,
] as const;

export interface RuntimeIntegrityFile {
  path: string;
  type: 'file' | 'symlink';
  size: number;
  sha256: string;
}

export interface RuntimeManifest {
  formatVersion: 3;
  createdAt: string;
  core: { version: string; commit: string; entry: string };
  bank: {
    commit: string;
    manifest: typeof BANK_MANIFEST_PATH;
    manifestFormatVersion: typeof BANK_MANIFEST_FORMAT;
    wireContractVersion: typeof BANK_WIRE_CONTRACT_VERSION;
    rootSha256: string;
    schemaVersions: number[];
  };
  revisions: {
    catalog: typeof REVISION_CATALOG_PATH;
    formatVersion: 1;
    pinnedCommit: string;
    commitCount: number;
    questionRevisionCount: number;
    objectCount: number;
    objectBytes: number;
  };
  files: RuntimeIntegrityFile[];
}

export interface RuntimeIntegrityResult {
  mode: 'light' | 'full';
  checkedFiles: number;
  checkedBytes: number;
}

export class RuntimeIntegrityError extends Error {
  readonly code = 'RUNTIME_INTEGRITY_FAILED';
  readonly requiresSignedReinstall = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeIntegrityError';
  }
}

export function isRuntimeIntegrityError(error: unknown): error is RuntimeIntegrityError {
  return (
    error instanceof RuntimeIntegrityError ||
    (error instanceof Error && (error as Error & { code?: string }).code === 'RUNTIME_INTEGRITY_FAILED')
  );
}

function fail(message: string, cause?: unknown): never {
  throw new RuntimeIntegrityError(message, cause === undefined ? undefined : { cause });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function hasCanonicalKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.every((key, index) => index === 0 || keys[index - 1]! < key);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  );
}

function safeBankRepositoryPath(value: unknown, root: 'content' | 'assets', suffix: string): value is string {
  return (
    safeManifestPath(value) &&
    value.startsWith(`${root}/`) &&
    value.endsWith(suffix) &&
    value.split('/').every((part) => !part.startsWith('.'))
  );
}

function safeManifestPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) return false;
  if (value.includes('\\') || value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith('/') || value.endsWith('/') || posix.normalize(value) !== value) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && part.length <= 255);
}

function isCoveredPath(path: string): boolean {
  return (
    (INTEGRITY_FILES as readonly string[]).includes(path) ||
    [...INTEGRITY_ROOTS, ...OPTIONAL_INTEGRITY_ROOTS].some((root) => path.startsWith(`${root}/`))
  );
}

function parseManifest(value: unknown): RuntimeManifest {
  if (!isObject(value) || value.formatVersion !== 3) {
    fail('The bundled runtime manifest is missing or uses an unsupported integrity format.');
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    fail('The bundled runtime manifest has an invalid creation timestamp.');
  }
  if (!isObject(value.core) || !isObject(value.bank) || !isObject(value.revisions)) {
    fail('The bundled runtime manifest has invalid Core, bank, or revision metadata.');
  }
  const coreVersion = value.core.version;
  const coreCommit = value.core.commit;
  const coreEntry = value.core.entry;
  const bankCommit = value.bank.commit;
  const bankManifest = value.bank.manifest;
  const bankManifestFormatVersion = value.bank.manifestFormatVersion;
  const bankWireContractVersion = value.bank.wireContractVersion;
  const bankRootSha256 = value.bank.rootSha256;
  const schemaVersions = value.bank.schemaVersions;
  const revisionCatalog = value.revisions.catalog;
  const revisionFormatVersion = value.revisions.formatVersion;
  const revisionPinnedCommit = value.revisions.pinnedCommit;
  const revisionCommitCount = value.revisions.commitCount;
  const questionRevisionCount = value.revisions.questionRevisionCount;
  const revisionObjectCount = value.revisions.objectCount;
  const revisionObjectBytes = value.revisions.objectBytes;
  if (typeof coreVersion !== 'string' || coreVersion.length === 0 || coreVersion.length > 100) {
    fail('The bundled runtime manifest has an invalid Core version.');
  }
  if (typeof coreCommit !== 'string' || !COMMIT_PATTERN.test(coreCommit)) {
    fail('The bundled runtime manifest does not contain a full Core commit.');
  }
  if (typeof bankCommit !== 'string' || !FULL_GIT_SHA_PATTERN.test(bankCommit)) {
    fail('The bundled runtime manifest does not contain a full question-bank commit.');
  }
  if (
    bankManifest !== BANK_MANIFEST_PATH ||
    bankManifestFormatVersion !== BANK_MANIFEST_FORMAT ||
    bankWireContractVersion !== BANK_WIRE_CONTRACT_VERSION ||
    typeof bankRootSha256 !== 'string' ||
    !SHA256_PATTERN.test(bankRootSha256)
  ) {
    fail('The bundled runtime manifest has invalid Bank Manifest v2 metadata.');
  }
  if (
    revisionCatalog !== REVISION_CATALOG_PATH ||
    revisionFormatVersion !== 1 ||
    typeof revisionPinnedCommit !== 'string' ||
    !FULL_GIT_SHA_PATTERN.test(revisionPinnedCommit) ||
    revisionPinnedCommit !== bankCommit ||
    !Number.isSafeInteger(revisionCommitCount) ||
    (revisionCommitCount as number) <= 0 ||
    !Number.isSafeInteger(questionRevisionCount) ||
    (questionRevisionCount as number) <= 0 ||
    !Number.isSafeInteger(revisionObjectCount) ||
    (revisionObjectCount as number) <= 0 ||
    !Number.isSafeInteger(revisionObjectBytes) ||
    (revisionObjectBytes as number) < 0
  ) {
    fail('The bundled runtime manifest has invalid immutable-revision metadata.');
  }
  if (!safeManifestPath(coreEntry) || !coreEntry.startsWith('dist/')) {
    fail('The bundled runtime manifest contains an unsafe Core entry path.');
  }
  if (
    !Array.isArray(schemaVersions) ||
    schemaVersions.length === 0 ||
    schemaVersions.some((version) => !Number.isInteger(version) || version < 2 || version > 4) ||
    schemaVersions.some((version, index) => index > 0 && version <= schemaVersions[index - 1]!)
  ) {
    fail('The bundled runtime manifest contains unsupported or non-canonical schema versions.');
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_RUNTIME_ENTRIES) {
    fail('The bundled runtime manifest has an invalid integrity inventory size.');
  }

  const files: RuntimeIntegrityFile[] = [];
  let priorPath = '';
  for (const rawFile of value.files) {
    if (!isObject(rawFile)) fail('The bundled runtime manifest contains an invalid file record.');
    const path = rawFile.path;
    const type = rawFile.type;
    const size = rawFile.size;
    const sha256 = rawFile.sha256;
    if (!safeManifestPath(path) || !isCoveredPath(path)) {
      fail(`The bundled runtime manifest contains an unsafe or unscoped path: ${String(path)}`);
    }
    if (path <= priorPath) {
      fail(`The bundled runtime manifest contains duplicate or non-canonical paths near: ${path}`);
    }
    if (type !== 'file' && type !== 'symlink') {
      fail(`The bundled runtime manifest contains an unsupported entry type: ${path}`);
    }
    if (!Number.isSafeInteger(size) || (size as number) < 0) {
      fail(`The bundled runtime manifest contains an invalid size: ${path}`);
    }
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      fail(`The bundled runtime manifest contains an invalid SHA-256 digest: ${path}`);
    }
    files.push({ path, type, size: size as number, sha256 });
    priorPath = path;
  }

  const paths = new Map(files.map((file) => [file.path, file]));
  const requiredFiles = [
    ...INTEGRITY_FILES,
    `core/${coreEntry}`,
    'core/dist/build-info.json',
    REVISION_CATALOG_PATH,
  ];
  for (const path of requiredFiles) {
    if (paths.get(path)?.type !== 'file') fail(`Required runtime file is absent from the manifest: ${path}`);
  }
  const protectedBankManifest = paths.get(BANK_MANIFEST_PATH)!;
  if (protectedBankManifest.size <= 0 || protectedBankManifest.size > MAX_BANK_MANIFEST_BYTES) {
    fail('Bank Manifest v2 has an unsafe size.');
  }
  for (const root of INTEGRITY_ROOTS) {
    if (!files.some((file) => file.path.startsWith(`${root}/`))) {
      fail(`Required runtime tree is absent from the manifest: ${root}`);
    }
  }

  return {
    formatVersion: 3,
    createdAt: value.createdAt,
    core: { version: coreVersion, commit: coreCommit, entry: coreEntry },
    bank: {
      commit: bankCommit,
      manifest: BANK_MANIFEST_PATH,
      manifestFormatVersion: BANK_MANIFEST_FORMAT,
      wireContractVersion: BANK_WIRE_CONTRACT_VERSION,
      rootSha256: bankRootSha256,
      schemaVersions: [...schemaVersions] as number[],
    },
    revisions: {
      catalog: REVISION_CATALOG_PATH,
      formatVersion: 1,
      pinnedCommit: revisionPinnedCommit,
      commitCount: revisionCommitCount as number,
      questionRevisionCount: questionRevisionCount as number,
      objectCount: revisionObjectCount as number,
      objectBytes: revisionObjectBytes as number,
    },
    files,
  };
}

export async function readRuntimeManifest(path: string): Promise<RuntimeManifest> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_MANIFEST_BYTES) {
      fail('The bundled runtime manifest has an unsafe size.');
    }
    return parseManifest(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    if (isRuntimeIntegrityError(error)) throw error;
    fail('The bundled runtime manifest is missing, unreadable, or malformed.', error);
  }
}

interface IntegrityCandidate {
  absolutePath: string;
  path: string;
  info: Stats;
}

function runtimePath(runtimeRoot: string, path: string): string {
  if (!safeManifestPath(path)) fail(`Unsafe runtime path: ${path}`);
  const candidate = resolve(runtimeRoot, ...path.split('/'));
  const child = relative(runtimeRoot, candidate);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`Runtime path escapes its bundled resource root: ${path}`);
  }
  return candidate;
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function collectCandidates(runtimeRoot: string): Promise<IntegrityCandidate[]> {
  const candidates: IntegrityCandidate[] = [];
  const visit = async (absolutePath: string, manifestPath: string): Promise<void> => {
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
      fail(`Unsupported entry exists in the bundled runtime: ${manifestPath}`);
    }
    candidates.push({ absolutePath, path: manifestPath, info });
    if (candidates.length > MAX_RUNTIME_ENTRIES) {
      fail(`The bundled runtime exceeds the ${MAX_RUNTIME_ENTRIES}-entry integrity limit.`);
    }
  };

  for (const root of [...INTEGRITY_ROOTS, ...OPTIONAL_INTEGRITY_ROOTS]) {
    const rootPath = runtimePath(runtimeRoot, root);
    const info = await lstat(rootPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && OPTIONAL_INTEGRITY_ROOTS.includes(root)) return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`Required runtime tree is not a directory: ${root}`);
    await visit(rootPath, root);
  }
  for (const path of INTEGRITY_FILES) {
    const absolutePath = runtimePath(runtimeRoot, path);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) fail(`Required runtime file is not regular: ${path}`);
    candidates.push({ absolutePath, path, info });
  }
  candidates.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return candidates;
}

async function validatePhysicalLayout(runtimeRoot: string): Promise<void> {
  for (const path of ['', 'core', 'bank']) {
    const label = path === '' ? 'runtime root' : `runtime ${path} directory`;
    const absolutePath = path === '' ? runtimeRoot : runtimePath(runtimeRoot, path);
    const info = await lstat(absolutePath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(`Required ${label} is not a regular directory.`);
    }
  }
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        result[index] = await worker(values[index]!);
      }
    }),
  );
  return result;
}

async function hashCandidate(
  runtimeRealRoot: string,
  candidate: IntegrityCandidate,
): Promise<RuntimeIntegrityFile> {
  const current = await lstat(candidate.absolutePath);
  if (current.isSymbolicLink()) {
    const target = await readlink(candidate.absolutePath);
    if (isAbsolute(target)) {
      fail(`Runtime symlink uses a non-relocatable absolute target: ${candidate.path}`);
    }
    const resolvedTarget = await realpath(candidate.absolutePath).catch(() => undefined);
    if (!resolvedTarget || !isWithin(runtimeRealRoot, resolvedTarget)) {
      fail(`Runtime symlink is broken or escapes application resources: ${candidate.path}`);
    }
    const targetPath = relative(runtimeRealRoot, resolvedTarget).split(sep).join('/');
    if (!safeManifestPath(targetPath) || !isCoveredPath(targetPath)) {
      fail(`Runtime symlink points outside the integrity-protected trees: ${candidate.path}`);
    }
    const bytes = Buffer.from(target, 'utf8');
    return {
      path: candidate.path,
      type: 'symlink',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  if (!current.isFile()) fail(`Runtime file changed type during verification: ${candidate.path}`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    if (current.size <= STREAM_HASH_THRESHOLD_BYTES) {
      const content = await readFile(candidate.absolutePath);
      size = content.byteLength;
      hash.update(content);
    } else {
      for await (const chunk of createReadStream(candidate.absolutePath)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        hash.update(bytes);
      }
    }
  } catch (error) {
    fail(`Runtime file became unreadable during verification: ${candidate.path}`, error);
  }
  const after = await lstat(candidate.absolutePath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== current.dev ||
    after.ino !== current.ino ||
    after.size !== current.size ||
    after.mtimeMs !== current.mtimeMs ||
    after.ctimeMs !== current.ctimeMs
  ) {
    fail(`Runtime file changed during verification: ${candidate.path}`);
  }
  return {
    path: candidate.path,
    type: 'file',
    size,
    sha256: hash.digest('hex'),
  };
}

function compareRecord(expected: RuntimeIntegrityFile, actual: RuntimeIntegrityFile): void {
  if (
    actual.type !== expected.type ||
    actual.size !== expected.size ||
    actual.sha256 !== expected.sha256
  ) {
    fail(`Bundled runtime integrity mismatch: ${expected.path}`);
  }
}

async function verifyRevisionCatalogMetadata(
  runtimeRoot: string,
  manifest: RuntimeManifest,
): Promise<void> {
  let catalog: unknown;
  try {
    catalog = JSON.parse(
      await readFile(runtimePath(runtimeRoot, manifest.revisions.catalog), 'utf8'),
    ) as unknown;
  } catch (error) {
    fail('The immutable revision catalog is malformed.', error);
  }
  if (
    !isObject(catalog) ||
    catalog.formatVersion !== manifest.revisions.formatVersion ||
    catalog.pinnedCommit !== manifest.bank.commit ||
    !Array.isArray(catalog.commitOrder) ||
    !isObject(catalog.commits) ||
    !isObject(catalog.objects)
  ) {
    fail('The immutable revision catalog does not match the bundled runtime manifest.');
  }
  const commitOrder = catalog.commitOrder;
  if (
    commitOrder.length !== manifest.revisions.commitCount ||
    commitOrder.at(-1) !== manifest.bank.commit ||
    commitOrder.some((commit) => typeof commit !== 'string' || !FULL_GIT_SHA_PATTERN.test(commit)) ||
    new Set(commitOrder).size !== commitOrder.length
  ) {
    fail('The immutable revision catalog has an invalid commit inventory.');
  }
  const commitKeys = Object.keys(catalog.commits).sort();
  const orderedCommitKeys = [...commitOrder].sort();
  if (
    commitKeys.length !== orderedCommitKeys.length ||
    commitKeys.some((commit, index) => commit !== orderedCommitKeys[index])
  ) {
    fail('The immutable revision catalog has an incomplete commit inventory.');
  }

  let questionRevisionCount = 0;
  for (const commit of commitOrder) {
    const record = catalog.commits[commit as string];
    if (!isObject(record) || !isObject(record.questions) || !isObject(record.assets)) {
      fail(`The immutable revision catalog has invalid metadata for ${String(commit)}.`);
    }
    questionRevisionCount += Object.keys(record.questions).length;
  }
  if (questionRevisionCount !== manifest.revisions.questionRevisionCount) {
    fail('The immutable revision catalog question inventory does not match the runtime manifest.');
  }

  const objects = Object.entries(catalog.objects);
  if (objects.length !== manifest.revisions.objectCount) {
    fail('The immutable revision catalog object inventory does not match the runtime manifest.');
  }
  const manifestFiles = new Map(manifest.files.map((file) => [file.path, file]));
  const revisionFiles = manifest.files.filter((file) => file.path.startsWith('bank/revisions/'));
  if (revisionFiles.length !== objects.length + 1) {
    fail('The immutable revision vault contains files outside its catalog.');
  }
  let objectBytes = 0;
  for (const [sha256, record] of objects) {
    if (
      !SHA256_PATTERN.test(sha256) ||
      !isObject(record) ||
      !Number.isSafeInteger(record.bytes) ||
      (record.bytes as number) < 0
    ) {
      fail(`The immutable revision catalog has invalid object metadata: ${sha256}.`);
    }
    const path = `bank/revisions/objects/${sha256.slice(0, 2)}/${sha256.slice(2)}`;
    const file = manifestFiles.get(path);
    if (
      file?.type !== 'file' ||
      file.size !== record.bytes ||
      file.sha256 !== sha256
    ) {
      fail(`The immutable revision object does not match its content address: ${sha256}.`);
    }
    objectBytes += record.bytes as number;
  }
  if (objectBytes !== manifest.revisions.objectBytes) {
    fail('The immutable revision catalog byte count does not match the runtime manifest.');
  }
}

async function verifyBankManifestMetadata(
  runtimeRoot: string,
  manifest: RuntimeManifest,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(runtimePath(runtimeRoot, manifest.bank.manifest), 'utf8'),
    ) as unknown;
  } catch (error) {
    fail('Bank Manifest v2 is malformed.', error);
  }
  if (
    !isObject(value) ||
    value.formatVersion !== manifest.bank.manifestFormatVersion ||
    value.wireContractVersion !== manifest.bank.wireContractVersion ||
    !isObject(value.bank) ||
    !isObject(value.questions) ||
    !isObject(value.assets) ||
    !hasExactKeys(value, ['formatVersion', 'wireContractVersion', 'bank', 'questions', 'assets'])
  ) {
    fail('Bank Manifest v2 does not match the bundled runtime manifest.');
  }
  const bank = value.bank;
  if (
    bank.commit !== manifest.bank.commit ||
    bank.rootSha256 !== manifest.bank.rootSha256 ||
    !isObject(bank.schema) ||
    !hasExactKeys(bank, ['commit', 'rootSha256', 'schema', 'immutableAssetBaseUrl']) ||
    !hasExactKeys(bank.schema, ['path', 'sha256']) ||
    bank.schema.path !== 'schema/question.ts' ||
    typeof bank.schema.sha256 !== 'string' ||
    !SHA256_PATTERN.test(bank.schema.sha256) ||
    bank.immutableAssetBaseUrl !== `/content/banks/${manifest.bank.commit}/assets`
  ) {
    fail('Bank Manifest v2 contains invalid or unattested bank metadata.');
  }
  const questions = value.questions;
  const assets = value.assets;
  if (
    Object.keys(questions).length === 0 ||
    Object.keys(assets).length === 0 ||
    !hasCanonicalKeys(questions) ||
    !hasCanonicalKeys(assets)
  ) {
    fail('Bank Manifest v2 contains an empty or non-canonical inventory.');
  }

  const inventory = new Map(manifest.files.map((file) => [file.path, file]));
  const questionPaths = new Set<string>();
  for (const [id, record] of Object.entries(questions)) {
    const recordAssets = isObject(record) && Array.isArray(record.assets) ? record.assets : undefined;
    if (
      id.length === 0 ||
      id.length > 255 ||
      /[\u0000-\u001f\u007f]/.test(id) ||
      !isObject(record) ||
      !hasExactKeys(record, ['path', 'rawSha256', 'wireSha256', 'assets']) ||
      !safeBankRepositoryPath(record.path, 'content', '.json') ||
      questionPaths.has(record.path) ||
      typeof record.rawSha256 !== 'string' ||
      !SHA256_PATTERN.test(record.rawSha256) ||
      typeof record.wireSha256 !== 'string' ||
      !SHA256_PATTERN.test(record.wireSha256) ||
      !recordAssets ||
      recordAssets.some(
        (asset, index) =>
          typeof asset !== 'string' ||
          !Object.hasOwn(assets, asset) ||
          (index > 0 && typeof recordAssets[index - 1] === 'string' && recordAssets[index - 1] >= asset),
      )
    ) {
      fail(`Bank Manifest v2 contains an invalid question record: ${id}.`);
    }
    const file = inventory.get(`bank/${record.path}`);
    if (file?.type !== 'file' || file.sha256 !== record.rawSha256) {
      fail(`Bank Manifest v2 question bytes do not match the runtime inventory: ${id}.`);
    }
    questionPaths.add(record.path);
  }

  const assetPaths = new Set<string>();
  for (const [key, record] of Object.entries(assets)) {
    if (
      !safeBankRepositoryPath(`assets/${key}`, 'assets', '.png') ||
      !isObject(record) ||
      !hasExactKeys(record, ['path', 'bytes', 'mimeType', 'sha256']) ||
      record.path !== `assets/${key}` ||
      assetPaths.has(record.path) ||
      !Number.isSafeInteger(record.bytes) ||
      (record.bytes as number) <= 0 ||
      record.mimeType !== 'image/png' ||
      typeof record.sha256 !== 'string' ||
      !SHA256_PATTERN.test(record.sha256)
    ) {
      fail(`Bank Manifest v2 contains an invalid asset record: ${key}.`);
    }
    const file = inventory.get(`bank/${record.path}`);
    if (
      file?.type !== 'file' ||
      file.size !== record.bytes ||
      file.sha256 !== record.sha256
    ) {
      fail(`Bank Manifest v2 asset bytes do not match the runtime inventory: ${key}.`);
    }
    assetPaths.add(record.path);
  }

  const schemaFile = inventory.get('bank/schema/question.ts');
  if (schemaFile?.type !== 'file' || schemaFile.sha256 !== bank.schema.sha256) {
    fail('Bank Manifest v2 schema digest does not match the runtime inventory.');
  }
  const contentInventory = manifest.files
    .filter((file) => file.path.startsWith('bank/content/'))
    .map((file) => file.path.slice('bank/'.length));
  const assetInventory = manifest.files
    .filter((file) => file.path.startsWith('bank/assets/'))
    .map((file) => file.path.slice('bank/'.length));
  if (
    contentInventory.length !== questionPaths.size ||
    contentInventory.some((file) => !questionPaths.has(file)) ||
    assetInventory.length !== assetPaths.size ||
    assetInventory.some((file) => !assetPaths.has(file))
  ) {
    fail('Bank Manifest v2 does not cover the complete packaged bank inventory.');
  }
  const rootSha256 = canonicalSha256({
    wireContractVersion: value.wireContractVersion,
    schema: bank.schema,
    questions,
    assets,
  });
  if (rootSha256 !== manifest.bank.rootSha256) {
    fail('Bank Manifest v2 root does not match its canonical inventory.');
  }
}

async function verifyMetadata(
  runtimeRoot: string,
  manifest: RuntimeManifest,
  contentFiles?: readonly RuntimeIntegrityFile[],
): Promise<void> {
  let packageValue: unknown;
  let buildValue: unknown;
  try {
    packageValue = JSON.parse(await readFile(runtimePath(runtimeRoot, 'core/package.json'), 'utf8')) as unknown;
    buildValue = JSON.parse(
      await readFile(runtimePath(runtimeRoot, 'core/dist/build-info.json'), 'utf8'),
    ) as unknown;
  } catch (error) {
    fail('Core version or build provenance metadata is malformed.', error);
  }
  if (
    !isObject(packageValue) ||
    packageValue.name !== 'qed2-core' ||
    packageValue.version !== manifest.core.version
  ) {
    fail('Core package metadata does not match the bundled runtime manifest.');
  }
  if (
    !isObject(buildValue) ||
    buildValue.version !== manifest.core.version ||
    buildValue.commit !== manifest.core.commit
  ) {
    fail('Core build provenance does not match the bundled runtime manifest.');
  }
  const bankVersion = (await readFile(runtimePath(runtimeRoot, 'bank/VERSION'), 'utf8')).trim();
  if (bankVersion !== manifest.bank.commit) {
    fail('Question-bank provenance does not match the bundled runtime manifest.');
  }

  await verifyBankManifestMetadata(runtimeRoot, manifest);
  await verifyRevisionCatalogMetadata(runtimeRoot, manifest);

  if (!contentFiles) return;
  const schemaVersions = new Set<number>();
  for (const file of contentFiles) {
    if (file.type !== 'file' || !file.path.endsWith('.json')) continue;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(runtimePath(runtimeRoot, file.path), 'utf8')) as unknown;
    } catch (error) {
      fail(`Question-bank content is malformed: ${file.path}`, error);
    }
    if (!isObject(value) || !Number.isInteger(value.schemaVersion)) {
      fail(`Question-bank content has no valid schemaVersion: ${file.path}`);
    }
    schemaVersions.add(value.schemaVersion as number);
  }
  const actual = [...schemaVersions].sort((left, right) => left - right);
  if (
    actual.length !== manifest.bank.schemaVersions.length ||
    actual.some((version, index) => version !== manifest.bank.schemaVersions[index])
  ) {
    fail('Question-bank schema versions do not match the bundled runtime manifest.');
  }
}

function validateDescriptorLayout(runtime: RuntimeDescriptor, runtimeRoot: string): void {
  if (
    resolve(runtime.coreDirectory) !== runtimePath(runtimeRoot, 'core') ||
    resolve(runtime.bankDirectory) !== runtimePath(runtimeRoot, 'bank') ||
    resolve(runtime.coreEntry) !== runtimePath(runtimeRoot, `core/${runtime.manifest!.core.entry}`)
  ) {
    fail('Runtime descriptor paths do not match the bundled resource layout.');
  }
}

export async function verifyRuntimeIntegrity(
  runtime: RuntimeDescriptor,
  mode: 'light' | 'full' = 'full',
): Promise<RuntimeIntegrityResult> {
  if (runtime.source !== 'bundled') {
    return { mode, checkedFiles: 0, checkedBytes: 0 };
  }
  if (!runtime.manifest) {
    fail('No verifiable bundled runtime is available.');
  }
  const runtimeRoot = resolve(runtime.runtimeRoot ?? dirname(runtime.coreDirectory));
  validateDescriptorLayout(runtime, runtimeRoot);

  try {
    await validatePhysicalLayout(runtimeRoot);
    const runtimeRealRoot = await realpath(runtimeRoot);
    const expectedByPath = new Map(runtime.manifest.files.map((file) => [file.path, file]));
    if (mode === 'light') {
      const criticalPaths = [
        'core/package.json',
        'core/dist/build-info.json',
        `core/${runtime.manifest.core.entry}`,
        'bank/VERSION',
        runtime.manifest.bank.manifest,
        runtime.manifest.revisions.catalog,
      ];
      const actual = await mapLimit(criticalPaths, HASH_CONCURRENCY, async (path) => {
        const expected = expectedByPath.get(path);
        if (!expected) fail(`Critical runtime entry is absent from the manifest: ${path}`);
        const absolutePath = runtimePath(runtimeRoot, path);
        return await hashCandidate(runtimeRealRoot, {
          absolutePath,
          path,
          info: await lstat(absolutePath),
        });
      });
      for (const record of actual) compareRecord(expectedByPath.get(record.path)!, record);
      await verifyMetadata(runtimeRoot, runtime.manifest);
      return {
        mode,
        checkedFiles: actual.length,
        checkedBytes: actual.reduce((sum, file) => sum + file.size, 0),
      };
    }

    const candidates = await collectCandidates(runtimeRoot);
    if (candidates.length !== runtime.manifest.files.length) {
      fail(
        `Bundled runtime inventory mismatch: expected ${runtime.manifest.files.length} entries, found ${candidates.length}.`,
      );
    }
    for (let index = 0; index < candidates.length; index += 1) {
      if (candidates[index]!.path !== runtime.manifest.files[index]!.path) {
        fail(`Bundled runtime inventory mismatch near: ${candidates[index]!.path}`);
      }
    }
    const actual = await mapLimit(candidates, HASH_CONCURRENCY, (candidate) =>
      hashCandidate(runtimeRealRoot, candidate),
    );
    for (let index = 0; index < actual.length; index += 1) {
      compareRecord(runtime.manifest.files[index]!, actual[index]!);
    }
    await verifyMetadata(
      runtimeRoot,
      runtime.manifest,
      actual.filter((file) => file.path.startsWith('bank/content/')),
    );
    return {
      mode,
      checkedFiles: actual.length,
      checkedBytes: actual.reduce((sum, file) => sum + file.size, 0),
    };
  } catch (error) {
    if (isRuntimeIntegrityError(error)) throw error;
    fail('The bundled runtime is incomplete or unreadable.', error);
  }
}
