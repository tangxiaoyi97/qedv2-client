/**
 * App store: runtime service endpoints, immutable release provenance, theme,
 * connectivity and API clients. Repository fields survive for old profiles,
 * but stable shells never execute or update from them.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  CoreClient,
  ServerClient,
  AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER,
  canonicalServiceBaseUrl,
  DEFAULT_CONFIG,
  mergeConfig,
  sanitizeClientConfigOverrides,
  type ClientConfig,
  type CoreEndpoint,
  type CoreInfo,
  type CoreRuntimeStatus,
  type CoreSourcePreference,
  type ManifestResponse,
  type ServerInfo,
  STORAGE,
} from '@qed2/core-logic';
import {
  attemptOutbox,
  authStore as authStorage,
  configStore,
  envConfigDefaults,
  ports,
  setCurrentCoreUrl,
  storage,
} from '../services.js';
import { runStorageMutation } from '../platform/desktop-storage.js';
import {
  currentBuiltinThemeId,
  isBuiltinThemeId,
  setBuiltinThemeExtension,
  syncThemeColorFromCss,
  type BuiltinThemeId,
} from '../platform/theme.js';

export type ThemePref = 'light' | 'dark' | 'system';
const ACCENT_STORAGE_KEY = 'accent';

export interface PinnedCoreContent {
  baseUrl: string;
  source: CoreSourcePreference;
  mode: 'current' | 'revision';
  contentId?: string;
  /** Initial manifest snapshot used to authenticate the session load. */
  manifest?: ManifestResponse;
  /** True when that initial authentication request failed. */
  manifestUnavailable?: true;
  client: CoreClient;
}

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
  const accentTheme = ref<BuiltinThemeId>(currentBuiltinThemeId());
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
  /** Desktop lifecycle state; undefined on the web adapter. */
  const coreRuntimeStatus = shallowRef<CoreRuntimeStatus | undefined>();
  /** Per-renderer content pin. Practice windows keep this when another window switches source. */
  const pinnedCoreContent = shallowRef<PinnedCoreContent | undefined>();

  /** Token is injected by the auth store so ServerClient stays fresh. */
  let tokenProvider: () => string | undefined = () => undefined;
  let endpointResolutionTail: Promise<void> = Promise.resolve();
  let runtimeStatusSubscribed = false;
  let networkSubscribed = false;
  let storageSubscribed = false;
  let externalSettingsTail: Promise<void> = Promise.resolve();
  let beforeServerEndpointChange: (nextServerBaseUrl: string) => Promise<void> = async () => {};
  let coreInfoRequestGeneration = 0;
  let serverInfoRequestGeneration = 0;

  /**
   * 2.1 accepted arbitrary http(s) strings. Never let one of those legacy
   * values reach a client constructor during 2.2 boot: repair it first, and
   * invalidate an unscoped bearer when the Server address itself was unsafe.
   */
  async function readSafeConfig(): Promise<{
    value: ClientConfig;
    unsafeServer: boolean;
  }> {
    const rawOverrides: unknown = await configStore.getOverrides();
    const sanitized = sanitizeClientConfigOverrides(rawOverrides);
    const overrides = sanitized.value;
    const merged = mergeConfig({ ...envConfigDefaults(), ...overrides });
    const repairs: Partial<ClientConfig> = {};
    let unsafeServer = sanitized.invalidFields.includes('(root)')
      || sanitized.invalidFields.includes('serverBaseUrl');
    const safeFallback = (field: 'coreBaseUrl' | 'serverBaseUrl'): string => {
      const configured = mergeConfig(envConfigDefaults())[field];
      try {
        return canonicalServiceBaseUrl(configured);
      } catch {
        return canonicalServiceBaseUrl(DEFAULT_CONFIG[field]);
      }
    };
    for (const field of ['coreBaseUrl', 'serverBaseUrl'] as const) {
      try {
        const canonical = canonicalServiceBaseUrl(merged[field]);
        if (canonical !== merged[field]) repairs[field] = canonical;
      } catch {
        repairs[field] = safeFallback(field);
        if (field === 'serverBaseUrl') unsafeServer = true;
      }
    }
    if (unsafeServer) {
      // A 2.1 bearer has no issuer, so an invalid/custom legacy address gives
      // us no safe origin to which it can be sent. Signing out preserves all
      // local profiles while requiring an explicit login to the repaired URL.
      await runStorageMutation(storage, () => authStorage.clearSession());
    }
    if (sanitized.invalidFields.length > 0 || Object.keys(repairs).length > 0) {
      // Replace, rather than merge into, a malformed document. Otherwise an
      // array/non-string field would survive every boot and retrigger repair.
      await runStorageMutation(storage, () => storage.set(
        STORAGE.config,
        'overrides',
        { ...overrides, ...repairs },
      ));
    }
    return {
      value: mergeConfig({ ...envConfigDefaults(), ...overrides, ...repairs }),
      unsafeServer,
    };
  }

  const coreClient = computed(
    () => new CoreClient(coreEndpointUrl.value || config.value.coreBaseUrl),
  );
  const coreSourcePreference = computed<CoreSourcePreference>(
    () => coreRuntimeStatus.value?.preferredSource ?? coreEndpointSource.value,
  );
  const serverClient = computed(() => new ServerClient(config.value.serverBaseUrl, () => tokenProvider()));

  function applyCoreEndpoint(endpoint: CoreEndpoint): void {
    if (
      endpoint.baseUrl !== coreEndpointUrl.value ||
      endpoint.source !== coreEndpointSource.value
    ) {
      // Invalidate an in-flight probe before publishing the new source. A
      // slow Local response must never overwrite fresher Remote metadata (or
      // vice versa) while Desktop is failing over between the two.
      coreInfoRequestGeneration += 1;
      coreInfo.value = undefined;
    }
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

  async function selectCoreSource(source: CoreSourcePreference): Promise<void> {
    if (!ports.coreRuntime.selectSource) return;
    try {
      const endpoint = await ports.coreRuntime.selectSource(source);
      applyCoreEndpoint(endpoint);
    } finally {
      // A failed Local selection may have deliberately entered a visible
      // preferred-local/remote-fallback state. Always read that canonical
      // status instead of leaving the controls on their previous snapshot.
      await readCoreRuntimeStatus();
      coreInfo.value = undefined;
      refreshServiceInfo();
    }
  }

  /**
   * Resolve a source-specific gateway and hold it for this renderer. The main
   * Browse window may change the device preference later; a running Practice
   * window continues to read JSON and assets from the exact same source.
   */
  async function pinCoreContent(
    source: CoreSourcePreference = coreEndpointSource.value,
    knownContentId?: string,
  ): Promise<PinnedCoreContent> {
    const endpoint = await ports.coreRuntime.getEndpoint(source);
    const client = new CoreClient(endpoint.baseUrl);
    let contentId = endpoint.contentId ?? knownContentId;
    let manifest: ManifestResponse | undefined;
    let manifestUnavailable = false;
    let mode: PinnedCoreContent['mode'] = 'current';
    let currentManifest: ManifestResponse | undefined;
    let currentManifestCause: unknown;
    try {
      currentManifest = await client.manifest();
    } catch (cause) {
      currentManifestCause = cause;
    }

    if (knownContentId && currentManifest?.commit !== knownContentId) {
      try {
        manifest = await client.revisionManifest(knownContentId);
        if (manifest.commit !== knownContentId) {
          throw new Error('Der Core hat die falsche historische Aufgabenbank geliefert.');
        }
        contentId = knownContentId;
        mode = 'revision';
      } catch (cause) {
        const currentIsProvenLocally =
          endpoint.source === 'local' && endpoint.contentId === knownContentId && !currentManifest;
        if (!currentIsProvenLocally) {
          throw new Error(
            'Die ursprüngliche Version dieser Aufgaben ist nicht verfügbar. Es wird nicht auf eine neuere Bank gewechselt.',
            { cause },
          );
        }
        contentId = knownContentId;
        manifestUnavailable = true;
      }
    } else if (currentManifest) {
      manifest = currentManifest;
      contentId = currentManifest.commit;
    } else {
      manifestUnavailable = true;
      if (knownContentId && endpoint.source === 'remote') {
        throw new Error(
          'Die Version der Remote-Aufgabenbank konnte nicht bestätigt werden. Bitte stelle die Verbindung wieder her.',
          { cause: currentManifestCause },
        );
      }
    }
    const pin: PinnedCoreContent = {
      baseUrl: endpoint.baseUrl,
      source: endpoint.source,
      mode,
      ...(contentId ? { contentId } : {}),
      ...(manifest ? { manifest } : {}),
      ...(manifestUnavailable ? { manifestUnavailable: true as const } : {}),
      client,
    };
    pinnedCoreContent.value = pin;
    return pin;
  }

  function releaseCoreContentPin(): void {
    pinnedCoreContent.value = undefined;
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
    const reloadAccent = key === undefined || key === ACCENT_STORAGE_KEY;
    if (reloadConfig) {
      const previous = config.value;
      const { value: next } = await readSafeConfig();
      if (previous.serverBaseUrl !== next.serverBaseUrl) {
        await beforeServerEndpointChange(next.serverBaseUrl);
      }
      config.value = next;
      attemptOutbox.configureLegacyAccountOwner(() => AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER);
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
    if (reloadAccent) {
      const stored = await storage.get<string>(STORAGE.config, ACCENT_STORAGE_KEY);
      const next = isBuiltinThemeId(stored) ? stored : 'weed';
      accentTheme.value = next;
      setBuiltinThemeExtension(next);
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
    config.value = (await readSafeConfig()).value;
    attemptOutbox.configureLegacyAccountOwner(() => AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER);
    setCurrentCoreUrl(config.value.coreBaseUrl);
    subscribeCoreRuntimeStatus();
    // Snapshot first, then configure: configure() is the authoritative endpoint
    // result, while the early subscription still captures progress emitted by it.
    await readCoreRuntimeStatus();
    await resolveCoreEndpoint();
    theme.value = ((await configStore.getTheme()) as ThemePref | undefined) ?? 'system';
    applyThemeToDom(theme.value);
    const storedAccent = await storage.get<string>(STORAGE.config, ACCENT_STORAGE_KEY);
    accentTheme.value = isBuiltinThemeId(storedAccent) ? storedAccent : currentBuiltinThemeId();
    setBuiltinThemeExtension(accentTheme.value);
    if (ports.shell.capabilities.desktop && storedAccent !== accentTheme.value) {
      await storage.set(STORAGE.config, ACCENT_STORAGE_KEY, accentTheme.value);
    }
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
    const coreGeneration = ++coreInfoRequestGeneration;
    const coreEndpoint = coreEndpointUrl.value || config.value.coreBaseUrl;
    const coreSource = coreEndpointSource.value;
    const requestedCore = coreClient.value;
    const serverGeneration = ++serverInfoRequestGeneration;
    const serverEndpoint = config.value.serverBaseUrl;
    const requestedServer = serverClient.value;

    const coreRequestIsCurrent = (): boolean =>
      coreGeneration === coreInfoRequestGeneration &&
      coreEndpoint === (coreEndpointUrl.value || config.value.coreBaseUrl) &&
      coreSource === coreEndpointSource.value;
    const serverRequestIsCurrent = (): boolean =>
      serverGeneration === serverInfoRequestGeneration &&
      serverEndpoint === config.value.serverBaseUrl;

    void requestedCore
      .info()
      .then((i) => {
        if (!coreRequestIsCurrent()) return;
        coreInfo.value = i;
      })
      .catch(() => {
        if (!coreRequestIsCurrent()) return;
        coreInfo.value = undefined;
      });
    void requestedServer
      .info()
      .then((i) => {
        if (!serverRequestIsCurrent()) return;
        serverInfo.value = i;
      })
      .catch(() => {
        if (!serverRequestIsCurrent()) return;
        serverInfo.value = undefined;
      });
  }

  /** Keys whose change means the app must talk to a different service. */
  const ENDPOINT_KEYS: (keyof ClientConfig)[] = [
    'coreBaseUrl',
    'serverBaseUrl',
  ];

  async function updateConfig(partial: Partial<ClientConfig>): Promise<void> {
    const safePartial = { ...partial };
    if (safePartial.coreBaseUrl !== undefined) {
      safePartial.coreBaseUrl = canonicalServiceBaseUrl(safePartial.coreBaseUrl);
    }
    if (safePartial.serverBaseUrl !== undefined) {
      safePartial.serverBaseUrl = canonicalServiceBaseUrl(safePartial.serverBaseUrl);
    }
    if (
      safePartial.serverBaseUrl !== undefined
      && safePartial.serverBaseUrl !== config.value.serverBaseUrl
    ) {
      // Auth installs this guard during store setup. It synchronously removes
      // the old bearer from the token provider, then durably signs out before
      // a different origin becomes observable through serverClient.
      await beforeServerEndpointChange(safePartial.serverBaseUrl);
    }
    const overrides = await runStorageMutation(storage, async () => {
      await configStore.setConfig(safePartial);
      return configStore.getOverrides();
    });
    config.value = mergeConfig({ ...envConfigDefaults(), ...overrides });
    attemptOutbox.configureLegacyAccountOwner(() => AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER);

    // Only an endpoint change justifies re-resolving and re-probing. Doing it
    // for a preference blanked serverInfo, which the AI settings section is
    // derived from — so changing the AI language made that whole section
    // disappear and come back, and the change looked like it had not stuck.
    if (!ENDPOINT_KEYS.some((k) => k in safePartial)) return;

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

  function setServerEndpointChangeGuard(
    guard: (nextServerBaseUrl: string) => Promise<void>,
  ): void {
    beforeServerEndpointChange = guard;
  }

  async function setAccentTheme(id: BuiltinThemeId): Promise<void> {
    // Commit first. If disk/IPC fails, this window keeps the last durable
    // theme instead of diverging from other windows and the native icon.
    await runStorageMutation(storage, () =>
      storage.set(STORAGE.config, ACCENT_STORAGE_KEY, id),
    );
    accentTheme.value = id;
    setBuiltinThemeExtension(id);
  }

  /** Resolve figure src (bank-root-relative) against the core endpoint. */
  function assetUrl(src: string): string {
    return (pinnedCoreContent.value?.client ?? coreClient.value).assetUrl(src);
  }

  return {
    config,
    theme,
    accentTheme,
    online,
    coreInfo,
    serverInfo,
    coreEndpointUrl,
    coreEndpointSource,
    coreSourcePreference,
    coreRuntimeStatus,
    pinnedCoreContent,
    ready,
    coreClient,
    serverClient,
    init,
    updateConfig,
    setTheme,
    setAccentTheme,
    assetUrl,
    setTokenProvider,
    setServerEndpointChangeGuard,
    selectCoreSource,
    pinCoreContent,
    releaseCoreContentPin,
    resolveCoreEndpoint,
    refreshServiceInfo,
  };
});
