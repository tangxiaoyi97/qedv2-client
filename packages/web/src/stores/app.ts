/**
 * App store: runtime config (four configurable upstream addresses), theme,
 * connectivity, API client instances. Contract §8.2: never hardcode hosts —
 * everything flows from ClientConfig.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  CoreClient,
  ServerClient,
  mergeConfig,
  type ClientConfig,
  type CoreEndpoint,
  type CoreInfo,
  type CoreRuntimeStatus,
  type ServerInfo,
  STORAGE,
} from '@qed2/core-logic';
import { configStore, envConfigDefaults, ports, setCurrentCoreUrl, storage } from '../services.js';
import { runStorageMutation } from '../platform/desktop-storage.js';
import { syncThemeColorFromCss } from '../platform/theme.js';

export type ThemePref = 'light' | 'dark' | 'system';

function applyThemeToDom(pref: ThemePref): void {
  const dark =
    pref === 'dark' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  syncThemeColorFromCss();
}

export const useAppStore = defineStore('app', () => {
  const config = ref<ClientConfig>(mergeConfig(envConfigDefaults()));
  const theme = ref<ThemePref>('system');
  const online = ref(ports.network.isOnline());
  const coreInfo = shallowRef<CoreInfo | undefined>();
  const serverInfo = shallowRef<ServerInfo | undefined>();
  const ready = ref(false);
  /**
   * Core endpoint RESOLVED through CoreRuntimePort — on web this mirrors the
   * configured remote URL; a desktop shell's injected port may instead point
   * at its locally spawned core process (contract §8.1 offline mode).
   */
  const coreEndpointUrl = ref('');
  const coreEndpointSource = ref<CoreEndpoint['source']>('remote');
  /** Desktop lifecycle/provisioning state; undefined on the web adapter. */
  const coreRuntimeStatus = shallowRef<CoreRuntimeStatus | undefined>();

  /** Token is injected by the auth store so ServerClient stays fresh. */
  let tokenProvider: () => string | undefined = () => undefined;
  let endpointResolutionTail: Promise<void> = Promise.resolve();
  let runtimeStatusSubscribed = false;
  let networkSubscribed = false;
  let storageSubscribed = false;
  let externalSettingsTail: Promise<void> = Promise.resolve();

  const coreClient = computed(
    () => new CoreClient(coreEndpointUrl.value || config.value.coreBaseUrl),
  );
  const serverClient = computed(() => new ServerClient(config.value.serverBaseUrl, () => tokenProvider()));

  function applyCoreEndpoint(endpoint: CoreEndpoint): void {
    coreEndpointUrl.value = endpoint.baseUrl;
    coreEndpointSource.value = endpoint.source;
  }

  function applyCoreRuntimeStatus(status: CoreRuntimeStatus): void {
    const endpointChanged =
      status.endpoint !== '' &&
      (status.endpoint !== coreEndpointUrl.value || status.source !== coreEndpointSource.value);
    coreRuntimeStatus.value = status;
    if (!endpointChanged) return;
    applyCoreEndpoint({ baseUrl: status.endpoint, source: status.source });
    if (ready.value) refreshServiceInfo();
  }

  /** Subscribe before configure(), so first-install progress is not missed. */
  function subscribeCoreRuntimeStatus(): void {
    if (runtimeStatusSubscribed || !ports.coreRuntime.onStatusChange) return;
    runtimeStatusSubscribed = true;
    try {
      ports.coreRuntime.onStatusChange(applyCoreRuntimeStatus);
    } catch {
      // A broken optional status channel must not prevent the endpoint fallback.
    }
  }

  async function readCoreRuntimeStatus(): Promise<void> {
    if (!ports.coreRuntime.getStatus) return;
    try {
      applyCoreRuntimeStatus(await ports.coreRuntime.getStatus());
    } catch {
      // Status is diagnostic; getEndpoint/configure remains authoritative.
    }
  }

  async function resolveCoreEndpointNow(): Promise<void> {
    try {
      // Vue refs proxy objects deeply. Pass a plain, structured-cloneable copy
      // through a preload bridge instead of leaking a reactive Proxy into IPC.
      const currentConfig: ClientConfig = { ...config.value };
      const endpoint = ports.coreRuntime.configure
        ? await ports.coreRuntime.configure(currentConfig)
        : await ports.coreRuntime.getEndpoint();
      applyCoreEndpoint(endpoint);
    } catch {
      applyCoreEndpoint({ baseUrl: config.value.coreBaseUrl, source: 'remote' });
    }
  }

  /** Serialize config/network-triggered resolves so an older result cannot win. */
  function resolveCoreEndpoint(): Promise<void> {
    const run = endpointResolutionTail.then(resolveCoreEndpointNow, resolveCoreEndpointNow);
    endpointResolutionTail = run.catch(() => undefined);
    return run;
  }

  function setTokenProvider(fn: () => string | undefined): void {
    tokenProvider = fn;
  }

  async function reloadExternalSettings(key?: string): Promise<void> {
    const reloadConfig = key === undefined || key === 'overrides';
    const reloadTheme = key === undefined || key === 'theme';
    if (reloadConfig) {
      const previous = config.value;
      const overrides = await configStore.getOverrides();
      const next = mergeConfig({ ...envConfigDefaults(), ...overrides });
      config.value = next;
      if (ENDPOINT_KEYS.some((field) => previous[field] !== next[field])) {
        setCurrentCoreUrl(next.coreBaseUrl);
        await resolveCoreEndpoint();
        coreInfo.value = undefined;
        serverInfo.value = undefined;
        refreshServiceInfo();
      }
    }
    if (reloadTheme) {
      theme.value = ((await configStore.getTheme()) as ThemePref | undefined) ?? 'system';
      applyThemeToDom(theme.value);
    }
  }

  function subscribeStorageChanges(): void {
    if (storageSubscribed || !storage.onChange) return;
    storageSubscribed = true;
    storage.onChange((change) => {
      if (change.collection !== STORAGE.config) return;
      const key = change.operation === 'clear' ? undefined : change.key;
      const run = externalSettingsTail.then(
        () => reloadExternalSettings(key),
        () => reloadExternalSettings(key),
      );
      externalSettingsTail = run.catch(() => undefined);
    });
  }

  async function init(): Promise<void> {
    subscribeStorageChanges();
    const overrides = await configStore.getOverrides();
    config.value = mergeConfig({ ...envConfigDefaults(), ...overrides });
    setCurrentCoreUrl(config.value.coreBaseUrl);
    subscribeCoreRuntimeStatus();
    // Snapshot first, then configure: configure() is the authoritative endpoint
    // result, while the early subscription still captures progress emitted by it.
    await readCoreRuntimeStatus();
    await resolveCoreEndpoint();
    theme.value = ((await configStore.getTheme()) as ThemePref | undefined) ?? 'system';
    applyThemeToDom(theme.value);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'system') applyThemeToDom('system');
    });
    if (!networkSubscribed) {
      networkSubscribed = true;
      ports.network.onChange((v) => {
        if (online.value === v) return;
        online.value = v;
        // A desktop runtime may move from remote fallback back to its local
        // core (or vice versa) as reachability changes.
        void resolveCoreEndpoint().then(refreshServiceInfo);
      });
    }
    ready.value = true;
    refreshServiceInfo();
  }

  /** Best-effort version probes for the settings page (offline → undefined). */
  function refreshServiceInfo(): void {
    void coreClient.value
      .info()
      .then((i) => {
        coreInfo.value = i;
      })
      .catch(() => {
        coreInfo.value = undefined;
      });
    void serverClient.value
      .info()
      .then((i) => {
        serverInfo.value = i;
      })
      .catch(() => {
        serverInfo.value = undefined;
      });
  }

  /** Keys whose change means the app must talk to a different service. */
  const ENDPOINT_KEYS: (keyof ClientConfig)[] = [
    'coreBaseUrl',
    'serverBaseUrl',
    'coreRepoUrl',
    'bankRepoUrl',
  ];

  async function updateConfig(partial: Partial<ClientConfig>): Promise<void> {
    const overrides = await runStorageMutation(storage, async () => {
      await configStore.setConfig(partial);
      return configStore.getOverrides();
    });
    config.value = mergeConfig({ ...envConfigDefaults(), ...overrides });

    // Only an endpoint change justifies re-resolving and re-probing. Doing it
    // for a preference blanked serverInfo, which the AI settings section is
    // derived from — so changing the AI language made that whole section
    // disappear and come back, and the change looked like it had not stuck.
    if (!ENDPOINT_KEYS.some((k) => k in partial)) return;

    setCurrentCoreUrl(config.value.coreBaseUrl);
    await resolveCoreEndpoint();
    coreInfo.value = undefined;
    serverInfo.value = undefined;
    refreshServiceInfo();
  }

  async function setTheme(pref: ThemePref): Promise<void> {
    await runStorageMutation(storage, () => configStore.setTheme(pref));
    theme.value = pref;
    applyThemeToDom(pref);
  }

  /** Resolve figure src (bank-root-relative) against the core endpoint. */
  function assetUrl(src: string): string {
    return coreClient.value.assetUrl(src);
  }

  return {
    config,
    theme,
    online,
    coreInfo,
    serverInfo,
    coreEndpointUrl,
    coreEndpointSource,
    coreRuntimeStatus,
    ready,
    coreClient,
    serverClient,
    init,
    updateConfig,
    setTheme,
    assetUrl,
    setTokenProvider,
    resolveCoreEndpoint,
    refreshServiceInfo,
  };
});
