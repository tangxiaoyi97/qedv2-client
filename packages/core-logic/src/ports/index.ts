/**
 * Platform ports (webclient brief §6) — every platform-specific capability is
 * expressed as an interface here. core-logic depends ONLY on these
 * interfaces; each shell (web today, Electron/iOS later) injects adapters.
 *
 * Web adapters live in @qed2/web/src/platform. Desktop/mobile adapters are
 * future work; the interfaces below already express what they will need
 * (e.g. a locally-spawned core process as an endpoint source).
 */

/* ------------------------------------------------------------------ *
 * StoragePort — durable local key/value storage, namespaced by collection.
 * Web: IndexedDB. Desktop: file system. iOS: native storage.
 * ------------------------------------------------------------------ */
export interface StoragePort {
  get<T>(collection: string, key: string): Promise<T | undefined>;
  set<T>(collection: string, key: string, value: T): Promise<void>;
  delete(collection: string, key: string): Promise<void>;
  /** List keys in a collection (used for cache eviction / export). */
  keys(collection: string): Promise<string[]>;
  clear(collection: string): Promise<void>;
}

/** Well-known storage collections. */
export const STORAGE = {
  /** LocalArchive (one entry per profile — 'guest' or user id). */
  archive: 'archive',
  /** Auth token + user info. */
  auth: 'auth',
  /** ClientConfig overrides, theme, etc. */
  config: 'config',
  /** Cached Question JSON by id. */
  questions: 'questions',
  /** Misc app state (last session, etc.). */
  app: 'app',
} as const;

/* ------------------------------------------------------------------ *
 * CoreRuntimePort — where does the core service live?
 * Web: always the configured remote URL (web/PWA never spawns a local core —
 * contract §8.2). Desktop (future): may spawn a local core process and
 * return a localhost endpoint, switching between remote and local.
 * ------------------------------------------------------------------ */
export interface CoreEndpoint {
  baseUrl: string;
  source: 'remote' | 'local';
}

export interface CoreRuntimePort {
  /** Resolve the core endpoint to use right now. */
  getEndpoint(): Promise<CoreEndpoint>;
  /** Whether this platform can run a local core at all (desktop only). */
  readonly capabilities: {
    localCore: boolean;
  };
}

/* ------------------------------------------------------------------ *
 * UpdatePort — version display + (desktop, future) update checks for the
 * core source and the question bank (contract §6, brief §6).
 * ------------------------------------------------------------------ */
export interface UpdateCheckResult {
  target: 'core' | 'bank' | 'app';
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  detail?: string;
}

export interface UpdatePort {
  /** Version of the running client shell (web: package version). */
  getAppVersion(): string;
  readonly capabilities: {
    /** Can check & apply core/bank updates (desktop). Web: false. */
    selfUpdate: boolean;
  };
  /** Present when capabilities.selfUpdate — desktop implements. */
  checkForUpdates?(): Promise<UpdateCheckResult[]>;
}

/* ------------------------------------------------------------------ *
 * NetworkPort — online/offline awareness (drives "cloud archive
 * unavailable" hints and sync scheduling).
 * ------------------------------------------------------------------ */
export interface NetworkPort {
  isOnline(): boolean;
  /** Subscribe to connectivity changes; returns an unsubscribe fn. */
  onChange(cb: (online: boolean) => void): () => void;
}

/** Everything a platform shell must provide to boot core-logic. */
export interface PlatformPorts {
  storage: StoragePort;
  coreRuntime: CoreRuntimePort;
  update: UpdatePort;
  network: NetworkPort;
}
