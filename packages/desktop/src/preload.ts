import { contextBridge, ipcRenderer } from 'electron';
import type {
  ClientConfig,
  CoreRecoveryAction,
  CoreRuntimeStatus,
  CoreSourcePreference,
  DesktopRendererKind,
  DesktopWindowTarget,
  PlatformPorts,
  ShellCommand,
  StorageAddress,
  StorageBatchCommit,
  StorageBatchCommitResult,
  StorageChange,
  StorageVersionedEntry,
  UpdateSnapshot,
} from '@qed2/core-logic';
import { IPC } from './shared/channels.js';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(structuredClone(payload));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.findLast((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const appVersion = argument('qed2-app-version') ?? 'unknown';
const selfUpdateAvailable = argument('qed2-self-update') === 'true';
const manualAppInstall = argument('qed2-manual-app-install') === 'true';
const rawWindowKind = argument('qed2-window-kind');
const desktopWindowKinds = new Set<DesktopRendererKind>(['main', 'practice', 'updates', 'node']);
const windowKind = desktopWindowKinds.has(rawWindowKind as DesktopRendererKind)
  ? rawWindowKind as DesktopRendererKind
  : undefined;
let online =
  typeof globalThis.navigator === 'undefined'
    ? true
    : (globalThis.navigator as { onLine?: boolean }).onLine !== false;
ipcRenderer.on(IPC.networkChange, (_event, value: boolean) => {
  online = value;
});

const ports: Partial<PlatformPorts> = {
  storage: {
    get: async <T>(collection: string, key: string) =>
      (await ipcRenderer.invoke(IPC.storageGet, collection, key)) as T | undefined,
    set: async <T>(collection: string, key: string, value: T) => {
      await ipcRenderer.invoke(IPC.storageSet, collection, key, value);
    },
    delete: async (collection: string, key: string) => {
      await ipcRenderer.invoke(IPC.storageDelete, collection, key);
    },
    keys: async (collection: string) =>
      (await ipcRenderer.invoke(IPC.storageKeys, collection)) as string[],
    clear: async (collection: string) => {
      await ipcRenderer.invoke(IPC.storageClear, collection);
    },
    readBatch: async (addresses: readonly StorageAddress[]) =>
      (await ipcRenderer.invoke(IPC.storageReadBatch, addresses)) as StorageVersionedEntry[],
    commitBatch: async (request: StorageBatchCommit) =>
      (await ipcRenderer.invoke(IPC.storageCommitBatch, request)) as StorageBatchCommitResult,
    onChange: (callback) => subscribe<StorageChange>(IPC.storageChange, callback),
  },
  coreRuntime: {
    capabilities: { localCore: true },
    getEndpoint: async (source?: CoreSourcePreference) =>
      await ipcRenderer.invoke(IPC.coreGetEndpoint, source),
    configure: async (config: ClientConfig) => await ipcRenderer.invoke(IPC.coreConfigure, config),
    getStatus: async () => (await ipcRenderer.invoke(IPC.coreGetStatus)) as CoreRuntimeStatus,
    onStatusChange: (callback) => subscribe<CoreRuntimeStatus>(IPC.coreStatus, callback),
    recover: async (action: CoreRecoveryAction) => await ipcRenderer.invoke(IPC.coreRecover, action),
    selectSource: async (source: CoreSourcePreference) =>
      await ipcRenderer.invoke(IPC.coreSelectSource, source),
  },
  update: {
    capabilities: { selfUpdate: selfUpdateAvailable, manualAppInstall },
    getAppVersion: () => appVersion,
    getState: async () => (await ipcRenderer.invoke(IPC.updateGetState)) as UpdateSnapshot,
    onChange: (callback) => subscribe<UpdateSnapshot>(IPC.updateState, callback),
    ...(selfUpdateAvailable
      ? {
          checkForUpdates: async () => await ipcRenderer.invoke(IPC.updateCheck),
          applyUpdates: async (targets: Array<'core' | 'bank' | 'app'>) => {
            await ipcRenderer.invoke(IPC.updateApply, targets);
          },
          relaunchToApply: async () => {
            await ipcRenderer.invoke(IPC.updateRelaunch);
          },
        }
      : {}),
  },
  network: {
    isOnline: () => online,
    onChange: (callback) => subscribe<boolean>(IPC.networkChange, (value) => {
      online = value;
      callback(value);
    }),
  },
  shell: {
    capabilities: { desktop: true, nativeMenu: true, nativeTitleBar: true },
    ...(windowKind ? { windowKind } : {}),
    onCommand: (callback) => subscribe<ShellCommand>(IPC.shellCommand, callback),
    openDesktopWindow: async (target: DesktopWindowTarget) => {
      await ipcRenderer.invoke(IPC.shellOpenWindow, target);
    },
  },
};

contextBridge.exposeInMainWorld('__QED2_PLATFORM_PORTS__', ports);
