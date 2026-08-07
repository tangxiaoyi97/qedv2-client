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

/** Trim trailing slashes so URL joining is uniform. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function mergeConfig(overrides: Partial<ClientConfig> | undefined): ClientConfig {
  const merged = { ...DEFAULT_CONFIG, ...(overrides ?? {}) };
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
