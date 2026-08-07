import { lstat, open } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import type { AppUpdater } from 'electron-updater';
import type { ApprovedDesktopRelease } from './release-feed.js';
import { errorCode } from './update-error-policy.js';

export interface SelfUpdateAvailability {
  available: boolean;
  reason:
    | 'ready'
    | 'development'
    | 'unsigned-manual'
    | 'configuration-missing'
    | 'configuration-invalid'
    | 'unsupported-installation';
}

const MANUAL_INSTALL_PACKAGE_EXTENSIONS = new Set(['.deb', '.rpm', '.zip', '.exe', '.dmg']);
const MANUAL_LINUX_UPDATER_NAMES = new Set(['DebUpdater', 'RpmUpdater', 'PacmanUpdater']);
const UPDATE_REPOSITORY_OWNER = 'tangxiaoyi97';
const UPDATE_REPOSITORY_NAME = 'qedv2-client';
const UPDATE_CONFIG_FILENAME = 'app-update.yml';
const UNSIGNED_BUILD_MARKER_FILENAME = 'qed2-unsigned-release.json';
const MAX_UPDATE_CONFIG_BYTES = 8 * 1024;

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readRegularBoundedFile(filePath: string, maximumBytes: number, label: string): Promise<Buffer> {
  const pathInfo = await lstat(filePath);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size <= 0 || pathInfo.size > maximumBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  const handle = await open(filePath, 'r');
  try {
    const handleInfo = await handle.stat();
    if (
      !handleInfo.isFile() ||
      handleInfo.size !== pathInfo.size ||
      handleInfo.dev !== pathInfo.dev ||
      handleInfo.ino !== pathInfo.ino
    ) {
      throw new Error(`${label} changed while it was opened`);
    }
    const bytes = Buffer.allocUnsafe(handleInfo.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error(`${label} is truncated`);
      offset += result.bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, bytes.length)).bytesRead !== 0) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseUpdateConfigScalar(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    const inner = value.slice(1, -1);
    if (inner.replace(/''/g, '').includes("'")) return undefined;
    return inner.replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return /^[A-Za-z0-9@._/-]+$/.test(value) ? value : undefined;
}

function parsePublisherNameScalar(raw: string): string | undefined {
  const quoted = parseUpdateConfigScalar(raw);
  if (quoted !== undefined) {
    return quoted.length > 0 && quoted.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(quoted)
      ? quoted
      : undefined;
  }
  const value = raw.trim();
  if (
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /^[\-?:,\[\]{}#&*!|>'"%@`]/u.test(value) ||
    /(?:^|\s)#/u.test(value) ||
    /:\s/u.test(value)
  ) return undefined;
  return value;
}

function validUpdateConfiguration(source: string): boolean {
  const values: Record<string, string> = {};
  let publisherNames: string[] | undefined;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    if (rawLine.trim() === '') continue;
    if (/^publisherName:\s*$/.test(rawLine)) {
      if (publisherNames !== undefined) return false;
      publisherNames = [];
      while (index + 1 < lines.length) {
        const itemLine = lines[index + 1]!;
        const item = /^ {2}-\s+(.*?)\s*$/.exec(itemLine);
        if (!item) break;
        const value = parsePublisherNameScalar(item[1] ?? '');
        if (value === undefined || publisherNames.includes(value) || publisherNames.length >= 8) return false;
        publisherNames.push(value);
        index += 1;
      }
      if (publisherNames.length === 0) return false;
      continue;
    }
    if (/^\s/u.test(rawLine)) return false;
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/.exec(rawLine);
    if (!match?.[1] || match[2] === undefined || Object.hasOwn(values, match[1])) return false;
    if (match[1] === 'publisherName') return false;
    const value = parseUpdateConfigScalar(match[2]);
    if (value === undefined) return false;
    values[match[1]] = value;
  }
  if (!hasExactOwnKeys(values, ['owner', 'repo', 'provider', 'releaseType', 'updaterCacheDirName'])) {
    return false;
  }
  return (
    values.owner === UPDATE_REPOSITORY_OWNER &&
    values.repo === UPDATE_REPOSITORY_NAME &&
    values.provider === 'github' &&
    values.releaseType === 'release' &&
    typeof values.updaterCacheDirName === 'string' &&
    /^[A-Za-z0-9@._-]{1,128}$/.test(values.updaterCacheDirName)
  );
}

/** Fail-closed capability probe; app-update.yml never contains credentials. */
export async function inspectSelfUpdateAvailability(
  packaged: boolean,
  resourcesPath: string,
  runtime: {
    platform?: typeof process.platform;
    appImagePath?: string;
  } = {},
): Promise<SelfUpdateAvailability> {
  if (!packaged) return { available: false, reason: 'development' };
  const platform = runtime.platform ?? process.platform;
  let unsignedManual = false;
  try {
    const bytes = await readRegularBoundedFile(
      resolve(resourcesPath, UNSIGNED_BUILD_MARKER_FILENAME),
      1_024,
      'Unsigned Desktop release marker',
    );
    const marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (
      !isRecord(marker) ||
      !hasExactOwnKeys(marker, ['formatVersion', 'selfUpdate']) ||
      marker.formatVersion !== 1 ||
      marker.selfUpdate !== 'manual-only'
    ) {
      return { available: false, reason: 'configuration-invalid' };
    }
    unsignedManual = true;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return { available: false, reason: 'configuration-invalid' };
    }
  }
  try {
    const bytes = await readRegularBoundedFile(
      resolve(resourcesPath, UPDATE_CONFIG_FILENAME),
      MAX_UPDATE_CONFIG_BYTES,
      'Desktop update configuration',
    );
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!validUpdateConfiguration(source)) {
      return { available: false, reason: 'configuration-invalid' };
    }
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { available: false, reason: 'configuration-missing' }
      : { available: false, reason: 'configuration-invalid' };
  }

  if (platform !== 'linux') {
    return unsignedManual
      ? { available: true, reason: 'unsigned-manual' }
      : { available: true, reason: 'ready' };
  }
  const appImagePath = runtime.appImagePath ?? process.env.APPIMAGE;
  if (appImagePath && isAbsolute(appImagePath) && !appImagePath.includes('\0')) {
    return { available: true, reason: unsignedManual ? 'unsigned-manual' : 'ready' };
  }
  try {
    const packageTypeBytes = await readRegularBoundedFile(
      resolve(resourcesPath, 'package-type'),
      32,
      'Linux package type',
    );
    const packageType = new TextDecoder('utf-8', { fatal: true }).decode(packageTypeBytes).trim();
    return packageType === 'deb' || packageType === 'rpm'
      ? { available: true, reason: unsignedManual ? 'unsigned-manual' : 'ready' }
      : { available: false, reason: 'unsupported-installation' };
  } catch {
    return { available: false, reason: 'unsupported-installation' };
  }
}

export function configureUpdaterInstallPolicy(
  updater: AppUpdater,
  availability: SelfUpdateAvailability,
): { manualPackageInstall: boolean } {
  // Package-manager updaters can synchronously invoke sudo. Unsigned 2.1.x
  // packages on every platform are also reveal-only and must never execute.
  const manualPackageInstall = (
    MANUAL_LINUX_UPDATER_NAMES.has(updater.constructor?.name ?? '') ||
    availability.reason === 'unsigned-manual'
  );
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = !manualPackageInstall;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.fullChangelog = true;
  // QED2 publishes a complete NSIS installer; web installers are never an
  // acceptable fallback for a verified release.
  updater.disableWebInstaller = true;
  return { manualPackageInstall };
}

export function verifiedManualInstallPackage(paths: readonly string[]): string | undefined {
  return paths.find((candidate) =>
    isAbsolute(candidate) && MANUAL_INSTALL_PACKAGE_EXTENSIONS.has(extname(candidate).toLowerCase()));
}

export function selectManualReleaseAsset(
  release: ApprovedDesktopRelease,
  platform: NodeJS.Platform,
  arch: string,
  updater: AppUpdater,
): ApprovedDesktopRelease['assets'][string] | undefined {
  if (
    (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') ||
    (arch !== 'arm64' && arch !== 'x64')
  ) return undefined;
  const updaterName = updater.constructor?.name ?? '';
  const suffix = updaterName === 'DebUpdater'
    ? '.deb'
    : updaterName === 'RpmUpdater'
      ? '.rpm'
      : updaterName === 'AppImageUpdater' || platform === 'linux'
        ? '.AppImage'
        : platform === 'darwin'
          ? '.dmg'
          : platform === 'win32'
            ? '.exe'
            : undefined;
  if (!suffix) return undefined;
  const matches = Object.values(release.assets).filter((asset) => (
    asset.name.endsWith(suffix) &&
    asset.target?.platform === platform &&
    asset.target.arch === arch &&
    asset.target.installMode === 'manual-package'
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

export function selfUpdateUnavailableMessage(reason: SelfUpdateAvailability['reason']): string {
  return reason === 'development'
    ? 'Lokaler Entwicklungsbuild – Desktop-Aktualisierungen sind deaktiviert.'
    : 'Lokaler Test-Build – Desktop-Aktualisierungen sind nur in regulär installierten Release-Builds verfügbar.';
}
