import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { UpdateSnapshot } from '@qed2/core-logic';
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchApprovedDesktopRelease,
  inspectSelfUpdateAvailability,
  UpdateCoordinator,
  type ApprovedDesktopRelease,
  type RuntimeVersions,
  type SelfUpdateAvailability,
  type UpdateCoordinatorLogger,
  type UpdateInstallLifecycle,
  type UpdateRecoveryStore,
} from '../src/main/update-coordinator.js';
import { ResumableArtifactDownloader } from '../src/main/resumable-downloader.js';
import {
  MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS,
  UpdateRecoveryJournal,
} from '../src/main/update-recovery-journal.js';

vi.mock('electron-updater', () => ({
  default: { autoUpdater: {} },
}));

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() },
}));

const CLIENT_COMMIT = '1'.repeat(40);
const CORE_COMMIT = '2'.repeat(40);
const BANK_COMMIT = '3'.repeat(40);

const runtimeVersions: RuntimeVersions = {
  coreVersion: '2.0.0-core',
  coreCommit: CORE_COMMIT,
  bankCommit: BANK_COMMIT,
  coreRepoUrl: 'https://github.com/qed2/core',
  bankRepoUrl: 'https://github.com/qed2/bank',
};

function approvedDesktopRelease(
  version = '2.1.0',
  overrides: Partial<ApprovedDesktopRelease> = {},
): ApprovedDesktopRelease {
  const manualTargets = new Map([
    [`QED2-${version}-mac-arm64.dmg`, { platform: 'darwin', arch: 'arm64', installMode: 'manual-package' } as const],
    [`QED2-${version}-mac-x64.dmg`, { platform: 'darwin', arch: 'x64', installMode: 'manual-package' } as const],
    [`QED2-${version}-win-x64.exe`, { platform: 'win32', arch: 'x64', installMode: 'manual-package' } as const],
    [`QED2-${version}-linux-x64.AppImage`, { platform: 'linux', arch: 'x64', installMode: 'manual-package' } as const],
    [`QED2-${version}-linux-x64.deb`, { platform: 'linux', arch: 'x64', installMode: 'manual-package' } as const],
    [`QED2-${version}-linux-x64.rpm`, { platform: 'linux', arch: 'x64', installMode: 'manual-package' } as const],
  ]);
  const asset = (name: string, index: number) => {
    const target = manualTargets.get(name);
    return {
      name,
      size: index + 1,
      sha256: String((index % 9) + 1).repeat(64),
      sha512: Buffer.alloc(64, (index % 250) + 1).toString('base64'),
      downloadUrl: `https://github.com/tangxiaoyi97/qedv2-client/releases/download/v${version}/${name}`,
      ...(target ? { target } : {}),
    };
  };
  const assetList = [
    `QED2-${version}-mac-arm64.dmg`,
    `QED2-${version}-mac-arm64.zip`,
    `QED2-${version}-mac-x64.dmg`,
    `QED2-${version}-mac-x64.zip`,
    `QED2-${version}-win-x64.exe`,
    `QED2-${version}-linux-x64.deb`,
    `QED2-${version}-linux-x64.rpm`,
    `QED2-${version}-linux-x64.AppImage`,
    'latest.yml',
    'latest-mac.yml',
    'latest-linux.yml',
  ].map(asset);
  return {
    tag: `v${version}`,
    version,
    clientCommit: CLIENT_COMMIT,
    coreCommit: CORE_COMMIT,
    bankCommit: BANK_COMMIT,
    assets: Object.fromEntries(assetList.map((item) => [item.name, item])),
    updateMetadata: {
      'latest.yml': [`QED2-${version}-win-x64.exe`],
      'latest-mac.yml': [
        `QED2-${version}-mac-arm64.zip`,
        `QED2-${version}-mac-x64.zip`,
      ],
      'latest-linux.yml': [
        `QED2-${version}-linux-x64.AppImage`,
        `QED2-${version}-linux-x64.deb`,
        `QED2-${version}-linux-x64.rpm`,
      ],
    },
    ...overrides,
  };
}

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  allowDowngrade = true;
  fullChangelog = false;
  disableWebInstaller = false;

  checkResult: {
    isUpdateAvailable: boolean;
    updateInfo: { version: string };
  } | null = {
    isUpdateAvailable: true,
    updateInfo: { version: '2.1.0' },
  };

  readonly checkForUpdates = vi.fn(async () => this.checkResult);
  readonly downloadUpdate = vi.fn(async () => {
    this.reportDownloaded();
    return ['/tmp/qed2-update'];
  });
  readonly quitAndInstall = vi.fn();

  reportProgress(progress: Pick<ProgressInfo, 'percent' | 'transferred' | 'total'>): void {
    this.emit('download-progress', progress as ProgressInfo);
  }

  reportDownloaded(version = '2.1.0'): void {
    this.emit('update-downloaded', { version } as UpdateInfo);
  }

  reportError(error: Error): void {
    this.emit('error', error);
  }
}

class DebUpdater extends FakeUpdater {}

class RpmUpdater extends FakeUpdater {}

class AppImageUpdater extends FakeUpdater {}

class MemoryRecoveryStore implements UpdateRecoveryStore {
  private readonly values = new Map<string, unknown>();

  get<T>(collection: string, key: string): T | undefined {
    const value = this.values.get(`${collection}:${key}`);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  set(collection: string, key: string, value: unknown): void {
    this.values.set(`${collection}:${key}`, structuredClone(value));
  }

  delete(collection: string, key: string): void {
    this.values.delete(`${collection}:${key}`);
  }

  pending(): Record<string, unknown> | undefined {
    return this.get<Record<string, unknown>>('desktop-update', 'pending-app-download');
  }
}

class FakeInstallLifecycle implements UpdateInstallLifecycle {
  private listener: (() => void) | undefined;

  onBeforeQuitForUpdate(callback: () => void): () => void {
    this.listener = callback;
    return () => {
      if (this.listener === callback) this.listener = undefined;
    };
  }

  confirm(): void {
    this.listener?.();
  }
}

function codedError(code: string, privateDetail = '/Users/example/private/update.bin'): Error {
  return Object.assign(new Error(privateDetail), { code });
}

function appState(snapshot: UpdateSnapshot) {
  const state = snapshot.targets.find((target) => target.target === 'app');
  if (!state) throw new Error('Missing app update state');
  return state;
}

function logger(): UpdateCoordinatorLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createCoordinator(options: {
  updater?: FakeUpdater;
  recoveryStore?: MemoryRecoveryStore;
  appVersion?: string;
  packaged?: boolean;
  approvedRelease?: () => Promise<ApprovedDesktopRelease | undefined>;
  selfUpdateAvailability?: SelfUpdateAvailability;
  retryDelaysMs?: readonly number[];
  installLifecycle?: UpdateInstallLifecycle;
  installHandoffTimeoutMs?: number;
  revealInstallPackage?: (packagePath: string) => void;
  downloader?: ResumableArtifactDownloader;
  platform?: NodeJS.Platform;
  arch?: string;
} = {}): {
  coordinator: UpdateCoordinator;
  updater: FakeUpdater;
  recoveryStore: MemoryRecoveryStore;
  approvedRelease: ReturnType<typeof vi.fn>;
  updateLogger: UpdateCoordinatorLogger;
} {
  const updater = options.updater ?? new FakeUpdater();
  const recoveryStore = options.recoveryStore ?? new MemoryRecoveryStore();
  const approvedRelease = vi.fn(options.approvedRelease ?? (async () => approvedDesktopRelease()));
  const updateLogger = logger();
  const coordinator = new UpdateCoordinator(
    options.appVersion ?? '2.0.0',
    options.packaged ?? true,
    runtimeVersions,
    updateLogger,
    {
      updater: updater as unknown as AppUpdater,
      recoveryStore,
      approvedRelease,
      ...(options.selfUpdateAvailability ? { selfUpdateAvailability: options.selfUpdateAvailability } : {}),
      retryDelaysMs: options.retryDelaysMs ?? [0, 0, 0],
      wait: async () => {},
      now: () => Date.parse('2026-08-07T01:00:00.000Z'),
      ...(options.installLifecycle ? { installLifecycle: options.installLifecycle } : {}),
      ...(options.installHandoffTimeoutMs !== undefined
        ? { installHandoffTimeoutMs: options.installHandoffTimeoutMs }
        : {}),
      ...(options.revealInstallPackage
        ? { revealInstallPackage: options.revealInstallPackage }
        : {}),
      ...(options.downloader ? { downloader: options.downloader } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.arch ? { arch: options.arch } : {}),
    },
  );
  return { coordinator, updater, recoveryStore, approvedRelease, updateLogger };
}

async function prepareAvailable(coordinator: UpdateCoordinator): Promise<void> {
  await coordinator.checkForUpdates();
  expect(appState(coordinator.getState()).phase).toBe('available');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('UpdateRecoveryJournal', () => {
  const now = () => Date.parse('2026-08-07T01:00:00.000Z');

  it('strictly rejects unknown fields and attempts beyond the recovery ceiling', () => {
    const recoveryStore = new MemoryRecoveryStore();
    const updateLogger = logger();
    const journal = new UpdateRecoveryJournal(recoveryStore, updateLogger, now);
    recoveryStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-08-07T00:00:00.000Z',
      attempts: 0,
      status: 'downloading',
      injected: true,
    });

    expect(journal.read()).toBeUndefined();
    expect(recoveryStore.pending()).toBeUndefined();

    recoveryStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-08-07T00:00:00.000Z',
      attempts: MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS + 1,
      status: 'downloading',
    });
    expect(journal.read()).toBeUndefined();
    expect(recoveryStore.pending()).toBeUndefined();
    expect(updateLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy intents untrusted and caps failure increments at eight', () => {
    const recoveryStore = new MemoryRecoveryStore();
    const journal = new UpdateRecoveryJournal(recoveryStore, logger(), now);
    recoveryStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-08-07T00:00:00.000Z',
      attempts: MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS - 1,
    });

    const legacy = journal.read();
    expect(legacy).toMatchObject({ status: 'downloading', attempts: 7 });
    const failure = journal.recordFailure(legacy!);
    expect(failure).toMatchObject({
      automaticLimitReached: true,
      pending: { status: 'downloading', attempts: MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS },
    });
    expect(recoveryStore.pending()).toMatchObject({ attempts: MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS });
  });
});

describe('UpdateCoordinator', () => {
  it('configures a stable, explicit and fail-closed updater policy', async () => {
    const { coordinator, updater, approvedRelease } = createCoordinator();

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.autoRunAppAfterInstall).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.fullChangelog).toBe(true);
    expect(updater.disableWebInstaller).toBe(true);

    const results = await coordinator.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(approvedRelease).toHaveBeenCalledTimes(1);
    expect(results).toContainEqual({
      target: 'app',
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      updateAvailable: true,
    });
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'core', updateAvailable: false }),
      expect.objectContaining({ target: 'bank', updateAvailable: false }),
    ]));
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'available',
      latestVersion: '2.1.0',
    });
  });

  it('trusts electron-updater eligibility for staged rollout and downgrade decisions', async () => {
    const updater = new FakeUpdater();
    updater.checkResult = {
      isUpdateAvailable: false,
      updateInfo: { version: '1.9.0' },
    };
    const { coordinator } = createCoordinator({
      updater,
      approvedRelease: async () => approvedDesktopRelease('1.9.0'),
    });

    const result = await coordinator.checkForUpdates();
    expect(result[0]).toMatchObject({ latestVersion: '1.9.0', updateAvailable: false });
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'complete',
      latestVersion: '1.9.0',
    });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('fails closed when electron-updater disagrees with the approved public release', async () => {
    const updater = new FakeUpdater();
    updater.checkResult = {
      isUpdateAvailable: true,
      updateInfo: { version: '2.2.0' },
    };
    const { coordinator } = createCoordinator({ updater });

    await expect(coordinator.checkForUpdates()).rejects.toMatchObject({
      code: 'APP_UPDATE_RELEASE_INVALID',
    });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      latestVersion: '2.1.0',
      error: { code: 'APP_UPDATE_RELEASE_INVALID', retryable: false },
    });
  });

  it('deduplicates concurrent checks and rejects apply while a check is active', async () => {
    const updater = new FakeUpdater();
    let finishCheck!: () => void;
    updater.checkForUpdates.mockImplementationOnce(() => new Promise((resolve) => {
      finishCheck = () => resolve({
        isUpdateAvailable: true,
        updateInfo: { version: '2.1.0' },
      });
    }));
    const { coordinator } = createCoordinator({ updater });

    const first = coordinator.checkForUpdates();
    const second = coordinator.checkForUpdates();
    expect(first).toBe(second);
    await expect(coordinator.applyUpdates(['app'])).rejects.toMatchObject({ code: 'APP_UPDATE_BUSY' });
    finishCheck();
    await Promise.all([first, second]);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('normalizes monotonic live progress and ignores stale events', async () => {
    const { coordinator, updater } = createCoordinator();
    await prepareAvailable(coordinator);
    let finishDownload!: () => void;
    updater.downloadUpdate.mockImplementationOnce(() => new Promise((resolve) => {
      finishDownload = () => resolve(['/tmp/qed2-update']);
    }));

    const applying = coordinator.applyUpdates(['app']);
    updater.reportProgress({ percent: 50, transferred: 5, total: 10 });
    updater.reportProgress({ percent: 30, transferred: 3, total: 8 });
    expect(appState(coordinator.getState()).progress).toEqual({
      completed: 50,
      total: 100,
      unit: 'percent',
    });

    updater.reportProgress({ percent: 150, transferred: 15, total: 10 });
    expect(appState(coordinator.getState())).toMatchObject({
      progress: { completed: 100, total: 100, unit: 'percent' },
      message: expect.stringContaining('(100 %)'),
    });
    updater.reportDownloaded();
    updater.reportDownloaded();
    expect(appState(coordinator.getState()).phase).toBe('verifying');
    await expect(coordinator.relaunchToApply()).rejects.toMatchObject({
      code: 'APP_UPDATE_BUSY',
    });
    finishDownload();
    await applying;

    updater.reportProgress({ percent: 1, transferred: 1, total: 100 });
    expect(appState(coordinator.getState())).toMatchObject({ phase: 'restart-required' });
    expect(appState(coordinator.getState()).progress).toBeUndefined();
  });

  it('keeps transaction progress monotonic while reporting restarted attempt bytes truthfully', async () => {
    const { coordinator, updater } = createCoordinator();
    await prepareAvailable(coordinator);
    let finishRetry!: () => void;
    updater.downloadUpdate
      .mockImplementationOnce(async () => {
        updater.reportProgress({ percent: 80, transferred: 80, total: 100 });
        throw codedError('ECONNRESET');
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishRetry = () => resolve(['/tmp/qed2-update']);
      }));

    const applying = coordinator.applyUpdates(['app']);
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledTimes(2));
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'downloading',
      progress: { completed: 80, total: 100, unit: 'percent' },
      message: expect.stringMatching(/startet bei 0 .*nicht angerechnet.*80 %/),
    });

    updater.reportProgress({ percent: 10, transferred: 10, total: 100 });
    expect(appState(coordinator.getState())).toMatchObject({
      progress: { completed: 80, total: 100, unit: 'percent' },
      message: expect.stringMatching(/aktuell 10 %.*Höchststand 80 %.*nicht angerechnet/),
    });
    updater.reportProgress({ percent: 90, transferred: 90, total: 100 });
    expect(appState(coordinator.getState())).toMatchObject({
      progress: { completed: 90, total: 100, unit: 'percent' },
      message: expect.stringMatching(/aktuell 90 %.*Höchststand 90 %/),
    });

    updater.reportDownloaded();
    finishRetry();
    await applying;
    expect(appState(coordinator.getState()).phase).toBe('restart-required');
  });

  it('requires an update-downloaded verification event before enabling relaunch', async () => {
    const { coordinator, updater, recoveryStore } = createCoordinator();
    await prepareAvailable(coordinator);
    updater.downloadUpdate.mockResolvedValueOnce(['/tmp/unconfirmed-update']);

    await expect(coordinator.applyUpdates(['app'])).rejects.toMatchObject({
      code: 'APP_UPDATE_VERIFICATION_INCOMPLETE',
    });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(recoveryStore.pending()).toBeUndefined();
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_VERIFICATION_INCOMPLETE', retryable: false },
    });
    await expect(coordinator.relaunchToApply()).rejects.toMatchObject({ code: 'APP_UPDATE_NOT_READY' });
  });

  it('rejects a downloaded version that differs from the checked release', async () => {
    const { coordinator, updater, recoveryStore } = createCoordinator();
    await prepareAvailable(coordinator);
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.reportDownloaded('9.9.9');
      return ['/tmp/wrong-version'];
    });

    await expect(coordinator.applyUpdates(['app'])).rejects.toMatchObject({
      code: 'APP_UPDATE_INTEGRITY_FAILED',
    });
    expect(recoveryStore.pending()).toBeUndefined();
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_INTEGRITY_FAILED', retryable: false },
    });
  });

  it('retries only transient network failures and persists interrupted intent', async () => {
    const { coordinator, updater, recoveryStore } = createCoordinator();
    await prepareAvailable(coordinator);
    const networkError = codedError('ENETUNREACH');
    updater.downloadUpdate.mockImplementation(async () => {
      updater.reportError(networkError);
      throw networkError;
    });

    await expect(coordinator.applyUpdates(['app'])).rejects.toMatchObject({
      code: 'APP_UPDATE_NETWORK_FAILED',
    });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(3);
    expect(recoveryStore.pending()).toMatchObject({
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      attempts: 3,
      status: 'downloading',
    });
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_NETWORK_FAILED', retryable: true },
    });
  });

  it.each([
    ['ERR_UPDATER_INVALID_SIGNATURE', 'APP_UPDATE_INTEGRITY_FAILED', false],
    ['ERR_CHECKSUM_MISMATCH', 'APP_UPDATE_INTEGRITY_FAILED', false],
    ['ENOSPC', 'APP_UPDATE_STORAGE_UNAVAILABLE', true],
    ['HTTP_ERROR_404', 'APP_UPDATE_RELEASE_UNAVAILABLE', false],
    ['ERR_UPDATER_INVALID_UPDATE_INFO', 'APP_UPDATE_RELEASE_INVALID', false],
  ])('does not auto-retry terminal %s failures', async (updaterCode, stateCode, retryable) => {
    const { coordinator, updater, recoveryStore } = createCoordinator();
    await prepareAvailable(coordinator);
    updater.downloadUpdate.mockRejectedValue(codedError(updaterCode));

    await expect(coordinator.applyUpdates(['app'])).rejects.toMatchObject({ code: stateCode });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(recoveryStore.pending()).toBeUndefined();
    const state = appState(coordinator.getState());
    expect(state).toMatchObject({
      phase: 'error',
      error: { code: stateCode, retryable },
    });
    expect(JSON.stringify(state)).not.toContain('/Users/example/private');
  });

  it('recovers a transient failure when a later bounded attempt verifies', async () => {
    const { coordinator, updater, recoveryStore } = createCoordinator();
    await prepareAvailable(coordinator);
    updater.downloadUpdate
      .mockRejectedValueOnce(codedError('ECONNRESET'))
      .mockImplementationOnce(async () => {
        updater.reportDownloaded();
        return ['/tmp/qed2-update'];
      });

    await coordinator.applyUpdates(['app']);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'restart-required',
      latestVersion: '2.1.0',
    });
    expect(recoveryStore.pending()).toMatchObject({
      status: 'verified-ready',
      attempts: 1,
    });
  });

  it('persists verified-ready only as an intent and revalidates it after restart', async () => {
    const recoveryStore = new MemoryRecoveryStore();
    const first = createCoordinator({ recoveryStore });
    await prepareAvailable(first.coordinator);
    await first.coordinator.applyUpdates(['app']);
    expect(recoveryStore.pending()).toMatchObject({
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      status: 'verified-ready',
    });

    const restartedUpdater = new FakeUpdater();
    const restarted = createCoordinator({ updater: restartedUpdater, recoveryStore });
    expect(appState(restarted.coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_REVALIDATION_REQUIRED', retryable: true },
    });
    await expect(restarted.coordinator.relaunchToApply()).rejects.toMatchObject({
      code: 'APP_UPDATE_NOT_READY',
    });

    expect(await restarted.coordinator.resumePendingDownload()).toBe(true);
    expect(restartedUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(restartedUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(appState(restarted.coordinator.getState()).phase).toBe('restart-required');
  });

  it('deduplicates concurrent automatic recovery before the asynchronous journal read', async () => {
    const recoveryStore = new MemoryRecoveryStore();
    recoveryStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-08-07T00:00:00.000Z',
      attempts: 0,
      status: 'downloading',
    });
    let finishInspect!: (journal: Awaited<ReturnType<ResumableArtifactDownloader['inspect']>>) => void;
    const inspect = vi.fn(() => new Promise<Awaited<ReturnType<ResumableArtifactDownloader['inspect']>>>((resolve) => {
      finishInspect = resolve;
    }));
    const downloader = {
      hasRecoverySync: () => true,
      inspect,
    } as unknown as ResumableArtifactDownloader;
    const { coordinator } = createCoordinator({
      recoveryStore,
      downloader,
      selfUpdateAvailability: { available: true, reason: 'unsigned-manual' },
    });

    const first = coordinator.resumePendingDownload();
    const second = coordinator.resumePendingDownload();
    expect(second).toBe(first);
    expect(inspect).toHaveBeenCalledTimes(1);
    finishInspect({
      formatVersion: 1,
      state: 'partial',
      fromVersion: '2.0.0',
      targetVersion: '2.1.0',
      releaseTag: 'v2.1.0',
      assetName: 'QED2-2.1.0-mac-arm64.dmg',
      expectedSize: 1,
      sha256: '1'.repeat(64),
      sha512: Buffer.alloc(64, 1).toString('base64'),
      downloadedBytes: 0,
      validator: null,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
      automaticAttempts: 0,
      manualRetryRequired: true,
    });

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(recoveryStore.pending()).toMatchObject({ attempts: 0, status: 'downloading' });
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_STORAGE_UNAVAILABLE', retryable: true },
    });
  });

  it('preserves restart-required and recovery intent when checking again', async () => {
    const { coordinator, updater, recoveryStore } = createCoordinator();
    await prepareAvailable(coordinator);
    await coordinator.applyUpdates(['app']);
    const pendingBeforeCheck = recoveryStore.pending();

    await expect(coordinator.checkForUpdates()).resolves.toEqual([
      expect.objectContaining({ target: 'app', updateAvailable: true, latestVersion: '2.1.0' }),
    ]);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(appState(coordinator.getState()).phase).toBe('restart-required');
    expect(recoveryStore.pending()).toEqual(pendingBeforeCheck);
  });

  it('fails closed when restarted verified-ready cache cannot be revalidated', async () => {
    const recoveryStore = new MemoryRecoveryStore();
    recoveryStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-08-07T00:00:00.000Z',
      attempts: 0,
      status: 'verified-ready',
    });
    const updater = new FakeUpdater();
    updater.downloadUpdate.mockRejectedValue(codedError('ERR_CHECKSUM_MISMATCH'));
    const { coordinator } = createCoordinator({ updater, recoveryStore });

    expect(await coordinator.resumePendingDownload()).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(recoveryStore.pending()).toBeUndefined();
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_INTEGRITY_FAILED', retryable: false },
    });
    await expect(coordinator.relaunchToApply()).rejects.toMatchObject({ code: 'APP_UPDATE_NOT_READY' });
  });

  it('discards recovery state after the app version changes', () => {
    const recoveryStore = new MemoryRecoveryStore();
    recoveryStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-08-07T00:00:00.000Z',
      attempts: 0,
      status: 'verified-ready',
    });

    const { coordinator } = createCoordinator({ appVersion: '2.1.0', recoveryStore });
    expect(recoveryStore.pending()).toBeUndefined();
    expect(appState(coordinator.getState()).phase).toBe('idle');
  });

  it('expires stale recovery records and caps automatic cross-process retries', () => {
    const expiredStore = new MemoryRecoveryStore();
    expiredStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-07-01T00:00:00.000Z',
      attempts: 1,
      status: 'downloading',
    });
    const expired = createCoordinator({ recoveryStore: expiredStore });
    expect(expired.coordinator.hasPendingDownload()).toBe(false);
    expect(expiredStore.pending()).toBeUndefined();

    const exhaustedStore = new MemoryRecoveryStore();
    exhaustedStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-08-07T00:00:00.000Z',
      attempts: 8,
      status: 'downloading',
    });
    const exhausted = createCoordinator({ recoveryStore: exhaustedStore });
    expect(exhausted.coordinator.hasPendingDownload()).toBe(false);
    expect(exhaustedStore.pending()).toBeUndefined();
    expect(appState(exhausted.coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_RECOVERY_LIMIT_REACHED', retryable: true },
    });
  });

  it('enforces the automatic retry ceiling inside the final recovery round', async () => {
    const recoveryStore = new MemoryRecoveryStore();
    recoveryStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-08-07T00:00:00.000Z',
      attempts: 7,
      status: 'downloading',
    });
    const updater = new FakeUpdater();
    updater.downloadUpdate.mockRejectedValue(codedError('ECONNRESET'));
    const { coordinator } = createCoordinator({ updater, recoveryStore });

    expect(await coordinator.resumePendingDownload()).toBe(false);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(recoveryStore.pending()).toBeUndefined();
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_RECOVERY_LIMIT_REACHED', retryable: true },
    });
  });

  it('reports unsupported installed formats instead of claiming they are current', async () => {
    const updater = new FakeUpdater();
    updater.checkResult = null;
    const { coordinator } = createCoordinator({ updater });

    await expect(coordinator.checkForUpdates()).rejects.toMatchObject({
      code: 'APP_UPDATE_UNSUPPORTED_INSTALL',
    });
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_UNSUPPORTED_INSTALL', retryable: false },
    });
  });

  it('still completes approved Core and bank checks when the platform updater is offline', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockRejectedValue(codedError('ETIMEDOUT'));
    const { coordinator, approvedRelease } = createCoordinator({ updater });

    await expect(coordinator.checkForUpdates()).rejects.toMatchObject({
      code: 'APP_UPDATE_CHECK_NETWORK_FAILED',
    });
    expect(approvedRelease).toHaveBeenCalledTimes(1);
    expect(coordinator.getState().targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'core', phase: 'complete' }),
      expect.objectContaining({ target: 'bank', phase: 'complete' }),
    ]));
  });

  it('recognizes nested undici causes and reports one public release-channel failure', async () => {
    const networkCause = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), {
      code: 'ENOTFOUND',
    });
    const fetchFailure = Object.assign(new TypeError('fetch failed'), { cause: networkCause });
    const { coordinator, approvedRelease, updater } = createCoordinator({
      approvedRelease: async () => {
        throw fetchFailure;
      },
    });

    await expect(coordinator.checkForUpdates()).rejects.toMatchObject({
      code: 'APP_UPDATE_CHECK_NETWORK_FAILED',
    });
    expect(approvedRelease).toHaveBeenCalledTimes(3);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(coordinator.getState().targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'core',
        phase: 'complete',
        message: 'In Desktop-Releases enthalten; kein eigener Update-Kanal.',
      }),
      expect.objectContaining({
        target: 'bank',
        phase: 'complete',
        message: 'In Desktop-Releases enthalten; kein eigener Update-Kanal.',
      }),
    ]));
  });

  it('uses the bounded production retry schedule 0/2/10/30 seconds', async () => {
    const updater = new FakeUpdater();
    const approvedRelease = vi.fn(async () => {
      throw codedError('ECONNRESET');
    });
    const wait = vi.fn(async () => {});
    const coordinator = new UpdateCoordinator(
      '2.0.0',
      true,
      runtimeVersions,
      logger(),
      {
        updater: updater as unknown as AppUpdater,
        approvedRelease,
        wait,
        now: () => Date.parse('2026-08-07T01:00:00.000Z'),
      },
    );

    await expect(coordinator.checkForUpdates()).rejects.toMatchObject({
      code: 'APP_UPDATE_CHECK_NETWORK_FAILED',
    });
    expect(approvedRelease).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls).toEqual([[2_000], [10_000], [30_000]]);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('treats the absence of a public Desktop release as a neutral unpublished state', async () => {
    const { coordinator, approvedRelease, updater } = createCoordinator({
      approvedRelease: async () => undefined,
    });

    const results = await coordinator.checkForUpdates();
    expect(approvedRelease).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(results).toHaveLength(3);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'app', latestVersion: '2.0.0', updateAvailable: false }),
      expect.objectContaining({
        target: 'core',
        latestVersion: `2.0.0-core (${CORE_COMMIT.slice(0, 12)})`,
        updateAvailable: false,
      }),
      expect.objectContaining({
        target: 'bank',
        latestVersion: BANK_COMMIT.slice(0, 12),
        updateAvailable: false,
      }),
    ]));
    expect(coordinator.getState().targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'core',
        phase: 'complete',
        message: expect.stringContaining('Noch keine öffentliche Desktop-Veröffentlichung'),
      }),
    ]));
  });

  it('does not relabel a prerequisite check failure as a download failure', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockRejectedValue(codedError('ERR_UPDATER_INVALID_UPDATE_INFO'));
    const { coordinator } = createCoordinator({ updater });

    await expect(coordinator.applyUpdates(['app'])).resolves.toBeUndefined();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_RELEASE_INVALID', retryable: false },
    });
  });

  it('disables update commands and recovery for unpacked builds without updater metadata', async () => {
    const recoveryStore = new MemoryRecoveryStore();
    recoveryStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-08-07T00:00:00.000Z',
      attempts: 0,
      status: 'downloading',
    });
    const { coordinator, updater, approvedRelease } = createCoordinator({
      recoveryStore,
      selfUpdateAvailability: { available: false, reason: 'configuration-missing' },
    });

    expect(coordinator.isSelfUpdateAvailable()).toBe(false);
    expect(coordinator.hasPendingDownload()).toBe(false);
    expect(recoveryStore.pending()).toBeUndefined();
    await expect(coordinator.checkForUpdates()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'app', updateAvailable: false }),
    ]));
    expect(approvedRelease).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await expect(coordinator.applyUpdates(['app'])).rejects.toMatchObject({
      code: 'APP_UPDATE_UNAVAILABLE',
    });
    expect(coordinator.getState().targets.every((target) => target.phase === 'complete')).toBe(true);
  });

  it('recovers a transient provider check within the bounded retry policy', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates
      .mockRejectedValueOnce(new Error('Request timed out'))
      .mockResolvedValueOnce({
        isUpdateAvailable: true,
        updateInfo: { version: '2.1.0' },
      });
    const { coordinator } = createCoordinator({ updater });

    await expect(coordinator.checkForUpdates()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'app', updateAvailable: true }),
    ]));
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(appState(coordinator.getState()).phase).toBe('available');
  });

  it.each([
    'Cannot download "https://github.com/qed2/release.bin", status 503: Service Unavailable',
    'Request timed out',
    'Request has been aborted by the server',
  ])('recognizes electron-updater transient errors without a code: %s', async (message) => {
    const { coordinator, updater } = createCoordinator();
    await prepareAvailable(coordinator);
    updater.downloadUpdate.mockRejectedValue(new Error(message));

    await expect(coordinator.applyUpdates(['app'])).rejects.toMatchObject({
      code: 'APP_UPDATE_NETWORK_FAILED',
    });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(3);
  });

  it('blocks duplicate downloads while one apply operation is active', async () => {
    const { coordinator, updater } = createCoordinator();
    await prepareAvailable(coordinator);
    let finishDownload!: () => void;
    updater.downloadUpdate.mockImplementationOnce(() => new Promise((resolve) => {
      finishDownload = () => resolve(['/tmp/qed2-update']);
    }));

    const first = coordinator.applyUpdates(['app']);
    await expect(coordinator.applyUpdates(['app'])).rejects.toMatchObject({ code: 'APP_UPDATE_BUSY' });
    updater.reportDownloaded();
    finishDownload();
    await first;
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['deb', () => new DebUpdater(), { available: true, reason: 'ready' } as const],
    ['rpm', () => new RpmUpdater(), { available: true, reason: 'ready' } as const],
    ['zip', () => new FakeUpdater(), { available: true, reason: 'unsigned-manual' } as const],
    ['exe', () => new FakeUpdater(), { available: true, reason: 'unsigned-manual' } as const],
  ])('refuses a manual .%s package outside the managed resumable cache', async (_extension, makeUpdater, availability) => {
    const updater = makeUpdater();
    const revealInstallPackage = vi.fn();
    const { coordinator } = createCoordinator({
      updater,
      selfUpdateAvailability: availability,
      revealInstallPackage,
    });

    await prepareAvailable(coordinator);
    await expect(coordinator.applyUpdates(['app'])).rejects.toMatchObject({
      code: 'APP_UPDATE_RELEASE_INVALID',
    });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(revealInstallPackage).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('uses the resumable manifest path for unsigned macOS and only reveals the verified DMG', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qed2-manual-resumable-'));
    try {
      const bytes = Buffer.from('verified unsigned dmg');
      const assetName = 'QED2-2.1.0-mac-arm64.dmg';
      const asset = {
        name: assetName,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sha512: createHash('sha512').update(bytes).digest('base64'),
        downloadUrl: `https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/${assetName}`,
        target: { platform: 'darwin', arch: 'arm64', installMode: 'manual-package' } as const,
      };
      const baseRelease = approvedDesktopRelease();
      const release = approvedDesktopRelease('2.1.0', {
        assets: { ...baseRelease.assets, [assetName]: asset },
      });
      const fetchMock = vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: {
          'content-length': String(bytes.length),
          etag: '"qed2-2.1.0"',
        },
      })) as unknown as typeof fetch;
      const downloader = new ResumableArtifactDownloader(directory, logger(), {
        fetch: fetchMock,
        reserveBytes: 0,
        checkpointBytes: 1,
        availableBytes: async () => 1024 * 1024,
      });
      const updater = new FakeUpdater();
      const revealInstallPackage = vi.fn();
      const { coordinator } = createCoordinator({
        updater,
        downloader,
        platform: 'darwin',
        arch: 'arm64',
        approvedRelease: async () => release,
        selfUpdateAvailability: { available: true, reason: 'unsigned-manual' },
        revealInstallPackage,
      });

      await prepareAvailable(coordinator);
      await coordinator.applyUpdates(['app']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(updater.downloadUpdate).not.toHaveBeenCalled();
      expect(appState(coordinator.getState())).toMatchObject({
        phase: 'restart-required',
        installMode: 'manual-package',
      });
      await expect(coordinator.relaunchToApply()).rejects.toMatchObject({
        code: 'APP_UPDATE_MANUAL_INSTALL_REQUIRED',
      });
      expect(revealInstallPackage).toHaveBeenCalledWith(expect.stringMatching(/\.dmg$/));
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when a verified manual package is tampered with before reveal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qed2-manual-tamper-'));
    try {
      const bytes = Buffer.from('verified unsigned dmg');
      const assetName = 'QED2-2.1.0-mac-arm64.dmg';
      const asset = {
        name: assetName,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sha512: createHash('sha512').update(bytes).digest('base64'),
        downloadUrl: `https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/${assetName}`,
        target: { platform: 'darwin', arch: 'arm64', installMode: 'manual-package' } as const,
      };
      const baseRelease = approvedDesktopRelease();
      const release = approvedDesktopRelease('2.1.0', {
        assets: { ...baseRelease.assets, [assetName]: asset },
      });
      const fetchMock = vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.length), etag: '"qed2-2.1.0"' },
      })) as unknown as typeof fetch;
      const downloader = new ResumableArtifactDownloader(directory, logger(), {
        fetch: fetchMock,
        reserveBytes: 0,
        checkpointBytes: 1,
        availableBytes: async () => 1024 * 1024,
      });
      const revealInstallPackage = vi.fn();
      const { coordinator, recoveryStore } = createCoordinator({
        downloader,
        platform: 'darwin',
        arch: 'arm64',
        approvedRelease: async () => release,
        selfUpdateAvailability: { available: true, reason: 'unsigned-manual' },
        revealInstallPackage,
      });

      await prepareAvailable(coordinator);
      await coordinator.applyUpdates(['app']);
      await writeFile(join(directory, assetName), Buffer.alloc(bytes.length, 0x78));

      await expect(coordinator.relaunchToApply()).rejects.toMatchObject({
        code: 'APP_UPDATE_INTEGRITY_FAILED',
      });
      expect(revealInstallPackage).not.toHaveBeenCalled();
      expect(recoveryStore.pending()).toBeUndefined();
      expect(downloader.hasRecoverySync()).toBe(false);
      expect(appState(coordinator.getState())).toMatchObject({
        phase: 'error',
        error: { code: 'APP_UPDATE_INTEGRITY_FAILED', retryable: false },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when a manual package target disagrees with its filename', async () => {
    const release = approvedDesktopRelease();
    const assetName = 'QED2-2.1.0-mac-arm64.dmg';
    const mismatched: ApprovedDesktopRelease = {
      ...release,
      assets: {
        ...release.assets,
        [assetName]: {
          ...release.assets[assetName]!,
          target: { platform: 'darwin', arch: 'x64', installMode: 'manual-package' },
        },
      },
    };
    const { coordinator, updater } = createCoordinator({
      approvedRelease: async () => mismatched,
      selfUpdateAvailability: { available: true, reason: 'unsigned-manual' },
      platform: 'darwin',
      arch: 'arm64',
    });

    await expect(coordinator.checkForUpdates()).rejects.toMatchObject({
      code: 'APP_UPDATE_RELEASE_INVALID',
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('treats an explicitly unsigned Linux AppImage as reveal-only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qed2-appimage-resumable-'));
    try {
      const bytes = Buffer.from('verified unsigned appimage');
      const assetName = 'QED2-2.1.0-linux-x64.AppImage';
      const asset = {
        name: assetName,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sha512: createHash('sha512').update(bytes).digest('base64'),
        downloadUrl: `https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/${assetName}`,
        target: { platform: 'linux', arch: 'x64', installMode: 'manual-package' } as const,
      };
      const baseRelease = approvedDesktopRelease();
      const release = approvedDesktopRelease('2.1.0', {
        assets: { ...baseRelease.assets, [assetName]: asset },
      });
      const fetchMock = vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.length), etag: '"qed2-2.1.0"' },
      })) as unknown as typeof fetch;
      const downloader = new ResumableArtifactDownloader(directory, logger(), {
        fetch: fetchMock,
        reserveBytes: 0,
        checkpointBytes: 1,
        availableBytes: async () => 1024 * 1024,
      });
      const updater = new AppImageUpdater();
      const revealInstallPackage = vi.fn();
      const { coordinator } = createCoordinator({
        updater,
        downloader,
        platform: 'linux',
        arch: 'x64',
        approvedRelease: async () => release,
        selfUpdateAvailability: { available: true, reason: 'unsigned-manual' },
        revealInstallPackage,
      });

      await prepareAvailable(coordinator);
      await coordinator.applyUpdates(['app']);
      expect(updater.downloadUpdate).not.toHaveBeenCalled();
      await expect(coordinator.relaunchToApply()).rejects.toMatchObject({
        code: 'APP_UPDATE_MANUAL_INSTALL_REQUIRED',
      });
      expect(revealInstallPackage).toHaveBeenCalledWith(expect.stringMatching(/\.AppImage$/));
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['deb', () => new DebUpdater()],
    ['rpm', () => new RpmUpdater()],
  ])('selects the typed Linux target for the current .%s package updater', async (extension, makeUpdater) => {
    const directory = await mkdtemp(join(tmpdir(), `qed2-${extension}-target-`));
    try {
      const bytes = Buffer.from(`verified unsigned ${extension}`);
      const assetName = `QED2-2.1.0-linux-x64.${extension}`;
      const baseRelease = approvedDesktopRelease();
      const asset = {
        ...baseRelease.assets[assetName]!,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sha512: createHash('sha512').update(bytes).digest('base64'),
      };
      const release: ApprovedDesktopRelease = {
        ...baseRelease,
        assets: { ...baseRelease.assets, [assetName]: asset },
      };
      const fetchMock = vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.length), etag: '"qed2-2.1.0"' },
      })) as unknown as typeof fetch;
      const downloader = new ResumableArtifactDownloader(directory, logger(), {
        fetch: fetchMock,
        reserveBytes: 0,
        checkpointBytes: 1,
        availableBytes: async () => 1024 * 1024,
      });
      const updater = makeUpdater();
      const revealInstallPackage = vi.fn();
      const { coordinator } = createCoordinator({
        updater,
        downloader,
        platform: 'linux',
        arch: 'x64',
        approvedRelease: async () => release,
        selfUpdateAvailability: { available: true, reason: 'unsigned-manual' },
        revealInstallPackage,
      });

      await prepareAvailable(coordinator);
      await coordinator.applyUpdates(['app']);
      expect(updater.downloadUpdate).not.toHaveBeenCalled();
      await expect(coordinator.relaunchToApply()).rejects.toMatchObject({
        code: 'APP_UPDATE_MANUAL_INSTALL_REQUIRED',
      });
      expect(revealInstallPackage).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`\\.${extension}$`)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('pauses ENOSPC recovery until an explicit retry after space is freed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qed2-storage-gate-'));
    try {
      const bytes = Buffer.from('verified unsigned dmg after storage recovery');
      const assetName = 'QED2-2.1.0-mac-arm64.dmg';
      const asset = {
        name: assetName,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sha512: createHash('sha512').update(bytes).digest('base64'),
        downloadUrl: `https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/${assetName}`,
        target: { platform: 'darwin', arch: 'arm64', installMode: 'manual-package' } as const,
      };
      const baseRelease = approvedDesktopRelease();
      const release = approvedDesktopRelease('2.1.0', {
        assets: { ...baseRelease.assets, [assetName]: asset },
      });
      const fetchMock = vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.length), etag: '"qed2-2.1.0"' },
      })) as unknown as typeof fetch;
      let availableBytes = 0;
      const downloader = new ResumableArtifactDownloader(directory, logger(), {
        fetch: fetchMock,
        reserveBytes: 0,
        checkpointBytes: 1,
        availableBytes: async () => availableBytes,
        now: () => Date.parse('2026-08-07T01:00:00.000Z'),
      });
      const recoveryStore = new MemoryRecoveryStore();
      const { coordinator } = createCoordinator({
        recoveryStore,
        downloader,
        platform: 'darwin',
        arch: 'arm64',
        approvedRelease: async () => release,
        selfUpdateAvailability: { available: true, reason: 'unsigned-manual' },
      });

      await prepareAvailable(coordinator);
      await expect(coordinator.applyUpdates(['app'])).rejects.toMatchObject({
        code: 'APP_UPDATE_STORAGE_UNAVAILABLE',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(recoveryStore.pending()).toMatchObject({ attempts: 0, status: 'downloading' });
      await expect(downloader.inspect()).resolves.toMatchObject({
        automaticAttempts: 0,
        manualRetryRequired: true,
      });

      await expect(coordinator.resumePendingDownload()).resolves.toBe(false);
      await expect(coordinator.resumePendingDownload()).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(recoveryStore.pending()).toMatchObject({ attempts: 0 });

      availableBytes = 1024 * 1024;
      await coordinator.applyUpdates(['app']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(recoveryStore.pending()).toMatchObject({ attempts: 0, status: 'verified-ready' });
      await expect(downloader.inspect()).resolves.toMatchObject({
        automaticAttempts: 0,
        state: 'verified',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stops resumable cross-process recovery at eight failures and explicit retry resets the budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qed2-resumable-budget-'));
    try {
      const bytes = Buffer.from('verified unsigned dmg after retry');
      const assetName = 'QED2-2.1.0-mac-arm64.dmg';
      const asset = {
        name: assetName,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sha512: createHash('sha512').update(bytes).digest('base64'),
        downloadUrl: `https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/${assetName}`,
        target: { platform: 'darwin', arch: 'arm64', installMode: 'manual-package' } as const,
      };
      const baseRelease = approvedDesktopRelease();
      const release = approvedDesktopRelease('2.1.0', {
        assets: { ...baseRelease.assets, [assetName]: asset },
      });
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(codedError('ECONNRESET'))
        .mockResolvedValue(new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length), etag: '"qed2-2.1.0"' },
        })) as unknown as typeof fetch;
      const downloader = new ResumableArtifactDownloader(directory, logger(), {
        fetch: fetchMock,
        reserveBytes: 0,
        checkpointBytes: 1,
        availableBytes: async () => 1024 * 1024,
        now: () => Date.parse('2026-08-07T01:00:00.000Z'),
      });
      const recoveryStore = new MemoryRecoveryStore();
      recoveryStore.set('desktop-update', 'pending-app-download', {
        fromVersion: '2.0.0',
        latestVersion: '2.1.0',
        requestedAt: '2026-08-07T00:00:00.000Z',
        attempts: 7,
        status: 'downloading',
      });
      const { coordinator } = createCoordinator({
        recoveryStore,
        downloader,
        platform: 'darwin',
        arch: 'arm64',
        approvedRelease: async () => release,
        selfUpdateAvailability: { available: true, reason: 'unsigned-manual' },
      });

      await expect(coordinator.resumePendingDownload()).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(recoveryStore.pending()).toMatchObject({ attempts: 8, status: 'downloading' });
      await expect(downloader.inspect()).resolves.toMatchObject({ automaticAttempts: 8, state: 'partial' });
      expect(appState(coordinator.getState())).toMatchObject({
        phase: 'error',
        error: { code: 'APP_UPDATE_RECOVERY_LIMIT_REACHED', retryable: true },
      });
      expect(coordinator.hasPendingDownload()).toBe(false);

      await coordinator.applyUpdates(['app']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(recoveryStore.pending()).toMatchObject({ attempts: 0, status: 'verified-ready' });
      await expect(downloader.inspect()).resolves.toMatchObject({ automaticAttempts: 0, state: 'verified' });
      expect(appState(coordinator.getState()).phase).toBe('restart-required');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('relaunches exactly once only after verification and rolls back synchronous launch errors', async () => {
    const { coordinator, updater, recoveryStore } = createCoordinator();
    await expect(coordinator.relaunchToApply()).rejects.toMatchObject({ code: 'APP_UPDATE_NOT_READY' });
    await prepareAvailable(coordinator);
    await coordinator.applyUpdates(['app']);

    const launchError = codedError('EACCES');
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.reportError(launchError);
    });
    await expect(coordinator.relaunchToApply()).rejects.toMatchObject({
      code: 'APP_UPDATE_STORAGE_UNAVAILABLE',
    });
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(coordinator.getState().busy).toBe(false);
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_STORAGE_UNAVAILABLE', retryable: true },
    });
    expect(recoveryStore.pending()).toBeUndefined();
  });

  it('enters installing/busy and rejects a second relaunch after a successful handoff', async () => {
    const { coordinator, updater } = createCoordinator();
    await prepareAvailable(coordinator);
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.reportDownloaded();
      return ['/tmp/QED2-2.1.0.AppImage'];
    });
    await coordinator.applyUpdates(['app']);

    await coordinator.relaunchToApply();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(coordinator.getState().busy).toBe(true);
    expect(appState(coordinator.getState()).phase).toBe('installing');
    await expect(coordinator.relaunchToApply()).rejects.toMatchObject({ code: 'APP_UPDATE_BUSY' });
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('fails closed when quitAndInstall throws before handing off', async () => {
    const { coordinator, updater, recoveryStore } = createCoordinator();
    await prepareAvailable(coordinator);
    await coordinator.applyUpdates(['app']);
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw codedError('EPERM');
    });

    await expect(coordinator.relaunchToApply()).rejects.toMatchObject({
      code: 'APP_UPDATE_STORAGE_UNAVAILABLE',
    });
    expect(coordinator.getState().busy).toBe(false);
    expect(recoveryStore.pending()).toBeUndefined();
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_STORAGE_UNAVAILABLE', retryable: true },
    });
  });

  it('requires native lifecycle confirmation and unlocks after a missing handoff', async () => {
    vi.useFakeTimers();
    const lifecycle = new FakeInstallLifecycle();
    const { coordinator, updater, recoveryStore } = createCoordinator({
      installLifecycle: lifecycle,
      installHandoffTimeoutMs: 1_000,
    });
    await prepareAvailable(coordinator);
    await coordinator.applyUpdates(['app']);
    updater.quitAndInstall.mockImplementationOnce(() => {
      expect(vi.getTimerCount()).toBe(1);
    });

    await coordinator.relaunchToApply();
    expect(coordinator.getState().busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(coordinator.getState().busy).toBe(false);
    expect(recoveryStore.pending()).toBeUndefined();
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_INSTALL_HANDOFF_TIMEOUT', retryable: true },
    });
  });

  it('keeps the install handoff locked once native Electron confirms app exit', async () => {
    vi.useFakeTimers();
    const lifecycle = new FakeInstallLifecycle();
    const { coordinator } = createCoordinator({
      installLifecycle: lifecycle,
      installHandoffTimeoutMs: 1_000,
    });
    await prepareAvailable(coordinator);
    await coordinator.applyUpdates(['app']);

    await coordinator.relaunchToApply();
    lifecycle.confirm();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(coordinator.getState().busy).toBe(true);
    expect(appState(coordinator.getState()).phase).toBe('installing');
  });
});

describe('Desktop release trust boundary', () => {
  it('recognizes only an exact, bounded updater configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qed2-updater-config-'));
    try {
      await expect(inspectSelfUpdateAvailability(true, directory, { platform: 'darwin' })).resolves.toEqual({
        available: false,
        reason: 'configuration-missing',
      });

      const configurationPath = join(directory, 'app-update.yml');
      await writeFile(configurationPath, [
        'owner: tangxiaoyi97',
        'repo: qedv2-client',
        'provider: github',
        'releaseType: release',
        "updaterCacheDirName: '@qed2desktop-updater'",
        '',
      ].join('\n'));
      await expect(inspectSelfUpdateAvailability(true, directory, { platform: 'darwin' })).resolves.toEqual({
        available: true,
        reason: 'ready',
      });

      await writeFile(configurationPath, [
        'owner: tangxiaoyi97',
        'repo: qedv2-client',
        'provider: github',
        'releaseType: release',
        'publisherName:',
        '  - CN=Tang Xiaoyi, O=Barcarolle Studio, C=DE',
        "  - 'CN=QED2 Prüfteam, O=Barcarolle Studio'",
        "updaterCacheDirName: '@qed2desktop-updater'",
        '',
      ].join('\n'));
      await expect(inspectSelfUpdateAvailability(true, directory, { platform: 'win32' })).resolves.toEqual({
        available: true,
        reason: 'ready',
      });

      await writeFile(configurationPath, [
        'owner: tangxiaoyi97',
        'repo: qedv2-client',
        'provider: github',
        'releaseType: release',
        "updaterCacheDirName: '@qed2desktop-updater'",
        'token: must-never-be-accepted',
        '',
      ].join('\n'));
      await expect(inspectSelfUpdateAvailability(true, directory, { platform: 'darwin' })).resolves.toEqual({
        available: false,
        reason: 'configuration-invalid',
      });
      await expect(inspectSelfUpdateAvailability(false, directory)).resolves.toEqual({
        available: false,
        reason: 'development',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('disables in-place updates for an explicitly unsigned desktop release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qed2-unsigned-updater-'));
    try {
      await writeFile(join(directory, 'app-update.yml'), [
        'owner: tangxiaoyi97',
        'repo: qedv2-client',
        'provider: github',
        'releaseType: release',
        "updaterCacheDirName: '@qed2desktop-updater'",
        '',
      ].join('\n'));
      await writeFile(join(directory, 'qed2-unsigned-release.json'), JSON.stringify({
        formatVersion: 1,
        selfUpdate: 'manual-only',
      }));

      await expect(inspectSelfUpdateAvailability(true, directory, { platform: 'darwin' })).resolves.toEqual({
        available: true,
        reason: 'unsigned-manual',
      });
      await expect(inspectSelfUpdateAvailability(true, directory, { platform: 'win32' })).resolves.toEqual({
        available: true,
        reason: 'unsigned-manual',
      });
      await expect(inspectSelfUpdateAvailability(true, directory, {
        platform: 'linux',
        appImagePath: '/opt/QED2-2.0.0.AppImage',
      })).resolves.toEqual({ available: true, reason: 'unsigned-manual' });

      await writeFile(join(directory, 'qed2-unsigned-release.json'), '{"formatVersion":1}');
      await expect(inspectSelfUpdateAvailability(true, directory, { platform: 'darwin' })).resolves.toEqual({
        available: false,
        reason: 'configuration-invalid',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an unpacked Linux directory but accepts supported package identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qed2-linux-updater-'));
    try {
      await writeFile(join(directory, 'app-update.yml'), [
        'owner: tangxiaoyi97',
        'repo: qedv2-client',
        'provider: github',
        'releaseType: release',
        "updaterCacheDirName: '@qed2desktop-updater'",
        '',
      ].join('\n'));
      await expect(inspectSelfUpdateAvailability(true, directory, {
        platform: 'linux',
        appImagePath: '',
      })).resolves.toEqual({
        available: false,
        reason: 'unsupported-installation',
      });

      await writeFile(join(directory, 'package-type'), 'deb\n');
      await expect(inspectSelfUpdateAvailability(true, directory, {
        platform: 'linux',
        appImagePath: '',
      })).resolves.toEqual({ available: true, reason: 'ready' });
      await expect(inspectSelfUpdateAvailability(true, directory, {
        platform: 'linux',
        appImagePath: '/opt/QED2-2.0.0.AppImage',
      })).resolves.toEqual({ available: true, reason: 'ready' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('treats GitHub 404 as not yet published without requesting a repository token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchApprovedDesktopRelease()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/tangxiaoyi97/qedv2-client/releases/latest',
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/authorization/i);
  });

  it('classifies GitHub rate limits as retryable checks without immediate retry amplification', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const recoveryStore = new MemoryRecoveryStore();
    recoveryStore.set('desktop-update', 'pending-app-download', {
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      requestedAt: '2026-08-07T00:00:00.000Z',
      attempts: 1,
      status: 'downloading',
    });
    const { coordinator, approvedRelease, updater } = createCoordinator({
      approvedRelease: fetchApprovedDesktopRelease,
      recoveryStore,
    });

    await expect(coordinator.resumePendingDownload()).resolves.toBe(false);
    expect(approvedRelease).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(recoveryStore.pending()).toMatchObject({
      fromVersion: '2.0.0',
      latestVersion: '2.1.0',
      attempts: 1,
      status: 'downloading',
    });
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'error',
      error: { code: 'APP_UPDATE_CHECK_NETWORK_FAILED', retryable: true },
    });
    expect(coordinator.getState().targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'core',
        phase: 'complete',
        message: 'In Desktop-Releases enthalten; kein eigener Update-Kanal.',
      }),
    ]));
  });

  it('accepts a strict release manifest from the fixed public GitHub release', async () => {
    const manifestUrl =
      'https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/release-manifest.json';
    const approved = approvedDesktopRelease();
    const assets = Object.values(approved.assets).map((asset) => ({
      name: asset.name,
      size: asset.size,
      sha256: asset.sha256,
      sha512: asset.sha512,
      ...(asset.target ? { target: asset.target } : {}),
    }));
    const releaseResponse = new Response(JSON.stringify({
      tag_name: 'v2.1.0',
      draft: false,
      prerelease: false,
      assets: [
        { name: 'release-manifest.json', size: 1, browser_download_url: manifestUrl },
        {
          name: 'SHA256SUMS',
          size: 1,
          browser_download_url: 'https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/SHA256SUMS',
        },
        ...assets.map(({ name, size }) => ({
          name,
          size,
          browser_download_url: `https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/${name}`,
        })),
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const manifestResponse = new Response(JSON.stringify({
      formatVersion: 2,
      tag: 'v2.1.0',
      version: '2.1.0',
      sources: {
        client: CLIENT_COMMIT,
        core: CORE_COMMIT,
        bank: BANK_COMMIT,
      },
      updateMetadata: approved.updateMetadata,
      assets,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(releaseResponse)
      .mockResolvedValueOnce(manifestResponse);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchApprovedDesktopRelease()).resolves.toMatchObject({
      tag: 'v2.1.0',
      version: '2.1.0',
      clientCommit: CLIENT_COMMIT,
      coreCommit: CORE_COMMIT,
      bankCommit: BANK_COMMIT,
      assets: Object.fromEntries(assets.map((asset) => [asset.name, expect.objectContaining(asset)])),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(manifestUrl);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/authorization/i);
  });

  it('rejects v1, missing SHA-512, and filename/target mismatches in the public release manifest', async () => {
    const approved = approvedDesktopRelease();
    const assets = Object.values(approved.assets).map((asset) => ({
      name: asset.name,
      size: asset.size,
      sha256: asset.sha256,
      sha512: asset.sha512,
      ...(asset.target ? { target: { ...asset.target } } : {}),
    }));
    const baseManifest = {
      formatVersion: 2,
      tag: 'v2.1.0',
      version: '2.1.0',
      sources: { client: CLIENT_COMMIT, core: CORE_COMMIT, bank: BANK_COMMIT },
      updateMetadata: approved.updateMetadata,
      assets,
    };
    const legacy = { ...structuredClone(baseManifest), formatVersion: 1 };
    const missingSha512 = structuredClone(baseManifest) as unknown as {
      assets: Array<Record<string, unknown>>;
    };
    delete missingSha512.assets[0]!.sha512;
    const mismatchedTarget = structuredClone(baseManifest) as unknown as {
      assets: Array<Record<string, unknown>>;
    };
    const armDmg = mismatchedTarget.assets.find((asset) => asset.name === 'QED2-2.1.0-mac-arm64.dmg');
    (armDmg?.target as Record<string, unknown>).arch = 'x64';

    for (const manifest of [legacy, missingSha512, mismatchedTarget]) {
      const releaseAssets = [
        {
          name: 'release-manifest.json',
          size: 1,
          browser_download_url:
            'https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/release-manifest.json',
        },
        {
          name: 'SHA256SUMS',
          size: 1,
          browser_download_url: 'https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/SHA256SUMS',
        },
        ...assets.map((asset) => ({
          name: asset.name,
          size: asset.size,
          browser_download_url:
            `https://github.com/tangxiaoyi97/qedv2-client/releases/download/v2.1.0/${asset.name}`,
        })),
      ];
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          tag_name: 'v2.1.0', draft: false, prerelease: false, assets: releaseAssets,
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 })));

      await expect(fetchApprovedDesktopRelease()).rejects.toMatchObject({
        code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
      });
    }
  });

  it('rejects malformed or oversized public release data before electron-updater runs', async () => {
    const oversized = new Response('{}', {
      status: 200,
      headers: { 'content-length': String(10 * 1024 * 1024) },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(oversized));

    await expect(fetchApprovedDesktopRelease()).rejects.toMatchObject({
      code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
    });
  });
});
