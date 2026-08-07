import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, inflateRawSync } from 'node:zlib'

const SHA_PATTERN = /^[0-9a-f]{40}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const MAX_EMBEDDED_BLOCKMAP_BYTES = 16 * 1024 * 1024
const MAX_SIDECAR_BLOCKMAP_BYTES = 16 * 1024 * 1024
const MAX_INFLATED_BLOCKMAP_BYTES = 64 * 1024 * 1024
const BUILDER_RABIN_MIN_BYTES = 8 * 1024
const BUILDER_RABIN_MAX_BYTES = 32 * 1024

// app-builder-lib 26.15.3 creates each v2 checksum with BLAKE2b's digest
// length set to 18 bytes. Truncating a generic 64-byte BLAKE2b digest is not
// equivalent, so resolve the exact implementation used by the pinned builder.
const localRequire = createRequire(import.meta.url)
const electronBuilderRequire = createRequire(localRequire.resolve('electron-builder/package.json'))
const appBuilderRequire = createRequire(electronBuilderRequire.resolve('app-builder-lib/package.json'))
const appBuilderVersion = appBuilderRequire('./package.json').version
if (appBuilderVersion !== '26.15.3') {
  throw new Error(`Unsupported app-builder-lib blockmap format version ${appBuilderVersion}`)
}
const { blake2b: builderBlake2b } = appBuilderRequire('@noble/hashes/blake2.js')

function parseScalar(value) {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseUpdateManifest(source, filename = 'update manifest') {
  const manifest = { version: undefined, files: [], path: undefined, sha512: undefined }
  let inFiles = false
  let currentFile

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue

    const topLevel = /^([^\s][^:]*):\s*(.*)$/u.exec(line)
    if (topLevel) {
      const [, key, rawValue] = topLevel
      inFiles = key === 'files'
      currentFile = undefined
      if (key === 'version') manifest.version = parseScalar(rawValue)
      if (key === 'path') manifest.path = parseScalar(rawValue)
      if (key === 'sha512') manifest.sha512 = parseScalar(rawValue)
      continue
    }

    if (!inFiles) continue

    const url = /^\s+-\s+url:\s*(.+)$/u.exec(line)
    if (url) {
      currentFile = {
        url: parseScalar(url[1]),
        sha512: undefined,
        size: undefined,
        blockMapSize: undefined,
      }
      manifest.files.push(currentFile)
      continue
    }

    const property = /^\s+(sha512|size|blockMapSize):\s*(.+)$/u.exec(line)
    if (property && currentFile) {
      const [, key, rawValue] = property
      currentFile[key] =
        key === 'size' || key === 'blockMapSize'
          ? Number(parseScalar(rawValue))
          : parseScalar(rawValue)
      continue
    }

    throw new Error(`${filename}:${index + 1}: unsupported or malformed update metadata`)
  }

  if (!manifest.version || manifest.files.length === 0 || !manifest.path || !manifest.sha512) {
    throw new Error(`${filename}: missing version, files, path, or sha512`)
  }
  return manifest
}

function canonicalBlockChecksum(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{24}$/u.test(value)) return false
  const bytes = Buffer.from(value, 'base64')
  return bytes.length === 18 && bytes.toString('base64') === value
}

function hasExactOwnKeys(value, expected) {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

async function readExactly(handle, buffer, position, label) {
  let offset = 0
  while (offset < buffer.length) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    )
    if (result.bytesRead === 0) throw new Error(`Truncated ${label}`)
    offset += result.bytesRead
  }
}

/**
 * electron-builder 26 appends a raw-deflate v2 blockmap and a four-byte
 * big-endian blockmap length to AppImage itself. electron-updater reads this
 * trailer using `blockMapSize` from latest-linux.yml.
 */
export async function verifyEmbeddedAppImageBlockMap(assetPath, entry, manifestName) {
  const fileStat = await stat(assetPath)
  const blockMapSize = entry.blockMapSize
  if (
    !Number.isSafeInteger(blockMapSize) ||
    blockMapSize <= 0 ||
    blockMapSize > MAX_EMBEDDED_BLOCKMAP_BYTES ||
    blockMapSize + 4 >= fileStat.size
  ) {
    throw new Error(`${manifestName}: invalid embedded blockMapSize for ${path.basename(assetPath)}`)
  }

  const handle = await open(assetPath, 'r')
  let compressed
  try {
    const sizeHeader = Buffer.allocUnsafe(4)
    await readExactly(handle, sizeHeader, fileStat.size - 4, 'AppImage blockmap size trailer')
    if (sizeHeader.readUInt32BE(0) !== blockMapSize) {
      throw new Error(`${manifestName}: AppImage blockmap trailer length does not match metadata`)
    }
    compressed = Buffer.allocUnsafe(blockMapSize)
    await readExactly(
      handle,
      compressed,
      fileStat.size - blockMapSize - 4,
      'embedded AppImage blockmap',
    )
  } finally {
    await handle.close()
  }

  let blockMap
  try {
    blockMap = JSON.parse(
      inflateRawSync(compressed, { maxOutputLength: MAX_INFLATED_BLOCKMAP_BYTES }).toString('utf8'),
    )
  } catch (error) {
    throw new Error(`${manifestName}: invalid embedded AppImage blockmap`, { cause: error })
  }
  if (
    !blockMap ||
    typeof blockMap !== 'object' ||
    Array.isArray(blockMap) ||
    blockMap.version !== '2' ||
    !Array.isArray(blockMap.files) ||
    blockMap.files.length !== 1
  ) {
    throw new Error(`${manifestName}: unsupported embedded AppImage blockmap structure`)
  }
  const [file] = blockMap.files
  if (
    !file ||
    typeof file !== 'object' ||
    Array.isArray(file) ||
    file.name !== 'file' ||
    file.offset !== 0 ||
    !Array.isArray(file.sizes) ||
    !Array.isArray(file.checksums) ||
    file.sizes.length === 0 ||
    file.sizes.length !== file.checksums.length
  ) {
    throw new Error(`${manifestName}: malformed embedded AppImage block inventory`)
  }
  let inventoriedBytes = 0
  for (let index = 0; index < file.sizes.length; index += 1) {
    const size = file.sizes[index]
    if (!Number.isSafeInteger(size) || size <= 0 || !canonicalBlockChecksum(file.checksums[index])) {
      throw new Error(`${manifestName}: invalid embedded AppImage block near index ${index}`)
    }
    inventoriedBytes += size
    if (!Number.isSafeInteger(inventoriedBytes)) {
      throw new Error(`${manifestName}: embedded AppImage block inventory exceeds the safe size limit`)
    }
  }
  const payloadSize = fileStat.size - blockMapSize - 4
  if (inventoriedBytes !== payloadSize) {
    throw new Error(`${manifestName}: embedded AppImage block inventory does not cover the payload`)
  }
  return { blockMapSize, payloadSize, blocks: file.sizes.length }
}

async function readBoundedFile(filePath, maximumBytes, label) {
  const handle = await open(filePath, 'r')
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maximumBytes) {
      throw new Error(`${label} exceeds the supported compressed size limit`)
    }
    const bytes = Buffer.allocUnsafe(fileStat.size)
    await readExactly(handle, bytes, 0, label)
    const trailingByte = Buffer.allocUnsafe(1)
    if ((await handle.read(trailingByte, 0, 1, fileStat.size)).bytesRead !== 0) {
      throw new Error(`${label} changed while it was being verified`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function parseSidecarBlockMap(compressed, label) {
  let source
  let blockMap
  try {
    const inflated = gunzipSync(compressed, { maxOutputLength: MAX_INFLATED_BLOCKMAP_BYTES })
    source = new TextDecoder('utf-8', { fatal: true }).decode(inflated)
    blockMap = JSON.parse(source)
  } catch (error) {
    throw new Error(`${label}: invalid gzip-compressed blockmap`, { cause: error })
  }

  // app-builder-lib writes JSON.stringify(blockMap) directly. This rejects
  // duplicate-key smuggling, trailing data and non-canonical JSON accepted by
  // JSON.parse but never emitted by the builder.
  if (source !== JSON.stringify(blockMap)) {
    throw new Error(`${label}: non-canonical sidecar blockmap JSON`)
  }
  return blockMap
}

function validateSidecarBlockInventory(blockMap, payloadSize, label) {
  if (
    !blockMap ||
    typeof blockMap !== 'object' ||
    Array.isArray(blockMap) ||
    !hasExactOwnKeys(blockMap, ['version', 'files']) ||
    blockMap.version !== '2' ||
    !Array.isArray(blockMap.files) ||
    blockMap.files.length !== 1
  ) {
    throw new Error(`${label}: unsupported sidecar blockmap structure`)
  }

  const [file] = blockMap.files
  if (
    !file ||
    typeof file !== 'object' ||
    Array.isArray(file) ||
    !hasExactOwnKeys(file, ['name', 'offset', 'checksums', 'sizes']) ||
    file.name !== 'file' ||
    file.offset !== 0 ||
    !Array.isArray(file.sizes) ||
    !Array.isArray(file.checksums) ||
    file.sizes.length === 0 ||
    file.sizes.length !== file.checksums.length
  ) {
    throw new Error(`${label}: malformed sidecar block inventory`)
  }

  let inventoriedBytes = 0
  const lastIndex = file.sizes.length - 1
  for (let index = 0; index < file.sizes.length; index += 1) {
    const size = file.sizes[index]
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > BUILDER_RABIN_MAX_BYTES ||
      (index !== lastIndex && size < BUILDER_RABIN_MIN_BYTES) ||
      !canonicalBlockChecksum(file.checksums[index])
    ) {
      throw new Error(`${label}: invalid sidecar block near index ${index}`)
    }
    inventoriedBytes += size
    if (!Number.isSafeInteger(inventoriedBytes)) {
      throw new Error(`${label}: sidecar block inventory exceeds the safe size limit`)
    }
  }
  if (inventoriedBytes !== payloadSize) {
    throw new Error(`${label}: sidecar block inventory does not cover the update payload`)
  }
  return file
}

async function verifySidecarBlockChecksums(assetPath, file, label) {
  let blockIndex = 0
  let remaining = file.sizes[0]
  let hash = builderBlake2b.create({ dkLen: 18 })

  for await (const chunk of createReadStream(assetPath, { highWaterMark: 256 * 1024 })) {
    let offset = 0
    while (offset < chunk.length) {
      if (blockIndex >= file.sizes.length) {
        throw new Error(`${label}: update payload changed while its blockmap was being verified`)
      }
      const consumed = Math.min(remaining, chunk.length - offset)
      hash.update(chunk.subarray(offset, offset + consumed))
      offset += consumed
      remaining -= consumed
      if (remaining === 0) {
        const actual = Buffer.from(hash.digest()).toString('base64')
        if (actual !== file.checksums[blockIndex]) {
          throw new Error(`${label}: sidecar block checksum mismatch near index ${blockIndex}`)
        }
        blockIndex += 1
        if (blockIndex < file.sizes.length) {
          remaining = file.sizes[blockIndex]
          hash = builderBlake2b.create({ dkLen: 18 })
        }
      }
    }
  }
  if (blockIndex !== file.sizes.length) {
    throw new Error(`${label}: update payload ended before its block inventory`)
  }
}

async function verifySidecarBlockMap(blockMapPath, assetPath, payloadSize, manifestName) {
  const blockMapName = path.basename(blockMapPath)
  const label = `${manifestName}: ${blockMapName}`
  const compressed = await readBoundedFile(
    blockMapPath,
    MAX_SIDECAR_BLOCKMAP_BYTES,
    `${label} sidecar blockmap`,
  )
  const blockMap = parseSidecarBlockMap(compressed, label)
  const file = validateSidecarBlockInventory(blockMap, payloadSize, label)
  await verifySidecarBlockChecksums(assetPath, file, label)
}

async function digest(filePath, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest(encoding)
}

function safeAssetName(rawName, manifestName) {
  let decoded
  try {
    decoded = decodeURIComponent(rawName)
  } catch {
    throw new Error(`${manifestName}: invalid percent-encoding in asset URL ${rawName}`)
  }
  if (
    decoded !== path.basename(decoded) ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded.includes('?') ||
    decoded.includes('#')
  ) {
    throw new Error(`${manifestName}: asset URL must be a plain top-level filename: ${rawName}`)
  }
  return decoded
}

function requireCount(names, predicate, count, label) {
  const matches = names.filter(predicate)
  if (matches.length !== count) {
    throw new Error(`Expected ${count} ${label} asset(s), found ${matches.length}`)
  }
  return matches
}

function requireOne(names, predicate, label) {
  return requireCount(names, predicate, 1, label)[0]
}

async function verifyManifest(root, manifestName, version, names) {
  const source = await readFile(path.join(root, manifestName), 'utf8')
  const manifest = parseUpdateManifest(source, manifestName)
  if (manifest.version !== version) {
    throw new Error(`${manifestName}: version ${manifest.version} does not match ${version}`)
  }

  const seen = new Set()
  const sidecarBlockmaps = new Set()
  for (const entry of manifest.files) {
    const assetName = safeAssetName(entry.url, manifestName)
    if (seen.has(assetName)) throw new Error(`${manifestName}: duplicate asset ${assetName}`)
    seen.add(assetName)
    if (!names.includes(assetName)) throw new Error(`${manifestName}: missing referenced asset ${assetName}`)
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
      throw new Error(`${manifestName}: invalid size for ${assetName}`)
    }
    const assetPath = path.join(root, assetName)
    const fileStat = await stat(assetPath)
    if (fileStat.size !== entry.size) {
      throw new Error(`${manifestName}: size mismatch for ${assetName}`)
    }
    const actualSha512 = await digest(assetPath, 'sha512', 'base64')
    if (actualSha512 !== entry.sha512) {
      throw new Error(`${manifestName}: SHA-512 mismatch for ${assetName}`)
    }
    // NSIS and macOS ZIP updates use sidecar blockmaps. AppImage carries a
    // raw-deflate blockmap in its own trailer, described by blockMapSize.
    if (/\.(?:exe|zip)$/u.test(assetName)) {
      if (entry.blockMapSize !== undefined) {
        throw new Error(`${manifestName}: sidecar update ${assetName} must not declare blockMapSize`)
      }
      const blockmap = `${assetName}.blockmap`
      if (!names.includes(blockmap)) {
        throw new Error(`${manifestName}: missing differential-update blockmap ${blockmap}`)
      }
      await verifySidecarBlockMap(path.join(root, blockmap), assetPath, fileStat.size, manifestName)
      sidecarBlockmaps.add(blockmap)
    } else if (assetName.endsWith('.AppImage')) {
      const blockmap = `${assetName}.blockmap`
      if (names.includes(blockmap)) {
        throw new Error(`${manifestName}: AppImage must use its embedded blockmap, not ${blockmap}`)
      }
      await verifyEmbeddedAppImageBlockMap(assetPath, entry, manifestName)
    } else if (entry.blockMapSize !== undefined) {
      throw new Error(`${manifestName}: full-package update ${assetName} must not declare blockMapSize`)
    }
  }

  const legacyPath = safeAssetName(manifest.path, manifestName)
  const legacyEntry = manifest.files.find((entry) => safeAssetName(entry.url, manifestName) === legacyPath)
  if (!legacyEntry || legacyEntry.sha512 !== manifest.sha512) {
    throw new Error(`${manifestName}: top-level path/SHA-512 does not match a files entry`)
  }

  return {
    ...manifest,
    referencedAssets: [...seen].sort(),
    sidecarBlockmaps: [...sidecarBlockmaps].sort(),
  }
}

function validateManifestTargets(manifestName, manifest, version) {
  const prefix = `QED2-${version}-`
  for (const name of manifest.referencedAssets) {
    if (!name.startsWith(prefix)) {
      throw new Error(`${manifestName}: referenced asset does not use the release version: ${name}`)
    }
  }

  if (manifestName === 'latest.yml') {
    requireOne(manifest.referencedAssets, (name) => /-win-x64\.exe$/u.test(name), 'Windows x64 update')
    if (manifest.referencedAssets.length !== 1) throw new Error('latest.yml must reference exactly one installer')
  } else if (manifestName === 'latest-mac.yml') {
    requireOne(manifest.referencedAssets, (name) => /-mac-arm64\.zip$/u.test(name), 'macOS arm64 update')
    requireOne(manifest.referencedAssets, (name) => /-mac-x64\.zip$/u.test(name), 'macOS x64 update')
    if (manifest.referencedAssets.length !== 2) throw new Error('latest-mac.yml must reference exactly two ZIPs')
  } else if (manifestName === 'latest-linux.yml') {
    requireOne(
      manifest.referencedAssets,
      (name) => /-linux-(?:x64|x86_64|amd64)\.AppImage$/u.test(name),
      'Linux x64 AppImage update',
    )
    requireOne(
      manifest.referencedAssets,
      (name) => /-linux-(?:x64|x86_64|amd64)\.deb$/u.test(name),
      'Linux x64 deb update',
    )
    requireOne(
      manifest.referencedAssets,
      (name) => /-linux-(?:x64|x86_64|amd64)\.rpm$/u.test(name),
      'Linux x64 rpm update',
    )
    if (manifest.referencedAssets.length !== 3) {
      throw new Error('latest-linux.yml must reference exactly AppImage, deb and rpm payloads')
    }
  }
}

async function regularAssetNames(root) {
  const names = (await readdir(root)).sort()
  for (const name of names) {
    const item = await lstat(path.join(root, name))
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`Release asset directory may contain only regular top-level files: ${name}`)
    }
  }
  return names
}

export async function verifyReleaseAssets({ root, version, tag, clientSha, coreSha, bankSha }) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid stable release version: ${version}`)
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match version ${version}`)
  for (const [label, value] of Object.entries({ clientSha, coreSha, bankSha })) {
    if (!SHA_PATTERN.test(value)) throw new Error(`Invalid ${label}: expected a full Git commit ID`)
  }

  const names = await regularAssetNames(root)
  for (const required of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'runtime-sources.txt']) {
    if (!names.includes(required)) throw new Error(`Missing required release asset ${required}`)
  }

  const binaries = names.filter((name) => /\.(?:dmg|zip|exe|AppImage|deb|rpm)$/u.test(name))
  for (const name of binaries) {
    if (!name.startsWith(`QED2-${version}-`)) {
      throw new Error(`Unexpected version or product name in binary asset ${name}`)
    }
  }
  requireCount(binaries, (name) => name.endsWith('.dmg'), 2, 'macOS DMG')
  requireCount(binaries, (name) => name.endsWith('.zip'), 2, 'macOS ZIP')
  requireOne(binaries, (name) => /-win-x64\.exe$/u.test(name), 'Windows x64 installer')
  requireOne(
    binaries,
    (name) => /-linux-(?:x64|x86_64|amd64)\.AppImage$/u.test(name),
    'Linux x64 AppImage',
  )
  requireCount(binaries, (name) => name.endsWith('.deb'), 1, 'Linux deb')
  requireCount(binaries, (name) => name.endsWith('.rpm'), 1, 'Linux rpm')

  const manifests = {}
  const expectedSidecarBlockmaps = new Set()
  for (const manifestName of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
    const manifest = await verifyManifest(root, manifestName, version, names)
    validateManifestTargets(manifestName, manifest, version)
    manifests[manifestName] = manifest.referencedAssets
    for (const blockmap of manifest.sidecarBlockmaps) expectedSidecarBlockmaps.add(blockmap)
  }
  const actualSidecarBlockmaps = names.filter((name) => name.endsWith('.blockmap'))
  if (
    actualSidecarBlockmaps.length !== expectedSidecarBlockmaps.size ||
    actualSidecarBlockmaps.some((name) => !expectedSidecarBlockmaps.has(name))
  ) {
    throw new Error(
      `Release blockmap set mismatch: expected ${[...expectedSidecarBlockmaps].sort().join(', ')}, ` +
        `found ${actualSidecarBlockmaps.join(', ')}`,
    )
  }

  const sourceText = await readFile(path.join(root, 'runtime-sources.txt'), 'utf8')
  for (const value of [tag, clientSha, coreSha, bankSha]) {
    if (!sourceText.includes(value)) throw new Error(`runtime-sources.txt does not record ${value}`)
  }

  const outputNames = names.filter((name) => name !== 'SHA256SUMS' && name !== 'release-manifest.json')
  const assets = []
  for (const name of outputNames) {
    const filePath = path.join(root, name)
    const fileStat = await stat(filePath)
    assets.push({ name, size: fileStat.size, sha256: await digest(filePath, 'sha256', 'hex') })
  }
  const releaseManifest = {
    formatVersion: 1,
    tag,
    version,
    sources: { client: clientSha, core: coreSha, bank: bankSha },
    updateMetadata: manifests,
    assets,
  }
  await writeFile(
    path.join(root, 'release-manifest.json'),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o644 },
  )

  const checksumNames = [...outputNames, 'release-manifest.json'].sort()
  const checksumLines = []
  for (const name of checksumNames) {
    checksumLines.push(`${await digest(path.join(root, name), 'sha256', 'hex')}  ${name}`)
  }
  await writeFile(path.join(root, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  })

  return releaseManifest
}

function commandLineOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument list near ${key ?? '<end>'}`)
    options[key.slice(2)] = value
  }
  for (const key of ['root', 'version', 'tag', 'client-sha', 'core-sha', 'bank-sha']) {
    if (!options[key]) throw new Error(`Missing --${key}`)
  }
  return options
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = commandLineOptions(process.argv.slice(2))
  const manifest = await verifyReleaseAssets({
    root: path.resolve(options.root),
    version: options.version,
    tag: options.tag,
    clientSha: options['client-sha'],
    coreSha: options['core-sha'],
    bankSha: options['bank-sha'],
  })
  process.stdout.write(`Verified ${manifest.assets.length} release assets for ${manifest.tag}\n`)
}
