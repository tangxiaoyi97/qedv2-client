import { EventEmitter } from 'node:events';
import type {
  UpdateCheckResult as QedUpdateCheckResult,
  UpdateSnapshot,
  UpdateTargetState,
} from '@qed2/core-logic';
import { shell } from 'electron';
import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import {
  buildReleaseAssetUrl,
  codedReleaseError,
  expectedManualReleaseTargets,
  fetchApprovedDesktopRelease,
  isCanonicalSha512,
  releaseFeedPatterns,
  type ApprovedDesktopRelease,
} from './release-feed.js';
import {
  ResumableArtifactDownloader,
  type ArtifactDescriptor,
  type VerifiedArtifact,
} from './resumable-downloader.js';
import {
  configureUpdaterInstallPolicy,
  inspectSelfUpdateAvailability,
  selectManualReleaseAsset,
  selfUpdateUnavailableMessage,
  verifiedManualInstallPackage,
  type SelfUpdateAvailability,
} from './self-update-install-policy.js';
import {
  classifyUpdateError,
  publicUpdateError,
  retryAtFromError,
  type ClassifiedUpdateError,
} from './update-error-policy.js';
import {
  MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS,
  UpdateRecoveryJournal,
  type PendingAppDownload,
  type UpdateRecoveryStore,
} from './update-recovery-journal.js';

export { fetchApprovedDesktopRelease } from './release-feed.js';
export type { ApprovedDesktopRelease } from './release-feed.js';
export { inspectSelfUpdateAvailability } from './self-update-install-policy.js';
export type { SelfUpdateAvailability } from './self-update-install-policy.js';
export type { UpdateRecoveryStore } from './update-recovery-journal.js';

export interface UpdateCoordinatorLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface RuntimeVersions {
  coreVersion: string;
  coreCommit?: string;
  bankCommit?: string;
  coreRepoUrl: string;
  bankRepoUrl: string;
}

export interface UpdateInstallLifecycle {
  /** Electron's native `before-quit-for-update` handoff confirmation. */
  onBeforeQuitForUpdate(callback: () => void): () => void;
}

export interface UpdateCoordinatorOptions {
  updater?: AppUpdater;
  recoveryStore?: UpdateRecoveryStore;
  approvedRelease?: () => Promise<ApprovedDesktopRelease | undefined>;
  selfUpdateAvailability?: SelfUpdateAvailability;
  /** Test seam; production uses bounded exponential-ish retry delays. */
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
  now?: () => number;
  installLifecycle?: UpdateInstallLifecycle;
  installHandoffTimeoutMs?: number;
  /** Test seam; production reveals verified manager packages in the OS file manager. */
  revealInstallPackage?: (packagePath: string) => void;
  /** Persistent update cache. Production passes userData/updates/v1. */
  downloadRoot?: string;
  downloader?: ResumableArtifactDownloader;
  platform?: NodeJS.Platform;
  arch?: string;
}

type UpdateOperation = 'idle' | 'checking' | 'downloading' | 'installing';
const DEFAULT_RETRY_DELAYS_MS = [0, 2_000, 10_000, 30_000] as const;
const DEFAULT_INSTALL_HANDOFF_TIMEOUT_MS = 30_000;

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function initialTarget(target: UpdateTargetState['target'], version: string): UpdateTargetState {
  return { target, phase: 'idle', currentVersion: version };
}

function shortCommit(commit: string | undefined): string {
  return commit ? commit.slice(0, 12) : 'unbekannt';
}

export class UpdateCoordinator extends EventEmitter {
  private readonly updater: AppUpdater;
  private readonly recoveryJournal: UpdateRecoveryJournal;
  private readonly approvedRelease: () => Promise<ApprovedDesktopRelease | undefined>;
  private readonly selfUpdateAvailability: SelfUpdateAvailability;
  private readonly retryDelaysMs: readonly number[];
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly now: () => number;
  private readonly installHandoffTimeoutMs: number;
  private readonly revealInstallPackage: (packagePath: string) => void;
  private readonly downloader: ResumableArtifactDownloader | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private state: UpdateSnapshot;
  private checking: Promise<QedUpdateCheckResult[]> | undefined;
  private runtimeVersions: RuntimeVersions;
  private activeOperation: UpdateOperation = 'idle';
  private receivedDownloadedEvent = false;
  private downloadedEventVersion: string | undefined;
  private downloadProgressCompleted = 0;
  private downloadProgressTotal: number | undefined;
  private downloadTransactionHighWaterPercent = 0;
  private downloadAttemptNumber = 0;
  private acceptingDownloadEvents = false;
  private installFailure: ClassifiedUpdateError | undefined;
  private resumeInFlight: Promise<boolean> | undefined;
  private manualPackageInstall: boolean;
  private verifiedInstallPackagePath: string | undefined;
  private verifiedInstallArtifact: VerifiedArtifact | undefined;
  private installHandoffConfirmed = false;
  private installWatchdog: NodeJS.Timeout | undefined;
  private checkedRelease: ApprovedDesktopRelease | undefined;

  constructor(
    private readonly appVersion: string,
    packaged: boolean,
    runtimeVersions: RuntimeVersions,
    private readonly logger: UpdateCoordinatorLogger,
    options: UpdateCoordinatorOptions = {},
  ) {
    super();
    this.runtimeVersions = { ...runtimeVersions };
    const { autoUpdater } = electronUpdater;
    this.updater = options.updater ?? autoUpdater;
    this.approvedRelease = options.approvedRelease ?? fetchApprovedDesktopRelease;
    const requestedAvailability = options.selfUpdateAvailability ?? (
      packaged
        ? { available: true, reason: 'ready' as const }
        : { available: false, reason: 'development' as const }
    );
    this.selfUpdateAvailability = packaged
      ? requestedAvailability
      : { available: false, reason: 'development' };
    this.retryDelaysMs = options.retryDelaysMs?.length
      ? [...options.retryDelaysMs]
      : DEFAULT_RETRY_DELAYS_MS;
    this.wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    this.now = options.now ?? Date.now;
    this.recoveryJournal = new UpdateRecoveryJournal(options.recoveryStore, logger, this.now);
    this.installHandoffTimeoutMs = options.installHandoffTimeoutMs ?? DEFAULT_INSTALL_HANDOFF_TIMEOUT_MS;
    this.revealInstallPackage = options.revealInstallPackage ?? ((packagePath) => shell.showItemInFolder(packagePath));
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.downloader = options.downloader ?? (
      options.downloadRoot
        ? new ResumableArtifactDownloader(options.downloadRoot, logger)
        : undefined
    );
    this.manualPackageInstall = configureUpdaterInstallPolicy(
      this.updater,
      this.selfUpdateAvailability,
    ).manualPackageInstall;
    options.installLifecycle?.onBeforeQuitForUpdate(() => this.confirmInstallHandoff());
    this.state = {
      targets: [
        initialTarget('app', appVersion),
        initialTarget('core', `${runtimeVersions.coreVersion} (${shortCommit(runtimeVersions.coreCommit)})`),
        initialTarget('bank', shortCommit(runtimeVersions.bankCommit)),
      ],
      busy: false,
    };
    if (!this.selfUpdateAvailability.available) {
      const message = selfUpdateUnavailableMessage(this.selfUpdateAvailability.reason);
      this.state.targets = this.state.targets.map((target) => ({ ...target, phase: 'complete', message }));
    }
    const pending = this.readPendingDownload();
    const hasFileRecovery = this.downloader?.hasRecoverySync() === true;
    if (pending && pending.fromVersion !== this.appVersion) {
      this.clearPendingDownload();
      this.discardDownloadCache();
    } else if (!this.selfUpdateAvailability.available && (pending || hasFileRecovery)) {
      this.clearPendingDownload();
      this.discardDownloadCache();
    } else if (pending || hasFileRecovery) {
      this.state.targets[0] = {
        target: 'app',
        phase: 'error',
        currentVersion: appVersion,
        ...(pending?.latestVersion ? { latestVersion: pending.latestVersion } : {}),
        message: pending?.status === 'verified-ready'
          ? 'Ein zuvor verifiziertes Update wird vor der Installation erneut sicher bestätigt.'
          : 'Ein unterbrochener Desktop-Download kann automatisch erneut gestartet werden.',
        error: {
          code: pending?.status === 'verified-ready'
            ? 'APP_UPDATE_REVALIDATION_REQUIRED'
            : 'APP_UPDATE_INTERRUPTED',
          message: pending?.status === 'verified-ready'
            ? 'Der verifizierte Cache muss nach dem Neustart erneut bestätigt werden.'
            : 'Der letzte Download wurde nicht abgeschlossen.',
          retryable: true,
        },
      };
    }
    this.bindUpdaterEvents();
  }

  isSelfUpdateAvailable(): boolean {
    return this.selfUpdateAvailability.available;
  }

  getState(): UpdateSnapshot {
    return structuredClone(this.state);
  }

  hasPendingDownload(): boolean {
    if (!this.selfUpdateAvailability.available) {
      this.clearPendingDownload();
      this.discardDownloadCache();
      return false;
    }
    const pending = this.readPendingDownload();
    if (!pending) return this.downloader?.hasRecoverySync() === true;
    if (
      pending.status === 'downloading' &&
      pending.attempts >= MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS
    ) {
      // Keep the exhausted record. Removing it while a byte journal remains
      // would make the next timer/process mistake that journal for a fresh
      // recovery and silently reset the safety budget. An explicit apply
      // request writes a new intent with attempts=0.
      if (!this.downloader) this.clearPendingDownload();
      this.patchTarget('app', {
        phase: 'error',
        message: 'Die automatische Wiederherstellung wurde begrenzt. Bitte prüfe das Update manuell erneut.',
        error: {
          code: 'APP_UPDATE_RECOVERY_LIMIT_REACHED',
          message: 'Die automatische Wiederherstellung wurde begrenzt. Bitte prüfe das Update manuell erneut.',
          retryable: true,
        },
      });
      return false;
    }
    return true;
  }

  /** Re-enters the normal platform updater flow after restart/network recovery. */
  resumePendingDownload(): Promise<boolean> {
    if (this.resumeInFlight) return this.resumeInFlight;
    let tracked: Promise<boolean>;
    tracked = this.performPendingDownloadResume().finally(() => {
      if (this.resumeInFlight === tracked) this.resumeInFlight = undefined;
    });
    this.resumeInFlight = tracked;
    return tracked;
  }

  private async performPendingDownloadResume(): Promise<boolean> {
    if (!this.selfUpdateAvailability.available || !this.hasPendingDownload() || this.state.busy) return false;
    if (this.downloader) {
      try {
        const journal = await this.downloader.inspect();
        if (journal && journal.automaticAttempts >= MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS) {
          const message = 'Die automatische Wiederherstellung wurde begrenzt. Bitte prüfe das Update manuell erneut.';
          this.patchTarget('app', {
            phase: 'error',
            message,
            error: { code: 'APP_UPDATE_RECOVERY_LIMIT_REACHED', message, retryable: true },
          });
          return false;
        }
        if (journal?.manualRetryRequired) {
          const message = 'Der Download wartet auf freien Speicher. Bitte gib Speicher frei und starte ihn danach ausdrücklich erneut.';
          this.patchTarget('app', {
            phase: 'error',
            message,
            error: { code: 'APP_UPDATE_STORAGE_UNAVAILABLE', message, retryable: true },
          });
          return false;
        }
        if (journal?.nextRetryAt && Date.parse(journal.nextRetryAt) > this.now()) return false;
      } catch (error) {
        this.logger.warn('Desktop update recovery journal could not be inspected', error);
        return false;
      }
    }
    this.logger.info('Revalidating persisted desktop update intent through electron-updater');
    try {
      await this.applyUpdatesInternal(['app'], true);
      return this.target('app').phase === 'restart-required';
    } catch (error) {
      this.logger.warn('Interrupted desktop update could not yet be resumed', error);
      return false;
    }
  }

  checkForUpdates(): Promise<QedUpdateCheckResult[]> {
    if (!this.selfUpdateAvailability.available) {
      return Promise.resolve(this.unavailableResults());
    }
    if (this.target('app').phase === 'restart-required') {
      const app = this.target('app');
      return Promise.resolve([{
        target: 'app',
        currentVersion: this.appVersion,
        ...(app.latestVersion ? { latestVersion: app.latestVersion } : {}),
        updateAvailable: true,
        detail: 'Das verifizierte Update ist installationsbereit.',
      }]);
    }
    if (this.state.busy && !this.checking) {
      return Promise.reject(Object.assign(new Error('Eine andere Aktualisierung läuft bereits.'), {
        name: 'UpdateError',
        code: 'APP_UPDATE_BUSY',
      }));
    }
    this.checking ??= this.performCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  async applyUpdates(targets: Array<'app' | 'core' | 'bank'>): Promise<void> {
    await this.applyUpdatesInternal(targets, false);
  }

  private async applyUpdatesInternal(
    targets: Array<'app' | 'core' | 'bank'>,
    automaticRecovery: boolean,
  ): Promise<void> {
    if (this.state.busy) {
      throw Object.assign(new Error('Eine andere Aktualisierung läuft bereits.'), {
        name: 'UpdateError',
        code: 'APP_UPDATE_BUSY',
      });
    }
    const requested = new Set(targets);
    if (requested.has('core') || requested.has('bank')) {
      // Executable Core code is intentionally delivered only inside a verified,
      // versioned desktop release. A bank-only A/B updater can be added without changing
      // this contract; until then, never execute newly downloaded repository
      // code on the user's machine.
      requested.add('app');
    }
    if (!requested.has('app')) return;
    if (!this.selfUpdateAvailability.available) {
      throw Object.assign(new Error(selfUpdateUnavailableMessage(this.selfUpdateAvailability.reason)), {
        name: 'UpdateError',
        code: 'APP_UPDATE_UNAVAILABLE',
      });
    }
    const appState = this.target('app');
    if (appState.phase === 'restart-required' || appState.phase === 'installing') return;
    if (appState.phase !== 'available') {
      try {
        await this.checkForUpdates();
      } catch {
        // The renderer reads the canonical state after every apply request.
        // A failed prerequisite check must remain a check failure there; if
        // we reject, the legacy UI mislabels it as a download failure even
        // though downloadUpdate() was never entered.
        return;
      }
    }
    if (this.target('app').phase !== 'available') return;

    const latestVersion = this.target('app').latestVersion;
    if (latestVersion === undefined) {
      throw publicUpdateError({
        code: 'APP_UPDATE_RELEASE_INVALID',
        message: 'Die GitHub-Veröffentlichung enthält keine gültige Zielversion.',
        retryable: false,
        automaticRetry: false,
      });
    }
    const existingPending = this.readPendingDownload();
    const sameRelease =
      existingPending !== undefined &&
      existingPending.fromVersion === this.appVersion &&
      existingPending.latestVersion === latestVersion;
    const preserveRecoveryBudget = sameRelease && automaticRecovery;
    this.writePendingDownload({
      fromVersion: this.appVersion,
      latestVersion,
      requestedAt: preserveRecoveryBudget
        ? existingPending.requestedAt
        : new Date(this.now()).toISOString(),
      attempts: preserveRecoveryBudget ? existingPending.attempts : 0,
      status: 'downloading',
    });
    if (this.manualPackageInstall) {
      await this.downloadManualPackage(latestVersion, automaticRecovery);
      return;
    }
    this.verifiedInstallPackagePath = undefined;
    this.verifiedInstallArtifact = undefined;
    this.downloadProgressCompleted = 0;
    this.downloadProgressTotal = undefined;
    this.downloadTransactionHighWaterPercent = 0;
    this.downloadAttemptNumber = 0;
    this.patchTarget('app', {
      phase: 'downloading',
      message: 'Desktop-Update wird heruntergeladen …',
    }, { clearProgress: true });
    this.activeOperation = 'downloading';
    this.setBusy(true);
    try {
      for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
        this.downloadAttemptNumber = attempt + 1;
        const delay = this.retryDelaysMs[attempt] ?? 0;
        if (attempt > 0) {
          const highWaterPercent = Math.round(this.downloadTransactionHighWaterPercent);
          this.patchTarget('app', {
            phase: 'downloading',
            progress: {
              completed: this.downloadTransactionHighWaterPercent,
              total: 100,
              unit: 'percent',
            },
            message: `Downloadversuch ${attempt + 1}/${this.retryDelaysMs.length} startet bei 0 %. Frühere Teildaten werden nicht angerechnet; der Transaktions-Höchststand bleibt bei ${highWaterPercent} %.`,
          });
        }
        if (delay > 0) await this.wait(delay);
        this.receivedDownloadedEvent = false;
        this.downloadedEventVersion = undefined;
        this.downloadProgressCompleted = 0;
        this.downloadProgressTotal = undefined;
        this.acceptingDownloadEvents = true;
        try {
          const downloadedPaths = await this.updater.downloadUpdate();
          this.acceptingDownloadEvents = false;
          if (this.target('app').error?.code === 'APP_UPDATE_VERSION_MISMATCH') {
            throw Object.assign(new Error('electron-updater reported a mismatched version'), {
              code: 'ERR_UPDATER_VERSION_MISMATCH',
            });
          }
          if (!this.receivedDownloadedEvent || this.downloadedEventVersion === undefined) {
            throw Object.assign(new Error('electron-updater did not confirm the verified artifact'), {
              code: 'ERR_UPDATER_VERIFICATION_EVENT_MISSING',
            });
          }
          const managerPackagePath = verifiedManualInstallPackage(downloadedPaths);
          if (this.manualPackageInstall && managerPackagePath === undefined) {
            throw Object.assign(new Error('electron-updater did not return a verified manager package path'), {
              code: 'ERR_UPDATER_MANUAL_PACKAGE_PATH_MISSING',
            });
          }
          if (managerPackagePath !== undefined) {
            this.manualPackageInstall = true;
            this.verifiedInstallPackagePath = managerPackagePath;
            this.verifiedInstallArtifact = undefined;
            // BaseUpdater installs again from its normal quit handler unless
            // this flag is disabled after a manager package is identified.
            this.updater.autoInstallOnAppQuit = false;
          }
          this.patchTarget('app', {
            phase: 'restart-required',
            ...(this.downloadedEventVersion ? { latestVersion: this.downloadedEventVersion } : {}),
            installMode: this.manualPackageInstall ? 'manual-package' : 'self',
            message: this.manualPackageInstall
              ? 'Das Installationspaket ist verifiziert und für die manuelle Installation bereit.'
              : 'Update ist verifiziert und wird beim Neustart installiert.',
          });
          return;
        } catch (error) {
          this.acceptingDownloadEvents = false;
          const classified = classifyUpdateError(error, 'downloading');
          const pending = this.readPendingDownload();
          let recoveryBudgetExhausted = false;
          if (pending && classified.automaticRetry) {
            const failure = this.recoveryJournal.recordFailure(pending);
            recoveryBudgetExhausted =
              automaticRecovery &&
              failure.automaticLimitReached;
          }
          this.logger.warn('Desktop update download attempt failed', { attempt: attempt + 1, error });
          const terminalClassification = recoveryBudgetExhausted && classified.automaticRetry
            ? {
                code: 'APP_UPDATE_RECOVERY_LIMIT_REACHED',
                message: 'Die automatische Wiederherstellung wurde begrenzt. Bitte prüfe das Update manuell erneut.',
                retryable: true,
                automaticRetry: false,
              }
            : classified;
          const canRetryAutomatically =
            terminalClassification.automaticRetry && attempt + 1 < this.retryDelaysMs.length;
          if (canRetryAutomatically) continue;

          if (!terminalClassification.automaticRetry) this.clearPendingDownload();
          this.patchTarget('app', {
            phase: 'error',
            message: terminalClassification.message,
            error: {
              code: terminalClassification.code,
              message: terminalClassification.message,
              retryable: terminalClassification.retryable,
            },
          });
          throw publicUpdateError(terminalClassification);
        }
      }
    } finally {
      this.acceptingDownloadEvents = false;
      if (this.activeOperation === 'downloading') this.activeOperation = 'idle';
      this.setBusy(false);
    }
  }

  private async downloadManualPackage(
    latestVersion: string | undefined,
    automaticRecovery: boolean,
  ): Promise<void> {
    const release = this.checkedRelease;
    const asset = release
      ? selectManualReleaseAsset(release, this.platform, this.arch, this.updater)
      : undefined;
    if (!release || !asset || latestVersion !== release.version || !this.downloader) {
      this.clearPendingDownload();
      const invalid: ClassifiedUpdateError = {
        code: 'APP_UPDATE_RELEASE_INVALID',
        message: 'Die GitHub-Veröffentlichung enthält kein passendes manuelles Installationspaket.',
        retryable: false,
        automaticRetry: false,
      };
      this.patchTarget('app', {
        phase: 'error',
        message: invalid.message,
        error: { code: invalid.code, message: invalid.message, retryable: false },
      });
      throw publicUpdateError(invalid);
    }

    const descriptor: ArtifactDescriptor = {
      fromVersion: this.appVersion,
      targetVersion: release.version,
      releaseTag: release.tag,
      assetName: asset.name,
      size: asset.size,
      sha256: asset.sha256,
      sha512: asset.sha512,
      installMode: 'manual-package',
    };
    this.verifiedInstallPackagePath = undefined;
    this.verifiedInstallArtifact = undefined;
    this.activeOperation = 'downloading';
    this.setBusy(true);
    this.patchTarget('app', {
      phase: 'downloading',
      message: 'Desktop-Update wird sicher heruntergeladen …',
      progress: { completed: 0, total: asset.size, unit: 'bytes' },
    });
    try {
      for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
        const delay = this.retryDelaysMs[attempt] ?? 0;
        if (delay > 0) await this.wait(delay);
        try {
          if (attempt === 0 && !automaticRecovery) {
            // A visible user retry creates a fresh automatic-recovery budget
            // but keeps already persisted bytes available for safe reuse.
            await this.downloader.resetAutomaticRecovery();
          }
          const verified = await this.downloader.stage(descriptor, {
            onProgress: ({ persistedBytes, totalBytes }) => {
              if (this.activeOperation !== 'downloading') return;
              this.patchTarget('app', {
                phase: 'downloading',
                progress: { completed: persistedBytes, total: totalBytes, unit: 'bytes' },
                message: attempt > 0
                  ? `Download wird ab ${persistedBytes} Byte fortgesetzt (Versuch ${attempt + 1}/${this.retryDelaysMs.length}) …`
                  : 'Desktop-Update wird sicher heruntergeladen …',
              });
            },
          });
          this.patchTarget('app', {
            phase: 'verifying',
            latestVersion: release.version,
            message: 'Paketgröße und Prüfsumme wurden sicher bestätigt.',
          });
          this.verifiedInstallPackagePath = verified.path;
          this.verifiedInstallArtifact = verified;
          this.updater.autoInstallOnAppQuit = false;
          const pending = this.readPendingDownload();
          this.writePendingDownload({
            fromVersion: this.appVersion,
            latestVersion: release.version,
            requestedAt: pending?.requestedAt ?? new Date(this.now()).toISOString(),
            attempts: pending?.attempts ?? 0,
            status: 'verified-ready',
          });
          this.patchTarget('app', {
            phase: 'restart-required',
            latestVersion: release.version,
            installMode: 'manual-package',
            message: 'Das Installationspaket ist verifiziert und für die manuelle Installation bereit.',
          });
          return;
        } catch (error) {
          const classified = classifyUpdateError(error, 'downloading');
          const pending = this.readPendingDownload();
          let recoveryBudgetExhausted = false;
          let persistedAttempts = 0;
          if (pending && classified.automaticRetry) {
            const failure = this.recoveryJournal.recordFailure(pending);
            persistedAttempts = failure.pending.attempts;
            recoveryBudgetExhausted = failure.automaticLimitReached;
          } else if (pending) {
            persistedAttempts = pending.attempts;
          }
          try {
            const recovery = await this.downloader.recordAutomaticFailure(
              classified.code,
              retryAtFromError(error, this.now()),
              persistedAttempts,
            );
            recoveryBudgetExhausted = recoveryBudgetExhausted || (
              recovery !== undefined &&
              recovery.automaticAttempts >= MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS
            );
          } catch (journalError) {
            this.logger.warn('Could not persist the desktop update recovery budget', journalError);
          }
          this.logger.warn('Resumable desktop update download attempt failed', {
            attempt: attempt + 1,
            error,
          });
          const terminalClassification = recoveryBudgetExhausted && classified.retryable
            ? {
                code: 'APP_UPDATE_RECOVERY_LIMIT_REACHED',
                message: 'Die automatische Wiederherstellung wurde begrenzt. Bitte prüfe das Update manuell erneut.',
                retryable: true,
                automaticRetry: false,
              }
            : classified;
          if (terminalClassification.automaticRetry && attempt + 1 < this.retryDelaysMs.length) continue;
          if (!terminalClassification.retryable || terminalClassification.code === 'APP_UPDATE_INTEGRITY_FAILED') {
            this.clearPendingDownload();
            await this.downloader.discard().catch((discardError) => {
              this.logger.warn('Could not discard an invalid desktop update cache', discardError);
            });
          }
          this.patchTarget('app', {
            phase: 'error',
            latestVersion: release.version,
            message: terminalClassification.message,
            error: {
              code: terminalClassification.code,
              message: terminalClassification.message,
              retryable: terminalClassification.retryable,
            },
          });
          throw publicUpdateError(terminalClassification);
        }
      }
    } finally {
      if (this.activeOperation === 'downloading') this.activeOperation = 'idle';
      this.setBusy(false);
    }
  }

  async relaunchToApply(): Promise<void> {
    if (this.state.busy || this.activeOperation !== 'idle') {
      throw Object.assign(new Error('Eine andere Aktualisierung läuft bereits.'), {
        name: 'UpdateError',
        code: 'APP_UPDATE_BUSY',
      });
    }
    if (this.target('app').phase !== 'restart-required') {
      throw Object.assign(new Error('Kein verifiziertes App-Update ist installationsbereit.'), {
        name: 'UpdateError',
        code: 'APP_UPDATE_NOT_READY',
      });
    }
    if (this.manualPackageInstall) {
      const packagePath = this.verifiedInstallPackagePath;
      const artifact = this.verifiedInstallArtifact;
      const downloader = this.downloader;
      if (packagePath === undefined || artifact === undefined || downloader === undefined) {
        this.clearPendingDownload();
        this.verifiedInstallPackagePath = undefined;
        this.verifiedInstallArtifact = undefined;
        const unavailable: ClassifiedUpdateError = {
          code: 'APP_UPDATE_MANUAL_PACKAGE_UNAVAILABLE',
          message: 'Der sichere Pfad zum verifizierten Installationspaket ist nicht mehr verfügbar. Bitte lade das Update erneut.',
          retryable: true,
          automaticRetry: false,
        };
        this.patchTarget('app', {
          phase: 'error',
          message: unavailable.message,
          error: {
            code: unavailable.code,
            message: unavailable.message,
            retryable: unavailable.retryable,
          },
        });
        throw publicUpdateError(unavailable);
      }
      this.activeOperation = 'installing';
      this.setBusy(true);
      this.patchTarget('app', {
        phase: 'verifying',
        installMode: 'manual-package',
        message: 'Das Installationspaket wird unmittelbar vor der Übergabe erneut geprüft …',
      });
      try {
        const revalidated = await downloader.revalidate(artifact);
        if (revalidated.path !== packagePath) {
          throw Object.assign(new Error('Verified manual package path changed'), {
            code: 'ERR_DOWNLOAD_INTEGRITY',
          });
        }
      } catch (error) {
        this.logger.error('Manual update package failed final integrity verification', error);
        this.clearPendingDownload();
        this.verifiedInstallPackagePath = undefined;
        this.verifiedInstallArtifact = undefined;
        await downloader.discard().catch((discardError) => {
          this.logger.warn('Could not discard the invalid manual update package', discardError);
        });
        const invalid = classifyUpdateError(
          Object.assign(new Error('Manual update package integrity verification failed'), {
            code: 'ERR_DOWNLOAD_INTEGRITY',
          }),
          'installing',
        );
        this.activeOperation = 'idle';
        this.setBusy(false);
        this.patchTarget('app', {
          phase: 'error',
          message: invalid.message,
          error: { code: invalid.code, message: invalid.message, retryable: invalid.retryable },
        });
        throw publicUpdateError(invalid);
      }
      try {
        this.revealInstallPackage(packagePath);
      } catch (error) {
        this.logger.error('Could not reveal the verified update package', error);
        const message = 'Das verifizierte Installationspaket konnte nicht im Dateimanager angezeigt werden. Bitte versuche es erneut.';
        this.patchTarget('app', { phase: 'restart-required', installMode: 'manual-package', message });
        this.activeOperation = 'idle';
        this.setBusy(false);
        throw publicUpdateError({
          code: 'APP_UPDATE_MANUAL_PACKAGE_REVEAL_FAILED',
          message,
          retryable: true,
          automaticRetry: false,
        });
      }
      const message = 'Das verifizierte Installationspaket wurde im Dateimanager markiert. Installiere es manuell; QED2 bleibt geöffnet.';
      this.patchTarget('app', { phase: 'restart-required', installMode: 'manual-package', message });
      this.activeOperation = 'idle';
      this.setBusy(false);
      // The existing UpdatePort is command-shaped and the renderer assumes a
      // fulfilled relaunch request will terminate the app. Reject explicitly
      // so the UI unlocks while preserving verified-ready state for another
      // reveal. This is guidance, never a claim that installation succeeded.
      throw publicUpdateError({
        code: 'APP_UPDATE_MANUAL_INSTALL_REQUIRED',
        message,
        retryable: true,
        automaticRetry: false,
      });
    }
    this.activeOperation = 'installing';
    this.installFailure = undefined;
    this.installHandoffConfirmed = false;
    this.clearInstallWatchdog();
    this.patchTarget('app', { phase: 'installing', message: 'Update wird installiert …' });
    this.setBusy(true);
    // Arm before calling into the updater. Supported self-installers hand off
    // asynchronously; package-manager formats never reach this branch.
    if (
      Number.isFinite(this.installHandoffTimeoutMs) &&
      this.installHandoffTimeoutMs > 0
    ) {
      this.installWatchdog = setTimeout(() => this.handleInstallHandoffTimeout(), this.installHandoffTimeoutMs);
      this.installWatchdog.unref();
    }
    let launchError: unknown;
    try {
      this.updater.quitAndInstall(false, true);
    } catch (error) {
      launchError = error;
    }
    const classified = this.installFailure ?? (
      launchError === undefined ? undefined : classifyUpdateError(launchError, 'installing')
    );
    if (classified) {
      this.clearInstallWatchdog();
      if (launchError !== undefined) {
        this.logger.error('Starting the verified update installer failed', launchError);
      }
      if (!classified.automaticRetry) this.clearPendingDownload();
      this.activeOperation = 'idle';
      this.patchTarget('app', {
        phase: 'error',
        message: classified.message,
        error: {
          code: classified.code,
          message: classified.message,
          retryable: classified.retryable,
        },
      });
      this.setBusy(false);
      throw publicUpdateError(classified);
    }
  }

  private async performCheck(): Promise<QedUpdateCheckResult[]> {
    this.activeOperation = 'checking';
    this.setBusy(true);
    for (const target of ['app', 'core', 'bank'] as const) {
      this.patchTarget(target, { phase: 'checking', message: 'Nach Updates wird gesucht …' });
    }
    const results: QedUpdateCheckResult[] = [];
    try {
      let approvedRelease: ApprovedDesktopRelease | undefined;
      try {
        approvedRelease = await this.checkApprovedReleaseWithRetry();
      } catch (error) {
        this.checkedRelease = undefined;
        this.logger.error('Public Desktop release check failed', error);
        const appFailure = classifyUpdateError(error, 'checking');
        if (!appFailure.retryable) this.clearPendingDownload();
        this.patchTarget('app', {
          phase: 'error',
          message: appFailure.message,
          error: {
            code: appFailure.code,
            message: appFailure.message,
            retryable: appFailure.retryable,
          },
        }, { clearLatestVersion: true });
        this.finishReleaseChannelFailure('core', appFailure);
        this.finishReleaseChannelFailure('bank', appFailure);
        this.recordCheckedAt();
        throw publicUpdateError(appFailure);
      }

      if (approvedRelease === undefined) {
        this.checkedRelease = undefined;
        this.clearPendingDownload();
        this.discardDownloadCache();
        for (const target of ['app', 'core', 'bank'] as const) {
          results.push(this.finishUnpublishedCheck(target));
        }
        this.recordCheckedAt();
        return results;
      }

      this.checkedRelease = approvedRelease;

      let appFailure: ClassifiedUpdateError | undefined;
      try {
        const appResult = await this.checkAppUpdaterWithRetry();
        if (appResult === null) {
          throw Object.assign(new Error('electron-updater does not support this installed format'), {
            code: 'ERR_UPDATER_OLD_FILE_NOT_FOUND',
          });
        }
        const latest = appResult.updateInfo.version;
        if (latest !== approvedRelease.version) {
          throw codedReleaseError(
            'electron-updater and the approved Desktop release disagree',
            'ERR_UPDATER_INVALID_RELEASE_FEED',
          );
        }
        // electron-updater remains authoritative for platform eligibility,
        // staged rollout and downgrade policy, after the public manifest pins
        // the exact release and bundled Core/bank commits.
        const available = appResult.isUpdateAvailable === true;
        if (!available) {
          this.clearPendingDownload();
          this.discardDownloadCache();
        }
        this.patchTarget('app', {
          phase: available ? 'available' : 'complete',
          latestVersion: latest,
          message: available ? 'Ein verifiziertes Desktop-Update ist verfügbar.' : 'Desktop-App ist aktuell.',
        });
        results.push({
          target: 'app',
          currentVersion: this.appVersion,
          latestVersion: latest,
          updateAvailable: available,
        });
      } catch (error) {
        this.logger.error('Desktop platform update check failed', error);
        appFailure = classifyUpdateError(error, 'checking');
        if (!appFailure.retryable) this.clearPendingDownload();
        this.patchTarget('app', {
          phase: 'error',
          latestVersion: approvedRelease.version,
          message: appFailure.message,
          error: {
            code: appFailure.code,
            message: appFailure.message,
            retryable: appFailure.retryable,
          },
        });
      }

      results.push(
        this.finishApprovedComponentCheck('core', this.runtimeVersions.coreCommit, approvedRelease.coreCommit),
        this.finishApprovedComponentCheck('bank', this.runtimeVersions.bankCommit, approvedRelease.bankCommit),
      );
      this.recordCheckedAt();
      if (appFailure) throw publicUpdateError(appFailure);
      return results;
    } finally {
      if (this.activeOperation === 'checking') this.activeOperation = 'idle';
      this.setBusy(false);
    }
  }

  private async checkApprovedReleaseWithRetry(): Promise<ApprovedDesktopRelease | undefined> {
    for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
      const delay = this.retryDelaysMs[attempt] ?? 0;
      if (delay > 0) {
        for (const target of ['app', 'core', 'bank'] as const) {
          this.patchTarget(target, {
            phase: 'checking',
            message: `Release-Prüfung wird erneut versucht (Versuch ${attempt + 1}/${this.retryDelaysMs.length}) …`,
          });
        }
        await this.wait(delay);
      }
      try {
        const release = await this.approvedRelease();
        if (release !== undefined && !this.isValidApprovedRelease(release)) {
          throw codedReleaseError(
            'Approved Desktop release seam returned invalid data',
            'ERR_UPDATER_INVALID_RELEASE_FEED',
          );
        }
        return release;
      } catch (error) {
        const classified = classifyUpdateError(error, 'checking');
        this.logger.warn('Public Desktop release check attempt failed', { attempt: attempt + 1, error });
        if (classified.automaticRetry && attempt + 1 < this.retryDelaysMs.length) continue;
        throw error;
      }
    }
    throw Object.assign(new Error('No public release check attempt was configured'), {
      code: 'ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION',
    });
  }

  private async checkAppUpdaterWithRetry(): ReturnType<AppUpdater['checkForUpdates']> {
    for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
      const delay = this.retryDelaysMs[attempt] ?? 0;
      if (delay > 0) {
        this.patchTarget('app', {
          phase: 'checking',
          message: `Update-Prüfung wird erneut versucht (Versuch ${attempt + 1}/${this.retryDelaysMs.length}) …`,
        });
        await this.wait(delay);
      }
      try {
        return await this.updater.checkForUpdates();
      } catch (error) {
        const classified = classifyUpdateError(error, 'checking');
        this.logger.warn('Desktop update check attempt failed', { attempt: attempt + 1, error });
        if (classified.automaticRetry && attempt + 1 < this.retryDelaysMs.length) continue;
        throw error;
      }
    }
    // retryDelaysMs is normalized to a non-empty list in the constructor.
    throw Object.assign(new Error('No updater check attempt was configured'), {
      code: 'ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION',
    });
  }

  private finishApprovedComponentCheck(
    target: 'core' | 'bank',
    current: string | undefined,
    approved: string,
  ): QedUpdateCheckResult {
    const currentVersion = shortCommit(current);
    if (!current) {
      const label = target === 'core' ? 'Core' : 'Aufgabenbank';
      const code = target === 'core' ? 'CORE_VERSION_METADATA_MISSING' : 'BANK_VERSION_METADATA_MISSING';
      const message = `${label}-Versionsdaten fehlen in dieser Installation.`;
      this.patchTarget(target, {
        phase: 'error',
        latestVersion: shortCommit(approved),
        message,
        error: { code, message, retryable: false },
      });
      return {
        target,
        currentVersion,
        latestVersion: shortCommit(approved),
        updateAvailable: false,
      };
    }

    const includedInAvailableRelease = current !== approved;
    const message = includedInAvailableRelease
      ? 'Dieser Stand ist im verfügbaren Desktop-Release enthalten und wird nicht separat installiert.'
      : 'Dieser Stand ist im installierten Desktop-Release enthalten.';
    this.patchTarget(target, {
      phase: 'complete',
      latestVersion: shortCommit(approved),
      message,
    });
    return {
      target,
      currentVersion,
      latestVersion: shortCommit(approved),
      updateAvailable: false,
      detail: message,
    };
  }

  private finishUnpublishedCheck(target: 'app' | 'core' | 'bank'): QedUpdateCheckResult {
    const currentVersion = this.target(target).currentVersion;
    const detail = 'Noch keine öffentliche Desktop-Veröffentlichung vorhanden.';
    this.patchTarget(target, { phase: 'complete', message: detail }, { clearLatestVersion: true });
    // The shared renderer treats a missing latestVersion as a partial failure.
    // Echoing the installed version keeps this explicitly neutral while the
    // target message explains that no public channel exists yet.
    return { target, currentVersion, latestVersion: currentVersion, updateAvailable: false, detail };
  }

  private finishReleaseChannelFailure(
    target: 'core' | 'bank',
    _appFailure: ClassifiedUpdateError,
  ): void {
    const message = 'In Desktop-Releases enthalten; kein eigener Update-Kanal.';
    this.patchTarget(target, {
      phase: 'complete',
      message,
    }, { clearLatestVersion: true });
  }

  private unavailableResults(): QedUpdateCheckResult[] {
    const detail = selfUpdateUnavailableMessage(this.selfUpdateAvailability.reason);
    this.state = {
      ...this.state,
      targets: this.state.targets.map((target) => {
        const next = { ...target, phase: 'complete' as const, message: detail };
        delete next.error;
        delete next.progress;
        delete next.installMode;
        delete next.latestVersion;
        return next;
      }),
      busy: false,
    };
    this.emitState();
    return this.state.targets.map((target) => ({
      target: target.target,
      currentVersion: target.currentVersion,
      updateAvailable: false,
      detail,
    }));
  }

  private isValidApprovedRelease(release: ApprovedDesktopRelease): boolean {
    if (
      !releaseFeedPatterns.stableVersion.test(release.version) ||
      release.tag !== `v${release.version}` ||
      !releaseFeedPatterns.gitCommit.test(release.clientCommit) ||
      !releaseFeedPatterns.gitCommit.test(release.coreCommit) ||
      !releaseFeedPatterns.gitCommit.test(release.bankCommit) ||
      !isRecord(release.assets) ||
      Object.keys(release.assets).length === 0 ||
      !isRecord(release.updateMetadata)
    ) return false;
    const manualTargets = expectedManualReleaseTargets(release.version);
    for (const [name, asset] of Object.entries(release.assets)) {
      const expectedTarget = manualTargets.get(name);
      if (
        !isRecord(asset) ||
        asset.name !== name ||
        !releaseFeedPatterns.assetName.test(name) ||
        !Number.isSafeInteger(asset.size) ||
        (asset.size as number) <= 0 ||
        typeof asset.sha256 !== 'string' ||
        !releaseFeedPatterns.sha256.test(asset.sha256) ||
        typeof asset.sha512 !== 'string' ||
        !isCanonicalSha512(asset.sha512) ||
        asset.downloadUrl !== buildReleaseAssetUrl(release.tag, name) ||
        (expectedTarget === undefined && releaseFeedPatterns.manualPackageName.test(name)) ||
        (expectedTarget
          ? !isRecord(asset.target) ||
            asset.target.platform !== expectedTarget.platform ||
            asset.target.arch !== expectedTarget.arch ||
            asset.target.installMode !== 'manual-package' ||
            !hasExactOwnKeys(asset.target, ['platform', 'arch', 'installMode'])
          : asset.target !== undefined)
      ) return false;
    }
    if ([...manualTargets.keys()].some((name) => !Object.hasOwn(release.assets, name))) return false;
    const expectedMetadata = {
      'latest.yml': [`QED2-${release.version}-win-x64.exe`],
      'latest-mac.yml': [
        `QED2-${release.version}-mac-arm64.zip`,
        `QED2-${release.version}-mac-x64.zip`,
      ],
      'latest-linux.yml': [
        `QED2-${release.version}-linux-x64.AppImage`,
        `QED2-${release.version}-linux-x64.deb`,
        `QED2-${release.version}-linux-x64.rpm`,
      ],
    } as const;
    return (Object.keys(expectedMetadata) as Array<keyof typeof expectedMetadata>).every((name) => {
      const actual = release.updateMetadata[name];
      const expected = expectedMetadata[name];
      return Array.isArray(actual) &&
        actual.length === expected.length &&
        actual.every((assetName, index) => assetName === expected[index] && Object.hasOwn(release.assets, assetName));
    });
  }

  private recordCheckedAt(): void {
    this.state = { ...this.state, checkedAt: new Date(this.now()).toISOString() };
    this.emitState();
  }

  private bindUpdaterEvents(): void {
    this.updater.on('checking-for-update', () => {
      if (this.activeOperation !== 'checking') return;
      this.patchTarget('app', { phase: 'checking', message: 'Nach Desktop-Updates wird gesucht …' });
    });
    this.updater.on('update-available', (info: UpdateInfo) => {
      if (this.activeOperation !== 'checking') return;
      this.patchTarget('app', {
        phase: 'available',
        latestVersion: info.version,
        message: 'Ein verifiziertes Desktop-Update ist verfügbar.',
      });
    });
    this.updater.on('update-not-available', (info: UpdateInfo) => {
      if (this.activeOperation !== 'checking') return;
      this.patchTarget('app', {
        phase: 'complete',
        latestVersion: info.version,
        message: 'Desktop-App ist aktuell.',
      });
    });
    this.updater.on('download-progress', (progress: ProgressInfo) => {
      if (
        this.activeOperation !== 'downloading' ||
        !this.acceptingDownloadEvents ||
        this.target('app').phase !== 'downloading'
      ) {
        this.logger.warn('Ignored stale desktop update progress event');
        return;
      }
      const reportedCompleted = Number.isFinite(progress.transferred)
        ? Math.max(0, progress.transferred)
        : 0;
      const completed = Math.max(this.downloadProgressCompleted, reportedCompleted);
      const reportedTotal = Number.isFinite(progress.total) && progress.total > 0
        ? progress.total
        : undefined;
      const totalCandidates = [this.downloadProgressTotal, reportedTotal]
        .filter((value): value is number => value !== undefined);
      const total = totalCandidates.length === 0
        ? undefined
        : Math.max(completed, ...totalCandidates);
      this.downloadProgressCompleted = completed;
      this.downloadProgressTotal = total;
      const currentAttemptPercent = total !== undefined
        ? clampPercent((completed / total) * 100)
        : Number.isFinite(progress.percent)
          ? clampPercent(progress.percent)
          : 0;
      this.downloadTransactionHighWaterPercent = Math.max(
        this.downloadTransactionHighWaterPercent,
        currentAttemptPercent,
      );
      const transactionPercent = Math.round(this.downloadTransactionHighWaterPercent);
      const message = this.downloadAttemptNumber > 1
        ? `Downloadversuch ${this.downloadAttemptNumber}/${this.retryDelaysMs.length}: aktuell ${Math.round(currentAttemptPercent)} %. Transaktions-Höchststand ${transactionPercent} %; frühere Teildaten werden nicht angerechnet.`
        : `Desktop-Update wird heruntergeladen (${transactionPercent} %) …`;
      this.patchTarget('app', {
        phase: 'downloading',
        progress: {
          completed: this.downloadTransactionHighWaterPercent,
          total: 100,
          unit: 'percent',
        },
        message,
      });
    });
    this.updater.on('update-downloaded', (info: UpdateInfo) => {
      if (this.activeOperation !== 'downloading' || !this.acceptingDownloadEvents) {
        this.logger.warn('Ignored stale desktop update completion event');
        return;
      }
      if (this.receivedDownloadedEvent) {
        this.logger.warn('Ignored duplicate desktop update completion event');
        return;
      }
      const expectedVersion = this.target('app').latestVersion;
      if (!info.version || (expectedVersion !== undefined && info.version !== expectedVersion)) {
        this.logger.error('Updater reported a downloaded version that does not match the checked release', {
          expectedVersion,
          reportedVersion: info.version,
        });
        this.receivedDownloadedEvent = false;
        this.clearPendingDownload();
        this.patchTarget('app', {
          phase: 'error',
          message: 'Die heruntergeladene Version stimmt nicht mit der geprüften Veröffentlichung überein.',
          error: {
            code: 'APP_UPDATE_VERSION_MISMATCH',
            message: 'Die heruntergeladene Version stimmt nicht mit der geprüften Veröffentlichung überein.',
            retryable: false,
          },
        });
        return;
      }
      const pending = this.readPendingDownload();
      this.writePendingDownload({
        fromVersion: this.appVersion,
        latestVersion: info.version,
        requestedAt: pending?.requestedAt ?? new Date(this.now()).toISOString(),
        attempts: pending?.attempts ?? 0,
        status: 'verified-ready',
      });
      this.receivedDownloadedEvent = true;
      this.downloadedEventVersion = info.version;
      this.patchTarget('app', {
        phase: 'verifying',
        latestVersion: info.version,
        message: 'Das verifizierte Update wird für die Installation vorbereitet …',
      });
    });
    this.updater.on('error', (error: Error) => {
      this.logger.error('Electron updater error', error);
      // During awaited check/download calls the Promise rejection is the
      // canonical terminal signal. Avoid racing it with a duplicate, generic
      // event transition; the catch block classifies that same error once.
      if (this.activeOperation === 'checking' || this.activeOperation === 'downloading') return;
      if (this.activeOperation === 'idle') {
        this.logger.warn('Ignored stale desktop updater error event');
        return;
      }
      const classified = classifyUpdateError(error, 'installing');
      this.installFailure = classified;
      this.clearInstallWatchdog();
      if (!classified.automaticRetry) this.clearPendingDownload();
      this.patchTarget('app', {
        phase: 'error',
        message: classified.message,
        error: {
          code: classified.code,
          message: classified.message,
          retryable: classified.retryable,
        },
      });
      this.activeOperation = 'idle';
      this.setBusy(false);
    });
  }

  private target(target: UpdateTargetState['target']): UpdateTargetState {
    const found = this.state.targets.find((item) => item.target === target);
    if (!found) throw new Error(`Missing update target state: ${target}`);
    return found;
  }

  private confirmInstallHandoff(): void {
    if (this.activeOperation !== 'installing') return;
    this.installHandoffConfirmed = true;
    this.clearInstallWatchdog();
    this.logger.info('Native updater confirmed the install handoff');
  }

  private handleInstallHandoffTimeout(): void {
    this.installWatchdog = undefined;
    if (this.activeOperation !== 'installing' || this.installHandoffConfirmed) return;
    this.logger.error('Native updater did not confirm the install handoff before the watchdog expired');
    this.activeOperation = 'idle';
    // The installer may have started without emitting a lifecycle signal. Do
    // not automatically invoke it again; require a fresh explicit check.
    this.clearPendingDownload();
    const message = 'Der Neustart für die Installation wurde nicht bestätigt. Bitte prüfe das Update erneut.';
    this.patchTarget('app', {
      phase: 'error',
      message,
      error: {
        code: 'APP_UPDATE_INSTALL_HANDOFF_TIMEOUT',
        message,
        retryable: true,
      },
    });
    this.setBusy(false);
  }

  private clearInstallWatchdog(): void {
    if (this.installWatchdog) clearTimeout(this.installWatchdog);
    this.installWatchdog = undefined;
  }

  private patchTarget(
    target: UpdateTargetState['target'],
    patch: Partial<UpdateTargetState>,
    options: { clearProgress?: boolean; clearLatestVersion?: boolean } = {},
  ): void {
    this.state = {
      ...this.state,
      targets: this.state.targets.map((item) => {
        if (item.target !== target) return item;
        const next = { ...item, ...patch, target } as UpdateTargetState;
        if (patch.phase && patch.phase !== 'error') delete next.error;
        if (patch.phase && patch.phase !== 'downloading') delete next.progress;
        if (patch.phase && patch.phase !== 'restart-required') delete next.installMode;
        if (options.clearProgress) delete next.progress;
        if (options.clearLatestVersion) delete next.latestVersion;
        return next;
      }),
    };
    this.emitState();
  }

  private setBusy(busy: boolean): void {
    if (this.state.busy === busy) return;
    this.state = { ...this.state, busy };
    this.emitState();
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  private readPendingDownload(): PendingAppDownload | undefined {
    return this.recoveryJournal.read();
  }

  private writePendingDownload(pending: PendingAppDownload): void {
    this.recoveryJournal.write(pending);
  }

  private clearPendingDownload(): void {
    this.recoveryJournal.clear();
  }

  private discardDownloadCache(): void {
    void this.downloader?.discard().catch((error) => {
      this.logger.warn('Could not clear the desktop update download cache', error);
    });
  }
}
