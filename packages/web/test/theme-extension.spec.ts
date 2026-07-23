import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateThemeExtension,
  applyExternalTheme,
  BUILTIN_THEME_EXTENSIONS,
  currentBuiltinThemeId,
  prepareThemeBeforeMount,
  THEME_STORAGE_KEYS,
  type ExternalCssThemeExtension,
} from '../src/platform/theme.js';

const externalStyleId = 'qed2-external-theme';

function cleanupThemeState(): void {
  document.getElementById(externalStyleId)?.remove();
  document.querySelector('meta[name="theme-color"]')?.remove();
  delete document.documentElement.dataset.accent;
  delete document.documentElement.dataset.theme;
  window.localStorage.clear();
}

describe('CSS theme-extension runtime', () => {
  beforeEach(cleanupThemeState);
  afterEach(() => {
    cleanupThemeState();
    vi.unstubAllGlobals();
  });

  it('treats an unknown persisted built-in id as the default extension', () => {
    window.localStorage.setItem(THEME_STORAGE_KEYS.builtinId, 'unknown-theme');
    expect(currentBuiltinThemeId()).toBe('weed');
  });

  it('keeps an external stylesheet last and removes the built-in selector', () => {
    document.documentElement.dataset.accent = 'sky';
    applyExternalTheme(':root { --q-page: Canvas; }');
    const laterStyle = document.createElement('style');
    laterStyle.id = 'application-styles';
    document.head.appendChild(laterStyle);

    applyExternalTheme(':root { --q-page: CanvasText; }');

    const external = document.getElementById(externalStyleId);
    expect(external?.textContent).toContain('CanvasText');
    expect(document.head.lastElementChild).toBe(external);
    expect(document.documentElement.dataset.accent).toBeUndefined();
  });

  it('activates a built-in CSS extension and clears an external one', async () => {
    applyExternalTheme(':root { --q-page: Canvas; }');
    window.localStorage.setItem(THEME_STORAGE_KEYS.externalCss, 'cached');
    window.localStorage.setItem(THEME_STORAGE_KEYS.externalUrl, 'https://themes.example/old.css');

    const sky = BUILTIN_THEME_EXTENSIONS.find((extension) => extension.id === 'sky');
    if (!sky) throw new Error('sky extension missing');
    await activateThemeExtension(sky);

    expect(document.getElementById(externalStyleId)).toBeNull();
    expect(document.documentElement.dataset.accent).toBe('sky');
    expect(window.localStorage.getItem(THEME_STORAGE_KEYS.builtinId)).toBe('sky');
    expect(window.localStorage.getItem(THEME_STORAGE_KEYS.externalCss)).toBeNull();
    expect(window.localStorage.getItem(THEME_STORAGE_KEYS.externalUrl)).toBeNull();
  });

  it('accepts the future server/user-library external CSS record', async () => {
    const extension: ExternalCssThemeExtension = {
      kind: 'external-css',
      id: 'library-night',
      label: 'Library Night',
      cssUrl: 'https://themes.example/library-night.css',
    };
    const css = ':root { --q-page: #101114; }';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => css,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await activateThemeExtension(extension);

    expect(fetchMock).toHaveBeenCalledWith(extension.cssUrl, { cache: 'no-store' });
    expect(document.getElementById(externalStyleId)?.textContent).toBe(css);
    expect(window.localStorage.getItem(THEME_STORAGE_KEYS.externalUrl)).toBe(extension.cssUrl);
    expect(window.localStorage.getItem(THEME_STORAGE_KEYS.externalCss)).toBe(css);
  });

  it('awaits a future resolver before handing control back to the app entry', async () => {
    const weed = BUILTIN_THEME_EXTENSIONS.find((extension) => extension.id === 'weed');
    if (!weed) throw new Error('weed extension missing');
    let resolved = false;
    const resolver = {
      async resolveThemeExtension() {
        await Promise.resolve();
        resolved = true;
        return weed;
      },
    };

    await prepareThemeBeforeMount(resolver);

    expect(resolved).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEYS.builtinId)).toBe('weed');
  });
});
