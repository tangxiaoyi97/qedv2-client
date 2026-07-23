/**
 * Accent theme system.
 *
 * Built-in accents ship as overlay stylesheets (packages/ui/src/styles/
 * themes/*.css) keyed off `html[data-accent]`; the base palette (olive) is
 * the default when no attribute is set.
 *
 * FUTURE (next major): user-supplied themes — a full stylesheet living at
 * any URL (stored per-account in the user library, synced by the server)
 * that REPLACES the built-in tokens instead of just accenting them. The
 * seams are already here: `applyExternalTheme(cssText)` injects a <style>
 * that overrides everything below it, `loadExternalTheme(url)` fetches +
 * caches it, and `initThemeEarly()` runs before first paint so a stored
 * URL can be applied without a flash of the default palette.
 */

export type AccentId = 'weed' | 'sky' | 'raspberry' | 'violette';

export interface AccentSpec {
  id: AccentId;
  /** Unified English names — used for labels AND hover/aria text. */
  label: string;
  /** Swatch color shown in settings. */
  color: string;
  /** Surface and semantic colors for the picker preview. */
  preview: {
    page: string;
    card: string;
    muted: string;
    states: readonly [string, string, string];
  };
}

export const ACCENTS: readonly AccentSpec[] = [
  {
    id: 'weed',
    label: 'weed',
    color: '#8e9c49',
    preview: {
      page: '#f5f5f6',
      card: '#ffffff',
      muted: '#eef0e6',
      states: ['#2f7d54', '#b07d1f', '#b4462f'],
    },
  },
  {
    id: 'sky',
    label: 'sky',
    color: '#287f9d',
    preview: {
      page: '#f6f6f7',
      card: '#ffffff',
      muted: '#ecf5f9',
      states: ['#28765b', '#96641d', '#b3483e'],
    },
  },
  {
    id: 'raspberry',
    label: 'raspberry',
    color: '#c43b70',
    preview: {
      page: '#f6f6f7',
      card: '#ffffff',
      muted: '#fbeef3',
      states: ['#3b7655', '#94621f', '#b73d54'],
    },
  },
  {
    id: 'violette',
    label: 'violette',
    color: '#7c5acf',
    preview: {
      page: '#f6f6f7',
      card: '#ffffff',
      muted: '#f2eefb',
      states: ['#2f7664', '#946924', '#b14058'],
    },
  },
] as const;

const ACCENT_KEY = 'qed2.accent';
const EXTERNAL_URL_KEY = 'qed2.themeUrl';
const EXTERNAL_CSS_KEY = 'qed2.themeCss';
const STYLE_ID = 'qed2-external-theme';

function isAccentId(v: string | null): v is AccentId {
  return v != null && ACCENTS.some((a) => a.id === v);
}

/** Current accent (localStorage; 'weed' when unset). */
export function currentAccent(): AccentId {
  try {
    const v = window.localStorage.getItem(ACCENT_KEY);
    return isAccentId(v) ? v : 'weed';
  } catch {
    return 'weed';
  }
}

/** Apply + persist a built-in accent. Clears any external theme. */
export function setAccent(id: AccentId): void {
  clearExternalTheme();
  if (id === 'weed') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = id;
  try {
    window.localStorage.setItem(ACCENT_KEY, id);
    window.localStorage.removeItem(EXTERNAL_URL_KEY);
    window.localStorage.removeItem(EXTERNAL_CSS_KEY);
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
    document.head.appendChild(el);
  }
  el.textContent = cssText;
}

export function clearExternalTheme(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/**
 * Fetch a theme URL and apply it, caching the css text so the next boot
 * can paint it without a network round-trip (offline-friendly, PWA-style).
 * Reserved for the account-synced theme setting; today nothing calls this
 * before `setAccent` clears it.
 */
export async function loadExternalTheme(url: string): Promise<void> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`theme fetch failed: ${res.status}`);
  const cssText = await res.text();
  applyExternalTheme(cssText);
  try {
    window.localStorage.setItem(EXTERNAL_URL_KEY, url);
    window.localStorage.setItem(EXTERNAL_CSS_KEY, cssText);
  } catch {
    /* cache miss next time — acceptable */
  }
}

/**
 * Pre-paint theme bootstrap (call as early as possible in main.ts):
 *  - built-in accent → just the html attribute (no flash);
 *  - stored external theme → apply the cached css immediately; the next
 *    version will revalidate it against the server-side user library.
 */
export function initThemeEarly(): void {
  try {
    const externalCss = window.localStorage.getItem(EXTERNAL_CSS_KEY);
    if (externalCss) {
      applyExternalTheme(externalCss);
      return;
    }
    const accent = currentAccent();
    if (accent !== 'weed') document.documentElement.dataset.accent = accent;
  } catch {
    /* storage unavailable — default palette */
  }
}
