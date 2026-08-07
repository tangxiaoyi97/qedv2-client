import { EventEmitter } from 'node:events';
import type { UpdateSnapshot } from '@qed2/core-logic';
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UpdateCoordinator,
  type RuntimeVersions,
  type UpdateCoordinatorLogger,
  type UpdateInstallLifecycle,
  type UpdateRecoveryStore,
} from '../src/main/update-coordinator.js';

vi.mock('electron-updater', () => ({
  default: { autoUpdater: {} },
}));

const runtimeVersions: RuntimeVersions = {
  coreVersion: '2.0.0-core',
  coreCommit: 'core-commit',
  bankCommit: 'bank-commit',
  coreRepoUrl: 'https://github.com/qed2/core',
  bankRepoUrl: 'https://github.com/qed2/bank',
};

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
  repositoryHead?: (repoUrl: string, branch: string) => Promise<string | undefined>;
  retryDelaysMs?: readonly number[];
  installLifecycle?: UpdateInstallLifecycle;
  installHandoffTimeoutMs?: number;
} = {}): {
  coordinator: UpdateCoordinator;
  updater: FakeUpdater;
  recoveryStore: MemoryRecoveryStore;
  repositoryHead: ReturnType<typeof vi.fn>;
  updateLogger: UpdateCoordinatorLogger;
} {
  const updater = options.updater ?? new FakeUpdater();
  const recoveryStore = options.recoveryStore ?? new MemoryRecoveryStore();
  const repositoryHead = vi.fn(options.repositoryHead ?? (async (repoUrl: string) =>
    repoUrl === runtimeVersions.coreRepoUrl
      ? runtimeVersions.coreCommit
      : runtimeVersions.bankCommit));
  const updateLogger = logger();
  const coordinator = new UpdateCoordinator(
    options.appVersion ?? '2.0.0',
    options.packaged ?? true,
    runtimeVersions,
    updateLogger,
    {
      updater: updater as unknown as AppUpdater,
      recoveryStore,
      repositoryHead,
      retryDelaysMs: options.retryDelaysMs ?? [0, 0, 0],
      wait: async () => {},
      now: () => Date.parse('2026-08-07T01:00:00.000Z'),
      ...(options.installLifecycle ? { installLifecycle: options.installLifecycle } : {}),
      ...(options.installHandoffTimeoutMs !== undefined
        ? { installHandoffTimeoutMs: options.installHandoffTimeoutMs }
        : {}),
    },
  );
  return { coordinator, updater, recoveryStore, repositoryHead, updateLogger };
}

async function prepareAvailable(coordinator: UpdateCoordinator): Promise<void> {
  await coordinator.checkForUpdates();
  expect(appState(coordinator.getState()).phase).toBe('available');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UpdateCoordinator', () => {
  it('configures a stable, explicit and fail-closed updater policy', async () => {
    const { coordinator, updater, repositoryHead } = createCoordinator();

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.autoRunAppAfterInstall).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.fullChangelog).toBe(true);
    expect(updater.disableWebInstaller).toBe(true);

    const results = await coordinator.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(repositoryHead).toHaveBeenCalledWith(runtimeVersions.coreRepoUrl, 'main');
    expect(repositoryHead).toHaveBeenCalledWith(runtimeVersions.bankRepoUrl, 'pastpapers');
    expect(results).toContainEqual({
      target: 'app',
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      updateAvailable: true,
    });
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
    const { coordinator } = createCoordinator({ updater });

    const result = await coordinator.checkForUpdates();
    expect(result[0]).toMatchObject({ latestVersion: '1.9.0', updateAvailable: false });
    expect(appState(coordinator.getState())).toMatchObject({
      phase: 'complete',
      latestVersion: '1.9.0',
    });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
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
      completed: 5,
      total: 10,
      unit: 'bytes',
    });

    updater.reportProgress({ percent: 150, transferred: 15, total: 10 });
    expect(appState(coordinator.getState())).toMatchObject({
      progress: { completed: 15, total: 15, unit: 'bytes' },
      message: expect.stringContaining('(100 %)'),
    });
    updater.reportDownloaded();
    updater.reportDownloaded();
    expect(appState(coordinator.getState()).phase).toBe('verifying');
    expect(() => coordinator.relaunchToApply()).toThrow(expect.objectContaining({
      code: 'APP_UPDATE_BUSY',
    }));
    finishDownload();
    await applying;

    updater.reportProgress({ percent: 1, transferred: 1, total: 100 });
    expect(appState(coordinator.getState())).toMatchObject({ phase: 'restart-required' });
    expect(appState(coordinator.getState()).progress).toBeUndefined();
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
    expect(() => coordinator.relaunchToApply()).toThrow();
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
    expect(() => restarted.coordinator.relaunchToApply()).toThrow();

    expect(await restarted.coordinator.resumePendingDownload()).toBe(true);
    expect(restartedUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(restartedUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(appState(restarted.coordinator.getState()).phase).toBe('restart-required');
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
    expect(() => coordinator.relaunchToApply()).toThrow();
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
      attempts: 24,
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
      attempts: 23,
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

  it('still completes repository checks when the app provider is offline', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockRejectedValue(codedError('ETIMEDOUT'));
    const { coordinator, repositoryHead } = createCoordinator({ updater });

    await expect(coordinator.checkForUpdates()).rejects.toMatchObject({
      code: 'APP_UPDATE_NETWORK_FAILED',
    });
    expect(repositoryHead).toHaveBeenCalledTimes(2);
    expect(coordinator.getState().targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'core', phase: 'complete' }),
      expect.objectContaining({ target: 'bank', phase: 'complete' }),
    ]));
  });

  it('never reports an unverified Core or bank repository as current', async () => {
    const { coordinator } = createCoordinator({
      repositoryHead: async (repoUrl) => {
        if (repoUrl === runtimeVersions.coreRepoUrl) throw new Error('private or offline');
        return undefined;
      },
    });

    const results = await coordinator.checkForUpdates();
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'core', updateAvailable: false }),
      expect.objectContaining({ target: 'bank', updateAvailable: false }),
    ]));
    expect(coordinator.getState().targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'core',
        phase: 'error',
        error: expect.objectContaining({ code: 'CORE_UPDATE_CHECK_FAILED', retryable: true }),
      }),
      expect.objectContaining({
        target: 'bank',
        phase: 'error',
        error: expect.objectContaining({ code: 'BANK_UPDATE_CHECK_FAILED', retryable: true }),
      }),
    ]));
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

  it('relaunches exactly once only after verification and rolls back synchronous launch errors', async () => {
    const { coordinator, updater, recoveryStore } = createCoordinator();
    expect(() => coordinator.relaunchToApply()).toThrow();
    await prepareAvailable(coordinator);
    await coordinator.applyUpdates(['app']);

    const launchError = codedError('EACCES');
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.reportError(launchError);
    });
    expect(() => coordinator.relaunchToApply()).toThrow(expect.objectContaining({
      code: 'APP_UPDATE_STORAGE_UNAVAILABLE',
    }));
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
    await coordinator.applyUpdates(['app']);

    coordinator.relaunchToApply();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(coordinator.getState().busy).toBe(true);
    expect(appState(coordinator.getState()).phase).toBe('installing');
    expect(() => coordinator.relaunchToApply()).toThrow();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('fails closed when quitAndInstall throws before handing off', async () => {
    const { coordinator, updater, recoveryStore } = createCoordinator();
    await prepareAvailable(coordinator);
    await coordinator.applyUpdates(['app']);
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw codedError('EPERM');
    });

    expect(() => coordinator.relaunchToApply()).toThrow(expect.objectContaining({
      code: 'APP_UPDATE_STORAGE_UNAVAILABLE',
    }));
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
    const { coordinator, recoveryStore } = createCoordinator({
      installLifecycle: lifecycle,
      installHandoffTimeoutMs: 1_000,
    });
    await prepareAvailable(coordinator);
    await coordinator.applyUpdates(['app']);

    coordinator.relaunchToApply();
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

    coordinator.relaunchToApply();
    lifecycle.confirm();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(coordinator.getState().busy).toBe(true);
    expect(appState(coordinator.getState()).phase).toBe('installing');
  });
});
