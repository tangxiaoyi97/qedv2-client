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
} from '@qed2/core-logic';
import { configStore, envConfigDefaults, ports, setCurrentCoreUrl } from '../services.js';

export type ThemePref = 'light' | 'dark' | 'system';

function applyThemeToDom(pref: ThemePref): void {
  const dark =
    pref === 'dark' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export const useAppStore = defineStore('app', () => {
  const config = ref<ClientConfig>(mergeConfig(envConfigDefaults()));
  const theme = ref<ThemePref>('system');
  const online = ref(ports.network.isOnline());
  const coreInfo = shallowRef<CoreInfo | undefined>();
  const ready = ref(false);

  /** Token is injected by the auth store so ServerClient stays fresh. */
  let tokenProvider: () => string | undefined = () => undefined;

  const coreClient = computed(() => new CoreClient(config.value.coreBaseUrl));
  const serverClient = computed(() => new ServerClient(config.value.serverBaseUrl, () => tokenProvider()));

  function setTokenProvider(fn: () => string | undefined): void {
    tokenProvider = fn;
  }

  async function init(): Promise<void> {
    const overrides = await configStore.getOverrides();
    config.value = mergeConfig({ ...envConfigDefaults(), ...overrides });
    setCurrentCoreUrl(config.value.coreBaseUrl);
    theme.value = ((await configStore.getTheme()) as ThemePref | undefined) ?? 'system';
    applyThemeToDom(theme.value);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'system') applyThemeToDom('system');
    });
    ports.network.onChange((v) => {
      online.value = v;
    });
    ready.value = true;
    void coreClient.value
      .info()
      .then((i) => {
        coreInfo.value = i;
      })
      .catch(() => undefined);
  }

  async function updateConfig(partial: Partial<ClientConfig>): Promise<void> {
    await configStore.setConfig(partial);
    const overrides = await configStore.getOverrides();
    config.value = mergeConfig({ ...envConfigDefaults(), ...overrides });
    setCurrentCoreUrl(config.value.coreBaseUrl);
    coreInfo.value = undefined;
    void coreClient.value
      .info()
      .then((i) => {
        coreInfo.value = i;
      })
      .catch(() => undefined);
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
    ready,
    coreClient,
    serverClient,
    init,
    updateConfig,
    setTheme,
    assetUrl,
    setTokenProvider,
  };
});
