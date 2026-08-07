import type { ClientConfig } from '../config/index.js';

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
  /**
   * Read several addresses together with opaque, monotonically changing
   * revisions.  Adapters that implement this method MUST return entries in the
   * same order as `addresses` and MUST retain revisions across deletion (an
   * absent value can therefore have a non-zero revision).  The retained
   * tombstone prevents an absent -> present -> absent ABA cycle from satisfying
   * a stale compare-and-swap.
   */
  readBatch?(addresses: readonly StorageAddress[]): Promise<StorageVersionedEntry[]>;
  /**
   * Atomically compare revisions and apply a bounded declarative mutation set.
   * Every mutated address must also occur exactly once in `ifRevisions`.
   * `committed: false` is a normal CAS conflict and means that no mutation was
   * applied.  A rejection means the outcome may be unknown to the caller, so
   * durable workflows must reload their idempotency marker before retrying.
   */
  commitBatch?(request: StorageBatchCommit): Promise<StorageBatchCommitResult>;
  /**
   * Desktop shells with multiple renderer windows may provide an origin-wide
   * exclusive mutation. Callers keep the callback limited to local
   * read/modify/write work; network requests must happen outside this lock.
   * Web/PWA adapters intentionally omit this coarse mutex; their durable
   * multi-document workflows coordinate across tabs through revisioned CAS.
   */
  runExclusiveMutation?<T>(mutation: () => Promise<T>): Promise<T>;
  /**
   * Changes committed by another renderer using the same durable store.
   * The writing renderer is not notified, which prevents refresh/write
   * feedback loops while its in-memory state is already authoritative.
   */
  onChange?(cb: (change: StorageChange) => void): () => void;
}

export interface StorageAddress {
  collection: string;
  key: string;
}

export interface StorageVersionedEntry extends StorageAddress {
  /** Monotonic per-address adapter revision. Zero denotes an untouched key. */
  revision: number;
  exists: boolean;
  /** Present exactly when `exists` is true. Storage values may not be undefined. */
  value?: unknown;
}

export interface StorageRevisionPrecondition extends StorageAddress {
  revision: number;
}

export type StorageBatchMutation =
  | (StorageAddress & { operation: 'set'; value: unknown })
  | (StorageAddress & { operation: 'delete' });

export interface StorageBatchCommit {
  ifRevisions: StorageRevisionPrecondition[];
  mutations: StorageBatchMutation[];
}

export interface StorageBatchCommitResult {
  committed: boolean;
}

export interface AtomicStoragePort extends StoragePort {
  readBatch(addresses: readonly StorageAddress[]): Promise<StorageVersionedEntry[]>;
  commitBatch(request: StorageBatchCommit): Promise<StorageBatchCommitResult>;
}

export function hasAtomicStorage(storage: StoragePort): storage is AtomicStoragePort {
  return typeof storage.readBatch === 'function' && typeof storage.commitBatch === 'function';
}

export type StorageChangeOperation = 'set' | 'delete' | 'clear';

export interface StorageChange {
  collection: string;
  operation: StorageChangeOperation;
  /** Absent for a collection-wide clear. */
  key?: string;
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
  /** Local practice-history log (this device only — see store/history-log.ts). */
  history: 'history',
  /** Misc app state (last session, etc.). */
  app: 'app',
  /** AI answers already paid for — see store/ai-cache.ts. */
  aiCache: 'ai-cache',
} as const;

/* ------------------------------------------------------------------ *
 * CoreRuntimePort — where does the core service live?
 * Web: always the configured remote URL (web/PWA never spawns a local core —
 * contract §8.2). Desktop may spawn a local core process and
 * return a localhost endpoint, switching between remote and local.
 * ------------------------------------------------------------------ */
export type CoreSourcePreference = 'remote' | 'local';

export interface CoreEndpoint {
  baseUrl: string;
  source: CoreSourcePreference;
  /**
   * Immutable question-bank identity when the shell can prove it without a
   * network probe (the bundled Desktop runtime does). Callers use it to keep
   * offline caches and resumed practice sessions revision-scoped.
   */
  contentId?: string;
}

export type CoreRuntimePhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'recovering'
  | 'degraded'
  | 'failed'
  | 'stopped';

export interface OperationProgress {
  /** Completed work. For byte progress this is transferred bytes. */
  completed: number;
  /** Omitted when the source cannot provide a reliable total. */
  total?: number;
  unit: 'bytes' | 'steps' | 'percent';
}

/** Serializable state emitted by a desktop-managed local core. */
export interface CoreRuntimeStatus {
  phase: CoreRuntimePhase;
  /** Source currently selected for new content requests. */
  source: CoreSourcePreference;
  /** User-selected source, even while Desktop is temporarily degraded. */
  preferredSource: CoreSourcePreference;
  endpoint: string;
  /** Verified bank commit when known. */
  contentId?: string;
  operation?:
    | 'prepare-runtime'
    | 'start-core'
    | 'health-check'
    | 'restart-core'
    | 'repair-runtime';
  progress?: OperationProgress;
  message?: string;
  restartAttempt?: number;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

export type CoreRecoveryAction = 'retry' | 'use-remote' | 'repair';

export interface CoreRuntimePort {
  /**
   * Resolve the selected endpoint, or a source-pinned endpoint for a practice
   * session. A source-pinned endpoint must never silently cross over to the
   * other bank.
   */
  getEndpoint(source?: CoreSourcePreference): Promise<CoreEndpoint>;
  /** Whether this platform can run a local core at all (desktop only). */
  readonly capabilities: {
    localCore: boolean;
  };
  /** Desktop: pass the complete, current configuration to the main process. */
  configure?(config: ClientConfig): Promise<CoreEndpoint>;
  /** Desktop: current lifecycle state. */
  getStatus?(): Promise<CoreRuntimeStatus>;
  /** Desktop: lifecycle updates; returns an unsubscribe function. */
  onStatusChange?(cb: (status: CoreRuntimeStatus) => void): () => void;
  /** Desktop: bounded, explicit recovery actions. */
  recover?(action: CoreRecoveryAction): Promise<CoreEndpoint>;
  /** Desktop: persist and select the source used by new content requests. */
  selectSource?(source: CoreSourcePreference): Promise<CoreEndpoint>;
}

/* ------------------------------------------------------------------ *
 * UpdatePort — version display + desktop update checks for the
 * core source and the question bank (contract §6, brief §6).
 * ------------------------------------------------------------------ */
export interface UpdateCheckResult {
  target: 'core' | 'bank' | 'app';
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  detail?: string;
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restart-required'
  | 'complete'
  | 'error';

export interface UpdateTargetState {
  target: 'core' | 'bank' | 'app';
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  /** How a verified app package is handed off on this platform. */
  installMode?: 'self' | 'manual-package';
  progress?: OperationProgress;
  message?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface UpdateSnapshot {
  targets: UpdateTargetState[];
  checkedAt?: string;
  busy: boolean;
}

export interface UpdatePort {
  /** Version of the running client shell (web: package version). */
  getAppVersion(): string;
  readonly capabilities: {
    /** Can check & apply core/bank updates (desktop). Web: false. */
    selfUpdate: boolean;
    /** This build downloads a verified app package but hands installation to the OS/user. */
    manualAppInstall?: boolean;
  };
  /** Present when capabilities.selfUpdate — desktop implements. */
  checkForUpdates?(): Promise<UpdateCheckResult[]>;
  /** Desktop: complete state for app/core/bank update UI. */
  getState?(): Promise<UpdateSnapshot>;
  /** Desktop: state/progress subscription; returns an unsubscribe function. */
  onChange?(cb: (snapshot: UpdateSnapshot) => void): () => void;
  /** Desktop: stage and verify the selected targets. */
  applyUpdates?(targets: Array<'core' | 'bank' | 'app'>): Promise<void>;
  /** Desktop: hand off a verified app update; self-installers relaunch QED2. */
  relaunchToApply?(): Promise<void>;
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

/* ------------------------------------------------------------------ *
 * ShellPort — bounded native-shell commands. The renderer never receives
 * raw Electron IPC, arbitrary routes, paths, or process access.
 * ------------------------------------------------------------------ */
export type ShellCommand =
  | 'navigate-home'
  | 'navigate-practice'
  | 'navigate-questions'
  | 'navigate-history'
  | 'navigate-progress'
  | 'open-settings'
  | 'open-update-center'
  | 'go-back'
  | 'go-forward';

/** Native singleton windows the Desktop renderer may explicitly reveal. */
export type DesktopWindowTarget = 'practice' | 'updates' | 'node';
/** Stable renderer scope supplied by Electron; absent in Web/PWA. */
export type DesktopRendererKind = 'main' | DesktopWindowTarget;

export interface ShellPort {
  readonly capabilities: {
    desktop: boolean;
    nativeMenu: boolean;
    nativeTitleBar: boolean;
  };
  /**
   * Identifies the stable native window role without exposing BrowserWindow
   * or IPC. Local session snapshots use it to prevent main/practice renderers
   * from overwriting one another.
   */
  readonly windowKind?: DesktopRendererKind;
  onCommand(cb: (command: ShellCommand) => void): () => void;
  /**
   * Desktop-only typed bridge. It cannot open arbitrary routes, URLs or
   * BrowserWindows; the main process maps each target to one fixed singleton.
   */
  openDesktopWindow?(target: DesktopWindowTarget): Promise<void>;
}

/** Everything a platform shell must provide to boot core-logic. */
export interface PlatformPorts {
  storage: StoragePort;
  coreRuntime: CoreRuntimePort;
  update: UpdatePort;
  network: NetworkPort;
  shell: ShellPort;
}
