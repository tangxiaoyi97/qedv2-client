/**
 * Client runtime configuration (contract §8.2): every upstream address is
 * user-configurable (official deployment, fork, intranet, localhost).
 *
 * Two kinds of addresses live here:
 *  - SERVICE endpoints (coreBaseUrl, serverBaseUrl) — used by every shell at
 *    runtime for HTTP calls;
 *  - PULL locations (coreRepoUrl, bankRepoUrl) — git remotes the desktop/iOS
 *    shells clone and update from for offline self-hosting (contract §8.2:
 *    first install clones core source + bank once, then runs offline; update
 *    checks compare core `/info` version / bank.commit against these
 *    remotes). The web shell only stores and displays them — it never pulls
 *    (web/PWA runs no local core).
 */
export interface ClientConfig {
  /** qed2-core base URL (content line, HTTP service). */
  coreBaseUrl: string;
  /** qed2-server base URL (user line, HTTP service). */
  serverBaseUrl: string;
  /** qed2-core SOURCE repository (git) — desktop clones/updates the local core from it. */
  coreRepoUrl: string;
  /** Question-bank repository (git) — desktop clones/updates the bank from it. */
  bankRepoUrl: string;
}

export const DEFAULT_CONFIG: ClientConfig = {
  coreBaseUrl: 'https://qedcore.barcarolle.studio',
  serverBaseUrl: 'https://qedsync.barcarolle.studio',
  coreRepoUrl: 'https://github.com/tangxiaoyi97/qed2-core',
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
    coreRepoUrl: normalizeBaseUrl(merged.coreRepoUrl),
    bankRepoUrl: normalizeBaseUrl(merged.bankRepoUrl),
  };
}
