import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream, existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  statfs,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import {
  buildReleaseAssetUrl,
  fetchApprovedReleaseUrl,
  isApprovedReleaseAssetUrl,
  isCanonicalSha512,
  releaseFeedPatterns,
} from './release-feed.js';

const JOURNAL_FILENAME = 'download-journal.json';
const JOURNAL_FORMAT_VERSION = 1;
const DEFAULT_RESERVE_BYTES = 512 * 1024 * 1024;
const DEFAULT_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const DEFAULT_CHECKPOINT_MS = 2_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const PARTIAL_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const VERIFIED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const STRONG_ETAG_PATTERN = /^"[^"\r\n]*"$/;
const TERMINAL_DOWNLOAD_CODES = new Set([
  'ERR_DOWNLOAD_INTEGRITY',
  'ERR_DOWNLOAD_OVERSIZED',
  'ERR_DOWNLOAD_PROTOCOL',
  'ERR_UPDATER_REDIRECT_REJECTED',
]);

export interface ResumableDownloadLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface ArtifactDescriptor {
  fromVersion: string;
  targetVersion: string;
  releaseTag: string;
  assetName: string;
  size: number;
  sha256: string;
  sha512: string;
  installMode: 'manual-package' | 'self';
}

export type DownloadValidator =
  | { kind: 'etag'; value: string }
  | { kind: 'last-modified'; value: string }
  | null;

export interface DownloadJournalV1 {
  formatVersion: 1;
  state: 'partial' | 'verified';
  fromVersion: string;
  targetVersion: string;
  releaseTag: string;
  assetName: string;
  expectedSize: number;
  sha256: string;
  sha512: string;
  downloadedBytes: number;
  validator: DownloadValidator;
  createdAt: string;
  updatedAt: string;
  automaticAttempts: number;
  nextRetryAt?: string;
  lastErrorCode?: string;
  /** Automatic timers/network events must not retry until the user explicitly asks. */
  manualRetryRequired?: boolean;
}

export interface VerifiedArtifact {
  path: string;
  size: number;
  sha256: string;
  sha512: string;
  reused: boolean;
}

export interface ResumableArtifactDownloaderOptions {
  fetch?: typeof fetch;
  now?: () => number;
  reserveBytes?: number;
  checkpointBytes?: number;
  checkpointMs?: number;
  idleTimeoutMs?: number;
  availableBytes?: (directory: string) => Promise<number>;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code).toUpperCase()
    : undefined;
}

function codedDownloadError(message: string, code: string, detail?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSemver(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);
}

function validTimestamp(value: unknown, now: number): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now + MAX_CLOCK_SKEW_MS;
}

function validValidator(value: unknown): value is DownloadValidator {
  if (value === null) return true;
  if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.value !== 'string') return false;
  return value.kind === 'etag'
    ? STRONG_ETAG_PATTERN.test(value.value) && !value.value.startsWith('W/')
    : value.kind === 'last-modified' && Number.isFinite(Date.parse(value.value));
}

function parseJournal(value: unknown, now: number): DownloadJournalV1 | undefined {
  if (
    !isRecord(value) ||
    value.formatVersion !== JOURNAL_FORMAT_VERSION ||
    (value.state !== 'partial' && value.state !== 'verified') ||
    !validSemver(value.fromVersion) ||
    !validSemver(value.targetVersion) ||
    typeof value.releaseTag !== 'string' ||
    value.releaseTag !== `v${value.targetVersion}` ||
    typeof value.assetName !== 'string' ||
    !releaseFeedPatterns.assetName.test(value.assetName) ||
    !Number.isSafeInteger(value.expectedSize) ||
    (value.expectedSize as number) <= 0 ||
    (value.expectedSize as number) > 2 * 1024 * 1024 * 1024 ||
    typeof value.sha256 !== 'string' ||
    !releaseFeedPatterns.sha256.test(value.sha256) ||
    typeof value.sha512 !== 'string' ||
    !isCanonicalSha512(value.sha512) ||
    !Number.isSafeInteger(value.downloadedBytes) ||
    (value.downloadedBytes as number) < 0 ||
    (value.downloadedBytes as number) > (value.expectedSize as number) ||
    !validValidator(value.validator) ||
    !validTimestamp(value.createdAt, now) ||
    !validTimestamp(value.updatedAt, now) ||
    !Number.isInteger(value.automaticAttempts) ||
    (value.automaticAttempts as number) < 0 ||
    (value.automaticAttempts as number) > 10_000 ||
    (value.nextRetryAt !== undefined && !validTimestamp(value.nextRetryAt, now + 365 * 24 * 60 * 60 * 1_000)) ||
    (value.lastErrorCode !== undefined && (typeof value.lastErrorCode !== 'string' || value.lastErrorCode.length > 128)) ||
    (value.manualRetryRequired !== undefined && typeof value.manualRetryRequired !== 'boolean')
  ) return undefined;

  const age = now - Date.parse(value.updatedAt as string);
  const ttl = value.state === 'verified' ? VERIFIED_TTL_MS : PARTIAL_TTL_MS;
  if (age > ttl) return undefined;
  return value as unknown as DownloadJournalV1;
}

function sameDescriptor(journal: DownloadJournalV1, descriptor: ArtifactDescriptor): boolean {
  return (
    journal.fromVersion === descriptor.fromVersion &&
    journal.targetVersion === descriptor.targetVersion &&
    journal.releaseTag === descriptor.releaseTag &&
    journal.assetName === descriptor.assetName &&
    journal.expectedSize === descriptor.size &&
    journal.sha256 === descriptor.sha256 &&
    journal.sha512 === descriptor.sha512
  );
}

function clearAutomaticRecoveryFields(journal: DownloadJournalV1): DownloadJournalV1 {
  const cleared: DownloadJournalV1 = { ...journal, automaticAttempts: 0 };
  delete cleared.nextRetryAt;
  delete cleared.lastErrorCode;
  delete cleared.manualRetryRequired;
  return cleared;
}

function currentValidator(headers: Headers): DownloadValidator {
  const etag = headers.get('etag');
  if (etag && !etag.startsWith('W/') && STRONG_ETAG_PATTERN.test(etag)) {
    return { kind: 'etag', value: etag };
  }
  const lastModified = headers.get('last-modified');
  if (lastModified && Number.isFinite(Date.parse(lastModified))) {
    return { kind: 'last-modified', value: lastModified };
  }
  return null;
}

function validatorsEqual(expected: DownloadValidator, actual: DownloadValidator): boolean {
  return expected !== null && actual !== null && expected.kind === actual.kind && expected.value === actual.value;
}

function contentRange(value: string | null): { start: number; end: number; total: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return undefined;
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start! > end! || end! >= total!) return undefined;
  return { start: start!, end: end!, total: total! };
}

async function hashFile(path: string): Promise<{ sha256: string; sha512: string }> {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path, { highWaterMark: 1024 * 1024 });
    input.on('data', (chunk: string | Buffer) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sha256.update(bytes);
      sha512.update(bytes);
    });
    input.on('error', reject);
    input.on('end', resolvePromise);
  });
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

async function safeFileSize(path: string): Promise<number | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw codedDownloadError('Update cache entry is not a private regular file', 'ERR_DOWNLOAD_PROTOCOL');
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw codedDownloadError('Update cache entry has an unexpected owner', 'ERR_DOWNLOAD_PROTOCOL');
    }
    return info.size;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten <= 0) {
      throw codedDownloadError('Update cache write made no progress', 'EIO');
    }
    offset += bytesWritten;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows cannot fsync a directory handle. File fsync + atomic rename is
    // still the strongest primitive available there.
    if (process.platform !== 'win32') throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(codedDownloadError('Update download became idle', 'ETIMEDOUT')), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ResumableArtifactDownloader {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly reserveBytes: number;
  private readonly checkpointBytes: number;
  private readonly checkpointMs: number;
  private readonly idleTimeoutMs: number;
  private readonly availableBytes: (directory: string) => Promise<number>;
  private active = false;

  constructor(
    private readonly rootDirectory: string,
    private readonly logger: ResumableDownloadLogger,
    options: ResumableArtifactDownloaderOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.reserveBytes = options.reserveBytes ?? DEFAULT_RESERVE_BYTES;
    this.checkpointBytes = options.checkpointBytes ?? DEFAULT_CHECKPOINT_BYTES;
    this.checkpointMs = options.checkpointMs ?? DEFAULT_CHECKPOINT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.availableBytes = options.availableBytes ?? (async (directory) => {
      const info = await statfs(directory);
      return Number(info.bavail) * Number(info.bsize);
    });
  }

  hasRecoverySync(): boolean {
    return existsSync(this.journalPath());
  }

  async inspect(): Promise<DownloadJournalV1 | undefined> {
    await this.ensureRoot();
    return await this.readJournal();
  }

  async resetAutomaticRecovery(): Promise<void> {
    await this.ensureRoot();
    const journal = await this.readJournal();
    if (!journal || (
      journal.automaticAttempts === 0 &&
      journal.nextRetryAt === undefined &&
      journal.lastErrorCode === undefined &&
      journal.manualRetryRequired === undefined
    )) return;
    await this.writeJournal({
      ...clearAutomaticRecoveryFields(journal),
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  async recordAutomaticFailure(
    code: string,
    retryAt?: number,
    minimumAttempts = 0,
  ): Promise<DownloadJournalV1 | undefined> {
    await this.ensureRoot();
    const journal = await this.readJournal();
    if (!journal) return undefined;
    const normalizedCode = /^[A-Z0-9_]{1,128}$/.test(code) ? code : 'APP_UPDATE_DOWNLOAD_FAILED';
    const now = this.now();
    const boundedRetryAt = retryAt !== undefined && Number.isFinite(retryAt)
      ? Math.min(Math.max(retryAt, now), now + 365 * 24 * 60 * 60 * 1_000)
      : undefined;
    const boundedMinimumAttempts = Number.isInteger(minimumAttempts) && minimumAttempts >= 0
      ? Math.min(minimumAttempts, 10_000)
      : 0;
    const manualRetryRequired = normalizedCode === 'APP_UPDATE_STORAGE_UNAVAILABLE';
    const next: DownloadJournalV1 = {
      ...journal,
      automaticAttempts: manualRetryRequired
        ? journal.automaticAttempts
        : Math.min(Math.max(journal.automaticAttempts + 1, boundedMinimumAttempts), 10_000),
      lastErrorCode: normalizedCode,
      updatedAt: new Date(now).toISOString(),
      ...(boundedRetryAt === undefined ? {} : { nextRetryAt: new Date(boundedRetryAt).toISOString() }),
      ...(manualRetryRequired ? { manualRetryRequired: true } : {}),
    };
    if (boundedRetryAt === undefined) delete next.nextRetryAt;
    if (!manualRetryRequired) delete next.manualRetryRequired;
    return await this.writeJournal(next);
  }

  async stage(
    descriptor: ArtifactDescriptor,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: { persistedBytes: number; totalBytes: number }) => void;
    } = {},
  ): Promise<VerifiedArtifact> {
    if (this.active) throw codedDownloadError('An update download is already active', 'ERR_DOWNLOAD_BUSY');
    this.validateDescriptor(descriptor);
    this.active = true;
    try {
      await this.ensureRoot();
      let journal = await this.prepareJournal(descriptor);
      const readyPath = this.readyPath(descriptor.assetName);
      if (await safeFileSize(readyPath) !== undefined) {
        const verified = await this.verifyReadyFile(readyPath, descriptor);
        journal = await this.writeJournal({
          ...clearAutomaticRecoveryFields(journal),
          state: 'verified',
          downloadedBytes: descriptor.size,
          updatedAt: new Date(this.now()).toISOString(),
        });
        options.onProgress?.({ persistedBytes: descriptor.size, totalBytes: descriptor.size });
        return { ...verified, reused: true };
      }

      const partPath = this.partPath(descriptor.assetName);
      let offset = (await safeFileSize(partPath)) ?? 0;
      if (offset > descriptor.size) {
        await this.quarantine(partPath, 'oversized');
        journal = await this.resetJournal(journal);
        offset = 0;
      }
      if (offset > 0 && journal.validator === null) {
        await this.quarantine(partPath, 'missing-validator');
        journal = await this.resetJournal(journal);
        offset = 0;
      }
      if (journal.downloadedBytes !== offset) {
        if (offset > journal.downloadedBytes) {
          // Bytes after the last fsync-backed journal checkpoint were never
          // exposed as progress. A crash or ENOSPC may leave that tail in the
          // file; discard only the uncommitted tail and resume from the last
          // durable byte instead of throwing away the whole partial.
          await this.truncatePartial(partPath, journal.downloadedBytes);
          offset = journal.downloadedBytes;
        } else {
          // A file shorter than its durable journal is genuine loss/tamper.
          if (offset > 0) await this.quarantine(partPath, 'state-mismatch');
          journal = await this.resetJournal(journal);
          offset = 0;
        }
      }
      options.onProgress?.({ persistedBytes: offset, totalBytes: descriptor.size });

      if (offset < descriptor.size) {
        await this.assertDiskSpace(descriptor.size - offset);
        journal = await this.download(descriptor, journal, offset, options, true);
      }
      const finalPartSize = await safeFileSize(partPath);
      if (finalPartSize !== descriptor.size) {
        throw codedDownloadError('Update download ended before the expected size', 'ERR_DOWNLOAD_TRUNCATED');
      }
      const verifiedPart = await this.verifyReadyFile(partPath, descriptor);
      await rename(partPath, readyPath);
      await syncDirectory(this.rootDirectory);
      await this.writeJournal({
        ...clearAutomaticRecoveryFields(journal),
        state: 'verified',
        downloadedBytes: descriptor.size,
        updatedAt: new Date(this.now()).toISOString(),
      });
      options.onProgress?.({ persistedBytes: descriptor.size, totalBytes: descriptor.size });
      return { ...verifiedPart, path: readyPath, reused: false };
    } catch (error) {
      if (TERMINAL_DOWNLOAD_CODES.has(errorCode(error) ?? '')) {
        await this.quarantineCurrent().catch((quarantineError) => {
          this.logger.warn('Could not quarantine an invalid desktop update download', quarantineError);
        });
      }
      throw error;
    } finally {
      this.active = false;
    }
  }

  /** Re-checks a staged artifact immediately before a manual OS handoff. */
  async revalidate(artifact: VerifiedArtifact): Promise<VerifiedArtifact> {
    if (this.active) throw codedDownloadError('An update download is already active', 'ERR_DOWNLOAD_BUSY');
    if (
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      artifact.size > 2 * 1024 * 1024 * 1024 ||
      !releaseFeedPatterns.sha256.test(artifact.sha256) ||
      !isCanonicalSha512(artifact.sha512)
    ) {
      throw codedDownloadError('Verified update metadata is invalid', 'ERR_DOWNLOAD_PROTOCOL');
    }
    await this.ensureRoot();
    const root = resolve(this.rootDirectory);
    const path = resolve(artifact.path);
    if (
      !path.startsWith(`${root}${sep}`) ||
      basename(path).endsWith('.part') ||
      !releaseFeedPatterns.assetName.test(basename(path))
    ) {
      throw codedDownloadError('Verified update path escaped the update cache', 'ERR_DOWNLOAD_PROTOCOL');
    }
    const verified = await this.verifyReadyFile(path, artifact);
    return { ...verified, reused: true };
  }

  async materializeForUpdater(artifact: VerifiedArtifact, destination: string): Promise<void> {
    const expectedPrefix = `${resolve(this.rootDirectory)}${sep}`;
    const source = resolve(artifact.path);
    if (!source.startsWith(expectedPrefix) || basename(source).endsWith('.part')) {
      throw codedDownloadError('Verified update path escaped the update cache', 'ERR_DOWNLOAD_PROTOCOL');
    }
    const sourceInfo = await safeFileSize(source);
    if (sourceInfo !== artifact.size) {
      throw codedDownloadError('Verified update disappeared before handoff', 'ERR_DOWNLOAD_INTEGRITY');
    }
    const destinationHandle = await open(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const input = createReadStream(source);
    try {
      for await (const chunk of input) {
        await writeAll(destinationHandle, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      await destinationHandle.sync();
    } catch (error) {
      input.destroy();
      await destinationHandle.close().catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      throw error;
    }
    await destinationHandle.close();
  }

  async discard(): Promise<void> {
    await this.ensureRoot();
    const journal = await this.readJournal();
    if (journal) {
      for (const path of [this.partPath(journal.assetName), this.readyPath(journal.assetName)]) {
        await unlink(path).catch((error) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        });
      }
    }
    await unlink(this.journalPath()).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    await syncDirectory(this.rootDirectory);
  }

  private validateDescriptor(descriptor: ArtifactDescriptor): void {
    if (
      !validSemver(descriptor.fromVersion) ||
      !validSemver(descriptor.targetVersion) ||
      descriptor.releaseTag !== `v${descriptor.targetVersion}` ||
      !releaseFeedPatterns.assetName.test(descriptor.assetName) ||
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size <= 0 ||
      descriptor.size > 2 * 1024 * 1024 * 1024 ||
      !releaseFeedPatterns.sha256.test(descriptor.sha256) ||
      !isCanonicalSha512(descriptor.sha512)
    ) throw codedDownloadError('Desktop update descriptor is invalid', 'ERR_DOWNLOAD_PROTOCOL');
    const url = new URL(buildReleaseAssetUrl(descriptor.releaseTag, descriptor.assetName));
    if (!isApprovedReleaseAssetUrl(url, descriptor.releaseTag, descriptor.assetName)) {
      throw codedDownloadError('Desktop update URL is not approved', 'ERR_DOWNLOAD_PROTOCOL');
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.rootDirectory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw codedDownloadError('Update cache root is not a private directory', 'ERR_DOWNLOAD_PROTOCOL');
    }
    if (typeof process.getuid === 'function' && rootInfo.uid !== process.getuid()) {
      throw codedDownloadError('Update cache root has an unexpected owner', 'ERR_DOWNLOAD_PROTOCOL');
    }
    await chmod(this.rootDirectory, 0o700).catch((error) => {
      if (process.platform !== 'win32') throw error;
    });
  }

  private async truncatePartial(path: string, length: number): Promise<void> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw codedDownloadError('Partial checkpoint length is invalid', 'ERR_DOWNLOAD_PROTOCOL');
    }
    const handle = await open(
      path,
      fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size < length ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())
      ) {
        throw codedDownloadError('Partial update changed before recovery', 'ERR_DOWNLOAD_PROTOCOL');
      }
      await handle.truncate(length);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(this.rootDirectory);
  }

  private journalPath(): string {
    return resolve(this.rootDirectory, JOURNAL_FILENAME);
  }

  private partPath(assetName: string): string {
    return resolve(this.rootDirectory, `${assetName}.part`);
  }

  private readyPath(assetName: string): string {
    return resolve(this.rootDirectory, assetName);
  }

  private async readJournal(): Promise<DownloadJournalV1 | undefined> {
    let handle: FileHandle | undefined;
    try {
      const path = this.journalPath();
      const size = await safeFileSize(path);
      if (size === undefined) return undefined;
      if (size <= 0 || size > 32 * 1024) throw codedDownloadError('Update journal is not bounded', 'ERR_DOWNLOAD_PROTOCOL');
      handle = await open(path, 'r');
      const source = await handle.readFile('utf8');
      const journal = parseJournal(JSON.parse(source) as unknown, this.now());
      if (!journal) throw codedDownloadError('Update journal schema is invalid', 'ERR_DOWNLOAD_PROTOCOL');
      return journal;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      this.logger.warn('Discarding an invalid desktop update journal', error);
      await handle?.close().catch(() => undefined);
      handle = undefined;
      await this.quarantine(this.journalPath(), 'journal').catch(() => undefined);
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeJournal(journal: DownloadJournalV1): Promise<DownloadJournalV1> {
    const temporaryPath = resolve(this.rootDirectory, `${JOURNAL_FILENAME}.tmp`);
    // Refuse a stale symlink or hardlink before opening with truncation. The
    // cache root is private, but this also fails closed after local tampering.
    await safeFileSize(temporaryPath);
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.journalPath());
    await syncDirectory(this.rootDirectory);
    return journal;
  }

  private async prepareJournal(descriptor: ArtifactDescriptor): Promise<DownloadJournalV1> {
    const existing = await this.readJournal();
    if (existing && sameDescriptor(existing, descriptor)) return existing;
    if (existing) await this.discard();
    const now = new Date(this.now()).toISOString();
    return await this.writeJournal({
      formatVersion: 1,
      state: 'partial',
      fromVersion: descriptor.fromVersion,
      targetVersion: descriptor.targetVersion,
      releaseTag: descriptor.releaseTag,
      assetName: descriptor.assetName,
      expectedSize: descriptor.size,
      sha256: descriptor.sha256,
      sha512: descriptor.sha512,
      downloadedBytes: 0,
      validator: null,
      createdAt: now,
      updatedAt: now,
      automaticAttempts: 0,
    });
  }

  private async resetJournal(journal: DownloadJournalV1): Promise<DownloadJournalV1> {
    return await this.writeJournal({
      ...journal,
      state: 'partial',
      downloadedBytes: 0,
      validator: null,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  private async assertDiskSpace(remainingBytes: number): Promise<void> {
    const available = await this.availableBytes(this.rootDirectory);
    if (!Number.isFinite(available) || available < remainingBytes + this.reserveBytes) {
      throw codedDownloadError('There is not enough writable storage for the desktop update', 'ENOSPC');
    }
  }

  private async download(
    descriptor: ArtifactDescriptor,
    journal: DownloadJournalV1,
    offset: number,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: { persistedBytes: number; totalBytes: number }) => void;
    },
    mayReset: boolean,
  ): Promise<DownloadJournalV1> {
    const headers = new Headers({
      Accept: 'application/octet-stream',
      'Accept-Encoding': 'identity',
      'User-Agent': 'QED2-Desktop',
    });
    if (offset > 0) {
      headers.set('Range', `bytes=${offset}-`);
      if (journal.validator) headers.set('If-Range', journal.validator.value);
    }
    const response = await fetchApprovedReleaseUrl(
      new URL(buildReleaseAssetUrl(descriptor.releaseTag, descriptor.assetName)),
      {
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
        cache: 'no-store',
      },
      this.fetchImpl,
    );
    if (response.status === 429) {
      response.body?.cancel().catch(() => undefined);
      const retryAfter = response.headers.get('retry-after');
      throw codedDownloadError('GitHub rate limited the desktop update download', 'ERR_UPDATER_RATE_LIMITED', {
        ...(retryAfter ? { retryAfter } : {}),
        statusCode: response.status,
      });
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      throw codedDownloadError('Desktop update asset request failed', `HTTP_ERROR_${response.status}`, {
        statusCode: response.status,
      });
    }
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') {
      response.body?.cancel().catch(() => undefined);
      throw codedDownloadError('Desktop update response used content encoding', 'ERR_DOWNLOAD_PROTOCOL');
    }
    const validator = currentValidator(response.headers);
    if (offset > 0 && response.status === 200) {
      response.body?.cancel().catch(() => undefined);
      if (!mayReset) throw codedDownloadError('Desktop update server ignored byte ranges', 'ERR_DOWNLOAD_PROTOCOL');
      await this.quarantine(this.partPath(descriptor.assetName), 'range-ignored');
      const reset = await this.resetJournal(journal);
      options.onProgress?.({ persistedBytes: 0, totalBytes: descriptor.size });
      return await this.download(descriptor, reset, 0, options, false);
    }
    if (offset === 0 && response.status !== 200) {
      response.body?.cancel().catch(() => undefined);
      throw codedDownloadError('Desktop update server returned an unexpected initial response', 'ERR_DOWNLOAD_PROTOCOL');
    }
    if (offset > 0) {
      if (response.status !== 206) {
        response.body?.cancel().catch(() => undefined);
        throw codedDownloadError('Desktop update server did not honor byte ranges', 'ERR_DOWNLOAD_PROTOCOL');
      }
      const range = contentRange(response.headers.get('content-range'));
      if (!range || range.start !== offset || range.total !== descriptor.size || range.end !== descriptor.size - 1) {
        response.body?.cancel().catch(() => undefined);
        throw codedDownloadError('Desktop update server returned an invalid byte range', 'ERR_DOWNLOAD_PROTOCOL');
      }
      if (!validatorsEqual(journal.validator, validator)) {
        response.body?.cancel().catch(() => undefined);
        if (!mayReset) throw codedDownloadError('Desktop update validator changed', 'ERR_DOWNLOAD_PROTOCOL');
        await this.quarantine(this.partPath(descriptor.assetName), 'validator-changed');
        const reset = await this.resetJournal(journal);
        options.onProgress?.({ persistedBytes: 0, totalBytes: descriptor.size });
        return await this.download(descriptor, reset, 0, options, false);
      }
    }
    const declaredLengthHeader = response.headers.get('content-length');
    const declaredLength = declaredLengthHeader === null ? undefined : Number(declaredLengthHeader);
    const expectedBodySize = descriptor.size - offset;
    if (
      declaredLength !== undefined &&
      (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength !== expectedBodySize)
    ) {
      response.body?.cancel().catch(() => undefined);
      throw codedDownloadError('Desktop update response length is invalid', 'ERR_DOWNLOAD_PROTOCOL');
    }
    if (!response.body) throw codedDownloadError('Desktop update response has no body', 'ERR_DOWNLOAD_PROTOCOL');

    journal = await this.writeJournal({
      ...journal,
      validator: offset === 0 ? validator : journal.validator,
      updatedAt: new Date(this.now()).toISOString(),
    });
    const partPath = this.partPath(descriptor.assetName);
    const flags = offset === 0
      ? fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0)
      : fsConstants.O_APPEND | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const file = await open(partPath, flags, 0o600);
    const reader = response.body.getReader();
    let persistedBytes = offset;
    let writtenBytes = offset;
    let checkpointAt = this.now();
    const checkpoint = async (force = false): Promise<void> => {
      if (
        !force &&
        writtenBytes - persistedBytes < this.checkpointBytes &&
        this.now() - checkpointAt < this.checkpointMs
      ) return;
      await file.datasync();
      persistedBytes = writtenBytes;
      checkpointAt = this.now();
      journal = await this.writeJournal({
        ...journal,
        downloadedBytes: persistedBytes,
        updatedAt: new Date(this.now()).toISOString(),
      });
      options.onProgress?.({ persistedBytes, totalBytes: descriptor.size });
    };
    try {
      for (;;) {
        const { done, value } = await readWithIdleTimeout(reader, this.idleTimeoutMs);
        if (done) break;
        if (writtenBytes + value.byteLength > descriptor.size) {
          await reader.cancel().catch(() => undefined);
          throw codedDownloadError('Desktop update response exceeded the approved size', 'ERR_DOWNLOAD_OVERSIZED');
        }
        await writeAll(file, Buffer.from(value));
        writtenBytes += value.byteLength;
        await checkpoint();
      }
      await checkpoint(true);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await checkpoint(true).catch((checkpointError) => {
        this.logger.warn('Could not checkpoint an interrupted desktop update', checkpointError);
      });
      throw error;
    } finally {
      reader.releaseLock();
      await file.close();
    }
    if (writtenBytes !== descriptor.size) {
      throw codedDownloadError('Desktop update response was truncated', 'ERR_DOWNLOAD_TRUNCATED');
    }
    return journal;
  }

  private async verifyReadyFile(
    path: string,
    descriptor: Pick<ArtifactDescriptor, 'size' | 'sha256' | 'sha512'>,
  ): Promise<Omit<VerifiedArtifact, 'reused'>> {
    const size = await safeFileSize(path);
    if (size !== descriptor.size) {
      throw codedDownloadError('Desktop update size differs from the approved manifest', 'ERR_DOWNLOAD_INTEGRITY');
    }
    const digest = await hashFile(path);
    if (digest.sha256 !== descriptor.sha256 || digest.sha512 !== descriptor.sha512) {
      throw codedDownloadError('Desktop update checksum differs from the approved manifest', 'ERR_DOWNLOAD_INTEGRITY');
    }
    return {
      path,
      size,
      sha256: digest.sha256,
      sha512: digest.sha512,
    };
  }

  private async quarantineCurrent(): Promise<void> {
    const journal = await this.readJournal();
    if (!journal) return;
    for (const path of [this.partPath(journal.assetName), this.readyPath(journal.assetName)]) {
      if (await safeFileSize(path) !== undefined) await this.quarantine(path, 'invalid');
    }
    await unlink(this.journalPath()).catch(() => undefined);
    await syncDirectory(this.rootDirectory);
  }

  private async quarantine(path: string, reason: string): Promise<void> {
    if (await safeFileSize(path) === undefined) return;
    const destination = resolve(
      this.rootDirectory,
      `${basename(path)}.${reason}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`,
    );
    await rename(path, destination);
    await syncDirectory(this.rootDirectory);
  }
}
