import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  STORAGE,
  type ClientConfig,
  type CoreEndpoint,
  type CoreRecoveryAction,
  type CoreRuntimeStatus,
  type DesktopWindowTarget,
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
}

const RECOVERY_ACTIONS = new Set<CoreRecoveryAction>(['retry', 'use-remote', 'repair']);
const UPDATE_TARGETS = new Set(['app', 'core', 'bank'] as const);
const DESKTOP_WINDOWS = new Set<DesktopWindowTarget>(['practice', 'updates', 'node']);

function validateText(value: unknown, name: string, maxLength = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
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
    IPC.coreGetEndpoint,
    IPC.coreConfigure,
    IPC.coreGetStatus,
    IPC.coreRecover,
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

  const exposeEndpoint = (endpoint: CoreEndpoint): CoreEndpoint => ({
    baseUrl: coreBaseUrl,
    source: endpoint.source,
  });
  const exposeCoreStatus = (status = options.core.getStatus()): CoreRuntimeStatus => ({
    ...status,
    endpoint: coreBaseUrl,
  });
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
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
        window.webContents.send(IPC.storageChange, change);
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
    if (validCollection === STORAGE.config) options.applyThemePreference('system');
    broadcastStorageChange(event.sender, { collection: validCollection, operation: 'clear' });
  });

  handle(IPC.coreGetEndpoint, async () => exposeEndpoint(await options.core.getEndpoint()));
  handle(IPC.coreConfigure, async (_event, rawConfig: unknown) => {
    const config = validateConfig(rawConfig);
    options.updates.setRepositories(config.coreRepoUrl, config.bankRepoUrl);
    return exposeEndpoint(await options.core.configure(config));
  });
  handle(IPC.coreGetStatus, () => exposeCoreStatus());
  handle(IPC.coreRecover, async (_event, rawAction: unknown) => {
    if (!RECOVERY_ACTIONS.has(rawAction as CoreRecoveryAction)) throw new TypeError('Invalid recovery action');
    return exposeEndpoint(await options.core.recover(rawAction as CoreRecoveryAction));
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
