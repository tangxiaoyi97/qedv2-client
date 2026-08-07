import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopIpcOptions } from '../src/main/ipc.js';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: {
      id: number;
      isDestroyed: () => boolean;
      send: ReturnType<typeof vi.fn>;
    };
  }>,
  removeHandler: vi.fn(),
  handle: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electronMocks.windows },
  ipcMain: {
    removeHandler: (channel: string) => {
      electronMocks.removeHandler(channel);
      electronMocks.handlers.delete(channel);
    },
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMocks.handle(channel, handler);
      electronMocks.handlers.set(channel, handler);
    },
  },
}));

import { installDesktopIpc } from '../src/main/ipc.js';
import { IPC } from '../src/shared/channels.js';

function options(): DesktopIpcOptions {
  const core = Object.assign(new EventEmitter(), {
    getStatus: vi.fn(() => ({
      phase: 'ready',
      source: 'local',
      preferredSource: 'local',
      endpoint: 'http://127.0.0.1:1024',
      contentId: 'bank-local',
    })),
    getEndpoint: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1024', source: 'local' })),
    configure: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1024', source: 'local' })),
    recover: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1024', source: 'local' })),
    selectSource: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1024', source: 'local' })),
  });
  const updates = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => []),
    getState: vi.fn(() => ({ busy: false, targets: [] })),
    applyUpdates: vi.fn(async () => undefined),
    relaunchToApply: vi.fn(async () => undefined),
  });
  const network = Object.assign(new EventEmitter(), { isOnline: vi.fn(() => true) });
  const storage = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    keys: vi.fn(() => []),
    clear: vi.fn(),
    readBatch: vi.fn(() => []),
    commitBatch: vi.fn(() => ({ committed: true })),
  };
  return {
    renderer: {
      origin: 'http://127.0.0.1:1122',
      bootUrl: 'http://127.0.0.1:1122/__qed2_boot/token',
      port: 1122,
      token: 'token',
    },
    storage,
    core,
    updates,
    network,
    openDesktopWindow: vi.fn(),
    applyThemePreference: vi.fn(),
    applyAccentPreference: vi.fn(),
  } as unknown as DesktopIpcOptions;
}

function trustedEvent(): unknown {
  return {
    senderFrame: {
      parent: null,
      url: 'http://127.0.0.1:1122/settings?section=desktop',
    },
    sender: { id: 101 },
  };
}

function browserWindow(id: number, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      id,
      isDestroyed: () => destroyed,
      send: vi.fn(),
    },
  };
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return await handler(trustedEvent(), ...args);
}

describe('Desktop IPC native-shell boundary', () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    electronMocks.windows.length = 0;
    vi.clearAllMocks();
  });

  it('maps selected and source-pinned Core endpoints without exposing native ports', async () => {
    const desktop = options();
    vi.mocked(desktop.core.getEndpoint).mockImplementation(async (source) => {
      if (source === 'local') {
        return {
          baseUrl: 'http://127.0.0.1:1022',
          source: 'local',
          contentId: 'bank-local',
        };
      }
      return { baseUrl: 'https://core.example', source: 'remote' };
    });
    installDesktopIpc(desktop);

    await expect(invoke(IPC.coreGetEndpoint)).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:1122/__qed2_core',
      source: 'remote',
    });
    await expect(invoke(IPC.coreGetEndpoint, 'local')).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:1122/__qed2_core/local',
      source: 'local',
      contentId: 'bank-local',
    });
    await expect(invoke(IPC.coreGetEndpoint, 'remote')).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:1122/__qed2_core/remote',
      source: 'remote',
    });
    expect(desktop.core.getEndpoint).toHaveBeenNthCalledWith(1, undefined);
    expect(desktop.core.getEndpoint).toHaveBeenNthCalledWith(2, 'local');
    expect(desktop.core.getEndpoint).toHaveBeenNthCalledWith(3, 'remote');

    for (const invalid of [null, 'automatic', 'LOCAL', {}, 0]) {
      await expect(invoke(IPC.coreGetEndpoint, invalid)).rejects.toThrow('Invalid Core source');
    }
    expect(desktop.core.getEndpoint).toHaveBeenCalledTimes(3);
  });

  it('validates source selection, persists the preference, and broadcasts typed changes', async () => {
    const desktop = options();
    const senderWindow = browserWindow(101);
    const peerWindow = browserWindow(202);
    const destroyedWindow = browserWindow(303, true);
    electronMocks.windows.push(senderWindow, peerWindow, destroyedWindow);
    const remoteStatus = {
      phase: 'ready' as const,
      source: 'remote' as const,
      preferredSource: 'remote' as const,
      endpoint: 'https://core.example',
    };
    vi.mocked(desktop.core.getStatus).mockReturnValue(remoteStatus);
    vi.mocked(desktop.core.selectSource).mockResolvedValue({
      baseUrl: 'https://core.example',
      source: 'remote',
    });
    installDesktopIpc(desktop);

    await expect(invoke(IPC.coreSelectSource, 'remote')).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:1122/__qed2_core',
      source: 'remote',
    });
    expect(desktop.core.selectSource).toHaveBeenCalledWith('remote');
    expect(desktop.storage.set).toHaveBeenCalledWith('config', 'core-source', 'remote');
    expect(senderWindow.webContents.send).not.toHaveBeenCalledWith(
      IPC.storageChange,
      expect.anything(),
    );
    expect(peerWindow.webContents.send).toHaveBeenCalledWith(IPC.storageChange, {
      collection: 'config',
      key: 'core-source',
      operation: 'set',
    });
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();

    desktop.core.emit('status', remoteStatus);
    for (const window of [senderWindow, peerWindow]) {
      expect(window.webContents.send).toHaveBeenCalledWith(IPC.coreStatus, {
        ...remoteStatus,
        endpoint: 'http://127.0.0.1:1122/__qed2_core',
      });
    }

    vi.mocked(desktop.core.selectSource).mockClear();
    vi.mocked(desktop.storage.set).mockClear();
    for (const invalid of [undefined, null, 'automatic', 'REMOTE', {}, 0]) {
      await expect(invoke(IPC.coreSelectSource, invalid)).rejects.toThrow('Invalid Core source');
    }
    expect(desktop.core.selectSource).not.toHaveBeenCalled();
    expect(desktop.storage.set).not.toHaveBeenCalled();
  });

  it('persists and broadcasts the preferred source even when local selection fails', async () => {
    const desktop = options();
    const peerWindow = browserWindow(202);
    electronMocks.windows.push(browserWindow(101), peerWindow);
    vi.mocked(desktop.core.selectSource).mockRejectedValue(new Error('Local Core failed to start'));
    vi.mocked(desktop.core.getStatus).mockReturnValue({
      phase: 'degraded',
      source: 'remote',
      preferredSource: 'local',
      endpoint: 'https://core.example',
      error: {
        code: 'CORE_START_FAILED',
        message: 'Local Core failed to start',
        recoverable: true,
      },
    });
    installDesktopIpc(desktop);

    await expect(invoke(IPC.coreSelectSource, 'local')).rejects.toThrow(
      'Local Core failed to start',
    );
    expect(desktop.storage.set).toHaveBeenCalledWith('config', 'core-source', 'local');
    expect(peerWindow.webContents.send).toHaveBeenCalledWith(IPC.storageChange, {
      collection: 'config',
      key: 'core-source',
      operation: 'set',
    });
  });

  it('accepts only the three typed singleton targets', async () => {
    const desktop = options();
    const installed = installDesktopIpc(desktop);

    for (const target of ['practice', 'updates', 'node'] as const) {
      await invoke(IPC.shellOpenWindow, target);
    }
    expect(desktop.openDesktopWindow).toHaveBeenCalledTimes(3);
    expect(desktop.openDesktopWindow).toHaveBeenNthCalledWith(1, 'practice');
    expect(desktop.openDesktopWindow).toHaveBeenNthCalledWith(2, 'updates');
    expect(desktop.openDesktopWindow).toHaveBeenNthCalledWith(3, 'node');

    await expect(invoke(IPC.shellOpenWindow, 'main')).rejects.toThrow(
      'Invalid desktop window target',
    );
    await expect(invoke(IPC.shellOpenWindow, 'https://example.com')).rejects.toThrow(
      'Invalid desktop window target',
    );
    expect(desktop.openDesktopWindow).toHaveBeenCalledTimes(3);
    installed.dispose();
  });

  it('rejects non-top-level and foreign-origin senders before any action', async () => {
    const desktop = options();
    installDesktopIpc(desktop);
    const handler = electronMocks.handlers.get(IPC.shellOpenWindow);
    expect(handler).toBeDefined();

    expect(() => handler?.({
      senderFrame: { parent: {}, url: 'http://127.0.0.1:1122/' },
      sender: { id: 1 },
    }, 'node')).toThrow('top-level QED2 frame');
    expect(() => handler?.({
      senderFrame: { parent: null, url: 'https://example.com/' },
      sender: { id: 1 },
    }, 'node')).toThrow('not a QED2 desktop window');
    expect(desktop.openDesktopWindow).not.toHaveBeenCalled();
  });

  it('synchronizes native theme and accent icons through existing storage mutations', async () => {
    const desktop = options();
    installDesktopIpc(desktop);

    await invoke(IPC.storageSet, 'config', 'theme', 'dark');
    await invoke(IPC.storageSet, 'config', 'accent', 'sky');
    await invoke(IPC.storageDelete, 'config', 'theme');
    await invoke(IPC.storageDelete, 'config', 'accent');
    await invoke(IPC.storageClear, 'config');
    await invoke(IPC.storageSet, 'config', 'overrides', { coreBaseUrl: 'https://core.invalid' });

    expect(desktop.applyThemePreference).toHaveBeenNthCalledWith(1, 'dark');
    expect(desktop.applyThemePreference).toHaveBeenNthCalledWith(2, 'system');
    expect(desktop.applyThemePreference).toHaveBeenNthCalledWith(3, 'system');
    expect(desktop.applyThemePreference).toHaveBeenCalledTimes(3);
    expect(desktop.applyAccentPreference).toHaveBeenNthCalledWith(1, 'sky');
    expect(desktop.applyAccentPreference).toHaveBeenNthCalledWith(2, 'weed');
    expect(desktop.applyAccentPreference).toHaveBeenNthCalledWith(3, 'weed');
    expect(desktop.applyAccentPreference).toHaveBeenCalledTimes(3);
  });

  it('still commits and broadcasts an accent when native icon application fails', async () => {
    const desktop = options();
    vi.mocked(desktop.applyAccentPreference!).mockImplementation(() => {
      throw new Error('Dock unavailable');
    });
    const peer = browserWindow(202);
    electronMocks.windows.push(peer);
    installDesktopIpc(desktop);

    await expect(invoke(IPC.storageSet, 'config', 'accent', 'sky')).resolves.toBeUndefined();

    expect(desktop.storage.set).toHaveBeenCalledWith('config', 'accent', 'sky');
    expect(peer.webContents.send).toHaveBeenCalledWith(
      IPC.storageChange,
      { collection: 'config', key: 'accent', operation: 'set' },
    );
  });

  it('validates and forwards bounded atomic storage batches and broadcasts only after commit', async () => {
    const desktop = options();
    const peer = browserWindow(202);
    electronMocks.windows.push(browserWindow(101), peer);
    vi.mocked(desktop.storage.readBatch).mockReturnValue([
      { collection: 'archive', key: 'current', revision: 4, exists: true, value: { baseVersion: 1 } },
    ]);
    installDesktopIpc(desktop);

    const addresses = [{ collection: 'archive', key: 'current' }];
    await expect(invoke(IPC.storageReadBatch, addresses)).resolves.toEqual([
      { ...addresses[0], revision: 4, exists: true, value: { baseVersion: 1 } },
    ]);
    expect(desktop.storage.readBatch).toHaveBeenCalledWith(addresses);

    const request = {
      ifRevisions: [{ collection: 'archive', key: 'current', revision: 4 }],
      mutations: [{ collection: 'archive', key: 'current', operation: 'set', value: { baseVersion: 2 } }],
    };
    await expect(invoke(IPC.storageCommitBatch, request)).resolves.toEqual({ committed: true });
    expect(desktop.storage.commitBatch).toHaveBeenCalledWith(request);
    expect(peer.webContents.send).toHaveBeenCalledWith(IPC.storageChange, {
      collection: 'archive',
      key: 'current',
      operation: 'set',
    });

    peer.webContents.send.mockClear();
    vi.mocked(desktop.storage.commitBatch).mockReturnValueOnce({ committed: false });
    await expect(invoke(IPC.storageCommitBatch, request)).resolves.toEqual({ committed: false });
    expect(peer.webContents.send).not.toHaveBeenCalled();
  });

  it('rejects malformed or unbounded storage batches before SQLite sees them', async () => {
    const desktop = options();
    installDesktopIpc(desktop);

    for (const invalid of [
      null,
      {},
      { ifRevisions: [], mutations: [] },
      {
        ifRevisions: [{ collection: '../archive', key: 'current', revision: 0 }],
        mutations: [{ collection: '../archive', key: 'current', operation: 'delete' }],
      },
      {
        ifRevisions: [{ collection: 'archive', key: 'current', revision: -1 }],
        mutations: [{ collection: 'archive', key: 'current', operation: 'delete' }],
      },
      {
        ifRevisions: [{ collection: 'archive', key: 'current', revision: 0 }],
        mutations: [{ collection: 'archive', key: 'current', operation: 'run' }],
      },
      {
        ifRevisions: Array.from({ length: 33 }, (_, index) => ({
          collection: 'app', key: `key-${index}`, revision: 0,
        })),
        mutations: [{ collection: 'app', key: 'key-0', operation: 'delete' }],
      },
    ]) {
      await expect(invoke(IPC.storageCommitBatch, invalid)).rejects.toThrow();
    }
    await expect(invoke(IPC.storageReadBatch, Array.from({ length: 33 }, (_, index) => ({
      collection: 'app', key: `key-${index}`,
    })))).rejects.toThrow('batch size');
    expect(desktop.storage.commitBatch).not.toHaveBeenCalled();
    expect(desktop.storage.readBatch).not.toHaveBeenCalled();
  });

  it('ignores a renderer that closes during a status or storage broadcast', async () => {
    const desktop = options();
    const closingWindow = browserWindow(202);
    closingWindow.webContents.send.mockImplementation(() => {
      throw new Error('Render frame was disposed');
    });
    electronMocks.windows.push(closingWindow);
    installDesktopIpc(desktop);

    expect(() => desktop.core.emit('status', desktop.core.getStatus())).not.toThrow();
    await expect(invoke(IPC.storageSet, 'config', 'accent', 'sky')).resolves.toBeUndefined();
    expect(closingWindow.webContents.send).toHaveBeenCalled();
  });
});
