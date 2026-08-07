import 'fake-indexeddb/auto';
import { createApp, nextTick, type Component } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPorts, ShellPort, UpdateSnapshot } from '@qed2/core-logic';
import DesktopSettings from '../src/routes/settings/DesktopSettings.vue';
import { ports } from '../src/services.js';

const originalUpdate = ports.update;
const originalShell = ports.shell;

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
    ports.update = originalUpdate;
    ports.shell = originalShell;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders no desktop UI or placeholder in a normal Web/PWA session', async () => {
    const mounted = await mountDynamic(DesktopSettings, '/settings?section=desktop');

    expect(mounted.host.querySelector('#desktop')).toBeNull();
    expect(mounted.host.textContent?.trim()).toBe('');
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
      capabilities: { selfUpdate: true },
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
    expect(mounted.host.textContent).toContain('5.0 MB / 10.0 MB');

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
      capabilities: { selfUpdate: true },
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
    expect(mounted.host.textContent).toContain('macOS- und Windows-Pakete sind signiert');
    expect(mounted.host.textContent).toContain('Metadaten und Prüfsummen');
    expect(mounted.host.textContent).not.toContain('App-Downloads sind signiert');
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
    expect(mounted.host.querySelector('h2')?.textContent).toContain('Lokale Laufzeit');
    expect(mounted.host.textContent).toContain('Lokale Laufzeit');
    expect(mounted.host.textContent).not.toContain('Nach Updates suchen');
    expect(getState).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(mounted.host.querySelector('h1'));
    expect(mounted.host.querySelector('[data-desktop-window-target]')).toBeNull();
    mounted.unmount();
  });
});
