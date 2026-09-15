import {
  currentBuiltinThemeId,
  mirrorThemeAppearance,
  readThemeAppearance,
  THEME_PREFERENCES_EVENT,
  THEME_STORAGE_KEYS,
  type ThemeAppearance,
} from '../platform/theme-preferences.js';
import { readLegacyThemeAppearance } from './legacy-theme.js';

/** Share Client colors without loading its runtime or applying external CSS. */
export async function startAdminTheme(): Promise<() => void> {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let legacyFallback: ThemeAppearance | undefined;
  const apply = (): void => {
    const appearance = readThemeAppearance() ?? legacyFallback ?? 'system';
    const root = document.documentElement;
    root.dataset.theme = appearance === 'dark' || (appearance === 'system' && media.matches)
      ? 'dark' : 'light';
    const accent = currentBuiltinThemeId();
    if (accent === 'weed') delete root.dataset.accent;
    else root.dataset.accent = accent;
    const color = getComputedStyle(root).getPropertyValue('--q-page').trim();
    if (color) {
      let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'theme-color';
        document.head.appendChild(meta);
      }
      meta.content = color;
    }
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === THEME_STORAGE_KEYS.appearance || event.key === THEME_STORAGE_KEYS.builtinId) {
      legacyFallback = undefined;
      apply();
    }
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') apply();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', apply);
  window.addEventListener(THEME_PREFERENCES_EVENT, apply);
  document.addEventListener('visibilitychange', onVisible);
  media.addEventListener('change', apply);

  if (readThemeAppearance() === undefined) {
    const legacy = await readLegacyThemeAppearance();
    // A setting saved in another tab while reading takes precedence.
    if (legacy !== undefined && readThemeAppearance() === undefined) {
      legacyFallback = legacy;
      mirrorThemeAppearance(legacy);
    }
  }
  apply();

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', apply);
    window.removeEventListener(THEME_PREFERENCES_EVENT, apply);
    document.removeEventListener('visibilitychange', onVisible);
    media.removeEventListener('change', apply);
  };
}
