import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  crashReporter,
  dialog,
  nativeImage,
  nativeTheme,
  session,
  shell,
  type Event,
  type NativeImage,
  type WebContents,
} from 'electron';
import {
  DEFAULT_CONFIG,
  type CoreSourcePreference,
  type DesktopWindowTarget,
} from '@qed2/core-logic';
import { CoreSupervisor } from './main/core-supervisor.js';
import { ElectronCoreProcessLauncher } from './main/electron-process-launcher.js';
import { installDesktopIpc } from './main/ipc.js';
import { DesktopLogger } from './main/logger.js';
import { installApplicationMenu } from './main/menu.js';
import { NetworkMonitor } from './main/network-monitor.js';
import {
  migratePreloadCodeCache,
  PreloadCodeCacheRuntimeRecovery,
  resetPreloadCodeCaches,
} from './main/preload-cache-migration.js';
import { RendererServer, DESKTOP_TOKEN_HEADER } from './main/renderer-server.js';
import { resolveRuntime, type RuntimeDescriptor } from './main/runtime-layout.js';
import { openSqliteStorageWithRecovery } from './main/storage.js';
import { ElectronStorageCodec } from './main/storage-codec.js';
import {
  desktopThemeIconPath,
  loadDesktopThemeBackgrounds,
  normalizeDesktopAccent,
} from './main/theme-icon.js';
import {
  inspectSelfUpdateAvailability,
  UpdateCoordinator,
} from './main/update-coordinator.js';
import { WindowManager } from './main/window-manager.js';

const APP_NAME = 'QED2';
const DEFAULT_UI_PORT = 1122;
const DEFAULT_CORE_PORT = 1022;
const SESSION_PARTITION = 'persist:qed2-desktop-v2';
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const UPDATE_RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;
const CORE_SOURCE_STORAGE_KEY = 'core-source';
const ACCENT_STORAGE_KEY = 'accent';

app.setName(APP_NAME);
app.enableSandbox();
if (process.platform === 'win32') app.setAppUserModelId('studio.barcarolle.qed2');

let windows: WindowManager | undefined;
let shuttingDown = false;
let fatalMainProcess: ((kind: string, error: unknown) => void) | undefined;

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
else app.on('second-instance', () => windows?.openMainWindow());

function fallbackRuntime(): RuntimeDescriptor {
  if (app.isPackaged) {
    const runtimeRoot = resolve(process.resourcesPath, 'runtime');
    return {
      coreDirectory: resolve(runtimeRoot, 'core'),
      coreEntry: resolve(runtimeRoot, 'core/dist/main.js'),
      bankDirectory: resolve(runtimeRoot, 'bank'),
      source: 'bundled',
    };
  }
  const workspaceContainer = resolve(app.getAppPath(), '../../..');
  const coreDirectory = resolve(process.env.QED2_DESKTOP_CORE_PATH ?? resolve(workspaceContainer, 'qedv2-core'));
  return {
    coreDirectory,
    coreEntry: resolve(process.env.QED2_DESKTOP_CORE_ENTRY ?? resolve(coreDirectory, 'dist/main.js')),
    bankDirectory: resolve(process.env.QED2_DESKTOP_BANK_PATH ?? resolve(workspaceContainer, 'srdpmppr')),
    source: 'development',
  };
}

function installRendererRecovery(
  logger: DesktopLogger,
  clearPreloadCodeCaches: () => Promise<void>,
): void {
  const failures = new Map<number, number[]>();
  const unresponsiveTimers = new Map<number, NodeJS.Timeout>();
  const reloadTimers = new Map<number, NodeJS.Timeout>();
  const recoveryDialogs = new Set<number>();
  const preloadRecovery = new PreloadCodeCacheRuntimeRecovery(clearPreloadCodeCaches);

  const clearReloadTimer = (id: number): void => {
    const timer = reloadTimers.get(id);
    if (timer) clearTimeout(timer);
    reloadTimers.delete(id);
  };

  const recordFailure = (id: number): number => {
    const now = Date.now();
    const recent = (failures.get(id) ?? []).filter((time) => now - time < 60_000);
    recent.push(now);
    failures.set(id, recent);
    return recent.length;
  };

  const showNativeRecovery = async (contents: WebContents, window: BrowserWindow): Promise<void> => {
    if (recoveryDialogs.has(contents.id) || window.isDestroyed()) return;
    clearReloadTimer(contents.id);
    recoveryDialogs.add(contents.id);
    try {
      await logger.flush();
      const { response } = await dialog.showMessageBox(window, {
        type: 'error',
        title: `${APP_NAME} – Fensterwiederherstellung`,
        message: 'Dieses Fenster konnte nicht stabil dargestellt werden.',
        detail:
          'Der Darstellungsprozess ist innerhalb einer Minute wiederholt ausgefallen. ' +
          'Der lokale Core und Ihre Daten laufen getrennt weiter.',
        buttons: ['Fenster neu laden', 'Protokoll anzeigen und neu laden', 'Fenster schließen'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (window.isDestroyed()) return;
      if (response === 2) {
        window.close();
        return;
      }
      if (response === 1) {
        await logger.flush();
        shell.showItemInFolder(logger.filePath);
      }
      failures.delete(contents.id);
      window.reload();
    } catch (error) {
      logger.error('Could not present native renderer recovery', error);
      if (!window.isDestroyed()) window.close();
    } finally {
      recoveryDialogs.delete(contents.id);
    }
  };

  const recoverWindow = (contents: WebContents, window: BrowserWindow): void => {
    const failureCount = recordFailure(contents.id);
    if (failureCount > 3) {
      void showNativeRecovery(contents, window);
      return;
    }
    clearReloadTimer(contents.id);
    const delay = [500, 1_500, 4_000][failureCount - 1] ?? 4_000;
    const timer = setTimeout(() => {
      reloadTimers.delete(contents.id);
      if (!window.isDestroyed()) window.reload();
    }, delay);
    timer.unref();
    reloadTimers.set(contents.id, timer);
  };

  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.on('preload-error', (_preloadEvent, preloadPath, error) => {
      logger.error('Renderer preload failed; clearing Electron code cache before recovery', {
        id: contents.id,
        preloadPath,
        error,
      });
      void preloadRecovery
        .recover(contents.id, (clearError) => {
          if (clearError) logger.error('Could not clear Electron code cache after preload failure', clearError);
          const window = BrowserWindow.fromWebContents(contents);
          if (!window || window.isDestroyed()) return;
          recoverWindow(contents, window);
        })
        .catch((recoveryError: unknown) => {
          logger.error('Unexpected preload recovery coordinator failure', recoveryError);
        });
    });
    contents.on('render-process-gone', (_goneEvent, details) => {
      if (details.reason === 'clean-exit') return;
      logger.error('Renderer process exited unexpectedly', {
        id: contents.id,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      const window = BrowserWindow.fromWebContents(contents);
      if (!window || window.isDestroyed()) return;
      recoverWindow(contents, window);
    });
    contents.on('did-fail-load', (_loadEvent, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      // ERR_ABORTED is expected when a navigation is intentionally superseded.
      if (!isMainFrame || errorCode === -3) return;
      logger.warn('Renderer main-frame load failed', {
        id: contents.id,
        errorCode,
        errorDescription,
        url: validatedUrl,
      });
      const window = BrowserWindow.fromWebContents(contents);
      if (window && !window.isDestroyed()) recoverWindow(contents, window);
    });
    contents.on('unresponsive', () => {
      logger.warn('Renderer became unresponsive', { id: contents.id, url: contents.getURL() });
      const prior = unresponsiveTimers.get(contents.id);
      if (prior) clearTimeout(prior);
      const timer = setTimeout(() => {
        unresponsiveTimers.delete(contents.id);
        const window = BrowserWindow.fromWebContents(contents);
        if (window && !window.isDestroyed()) recoverWindow(contents, window);
      }, 15_000);
      timer.unref();
      unresponsiveTimers.set(contents.id, timer);
    });
    contents.on('responsive', () => {
      const timer = unresponsiveTimers.get(contents.id);
      if (timer) clearTimeout(timer);
      unresponsiveTimers.delete(contents.id);
      // If Chromium recovered on its own during the grace period, avoid a
      // needless reload that could discard in-flight renderer interaction.
      clearReloadTimer(contents.id);
    });
    contents.once('destroyed', () => {
      const timer = unresponsiveTimers.get(contents.id);
      if (timer) clearTimeout(timer);
      unresponsiveTimers.delete(contents.id);
      clearReloadTimer(contents.id);
      failures.delete(contents.id);
      recoveryDialogs.delete(contents.id);
    });
  });
}

function installMainCrashRecovery(logger: DesktopLogger): (kind: string, error: unknown) => void {
  const journalPath = resolve(app.getPath('userData'), 'main-crash-restarts.json');
  const writeJournal = (timestamps: number[]) => {
    const temporary = `${journalPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(timestamps)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      renameSync(temporary, journalPath);
    } catch (error) {
      // Windows does not consistently replace an existing destination with
      // rename(). Keep POSIX atomic replacement and use the narrow fallback
      // only for the platform's destination-exists variants.
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EACCES', 'EEXIST', 'EPERM'].includes(code ?? '')) {
        throw error;
      }
      rmSync(journalPath, { force: true });
      renameSync(temporary, journalPath);
    }
  };
  const fatal = (kind: string, error: unknown) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.error(`Fatal main-process ${kind}`, error);
    const now = Date.now();
    let timestamps: number[] = [];
    try {
      const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        timestamps = parsed.filter(
          (value): value is number =>
            typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now,
        );
      }
    } catch {
      // First crash or a damaged journal: start a new bounded recovery window.
    }
    timestamps = timestamps.filter((time) => now - time < 5 * 60_000);
    timestamps.push(now);
    try {
      writeJournal(timestamps);
    } catch (journalError) {
      logger.error('Could not persist crash-restart journal', journalError);
    }
    const shouldRestart = timestamps.length <= 3;
    if (!shouldRestart) {
      try {
        dialog.showErrorBox(
          `${APP_NAME} konnte nicht stabil gestartet werden`,
          'Der automatische Neustart wurde nach drei Fehlern angehalten. Öffnen Sie QED2 erneut; die lokalen Daten bleiben erhalten.',
        );
      } catch (dialogError) {
        logger.error('Could not present the main-process crash-loop dialog', dialogError);
      }
    }
    let terminated = false;
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      if (shouldRestart) {
        try {
          app.relaunch();
        } catch (relaunchError) {
          logger.error('Could not schedule the automatic desktop relaunch', relaunchError);
        }
      }
      app.exit(1);
    };
    // Preserve the fatal record when possible, but never trust asynchronous
    // logging enough to leave a broken main process alive indefinitely.
    const exitWatchdog = setTimeout(terminate, 1_000);
    void logger.flush().finally(() => {
      clearTimeout(exitWatchdog);
      terminate();
    });
  };
  process.on('uncaughtException', (error) => fatal('exception', error));
  process.on('unhandledRejection', (error) => fatal('promise rejection', error));
  const stableTimer = setTimeout(() => {
    try {
      writeJournal([]);
    } catch {
      // A read-only userData directory is reported by the normal logger paths.
    }
  }, 2 * 60_000);
  stableTimer.unref();
  return fatal;
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });

  crashReporter.start({
    companyName: 'Barcarolle Studio',
    productName: APP_NAME,
    uploadToServer: false,
    compress: true,
  });
  const logger = new DesktopLogger(app.getPath('logs'));
  fatalMainProcess = installMainCrashRecovery(logger);
  logger.info('Desktop bootstrap started', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  });
  const selfUpdateAvailability = await inspectSelfUpdateAvailability(
    app.isPackaged,
    process.resourcesPath,
  );
  const updateAvailabilityDetail = {
    available: selfUpdateAvailability.available,
    reason: selfUpdateAvailability.reason,
  };
  if (selfUpdateAvailability.reason === 'unsigned-manual') {
    logger.warn('Desktop update channel is manual-install only for this unsigned build', updateAvailabilityDetail);
  } else if (selfUpdateAvailability.available) {
    logger.info('Desktop self-update channel is available', updateAvailabilityDetail);
  } else {
    logger.warn('Desktop self-update channel is unavailable for this build', updateAvailabilityDetail);
  }

  const preloadPath = resolve(app.getAppPath(), 'dist/preload.cjs');
  const uiSession = session.fromPartition(SESSION_PARTITION, { cache: true });
  const resetElectronPreloadCaches = (): Promise<void> =>
    resetPreloadCodeCaches({
      userDataPath: app.getPath('userData'),
      clearSessionCodeCaches: async () => {
        // Electron's application-level bootstrap cache lives under the default
        // sessionData root, while QED2's renderer uses a dedicated partition.
        // Clear both through Electron's supported API before trusting the marker.
        await Promise.all([
          session.defaultSession.clearCodeCaches({}),
          uiSession.clearCodeCaches({}),
        ]);
      },
      onCleanupError: (error, stalePath) => {
        logger.warn('Could not remove rotated Electron preload cache', { error, stalePath });
      },
    });
  installRendererRecovery(logger, resetElectronPreloadCaches);
  const preloadCacheMigration = await migratePreloadCodeCache({
    electronVersion: process.versions.electron,
    preloadPath,
    markerPath: resolve(app.getPath('userData'), 'cache-migrations', 'preload-code-cache.json'),
    resetCodeCaches: resetElectronPreloadCaches,
  });
  logger.info(
    preloadCacheMigration.migrated
      ? 'Cleared stale Electron preload code cache'
      : 'Electron preload code cache is current',
    {
      electronVersion: preloadCacheMigration.marker.electronVersion,
      preloadSha256: preloadCacheMigration.marker.preloadSha256,
    },
  );

  let runtime: RuntimeDescriptor;
  try {
    runtime = await resolveRuntime({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
  } catch (error) {
    runtime = fallbackRuntime();
    logger.error('Bundled local runtime is unavailable; remote fallback will remain usable', error);
  }

  const storageResult = openSqliteStorageWithRecovery(
    resolve(app.getPath('userData'), 'data', 'qed2.sqlite3'),
    new ElectronStorageCodec(logger),
    {
      onRecovery: (notice) => logger.error(notice.message, notice),
    },
  );
  const storage = storageResult.storage;
  if (storageResult.quarantinedPaths.length > 0) {
    logger.warn('QED2 started with a clean database after preserving damaged local data', {
      quarantinedPaths: storageResult.quarantinedPaths,
    });
  }
  const themeIconRoot = app.isPackaged
    ? resolve(process.resourcesPath, 'theme-icons')
    : resolve(app.getAppPath(), 'build/theme-icons');
  const themeBackgrounds = loadDesktopThemeBackgrounds(themeIconRoot);
  let currentDesktopAccent = 'weed';
  const currentDesktopBackground = (): string | undefined => {
    const palette = themeBackgrounds[currentDesktopAccent] ?? themeBackgrounds.weed;
    return palette?.[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
  };
  const applyThemePreference = (preference: unknown): void => {
    nativeTheme.themeSource =
      preference === 'light' || preference === 'dark' || preference === 'system'
        ? preference
        : 'system';
    windows?.refreshThemeBackgrounds();
  };
  applyThemePreference(storage.get('config', 'theme'));
  let currentWindowIcon: NativeImage | undefined;
  const applyAccentPreference = (preference: unknown): void => {
    const requestedAccent = normalizeDesktopAccent(preference);
    const requestedPath = desktopThemeIconPath(themeIconRoot, requestedAccent);
    const loadThemeIcon = (accent: string): NativeImage | undefined => {
      const iconPath = desktopThemeIconPath(themeIconRoot, accent);
      try {
        const candidate = nativeImage.createFromPath(iconPath);
        return candidate.isEmpty() ? undefined : candidate;
      } catch (error) {
        logger.warn('Desktop theme icon could not be decoded', { accent, iconPath, error });
        return undefined;
      }
    };
    let icon = loadThemeIcon(requestedAccent);
    let appliedAccent = requestedAccent;
    if (!icon && requestedAccent !== 'weed') {
      appliedAccent = 'weed';
      icon = loadThemeIcon(appliedAccent);
    }
    if (!icon) {
      logger.warn('Desktop theme icon is unavailable; retaining the installed application icon', {
        requestedAccent,
        requestedPath,
      });
      currentDesktopAccent = themeBackgrounds[requestedAccent] ? requestedAccent : 'weed';
      windows?.refreshThemeBackgrounds();
      return;
    }
    currentDesktopAccent = appliedAccent;
    currentWindowIcon = icon;
    if (process.platform === 'darwin') {
      try {
        app.dock?.setIcon(icon);
      } catch (error) {
        logger.warn('macOS Dock icon update failed; the installed icon remains available', error);
      }
    } else {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        try {
          window.setIcon(icon);
        } catch (error) {
          logger.warn('Native window icon update failed', { windowId: window.id, error });
        }
      }
    }
    windows?.refreshThemeBackgrounds();
    logger.info('Desktop theme icon applied', { requestedAccent, appliedAccent });
  };
  applyAccentPreference(storage.get('config', ACCENT_STORAGE_KEY));
  const storedCoreSource = storage.get<unknown>('config', CORE_SOURCE_STORAGE_KEY);
  const initialCoreSource: CoreSourcePreference = storedCoreSource === 'remote' ? 'remote' : 'local';
  const onNativeThemeUpdated = (): void => windows?.refreshThemeBackgrounds();
  nativeTheme.on('updated', onNativeThemeUpdated);
  const core = new CoreSupervisor(
    runtime,
    new ElectronCoreProcessLauncher(resolve(app.getAppPath(), 'dist/core-host.cjs')),
    logger,
    {
      preferredPort: DEFAULT_CORE_PORT,
      initialConfig: DEFAULT_CONFIG,
      initialSource: initialCoreSource,
    },
  );
  const network = new NetworkMonitor();
  network.start();
  const updates = new UpdateCoordinator(
    app.getVersion(),
    app.isPackaged,
    {
      coreVersion: runtime.manifest?.core.version ?? 'development',
      ...(runtime.manifest?.core.commit ? { coreCommit: runtime.manifest.core.commit } : {}),
      ...(runtime.manifest?.bank.commit ? { bankCommit: runtime.manifest.bank.commit } : {}),
      coreRepoUrl: DEFAULT_CONFIG.coreRepoUrl,
      bankRepoUrl: DEFAULT_CONFIG.bankRepoUrl,
    },
    logger,
    {
      recoveryStore: storage,
      selfUpdateAvailability,
      downloadRoot: resolve(app.getPath('userData'), 'updates', 'v1'),
      installLifecycle: {
        onBeforeQuitForUpdate(callback) {
          nativeAutoUpdater.on('before-quit-for-update', callback);
          return () => nativeAutoUpdater.off('before-quit-for-update', callback);
        },
      },
    },
  );

  const webRoot = app.isPackaged
    ? resolve(process.resourcesPath, 'web')
    : resolve(app.getAppPath(), '../web/dist');
  const renderer = new RendererServer({
    webRoot,
    preferredPort: DEFAULT_UI_PORT,
    getCoreUpstream: (source) => core.getProxyEndpoint(source),
    logger,
  });
  const rendererAddress = await renderer.start();

  uiSession.setPermissionCheckHandler(() => false);
  uiSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  uiSession.setDevicePermissionHandler(() => false);
  uiSession.setUserAgent(`${APP_NAME}/${app.getVersion()} Electron/${process.versions.electron}`);
  uiSession.webRequest.onBeforeSendHeaders(
    { urls: [`${rendererAddress.origin}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          [DESKTOP_TOKEN_HEADER]: rendererAddress.token,
        },
      });
    },
  );
  uiSession.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    for (const name of Object.keys(responseHeaders)) {
      const normalized = name.toLowerCase();
      if (normalized === 'set-cookie' || normalized === 'set-cookie2') delete responseHeaders[name];
    }
    callback({ responseHeaders });
  });
  // Erase cookies left by preview builds and reject every future Set-Cookie.
  // Auth SQLite continues to use Electron safeStorage and the real Keychain.
  await uiSession.clearStorageData({ storages: ['cookies', 'serviceworkers'] });

  windows = new WindowManager({
    session: uiSession,
    preloadPath,
    rendererUrl: rendererAddress.bootUrl,
    appVersion: app.getVersion(),
    selfUpdateAvailable: updates.isSelfUpdateAvailable(),
    manualAppInstall: selfUpdateAvailability.reason === 'unsigned-manual',
    appName: APP_NAME,
    windowIcon: () => currentWindowIcon,
    backgroundColor: currentDesktopBackground,
    restoreWindowState: (kind) => storage.get('desktop-window', kind),
    persistWindowState: (kind, state) => storage.set('desktop-window', kind, state),
    onError: (error, context) => logger.error('Window operation failed', { context, error }),
  });

  const desktopIpc = installDesktopIpc({
    renderer: rendererAddress,
    storage,
    core,
    updates,
    network,
    openDesktopWindow: (target: DesktopWindowTarget) => {
      windows?.openWindow(target);
    },
    applyThemePreference,
    applyAccentPreference,
  });
  installApplicationMenu({
    appName: APP_NAME,
    openPracticeWindow: () => windows?.openPracticeWindow(),
    openUpdateCenterWindow: () => windows?.openUpdateCenterWindow(),
    openNodeDiagnosticsWindow: () => windows?.openNodeDiagnosticsWindow(),
    openLogs: () => {
      void logger.flush().then(() => shell.showItemInFolder(logger.filePath));
    },
    dispatch: (command, target) => {
      windows?.dispatchShellCommand(command, target);
    },
  });

  windows.openMainWindow();
  // Local is the first-launch default. A persisted Remote choice deliberately
  // keeps the bundled process dormant until a pinned Local session needs it.
  // During Local startup the dynamic gateway remains usable through the
  // explicit, visible Remote fallback.
  void core.getEndpoint();

  const maintainUpdates = async (): Promise<void> => {
    if (!updates.isSelfUpdateAvailable() || !network.isOnline() || updates.getState().busy) return;
    if (updates.hasPendingDownload()) {
      await updates.resumePendingDownload();
      return;
    }
    await updates.checkForUpdates();
  };
  const updateTimer = setInterval(() => {
    void maintainUpdates().catch((error: unknown) => logger.warn('Scheduled update maintenance failed', error));
  }, UPDATE_INTERVAL_MS);
  updateTimer.unref();
  const updateRecoveryTimer = setInterval(() => {
    if (
      !updates.isSelfUpdateAvailable() ||
      !network.isOnline() ||
      !updates.hasPendingDownload() ||
      updates.getState().busy
    ) return;
    void updates.resumePendingDownload();
  }, UPDATE_RECOVERY_INTERVAL_MS);
  updateRecoveryTimer.unref();
  const initialUpdateTimer = setTimeout(() => {
    void maintainUpdates().catch((error: unknown) => logger.warn('Initial update maintenance failed', error));
  }, 30_000);
  initialUpdateTimer.unref();
  const onNetworkRestored = (online: boolean) => {
    if (!updates.isSelfUpdateAvailable() || !online || !updates.hasPendingDownload()) return;
    void updates.resumePendingDownload();
  };
  network.on('change', onNetworkRestored);

  app.on('activate', () => windows?.openMainWindow());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event: Event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    clearInterval(updateTimer);
    clearInterval(updateRecoveryTimer);
    clearTimeout(initialUpdateTimer);
    const shutdownWatchdog = setTimeout(() => {
      console.error('[qed2:shutdown] Graceful shutdown timed out; forcing process exit');
      app.exit(1);
    }, 10_000);
    void (async () => {
      const primary = await Promise.allSettled([
        windows?.flushWindowState() ?? Promise.resolve(),
        core.stop(),
        renderer.stop(),
      ]);
      for (const [index, result] of primary.entries()) {
        if (result.status === 'rejected') {
          logger.error('Desktop shutdown operation failed', { operationIndex: index, error: result.reason });
        }
      }
      const cleanup = async (label: string, operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          logger.error(`Desktop shutdown cleanup failed: ${label}`, error);
        }
      };
      await cleanup('desktop IPC', () => desktopIpc.dispose());
      await cleanup('network listener', () => {
        network.off('change', onNetworkRestored);
      });
      await cleanup('native theme listener', () => {
        nativeTheme.off('updated', onNativeThemeUpdated);
      });
      await cleanup('network monitor', () => network.stop());
      await cleanup('local storage', () => storage.close());
      await logger.flush();
    })()
      .catch((error: unknown) => console.error('[qed2:shutdown]', error))
      .finally(() => {
        clearTimeout(shutdownWatchdog);
        app.exit(0);
      });
  });

  logger.info('Desktop bootstrap complete', {
    uiPort: rendererAddress.port,
    preferredCorePort: DEFAULT_CORE_PORT,
    runtimeSource: runtime.source,
  });
}

if (hasInstanceLock) {
  void bootstrap().catch((error: unknown) => {
    if (fatalMainProcess) {
      fatalMainProcess('bootstrap rejection', error);
      return;
    }
    dialog.showErrorBox(`${APP_NAME} konnte nicht gestartet werden`, error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
}
