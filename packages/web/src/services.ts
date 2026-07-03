/**
 * Singleton wiring of platform adapters + core-logic stores.
 * Pinia stores bind reactive state on top of these; business logic stays in
 * @qed2/core-logic (iron rule).
 */
import {
  ArchiveStore,
  AuthStore,
  ConfigStore,
  QuestionCache,
  type PlatformPorts,
} from '@qed2/core-logic';
import { WebStorage } from './platform/web-storage.js';
import { WebCoreRuntime, WebNetwork, WebUpdate } from './platform/web-ports.js';

export const APP_VERSION = '0.1.0';

export const storage = new WebStorage();
export const configStore = new ConfigStore(storage);
export const authStore = new AuthStore(storage);
export const archiveStore = new ArchiveStore(storage);
export const questionCache = new QuestionCache(storage);

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
  coreRuntime: new WebCoreRuntime(() => currentCoreUrl),
  update: new WebUpdate(APP_VERSION),
  network: new WebNetwork(),
};

export function setCurrentCoreUrl(url: string): void {
  currentCoreUrl = url;
}
