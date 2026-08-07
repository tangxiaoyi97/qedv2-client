import { isProxy } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreRuntimeStatus } from '@qed2/core-logic';

const mocks = vi.hoisted(() => {
  const listeners: {
    network?: (online: boolean) => void;
    runtime?: (status: CoreRuntimeStatus) => void;
  } = {};
  return {
    listeners,
    configure: vi.fn(),
    getEndpoint: vi.fn(),
    getStatus: vi.fn(),
    onStatusChange: vi.fn((cb: (status: CoreRuntimeStatus) => void) => {
      listeners.runtime = cb;
      return () => {
        if (listeners.runtime === cb) listeners.runtime = undefined;
      };
    }),
    onNetworkChange: vi.fn((cb: (online: boolean) => void) => {
      listeners.network = cb;
      return () => {
        if (listeners.network === cb) listeners.network = undefined;
      };
    }),
    getOverrides: vi.fn(),
    getTheme: vi.fn(),
    setConfig: vi.fn(),
    setTheme: vi.fn(),
    setCurrentCoreUrl: vi.fn(),
  };
});

vi.mock('../src/services.js', () => ({
  storage: {},
  configStore: {
    getOverrides: mocks.getOverrides,
    getTheme: mocks.getTheme,
    setConfig: mocks.setConfig,
    setTheme: mocks.setTheme,
  },
  envConfigDefaults: () => ({}),
  ports: {
    coreRuntime: {
      capabilities: { localCore: true },
      getEndpoint: mocks.getEndpoint,
      configure: mocks.configure,
      getStatus: mocks.getStatus,
      onStatusChange: mocks.onStatusChange,
    },
    network: {
      isOnline: () => true,
      onChange: mocks.onNetworkChange,
    },
  },
  setCurrentCoreUrl: mocks.setCurrentCoreUrl,
}));

vi.mock('../src/platform/theme.js', () => ({
  syncThemeColorFromCss: vi.fn(),
}));

import { useAppStore } from '../src/stores/app.js';

const initialStatus: CoreRuntimeStatus = {
  phase: 'ready',
  source: 'local',
  endpoint: 'http://127.0.0.1:41001',
};

function stubBrowserApis(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('offline'))),
  );
  window.matchMedia = vi.fn(() => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.listeners.network = undefined;
  mocks.listeners.runtime = undefined;
  for (const mock of [
    mocks.configure,
    mocks.getEndpoint,
    mocks.getStatus,
    mocks.onStatusChange,
    mocks.onNetworkChange,
    mocks.getOverrides,
    mocks.getTheme,
    mocks.setConfig,
    mocks.setTheme,
    mocks.setCurrentCoreUrl,
  ]) {
    mock.mockClear();
  }
  mocks.getOverrides.mockResolvedValue({
    coreBaseUrl: 'https://remote-core.test',
    coreRepoUrl: 'https://git.test/core',
    bankRepoUrl: 'https://git.test/bank',
  });
  mocks.getTheme.mockResolvedValue('system');
  mocks.getStatus.mockResolvedValue(initialStatus);
  stubBrowserApis();
});

describe('desktop core runtime integration', () => {
  it('subscribes before configure and passes a plain complete config', async () => {
    mocks.configure.mockResolvedValue({
      baseUrl: initialStatus.endpoint,
      source: 'local',
    });
    const app = useAppStore();

    await app.init();

    expect(mocks.onStatusChange).toHaveBeenCalledOnce();
    expect(mocks.onStatusChange.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.configure.mock.invocationCallOrder[0]!,
    );
    expect(mocks.configure).toHaveBeenCalledOnce();
    const configured = mocks.configure.mock.calls[0]?.[0];
    expect(isProxy(configured)).toBe(false);
    expect(configured).toMatchObject({
      coreBaseUrl: 'https://remote-core.test',
      coreRepoUrl: 'https://git.test/core',
      bankRepoUrl: 'https://git.test/bank',
    });
    expect(app.coreEndpointUrl).toBe(initialStatus.endpoint);
    expect(app.coreEndpointSource).toBe('local');
    expect(app.coreRuntimeStatus).toEqual(initialStatus);
  });

  it('adopts status endpoints and reconfigures when connectivity changes', async () => {
    mocks.configure
      .mockResolvedValueOnce({ baseUrl: initialStatus.endpoint, source: 'local' })
      .mockResolvedValueOnce({ baseUrl: 'https://remote-core.test', source: 'remote' });
    const app = useAppStore();
    await app.init();

    mocks.listeners.runtime?.({
      phase: 'ready',
      source: 'local',
      endpoint: 'http://127.0.0.1:41002',
    });
    expect(app.coreEndpointUrl).toBe('http://127.0.0.1:41002');

    mocks.listeners.network?.(false);
    await vi.waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(app.coreEndpointUrl).toBe('https://remote-core.test'));
    expect(app.online).toBe(false);
    expect(app.coreEndpointSource).toBe('remote');
  });

  it('keeps the configured remote endpoint when desktop configure fails', async () => {
    mocks.configure.mockRejectedValue(new Error('runtime unavailable'));
    const app = useAppStore();

    await app.init();

    expect(app.coreEndpointUrl).toBe('https://remote-core.test');
    expect(app.coreEndpointSource).toBe('remote');
  });
});
