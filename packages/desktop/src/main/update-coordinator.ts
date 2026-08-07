import { EventEmitter } from 'node:events';
import type {
  UpdateCheckResult as QedUpdateCheckResult,
  UpdateSnapshot,
  UpdateTargetState,
} from '@qed2/core-logic';
import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';

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

export interface UpdateRecoveryStore {
  get<T>(collection: string, key: string): T | undefined;
  set(collection: string, key: string, value: unknown): void;
  delete(collection: string, key: string): void;
}

export interface UpdateInstallLifecycle {
  /** Electron's native `before-quit-for-update` handoff confirmation. */
  onBeforeQuitForUpdate(callback: () => void): () => void;
}

export interface UpdateCoordinatorOptions {
  updater?: AppUpdater;
  recoveryStore?: UpdateRecoveryStore;
  repositoryHead?: (repoUrl: string, branch: string) => Promise<string | undefined>;
  /** Test seam; production uses bounded exponential-ish retry delays. */
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
  now?: () => number;
  installLifecycle?: UpdateInstallLifecycle;
  installHandoffTimeoutMs?: number;
}

interface PendingAppDownload {
  fromVersion: string;
  latestVersion?: string;
  requestedAt: string;
  attempts: number;
  /**
   * `verified-ready` is only a recovery hint. After a process restart we
   * always ask electron-updater to re-open and re-verify its platform cache
   * before exposing restart-required again.
   */
  status: 'downloading' | 'verified-ready';
}

type UpdateOperation = 'idle' | 'checking' | 'downloading' | 'installing';
type UpdateErrorContext = Exclude<UpdateOperation, 'idle'>;

interface ClassifiedUpdateError {
  code: string;
  message: string;
  retryable: boolean;
  automaticRetry: boolean;
}

interface ErrorLike {
  code?: unknown;
  statusCode?: unknown;
  name?: unknown;
  message?: unknown;
}

const UPDATE_RECOVERY_COLLECTION = 'desktop-update';
const PENDING_APP_DOWNLOAD_KEY = 'pending-app-download';
const DEFAULT_RETRY_DELAYS_MS = [0, 2_000, 10_000] as const;
const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RECOVERY_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS = 24;
const MAX_PERSISTED_DOWNLOAD_ATTEMPTS = 10_000;
const DEFAULT_INSTALL_HANDOFF_TIMEOUT_MS = 30_000;

const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK',
  'ERR_NETWORK_CHANGED',
  'ERR_TIMED_OUT',
]);

const STORAGE_ERROR_CODES = new Set(['EACCES', 'EDQUOT', 'ENOSPC', 'EPERM', 'EROFS']);

const INTEGRITY_ERROR_CODES = new Set([
  'ERR_CHECKSUM_MISMATCH',
  'ERR_UPDATER_VERSION_MISMATCH',
  'ERR_UPDATER_INVALID_SIGNATURE',
  'ERR_UPDATER_NO_CHECKSUM',
]);

const RELEASE_ERROR_CODES = new Set([
  'ERR_UPDATER_ASSET_NOT_FOUND',
  'ERR_UPDATER_BLOCKMAP_FILE_NOT_FOUND',
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
  'ERR_UPDATER_INVALID_RELEASE_FEED',
  'ERR_UPDATER_INVALID_UPDATE_INFO',
  'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
  'ERR_UPDATER_NO_FILES_PROVIDED',
  'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
  'ERR_UPDATER_RELEASE_NOT_FOUND',
  'ERR_UPDATER_WEB_INSTALLER_DISABLED',
  'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
]);

const CONFIGURATION_ERROR_CODES = new Set([
  'ERR_UPDATER_INVALID_CHANNEL',
  'ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION',
  'ERR_UPDATER_INVALID_VERSION',
  'ERR_UPDATER_OLD_FILE_NOT_FOUND',
  'ERR_UPDATER_UNSUPPORTED_PROVIDER',
]);

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as ErrorLike).code;
  return typeof code === 'string' && code.length > 0 ? code.toUpperCase() : undefined;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as ErrorLike).statusCode;
  if (typeof direct === 'number' && Number.isInteger(direct)) return direct;
  const code = errorCode(error);
  const matched = code?.match(/^HTTP_ERROR_(\d{3})$/);
  if (matched?.[1]) return Number(matched[1]);
  const message = (error as ErrorLike).message;
  if (typeof message !== 'string') return undefined;
  // electron-updater 6.8.x uses a plain Error for artifact downloads:
  // `Cannot download "…", status 503: Service Unavailable`.
  const statusMatch = message.match(/\bstatus(?:\s+code)?\s+(\d{3})\b/i);
  return statusMatch?.[1] ? Number(statusMatch[1]) : undefined;
}

function hasTransientNetworkMessage(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = (error as ErrorLike).message;
  if (typeof message !== 'string') return false;
  return (
    /\brequest timed out\b/i.test(message) ||
    /\bsocket hang up\b/i.test(message) ||
    /\brequest (?:was |has been )?aborted\b/i.test(message) ||
    /\b(?:EAI_AGAIN|ECONNRESET|ENETUNREACH|ETIMEDOUT)\b/i.test(message) ||
    /\bnet::ERR_(?:CONNECTION_RESET|INTERNET_DISCONNECTED|NETWORK_CHANGED|TIMED_OUT)\b/i.test(message)
  );
}

function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as ErrorLike;
  return (
    errorCode(error) === 'ERR_CANCELLED' ||
    candidate.name === 'CancellationError' ||
    candidate.name === 'AbortError'
  );
}

/**
 * Converts implementation details into stable, path-free user-facing state.
 * Raw updater errors are logged separately and never copied into UpdatePort.
 */
function classifyUpdateError(error: unknown, context: UpdateErrorContext): ClassifiedUpdateError {
  const code = errorCode(error);
  const status = httpStatus(error);

  if (code && INTEGRITY_ERROR_CODES.has(code)) {
    return {
      code: 'APP_UPDATE_INTEGRITY_FAILED',
      message: 'Das Update konnte nicht sicher verifiziert werden und wurde nicht angewendet.',
      retryable: false,
      automaticRetry: false,
    };
  }
  if (code === 'ERR_UPDATER_VERIFICATION_EVENT_MISSING') {
    return {
      code: 'APP_UPDATE_VERIFICATION_INCOMPLETE',
      message: 'Der Updater hat die sichere Prüfung nicht vollständig bestätigt. Das Update wurde nicht angewendet.',
      retryable: false,
      automaticRetry: false,
    };
  }
  if (code && STORAGE_ERROR_CODES.has(code)) {
    return {
      code: 'APP_UPDATE_STORAGE_UNAVAILABLE',
      message: 'Für das Update ist nicht genügend beschreibbarer Speicher verfügbar.',
      retryable: true,
      automaticRetry: false,
    };
  }
  if (code && CONFIGURATION_ERROR_CODES.has(code)) {
    return {
      code: code === 'ERR_UPDATER_OLD_FILE_NOT_FOUND'
        ? 'APP_UPDATE_UNSUPPORTED_INSTALL'
        : 'APP_UPDATE_CONFIGURATION_INVALID',
      message: code === 'ERR_UPDATER_OLD_FILE_NOT_FOUND'
        ? 'Diese Installationsart unterstützt keine automatische Aktualisierung.'
        : 'Die Aktualisierung ist für diese Installation nicht korrekt konfiguriert.',
      retryable: false,
      automaticRetry: false,
    };
  }
  if (code && RELEASE_ERROR_CODES.has(code)) {
    return {
      code: 'APP_UPDATE_RELEASE_INVALID',
      message: 'Die GitHub-Veröffentlichung ist unvollständig oder nicht mit dieser Installation kompatibel.',
      retryable: false,
      automaticRetry: false,
    };
  }
  if (isCancellation(error)) {
    return {
      code: 'APP_UPDATE_CANCELLED',
      message: 'Die Aktualisierung wurde abgebrochen und kann erneut gestartet werden.',
      retryable: true,
      automaticRetry: false,
    };
  }
  if (
    (code && TRANSIENT_NETWORK_CODES.has(code)) ||
    hasTransientNetworkMessage(error) ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  ) {
    return {
      code: 'APP_UPDATE_NETWORK_FAILED',
      message: status === 429
        ? 'Der Update-Dienst ist ausgelastet. Der Download wird später erneut versucht.'
        : 'Die Update-Verbindung wurde unterbrochen. Der Vorgang wird automatisch erneut versucht.',
      retryable: true,
      automaticRetry: true,
    };
  }
  if (status !== undefined && status >= 400 && status <= 499) {
    return {
      code: 'APP_UPDATE_RELEASE_UNAVAILABLE',
      message: 'Das angeforderte Update ist in der GitHub-Veröffentlichung nicht verfügbar.',
      retryable: false,
      automaticRetry: false,
    };
  }

  return {
    code: context === 'checking'
      ? 'APP_UPDATE_CHECK_FAILED'
      : context === 'installing'
        ? 'APP_UPDATE_INSTALL_FAILED'
        : 'APP_UPDATE_DOWNLOAD_FAILED',
    message: context === 'checking'
      ? 'Die Aktualisierung konnte nicht geprüft werden.'
      : context === 'installing'
        ? 'Das verifizierte Update konnte nicht gestartet werden.'
        : 'Das Update konnte nicht vollständig heruntergeladen werden.',
    retryable: true,
    // Unknown failures may be deterministic. Require an explicit retry rather
    // than looping automatically and risking repeated disk/process damage.
    automaticRetry: false,
  };
}

function publicUpdateError(classification: ClassifiedUpdateError): Error & { code: string } {
  return Object.assign(new Error(classification.message), {
    name: 'UpdateError',
    code: classification.code,
  });
}

function isSafeSemver(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
  );
}

function initialTarget(target: UpdateTargetState['target'], version: string): UpdateTargetState {
  return { target, phase: 'idle', currentVersion: version };
}

function shortCommit(commit: string | undefined): string {
  return commit ? commit.slice(0, 12) : 'unbekannt';
}

function parseGitHubRepository(repoUrl: string): { owner: string; repo: string } | undefined {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== 'github.com') return undefined;
    const [owner, rawRepo] = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (!owner || !rawRepo) return undefined;
    return { owner, repo: rawRepo.replace(/\.git$/i, '') };
  } catch {
    return undefined;
  }
}

async function githubHead(repoUrl: string, branch: string): Promise<string | undefined> {
  const parsed = parseGitHubRepository(repoUrl);
  if (!parsed) return undefined;
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(branch)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'QED2-Desktop',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    },
  );
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const body = (await response.json()) as { sha?: string };
  return body.sha;
}

export class UpdateCoordinator extends EventEmitter {
  private readonly updater: AppUpdater;
  private readonly recoveryStore: UpdateRecoveryStore | undefined;
  private readonly repositoryHead: (repoUrl: string, branch: string) => Promise<string | undefined>;
  private readonly retryDelaysMs: readonly number[];
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly now: () => number;
  private readonly installHandoffTimeoutMs: number;
  private state: UpdateSnapshot;
  private checking: Promise<QedUpdateCheckResult[]> | undefined;
  private runtimeVersions: RuntimeVersions;
  private activeOperation: UpdateOperation = 'idle';
  private receivedDownloadedEvent = false;
  private downloadedEventVersion: string | undefined;
  private downloadProgressCompleted = 0;
  private downloadProgressTotal: number | undefined;
  private acceptingDownloadEvents = false;
  private installFailure: ClassifiedUpdateError | undefined;
  private resumingPendingDownload = false;
  private installHandoffConfirmed = false;
  private installWatchdog: NodeJS.Timeout | undefined;

  constructor(
    private readonly appVersion: string,
    private readonly packaged: boolean,
    runtimeVersions: RuntimeVersions,
    private readonly logger: UpdateCoordinatorLogger,
    options: UpdateCoordinatorOptions = {},
  ) {
    super();
    this.runtimeVersions = { ...runtimeVersions };
    const { autoUpdater } = electronUpdater;
    this.updater = options.updater ?? autoUpdater;
    this.recoveryStore = options.recoveryStore;
    this.repositoryHead = options.repositoryHead ?? githubHead;
    this.retryDelaysMs = options.retryDelaysMs?.length
      ? [...options.retryDelaysMs]
      : DEFAULT_RETRY_DELAYS_MS;
    this.wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    this.now = options.now ?? Date.now;
    this.installHandoffTimeoutMs = options.installHandoffTimeoutMs ?? DEFAULT_INSTALL_HANDOFF_TIMEOUT_MS;
    options.installLifecycle?.onBeforeQuitForUpdate(() => this.confirmInstallHandoff());
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;
    this.updater.fullChangelog = true;
    // A full NSIS installer is published; silently accepting web installers
    // would weaken signature guarantees on Windows.
    this.updater.disableWebInstaller = true;
    this.state = {
      targets: [
        initialTarget('app', appVersion),
        initialTarget('core', `${runtimeVersions.coreVersion} (${shortCommit(runtimeVersions.coreCommit)})`),
        initialTarget('bank', shortCommit(runtimeVersions.bankCommit)),
      ],
      busy: false,
    };
    const pending = this.readPendingDownload();
    if (pending && pending.fromVersion !== this.appVersion) {
      this.clearPendingDownload();
    } else if (pending && !this.packaged) {
      this.clearPendingDownload();
    } else if (pending) {
      this.state.targets[0] = {
        target: 'app',
        phase: 'error',
        currentVersion: appVersion,
        ...(pending.latestVersion ? { latestVersion: pending.latestVersion } : {}),
        message: pending.status === 'verified-ready'
          ? 'Ein zuvor verifiziertes Update wird vor der Installation erneut sicher bestätigt.'
          : 'Ein unterbrochener Desktop-Download kann automatisch erneut gestartet werden.',
        error: {
          code: pending.status === 'verified-ready'
            ? 'APP_UPDATE_REVALIDATION_REQUIRED'
            : 'APP_UPDATE_INTERRUPTED',
          message: pending.status === 'verified-ready'
            ? 'Der verifizierte Cache muss nach dem Neustart erneut bestätigt werden.'
            : 'Der letzte Download wurde nicht abgeschlossen.',
          retryable: true,
        },
      };
    }
    this.bindUpdaterEvents();
  }

  setRepositories(coreRepoUrl: string, bankRepoUrl: string): void {
    this.runtimeVersions = { ...this.runtimeVersions, coreRepoUrl, bankRepoUrl };
  }

  getState(): UpdateSnapshot {
    return structuredClone(this.state);
  }

  hasPendingDownload(): boolean {
    const pending = this.readPendingDownload();
    if (!pending) return false;
    if (
      pending.status === 'downloading' &&
      pending.attempts >= MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS
    ) {
      this.clearPendingDownload();
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
  async resumePendingDownload(): Promise<boolean> {
    if (!this.packaged || !this.hasPendingDownload() || this.state.busy) return false;
    this.logger.info('Revalidating persisted desktop update intent through electron-updater');
    this.resumingPendingDownload = true;
    try {
      await this.applyUpdates(['app']);
      return this.target('app').phase === 'restart-required';
    } catch (error) {
      this.logger.warn('Interrupted desktop update could not yet be resumed', error);
      return false;
    } finally {
      this.resumingPendingDownload = false;
    }
  }

  checkForUpdates(): Promise<QedUpdateCheckResult[]> {
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
    if (!this.packaged) {
      throw Object.assign(new Error('App-Updates sind nur in installierten Builds verfügbar.'), {
        name: 'UpdateError',
        code: 'APP_UPDATE_DEVELOPMENT_BUILD',
      });
    }
    const appState = this.target('app');
    if (appState.phase === 'restart-required' || appState.phase === 'installing') return;
    if (appState.phase !== 'available') {
      await this.checkForUpdates();
    }
    if (this.target('app').phase !== 'available') return;

    const latestVersion = this.target('app').latestVersion;
    const existingPending = this.readPendingDownload();
    const sameRelease =
      existingPending !== undefined &&
      existingPending.fromVersion === this.appVersion &&
      existingPending.latestVersion === latestVersion;
    const preserveRecoveryBudget = sameRelease && this.resumingPendingDownload;
    this.writePendingDownload({
      fromVersion: this.appVersion,
      ...(latestVersion ? { latestVersion } : {}),
      requestedAt: preserveRecoveryBudget
        ? existingPending.requestedAt
        : new Date(this.now()).toISOString(),
      attempts: preserveRecoveryBudget ? existingPending.attempts : 0,
      status: 'downloading',
    });
    this.patchTarget('app', {
      phase: 'downloading',
      message: 'Desktop-Update wird heruntergeladen …',
    }, { clearProgress: true });
    this.activeOperation = 'downloading';
    this.setBusy(true);
    try {
      for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
        const delay = this.retryDelaysMs[attempt] ?? 0;
        if (delay > 0) {
          this.patchTarget('app', {
            phase: 'downloading',
            message: `Download wird nach einem Verbindungsfehler erneut gestartet (Versuch ${attempt + 1}/${this.retryDelaysMs.length}) …`,
          }, { clearProgress: true });
          await this.wait(delay);
        }
        this.receivedDownloadedEvent = false;
        this.downloadedEventVersion = undefined;
        this.downloadProgressCompleted = 0;
        this.downloadProgressTotal = undefined;
        this.acceptingDownloadEvents = true;
        try {
          await this.updater.downloadUpdate();
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
          this.patchTarget('app', {
            phase: 'restart-required',
            ...(this.downloadedEventVersion ? { latestVersion: this.downloadedEventVersion } : {}),
            message: 'Update ist verifiziert und wird beim Neustart installiert.',
          });
          return;
        } catch (error) {
          this.acceptingDownloadEvents = false;
          const pending = this.readPendingDownload();
          let recoveryBudgetExhausted = false;
          if (pending) {
            const nextAttempts = pending.attempts + 1;
            this.writePendingDownload({
              ...pending,
              attempts: nextAttempts,
              status: 'downloading',
            });
            recoveryBudgetExhausted =
              this.resumingPendingDownload &&
              nextAttempts >= MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS;
          }
          this.logger.warn('Desktop update download attempt failed', { attempt: attempt + 1, error });
          const classified = classifyUpdateError(error, 'downloading');
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

  relaunchToApply(): void {
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
    this.activeOperation = 'installing';
    this.installFailure = undefined;
    this.installHandoffConfirmed = false;
    this.clearInstallWatchdog();
    this.patchTarget('app', { phase: 'installing', message: 'Update wird installiert …' });
    this.setBusy(true);
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
    if (
      !this.installHandoffConfirmed &&
      Number.isFinite(this.installHandoffTimeoutMs) &&
      this.installHandoffTimeoutMs > 0
    ) {
      this.installWatchdog = setTimeout(() => this.handleInstallHandoffTimeout(), this.installHandoffTimeoutMs);
      this.installWatchdog.unref();
    }
  }

  private async performCheck(): Promise<QedUpdateCheckResult[]> {
    this.activeOperation = 'checking';
    this.setBusy(true);
    for (const target of ['app', 'core', 'bank'] as const) {
      this.patchTarget(target, { phase: 'checking', message: 'Nach Updates wird gesucht …' });
    }
    const results: QedUpdateCheckResult[] = [];
    const repositoryChecksPromise = Promise.allSettled([
      this.repositoryHead(this.runtimeVersions.coreRepoUrl, 'main'),
      this.repositoryHead(this.runtimeVersions.bankRepoUrl, 'pastpapers'),
    ]);
    let appFailure: ClassifiedUpdateError | undefined;
    try {
      if (this.packaged) {
        try {
          const appResult = await this.checkAppUpdaterWithRetry();
          if (appResult === null) {
            this.clearPendingDownload();
            appFailure = {
              code: 'APP_UPDATE_UNSUPPORTED_INSTALL',
              message: 'Diese Installationsart unterstützt keine automatische Aktualisierung.',
              retryable: false,
              automaticRetry: false,
            };
            this.patchTarget('app', {
              phase: 'error',
              message: appFailure.message,
              error: {
                code: appFailure.code,
                message: appFailure.message,
                retryable: false,
              },
            });
          } else {
            const latest = appResult.updateInfo.version;
            // electron-updater owns semver, channel, downgrade and staged-
            // rollout policy. Never second-guess its authoritative decision.
            const available = appResult.isUpdateAvailable === true;
            if (!available) this.clearPendingDownload();
            this.patchTarget('app', {
              phase: available ? 'available' : 'complete',
              ...(latest ? { latestVersion: latest } : {}),
              message: available ? 'Ein verifiziertes Desktop-Update ist verfügbar.' : 'Desktop-App ist aktuell.',
            });
            results.push({
              target: 'app',
              currentVersion: this.appVersion,
              ...(latest ? { latestVersion: latest } : {}),
              updateAvailable: available,
            });
          }
        } catch (error) {
          this.logger.error('Desktop update check failed', error);
          appFailure = classifyUpdateError(error, 'checking');
          if (!appFailure.automaticRetry) this.clearPendingDownload();
          this.patchTarget('app', {
            phase: 'error',
            message: appFailure.message,
            error: {
              code: appFailure.code,
              message: appFailure.message,
              retryable: appFailure.retryable,
            },
          });
        }
      } else {
        this.patchTarget('app', { phase: 'complete', message: 'Entwicklungsbuild – App-Update übersprungen.' });
        results.push({ target: 'app', currentVersion: this.appVersion, updateAvailable: false });
      }

      const repositoryChecks = await repositoryChecksPromise;
      const coreLatest = repositoryChecks[0].status === 'fulfilled' ? repositoryChecks[0].value : undefined;
      const bankLatest = repositoryChecks[1].status === 'fulfilled' ? repositoryChecks[1].value : undefined;
      results.push(
        this.finishRepositoryCheck('core', this.runtimeVersions.coreCommit, coreLatest),
        this.finishRepositoryCheck('bank', this.runtimeVersions.bankCommit, bankLatest),
      );
      this.state = { ...this.state, checkedAt: new Date().toISOString() };
      this.emitState();
      if (appFailure) throw publicUpdateError(appFailure);
      return results;
    } finally {
      if (this.activeOperation === 'checking') this.activeOperation = 'idle';
      this.setBusy(false);
    }
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

  private finishRepositoryCheck(
    target: 'core' | 'bank',
    current: string | undefined,
    latest: string | undefined,
  ): QedUpdateCheckResult {
    const currentVersion = shortCommit(current);
    if (!current || !latest) {
      const label = target === 'core' ? 'Core' : 'Aufgabenbank';
      const code = target === 'core' ? 'CORE_UPDATE_CHECK_FAILED' : 'BANK_UPDATE_CHECK_FAILED';
      const message = `${label}-Repository konnte nicht automatisch geprüft werden.`;
      this.patchTarget(target, {
        phase: 'error',
        ...(latest ? { latestVersion: shortCommit(latest) } : {}),
        message,
        error: { code, message, retryable: true },
      });
      return {
        target,
        currentVersion,
        ...(latest ? { latestVersion: shortCommit(latest) } : {}),
        updateAvailable: false,
      };
    }

    const available = current !== latest;
    this.patchTarget(target, {
      phase: available ? 'available' : 'complete',
      latestVersion: shortCommit(latest),
      message: available
        ? 'Eine neuere Version wird mit dem nächsten verifizierten Desktop-Release installiert.'
        : 'Aktuell.',
    });
    return {
      target,
      currentVersion,
      latestVersion: shortCommit(latest),
      updateAvailable: available,
    };
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
      const percent = total !== undefined
        ? Math.min(100, Math.max(0, (completed / total) * 100))
        : Number.isFinite(progress.percent)
          ? Math.min(100, Math.max(0, progress.percent))
          : 0;
      this.patchTarget('app', {
        phase: 'downloading',
        progress: {
          completed,
          ...(total !== undefined ? { total } : {}),
          unit: 'bytes',
        },
        message: `Desktop-Update wird heruntergeladen (${Math.round(percent)} %) …`,
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
    options: { clearProgress?: boolean } = {},
  ): void {
    this.state = {
      ...this.state,
      targets: this.state.targets.map((item) => {
        if (item.target !== target) return item;
        const next = { ...item, ...patch, target } as UpdateTargetState;
        if (patch.phase && patch.phase !== 'error') delete next.error;
        if (patch.phase && patch.phase !== 'downloading') delete next.progress;
        if (options.clearProgress) delete next.progress;
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
    try {
      const pending = this.recoveryStore?.get<Partial<PendingAppDownload>>(
        UPDATE_RECOVERY_COLLECTION,
        PENDING_APP_DOWNLOAD_KEY,
      );
      if (
        !pending ||
        !isSafeSemver(pending.fromVersion) ||
        !isSafeSemver(pending.latestVersion) ||
        typeof pending.requestedAt !== 'string' ||
        !Number.isFinite(Date.parse(pending.requestedAt)) ||
        Date.parse(pending.requestedAt) > this.now() + RECOVERY_CLOCK_SKEW_MS ||
        this.now() - Date.parse(pending.requestedAt) > RECOVERY_TTL_MS ||
        typeof pending.attempts !== 'number' ||
        !Number.isInteger(pending.attempts) ||
        pending.attempts < 0 ||
        pending.attempts > MAX_PERSISTED_DOWNLOAD_ATTEMPTS ||
        (pending.status !== undefined &&
          pending.status !== 'downloading' &&
          pending.status !== 'verified-ready')
      ) {
        if (pending !== undefined) {
          this.logger.warn('Discarding invalid persisted desktop update recovery state');
          this.recoveryStore?.delete(UPDATE_RECOVERY_COLLECTION, PENDING_APP_DOWNLOAD_KEY);
        }
        return undefined;
      }
      return {
        fromVersion: pending.fromVersion,
        ...(pending.latestVersion ? { latestVersion: pending.latestVersion } : {}),
        requestedAt: pending.requestedAt,
        attempts: pending.attempts,
        // Backward compatibility for recovery records created before the
        // verified-ready distinction existed: never upgrade intent to trust.
        status: pending.status ?? 'downloading',
      };
    } catch (error) {
      this.logger.warn('Could not read persisted desktop update recovery state', error);
      return undefined;
    }
  }

  private writePendingDownload(pending: PendingAppDownload): void {
    try {
      this.recoveryStore?.set(
        UPDATE_RECOVERY_COLLECTION,
        PENDING_APP_DOWNLOAD_KEY,
        pending,
      );
    } catch (error) {
      // Persistence strengthens recovery, but a full userData disk must not
      // crash the already-running platform updater operation.
      this.logger.warn('Could not persist desktop update recovery state', error);
    }
  }

  private clearPendingDownload(): void {
    try {
      this.recoveryStore?.delete(UPDATE_RECOVERY_COLLECTION, PENDING_APP_DOWNLOAD_KEY);
    } catch (error) {
      this.logger.warn('Could not clear desktop update recovery state', error);
    }
  }
}
