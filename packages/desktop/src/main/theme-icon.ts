import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type DesktopAccent = string;
const SAFE_ACCENT_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu;
const THEME_BACKGROUNDS_FILENAME = 'theme-backgrounds.v1.json';

export interface DesktopThemeBackground {
  light: string;
  dark: string;
}

export type DesktopThemeBackgrounds = Readonly<Record<string, DesktopThemeBackground>>;

export function normalizeDesktopAccent(value: unknown): DesktopAccent {
  // The Web theme registry is authoritative. Electron only enforces a safe
  // directory segment and lets the generated asset set decide whether a new
  // theme exists, so adding a Web theme never requires Desktop source edits.
  return typeof value === 'string' && SAFE_ACCENT_ID.test(value) ? value : 'weed';
}

export function desktopThemeIconPath(
  root: string,
  accent: DesktopAccent,
  platform: NodeJS.Platform = process.platform,
): string {
  const filename = platform === 'win32'
    ? 'icon.ico'
    : platform === 'darwin'
      ? 'icon-1024.png'
      : 'icon-512.png';
  return resolve(root, accent, filename);
}

/** Read build-derived --q-page colors; malformed metadata fails closed. */
export function loadDesktopThemeBackgrounds(root: string): DesktopThemeBackgrounds {
  try {
    const parsed = JSON.parse(
      readFileSync(resolve(root, THEME_BACKGROUNDS_FILENAME), 'utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const record = parsed as { schemaVersion?: unknown; themes?: unknown };
    if (record.schemaVersion !== 1 || !record.themes || typeof record.themes !== 'object') return {};
    const backgrounds: Record<string, DesktopThemeBackground> = {};
    for (const [id, value] of Object.entries(record.themes)) {
      if (!SAFE_ACCENT_ID.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const candidate = value as { light?: unknown; dark?: unknown };
      if (
        typeof candidate.light !== 'string' ||
        typeof candidate.dark !== 'string' ||
        !SAFE_COLOR.test(candidate.light) ||
        !SAFE_COLOR.test(candidate.dark)
      ) continue;
      backgrounds[id] = { light: candidate.light, dark: candidate.dark };
    }
    return backgrounds;
  } catch {
    return {};
  }
}
