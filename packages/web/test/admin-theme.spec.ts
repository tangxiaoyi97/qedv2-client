import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBDatabase, IDBObjectStore } from 'fake-indexeddb';
import { startAdminTheme } from '../src/admin/theme.js';
import { readLegacyThemeAppearance } from '../src/admin/legacy-theme.js';
import {
  BUILTIN_THEME_EXTENSIONS,
  mirrorThemeAppearance,
  THEME_STORAGE_KEYS,
} from '../src/platform/theme-preferences.js';
import { setBuiltinThemeExtension } from '../src/platform/theme.js';
import adminCss from '../src/admin/admin.css?raw';
import adminEntry from '../src/admin/main.ts?raw';
import layoutTokens from '../../ui/src/styles/layout-tokens.css?raw';

let factory: IDBFactory;
let media: MediaQueryList;
const stops: Array<() => void> = [];

async function openExisting(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open('qed2');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedLegacy(theme: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open('qed2', 4);
    request.onupgradeneeded = () => {
      const config = request.result.createObjectStore('config');
      config.put(theme, 'theme');
      config.put('unrelated-value', 'other-setting');
      request.result.createObjectStore('progress').put({ attempts: 42 }, 'unchanged');
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
}

function systemDark(dark: boolean): void {
  Object.defineProperty(media, 'matches', { value: dark, configurable: true });
  media.dispatchEvent(new Event('change'));
}

function storageChanged(key: string | null): void {
  window.dispatchEvent(new StorageEvent('storage', { key }));
}

async function start(): Promise<void> {
  stops.push(await startAdminTheme());
}

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal('indexedDB', factory);
  media = Object.assign(new EventTarget(), { matches: false }) as MediaQueryList;
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.getElementById('qed2-external-theme')?.remove();
});

describe('independent management appearance', () => {
  it.each(BUILTIN_THEME_EXTENSIONS)('inherits $id and an explicit appearance before mounting', async ({ id }) => {
    window.localStorage.setItem(THEME_STORAGE_KEYS.appearance, 'light');
    window.localStorage.setItem(THEME_STORAGE_KEYS.builtinId, id);
    systemDark(true);
    const enumerate = vi.spyOn(factory, 'databases');
    await start();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.accent).toBe(id === 'weed' ? undefined : id);
    expect(enumerate).not.toHaveBeenCalled();
  });

  it('follows system changes only when the saved appearance permits them', async () => {
    await start();
    expect(document.documentElement.dataset.theme).toBe('light');
    systemDark(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    mirrorThemeAppearance('light');
    systemDark(false);
    systemDark(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    mirrorThemeAppearance('dark');
    systemDark(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    mirrorThemeAppearance('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('updates for Client settings, cross-tab changes and resumed browser pages', async () => {
    await start();
    setBuiltinThemeExtension('sky');
    mirrorThemeAppearance('dark');
    expect(document.documentElement.dataset).toMatchObject({ theme: 'dark', accent: 'sky' });
    window.localStorage.setItem(THEME_STORAGE_KEYS.builtinId, 'raspberry');
    storageChanged(THEME_STORAGE_KEYS.builtinId);
    expect(document.documentElement.dataset.accent).toBe('raspberry');
    window.localStorage.setItem(THEME_STORAGE_KEYS.appearance, 'light');
    window.dispatchEvent(new Event('focus'));
    expect(document.documentElement.dataset.theme).toBe('light');
    window.localStorage.setItem(THEME_STORAGE_KEYS.builtinId, 'violette');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.documentElement.dataset.accent).toBe('violette');
    window.localStorage.clear();
    storageChanged(null);
    expect(document.documentElement.dataset).toMatchObject({ theme: 'light' });
    expect(document.documentElement.dataset.accent).toBeUndefined();
  });

  it('does not use invalid preferences or load cached arbitrary CSS', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEYS.appearance, 'unrecognized');
    window.localStorage.setItem(THEME_STORAGE_KEYS.builtinId, 'unrecognized');
    window.localStorage.setItem(THEME_STORAGE_KEYS.externalCss, ':root { display: none; }');
    window.localStorage.setItem(THEME_STORAGE_KEYS.externalUrl, 'https://themes.example/style.css');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    systemDark(true);
    await start();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.accent).toBeUndefined();
    expect(document.getElementById('qed2-external-theme')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cleans up listeners when the page is disposed', async () => {
    const stop = await startAdminTheme();
    stop();
    systemDark(true);
    mirrorThemeAppearance('dark');
    window.dispatchEvent(new Event('focus'));
    storageChanged(THEME_STORAGE_KEYS.appearance);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('reuses Client typography, palette and geometry without motion or a learner import', () => {
    expect(adminEntry).toContain("import '@qed2/ui/themes'");
    expect(adminEntry).toContain("import '@qed2/ui/layout-tokens'");
    expect(adminEntry).toContain("import '@fontsource/public-sans/400.css'");
    expect(adminEntry).not.toMatch(/from ['"].*(?:stores|services|router)/);
    expect(adminCss).toContain('--admin-bg: var(--q-page)');
    expect(adminCss).toContain('color: var(--q-on-accent)');
    expect(adminCss).toContain('border-radius: var(--q-radius-card)');
    expect(adminCss).toContain('animation: none !important');
    expect(adminCss).toContain('transition: none !important');
    expect(adminCss).not.toMatch(/#[\da-f]{3,8}\b|prefers-color-scheme/);
    expect(layoutTokens).toContain('--q-control-height: 44px');
  });
});

describe('bounded legacy theme inheritance', () => {
  it('inherits an existing light preference on a dark system, reading only config/theme', async () => {
    await seedLegacy('light');
    systemDark(true);
    const read = vi.spyOn(IDBObjectStore.prototype, 'get');
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    await start();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEYS.appearance)).toBe('light');
    expect(read.mock.calls).toEqual([['theme']]);
    expect(transaction.mock.calls).toEqual([['config', 'readonly']]);
    const db = await openExisting();
    expect(db.version).toBe(4);
    const untouched = db.transaction('progress', 'readonly').objectStore('progress').get('unchanged');
    await new Promise<void>((resolve) => { untouched.onsuccess = () => resolve(); });
    expect(untouched.result).toEqual({ attempts: 42 });
    db.close();
  });

  it('does not open or create a learner database for a new browser', async () => {
    const open = vi.spyOn(factory, 'open');
    expect(await readLegacyThemeAppearance()).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    expect(await factory.databases()).toEqual([]);
  });

  it('aborts a creation race when the enumerated database has been deleted', async () => {
    vi.spyOn(factory, 'databases').mockResolvedValue([{ name: 'qed2', version: 4 }]);
    expect(await readLegacyThemeAppearance()).toBeUndefined();
    vi.restoreAllMocks();
    // Allow the aborted opening request to complete its rollback.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await factory.databases()).toEqual([]);
  });

  it('does not let a delayed legacy result overwrite a newer Client preference', async () => {
    await seedLegacy('light');
    const originalDatabases = factory.databases.bind(factory);
    let release!: () => void;
    vi.spyOn(factory, 'databases').mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return originalDatabases();
    });
    const starting = start();
    mirrorThemeAppearance('dark');
    release();
    await starting;
    expect(window.localStorage.getItem(THEME_STORAGE_KEYS.appearance)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('keeps legacy appearance in memory if localStorage is denied', async () => {
    await seedLegacy('light');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    await start();
    systemDark(true);
    window.dispatchEvent(new Event('focus'));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('falls back without persisting a choice when database enumeration is unavailable', async () => {
    Object.defineProperty(factory, 'databases', { value: undefined });
    systemDark(true);
    await start();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEYS.appearance)).toBeNull();
  });

  it('rejects invalid legacy values without writing a mirror', async () => {
    await seedLegacy({ appearance: 'light' });
    await start();
    expect(window.localStorage.getItem(THEME_STORAGE_KEYS.appearance)).toBeNull();
  });

  it('bounds database enumeration and does not open anything after timeout', async () => {
    vi.useFakeTimers();
    let resolveEnumeration!: (value: IDBDatabaseInfo[]) => void;
    vi.spyOn(factory, 'databases').mockImplementation(() => new Promise((resolve) => { resolveEnumeration = resolve; }));
    const open = vi.spyOn(factory, 'open');
    const result = readLegacyThemeAppearance(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeUndefined();
    resolveEnumeration([{ name: 'qed2', version: 4 }]);
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
  });

  it('closes a late open and still aborts late creation after timeout', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const abort = vi.fn();
    const transaction = vi.fn();
    const request = { result: { close, transaction }, transaction: { abort } } as unknown as IDBOpenDBRequest;
    vi.spyOn(factory, 'databases').mockResolvedValue([{ name: 'qed2', version: 4 }]);
    vi.spyOn(factory, 'open').mockReturnValue(request);
    const result = readLegacyThemeAppearance(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeUndefined();
    request.onupgradeneeded?.call(request, {} as IDBVersionChangeEvent);
    expect(abort).toHaveBeenCalledOnce();
    request.onsuccess?.call(request, new Event('success'));
    expect(close).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
  });
});
