import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Client runtime configuration (contract §8.2): every upstream address is
 * user-configurable (official deployment, fork, intranet, localhost).
 *
 * Two kinds of addresses remain in the persisted schema:
 *  - SERVICE endpoints (coreBaseUrl, serverBaseUrl) — used by every shell at
 *    runtime for HTTP calls;
 *  - PROVENANCE locations (coreRepoUrl, bankRepoUrl) — retained so existing
 *    profiles and runtime metadata remain readable. Stable clients never
 *    clone, execute or update from these values; Desktop accepts only the
 *    Core/bank embedded in its verified release.
 */
export interface ClientConfig {
  /** qed2-core base URL (content line, HTTP service). */
  coreBaseUrl: string;
  /** qed2-server base URL (user line, HTTP service). */
  serverBaseUrl: string;
  /** Legacy/read-only qed2-core release provenance. Never an execution source. */
  coreRepoUrl: string;
  /** Legacy/read-only question-bank release provenance. Never an execution source. */
  bankRepoUrl: string;
  /**
   * Language the AI answers in, as free text. Empty = German.
   * A preference, not a credential — it rides the request, nothing is stored
   * server-side.
   */
  aiLanguage?: string;
  /**
   * Extra instructions appended to every AI prompt, written by the user.
   * The prompt's own rules always take precedence over these.
   */
  aiCustomInstructions?: string;
  /**
   * Spend the shared pool even though this account has its own key.
   * Only meaningful for a `BOTH` entitlement; the server ignores it otherwise.
   */
  aiPreferPool?: boolean;
}

export const DEFAULT_CONFIG: ClientConfig = {
  coreBaseUrl: 'https://qedcore.barcarolle.studio',
  serverBaseUrl: 'https://qedsync.barcarolle.studio',
  coreRepoUrl: 'https://github.com/tangxiaoyi97/qedv2-core',
  bankRepoUrl: 'https://github.com/tangxiaoyi97/srdpmppr',
};

const STRING_LIMITS = {
  coreBaseUrl: 4096,
  serverBaseUrl: 4096,
  coreRepoUrl: 4096,
  bankRepoUrl: 4096,
  aiLanguage: 80,
  aiCustomInstructions: 600,
} as const;

export interface SanitizedClientConfigOverrides {
  value: Partial<ClientConfig>;
  invalidFields: string[];
}

/** Runtime boundary for the IndexedDB configuration document. */
export function sanitizeClientConfigOverrides(input: unknown): SanitizedClientConfigOverrides {
  if (input === undefined) return { value: {}, invalidFields: [] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { value: {}, invalidFields: ['(root)'] };
  }
  const source = input as Record<string, unknown>;
  const value: Partial<ClientConfig> = {};
  const invalidFields: string[] = [];
  for (const [field, limit] of Object.entries(STRING_LIMITS) as Array<
    [keyof typeof STRING_LIMITS, number]
  >) {
    const candidate = source[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string' || candidate.length > limit) {
      invalidFields.push(field);
      continue;
    }
    if (
      (field === 'coreBaseUrl'
        || field === 'serverBaseUrl'
        || field === 'coreRepoUrl'
        || field === 'bankRepoUrl')
      && candidate.length === 0
    ) {
      invalidFields.push(field);
      continue;
    }
    value[field] = candidate;
  }
  if (source.aiPreferPool !== undefined) {
    if (typeof source.aiPreferPool === 'boolean') value.aiPreferPool = source.aiPreferPool;
    else invalidFields.push('aiPreferPool');
  }
  return { value, invalidFields };
}

/** Trim trailing slashes so URL joining is uniform. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '[::1]') return true;
  const octets = lower.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

/**
 * Canonical, credential-safe service endpoint. Remote services must use
 * HTTPS; plaintext HTTP is accepted only for a true loopback development
 * server. Query/hash/userinfo are forbidden because they make both request
 * joining and local account identity ambiguous.
 */
export function canonicalServiceBaseUrl(input: string): string {
  if (input !== input.trim()) throw new TypeError('Service URL contains surrounding whitespace');
  // URL.search/hash are empty for a bare trailing `?`/`#`, but keeping those
  // delimiters would make string-joined API paths land in a query/fragment and
  // would create a second local account identity for the same origin.
  if (input.includes('?') || input.includes('#')) {
    throw new TypeError('Service URL must not contain query or fragment delimiters');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError('Service URL is invalid');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('Service URL must not contain credentials, query or fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new TypeError('Service URL must use HTTPS (HTTP is allowed only on loopback)');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}

/** Opaque local namespace for one remote account at one exact Server. */
export function accountStorageIdentity(serverBaseUrl: string, userId: string): string {
  if (!userId || userId.length > 128 || userId.includes('\0')) {
    throw new TypeError('Invalid user identity');
  }
  const issuer = canonicalServiceBaseUrl(serverBaseUrl);
  return `account-v1-${bytesToHex(sha256(utf8ToBytes(`${issuer}\0${userId}`)))}`;
}

export function mergeConfig(overrides: Partial<ClientConfig> | undefined): ClientConfig {
  const merged = { ...DEFAULT_CONFIG, ...sanitizeClientConfigOverrides(overrides).value };
  // Spread first, then normalise the URLs. Rebuilding the object from four
  // named keys silently dropped every field added later — the AI language and
  // custom-prompt settings looked like they saved and then did nothing.
  return {
    ...merged,
    coreBaseUrl: normalizeBaseUrl(merged.coreBaseUrl),
    serverBaseUrl: normalizeBaseUrl(merged.serverBaseUrl),
    coreRepoUrl: normalizeBaseUrl(merged.coreRepoUrl),
    bankRepoUrl: normalizeBaseUrl(merged.bankRepoUrl),
  };
}
