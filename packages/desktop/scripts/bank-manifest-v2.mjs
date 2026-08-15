import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export const BANK_MANIFEST_PATH = 'bank/manifest.v2.json'
export const BANK_MANIFEST_FORMAT = 2
export const BANK_WIRE_CONTRACT_VERSION = 1

const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const MAX_BANK_MANIFEST_BYTES = 32 * 1024 * 1024

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function safeRepositoryPath(value, root, suffix) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes('\\') ||
    value.includes('\0') ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    path.posix.normalize(value) !== value
  ) {
    return false
  }
  const parts = value.split('/')
  return (
    value.startsWith(`${root}/`) &&
    value.endsWith(suffix) &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
  )
}

function canonicalKeys(value) {
  const keys = Object.keys(value)
  return keys.every((key, index) => index === 0 || keys[index - 1] < key)
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

export function bankManifestRootSha256(value) {
  if (!plainObject(value) || !plainObject(value.bank)) {
    throw new Error('Bank Manifest v2 is malformed')
  }
  const bytes = canonicalJson({
    wireContractVersion: value.wireContractVersion,
    schema: value.bank.schema,
    questions: value.questions,
    assets: value.assets,
  })
  return createHash('sha256').update(bytes).digest('hex')
}

export function validateBankManifestV2(value, expectedCommit) {
  if (
    !plainObject(value) ||
    value.formatVersion !== BANK_MANIFEST_FORMAT ||
    value.wireContractVersion !== BANK_WIRE_CONTRACT_VERSION ||
    !plainObject(value.bank) ||
    !plainObject(value.questions) ||
    !plainObject(value.assets) ||
    !exactKeys(value, ['formatVersion', 'wireContractVersion', 'bank', 'questions', 'assets'])
  ) {
    throw new Error('Bank Manifest v2 is missing or uses an unsupported format')
  }
  const commit = value.bank.commit
  const expectedAssetBaseUrl = `/content/banks/${String(commit)}/assets`
  if (
    typeof commit !== 'string' ||
    !FULL_GIT_SHA_PATTERN.test(commit) ||
    (expectedCommit !== undefined && commit !== expectedCommit) ||
    typeof value.bank.rootSha256 !== 'string' ||
    !SHA256_PATTERN.test(value.bank.rootSha256) ||
    !plainObject(value.bank.schema) ||
    !exactKeys(value.bank, ['commit', 'rootSha256', 'schema', 'immutableAssetBaseUrl']) ||
    !exactKeys(value.bank.schema, ['path', 'sha256']) ||
    value.bank.schema.path !== 'schema/question.ts' ||
    typeof value.bank.schema.sha256 !== 'string' ||
    !SHA256_PATTERN.test(value.bank.schema.sha256) ||
    value.bank.immutableAssetBaseUrl !== expectedAssetBaseUrl
  ) {
    throw new Error('Bank Manifest v2 has invalid or unattested bank metadata')
  }

  if (
    Object.keys(value.questions).length === 0 ||
    Object.keys(value.assets).length === 0 ||
    !canonicalKeys(value.questions) ||
    !canonicalKeys(value.assets)
  ) {
    throw new Error('Bank Manifest v2 has an empty or non-canonical inventory')
  }

  const questionPaths = new Set()
  for (const [id, record] of Object.entries(value.questions)) {
    if (
      id.length === 0 ||
      id.length > 255 ||
      /[\u0000-\u001f\u007f]/u.test(id) ||
      !plainObject(record) ||
      !exactKeys(record, ['path', 'rawSha256', 'wireSha256', 'assets']) ||
      !safeRepositoryPath(record.path, 'content', '.json') ||
      questionPaths.has(record.path) ||
      typeof record.rawSha256 !== 'string' ||
      !SHA256_PATTERN.test(record.rawSha256) ||
      typeof record.wireSha256 !== 'string' ||
      !SHA256_PATTERN.test(record.wireSha256) ||
      !Array.isArray(record.assets) ||
      record.assets.some((asset, index) =>
        typeof asset !== 'string' ||
        !Object.hasOwn(value.assets, asset) ||
        (index > 0 && record.assets[index - 1] >= asset)
      )
    ) {
      throw new Error(`Bank Manifest v2 has an invalid question record: ${id}`)
    }
    questionPaths.add(record.path)
  }

  const assetPaths = new Set()
  for (const [key, record] of Object.entries(value.assets)) {
    if (
      !safeRepositoryPath(`assets/${key}`, 'assets', '.png') ||
      !plainObject(record) ||
      !exactKeys(record, ['path', 'bytes', 'mimeType', 'sha256']) ||
      record.path !== `assets/${key}` ||
      assetPaths.has(record.path) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes <= 0 ||
      record.mimeType !== 'image/png' ||
      typeof record.sha256 !== 'string' ||
      !SHA256_PATTERN.test(record.sha256)
    ) {
      throw new Error(`Bank Manifest v2 has an invalid asset record: ${key}`)
    }
    assetPaths.add(record.path)
  }

  const computedRoot = bankManifestRootSha256(value)
  if (computedRoot !== value.bank.rootSha256) {
    throw new Error('Bank Manifest v2 root does not match its canonical inventory')
  }
  return value
}

export async function readBankManifestV2(manifestPath, expectedCommit) {
  let value
  try {
    const info = await stat(manifestPath)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_BANK_MANIFEST_BYTES) {
      throw new Error('unsafe Bank Manifest v2 size')
    }
    value = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Bank Manifest v2 is missing, unreadable or malformed: ${manifestPath}`, {
      cause: error,
    })
  }
  return validateBankManifestV2(value, expectedCommit)
}
