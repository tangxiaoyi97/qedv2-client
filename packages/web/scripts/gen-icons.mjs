#!/usr/bin/env node
/**
 * Deterministic QED2 icon renderer — a warm light tile with a centered
 * accent-strong square. No native image dependencies: raw RGBA with 3x3
 * supersampling is encoded by the same minimal PNG writer used for the
 * original green PWA icons.
 *
 * Run: node scripts/gen-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PWA_OUT = join(dirname(SCRIPT_PATH), '..', 'public', 'icons');

export const ICON_BACKGROUND = Object.freeze([0xf4, 0xf3, 0xee]);
export const THEME_ACCENTS = Object.freeze({
  weed: Object.freeze([0x5f, 0x6b, 0x2e]),
  sky: Object.freeze([0x1d, 0x5f, 0x75]),
  raspberry: Object.freeze([0x96, 0x30, 0x4f]),
  violette: Object.freeze([0x5b, 0x3f, 0xa8]),
});

export const PWA_ICON_SPECS = Object.freeze([
  Object.freeze({ filename: 'icon-192.png', size: 192 }),
  Object.freeze({ filename: 'icon-512.png', size: 512 }),
  Object.freeze({ filename: 'apple-touch-icon.png', size: 180 }),
]);

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function renderIconPng(size, accent = THEME_ACCENTS.weed) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError('Icon size must be a positive integer');
  if (!Array.isArray(accent) || accent.length !== 3 || accent.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    throw new TypeError('Icon accent must be an RGB byte triplet');
  }

  // Geometry in fractions of the size. These values intentionally remain
  // identical to the original PWA renderer.
  const cx = size * 0.5;
  const cy = size * 0.5;
  const half = size * 0.2; // theme square half-edge (sharp corners)

  const inSquare = (x, y) => Math.abs(x - cx) <= half && Math.abs(y - cy) <= half;
  const colorAt = (x, y) => (inSquare(x, y) ? accent : ICON_BACKGROUND);

  const SS = 3; // supersampling per axis
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const color = colorAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const sampleCount = SS * SS;
      const index = (y * size + x) * 4;
      px[index] = Math.round(r / sampleCount);
      px[index + 1] = Math.round(g / sampleCount);
      px[index + 2] = Math.round(b / sampleCount);
      px[index + 3] = 255;
    }
  }
  return encodePng(size, px);
}

export function generatePwaIcons({ outDir = DEFAULT_PWA_OUT, logger = console } = {}) {
  mkdirSync(outDir, { recursive: true });
  return PWA_ICON_SPECS.map(({ filename, size }) => {
    const bytes = renderIconPng(size, THEME_ACCENTS.weed);
    writeFileSync(join(outDir, filename), bytes);
    logger?.log?.(`${filename} written`);
    return { filename, size, bytes };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  generatePwaIcons();
}
