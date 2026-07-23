import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import tokensCss from '../../ui/src/styles/tokens.css?inline';
import weedCss from '../../ui/src/styles/themes/weed.css?inline';
import skyCss from '../../ui/src/styles/themes/sky.css?inline';
import raspberryCss from '../../ui/src/styles/themes/raspberry.css?inline';
import violetteCss from '../../ui/src/styles/themes/violette.css?inline';
import {
  BUILTIN_THEME_EXTENSIONS,
  THEME_CSS_TOKENS,
} from '../src/platform/theme.js';

const parsed = new DOMParser().parseFromString(indexHtml, 'text/html');
const bootstrapScript =
  parsed.querySelector<HTMLScriptElement>('#theme-bootstrap')?.textContent ?? '';
const bootStyles = parsed.querySelector<HTMLStyleElement>('#boot-styles')?.textContent ?? '';

const builtinCss = {
  weed: weedCss,
  sky: skyCss,
  raspberry: raspberryCss,
  violette: violetteCss,
} as const;

interface FakeStyle {
  id: string;
  textContent: string;
}

interface FakeRoot {
  dataset: Record<string, string>;
  removeAttribute(name: string): void;
}

function runThemeBootstrap(options?: {
  dark?: boolean;
  storage?: { getItem(key: string): string | null };
  storageAccessError?: boolean;
}): { root: FakeRoot; appended: FakeStyle[] } {
  const root: FakeRoot = {
    dataset: {},
    removeAttribute(name) {
      if (name === 'data-accent') delete this.dataset.accent;
    },
  };
  const appended: FakeStyle[] = [];
  const fakeDocument = {
    documentElement: root,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (style: FakeStyle) => appended.push(style) },
  };
  const fakeWindow = {
    matchMedia: () => ({ matches: options?.dark ?? false }),
  };
  if (options?.storageAccessError) {
    Object.defineProperty(fakeWindow, 'localStorage', {
      get() {
        throw new Error('storage blocked');
      },
    });
  } else if (options?.storage) {
    Object.assign(fakeWindow, { localStorage: options.storage });
  }
  Function('window', 'document', bootstrapScript)(fakeWindow, fakeDocument);
  return { root, appended };
}

function declarationCount(css: string, token: string): number {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escaped}\\s*:`, 'g'))].length;
}

describe('pre-app CSS theme bootstrap', () => {
  it.each(BUILTIN_THEME_EXTENSIONS)(
    'selects the saved $id extension before the application module',
    (extension) => {
      const { root } = runThemeBootstrap({
        storage: {
          getItem: (key) => (key === 'qed2.accent' ? extension.id : null),
        },
      });
      expect(root.dataset.accent).toBe(extension.id);
      expect(indexHtml.indexOf('id="theme-bootstrap"')).toBeLessThan(
        indexHtml.indexOf('type="module"'),
      );
    },
  );

  it('selects the initial light/dark mode without embedding palette data', () => {
    expect(runThemeBootstrap().root.dataset.theme).toBe('light');
    expect(runThemeBootstrap({ dark: true }).root.dataset.theme).toBe('dark');
    expect(bootstrapScript).not.toMatch(/#[\da-f]{3,8}|rgba?\(|hsla?\(/i);
  });

  it.each([
    ['missing localStorage', {}],
    ['blocked localStorage', { storageAccessError: true }],
  ])('falls back safely to the default CSS extension for %s', (_case, options) => {
    const { root, appended } = runThemeBootstrap(options);
    expect(root.dataset.accent).toBeUndefined();
    expect(appended).toEqual([]);
  });

  it('injects a cached external CSS extension before the app starts', () => {
    const css = ':root { --q-page: Canvas; }';
    const { root, appended } = runThemeBootstrap({
      storage: {
        getItem: (key) => (key === 'qed2.themeCss' ? css : 'sky'),
      },
    });
    expect(root.dataset.accent).toBeUndefined();
    expect(appended).toEqual([
      { id: 'qed2-external-theme', textContent: css },
    ]);
  });

  it('loads the built-in CSS-extension bundle before boot markup and app code', () => {
    const themeLinkIndex = indexHtml.indexOf('href="/src/styles/theme-extensions.css"');
    const bootstrapIndex = indexHtml.indexOf('id="theme-bootstrap"');
    const moduleIndex = indexHtml.indexOf('type="module"');
    expect(themeLinkIndex).toBeGreaterThan(-1);
    expect(themeLinkIndex).toBeLessThan(bootstrapIndex);
    expect(bootstrapIndex).toBeLessThan(moduleIndex);
  });

  it('keeps boot layout palette-free and consumes only the theme contract', () => {
    expect(bootStyles).not.toMatch(/#[\da-f]{3,8}|rgba?\(|hsla?\(/i);
    expect(bootStyles).toContain('background: var(--q-page)');
    expect(bootStyles).toContain('color: var(--q-ink)');
    expect(bootStyles).toContain('color: var(--q-accent)');
    expect(bootStyles).toContain('background: var(--q-track)');
    expect(bootStyles).toContain('color: var(--q-mut-2)');
  });

  it('keeps theme values out of the theme-independent token module', () => {
    for (const token of THEME_CSS_TOKENS) {
      expect(declarationCount(tokensCss, token), token).toBe(0);
    }
  });

  it.each(BUILTIN_THEME_EXTENSIONS)(
    'defines the complete light/dark contract in one $id CSS file',
    (extension) => {
      const css = builtinCss[extension.id];
      for (const token of THEME_CSS_TOKENS) {
        expect(declarationCount(css, token), `${extension.id}: ${token}`).toBeGreaterThanOrEqual(2);
      }
    },
  );

  it('does not hard-code a built-in theme allowlist in the HTML bootstrap', () => {
    expect(bootstrapScript).not.toContain('sky');
    expect(bootstrapScript).not.toContain('raspberry');
    expect(bootstrapScript).not.toContain('violette');
    expect(bootstrapScript).not.toContain('weed');
  });
});
