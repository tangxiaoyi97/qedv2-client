#!/usr/bin/env node
/**
 * Generates deterministic Desktop icon sets from the shared Web/PWA renderer.
 * PNGs are used by macOS Dock and BrowserWindow integrations; ICO bundles use
 * PNG frames so Windows packaging never depends on a native converter.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodePng,
  ICON_BACKGROUND,
  THEME_ACCENTS,
  renderIconPng,
} from '../../web/scripts/gen-icons.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_OUT = join(dirname(SCRIPT_PATH), '..', 'build', 'theme-icons');
const SHARED_THEME_ROOT = join(dirname(SCRIPT_PATH), '..', '..', 'ui', 'src', 'styles', 'themes');
export const THEME_BACKGROUNDS_FILENAME = 'theme-backgrounds.v1.json';

export const DESKTOP_PNG_SIZES = Object.freeze([512, 1024]);
export const WINDOWS_ICO_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 128, 256]);
// Apple's 1024px macOS icon template leaves roughly 100px of transparent
// canvas around the continuous rounded tile. Keeping the ratio makes the
// runtime Dock icon and the generated application ICNS occupy the same visual
// footprint at every resolution.
export const NATIVE_ICON_INSET_RATIO = 100 / 1024;
export const NATIVE_ICON_SQUIRCLE_EXPONENT = 5;
const NATIVE_SUPERSAMPLING = 3;
const nativeGeometryCache = new Map();

function nativeIconGeometry(size) {
  const cached = nativeGeometryCache.get(size);
  if (cached) return cached;

  const center = size * 0.5;
  const tileHalf = size * (0.5 - NATIVE_ICON_INSET_RATIO);
  const accentHalf = size * 0.2;
  const tileCoverage = new Uint8Array(size * size);
  const accentCoverage = new Uint8Array(size * size);
  const fifthPower = (value) => {
    const square = value * value;
    return square * square * value;
  };
  const insideTile = (x, y) => {
    const normalizedX = Math.abs(x - center) / tileHalf;
    const normalizedY = Math.abs(y - center) / tileHalf;
    return (
      normalizedX <= 1 &&
      normalizedY <= 1 &&
      fifthPower(normalizedX) + fifthPower(normalizedY) <= 1
    );
  };
  const insideAccent = (x, y) =>
    Math.abs(x - center) <= accentHalf && Math.abs(y - center) <= accentHalf;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixelIndex = y * size + x;
      for (let sampleY = 0; sampleY < NATIVE_SUPERSAMPLING; sampleY += 1) {
        for (let sampleX = 0; sampleX < NATIVE_SUPERSAMPLING; sampleX += 1) {
          const pointX = x + (sampleX + 0.5) / NATIVE_SUPERSAMPLING;
          const pointY = y + (sampleY + 0.5) / NATIVE_SUPERSAMPLING;
          if (!insideTile(pointX, pointY)) continue;
          tileCoverage[pixelIndex] += 1;
          if (insideAccent(pointX, pointY)) accentCoverage[pixelIndex] += 1;
        }
      }
    }
  }

  const geometry = { tileCoverage, accentCoverage };
  nativeGeometryCache.set(size, geometry);
  return geometry;
}

export function renderNativeIconPng(size, accent) {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new TypeError('Native icon size must be a positive integer');
  }
  if (
    !Array.isArray(accent) ||
    accent.length !== 3 ||
    accent.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    throw new TypeError('Native icon accent must be an RGB byte triplet');
  }

  const { tileCoverage, accentCoverage } = nativeIconGeometry(size);
  const sampleCount = NATIVE_SUPERSAMPLING * NATIVE_SUPERSAMPLING;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixelIndex = y * size + x;
      const coveredSamples = tileCoverage[pixelIndex];
      const offset = (y * size + x) * 4;
      if (coveredSamples > 0) {
        const accentSamples = accentCoverage[pixelIndex];
        const backgroundSamples = coveredSamples - accentSamples;
        pixels[offset] = Math.round(
          (ICON_BACKGROUND[0] * backgroundSamples + accent[0] * accentSamples) / coveredSamples,
        );
        pixels[offset + 1] = Math.round(
          (ICON_BACKGROUND[1] * backgroundSamples + accent[1] * accentSamples) / coveredSamples,
        );
        pixels[offset + 2] = Math.round(
          (ICON_BACKGROUND[2] * backgroundSamples + accent[2] * accentSamples) / coveredSamples,
        );
        pixels[offset + 3] = Math.round((coveredSamples / sampleCount) * 255);
      }
    }
  }

  return encodePng(size, pixels);
}

export function encodeIco(images) {
  if (!Array.isArray(images) || images.length === 0 || images.length > 0xffff) {
    throw new TypeError('ICO images must be a non-empty array with at most 65535 entries');
  }

  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // icon resource
  header.writeUInt16LE(images.length, 4);

  let imageOffset = headerSize;
  images.forEach(({ size, bytes }, index) => {
    if (!Number.isSafeInteger(size) || size <= 0 || size > 256 || !Buffer.isBuffer(bytes)) {
      throw new TypeError(`Invalid ICO frame near index ${index}`);
    }
    const entryOffset = 6 + index * 16;
    header[entryOffset] = size === 256 ? 0 : size;
    header[entryOffset + 1] = size === 256 ? 0 : size;
    header[entryOffset + 2] = 0; // true color
    header[entryOffset + 3] = 0; // reserved
    header.writeUInt16LE(0, entryOffset + 4); // preserved from the shipped ICO
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(bytes.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += bytes.length;
  });

  return Buffer.concat([header, ...images.map(({ bytes }) => bytes)]);
}

export function renderThemeIconSet(accent) {
  const pngs = new Map(DESKTOP_PNG_SIZES.map((size) => [size, renderNativeIconPng(size, accent)]));
  const icoFrames = WINDOWS_ICO_SIZES.map((size) => ({ size, bytes: renderIconPng(size, accent) }));
  return { pngs, ico: encodeIco(icoFrames) };
}

/**
 * Derive BrowserWindow's pre-paint color from the same --q-page declarations
 * the renderer consumes. The generated JSON is build output, not a second
 * hand-maintained palette, so native chrome cannot drift from Web/PWA themes.
 */
export function readSharedThemeBackgrounds(themeRoot = SHARED_THEME_ROOT) {
  const themes = {};
  for (const theme of Object.keys(THEME_ACCENTS)) {
    const css = readFileSync(join(themeRoot, `${theme}.css`), 'utf8');
    const pageColors = [...css.matchAll(/--q-page:\s*(#[0-9a-f]{6}(?:[0-9a-f]{2})?)\s*;/giu)]
      .map((match) => match[1].toLowerCase());
    if (pageColors.length !== 2) {
      throw new Error(`${theme}.css must define --q-page exactly once for light and dark mode`);
    }
    themes[theme] = { light: pageColors[0], dark: pageColors[1] };
  }
  return { schemaVersion: 1, themes };
}

export function generateThemeIcons({ outDir = DEFAULT_OUT, logger = console } = {}) {
  mkdirSync(outDir, { recursive: true });
  const generated = new Map();

  for (const [theme, accent] of Object.entries(THEME_ACCENTS)) {
    const themeOut = join(outDir, theme);
    mkdirSync(themeOut, { recursive: true });
    const iconSet = renderThemeIconSet(accent);
    for (const [size, bytes] of iconSet.pngs) {
      const filename = `icon-${size}.png`;
      writeFileSync(join(themeOut, filename), bytes);
      logger?.log?.(`${theme}/${filename} written`);
    }
    writeFileSync(join(themeOut, 'icon.ico'), iconSet.ico);
    logger?.log?.(`${theme}/icon.ico written`);
    generated.set(theme, iconSet);
  }

  const backgrounds = readSharedThemeBackgrounds();
  writeFileSync(
    join(outDir, THEME_BACKGROUNDS_FILENAME),
    `${JSON.stringify(backgrounds, null, 2)}\n`,
  );
  logger?.log?.(`${THEME_BACKGROUNDS_FILENAME} written`);

  return generated;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  generateThemeIcons();
}
