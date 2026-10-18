import 'fake-indexeddb/auto';
import { createApp, nextTick, type Component } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopStorageOverview, PlatformPorts, ShellPort, UpdateSnapshot } from '@qed2/core-logic';
import DesktopSettings from '../src/routes/settings/DesktopSettings.vue';
import desktopSettingsSource from '../src/routes/settings/DesktopSettings.vue?raw';
import { ports } from '../src/services.js';
import { setUiLocale } from '@qed2/ui';
import { useAppStore } from '../src/stores/app.js';

const originalUpdate = ports.update;
const originalShell = ports.shell;
const originalCoreRuntime = ports.coreRuntime;

interface Mounted {
  host: HTMLElement;
  unmount(): void;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountDynamic(
  component: Component,
  path: string,
): Promise<Mounted> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/settings', component }],
  });
  await router.push(path);
  await router.isReady();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(component);
  app.use(createPinia());
  app.use(router);
  app.mount(host);
  await settle();
  return { host, unmount: () => app.unmount() };
}

function useDesktopPorts(
  update: PlatformPorts['update'],
  openDesktopWindow?: ShellPort['openDesktopWindow'],
): void {
  ports.update = update;
  ports.shell = {
    capabilities: { desktop: true, nativeMenu: true, nativeTitleBar: true },
    onCommand: () => () => undefined,
    ...(openDesktopWindow ? { openDesktopWindow } : {}),
  };
}

describe('capability-gated desktop settings', () => {
  afterEach(() => {
    setUiLocale('de');
    ports.update = originalUpdate;
    ports.shell = originalShell;
    ports.coreRuntime = originalCoreRuntime;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders no desktop UI or placeholder in a normal Web/PWA session', async () => {
    const mounted = await mountDynamic(DesktopSettings, '/settings?section=desktop');

    expect(mounted.host.querySelector('#desktop')).toBeNull();
    expect(mounted.host.textContent?.trim()).toBe('');
    mounted.unmount();
  });

  it('lets the variable runtime facts fill the available width', () => {
    expect(desktopSettingsSource).toMatch(
      /\.desktop-settings__facts\s*{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(130px, 1fr\)\);/s,
    );
  });

  it('shows offline readiness, locks a pending source change and preserves the selected source on failure', async () => {
    useDesktopPorts({
      capabilities: { selfUpdate: false },
      getAppVersion: () => '2.3.2',
    });
    ports.coreRuntime = { ...originalCoreRuntime, selectSource: vi.fn() };
    const mounted = await mountDynamic(DesktopSettings, '/settings?section=desktop');
    const app = useAppStore();
    app.coreEndpointSource = 'local';
    app.coreRuntimeStatus = {
      phase: 'ready', source: 'local', preferredSource: 'local', endpoint: 'http://127.0.0.1:1022',
    };
    vi.spyOn(app, 'refreshServiceInfo').mockImplementation(() => undefined);
    let reject!: (reason: Error) => void;
    const select = vi.spyOn(app, 'selectCoreSource').mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    await nextTick();

    const local = mounted.host.querySelector<HTMLButtonElement>('[data-source="local"]')!;
    const remote = mounted.host.querySelector<HTMLButtonElement>('[data-source="remote"]')!;
    expect(mounted.host.textContent).toContain('Offline bereit');
    expect(local.getAttribute('aria-pressed')).toBe('true');
    expect(mounted.host.querySelector('.desktop-settings__facts')).toBeNull();
    local.click();
    expect(select).not.toHaveBeenCalled();
    remote.click();
    await nextTick();
    expect(local.disabled).toBe(true);
    expect(remote.disabled).toBe(true);
    expect(select).toHaveBeenCalledWith('remote');
    reject(new Error('unavailable'));
    await settle();
    expect(local.disabled).toBe(false);
    expect(local.getAttribute('aria-pressed')).toBe('true');
    expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain('Remote-Core konnte nicht ausgewählt');

    setUiLocale('en');
    await nextTick();
    expect(local.textContent).toContain('Local');
    expect(mounted.host.textContent).toContain('Ready offline');
    expect(mounted.host.textContent).toContain('Runtime details');
    mounted.unmount();
  });

  it('lets a preferred-local fallback retry Local directly', async () => {
    useDesktopPorts({ capabilities: { selfUpdate: false }, getAppVersion: () => '2.3.2' });
    ports.coreRuntime = { ...originalCoreRuntime, selectSource: vi.fn() };
    const mounted = await mountDynamic(DesktopSettings, '/settings?section=desktop');
    const app = useAppStore();
    app.coreEndpointSource = 'remote';
    app.coreRuntimeStatus = {
      phase: 'degraded', source: 'remote', preferredSource: 'local', endpoint: 'https://example.test',
    };
    const select = vi.spyOn(app, 'selectCoreSource').mockResolvedValue(undefined);
    vi.spyOn(app, 'refreshServiceInfo').mockImplementation(() => undefined);
    await nextTick();
    expect(mounted.host.textContent).toContain('Remote-Ersatz');
    mounted.host.querySelector<HTMLButtonElement>('[data-source="local"]')!.click();
    await settle();
    expect(select).toHaveBeenCalledWith('local');
    mounted.unmount();
  });

  it('subscribes to state, downloads the explicit app target, shows progress/error and relaunches', async () => {
    const initial: UpdateSnapshot = {
      busy: false,
      targets: [
        { target: 'app', phase: 'available', currentVersion: '2.0.0', latestVersion: '2.1.0' },
        { target: 'core', phase: 'complete', currentVersion: 'abc123' },
        { target: 'bank', phase: 'complete', currentVersion: 'def456' },
      ],
    };
    let emit!: (snapshot: UpdateSnapshot) => void;
    const unsubscribe = vi.fn();
    const getState = vi.fn(async () => initial);
    const applyUpdates = vi.fn(async () => undefined);
    const relaunchToApply = vi.fn(async () => undefined);
    useDesktopPorts({
      capabilities: { selfUpdate: true, manualAppInstall: true },
      getAppVersion: () => '2.0.0',
      checkForUpdates: vi.fn(async () => []),
      getState,
      onChange: (callback) => {
        emit = callback;
        return unsubscribe;
      },
      applyUpdates,
      relaunchToApply,
    });
    const mounted = await mountDynamic(
      DesktopSettings,
      '/settings?section=desktop&desktopWindow=updates',
    );

    expect(getState).toHaveBeenCalledTimes(1);
    expect(mounted.host.querySelector('h1')?.textContent).toContain('Aktualisierungen');
    expect(mounted.host.querySelector('h2')?.textContent).toContain('Komponenten');
    expect(mounted.host.textContent).not.toContain('Lokale Laufzeit');

    const download = [...mounted.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('QED2 Desktop herunterladen'),
    ) as HTMLButtonElement;
    download.click();
    await settle();
    expect(applyUpdates).toHaveBeenCalledWith(['app']);

    emit({
      busy: true,
      targets: [
        {
          target: 'app',
          phase: 'downloading',
          currentVersion: '2.0.0',
          latestVersion: '2.1.0',
          progress: { completed: 5 * 1024 * 1024, total: 10 * 1024 * 1024, unit: 'bytes' },
        },
      ],
    });
    await nextTick();
    expect(mounted.host.querySelector('progress')?.getAttribute('value')).toBe(String(5 * 1024 * 1024));
    expect(mounted.host.textContent).toContain('5,0 MB / 10,0 MB');

    emit({
      busy: true,
      targets: [
        {
          target: 'app',
          phase: 'verifying',
          currentVersion: '2.0.0',
          latestVersion: '2.1.0',
        },
      ],
    });
    await nextTick();
    expect(mounted.host.textContent).toContain('Paket und Prüfsumme werden geprüft');
    expect(mounted.host.textContent).not.toContain('Signatur wird geprüft');

    emit({
      busy: false,
      targets: [
        {
          target: 'app',
          phase: 'error',
          currentVersion: '2.0.0',
          latestVersion: '2.1.0',
          error: { code: 'APP_UPDATE_DOWNLOAD_FAILED', message: 'Verbindung unterbrochen', retryable: true },
        },
      ],
    });
    await nextTick();
    expect(mounted.host.textContent).toContain('Verbindung unterbrochen');
    const retry = [...mounted.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('erneut herunterladen'),
    ) as HTMLButtonElement;
    retry.click();
    await settle();
    expect(applyUpdates).toHaveBeenCalledTimes(2);

    emit({
      busy: false,
      targets: [
        {
          target: 'app',
          phase: 'restart-required',
          currentVersion: '2.0.0',
          latestVersion: '2.1.0',
        },
      ],
    });
    await nextTick();
    const relaunch = [...mounted.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Neu starten & installieren'),
    ) as HTMLButtonElement;
    relaunch.click();
    await settle();
    expect(relaunchToApply).toHaveBeenCalledTimes(1);

    mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('never reports all components current when a Core or bank check is incomplete', async () => {
    const incomplete: UpdateSnapshot = {
      busy: false,
      targets: [
        { target: 'app', phase: 'complete', currentVersion: '2.0.0', latestVersion: '2.0.0' },
        {
          target: 'core',
          phase: 'error',
          currentVersion: 'abc123',
          error: { code: 'UPDATE_CHECK_FAILED', message: 'Repository nicht erreichbar', retryable: true },
        },
        { target: 'bank', phase: 'complete', currentVersion: 'def456', latestVersion: 'def456' },
      ],
    };
    const checkForUpdates = vi.fn(async () => [
      { target: 'app' as const, currentVersion: '2.0.0', latestVersion: '2.0.0', updateAvailable: false },
      { target: 'core' as const, currentVersion: 'abc123', updateAvailable: false },
      { target: 'bank' as const, currentVersion: 'def456', latestVersion: 'def456', updateAvailable: false },
    ]);
    useDesktopPorts({
      capabilities: { selfUpdate: true, manualAppInstall: true },
      getAppVersion: () => '2.0.0',
      checkForUpdates,
      getState: vi.fn(async () => incomplete),
    });
    const mounted = await mountDynamic(
      DesktopSettings,
      '/settings?section=desktop&desktopWindow=updates',
    );

    const check = [...mounted.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Nach Updates suchen'),
    ) as HTMLButtonElement;
    check.click();
    await settle();

    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mounted.host.textContent).toContain('Nicht alle Komponenten konnten geprüft werden');
    expect(mounted.host.textContent).not.toContain('Alle Komponenten sind aktuell');
    expect(mounted.host.textContent).toContain('Unsigniert');
    expect(mounted.host.textContent).toContain('manuelle Installation');
    expect(mounted.host.textContent).toContain('Core & Bank enthalten');
    expect(mounted.host.textContent).not.toContain('Apple-/Windows-Entwicklerzertifikat');
    expect(mounted.host.textContent).not.toContain('Metadaten und Prüfsummen');
    expect(mounted.host.textContent).not.toContain('Pakete sind signiert');
    mounted.unmount();
  });

  it('labels a verified Linux manager package truthfully and keeps QED2 open', async () => {
    const message = 'Das verifizierte Linux-Paket wurde im Dateimanager markiert.';
    const manual: UpdateSnapshot = {
      busy: false,
      targets: [{
        target: 'app',
        phase: 'restart-required',
        currentVersion: '2.0.0',
        latestVersion: '2.1.0',
        installMode: 'manual-package',
        message,
      }],
    };
    const relaunchToApply = vi.fn(async () => {
      throw new Error('main-process detail must not reach the UI');
    });
    useDesktopPorts({
      capabilities: { selfUpdate: true },
      getAppVersion: () => '2.0.0',
      getState: vi.fn(async () => manual),
      relaunchToApply,
    });
    const mounted = await mountDynamic(
      DesktopSettings,
      '/settings?section=desktop&desktopWindow=updates',
    );

    const reveal = [...mounted.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Paket anzeigen'),
    ) as HTMLButtonElement;
    reveal.click();
    await settle();

    expect(relaunchToApply).toHaveBeenCalledTimes(1);
    expect(mounted.host.textContent).toContain('Bereit zur Installation');
    expect(mounted.host.textContent).not.toContain('Bereit für Neustart');
    expect(mounted.host.textContent).toContain(message);
    expect(mounted.host.textContent).not.toContain('nicht neu gestartet');
    expect(mounted.host.textContent).not.toContain('main-process detail');
    mounted.unmount();
  });

  it('reports all components current only after three complete typed results and snapshots', async () => {
    const complete: UpdateSnapshot = {
      busy: false,
      targets: [
        { target: 'app', phase: 'complete', currentVersion: '2.0.0', latestVersion: '2.0.0' },
        { target: 'core', phase: 'complete', currentVersion: 'abc123', latestVersion: 'abc123' },
        { target: 'bank', phase: 'complete', currentVersion: 'def456', latestVersion: 'def456' },
      ],
    };
    useDesktopPorts({
      capabilities: { selfUpdate: true },
      getAppVersion: () => '2.0.0',
      checkForUpdates: vi.fn(async () => [
        { target: 'app' as const, currentVersion: '2.0.0', latestVersion: '2.0.0', updateAvailable: false },
        { target: 'core' as const, currentVersion: 'abc123', latestVersion: 'abc123', updateAvailable: false },
        { target: 'bank' as const, currentVersion: 'def456', latestVersion: 'def456', updateAvailable: false },
      ]),
      getState: vi.fn(async () => complete),
    });
    const mounted = await mountDynamic(DesktopSettings, '/settings?section=desktop');

    const check = [...mounted.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Nach Updates suchen'),
    ) as HTMLButtonElement;
    check.click();
    await settle();

    expect(mounted.host.textContent).toContain('Alle Komponenten sind aktuell');
    expect(mounted.host.textContent).not.toContain('Nicht alle Komponenten konnten geprüft werden');
    mounted.unmount();
  });

  it('reports an unpublished GitHub channel neutrally instead of claiming a completed release check', async () => {
    const detail = 'Noch keine öffentliche Desktop-Veröffentlichung vorhanden.';
    const unpublished: UpdateSnapshot = {
      busy: false,
      targets: [
        { target: 'app', phase: 'complete', currentVersion: '2.0.0', message: detail },
        { target: 'core', phase: 'complete', currentVersion: 'abc123', message: detail },
        { target: 'bank', phase: 'complete', currentVersion: 'def456', message: detail },
      ],
    };
    useDesktopPorts({
      capabilities: { selfUpdate: true },
      getAppVersion: () => '2.0.0',
      checkForUpdates: vi.fn(async () => [
        { target: 'app' as const, currentVersion: '2.0.0', latestVersion: '2.0.0', updateAvailable: false, detail },
        { target: 'core' as const, currentVersion: 'abc123', latestVersion: 'abc123', updateAvailable: false, detail },
        { target: 'bank' as const, currentVersion: 'def456', latestVersion: 'def456', updateAvailable: false, detail },
      ]),
      getState: vi.fn(async () => unpublished),
    });
    const mounted = await mountDynamic(DesktopSettings, '/settings?section=desktop');

    const check = [...mounted.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Nach Updates suchen'),
    ) as HTMLButtonElement;
    check.click();
    await settle();

    expect(mounted.host.textContent).toContain(detail);
    expect(mounted.host.textContent).not.toContain('Alle Komponenten sind aktuell');
    mounted.unmount();
  });

  it('keeps a check-network failure on the check action and never offers a fake download retry', async () => {
    const failedCheck: UpdateSnapshot = {
      busy: false,
      targets: [{
        target: 'app',
        phase: 'error',
        currentVersion: '2.0.0',
        latestVersion: '2.1.0',
        error: {
          code: 'APP_UPDATE_CHECK_NETWORK_FAILED',
          message: 'Der Release-Kanal ist vorübergehend nicht erreichbar.',
          retryable: true,
        },
      }],
    };
    useDesktopPorts({
      capabilities: { selfUpdate: true },
      getAppVersion: () => '2.0.0',
      checkForUpdates: vi.fn(async () => []),
      getState: vi.fn(async () => failedCheck),
      applyUpdates: vi.fn(async () => undefined),
    });
    const mounted = await mountDynamic(
      DesktopSettings,
      '/settings?section=desktop&desktopWindow=updates',
    );

    expect(mounted.host.textContent).toContain('Der Release-Kanal ist vorübergehend nicht erreichbar.');
    expect(mounted.host.textContent).not.toContain('erneut herunterladen');
    expect(mounted.host.textContent).toContain('Nach Updates suchen');
    mounted.unmount();
  });

  it('opens only the three typed native singleton targets from the embedded settings', async () => {
    const openDesktopWindow = vi.fn(async () => undefined);
    useDesktopPorts(
      {
        capabilities: { selfUpdate: true },
        getAppVersion: () => '2.0.0',
        getState: vi.fn(async () => ({ busy: false, targets: [] })),
      },
      openDesktopWindow,
    );
    const mounted = await mountDynamic(DesktopSettings, '/settings?section=desktop');

    const targets = ['practice', 'updates', 'node'] as const;
    for (const target of targets) {
      const button = mounted.host.querySelector<HTMLButtonElement>(
        `[data-desktop-window-target="${target}"]`,
      );
      expect(button).not.toBeNull();
      button?.click();
      await settle();
    }

    expect(openDesktopWindow.mock.calls).toEqual(targets.map((target) => [target]));
    mounted.unmount();
  });

  it('uses the node tool-window title and hides update actions', async () => {
    const getState = vi.fn(async (): Promise<UpdateSnapshot> => ({ busy: false, targets: [] }));
    useDesktopPorts({
      capabilities: { selfUpdate: true },
      getAppVersion: () => '2.0.0',
      getState,
    });
    const mounted = await mountDynamic(
      DesktopSettings,
      '/settings?section=desktop&desktopWindow=node',
    );

    expect(mounted.host.querySelector('h1')?.textContent).toContain('Lokaler Knoten');
    expect(mounted.host.querySelector('h2')?.textContent).toContain('Aufgabenquelle');
    expect(mounted.host.textContent).toContain('Laufzeitdetails');
    expect(mounted.host.textContent).not.toContain('Nach Updates suchen');
    expect(getState).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(mounted.host.querySelector('h1'));
    expect(mounted.host.querySelector('[data-desktop-window-target]')).toBeNull();
    mounted.unmount();
  });

  it('does not replace streamed progress with an older pending status read', async () => {
    let finishRead!: (state: UpdateSnapshot) => void;
    let emit!: (state: UpdateSnapshot) => void;
    useDesktopPorts({
      capabilities: { selfUpdate: true }, getAppVersion: () => '2.5.1',
      getState: () => new Promise((resolve) => { finishRead = resolve; }),
      onChange: (listener) => { emit = listener; return () => undefined; },
      applyUpdates: vi.fn(async () => undefined),
    });
    const mounted = await mountDynamic(DesktopSettings, '/settings?desktopWindow=updates');
    emit({ busy: true, targets: [{ target: 'app', currentVersion: '2.5.1', phase: 'downloading', progress: { completed: 60, total: 100, unit: 'percent' } }] });
    finishRead({ busy: false, targets: [{ target: 'app', currentVersion: '2.5.1', phase: 'available' }] });
    await settle();
    expect(mounted.host.querySelector('progress')?.getAttribute('value')).toBe('60');
    expect(mounted.host.textContent).toContain('Wird heruntergeladen');
    expect(mounted.host.textContent).not.toContain('QED2 Desktop herunterladen');
    mounted.unmount();
  });

  it('keeps pause available during a busy download, prevents duplicate commands and preserves progress', async () => {
    let current: UpdateSnapshot = { busy: true, targets: [{ target: 'app', currentVersion: '2.5.1', phase: 'downloading', progress: { completed: 512, total: 1024, unit: 'bytes' }, downloadControls: { canPause: true, canResume: false, canCancel: true } }] };
    let emit!: (state: UpdateSnapshot) => void;
    let finishPause!: () => void;
    const pauseDownload = vi.fn(() => new Promise<void>((resolve) => { finishPause = resolve; }));
    useDesktopPorts({ capabilities: { selfUpdate: true }, getAppVersion: () => '2.5.1', getState: async () => current,
      onChange: (listener) => { emit = listener; return () => undefined; }, pauseDownload,
      resumeDownload: vi.fn(async () => undefined), cancelDownload: vi.fn(async () => undefined) });
    const mounted = await mountDynamic(DesktopSettings, '/settings?desktopWindow=updates');
    const pause = mounted.host.querySelector<HTMLButtonElement>('[data-download-control="pause"]')!;
    expect(pause.disabled).toBe(false);
    expect(mounted.host.querySelector('progress')?.getAttribute('aria-valuetext')).toContain('50 %');
    pause.click(); pause.click(); await settle();
    expect(pauseDownload).toHaveBeenCalledTimes(1);
    expect(pause.disabled).toBe(true);
    current = { busy: false, targets: [{ ...current.targets[0]!, phase: 'paused', downloadControls: { canPause: false, canResume: true, canCancel: true } }] };
    emit(current); finishPause(); await settle();
    expect(mounted.host.textContent).toContain('Download pausiert');
    expect(mounted.host.querySelector('progress')?.getAttribute('value')).toBe('512');
    expect(mounted.host.querySelector<HTMLButtonElement>('[data-download-control="resume"]')?.disabled).toBe(false);
    expect(mounted.host.querySelector('[role="alert"]')).toBeNull();
    setUiLocale('en'); await nextTick();
    expect(mounted.host.textContent).toContain('Download paused');
    expect(mounted.host.textContent).toContain('Resume download');
    mounted.unmount();
  });

  it('allows a resumed long-running download to be paused without an older promise unlocking the new command', async () => {
    let current: UpdateSnapshot = { busy: false, targets: [{ target: 'app', currentVersion: '2.5.1', phase: 'paused', downloadControls: { canPause: false, canResume: true, canCancel: true } }] };
    let emit!: (state: UpdateSnapshot) => void;
    let finishResume!: () => void;
    let finishPause!: () => void;
    const resumeDownload = vi.fn(() => new Promise<void>((resolve) => { finishResume = resolve; }));
    const pauseDownload = vi.fn(() => new Promise<void>((resolve) => { finishPause = resolve; }));
    useDesktopPorts({ capabilities: { selfUpdate: true }, getAppVersion: () => '2.5.1', getState: async () => current,
      onChange: (listener) => { emit = listener; return () => undefined; }, resumeDownload, pauseDownload });
    const mounted = await mountDynamic(DesktopSettings, '/settings?desktopWindow=updates');
    mounted.host.querySelector<HTMLButtonElement>('[data-download-control="resume"]')!.click(); await settle();
    current = { busy: true, targets: [{ ...current.targets[0]!, phase: 'downloading', downloadControls: { canPause: true, canResume: false, canCancel: true } }] };
    emit(current); await settle();
    const pause = mounted.host.querySelector<HTMLButtonElement>('[data-download-control="pause"]')!;
    expect(pause.disabled).toBe(false); pause.click(); await settle();
    finishResume(); await settle();
    expect(pause.disabled).toBe(true);
    expect(pauseDownload).toHaveBeenCalledTimes(1);
    current = { busy: false, targets: [{ ...current.targets[0]!, phase: 'paused', downloadControls: { canPause: false, canResume: true, canCancel: true } }] };
    emit(current); finishPause(); await settle();
    expect(mounted.host.querySelector<HTMLButtonElement>('[data-download-control="resume"]')?.disabled).toBe(false);
    mounted.unmount();
  });

  it('requires an explicit discard confirmation and restores keyboard focus on Escape', async () => {
    let current: UpdateSnapshot = { busy: false, targets: [{ target: 'app', currentVersion: '2.5.1', phase: 'paused', downloadControls: { canPause: false, canResume: true, canCancel: true } }] };
    const cancelDownload = vi.fn(async () => { current = { busy: false, targets: [{ target: 'app', currentVersion: '2.5.1', phase: 'available' }] }; });
    useDesktopPorts({ capabilities: { selfUpdate: true }, getAppVersion: () => '2.5.1', getState: async () => current, cancelDownload });
    const mounted = await mountDynamic(DesktopSettings, '/settings?desktopWindow=updates');
    mounted.host.querySelector<HTMLButtonElement>('[data-download-control="cancel"]')!.click(); await settle();
    expect(cancelDownload).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('discard-download-title');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
    expect(document.activeElement).toBe(mounted.host.querySelector('[data-download-control="cancel"]'));
    mounted.host.querySelector<HTMLButtonElement>('[data-download-control="cancel"]')!.click(); await settle();
    mounted.host.querySelector<HTMLButtonElement>('[data-download-control="confirm-cancel"]')!.click(); await settle();
    expect(cancelDownload).toHaveBeenCalledTimes(1);
    expect(mounted.host.textContent).toContain('Download verworfen.');
    mounted.unmount();
  });

  it('keeps malformed or unknown progress indeterminate without NaN labels', async () => {
    useDesktopPorts({ capabilities: { selfUpdate: true }, getAppVersion: () => '2.5.1', getState: async () => ({ busy: true, targets: [{ target: 'app', currentVersion: '2.5.1', phase: 'downloading', progress: { completed: NaN, total: Infinity, unit: 'bytes' } }] }) });
    const mounted = await mountDynamic(DesktopSettings, '/settings?desktopWindow=updates');
    expect(mounted.host.querySelector('progress')?.hasAttribute('value')).toBe(false);
    expect(mounted.host.textContent).toContain('0 B geladen');
    expect(mounted.host.textContent).not.toMatch(/NaN|Infinity/);
    expect(mounted.host.querySelector('[data-download-control]')).toBeNull();
    mounted.unmount();
  });

  it('shows device and storage facts, confirms only selected safe categories and preserves keyboard recovery', async () => {
    setUiLocale('en');
    const overview: DesktopStorageOverview = { measuredAt: '2026-10-10T00:00:00Z', disk: { totalBytes: 1024 ** 4, availableBytes: 8 * 1024 ** 3 }, categories: [
      { id: 'database', bytes: 1024 ** 2, cleanableBytes: 0 },
      { id: 'cache', bytes: 2 * 1024 ** 2, cleanableBytes: 1024 ** 2 },
      { id: 'downloads', bytes: 5 * 1024 ** 2, cleanableBytes: 0, blockedReason: 'download-active' },
      { id: 'logs', bytes: null, cleanableBytes: null, blockedReason: 'unavailable' },
    ] };
    let finishCleanup!: (result: Awaited<ReturnType<NonNullable<ShellPort['desktopStorage']>['cleanup']>>) => void;
    const cleanup = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<ShellPort['desktopStorage']>['cleanup']>>>((resolve) => { finishCleanup = resolve; }));
    useDesktopPorts({ capabilities: { selfUpdate: false }, getAppVersion: () => '2.5.1' });
    ports.shell.desktopStorage = { getOverview: vi.fn(async () => overview), cleanup };
    ports.shell.getDesktopSupport = vi.fn(async () => ({ platform: 'darwin' as const, arch: 'arm64', localCoreSupported: true }));
    const mounted = await mountDynamic(DesktopSettings, '/settings?desktopWindow=node');
    await settle();
    expect(mounted.host.querySelector('[data-desktop-storage]')?.getAttribute('data-state')).toBe('ready');
    expect(mounted.host.textContent).toContain('macOS · Apple Silicon');
    expect(mounted.host.textContent).toContain('8 GB');
    expect(mounted.host.textContent).toContain('Accounts, learning progress, backups, and active or paused downloads will be kept.');
    expect(mounted.host.querySelector('[data-storage-category="database"] input')).toBeNull();
    expect(mounted.host.querySelector<HTMLInputElement>('[data-storage-category="downloads"] input')?.disabled).toBe(true);
    expect(mounted.host.querySelector<HTMLInputElement>('[data-storage-category="logs"] input')?.disabled).toBe(true);
    mounted.host.querySelector<HTMLButtonElement>('[data-storage-cleanup]')!.click(); await settle();
    expect(cleanup).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('storage-cleanup-title');
    expect(mounted.host.textContent).toContain('Selected: Cache');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
    expect(document.activeElement).toBe(mounted.host.querySelector('[data-storage-cleanup]'));
    mounted.host.querySelector<HTMLButtonElement>('[data-storage-cleanup]')!.click(); await settle();
    const confirm = mounted.host.querySelector<HTMLButtonElement>('[data-storage-confirm]')!;
    confirm.click(); confirm.click(); await settle();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(['cache']);
    expect(confirm.disabled).toBe(true);
    expect(mounted.host.querySelector<HTMLButtonElement>('[data-storage-refresh]')?.disabled).toBe(true);
    finishCleanup({ overview: { ...overview, categories: overview.categories.map((item) => item.id === 'cache' ? { ...item, cleanableBytes: 0 } : item) }, results: [{ target: 'cache', status: 'cleaned', freedBytes: 1024 ** 2 }] }); await settle();
    expect(mounted.host.textContent).toContain('Freed 1 MB.');
    expect(mounted.host.querySelector<HTMLButtonElement>('[data-storage-cleanup]')?.disabled).toBe(true);
    expect(document.activeElement).toBe(mounted.host.querySelector('[data-storage-refresh]'));
    setUiLocale('de'); await nextTick();
    expect(mounted.host.textContent).toContain('Auf diesem Gerät');
    expect(mounted.host.textContent).toContain('1 MB freigegeben.');
    mounted.unmount();
  });

  it('reports unavailable storage without treating unknown capacity as zero and supports a bounded refresh retry', async () => {
    useDesktopPorts({ capabilities: { selfUpdate: false }, getAppVersion: () => '2.5.1' });
    const getOverview = vi.fn<NonNullable<ShellPort['desktopStorage']>['getOverview']>()
      .mockRejectedValueOnce(new Error('/private/user-profile must not reach the UI'))
      .mockResolvedValue({ measuredAt: 'invalid', disk: { totalBytes: null, availableBytes: null }, categories: [{ id: 'cache', bytes: null, cleanableBytes: null, blockedReason: 'unavailable' }] });
    ports.shell.desktopStorage = { getOverview, cleanup: vi.fn() };
    ports.shell.getDesktopSupport = vi.fn(async () => ({ platform: 'other' as const, arch: 'unknown', localCoreSupported: false }));
    ports.coreRuntime = { ...originalCoreRuntime, selectSource: vi.fn(), recover: vi.fn() };
    const mounted = await mountDynamic(DesktopSettings, '/settings?desktopWindow=node'); await settle();
    expect(mounted.host.textContent).toContain('Speicherplatz konnte nicht ermittelt');
    expect(mounted.host.textContent).not.toContain('/private/user-profile');
    expect(mounted.host.querySelector<HTMLButtonElement>('[data-source="local"]')?.disabled).toBe(true);
    expect(mounted.host.querySelector<HTMLButtonElement>('[data-source="remote"]')?.disabled).toBe(false);
    mounted.host.querySelector<HTMLButtonElement>('[data-storage-refresh]')!.click(); await settle(); await settle();
    expect(getOverview).toHaveBeenCalledTimes(2);
    expect(mounted.host.querySelector('[data-desktop-storage]')?.getAttribute('data-state')).toBe('ready');
    expect(mounted.host.textContent).toContain('Nicht verfügbar');
    expect(mounted.host.querySelector<HTMLButtonElement>('[data-storage-cleanup]')?.disabled).toBe(true);
    expect(mounted.host.textContent).not.toContain('Invalid Date');
    mounted.unmount();
  });

  it('does not read native maintenance capabilities in Web/PWA sessions or an update-only window', async () => {
    const getOverview = vi.fn(); const getDesktopSupport = vi.fn();
    ports.shell = { ...originalShell, getDesktopSupport, desktopStorage: { getOverview, cleanup: vi.fn() } };
    const web = await mountDynamic(DesktopSettings, '/settings');
    expect(web.host.textContent?.trim()).toBe(''); expect(getOverview).not.toHaveBeenCalled(); expect(getDesktopSupport).not.toHaveBeenCalled(); web.unmount();
    useDesktopPorts({ capabilities: { selfUpdate: false }, getAppVersion: () => '2.5.1' });
    ports.shell.getDesktopSupport = getDesktopSupport; ports.shell.desktopStorage = { getOverview, cleanup: vi.fn() };
    const updates = await mountDynamic(DesktopSettings, '/settings?desktopWindow=updates');
    expect(updates.host.querySelector('[data-desktop-storage]')).toBeNull(); expect(getOverview).not.toHaveBeenCalled(); expect(getDesktopSupport).not.toHaveBeenCalled(); updates.unmount();
  });


  it('releases the action after a successful manual package handoff keeps the app open', async () => {
    const relaunchToApply = vi.fn(async () => undefined);
    useDesktopPorts({ capabilities: { selfUpdate: true }, getAppVersion: () => '2.5.1',
      getState: async () => ({ busy: false, targets: [{ target: 'app', currentVersion: '2.5.1', phase: 'restart-required', installMode: 'manual-package' }] }), relaunchToApply });
    const mounted = await mountDynamic(DesktopSettings, '/settings?desktopWindow=updates');
    const reveal = [...mounted.host.querySelectorAll('button')].find((button) => button.textContent?.includes('Paket anzeigen'))!;
    reveal.click(); await settle();
    expect(relaunchToApply).toHaveBeenCalledTimes(1);
    expect(reveal.disabled).toBe(false);
    expect(reveal.textContent).toContain('Paket anzeigen');
    mounted.unmount();
  });

  it('keeps cleanup failures private and requires refreshed facts before retrying', async () => {
    const overview: DesktopStorageOverview = { measuredAt: '2026-10-10T00:00:00Z', disk: { totalBytes: 1024, availableBytes: 0 }, categories: [{ id: 'logs', bytes: 512, cleanableBytes: 256 }] };
    const cleanup = vi.fn<NonNullable<ShellPort['desktopStorage']>['cleanup']>()
      .mockRejectedValueOnce(new Error('/private/profile/logs: EACCES'))
      .mockResolvedValue({ overview, results: [{ target: 'logs', status: 'skipped', freedBytes: 0, reason: 'download-active' }] });
    useDesktopPorts({ capabilities: { selfUpdate: false }, getAppVersion: () => '2.5.1' });
    ports.shell.desktopStorage = { getOverview: async () => overview, cleanup };
    const mounted = await mountDynamic(DesktopSettings, '/settings?desktopWindow=node'); await settle();
    const open = () => mounted.host.querySelector<HTMLButtonElement>('[data-storage-cleanup]')!.click();
    open(); await settle(); mounted.host.querySelector<HTMLButtonElement>('[data-storage-confirm]')!.click(); await settle();
    expect(mounted.host.textContent).toContain('Bereinigung konnte nicht abgeschlossen');
    expect(mounted.host.textContent).not.toContain('/private/profile');
    expect(mounted.host.querySelector<HTMLButtonElement>('[data-storage-cleanup]')?.disabled).toBe(true);
    mounted.host.querySelector<HTMLButtonElement>('[data-storage-refresh]')!.click(); await settle(); await settle();
    open(); await settle(); mounted.host.querySelector<HTMLButtonElement>('[data-storage-confirm]')!.click(); await settle();
    expect(mounted.host.textContent).toContain('0 B freigegeben.');
    expect(mounted.host.textContent).toContain('Ein Download ist aktiv. Seine Dateien wurden beibehalten.');
    expect(mounted.host.textContent).not.toContain('Bereinigung konnte nicht abgeschlossen');
    mounted.unmount();
  });


  it('disables a redundant update check while a saved download is paused', async () => {
    const checkForUpdates = vi.fn(async () => []);
    useDesktopPorts({ capabilities: { selfUpdate: true }, getAppVersion: () => '2.5.1', checkForUpdates,
      getState: async () => ({ busy: false, targets: [{ target: 'app', currentVersion: '2.5.1', phase: 'paused', downloadControls: { canPause: false, canResume: true, canCancel: true } }] }),
      resumeDownload: vi.fn(async () => undefined) });
    const mounted = await mountDynamic(DesktopSettings, '/settings?desktopWindow=updates');
    const check = mounted.host.querySelector<HTMLButtonElement>('[data-update-check]')!;
    expect(check.disabled).toBe(true); check.click(); await settle();
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(mounted.host.querySelector<HTMLButtonElement>('[data-download-control="resume"]')?.disabled).toBe(false);
    expect(mounted.host.textContent).not.toContain('Nicht alle Komponenten');
    mounted.unmount();
  });

});
