import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopIpcOptions } from '../src/main/ipc.js';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
  handle: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
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
    getStatus: () => ({ phase: 'ready', source: 'local', endpoint: 'http://127.0.0.1:1024' }),
    getEndpoint: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1024', source: 'local' })),
    configure: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1024', source: 'local' })),
    recover: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1024', source: 'local' })),
  });
  const updates = Object.assign(new EventEmitter(), {
    setRepositories: vi.fn(),
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

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return await handler(trustedEvent(), ...args);
}

describe('Desktop IPC native-shell boundary', () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    vi.clearAllMocks();
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

  it('synchronizes native theme changes through existing storage mutations', async () => {
    const desktop = options();
    installDesktopIpc(desktop);

    await invoke(IPC.storageSet, 'config', 'theme', 'dark');
    await invoke(IPC.storageDelete, 'config', 'theme');
    await invoke(IPC.storageClear, 'config');
    await invoke(IPC.storageSet, 'config', 'overrides', { coreBaseUrl: 'https://core.invalid' });

    expect(desktop.applyThemePreference).toHaveBeenNthCalledWith(1, 'dark');
    expect(desktop.applyThemePreference).toHaveBeenNthCalledWith(2, 'system');
    expect(desktop.applyThemePreference).toHaveBeenNthCalledWith(3, 'system');
    expect(desktop.applyThemePreference).toHaveBeenCalledTimes(3);
  });
});
