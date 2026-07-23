/**
 * Singleton wiring of platform adapters + core-logic stores.
 * Pinia stores bind reactive state on top of these; business logic stays in
 * @qed2/core-logic (iron rule).
 *
 * SHELL INJECTION SEAM (brief §0/§6 — "desktop = new shell + a handful of
 * adapters"): a wrapping shell (Electron preload, iOS wrapper) may define
 * `globalThis.__QED2_PLATFORM_PORTS__` with any subset of the platform ports
 * BEFORE this bundle loads. Whatever it provides replaces the web adapter;
 * everything it omits falls back to the web implementation. The web bundle
 * itself ships unchanged — a UI/logic upgrade is a rebuild of this app, a
 * platform capability change is a shell repackage. Neither rewrites the other.
 */
import {
  ArchiveStore,
  AttemptOutbox,
  AuthStore,
  ConfigStore,
  HistoryLog,
  QuestionCache,
  type PlatformPorts,
} from '@qed2/core-logic';
import { WebStorage } from './platform/web-storage.js';
import { WebCoreRuntime, WebNetwork, WebUpdate } from './platform/web-ports.js';

/** Injected from package.json at build time (vite.config define) — the
 *  fallback only covers dev/type-check contexts without the define. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/** Ports injected by a native shell, if any (see module header). */
const injected: Partial<PlatformPorts> =
  (globalThis as { __QED2_PLATFORM_PORTS__?: Partial<PlatformPorts> }).__QED2_PLATFORM_PORTS__ ?? {};

export const storage = injected.storage ?? new WebStorage();
export const configStore = new ConfigStore(storage);
export const authStore = new AuthStore(storage);
export const archiveStore = new ArchiveStore(storage);
export const questionCache = new QuestionCache(storage);
export const historyLog = new HistoryLog(storage);
export const attemptOutbox = new AttemptOutbox(storage);

/** Env-provided dev defaults (fall back to production defaults otherwise). */
export function envConfigDefaults(): Partial<Record<'coreBaseUrl' | 'serverBaseUrl', string>> {
  const out: Partial<Record<'coreBaseUrl' | 'serverBaseUrl', string>> = {};
  const core = import.meta.env.VITE_QED2_CORE_URL as string | undefined;
  const server = import.meta.env.VITE_QED2_SERVER_URL as string | undefined;
  if (core) out.coreBaseUrl = core;
  if (server) out.serverBaseUrl = server;
  return out;
}

let currentCoreUrl = '';

export const ports: PlatformPorts = {
  storage,
  coreRuntime: injected.coreRuntime ?? new WebCoreRuntime(() => currentCoreUrl),
  update: injected.update ?? new WebUpdate(APP_VERSION),
  network: injected.network ?? new WebNetwork(),
};

export function setCurrentCoreUrl(url: string): void {
  currentCoreUrl = url;
}
