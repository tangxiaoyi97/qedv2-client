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
    storageGet: vi.fn(),
    storageSet: vi.fn(),
    setConfig: vi.fn(),
    setTheme: vi.fn(),
    setBuiltinThemeExtension: vi.fn(),
    setCurrentCoreUrl: vi.fn(),
  };
});

vi.mock('../src/services.js', () => ({
  storage: {
    get: mocks.storageGet,
    set: mocks.storageSet,
  },
  configStore: {
    getOverrides: mocks.getOverrides,
    getTheme: mocks.getTheme,
    setConfig: mocks.setConfig,
    setTheme: mocks.setTheme,
  },
  envConfigDefaults: () => ({}),
  ports: {
    shell: {
      capabilities: { desktop: false },
    },
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
  currentBuiltinThemeId: () => 'weed',
  isBuiltinThemeId: (value: unknown) =>
    value === 'weed' || value === 'sky' || value === 'raspberry' || value === 'violette',
  setBuiltinThemeExtension: mocks.setBuiltinThemeExtension,
  syncThemeColorFromCss: vi.fn(),
}));

import { useAppStore } from '../src/stores/app.js';

const initialStatus: CoreRuntimeStatus = {
  phase: 'ready',
  source: 'local',
  preferredSource: 'local',
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
    mocks.storageGet,
    mocks.storageSet,
    mocks.setConfig,
    mocks.setTheme,
    mocks.setBuiltinThemeExtension,
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
  mocks.storageGet.mockResolvedValue(undefined);
  mocks.storageSet.mockResolvedValue(undefined);
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
      preferredSource: 'local',
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

  it('discards a slow Local info probe after the renderer fails over to Remote', async () => {
    let resolveLocal!: (response: Response) => void;
    let resolveRemote!: (response: Response) => void;
    const localResponse = new Promise<Response>((resolve) => { resolveLocal = resolve; });
    const remoteResponse = new Promise<Response>((resolve) => { resolveRemote = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${initialStatus.endpoint}/content/info`) return localResponse;
      if (url === 'https://remote-core.test/content/info') return remoteResponse;
      return Promise.reject(new TypeError('offline'));
    });
    vi.stubGlobal('fetch', fetchMock);
    mocks.configure.mockResolvedValue({
      baseUrl: initialStatus.endpoint,
      source: 'local',
    });
    const app = useAppStore();
    await app.init();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `${initialStatus.endpoint}/content/info`,
        expect.objectContaining({ credentials: 'omit' }),
      );
    });

    mocks.listeners.runtime?.({
      phase: 'degraded',
      source: 'remote',
      preferredSource: 'local',
      endpoint: 'https://remote-core.test',
    });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://remote-core.test/content/info',
        expect.objectContaining({ credentials: 'omit' }),
      );
    });

    resolveLocal(new Response(JSON.stringify({ version: 'local-old' }), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(app.coreInfo).toBeUndefined();

    resolveRemote(new Response(JSON.stringify({ version: 'remote-current' }), { status: 200 }));
    await vi.waitFor(() => expect(app.coreInfo?.version).toBe('remote-current'));
    expect(app.coreEndpointSource).toBe('remote');
  });

  it('keeps the durable accent active when Desktop storage rejects the change', async () => {
    mocks.storageSet.mockRejectedValueOnce(new Error('disk full'));
    const app = useAppStore();

    await expect(app.setAccentTheme('sky')).rejects.toThrow('disk full');

    expect(app.accentTheme).toBe('weed');
    expect(mocks.setBuiltinThemeExtension).not.toHaveBeenCalled();
  });
});
