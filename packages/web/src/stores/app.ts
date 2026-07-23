/**
 * App store: runtime config (three configurable upstream addresses), theme,
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
  type CoreInfo,
  type ServerInfo,
} from '@qed2/core-logic';
import { configStore, envConfigDefaults, ports, setCurrentCoreUrl } from '../services.js';
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

  /** Token is injected by the auth store so ServerClient stays fresh. */
  let tokenProvider: () => string | undefined = () => undefined;

  const coreClient = computed(
    () => new CoreClient(coreEndpointUrl.value || config.value.coreBaseUrl),
  );
  const serverClient = computed(() => new ServerClient(config.value.serverBaseUrl, () => tokenProvider()));

  async function resolveCoreEndpoint(): Promise<void> {
    try {
      const ep = await ports.coreRuntime.getEndpoint();
      coreEndpointUrl.value = ep.baseUrl;
    } catch {
      coreEndpointUrl.value = config.value.coreBaseUrl; // port failed → remote
    }
  }

  function setTokenProvider(fn: () => string | undefined): void {
    tokenProvider = fn;
  }

  async function init(): Promise<void> {
    const overrides = await configStore.getOverrides();
    config.value = mergeConfig({ ...envConfigDefaults(), ...overrides });
    setCurrentCoreUrl(config.value.coreBaseUrl);
    await resolveCoreEndpoint();
    theme.value = ((await configStore.getTheme()) as ThemePref | undefined) ?? 'system';
    applyThemeToDom(theme.value);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'system') applyThemeToDom('system');
    });
    ports.network.onChange((v) => {
      online.value = v;
    });
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

  async function updateConfig(partial: Partial<ClientConfig>): Promise<void> {
    await configStore.setConfig(partial);
    const overrides = await configStore.getOverrides();
    config.value = mergeConfig({ ...envConfigDefaults(), ...overrides });
    setCurrentCoreUrl(config.value.coreBaseUrl);
    await resolveCoreEndpoint();
    coreInfo.value = undefined;
    serverInfo.value = undefined;
    refreshServiceInfo();
  }

  async function setTheme(pref: ThemePref): Promise<void> {
    theme.value = pref;
    applyThemeToDom(pref);
    await configStore.setTheme(pref);
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
    ready,
    coreClient,
    serverClient,
    init,
    updateConfig,
    setTheme,
    assetUrl,
    setTokenProvider,
    refreshServiceInfo,
  };
});
