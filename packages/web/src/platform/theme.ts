/**
 * CSS theme-extension system.
 *
 * A theme is one stylesheet that owns the complete visual --q-* contract
 * for light and dark mode. The same tokens render index.html's boot UI and
 * the mounted application; no palette data is duplicated in JavaScript or
 * the HTML shell.
 *
 * FUTURE (next major): the server/user library can return an
 * ExternalCssThemeExtension. Its CSS URL is fetched, cached, and applied
 * before mount through the existing activation seam below. The account and
 * server plumbing is intentionally not part of this version.
 */

export type BuiltinThemeId = 'weed' | 'sky' | 'raspberry' | 'violette';

export interface BuiltinThemeExtension {
  kind: 'builtin-css';
  id: BuiltinThemeId;
  label: string;
}

/** Future server/user-library record for a single external theme stylesheet. */
export interface ExternalCssThemeExtension {
  kind: 'external-css';
  id: string;
  label: string;
  cssUrl: string;
}

export type ThemeExtension = BuiltinThemeExtension | ExternalCssThemeExtension;

/**
 * Next-major adapter boundary. A server/user-library implementation resolves
 * the active record; the theme module remains unaware of accounts or APIs.
 */
export interface ThemeExtensionResolver {
  resolveThemeExtension(): Promise<ThemeExtension | undefined>;
}

export const BUILTIN_THEME_EXTENSIONS: readonly BuiltinThemeExtension[] = [
  { kind: 'builtin-css', id: 'weed', label: 'weed' },
  { kind: 'builtin-css', id: 'sky', label: 'sky' },
  { kind: 'builtin-css', id: 'raspberry', label: 'raspberry' },
  { kind: 'builtin-css', id: 'violette', label: 'violette' },
] as const;

/**
 * Required variables for a standalone CSS theme extension.
 * Extensions may additionally override component CSS, but these tokens must
 * be supplied for both light and dark selectors so the shell can render them
 * before Vue starts.
 */
export const THEME_CSS_TOKENS = [
  '--q-page',
  '--q-card',
  '--q-panel',
  '--q-panel-2',
  '--q-track',
  '--q-dot-off',
  '--q-cta-card',
  '--q-cta-card-label',
  '--q-cta-card-text',
  '--q-ink',
  '--q-ink-2',
  '--q-mut',
  '--q-mut-2',
  '--q-faint',
  '--q-disabled',
  '--q-hint',
  '--q-border',
  '--q-border-2',
  '--q-border-3',
  '--q-border-soft',
  '--q-check-border',
  '--q-btn-border',
  '--q-accent',
  '--q-accent-strong',
  '--q-accent-bg',
  '--q-accent-ring',
  '--q-on-accent',
  '--q-chip-bg',
  '--q-chip-border',
  '--q-chip-ink',
  '--q-ok',
  '--q-ok-bg',
  '--q-ok-bg-2',
  '--q-ok-border',
  '--q-ok-ink',
  '--q-on-ok',
  '--q-err',
  '--q-err-bg',
  '--q-err-border',
  '--q-err-ink',
  '--q-on-err',
  '--q-part',
  '--q-part-bg',
  '--q-part-border',
  '--q-part-ink',
  '--q-part-ink-2',
  '--q-neutral',
  '--q-neutral-bg',
  '--q-neutral-border',
  '--q-shadow-card',
  '--q-shadow-panel',
  '--q-shadow-modal',
  '--q-backdrop-filter',
] as const;

export type ThemeCssToken = (typeof THEME_CSS_TOKENS)[number];

export const THEME_STORAGE_KEYS = {
  builtinId: 'qed2.accent',
  externalUrl: 'qed2.themeUrl',
  externalCss: 'qed2.themeCss',
} as const;

const STYLE_ID = 'qed2-external-theme';

function isBuiltinThemeId(v: string | null): v is BuiltinThemeId {
  return v != null && BUILTIN_THEME_EXTENSIONS.some((theme) => theme.id === v);
}

function applyBuiltinThemeToDom(id: BuiltinThemeId): void {
  if (id === 'weed') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = id;
}

/** Keep browser/PWA chrome aligned without duplicating a color outside CSS. */
export function syncThemeColorFromCss(): void {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--q-page').trim();
  if (!color) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = color;
}

/** Current built-in extension (localStorage; weed when unset or invalid). */
export function currentBuiltinThemeId(): BuiltinThemeId {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEYS.builtinId);
    return isBuiltinThemeId(v) ? v : 'weed';
  } catch {
    return 'weed';
  }
}

/** Apply + persist a built-in CSS extension. Clears any external theme. */
export function setBuiltinThemeExtension(id: BuiltinThemeId): void {
  clearExternalTheme();
  applyBuiltinThemeToDom(id);
  syncThemeColorFromCss();
  try {
    window.localStorage.setItem(THEME_STORAGE_KEYS.builtinId, id);
    window.localStorage.removeItem(THEME_STORAGE_KEYS.externalUrl);
    window.localStorage.removeItem(THEME_STORAGE_KEYS.externalCss);
  } catch {
    /* private mode — theme just won't persist */
  }
}

/* ------------------------------------------------------------------ *
 * External theme seam (reserved for the server-synced user theme).
 * ------------------------------------------------------------------ */

/**
 * Inject a full replacement theme. The <style> tag is appended LAST in
 * <head>, so its rules override every built-in token — this is the "user
 * css completely replaces the built-in theme" path.
 */
export function applyExternalTheme(cssText: string): void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
  }
  el.textContent = cssText;
  delete document.documentElement.dataset.accent;
  // Re-appending moves a cached pre-paint style after the application CSS,
  // allowing one external stylesheet to fully override the built-ins.
  document.head.appendChild(el);
  syncThemeColorFromCss();
}

export function clearExternalTheme(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/**
 * Fetch a theme URL and apply it, caching the css text so the next boot
 * can paint it without a network round-trip (offline-friendly, PWA-style).
 * Reserved for the account-synced theme setting; today nothing calls this
 * before `setBuiltinThemeExtension` clears it.
 */
export async function loadExternalTheme(
  source: string | ExternalCssThemeExtension,
): Promise<void> {
  const url = typeof source === 'string' ? source : source.cssUrl;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`theme fetch failed: ${res.status}`);
  const cssText = await res.text();
  applyExternalTheme(cssText);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEYS.externalUrl, url);
    window.localStorage.setItem(THEME_STORAGE_KEYS.externalCss, cssText);
  } catch {
    /* cache miss next time — acceptable */
  }
}

/**
 * Common activation seam for today's built-ins and a future user-library
 * ExternalCssThemeExtension. The settings UI only passes built-ins today.
 */
export async function activateThemeExtension(extension: ThemeExtension): Promise<void> {
  if (extension.kind === 'builtin-css') {
    setBuiltinThemeExtension(extension.id);
    return;
  }
  await loadExternalTheme(extension);
}

/**
 * Pre-paint theme bootstrap (call as early as possible in main.ts):
 *  - index.html has already selected the built-in CSS extension and injected
 *    cached external CSS synchronously for the boot UI;
 *  - this call validates the built-in id or moves cached external CSS after
 *    application styles before Vue mounts.
 */
export function initThemeEarly(): void {
  try {
    const externalCss = window.localStorage.getItem(THEME_STORAGE_KEYS.externalCss);
    if (externalCss) {
      applyExternalTheme(externalCss);
      return;
    }
    applyBuiltinThemeToDom(currentBuiltinThemeId());
    syncThemeColorFromCss();
  } catch {
    applyBuiltinThemeToDom('weed');
    syncThemeColorFromCss();
  }
}

/**
 * Single pre-mount entrypoint. Today it only reapplies the synchronous cache.
 * A future resolver may return an external CSS URL; activation is awaited so
 * the application never mounts between the old and replacement stylesheets.
 */
export async function prepareThemeBeforeMount(
  resolver?: ThemeExtensionResolver,
): Promise<void> {
  initThemeEarly();
  if (!resolver) return;
  const extension = await resolver.resolveThemeExtension();
  if (extension) await activateThemeExtension(extension);
}
