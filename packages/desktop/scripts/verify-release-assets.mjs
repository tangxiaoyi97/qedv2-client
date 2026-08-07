import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA_PATTERN = /^[0-9a-f]{40}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

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
      currentFile = { url: parseScalar(url[1]), sha512: undefined, size: undefined }
      manifest.files.push(currentFile)
      continue
    }

    const property = /^\s+(sha512|size):\s*(.+)$/u.exec(line)
    if (property && currentFile) {
      const [, key, rawValue] = property
      currentFile[key] = key === 'size' ? Number(parseScalar(rawValue)) : parseScalar(rawValue)
      continue
    }

    throw new Error(`${filename}:${index + 1}: unsupported or malformed update metadata`)
  }

  if (!manifest.version || manifest.files.length === 0 || !manifest.path || !manifest.sha512) {
    throw new Error(`${filename}: missing version, files, path, or sha512`)
  }
  return manifest
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
    // electron-builder emits differential blockmaps for NSIS, macOS ZIP and
    // AppImage payloads. Native Linux packages are full-package updates: their
    // size and SHA-512 remain mandatory, but electron-builder does not create
    // (and electron-updater does not consume) .deb/.rpm blockmaps.
    if (/\.(?:exe|zip|AppImage)$/u.test(assetName)) {
      const blockmap = `${assetName}.blockmap`
      if (!names.includes(blockmap)) {
        throw new Error(`${manifestName}: missing differential-update blockmap ${blockmap}`)
      }
    }
  }

  const legacyPath = safeAssetName(manifest.path, manifestName)
  const legacyEntry = manifest.files.find((entry) => safeAssetName(entry.url, manifestName) === legacyPath)
  if (!legacyEntry || legacyEntry.sha512 !== manifest.sha512) {
    throw new Error(`${manifestName}: top-level path/SHA-512 does not match a files entry`)
  }

  return { ...manifest, referencedAssets: [...seen].sort() }
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
  for (const manifestName of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
    const manifest = await verifyManifest(root, manifestName, version, names)
    validateManifestTargets(manifestName, manifest, version)
    manifests[manifestName] = manifest.referencedAssets
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
