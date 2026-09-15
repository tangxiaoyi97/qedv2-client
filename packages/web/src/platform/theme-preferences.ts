/** Browser appearance preferences only; no application state or CSS injection. */
export type ThemeAppearance = 'light' | 'dark' | 'system';
export type BuiltinThemeId = 'weed' | 'sky' | 'raspberry' | 'violette';

export interface BuiltinThemeExtension {
  kind: 'builtin-css';
  id: BuiltinThemeId;
  label: string;
}

export const BUILTIN_THEME_EXTENSIONS: readonly BuiltinThemeExtension[] = [
  { kind: 'builtin-css', id: 'weed', label: 'weed' },
  { kind: 'builtin-css', id: 'sky', label: 'sky' },
  { kind: 'builtin-css', id: 'raspberry', label: 'raspberry' },
  { kind: 'builtin-css', id: 'violette', label: 'violette' },
] as const;

export const THEME_STORAGE_KEYS = {
  builtinId: 'qed2.accent',
  appearance: 'qed2.appearance',
  externalUrl: 'qed2.themeUrl',
  externalCss: 'qed2.themeCss',
} as const;

export const THEME_PREFERENCES_EVENT = 'qed2-theme-preferences';

export function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function isBuiltinThemeId(value: unknown): value is BuiltinThemeId {
  return BUILTIN_THEME_EXTENSIONS.some((theme) => theme.id === value);
}

export function readThemeAppearance(): ThemeAppearance | undefined {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEYS.appearance);
    return isThemeAppearance(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function currentBuiltinThemeId(): BuiltinThemeId {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEYS.builtinId);
    return isBuiltinThemeId(value) ? value : 'weed';
  } catch {
    return 'weed';
  }
}

export function notifyThemePreferencesChanged(): void {
  window.dispatchEvent(new Event(THEME_PREFERENCES_EVENT));
}

/** Mirror the successfully loaded/saved learner preference for independent pages. */
export function mirrorThemeAppearance(value: ThemeAppearance): void {
  if (!isThemeAppearance(value)) return;
  try {
    if (window.localStorage.getItem(THEME_STORAGE_KEYS.appearance) === value) return;
    window.localStorage.setItem(THEME_STORAGE_KEYS.appearance, value);
    notifyThemePreferencesChanged();
  } catch {
    // A denied browser preference store must not block either application.
  }
}
