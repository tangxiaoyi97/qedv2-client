import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPorts, StorageAddress, StorageBatchCommit } from '@qed2/core-logic';
import { IPC } from '../src/shared/channels.js';

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

const originalArgv = [...process.argv];

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

describe('desktop preload surface', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = [...originalArgv];
  });

  afterEach(() => {
    process.argv = [...originalArgv];
  });

  it('exposes only the typed PlatformPorts seam and fails closed without updater metadata', async () => {
    await import('../src/preload.js');

    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledWith(
      '__QED2_PLATFORM_PORTS__',
      expect.objectContaining({
        storage: expect.any(Object),
        coreRuntime: expect.any(Object),
        update: expect.any(Object),
        network: expect.any(Object),
        shell: expect.any(Object),
      }),
    );
    const exposedNames = electronMocks.exposeInMainWorld.mock.calls.map(([name]) => name);
    expect(exposedNames).not.toContain('__QED2_DESKTOP__');
    expect(exposedNames).not.toContain('qed2Desktop');
    expect(exposedNames).not.toContain('qed2Ports');

    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as Partial<PlatformPorts>;
    expect(Object.keys(exposed).sort()).toEqual([
      'coreRuntime',
      'network',
      'shell',
      'storage',
      'update',
    ]);
    expect(Object.keys(exposed.coreRuntime ?? {}).sort()).toEqual([
      'capabilities',
      'configure',
      'getEndpoint',
      'getStatus',
      'onStatusChange',
      'recover',
      'selectSource',
    ]);
    expect(exposed.update?.capabilities.selfUpdate).toBe(false);
    expect(exposed.update?.capabilities.manualAppInstall).toBe(false);
    expect(exposed.update?.checkForUpdates).toBeUndefined();
    expect(exposed.update?.applyUpdates).toBeUndefined();
    expect(exposed.update?.relaunchToApply).toBeUndefined();
    expect(exposed.update?.getState).toEqual(expect.any(Function));
    await exposed.shell?.openDesktopWindow?.('node');
    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC.shellOpenWindow, 'node');
  });

  it('forwards source selection only through the typed CoreRuntimePort', async () => {
    electronMocks.invoke.mockImplementation(async (channel: string, source?: unknown) => ({
      baseUrl:
        channel === IPC.coreGetEndpoint && source !== undefined
          ? `http://127.0.0.1:1122/__qed2_core/${String(source)}`
          : 'http://127.0.0.1:1122/__qed2_core',
      source: source ?? 'local',
    }));
    await import('../src/preload.js');

    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as Partial<PlatformPorts>;
    await expect(exposed.coreRuntime?.getEndpoint()).resolves.toMatchObject({ source: 'local' });
    await expect(exposed.coreRuntime?.getEndpoint('local')).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:1122/__qed2_core/local',
      source: 'local',
    });
    await exposed.coreRuntime?.selectSource?.('remote');

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, IPC.coreGetEndpoint, undefined);
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, IPC.coreGetEndpoint, 'local');
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(3, IPC.coreSelectSource, 'remote');
  });

  it('exposes revisioned batch storage only through bounded typed IPC calls', async () => {
    electronMocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.storageReadBatch) {
        return [{ collection: 'archive', key: 'current', revision: 1, exists: true, value: {} }];
      }
      if (channel === IPC.storageCommitBatch) return { committed: true };
      return undefined;
    });
    await import('../src/preload.js');

    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as Partial<PlatformPorts>;
    const address: StorageAddress = { collection: 'archive', key: 'current' };
    const addresses = [address];
    await expect(exposed.storage?.readBatch?.(addresses)).resolves.toEqual([
      { ...address, revision: 1, exists: true, value: {} },
    ]);
    const request: StorageBatchCommit = {
      ifRevisions: [{ ...address, revision: 1 }],
      mutations: [{ ...address, operation: 'delete' }],
    };
    await expect(exposed.storage?.commitBatch?.(request)).resolves.toEqual({ committed: true });
    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC.storageReadBatch, addresses);
    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC.storageCommitBatch, request);
  });

  it('exposes update commands only when the main process marks the channel ready', async () => {
    process.argv.push(
      '--qed2-app-version=2.0.0',
      '--qed2-self-update=true',
      '--qed2-manual-app-install=true',
    );
    await import('../src/preload.js');

    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as Partial<PlatformPorts>;
    expect(exposed.update?.capabilities.selfUpdate).toBe(true);
    expect(exposed.update?.capabilities.manualAppInstall).toBe(true);
    expect(exposed.update?.getAppVersion()).toBe('2.0.0');
    expect(exposed.update?.checkForUpdates).toEqual(expect.any(Function));
    expect(exposed.update?.applyUpdates).toEqual(expect.any(Function));
    expect(exposed.update?.relaunchToApply).toEqual(expect.any(Function));

    await exposed.update?.checkForUpdates?.();
    await exposed.update?.applyUpdates?.(['app']);
    await exposed.update?.relaunchToApply?.();
    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC.updateCheck);
    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC.updateApply, ['app']);
    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC.updateRelaunch);
  });

  it('exposes only the bounded native window role for session isolation', async () => {
    process.argv.push('--qed2-window-kind=practice');
    await import('../src/preload.js');

    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as Partial<PlatformPorts>;
    expect(exposed.shell?.windowKind).toBe('practice');
  });

  it('uses the WindowManager capability argument when duplicate CLI values exist', async () => {
    process.argv.push('--qed2-self-update=true', '--qed2-self-update=false');
    await import('../src/preload.js');

    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as Partial<PlatformPorts>;
    expect(exposed.update?.capabilities.selfUpdate).toBe(false);
    expect(exposed.update?.checkForUpdates).toBeUndefined();
  });
});
