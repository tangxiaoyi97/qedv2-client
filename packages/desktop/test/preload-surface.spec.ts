import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPorts } from '@qed2/core-logic';
import { IPC } from '../src/shared/channels.js';

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

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
  });

  it('exposes only the typed PlatformPorts seam', async () => {
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
    await exposed.shell?.openDesktopWindow?.('node');
    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC.shellOpenWindow, 'node');
  });
});
