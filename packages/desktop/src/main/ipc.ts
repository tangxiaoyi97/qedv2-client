import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  STORAGE,
  type ClientConfig,
  type CoreEndpoint,
  type CoreRecoveryAction,
  type CoreRuntimeStatus,
  type CoreSourcePreference,
  type DesktopWindowTarget,
  type StorageAddress,
  type StorageBatchCommit,
  type StorageChange,
} from '@qed2/core-logic';
import { IPC } from '../shared/channels.js';
import type { CoreSupervisor } from './core-supervisor.js';
import type { NetworkMonitor } from './network-monitor.js';
import type { RendererServerAddress } from './renderer-server.js';
import type { SqliteStorage } from './storage.js';
import type { UpdateCoordinator } from './update-coordinator.js';

export interface DesktopIpcOptions {
  renderer: RendererServerAddress;
  storage: SqliteStorage;
  core: CoreSupervisor;
  updates: UpdateCoordinator;
  network: NetworkMonitor;
  openDesktopWindow(target: DesktopWindowTarget): void;
  applyThemePreference(preference: unknown): void;
  applyAccentPreference?(preference: unknown): void;
}

const RECOVERY_ACTIONS = new Set<CoreRecoveryAction>(['retry', 'use-remote', 'repair']);
const CORE_SOURCES = new Set<CoreSourcePreference>(['local', 'remote']);
const CORE_SOURCE_STORAGE_KEY = 'core-source';
const UPDATE_TARGETS = new Set(['app', 'core', 'bank'] as const);
const DESKTOP_WINDOWS = new Set<DesktopWindowTarget>(['practice', 'updates', 'node']);
const MAX_STORAGE_BATCH_ADDRESSES = 32;

function validateText(value: unknown, name: string, maxLength = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

function validateStorageAddress(value: unknown): StorageAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid storage address');
  }
  const address = value as Record<string, unknown>;
  const collection = validateText(address.collection, 'collection', 64);
  const key = validateText(address.key, 'key', 512);
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(collection) || key.includes('\0')) {
    throw new TypeError('Invalid storage address');
  }
  return { collection, key };
}

function validateStorageAddresses(value: unknown): StorageAddress[] {
  if (!Array.isArray(value) || value.length > MAX_STORAGE_BATCH_ADDRESSES) {
    throw new TypeError('Invalid storage batch size');
  }
  return value.map(validateStorageAddress);
}

function validateStorageBatch(value: unknown): StorageBatchCommit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid storage batch');
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate.ifRevisions)
    || candidate.ifRevisions.length === 0
    || candidate.ifRevisions.length > MAX_STORAGE_BATCH_ADDRESSES
    || !Array.isArray(candidate.mutations)
    || candidate.mutations.length === 0
    || candidate.mutations.length > MAX_STORAGE_BATCH_ADDRESSES
  ) {
    throw new TypeError('Invalid storage batch size');
  }
  const ifRevisions = candidate.ifRevisions.map((raw) => {
    const address = validateStorageAddress(raw);
    const revision = (raw as Record<string, unknown>).revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      throw new TypeError('Invalid storage revision');
    }
    return { ...address, revision: revision as number };
  });
  const mutations = candidate.mutations.map((raw) => {
    const address = validateStorageAddress(raw);
    const record = raw as Record<string, unknown>;
    if (record.operation === 'delete') return { ...address, operation: 'delete' as const };
    if (record.operation !== 'set' || !Object.prototype.hasOwnProperty.call(record, 'value')) {
      throw new TypeError('Invalid storage batch operation');
    }
    if (record.value === undefined) throw new TypeError('Storage value must be defined');
    return { ...address, operation: 'set' as const, value: record.value };
  });
  return { ifRevisions, mutations };
}

function validateHttpUrl(value: unknown, name: string): string {
  const raw = validateText(value, name);
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`Invalid ${name} scheme`);
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/$/, '');
}

function validateConfig(value: unknown): ClientConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid client config');
  const config = value as Record<string, unknown>;
  const result: ClientConfig = {
    coreBaseUrl: validateHttpUrl(config.coreBaseUrl, 'coreBaseUrl'),
    serverBaseUrl: validateHttpUrl(config.serverBaseUrl, 'serverBaseUrl'),
    coreRepoUrl: validateHttpUrl(config.coreRepoUrl, 'coreRepoUrl'),
    bankRepoUrl: validateHttpUrl(config.bankRepoUrl, 'bankRepoUrl'),
  };
  if (config.aiLanguage !== undefined) {
    if (typeof config.aiLanguage !== 'string' || config.aiLanguage.length > 256) {
      throw new TypeError('Invalid aiLanguage');
    }
    result.aiLanguage = config.aiLanguage;
  }
  if (config.aiCustomInstructions !== undefined) {
    if (typeof config.aiCustomInstructions !== 'string' || config.aiCustomInstructions.length > 16_384) {
      throw new TypeError('Invalid aiCustomInstructions');
    }
    result.aiCustomInstructions = config.aiCustomInstructions;
  }
  if (config.aiPreferPool !== undefined) {
    if (typeof config.aiPreferPool !== 'boolean') throw new TypeError('Invalid aiPreferPool');
    result.aiPreferPool = config.aiPreferPool;
  }
  return result;
}

/** Installs the complete, sender-validated renderer contract. */
export function installDesktopIpc(options: DesktopIpcOptions): {
  dispose(): void;
} {
  const coreBaseUrl = `${options.renderer.origin}/__qed2_core`;
  const channels = [
    IPC.storageGet,
    IPC.storageSet,
    IPC.storageDelete,
    IPC.storageKeys,
    IPC.storageClear,
    IPC.storageReadBatch,
    IPC.storageCommitBatch,
    IPC.coreGetEndpoint,
    IPC.coreConfigure,
    IPC.coreGetStatus,
    IPC.coreRecover,
    IPC.coreSelectSource,
    IPC.updateCheck,
    IPC.updateGetState,
    IPC.updateApply,
    IPC.updateRelaunch,
    IPC.networkGet,
    IPC.shellOpenWindow,
  ] as const;

  const assertSender = (event: IpcMainInvokeEvent): void => {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null) throw new Error('IPC is restricted to a top-level QED2 frame');
    let origin: string;
    try {
      origin = new URL(frame.url).origin;
    } catch {
      throw new Error('IPC sender has an invalid URL');
    }
    if (origin !== options.renderer.origin) throw new Error('IPC sender is not a QED2 desktop window');
  };

  const handle = <T extends unknown[]>(
    channel: (typeof channels)[number],
    listener: (event: IpcMainInvokeEvent, ...args: T) => unknown,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args: T) => {
      assertSender(event);
      return listener(event, ...args);
    });
  };

  const exposeEndpoint = (endpoint: CoreEndpoint, pinned = false): CoreEndpoint => ({
    baseUrl: pinned ? `${coreBaseUrl}/${endpoint.source}` : coreBaseUrl,
    source: endpoint.source,
    ...(endpoint.contentId ? { contentId: endpoint.contentId } : {}),
  });
  const exposeCoreStatus = (status = options.core.getStatus()): CoreRuntimeStatus => ({
    ...status,
    endpoint: coreBaseUrl,
  });
  const safeSend = (
    window: Electron.BrowserWindow,
    channel: string,
    payload: unknown,
  ): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    try {
      window.webContents.send(channel, payload);
    } catch {
      // A renderer can disappear between the liveness check and send().
      // Status fan-out is best-effort and must never destabilize the main
      // process while a native tool window is closing.
    }
  };
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      safeSend(window, channel, payload);
    }
  };
  const broadcastStorageChange = (
    source: Electron.WebContents,
    change: StorageChange,
  ): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        !window.isDestroyed() &&
        !window.webContents.isDestroyed() &&
        window.webContents.id !== source.id
      ) {
        safeSend(window, IPC.storageChange, change);
      }
    }
  };
  handle(IPC.storageGet, (_event, collection: unknown, key: unknown) =>
    options.storage.get(validateText(collection, 'collection', 64), validateText(key, 'key', 512)),
  );
  handle(IPC.storageSet, (event, collection: unknown, key: unknown, value: unknown) => {
    const validCollection = validateText(collection, 'collection', 64);
    const validKey = validateText(key, 'key', 512);
    options.storage.set(validCollection, validKey, value);
    if (validCollection === STORAGE.config && validKey === 'theme') {
      options.applyThemePreference(value);
    }
    if (validCollection === STORAGE.config && validKey === 'accent') {
      try {
        options.applyAccentPreference?.(value);
      } catch {
        // Native icon updates are best-effort. The durable preference and
        // cross-window UI broadcast must still commit atomically.
      }
    }
    broadcastStorageChange(event.sender, {
      collection: validCollection,
      key: validKey,
      operation: 'set',
    });
  });
  handle(IPC.storageDelete, (event, collection: unknown, key: unknown) => {
    const validCollection = validateText(collection, 'collection', 64);
    const validKey = validateText(key, 'key', 512);
    options.storage.delete(validCollection, validKey);
    if (validCollection === STORAGE.config && validKey === 'theme') {
      options.applyThemePreference('system');
    }
    if (validCollection === STORAGE.config && validKey === 'accent') {
      try {
        options.applyAccentPreference?.('weed');
      } catch {
        // See storageSet: native chrome must not block durable UI state.
      }
    }
    broadcastStorageChange(event.sender, {
      collection: validCollection,
      key: validKey,
      operation: 'delete',
    });
  });
  handle(IPC.storageKeys, (_event, collection: unknown) =>
    options.storage.keys(validateText(collection, 'collection', 64)),
  );
  handle(IPC.storageClear, (event, collection: unknown) => {
    const validCollection = validateText(collection, 'collection', 64);
    options.storage.clear(validCollection);
    if (validCollection === STORAGE.config) {
      options.applyThemePreference('system');
      try {
        options.applyAccentPreference?.('weed');
      } catch {
        // See storageSet: native chrome must not block durable UI state.
      }
    }
    broadcastStorageChange(event.sender, { collection: validCollection, operation: 'clear' });
  });
  handle(IPC.storageReadBatch, (_event, rawAddresses: unknown) =>
    options.storage.readBatch(validateStorageAddresses(rawAddresses)),
  );
  handle(IPC.storageCommitBatch, (event, rawRequest: unknown) => {
    const request = validateStorageBatch(rawRequest);
    const result = options.storage.commitBatch(request);
    if (!result.committed) return result;
    for (const mutation of request.mutations) {
      if (mutation.collection === STORAGE.config && mutation.key === 'theme') {
        options.applyThemePreference(mutation.operation === 'set' ? mutation.value : 'system');
      }
      if (mutation.collection === STORAGE.config && mutation.key === 'accent') {
        try {
          options.applyAccentPreference?.(mutation.operation === 'set' ? mutation.value : 'weed');
        } catch {
          // Native icon updates remain best-effort after the durable batch.
        }
      }
      broadcastStorageChange(event.sender, {
        collection: mutation.collection,
        key: mutation.key,
        operation: mutation.operation,
      });
    }
    return result;
  });

  handle(IPC.coreGetEndpoint, async (_event, rawSource?: unknown) => {
    if (rawSource !== undefined && !CORE_SOURCES.has(rawSource as CoreSourcePreference)) {
      throw new TypeError('Invalid Core source');
    }
    const source = rawSource as CoreSourcePreference | undefined;
    return exposeEndpoint(await options.core.getEndpoint(source), source !== undefined);
  });
  handle(IPC.coreConfigure, async (_event, rawConfig: unknown) => {
    const config = validateConfig(rawConfig);
    return exposeEndpoint(await options.core.configure(config));
  });
  handle(IPC.coreGetStatus, () => exposeCoreStatus());
  handle(IPC.coreRecover, async (event, rawAction: unknown) => {
    if (!RECOVERY_ACTIONS.has(rawAction as CoreRecoveryAction)) throw new TypeError('Invalid recovery action');
    try {
      return exposeEndpoint(await options.core.recover(rawAction as CoreRecoveryAction));
    } finally {
      const source = options.core.getStatus().preferredSource;
      options.storage.set(STORAGE.config, CORE_SOURCE_STORAGE_KEY, source);
      broadcastStorageChange(event.sender, {
        collection: STORAGE.config,
        key: CORE_SOURCE_STORAGE_KEY,
        operation: 'set',
      });
    }
  });
  handle(IPC.coreSelectSource, async (event, rawSource: unknown) => {
    if (!CORE_SOURCES.has(rawSource as CoreSourcePreference)) throw new TypeError('Invalid Core source');
    const source = rawSource as CoreSourcePreference;
    try {
      return exposeEndpoint(await options.core.selectSource(source));
    } finally {
      // Persist the user's intention even when Local is temporarily unable to
      // start; next launch retries it while the current run remains on the
      // visible remote fallback.
      const preferredSource = options.core.getStatus().preferredSource;
      options.storage.set(STORAGE.config, CORE_SOURCE_STORAGE_KEY, preferredSource);
      broadcastStorageChange(event.sender, {
        collection: STORAGE.config,
        key: CORE_SOURCE_STORAGE_KEY,
        operation: 'set',
      });
    }
  });

  handle(IPC.updateCheck, () => options.updates.checkForUpdates());
  handle(IPC.updateGetState, () => options.updates.getState());
  handle(IPC.updateApply, async (_event, rawTargets: unknown) => {
    if (!Array.isArray(rawTargets) || rawTargets.length > 3) throw new TypeError('Invalid update targets');
    const targets = [...new Set(rawTargets)];
    if (!targets.every((target) => UPDATE_TARGETS.has(target as 'app' | 'core' | 'bank'))) {
      throw new TypeError('Invalid update target');
    }
    await options.updates.applyUpdates(targets as Array<'app' | 'core' | 'bank'>);
  });
  handle(IPC.updateRelaunch, () => options.updates.relaunchToApply());
  handle(IPC.networkGet, () => options.network.isOnline());
  handle(IPC.shellOpenWindow, (_event, rawTarget: unknown) => {
    if (!DESKTOP_WINDOWS.has(rawTarget as DesktopWindowTarget)) {
      throw new TypeError('Invalid desktop window target');
    }
    options.openDesktopWindow(rawTarget as DesktopWindowTarget);
  });

  const onCoreStatus = (status: CoreRuntimeStatus) => {
    broadcast(IPC.coreStatus, exposeCoreStatus(status));
  };
  const onUpdateState = () => {
    broadcast(IPC.updateState, options.updates.getState());
  };
  const onNetworkChange = (online: boolean) => broadcast(IPC.networkChange, online);
  options.core.on('status', onCoreStatus);
  options.updates.on('state', onUpdateState);
  options.network.on('change', onNetworkChange);

  return {
    dispose() {
      for (const channel of channels) ipcMain.removeHandler(channel);
      options.core.off('status', onCoreStatus);
      options.updates.off('state', onUpdateState);
      options.network.off('change', onNetworkChange);
    },
  };
}
