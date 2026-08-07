export type UpdateErrorContext = 'checking' | 'downloading' | 'installing';

export interface ClassifiedUpdateError {
  code: string;
  message: string;
  retryable: boolean;
  automaticRetry: boolean;
}

interface ErrorLike {
  code?: unknown;
  statusCode?: unknown;
  retryAfter?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
}

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
  'ENOTFOUND',
  'ETIMEDOUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK',
  'ERR_NETWORK_CHANGED',
  'ERR_TIMED_OUT',
  'ERR_DOWNLOAD_TRUNCATED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const STORAGE_ERROR_CODES = new Set(['EACCES', 'EDQUOT', 'ENOSPC', 'EPERM', 'EROFS']);

const INTEGRITY_ERROR_CODES = new Set([
  'ERR_DOWNLOAD_INTEGRITY',
  'ERR_DOWNLOAD_OVERSIZED',
  'ERR_CHECKSUM_MISMATCH',
  'ERR_UPDATER_VERSION_MISMATCH',
  'ERR_UPDATER_INVALID_SIGNATURE',
  'ERR_UPDATER_NO_CHECKSUM',
]);

const RELEASE_ERROR_CODES = new Set([
  'ERR_DOWNLOAD_PROTOCOL',
  'ERR_UPDATER_REDIRECT_REJECTED',
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

function errorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  const seen = new Set<object>();
  let candidate = error;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === 'object'; depth += 1) {
    if (seen.has(candidate)) break;
    seen.add(candidate);
    const current = candidate as ErrorLike;
    chain.push(current);
    try {
      candidate = current.cause;
    } catch {
      break;
    }
  }
  return chain;
}

export function errorCode(error: unknown): string | undefined {
  for (const candidate of errorChain(error)) {
    const code = candidate.code;
    if (typeof code === 'string' && code.length > 0) return code.toUpperCase();
  }
  return undefined;
}

export function retryAtFromError(error: unknown, now: number): number | undefined {
  if (errorCode(error) !== 'ERR_UPDATER_RATE_LIMITED') return undefined;
  for (const candidate of errorChain(error)) {
    if (typeof candidate.retryAfter !== 'string') continue;
    const value = candidate.retryAfter.trim();
    const parsed = /^\d{1,10}$/.test(value)
      ? now + Number(value) * 1_000
      : Date.parse(value);
    if (Number.isFinite(parsed)) {
      return Math.min(Math.max(parsed, now), now + 24 * 60 * 60 * 1_000);
    }
  }
  // GitHub may omit Retry-After on some secondary limits. Avoid turning the
  // recovery timer into repeated pressure on that endpoint.
  return now + 15 * 60 * 1_000;
}

function httpStatus(error: unknown): number | undefined {
  const chain = errorChain(error);
  for (const candidate of chain) {
    if (typeof candidate.statusCode === 'number' && Number.isInteger(candidate.statusCode)) {
      return candidate.statusCode;
    }
  }
  const code = errorCode(error);
  const matched = code?.match(/^HTTP_ERROR_(\d{3})$/);
  if (matched?.[1]) return Number(matched[1]);
  for (const candidate of chain) {
    if (typeof candidate.message !== 'string') continue;
    // electron-updater 6.8.x uses a plain Error for artifact downloads.
    const statusMatch = candidate.message.match(/\bstatus(?:\s+code)?\s+(\d{3})\b/i);
    if (statusMatch?.[1]) return Number(statusMatch[1]);
  }
  return undefined;
}

function hasTransientNetworkMessage(error: unknown): boolean {
  return errorChain(error).some((candidate) => {
    const message = candidate.message;
    if (typeof message !== 'string') return false;
    return (
      /\bfetch failed\b/i.test(message) ||
      /\brequest timed out\b/i.test(message) ||
      /\boperation was aborted due to timeout\b/i.test(message) ||
      /\bsocket hang up\b/i.test(message) ||
      /\brequest (?:was |has been )?aborted\b/i.test(message) ||
      /\b(?:EAI_AGAIN|ECONNRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT)\b/i.test(message) ||
      /\bnet::ERR_(?:CONNECTION_RESET|INTERNET_DISCONNECTED|NETWORK_CHANGED|TIMED_OUT)\b/i.test(message)
    );
  });
}

function isCancellation(error: unknown): boolean {
  return errorCode(error) === 'ERR_CANCELLED' || errorChain(error).some((candidate) => (
    candidate.name === 'CancellationError' || candidate.name === 'AbortError'
  ));
}

function isTimeout(error: unknown): boolean {
  return errorChain(error).some((candidate) => candidate.name === 'TimeoutError');
}

/** Converts private implementation errors into stable, path-free UI state. */
export function classifyUpdateError(
  error: unknown,
  context: UpdateErrorContext,
): ClassifiedUpdateError {
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
  if (code === 'ERR_UPDATER_MANUAL_PACKAGE_PATH_MISSING') {
    return {
      code: 'APP_UPDATE_MANUAL_PACKAGE_UNAVAILABLE',
      message: 'Das verifizierte Installationspaket konnte nicht sicher an die manuelle Installation übergeben werden.',
      retryable: true,
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
  if (code === 'ERR_UPDATER_RATE_LIMITED') {
    return {
      code: context === 'checking' ? 'APP_UPDATE_CHECK_NETWORK_FAILED' : 'APP_UPDATE_NETWORK_FAILED',
      message: context === 'checking'
        ? 'GitHub hat die Update-Prüfung vorübergehend begrenzt. Bitte versuche es später erneut.'
        : 'GitHub hat den Update-Download vorübergehend begrenzt. Bitte versuche es später erneut.',
      retryable: true,
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
    isTimeout(error) ||
    hasTransientNetworkMessage(error) ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  ) {
    return {
      code: context === 'checking' ? 'APP_UPDATE_CHECK_NETWORK_FAILED' : 'APP_UPDATE_NETWORK_FAILED',
      message: context === 'checking'
        ? 'Die Verbindung zur Update-Prüfung wurde unterbrochen. Die Prüfung kann erneut gestartet werden.'
        : status === 429
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
    // Unknown failures may be deterministic. Require an explicit retry.
    automaticRetry: false,
  };
}

export function publicUpdateError(
  classification: ClassifiedUpdateError,
): Error & { code: string } {
  return Object.assign(new Error(classification.message), {
    name: 'UpdateError',
    code: classification.code,
  });
}
