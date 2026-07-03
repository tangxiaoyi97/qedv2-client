/**
 * Client runtime configuration (contract §8.2): all three upstream addresses
 * are user-configurable (official deployment, fork, intranet, localhost).
 */
export interface ClientConfig {
  /** qed2-core base URL (content line). */
  coreBaseUrl: string;
  /** qed2-server base URL (user line). */
  serverBaseUrl: string;
  /** Question-bank repository URL (informational; desktop clones it). */
  bankRepoUrl: string;
}

export const DEFAULT_CONFIG: ClientConfig = {
  coreBaseUrl: 'https://qedcore.barcarolle.studio',
  serverBaseUrl: 'https://qedsync.barcarolle.studio',
  bankRepoUrl: 'https://github.com/tangxiaoyi97/srdpmppr',
};

/** Trim trailing slashes so URL joining is uniform. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function mergeConfig(overrides: Partial<ClientConfig> | undefined): ClientConfig {
  const merged = { ...DEFAULT_CONFIG, ...(overrides ?? {}) };
  return {
    coreBaseUrl: normalizeBaseUrl(merged.coreBaseUrl),
    serverBaseUrl: normalizeBaseUrl(merged.serverBaseUrl),
    bankRepoUrl: normalizeBaseUrl(merged.bankRepoUrl),
  };
}
