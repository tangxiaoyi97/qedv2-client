import { createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
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
  writePngIfPixelsChanged,
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

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}

function paethPredictor(left, up, upperLeft) {
  const prediction = left + up - upperLeft
  const leftDistance = Math.abs(prediction - left)
  const upDistance = Math.abs(prediction - up)
  const upperLeftDistance = Math.abs(prediction - upperLeft)
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left
  if (upDistance <= upperLeftDistance) return up
  return upperLeft
}

function encodeEquivalentPng(size, pixels, compressionLevel, filters = [0]) {
  const rowBytes = size * 4
  const filtered = Buffer.alloc((rowBytes + 1) * size)
  for (let y = 0; y < size; y += 1) {
    const filter = filters[y % filters.length]
    const filteredRow = y * (rowBytes + 1)
    const pixelRow = y * rowBytes
    const previousRow = pixelRow - rowBytes
    filtered[filteredRow] = filter
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= 4 ? pixels[pixelRow + x - 4] : 0
      const up = y > 0 ? pixels[previousRow + x] : 0
      const upperLeft = y > 0 && x >= 4 ? pixels[previousRow + x - 4] : 0
      const predictor = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : paethPredictor(left, up, upperLeft)
      filtered[filteredRow + 1 + x] = (pixels[pixelRow + x] - predictor) & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(filtered, { level: compressionLevel })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function insertChunkBeforeImageData(png, type, data) {
  const headerEnd = 8 + 12 + 13
  return Buffer.concat([png.subarray(0, headerEnd), pngChunk(type, data), png.subarray(headerEnd)])
}

function appendTrailingIdatInput(png, trailing) {
  const imageDataChunk = 8 + 12 + 13
  const length = png.readUInt32BE(imageDataChunk)
  const dataStart = imageDataChunk + 8
  const dataEnd = dataStart + length
  return Buffer.concat([
    png.subarray(0, imageDataChunk),
    pngChunk('IDAT', Buffer.concat([png.subarray(dataStart, dataEnd), trailing])),
    png.subarray(dataEnd + 4),
  ])
}

function corruptHeaderChecksum(png) {
  const corrupted = Buffer.from(png)
  corrupted[8 + 4 + 4 + 13] ^= 0x01
  return corrupted
}

function aliasImageDataChunkType(png) {
  const aliased = Buffer.from(png)
  const imageDataChunk = 8 + 12 + 13
  const length = aliased.readUInt32BE(imageDataChunk)
  const typeStart = imageDataChunk + 4
  const dataStart = typeStart + 4
  const dataEnd = dataStart + length
  Buffer.from([0xc9, 0xc4, 0xc1, 0xd4]).copy(aliased, typeStart)
  aliased.writeUInt32BE(crc32(aliased.subarray(typeStart, dataEnd)), dataEnd)
  return aliased
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
  it('keeps byte-distinct PNGs when their decoded RGBA pixels are unchanged', async () => {
    const generatedOut = await mkdtemp(path.join(tmpdir(), 'qed2-semantic-png-'))
    temporaryDirectories.push(generatedOut)
    const iconPath = path.join(generatedOut, 'icon.png')
    const generated = renderNativeIconPng(32, THEME_ACCENTS.weed)
    const equivalent = encodeEquivalentPng(32, decodeGeneratedPng(generated).pixels, 1)
    expect(equivalent).not.toEqual(generated)
    await writeFile(iconPath, equivalent)

    expect(writePngIfPixelsChanged(iconPath, generated, 32, { logger: null })).toEqual({
      written: false,
      reason: 'pixels-unchanged',
    })
    expect(await readFile(iconPath)).toEqual(equivalent)
  })

  it('compares decoded pixels across all standard PNG scanline filters', async () => {
    const generatedOut = await mkdtemp(path.join(tmpdir(), 'qed2-filtered-png-'))
    temporaryDirectories.push(generatedOut)
    const iconPath = path.join(generatedOut, 'icon.png')
    const generated = renderNativeIconPng(8, THEME_ACCENTS.raspberry)
    const equivalent = encodeEquivalentPng(
      8,
      decodeGeneratedPng(generated).pixels,
      1,
      [0, 1, 2, 3, 4],
    )
    await writeFile(iconPath, equivalent)

    expect(writePngIfPixelsChanged(iconPath, generated, 8, { logger: null })).toEqual({
      written: false,
      reason: 'pixels-unchanged',
    })
    expect(await readFile(iconPath)).toEqual(equivalent)
  })

  it('rewrites PNGs when their decoded RGBA pixels really change', async () => {
    const generatedOut = await mkdtemp(path.join(tmpdir(), 'qed2-changed-png-'))
    temporaryDirectories.push(generatedOut)
    const iconPath = path.join(generatedOut, 'icon.png')
    await writeFile(iconPath, renderNativeIconPng(32, THEME_ACCENTS.weed))
    const replacement = renderNativeIconPng(32, THEME_ACCENTS.sky)

    expect(writePngIfPixelsChanged(iconPath, replacement, 32, { logger: null })).toEqual({
      written: true,
      reason: 'pixels-changed',
    })
    expect(await readFile(iconPath)).toEqual(replacement)
  })

  it('clearly rebuilds missing and damaged PNGs', async () => {
    const generatedOut = await mkdtemp(path.join(tmpdir(), 'qed2-rebuilt-png-'))
    temporaryDirectories.push(generatedOut)
    const iconPath = path.join(generatedOut, 'icon.png')
    const generated = renderNativeIconPng(32, THEME_ACCENTS.weed)
    const messages = []
    const logger = { log: (message) => messages.push(message) }

    expect(writePngIfPixelsChanged(iconPath, generated, 32, { label: 'test/icon.png', logger })).toEqual({
      written: true,
      reason: 'missing',
    })
    await writeFile(iconPath, Buffer.from('damaged PNG'))
    expect(writePngIfPixelsChanged(iconPath, generated, 32, { label: 'test/icon.png', logger })).toEqual({
      written: true,
      reason: 'invalid-existing',
    })
    expect(await readFile(iconPath)).toEqual(generated)
    expect(messages).toEqual([
      'test/icon.png written (missing PNG rebuilt)',
      expect.stringContaining('test/icon.png written (invalid PNG rebuilt:'),
    ])
  })

  it('rebuilds PNGs with unsupported rendering metadata or trailing compressed input', async () => {
    const generatedOut = await mkdtemp(path.join(tmpdir(), 'qed2-strict-png-'))
    temporaryDirectories.push(generatedOut)
    const iconPath = path.join(generatedOut, 'icon.png')
    const generated = renderNativeIconPng(32, THEME_ACCENTS.weed)
    const variants = [
      insertChunkBeforeImageData(generated, 'gAMA', Buffer.from([0, 0, 0xb1, 0x8f])),
      appendTrailingIdatInput(generated, Buffer.from([0xde, 0xad, 0xbe, 0xef])),
      encodeEquivalentPng(32, decodeGeneratedPng(generated).pixels, 1, [5]),
      corruptHeaderChecksum(generated),
      aliasImageDataChunkType(generated),
    ]

    for (const variant of variants) {
      await writeFile(iconPath, variant)
      expect(writePngIfPixelsChanged(iconPath, generated, 32, { logger: null })).toEqual({
        written: true,
        reason: 'invalid-existing',
      })
      expect(await readFile(iconPath)).toEqual(generated)
    }
  })

  it('rejects invalid generated bytes before touching an existing PNG', async () => {
    const generatedOut = await mkdtemp(path.join(tmpdir(), 'qed2-invalid-generated-png-'))
    temporaryDirectories.push(generatedOut)
    const iconPath = path.join(generatedOut, 'icon.png')
    const existing = renderNativeIconPng(32, THEME_ACCENTS.weed)
    await writeFile(iconPath, existing)

    expect(() => writePngIfPixelsChanged(iconPath, Buffer.from('invalid'), 32, { logger: null }))
      .toThrow('generated')
    expect(await readFile(iconPath)).toEqual(existing)
  })

  it('preserves the old PNG if writing its atomic replacement fails', async () => {
    const generatedOut = await mkdtemp(path.join(tmpdir(), 'qed2-failed-png-write-'))
    temporaryDirectories.push(generatedOut)
    const iconPath = path.join(generatedOut, 'icon.png')
    const existing = renderNativeIconPng(32, THEME_ACCENTS.weed)
    const replacement = renderNativeIconPng(32, THEME_ACCENTS.sky)
    await writeFile(iconPath, existing)
    const fileSystem = {
      writeFileSync(temporaryPath, bytes, options) {
        writeFileSync(temporaryPath, bytes.subarray(0, 16), options)
        throw new Error('injected partial write failure')
      },
      renameSync() {
        throw new Error('rename must not run after a failed temporary write')
      },
      rmSync,
    }

    expect(() => writePngIfPixelsChanged(iconPath, replacement, 32, { fileSystem, logger: null }))
      .toThrow('Could not write')
    expect(await readFile(iconPath)).toEqual(existing)
    expect(await readdir(generatedOut)).toEqual(['icon.png'])
  })

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
