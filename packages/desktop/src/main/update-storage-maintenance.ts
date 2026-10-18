import { closeSync, constants, fstatSync, openSync, readFileSync, type Stats } from 'node:fs';
import { opendir } from 'node:fs/promises';
import {
  managedDirectory, managedFile, sameFile, unlinkManagedFile, UnsafeManagedPathError,
} from './managed-file-safety.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_ENTRIES = 1_024;
const JOURNAL = 'download-journal.json';
// Only files produced by this application's release downloader are disposable.
// The release feed's general asset-name validator is deliberately too broad here.
const ASSET_SOURCE = 'QED2-(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)-(?:mac-(?:arm64|x64)\\.(?:dmg|zip)|win-x64\\.exe|linux-x64\\.(?:AppImage|deb))';
const ASSET = new RegExp(`^${ASSET_SOURCE}$`);
const PARTIAL = new RegExp(`^(${ASSET_SOURCE})\\.part$`);
const QUARANTINE = new RegExp(`^(?:(${ASSET_SOURCE})(?:\\.part)?\\.(?:oversized|missing-validator|state-mismatch|range-ignored|validator-changed|invalid)|download-journal\\.json\\.journal)-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z)$`);

interface StorageSnapshot {
  root: NonNullable<ReturnType<typeof managedDirectory>>;
  files: Array<{ name: string; stat: Stats; eligible: boolean }>;
  bytes: number;
  cleanableBytes: number;
}

function journalProtection(root: string): { assetName?: string; preserveAll: boolean } {
  const file = managedFile(root, JOURNAL);
  if (!file) return { preserveAll: false };
  // A corrupt/unreadable journal might still refer to a user's paused download.
  // Never quarantine or repair it while showing or cleaning storage.
  if (file.stat.size <= 0 || file.stat.size > 32 * 1_024) return { preserveAll: true };
  const descriptor = openSync(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(descriptor);
    if (!sameFile(info, file.stat) || !info.isFile() || info.nlink !== 1 || info.size !== file.stat.size) {
      throw new UnsafeManagedPathError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
    } catch {
      return { preserveAll: true };
    }
    const assetName = parsed && typeof parsed === 'object'
      ? (parsed as { assetName?: unknown }).assetName : undefined;
    return typeof assetName === 'string' && ASSET.test(assetName)
      ? { assetName, preserveAll: false }
      : { preserveAll: true };
  } finally {
    closeSync(descriptor);
  }
}

function expiration(name: string): { assetName?: string; ageMs: number; quarantinedAt?: number } | undefined {
  if (ASSET.test(name)) return { assetName: name, ageMs: 30 * DAY_MS };
  const partial = PARTIAL.exec(name);
  if (partial) return { assetName: partial[1]!, ageMs: 14 * DAY_MS };
  const quarantine = QUARANTINE.exec(name);
  if (!quarantine) return undefined;
  const timestamp = quarantine[2]!.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const quarantinedAt = Date.parse(timestamp);
  if (!Number.isFinite(quarantinedAt)) return undefined;
  return { ageMs: 14 * DAY_MS, quarantinedAt };
}

async function snapshot(
  rootDirectory: string,
  protectedAssetNames: readonly string[],
  now: number,
): Promise<StorageSnapshot | undefined> {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid storage measurement time');
  const root = managedDirectory(rootDirectory);
  if (!root) return undefined;
  const names: string[] = [];
  const directory = await opendir(root.path);
  for await (const entry of directory) {
    if (names.length >= MAX_ENTRIES) throw new Error('Update storage has too many entries to safely inspect');
    names.push(entry.name);
  }
  const currentRoot = managedDirectory(rootDirectory);
  if (!currentRoot || currentRoot.path !== root.path || !sameFile(currentRoot.stat, root.stat)) {
    throw new UnsafeManagedPathError();
  }
  const protectedFiles = new Set(protectedAssetNames);
  const protection = journalProtection(root.path);
  if (protection.assetName) protectedFiles.add(protection.assetName);
  const files: StorageSnapshot['files'] = [];
  let bytes = 0;
  let cleanableBytes = 0;
  for (const name of names) {
    const file = managedFile(root.path, name);
    if (!file) continue;
    const expiry = expiration(name);
    const protectedFile = protection.preserveAll || (expiry?.assetName !== undefined && protectedFiles.has(expiry.assetName));
    const eligible = !protectedFile && expiry !== undefined &&
      now - Math.max(file.stat.mtimeMs, expiry.quarantinedAt ?? 0) > expiry.ageMs;
    bytes += file.stat.size;
    if (eligible) cleanableBytes += file.stat.size;
    if (!Number.isSafeInteger(bytes)) throw new Error('Update storage size exceeds supported precision');
    files.push({ name, stat: file.stat, eligible });
  }
  return { root, files, bytes, cleanableBytes };
}

/** Read-only: does not create directories, expire journals, or alter download recovery. */
export async function inspectUpdateStorage(
  rootDirectory: string,
  protectedAssetNames: readonly string[] = [],
  now = Date.now(),
): Promise<{ bytes: number; cleanableBytes: number }> {
  const result = await snapshot(rootDirectory, protectedAssetNames, now);
  return { bytes: result?.bytes ?? 0, cleanableBytes: result?.cleanableBytes ?? 0 };
}

/** Caller must hold the updater's maintenance lock for the entire operation. */
export async function cleanupExpiredUpdateStorage(
  rootDirectory: string,
  protectedAssetNames: readonly string[] = [],
  now = Date.now(),
): Promise<number> {
  const result = await snapshot(rootDirectory, protectedAssetNames, now);
  if (!result) return 0;
  let freedBytes = 0;
  // Scan and validate every entry first. Never partially clean an unsafe folder.
  for (const file of result.files) {
    if (file.eligible) freedBytes += unlinkManagedFile(rootDirectory, result.root, file.name, file.stat);
  }
  return freedBytes;
}
