import type { DesktopWindowTarget, ShellCommand } from '@qed2/core-logic';
import { BrowserWindow, screen } from 'electron';
import { isAbsolute } from 'node:path';
import type {
  BrowserWindowConstructorOptions,
  NativeImage,
  Rectangle,
  Session,
} from 'electron';
import { IPC } from '../shared/channels.js';

export type ManagedWindowKind = 'main' | DesktopWindowTarget;
export type ToolWindowKind = Extract<ManagedWindowKind, 'updates' | 'node'>;

export interface PersistedWindowState {
  bounds: Rectangle;
  maximized: boolean;
  fullScreen: boolean;
}

export interface WindowManagerErrorContext {
  operation: 'load-state' | 'persist-state' | 'load-url';
  kind: ManagedWindowKind;
}

export interface WindowManagerOptions {
  /** Every BrowserWindow is pinned to this exact Electron session. */
  session: Session;
  /** Absolute path to the sandbox-compatible preload bundle. */
  preloadPath: string;
  /** Trusted renderer entry point, normally RendererServerAddress.bootUrl. */
  rendererUrl: string;
  appVersion: string;
  /** Whether this installed build has a validated electron-updater channel. */
  selfUpdateAvailable: boolean;
  /** Whether verified app packages must be handed off for manual installation. */
  manualAppInstall: boolean;
  appName?: string;
  /** Current accent icon for newly created Windows/Linux native windows. */
  windowIcon?: () => NativeImage | undefined;
  /** Pre-paint color generated from the shared Web theme's --q-page token. */
  backgroundColor?: () => string | undefined;
  routes?: Partial<Record<ManagedWindowKind, string>>;
  restoreWindowState?: (kind: ManagedWindowKind) => PersistedWindowState | undefined;
  persistWindowState?: (
    kind: ManagedWindowKind,
    state: PersistedWindowState,
  ) => void | Promise<void>;
  persistenceDebounceMs?: number;
  onError?: (error: unknown, context: WindowManagerErrorContext) => void;
  createBrowserWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
}

interface WindowDefaults {
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  maximizable: boolean;
  fullscreenable: boolean;
}

const DEFAULT_ROUTES: Readonly<Record<Exclude<ManagedWindowKind, 'main'>, string>> = {
  practice: '/practice',
  updates: '/desktop/updates',
  node: '/desktop/node',
};

const DEFAULT_PERSISTENCE_DEBOUNCE_MS = 350;

function finiteInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value);
}

function validBounds(bounds: Rectangle): boolean {
  return (
    finiteInteger(bounds.x) &&
    finiteInteger(bounds.y) &&
    finiteInteger(bounds.width) &&
    finiteInteger(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Owns the four desktop windows and keeps renderer-facing capabilities narrow.
 * Business state remains in the shared ports/core; this class only manages OS
 * windows, routes and native-shell command delivery.
 */
export class WindowManager {
  private readonly windows = new Map<ManagedWindowKind, BrowserWindow>();
  private readonly persistenceTimers = new Map<ManagedWindowKind, NodeJS.Timeout>();
  private readonly persistenceQueues = new Map<ManagedWindowKind, Promise<void>>();
  private readonly createBrowserWindow: (
    options: BrowserWindowConstructorOptions,
  ) => BrowserWindow;
  private readonly rendererEntry: URL;
  private readonly debounceMs: number;

  constructor(private readonly options: WindowManagerOptions) {
    this.rendererEntry = new URL(options.rendererUrl);
    if (this.rendererEntry.protocol !== 'http:' && this.rendererEntry.protocol !== 'https:') {
      throw new Error('The desktop renderer must use an HTTP(S) origin');
    }
    if (!isAbsolute(options.preloadPath)) {
      throw new Error('preloadPath must be absolute');
    }
    const requestedDebounce = options.persistenceDebounceMs ?? DEFAULT_PERSISTENCE_DEBOUNCE_MS;
    this.debounceMs = Number.isFinite(requestedDebounce)
      ? clamp(Math.round(requestedDebounce), 0, 60_000)
      : DEFAULT_PERSISTENCE_DEBOUNCE_MS;
    this.createBrowserWindow =
      options.createBrowserWindow ?? ((windowOptions) => new BrowserWindow(windowOptions));
  }

  openWindow(kind: ManagedWindowKind, route?: string): BrowserWindow {
    switch (kind) {
      case 'main':
        return this.openMainWindow(route);
      case 'practice':
        return this.openPracticeWindow(route);
      case 'updates':
        if (route !== undefined) throw new Error('The update-center route is fixed');
        return this.openUpdateCenterWindow();
      case 'node':
        if (route !== undefined) throw new Error('The node-diagnostics route is fixed');
        return this.openNodeDiagnosticsWindow();
    }
  }

  openMainWindow(route?: string): BrowserWindow {
    const destination = this.rendererRoute(route ?? this.options.routes?.main);
    return this.openSingleton('main', destination, route !== undefined);
  }

  openPracticeWindow(route?: string): BrowserWindow {
    const configuredRoute = this.options.routes?.practice ?? DEFAULT_ROUTES.practice;
    const destination = this.rendererRoute(route ?? configuredRoute);
    if (destination.pathname !== '/practice') {
      throw new Error('Practice windows may only load the /practice route');
    }
    return this.openSingleton('practice', destination, route !== undefined);
  }

  openUpdateCenterWindow(): BrowserWindow {
    return this.openToolWindow('updates');
  }

  openNodeDiagnosticsWindow(): BrowserWindow {
    return this.openToolWindow('node');
  }

  getWindow(kind: ManagedWindowKind): BrowserWindow | undefined {
    const window = this.windows.get(kind);
    return window && !window.isDestroyed() ? window : undefined;
  }

  getAllWindows(): BrowserWindow[] {
    return [...this.windows.values()].filter((window) => !window.isDestroyed());
  }

  /** Keeps the native clear color in step with Electron's current theme. */
  refreshThemeBackgrounds(): void {
    const background = this.windowBackgroundColor();
    if (!background) return;
    for (const window of this.getAllWindows()) window.setBackgroundColor(background);
  }

  /**
   * Sends only the compile-time bounded ShellCommand union. Single-purpose
   * tool windows host the shared Vue app, but remain excluded so a global
   * navigation command cannot replace their fixed desktop-control route.
   */
  dispatchShellCommand(command: ShellCommand, preferredWindow?: BrowserWindow): boolean {
    const focused = BrowserWindow.getFocusedWindow() ?? undefined;
    const target =
      this.commandWindow(preferredWindow) ??
      this.commandWindow(focused) ??
      this.getWindow('main') ??
      this.getWindow('practice');
    if (!target || target.isDestroyed()) return false;
    target.webContents.send(IPC.shellCommand, command);
    return true;
  }

  closeAll(): void {
    for (const window of this.getAllWindows()) window.close();
  }

  /** Flushes debounce timers and waits for injected persistence callbacks. */
  async flushWindowState(): Promise<void> {
    for (const [kind, window] of this.windows) this.flushPersistence(kind, window);
    await Promise.all([...this.persistenceQueues.values()]);
  }

  private openToolWindow(kind: ToolWindowKind): BrowserWindow {
    const route = this.options.routes?.[kind] ?? DEFAULT_ROUTES[kind];
    return this.openSingleton(kind, this.rendererRoute(route), true);
  }

  private openSingleton(
    kind: ManagedWindowKind,
    destination: URL,
    navigateExisting = false,
  ): BrowserWindow {
    const existing = this.getWindow(kind);
    if (existing) {
      if (navigateExisting && existing.webContents.getURL() !== destination.href) {
        this.load(existing, kind, destination);
      }
      this.reveal(existing);
      return existing;
    }

    const defaults = this.windowDefaults(kind);
    const restoredState = this.restoreState(kind, defaults);
    const bounds = restoredState?.bounds;
    const windowIcon = this.options.windowIcon?.();
    const backgroundColor = this.windowBackgroundColor();
    const window = this.createBrowserWindow({
      title: defaults.title,
      width: bounds?.width ?? defaults.width,
      height: bounds?.height ?? defaults.height,
      ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: defaults.minWidth,
      minHeight: defaults.minHeight,
      maximizable: defaults.maximizable,
      fullscreenable: defaults.fullscreenable,
      show: false,
      useContentSize: true,
      ...(backgroundColor ? { backgroundColor } : {}),
      autoHideMenuBar: kind !== 'main',
      ...(windowIcon ? { icon: windowIcon } : {}),
      webPreferences: {
        session: this.options.session,
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        additionalArguments: [
          `--qed2-app-version=${this.options.appVersion}`,
          `--qed2-self-update=${this.options.selfUpdateAvailable ? 'true' : 'false'}`,
          `--qed2-manual-app-install=${this.options.manualAppInstall ? 'true' : 'false'}`,
          `--qed2-window-kind=${kind}`,
        ],
      },
    });

    this.windows.set(kind, window);
    this.hardenWebContents(window, kind, destination);
    this.trackWindowState(kind, window);
    // The shared Web build owns one document title. Keep native windows
    // distinguishable in the Dock/task switcher without changing Web code.
    window.on('page-title-updated', (event) => {
      event.preventDefault();
      if (!window.isDestroyed()) window.setTitle(defaults.title);
    });

    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) {
        window.setTitle(defaults.title);
        this.reveal(window);
      }
    });
    window.once('closed', () => {
      if (this.windows.get(kind) === window) this.windows.delete(kind);
      this.clearPersistenceTimer(kind);
    });

    if (restoredState?.maximized && defaults.maximizable) window.maximize();
    if (restoredState?.fullScreen && defaults.fullscreenable) window.setFullScreen(true);
    this.load(window, kind, destination);
    return window;
  }

  private rendererRoute(route?: string): URL {
    const destination = route === undefined
      ? new URL(this.rendererEntry.href)
      : new URL(route, this.rendererEntry.origin);
    if (destination.origin !== this.rendererEntry.origin) {
      throw new Error('Desktop windows may only load the trusted renderer origin');
    }
    if (destination.username || destination.password) {
      throw new Error('Desktop renderer URLs must not contain credentials');
    }
    return destination;
  }

  private windowBackgroundColor(): string | undefined {
    const color = this.options.backgroundColor?.();
    return typeof color === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color)
      ? color
      : undefined;
  }

  private windowDefaults(kind: ManagedWindowKind): WindowDefaults {
    const appName = this.options.appName ?? 'QED2';
    switch (kind) {
      case 'main':
        return {
          title: appName,
          width: 1280,
          height: 820,
          minWidth: 900,
          minHeight: 620,
          maximizable: true,
          fullscreenable: true,
        };
      case 'practice':
        return {
          title: `${appName} – Üben`,
          width: 1180,
          height: 800,
          minWidth: 820,
          minHeight: 620,
          maximizable: true,
          fullscreenable: true,
        };
      case 'updates':
        return {
          title: `${appName} – Update-Center`,
          width: 760,
          height: 640,
          minWidth: 620,
          minHeight: 500,
          maximizable: false,
          fullscreenable: false,
        };
      case 'node':
        return {
          title: `${appName} – Knotendiagnose`,
          width: 840,
          height: 680,
          minWidth: 680,
          minHeight: 520,
          maximizable: false,
          fullscreenable: false,
        };
    }
  }

  private hardenWebContents(window: BrowserWindow, kind: ManagedWindowKind, destination: URL): void {
    const { webContents } = window;
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.on('will-navigate', (event) => event.preventDefault());
    webContents.on('will-frame-navigate', (event) => event.preventDefault());
    webContents.on('will-redirect', (event) => event.preventDefault());
    webContents.on('will-attach-webview', (event) => event.preventDefault());
    if (kind === 'updates' || kind === 'node') {
      webContents.on('did-navigate-in-page', (_event, rawUrl, isMainFrame) => {
        if (!isMainFrame || window.isDestroyed()) return;
        let current: URL;
        try {
          current = new URL(rawUrl);
        } catch {
          this.load(window, kind, destination);
          return;
        }
        const isFixedRoute =
          current.origin === destination.origin &&
          current.pathname === destination.pathname &&
          current.search === destination.search;
        if (!isFixedRoute) this.load(window, kind, destination);
      });
    }
  }

  private load(window: BrowserWindow, kind: ManagedWindowKind, destination: URL): void {
    try {
      void window.loadURL(destination.href).catch((error: unknown) => {
        this.reportError(error, { operation: 'load-url', kind });
        // Never leave a failed launch as an invisible process with no recovery
        // surface; Chromium's error page plus diagnostics remain reachable.
        if (!window.isDestroyed()) this.reveal(window);
      });
    } catch (error) {
      this.reportError(error, { operation: 'load-url', kind });
      if (!window.isDestroyed()) this.reveal(window);
    }
  }

  private reveal(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  }

  private commandWindow(candidate?: BrowserWindow): BrowserWindow | undefined {
    if (!candidate || candidate.isDestroyed()) return undefined;
    return this.windows.get('main') === candidate || this.windows.get('practice') === candidate
      ? candidate
      : undefined;
  }

  private restoreState(
    kind: ManagedWindowKind,
    defaults: WindowDefaults,
  ): PersistedWindowState | undefined {
    const restore = this.options.restoreWindowState;
    if (!restore) return undefined;
    try {
      const state = restore(kind);
      if (!state || !validBounds(state.bounds)) return undefined;
      const display = screen.getDisplayMatching(state.bounds);
      const workArea = display.workArea;
      const width = clamp(state.bounds.width, defaults.minWidth, workArea.width);
      const height = clamp(state.bounds.height, defaults.minHeight, workArea.height);
      const x = clamp(state.bounds.x, workArea.x, workArea.x + workArea.width - width);
      const y = clamp(state.bounds.y, workArea.y, workArea.y + workArea.height - height);
      return {
        bounds: { x, y, width, height },
        maximized: state.maximized === true,
        fullScreen: state.fullScreen === true,
      };
    } catch (error) {
      this.reportError(error, { operation: 'load-state', kind });
      return undefined;
    }
  }

  private trackWindowState(kind: ManagedWindowKind, window: BrowserWindow): void {
    if (!this.options.persistWindowState) return;
    const schedule = () => this.schedulePersistence(kind, window);
    window.on('move', schedule);
    window.on('resize', schedule);
    window.on('maximize', schedule);
    window.on('unmaximize', schedule);
    window.on('enter-full-screen', schedule);
    window.on('leave-full-screen', schedule);
    window.on('close', () => this.flushPersistence(kind, window));
  }

  private schedulePersistence(kind: ManagedWindowKind, window: BrowserWindow): void {
    this.clearPersistenceTimer(kind);
    const timer = setTimeout(() => {
      this.persistenceTimers.delete(kind);
      this.persist(kind, window);
    }, this.debounceMs);
    timer.unref();
    this.persistenceTimers.set(kind, timer);
  }

  private flushPersistence(kind: ManagedWindowKind, window: BrowserWindow): void {
    this.clearPersistenceTimer(kind);
    this.persist(kind, window);
  }

  private clearPersistenceTimer(kind: ManagedWindowKind): void {
    const timer = this.persistenceTimers.get(kind);
    if (!timer) return;
    clearTimeout(timer);
    this.persistenceTimers.delete(kind);
  }

  private persist(kind: ManagedWindowKind, window: BrowserWindow): void {
    const save = this.options.persistWindowState;
    if (!save || window.isDestroyed()) return;
    const state: PersistedWindowState = {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    };
    const previous = this.persistenceQueues.get(kind) ?? Promise.resolve();
    const next = previous
      .then(async () => await save(kind, state))
      .catch((error: unknown) => {
        this.reportError(error, { operation: 'persist-state', kind });
      });
    this.persistenceQueues.set(kind, next);
    void next.then(() => {
      if (this.persistenceQueues.get(kind) === next) this.persistenceQueues.delete(kind);
    });
  }

  private reportError(error: unknown, context: WindowManagerErrorContext): void {
    try {
      this.options.onError?.(error, context);
    } catch (reportingError) {
      console.error('[qed2:window-manager]', reportingError);
    }
  }
}
