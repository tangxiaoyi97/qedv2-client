import { EventEmitter } from 'node:events';
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Rectangle,
  Session,
} from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  focusedWindow: undefined as BrowserWindow | undefined,
  shouldUseDarkColors: false,
}));

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {
    static getFocusedWindow(): BrowserWindow | undefined {
      return electronMocks.focusedWindow;
    }
  },
  nativeTheme: {
    get shouldUseDarkColors(): boolean {
      return electronMocks.shouldUseDarkColors;
    },
  },
  screen: {
    getDisplayMatching: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
  },
}));

import { WindowManager } from '../src/main/window-manager.js';

class FakeWebContents extends EventEmitter {
  currentUrl = '';
  readonly loadedUrls: string[] = [];
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  windowOpenHandler: (() => { action: 'deny' }) | undefined;

  setWindowOpenHandler(handler: () => { action: 'deny' }): void {
    this.windowOpenHandler = handler;
  }

  getURL(): string {
    return this.currentUrl;
  }

  isDestroyed(): boolean {
    return false;
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  readonly loadedUrls: string[] = [];
  readonly titles: string[] = [];
  readonly backgroundColors: string[] = [];
  destroyed = false;
  visible = false;
  minimized = false;
  maximized = false;
  fullScreen = false;
  focused = false;

  constructor(readonly options: BrowserWindowConstructorOptions) {
    super();
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    this.webContents.loadedUrls.push(url);
    this.webContents.currentUrl = url;
  }

  isDestroyed(): boolean { return this.destroyed; }
  isVisible(): boolean { return this.visible; }
  isMinimized(): boolean { return this.minimized; }
  isMaximized(): boolean { return this.maximized; }
  isFullScreen(): boolean { return this.fullScreen; }
  show(): void { this.visible = true; }
  focus(): void { this.focused = true; }
  restore(): void { this.minimized = false; }
  maximize(): void { this.maximized = true; }
  setFullScreen(value: boolean): void { this.fullScreen = value; }
  setTitle(value: string): void { this.titles.push(value); }
  setBackgroundColor(value: string): void { this.backgroundColors.push(value); }
  close(): void { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  getNormalBounds(): Rectangle {
    return { x: 20, y: 30, width: this.options.width ?? 800, height: this.options.height ?? 600 };
  }
}

function createManager(options: { backgroundColor?: () => string | undefined } = {}): {
  manager: WindowManager;
  created: FakeBrowserWindow[];
} {
  const created: FakeBrowserWindow[] = [];
  const manager = new WindowManager({
    session: {} as Session,
    preloadPath: '/trusted/preload.cjs',
    rendererUrl: 'http://127.0.0.1:1122/__qed2_boot/session',
    appVersion: '2.0.0',
    selfUpdateAvailable: true,
    manualAppInstall: true,
    ...options,
    createBrowserWindow: (options) => {
      const window = new FakeBrowserWindow(options);
      created.push(window);
      return window as unknown as BrowserWindow;
    },
  });
  return { manager, created };
}

describe('WindowManager desktop-control windows', () => {
  beforeEach(() => {
    electronMocks.focusedWindow = undefined;
    electronMocks.shouldUseDarkColors = false;
  });

  it('opens distinct singleton windows on dedicated Desktop routes', () => {
    const { manager, created } = createManager();
    const updates = manager.openUpdateCenterWindow() as unknown as FakeBrowserWindow;
    const updatesAgain = manager.openUpdateCenterWindow();
    const node = manager.openNodeDiagnosticsWindow() as unknown as FakeBrowserWindow;

    expect(updatesAgain).toBe(updates);
    expect(node).not.toBe(updates);
    expect(created).toHaveLength(2);
    expect(updates.loadedUrls).toEqual([
      'http://127.0.0.1:1122/desktop/updates',
    ]);
    expect(node.loadedUrls).toEqual([
      'http://127.0.0.1:1122/desktop/node',
    ]);
    expect(updates.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      additionalArguments: [
        '--qed2-app-version=2.0.0',
        '--qed2-self-update=true',
        '--qed2-manual-app-install=true',
        '--qed2-window-kind=updates',
      ],
    });
    expect(updates.webContents.windowOpenHandler?.()).toEqual({ action: 'deny' });
  });

  it('restores a tool window that has navigated away from its fixed route', () => {
    const { manager } = createManager();
    const updates = manager.openUpdateCenterWindow() as unknown as FakeBrowserWindow;
    updates.webContents.currentUrl = 'http://127.0.0.1:1122/progress';

    manager.openUpdateCenterWindow();
    expect(updates.loadedUrls.at(-1)).toBe(
      'http://127.0.0.1:1122/desktop/updates',
    );

    updates.webContents.currentUrl = 'http://127.0.0.1:1122/history';
    updates.webContents.emit(
      'did-navigate-in-page',
      {},
      updates.webContents.currentUrl,
      true,
    );
    expect(updates.loadedUrls.at(-1)).toBe(
      'http://127.0.0.1:1122/desktop/updates',
    );
  });

  it('keeps the native title stable when the shared document changes it', () => {
    const { manager } = createManager();
    const node = manager.openNodeDiagnosticsWindow() as unknown as FakeBrowserWindow;
    const event = { preventDefault: vi.fn() };

    node.emit('page-title-updated', event, 'QED2 Web');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(node.titles.at(-1)).toBe('QED2 – Knotendiagnose');
  });

  it('uses stable window sizes and refreshes every native background with the theme', () => {
    let background = '#f5f5f6';
    const { manager } = createManager({ backgroundColor: () => background });
    const main = manager.openMainWindow() as unknown as FakeBrowserWindow;
    const practice = manager.openPracticeWindow() as unknown as FakeBrowserWindow;
    const updates = manager.openUpdateCenterWindow() as unknown as FakeBrowserWindow;
    const node = manager.openNodeDiagnosticsWindow() as unknown as FakeBrowserWindow;

    expect([main, practice, updates, node].map((window) => ({
      width: window.options.width,
      height: window.options.height,
      minWidth: window.options.minWidth,
      minHeight: window.options.minHeight,
    }))).toEqual([
      { width: 1280, height: 820, minWidth: 900, minHeight: 620 },
      { width: 1180, height: 800, minWidth: 820, minHeight: 620 },
      { width: 760, height: 640, minWidth: 620, minHeight: 500 },
      { width: 840, height: 680, minWidth: 680, minHeight: 520 },
    ]);
    expect(main.options.backgroundColor).toBe('#f5f5f6');

    electronMocks.shouldUseDarkColors = true;
    background = '#161613';
    manager.refreshThemeBackgrounds();
    for (const window of [main, practice, updates, node]) {
      expect(window.backgroundColors).toEqual(['#161613']);
    }
  });

  it('rejects cross-origin and credential-bearing renderer routes', () => {
    const { manager } = createManager();

    expect(() => manager.openMainWindow('https://example.com/settings')).toThrow(
      'trusted renderer origin',
    );
    expect(() => manager.openMainWindow('http://user:secret@127.0.0.1:1122/settings')).toThrow(
      'must not contain credentials',
    );
  });
});
