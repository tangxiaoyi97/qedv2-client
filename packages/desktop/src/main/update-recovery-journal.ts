export interface UpdateRecoveryStore {
  get<T>(collection: string, key: string): T | undefined;
  set(collection: string, key: string, value: unknown): void;
  delete(collection: string, key: string): void;
}

export interface UpdateRecoveryLogger {
  warn(message: string, detail?: unknown): void;
}

export interface PendingAppDownload {
  fromVersion: string;
  latestVersion: string;
  requestedAt: string;
  attempts: number;
  /**
   * `verified-ready` is only an intent. A restarted process must re-open and
   * re-verify the updater cache before it can expose restart-required again.
   */
  status: 'downloading' | 'verified-ready';
}

export const MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS = 8;

const UPDATE_RECOVERY_COLLECTION = 'desktop-update';
const PENDING_APP_DOWNLOAD_KEY = 'pending-app-download';
const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RECOVERY_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyPendingKeys(value: Record<string, unknown>): boolean {
  const allowed = new Set(['fromVersion', 'latestVersion', 'requestedAt', 'attempts', 'status']);
  const keys = Object.keys(value);
  return (
    keys.length >= 4 &&
    keys.length <= 5 &&
    keys.every((key) => allowed.has(key)) &&
    ['fromVersion', 'latestVersion', 'requestedAt', 'attempts'].every((key) => Object.hasOwn(value, key))
  );
}

function isSafeSemver(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
  );
}

function parsePendingAppDownload(value: unknown, now: number): PendingAppDownload | undefined {
  if (!isRecord(value) || !hasOnlyPendingKeys(value)) return undefined;
  if (!isSafeSemver(value.fromVersion) || !isSafeSemver(value.latestVersion)) return undefined;
  if (typeof value.requestedAt !== 'string') return undefined;
  const requestedAt = Date.parse(value.requestedAt);
  if (
    !Number.isFinite(requestedAt) ||
    requestedAt > now + RECOVERY_CLOCK_SKEW_MS ||
    now - requestedAt > RECOVERY_TTL_MS
  ) return undefined;
  if (
    typeof value.attempts !== 'number' ||
    !Number.isInteger(value.attempts) ||
    value.attempts < 0 ||
    value.attempts > MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS
  ) return undefined;
  if (
    value.status !== undefined &&
    value.status !== 'downloading' &&
    value.status !== 'verified-ready'
  ) return undefined;
  return {
    fromVersion: value.fromVersion,
    latestVersion: value.latestVersion,
    requestedAt: value.requestedAt,
    attempts: value.attempts,
    // Legacy records omitted status. They are never promoted to trusted data.
    status: value.status ?? 'downloading',
  };
}

/**
 * Owns the small cross-process update intent stored in application storage.
 * Artifact byte recovery has a separate, fsync-backed journal in the
 * resumable downloader; this record never establishes artifact trust.
 */
export class UpdateRecoveryJournal {
  constructor(
    private readonly store: UpdateRecoveryStore | undefined,
    private readonly logger: UpdateRecoveryLogger,
    private readonly now: () => number,
  ) {}

  read(): PendingAppDownload | undefined {
    try {
      const raw = this.store?.get<unknown>(UPDATE_RECOVERY_COLLECTION, PENDING_APP_DOWNLOAD_KEY);
      if (raw === undefined) return undefined;
      const parsed = parsePendingAppDownload(raw, this.now());
      if (parsed) return parsed;
      this.logger.warn('Discarding invalid persisted desktop update recovery state');
      this.store?.delete(UPDATE_RECOVERY_COLLECTION, PENDING_APP_DOWNLOAD_KEY);
      return undefined;
    } catch (error) {
      this.logger.warn('Could not read persisted desktop update recovery state', error);
      return undefined;
    }
  }

  write(pending: PendingAppDownload): void {
    try {
      const parsed = parsePendingAppDownload(pending, this.now());
      if (!parsed) {
        this.logger.warn('Refusing to persist invalid desktop update recovery state');
        return;
      }
      this.store?.set(UPDATE_RECOVERY_COLLECTION, PENDING_APP_DOWNLOAD_KEY, parsed);
    } catch (error) {
      // Persistence strengthens recovery, but storage pressure must not crash
      // the already-running platform updater operation.
      this.logger.warn('Could not persist desktop update recovery state', error);
    }
  }

  recordFailure(pending: PendingAppDownload): {
    pending: PendingAppDownload;
    automaticLimitReached: boolean;
  } {
    const next: PendingAppDownload = {
      ...pending,
      attempts: Math.min(pending.attempts + 1, MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS),
      status: 'downloading',
    };
    this.write(next);
    return {
      pending: next,
      automaticLimitReached: next.attempts >= MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS,
    };
  }

  clear(): void {
    try {
      this.store?.delete(UPDATE_RECOVERY_COLLECTION, PENDING_APP_DOWNLOAD_KEY);
    } catch (error) {
      this.logger.warn('Could not clear desktop update recovery state', error);
    }
  }
}
