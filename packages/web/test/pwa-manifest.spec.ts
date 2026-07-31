import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import weedCss from '../../ui/src/styles/themes/weed.css?inline';
import { PWA_MANIFEST } from '../scripts/pwa-manifest.mjs';
// Loaded through Vite (`?inline` → data URL) rather than node:fs: the web
// package deliberately types only against vite/client, without @types/node.
// A renamed or deleted icon fails this module at import time, which is the
// point — a manifest that points at a missing icon makes the browser fall
// back to a generated letter tile.
import icon192 from '../public/icons/icon-192.png?inline';
import icon512 from '../public/icons/icon-512.png?inline';
import appleTouchIcon from '../public/icons/apple-touch-icon.png?inline';

const SHIPPED_ICONS: Record<string, string> = {
  'icons/icon-192.png': icon192,
  'icons/icon-512.png': icon512,
  'icons/apple-touch-icon.png': appleTouchIcon,
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Signature + IHDR dimensions of a data-URL PNG. */
function pngHeader(src: string): { signature: boolean; width: number; height: number } {
  const dataUrl = SHIPPED_ICONS[src];
  if (!dataUrl) throw new Error(`manifest points at ${src}, which the app does not ship`);
  const bytes = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const at = (offset: number): number => bytes.charCodeAt(offset);
  const uint32 = (offset: number): number =>
    ((at(offset) << 24) | (at(offset + 1) << 16) | (at(offset + 2) << 8) | at(offset + 3)) >>> 0;
  return {
    signature: PNG_SIGNATURE.every((byte, i) => at(i) === byte),
    width: uint32(16),
    height: uint32(20),
  };
}

/**
 * First declaration of a token in the theme file, i.e. the light-mode value.
 * The manifest colors are baked into the installed app once and cannot follow
 * the runtime theme, so light/default is the only sensible source.
 */
function lightThemeToken(token: string): string {
  const value = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(weedCss)?.[1];
  if (!value) throw new Error(`token ${token} not declared in weed.css`);
  return value.trim();
}

const shortestSide = (icon: { sizes: string }): number => Number(icon.sizes.split('x')[0]);

describe('web app manifest', () => {
  it('carries the brand colors instead of the plugin defaults', () => {
    // Regression guard for 1.9.3: deleting these two entries did not make the
    // manifest theme-neutral, it handed the launcher/splash/task-switcher over
    // to vite-plugin-pwa's own defaults — Vue green on white.
    expect(PWA_MANIFEST().theme_color).toBe(lightThemeToken('--q-accent-strong'));
    expect(PWA_MANIFEST().background_color).toBe(lightThemeToken('--q-page'));
    expect(PWA_MANIFEST().theme_color).not.toBe('#42b883');
    expect(PWA_MANIFEST().background_color).not.toBe('#ffffff');
  });

  it('pins the app identity and scope explicitly', () => {
    expect(PWA_MANIFEST().id).toBe('/');
    expect(PWA_MANIFEST().start_url).toBe('/');
    expect(PWA_MANIFEST().scope).toBe('/');
    expect(PWA_MANIFEST().display).toBe('standalone');
  });

  it('declares icons that exist and match their declared size', () => {
    for (const icon of PWA_MANIFEST().icons) {
      const width = shortestSide(icon);
      expect(pngHeader(icon.src), icon.src).toEqual({ signature: true, width, height: width });
    }
  });

  it('offers an installable and a maskable icon of at least 192px', () => {
    // Chrome refuses to install without a >=192px `any` icon and falls back to
    // a generated letter tile on theme_color; without a maskable one, Android
    // launchers shrink the square tile into a white circle.
    const usable = (purpose: string) =>
      PWA_MANIFEST().icons.filter((i) => i.purpose === purpose && shortestSide(i) >= 192);
    expect(usable('any').length).toBeGreaterThan(0);
    expect(usable('maskable').length).toBeGreaterThan(0);
  });

  it('ships the iOS home-screen icon referenced by the HTML shell', () => {
    // iOS ignores the manifest here and reads <link rel="apple-touch-icon">.
    const href = /rel="apple-touch-icon"\s+href="\/([^"]+)"/.exec(indexHtml)?.[1];
    expect(href).toBeDefined();
    expect(pngHeader(href as string)).toEqual({ signature: true, width: 180, height: 180 });
  });
});

/**
 * The preview build installs as its own app on its own origin. Identical
 * names and icons on the home screen is how you end up doing real work in the
 * wrong environment.
 */
describe('channel identity', () => {
  it('gives the preview build a distinct name and colour', () => {
    const stable = PWA_MANIFEST('stable');
    const preview = PWA_MANIFEST('preview');
    expect(stable.name).toBe('QED2 — Matura Mathematik');
    expect(preview.name).toBe('QED2 Preview');
    expect(preview.short_name).not.toBe(stable.short_name);
    expect(preview.theme_color).not.toBe(stable.theme_color);
  });

  it('defaults to the stable identity', () => {
    expect(PWA_MANIFEST().name).toBe(PWA_MANIFEST('stable').name);
    // An unknown channel must not silently produce a preview-looking build.
    expect(PWA_MANIFEST('nonsense').name).toBe(PWA_MANIFEST('stable').name);
  });
});
