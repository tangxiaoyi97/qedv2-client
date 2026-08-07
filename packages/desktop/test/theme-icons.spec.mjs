import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ICON_BACKGROUND,
  PWA_ICON_SPECS,
  THEME_ACCENTS,
  generatePwaIcons,
  renderIconPng,
} from '../../web/scripts/gen-icons.mjs'
import {
  DESKTOP_PNG_SIZES,
  NATIVE_ICON_INSET_RATIO,
  THEME_BACKGROUNDS_FILENAME,
  WINDOWS_ICO_SIZES,
  generateThemeIcons,
  renderNativeIconPng,
} from '../scripts/generate-theme-icons.mjs'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const WEB_ROOT = path.resolve(DESKTOP_ROOT, '../web')
const temporaryDirectories = []

const PWA_HASHES = Object.freeze({
  'apple-touch-icon.png': '9853f7e15255dd05b8dccd7cee3a18d6b5185b64092f12ccb1bb5c4410b58f58',
  'icon-192.png': '2da2da6de25ef7105e6f1ec83c209c2640ba7632238c3f388d854de9f1856cde',
  'icon-512.png': '26e7e413e821233d6db418d13a9241c3b989bfe095d979a9c3c154c8d6e0840a',
})

const THEME_PIXEL_HASHES = Object.freeze({
  weed: Object.freeze({
    512: '922d3cc16349cd52c8159b2e72fe2812da42e2096fed742fadacde7d183a766d',
    1024: '15f7d90643a6290dd6b15d13a04b7db5855dc0674c0d8414e6b15800f6da8e76',
  }),
  sky: Object.freeze({
    512: '61747308d9385ddc5755996cb855328595802194214c03500e4e326abd926257',
    1024: '94df946a45485efe65566620a24157bdf8a57ce5b79af3d7d2382039b008b6e6',
  }),
  raspberry: Object.freeze({
    512: '4cb771dc17c5805f9f0a45fe57916b3d38ca00ede53ae172a52d71cbf0d0741d',
    1024: 'f0f612939da64d2655e7b331d9d21f8691553522cb6c717cb7adf40a464d9d42',
  }),
  violette: Object.freeze({
    512: '82bb14c1826c9734f0f6943561d6354d38a83eade06eb3ab8b736f056a846bcb',
    1024: 'd43c265d78f56873520cd4150c61add5ff0ab6660464bd2572a7ceaa72808850',
  }),
})

const ICO_HASHES = Object.freeze({
  weed: 'c490bd103a2c0ff476a2be2f483e9f3ed14a404c51c825ce5ae68f91d8f463fa',
  sky: 'a82d391e53348ca3d39179919a0f1651a818f8512867e460145766de6223d7d7',
  raspberry: '748e7a460c435af5823b1bcaed7cd862bde25b6a2044104c33402efb02b46811',
  violette: 'f4a3969c90e54aa78e072adcefe3e3a0eff7741ffc7d59a1a2ccc62da15a5f1b',
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function decodeGeneratedPng(bytes) {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  let offset = 8
  let width
  let height
  const imageData = []
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    offset += length + 12
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect([...data.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0])
    } else if (type === 'IDAT') {
      imageData.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  expect(width).toBe(height)
  const raw = inflateSync(Buffer.concat(imageData))
  const pixels = Buffer.alloc(width * height * 4)
  const rowLength = width * 4
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * (rowLength + 1)
    expect(raw[rawOffset]).toBe(0)
    raw.copy(pixels, y * rowLength, rawOffset + 1, rawOffset + 1 + rowLength)
  }
  return { width, height, pixels }
}

function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4
  return [...image.pixels.subarray(offset, offset + 4)]
}

function decodeIco(bytes) {
  expect(bytes.readUInt16LE(0)).toBe(0)
  expect(bytes.readUInt16LE(2)).toBe(1)
  const count = bytes.readUInt16LE(4)
  const frames = []
  let expectedOffset = 6 + count * 16
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16
    const width = bytes[entryOffset] || 256
    const height = bytes[entryOffset + 1] || 256
    const length = bytes.readUInt32LE(entryOffset + 8)
    const imageOffset = bytes.readUInt32LE(entryOffset + 12)
    expect(width).toBe(height)
    expect(imageOffset).toBe(expectedOffset)
    frames.push({ size: width, bytes: bytes.subarray(imageOffset, imageOffset + length) })
    expectedOffset += length
  }
  expect(expectedOffset).toBe(bytes.length)
  return frames
}

describe('deterministic theme icon assets', () => {
  it('preserves every shipped PWA icon byte-for-byte', async () => {
    const generatedOut = await mkdtemp(path.join(tmpdir(), 'qed2-pwa-icons-'))
    temporaryDirectories.push(generatedOut)
    generatePwaIcons({ outDir: generatedOut, logger: null })

    for (const { filename, size } of PWA_ICON_SPECS) {
      const shipped = await readFile(path.join(WEB_ROOT, 'public/icons', filename))
      const generated = await readFile(path.join(generatedOut, filename))
      expect(generated).toEqual(shipped)
      expect(generated).toEqual(renderIconPng(size, THEME_ACCENTS.weed))
      expect(sha256(shipped)).toBe(PWA_HASHES[filename])
    }
    expect(sha256(await readFile(path.join(DESKTOP_ROOT, 'build/icon.ico')))).toBe(
      'ffce4bdd6df6dfd5572f389ea221bc5a6b0c558aa578b275e6aa9c9088c1feb5',
    )
  })

  it('regenerates all committed high-resolution PNGs with stable pixels and hashes', async () => {
    const generatedOut = await mkdtemp(path.join(tmpdir(), 'qed2-theme-icons-'))
    temporaryDirectories.push(generatedOut)
    generateThemeIcons({ outDir: generatedOut, logger: null })

    for (const [theme, accent] of Object.entries(THEME_ACCENTS)) {
      for (const size of DESKTOP_PNG_SIZES) {
        const filename = `icon-${size}.png`
        const generated = await readFile(path.join(generatedOut, theme, filename))
        const committed = await readFile(path.join(DESKTOP_ROOT, 'build/theme-icons', theme, filename))
        const image = decodeGeneratedPng(committed)
        const generatedImage = decodeGeneratedPng(generated)
        // Node's bundled zlib may emit different but equivalent IDAT bytes.
        // The decoded pixels are the cross-runtime deterministic contract.
        expect(sha256(generatedImage.pixels)).toBe(sha256(image.pixels))
        expect(sha256(image.pixels)).toBe(THEME_PIXEL_HASHES[theme][size])
        expect([image.width, image.height]).toEqual([size, size])
        expect(pixelAt(image, 0, 0)).toEqual([0, 0, 0, 0])
        expect(pixelAt(image, Math.floor(size / 2), Math.ceil(size * (NATIVE_ICON_INSET_RATIO + 0.02))))
          .toEqual([...ICON_BACKGROUND, 255])
        expect(pixelAt(image, Math.floor(size / 2), Math.floor(size / 2))).toEqual([...accent, 255])
        expect(generated).toEqual(renderNativeIconPng(size, accent))
      }
    }

    expect(await readFile(path.join(DESKTOP_ROOT, 'build/theme-icons/weed/icon-512.png')))
      .not.toEqual(await readFile(path.join(WEB_ROOT, 'public/icons/icon-512.png')))
    expect(
      JSON.parse(await readFile(path.join(generatedOut, THEME_BACKGROUNDS_FILENAME), 'utf8')),
    ).toEqual({
      schemaVersion: 1,
      themes: {
        weed: { light: '#f5f5f6', dark: '#161613' },
        sky: { light: '#f5f7f8', dark: '#16191a' },
        raspberry: { light: '#f8f6f7', dark: '#191617' },
        violette: { light: '#f7f6f9', dark: '#18171b' },
      },
    })
  }, 30_000)

  it('builds deterministic multi-resolution ICOs from the exact same PNG renderer', async () => {
    for (const [theme, accent] of Object.entries(THEME_ACCENTS)) {
      const ico = await readFile(path.join(DESKTOP_ROOT, 'build/theme-icons', theme, 'icon.ico'))
      expect(sha256(ico)).toBe(ICO_HASHES[theme])
      const frames = decodeIco(ico)
      expect(frames.map(({ size }) => size)).toEqual(WINDOWS_ICO_SIZES)
      for (const frame of frames) {
        expect(frame.bytes).toEqual(renderIconPng(frame.size, accent))
        const image = decodeGeneratedPng(frame.bytes)
        expect([image.width, image.height]).toEqual([frame.size, frame.size])
      }
    }
  }, 30_000)
})
