#!/usr/bin/env node
/**
 * Generates deterministic Desktop icon sets from the shared Web/PWA renderer.
 * PNGs are used by macOS Dock and BrowserWindow integrations; ICO bundles use
 * PNG frames so Windows packaging never depends on a native converter.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
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
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BYTES_PER_PIXEL = 4;
const PNG_FILE_SYSTEM = Object.freeze({ renameSync, rmSync, writeFileSync });
let pngTemporarySequence = 0;

const PNG_CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < PNG_CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  PNG_CRC_TABLE[index] = value >>> 0;
}

function pngCrc32(...buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngError(label, message) {
  return new Error(`${label}: ${message}`);
}

function paethPredictor(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

/**
 * Decode the strict RGBA PNG subset emitted for Desktop icons. Compression
 * bytes and scanline filters are deliberately excluded from the result: Node
 * releases may bundle different zlib versions while rendering identical
 * pixels. CRCs and the complete PNG structure are still verified so a damaged
 * file is never mistaken for a semantic match.
 */
export function decodeRgbaPng(bytes, expectedSize, label = 'PNG') {
  if (!Buffer.isBuffer(bytes)) throw pngError(label, 'contents must be a Buffer');
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw pngError(label, 'expected size must be a positive integer');
  }
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw pngError(label, 'signature is invalid');
  }

  let offset = PNG_SIGNATURE.length;
  let width;
  let height;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  const imageData = [];

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw pngError(label, 'contains a truncated chunk header');
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(dataEnd) || chunkEnd > bytes.length) {
      throw pngError(label, 'contains a truncated chunk payload');
    }
    const typeBytes = bytes.subarray(typeStart, dataStart);
    if (![...typeBytes].every((byte) =>
      (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) {
      throw pngError(label, 'contains an invalid chunk type');
    }
    // PNG reserves bit 5 of the third type byte. Accepting a lowercase byte
    // here would make a future chunk definition ambiguous to this decoder.
    if ((typeBytes[2] & 0x20) !== 0) throw pngError(label, 'contains a chunk with an invalid reserved bit');
    const type = typeBytes.toString('ascii');
    const data = bytes.subarray(dataStart, dataEnd);
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (pngCrc32(typeBytes, data) !== expectedCrc) {
      throw pngError(label, `${type} chunk checksum is invalid`);
    }
    offset = chunkEnd;

    if (!sawHeader && type !== 'IHDR') throw pngError(label, 'IHDR must be the first chunk');
    if (type === 'IHDR') {
      if (sawHeader) throw pngError(label, 'contains more than one IHDR chunk');
      if (data.length !== 13) throw pngError(label, 'IHDR has an invalid length');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (width !== expectedSize || height !== expectedSize) {
        throw pngError(label, `dimensions are ${width}x${height}, expected ${expectedSize}x${expectedSize}`);
      }
      if (
        data[8] !== 8 ||
        data[9] !== 6 ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        throw pngError(label, 'must be non-interlaced 8-bit RGBA');
      }
      sawHeader = true;
      continue;
    }
    if (type === 'IDAT') {
      sawImageData = true;
      imageData.push(data);
      continue;
    }
    if (type === 'IEND') {
      if (data.length !== 0) throw pngError(label, 'IEND must be empty');
      if (!sawImageData) throw pngError(label, 'contains no IDAT data');
      if (offset !== bytes.length) throw pngError(label, 'contains bytes after IEND');
      sawEnd = true;
      break;
    }
    // Color-management and animation ancillary chunks can change rendering
    // semantics without changing the stored RGBA samples. The generator emits
    // only IHDR + consecutive IDAT + IEND, so rebuild anything outside that
    // exact, auditable subset instead of guessing whether it is equivalent.
    throw pngError(label, `contains unsupported chunk ${type}`);
  }

  if (!sawEnd) throw pngError(label, 'contains no IEND chunk');
  const rowBytes = width * PNG_BYTES_PER_PIXEL;
  const inflatedSize = (rowBytes + 1) * height;
  if (!Number.isSafeInteger(inflatedSize)) throw pngError(label, 'decoded size is unsafe');

  const compressed = Buffer.concat(imageData);
  let inflation;
  try {
    inflation = inflateSync(compressed, { maxOutputLength: inflatedSize, info: true });
  } catch (error) {
    throw new Error(`${label}: IDAT data cannot be decoded`, { cause: error });
  }
  const filtered = inflation.buffer;
  if (inflation.engine.bytesWritten !== compressed.length) {
    throw pngError(label, 'IDAT data contains trailing compressed input');
  }
  if (filtered.length !== inflatedSize) {
    throw pngError(label, `decoded byte length is ${filtered.length}, expected ${inflatedSize}`);
  }

  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const filteredRow = y * (rowBytes + 1);
    const filter = filtered[filteredRow];
    if (filter > 4) throw pngError(label, `scanline ${y} uses unsupported filter ${filter}`);
    const pixelRow = y * rowBytes;
    const previousRow = pixelRow - rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const encoded = filtered[filteredRow + 1 + x];
      const left = x >= PNG_BYTES_PER_PIXEL ? pixels[pixelRow + x - PNG_BYTES_PER_PIXEL] : 0;
      const up = y > 0 ? pixels[previousRow + x] : 0;
      const upperLeft = y > 0 && x >= PNG_BYTES_PER_PIXEL
        ? pixels[previousRow + x - PNG_BYTES_PER_PIXEL]
        : 0;
      const predictor = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : paethPredictor(left, up, upperLeft);
      pixels[pixelRow + x] = (encoded + predictor) & 0xff;
    }
  }
  return pixels;
}

function writeGeneratedPng(path, bytes, label, reason, logger, fileSystem) {
  const temporaryPath = `${path}.${process.pid}.${pngTemporarySequence += 1}.tmp`;
  try {
    fileSystem.writeFileSync(temporaryPath, bytes, { flag: 'wx' });
    fileSystem.renameSync(temporaryPath, path);
  } catch (error) {
    try {
      fileSystem.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new Error(`Could not write ${label} or clean its temporary file (${reason})`, {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw new Error(`Could not write ${label} (${reason})`, { cause: error });
  }
  logger?.log?.(`${label} written (${reason})`);
}

/** Keep the repository's PNG bytes when only the zlib representation differs. */
export function writePngIfPixelsChanged(
  path,
  generatedBytes,
  size,
  { label = path, logger = console, fileSystem = PNG_FILE_SYSTEM } = {},
) {
  const generatedPixels = decodeRgbaPng(generatedBytes, size, `generated ${label}`);
  let existingBytes;
  try {
    existingBytes = readFileSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Could not read existing ${label}`, { cause: error });
    }
    writeGeneratedPng(path, generatedBytes, label, 'missing PNG rebuilt', logger, fileSystem);
    return { written: true, reason: 'missing' };
  }

  let existingPixels;
  try {
    existingPixels = decodeRgbaPng(existingBytes, size, `existing ${label}`);
  } catch (error) {
    writeGeneratedPng(path, generatedBytes, label, `invalid PNG rebuilt: ${error.message}`, logger, fileSystem);
    return { written: true, reason: 'invalid-existing' };
  }
  if (existingPixels.equals(generatedPixels)) {
    logger?.log?.(`${label} kept (decoded RGBA pixels unchanged)`);
    return { written: false, reason: 'pixels-unchanged' };
  }

  writeGeneratedPng(path, generatedBytes, label, 'decoded RGBA pixels changed', logger, fileSystem);
  return { written: true, reason: 'pixels-changed' };
}

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
      const label = `${theme}/${filename}`;
      writePngIfPixelsChanged(join(themeOut, filename), bytes, size, { label, logger });
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
