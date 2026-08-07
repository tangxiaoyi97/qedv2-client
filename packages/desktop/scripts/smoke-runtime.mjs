import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..')
const coreHost = path.resolve(desktopRoot, 'src/core-host.cjs')
const packagedOutputRoot = path.resolve(desktopRoot, 'dist-packages')
const MAX_LOG_BYTES = 128 * 1024
const MAX_RUNTIME_ENTRIES = 100_000
const HASH_CONCURRENCY = 8
const STREAM_HASH_THRESHOLD_BYTES = 1024 * 1024
const INTEGRITY_ROOTS = [
  'core/dist',
  'core/node_modules',
  'bank/content',
  'bank/assets',
  'bank/schema',
  'bank/revisions',
]
const INTEGRITY_FILES = ['core/package.json', 'core/pnpm-lock.yaml', 'bank/VERSION']

function usageError(message) {
  throw new Error(
    `${message}\nUsage: node scripts/smoke-runtime.mjs [--packaged | --runtime-root <directory>]`,
  )
}

export function parseArguments(argv) {
  let packaged = false
  let runtimeRoot
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--' && index === 0) continue
    if (argument === '--packaged') {
      if (packaged) usageError('--packaged was specified more than once.')
      packaged = true
      continue
    }
    if (argument === '--runtime-root') {
      if (runtimeRoot !== undefined) usageError('--runtime-root was specified more than once.')
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) usageError('--runtime-root requires a directory.')
      runtimeRoot = path.resolve(value)
      index += 1
      continue
    }
    usageError(`Unknown argument: ${argument}`)
  }
  if (packaged && runtimeRoot !== undefined) {
    usageError('--packaged and --runtime-root cannot be combined.')
  }
  return { packaged, runtimeRoot }
}

async function isManifestFile(candidate) {
  try {
    const info = await lstat(candidate)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Locate the runtime copied into an electron-builder unpacked application.
 * This intentionally discovers the Resources/resources directory rather than
 * depending on architecture-specific output names such as mac-arm64.
 */
export async function discoverPackagedRuntimeRoot(outputRoot = packagedOutputRoot) {
  const candidates = []
  const visit = async (directory, depth) => {
    if (depth > 6) return
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const absolutePath = path.join(directory, entry.name)
      if (entry.name === 'runtime') {
        const parentName = path.basename(directory).toLowerCase()
        if (
          parentName === 'resources' &&
          (await isManifestFile(path.join(absolutePath, 'runtime-manifest.json')))
        ) {
          candidates.push(absolutePath)
        }
        continue
      }
      await visit(absolutePath, depth + 1)
    }
  }

  try {
    await visit(path.resolve(outputRoot), 0)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`Unpacked package output does not exist: ${path.resolve(outputRoot)}`)
    }
    throw error
  }

  candidates.sort()
  if (candidates.length === 0) {
    throw new Error(
      `No packaged runtime was found below ${path.resolve(outputRoot)}. Run electron-builder --dir first.`,
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      `More than one packaged runtime was found below ${path.resolve(outputRoot)}:\n${candidates.join('\n')}`,
    )
  }
  return candidates[0]
}

function portablePath(value) {
  return value.split(path.sep).join('/')
}

function isCoveredPath(value) {
  return (
    INTEGRITY_FILES.includes(value) ||
    INTEGRITY_ROOTS.some((root) => value.startsWith(`${root}/`))
  )
}

function safeManifestPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) return false
  if (value.includes('\\') || value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value)) return false
  if (value.startsWith('/') || value.endsWith('/') || path.posix.normalize(value) !== value) return false
  return value
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && part.length <= 255)
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || value.formatVersion !== 3) {
    throw new Error('runtime-manifest.json is missing or uses an unsupported format.')
  }
  if (
    !value.core ||
    typeof value.core !== 'object' ||
    !value.bank ||
    typeof value.bank !== 'object' ||
    !value.revisions ||
    typeof value.revisions !== 'object'
  ) {
    throw new Error('runtime-manifest.json has invalid Core, bank or revision metadata.')
  }
  if (
    typeof value.core.version !== 'string' ||
    typeof value.core.commit !== 'string' ||
    typeof value.core.entry !== 'string' ||
    typeof value.bank.commit !== 'string' ||
    !Array.isArray(value.bank.schemaVersions) ||
    value.revisions.catalog !== 'bank/revisions/revision-catalog.v1.json' ||
    value.revisions.formatVersion !== 1 ||
    value.revisions.pinnedCommit !== value.bank.commit ||
    !Number.isSafeInteger(value.revisions.commitCount) ||
    value.revisions.commitCount <= 0 ||
    !Number.isSafeInteger(value.revisions.questionRevisionCount) ||
    value.revisions.questionRevisionCount <= 0 ||
    !Number.isSafeInteger(value.revisions.objectCount) ||
    value.revisions.objectCount <= 0 ||
    !Number.isSafeInteger(value.revisions.objectBytes) ||
    value.revisions.objectBytes < 0 ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_RUNTIME_ENTRIES
  ) {
    throw new Error('runtime-manifest.json has invalid metadata or integrity inventory.')
  }

  let priorPath = ''
  for (const file of value.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      !safeManifestPath(file.path) ||
      !isCoveredPath(file.path) ||
      file.path <= priorPath ||
      (file.type !== 'file' && file.type !== 'symlink') ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(file.sha256)
    ) {
      throw new Error(`runtime-manifest.json has an invalid integrity record near ${String(file?.path)}.`)
    }
    priorPath = file.path
  }
  const catalog = value.files.find((file) => file.path === value.revisions.catalog)
  if (!catalog || catalog.type !== 'file') {
    throw new Error('runtime-manifest.json does not protect the immutable revision catalog.')
  }
  return value
}

async function collectIntegrityCandidates(runtimeRoot) {
  const candidates = []
  const visit = async (absolutePath, relativePath) => {
    const info = await lstat(absolutePath)
    if (info.isDirectory() && !info.isSymbolicLink()) {
      const entries = await readdir(absolutePath, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
      for (const entry of entries) {
        await visit(path.join(absolutePath, entry.name), `${relativePath}/${entry.name}`)
      }
      return
    }
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`Unsupported entry exists in the bundled runtime: ${relativePath}`)
    }
    candidates.push({ absolutePath, path: portablePath(relativePath), info })
    if (candidates.length > MAX_RUNTIME_ENTRIES) {
      throw new Error(`Bundled runtime exceeds the ${MAX_RUNTIME_ENTRIES}-entry integrity limit.`)
    }
  }

  for (const root of INTEGRITY_ROOTS) {
    const absolutePath = path.join(runtimeRoot, ...root.split('/'))
    const info = await lstat(absolutePath)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Required runtime tree is not a regular directory: ${root}`)
    }
    await visit(absolutePath, root)
  }
  for (const relativePath of INTEGRITY_FILES) {
    const absolutePath = path.join(runtimeRoot, ...relativePath.split('/'))
    const info = await lstat(absolutePath)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Required runtime file is not regular: ${relativePath}`)
    }
    candidates.push({ absolutePath, path: relativePath, info })
  }
  candidates.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return candidates
}

async function mapLimit(values, concurrency, worker) {
  const results = new Array(values.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor
        cursor += 1
        results[index] = await worker(values[index])
      }
    }),
  )
  return results
}

async function hashCandidate(candidate) {
  const hash = createHash('sha256')
  if (candidate.info.isSymbolicLink()) {
    const target = await readlink(candidate.absolutePath)
    const bytes = Buffer.from(target, 'utf8')
    return {
      path: candidate.path,
      type: 'symlink',
      size: bytes.byteLength,
      sha256: hash.update(bytes).digest('hex'),
    }
  }
  let size = 0
  if (candidate.info.size <= STREAM_HASH_THRESHOLD_BYTES) {
    const bytes = await readFile(candidate.absolutePath)
    size = bytes.byteLength
    hash.update(bytes)
  } else {
    for await (const chunk of createReadStream(candidate.absolutePath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.byteLength
      hash.update(bytes)
    }
  }
  return { path: candidate.path, type: 'file', size, sha256: hash.digest('hex') }
}

export async function verifyRuntimeInventory(runtimeRoot, manifest) {
  const rootInfo = await lstat(runtimeRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Runtime root is not a regular directory: ${runtimeRoot}`)
  }
  const candidates = await collectIntegrityCandidates(runtimeRoot)
  if (candidates.length !== manifest.files.length) {
    throw new Error(
      `Bundled runtime inventory mismatch: expected ${manifest.files.length} entries, found ${candidates.length}.`,
    )
  }
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index].path !== manifest.files[index].path) {
      throw new Error(`Bundled runtime inventory mismatch near: ${candidates[index].path}`)
    }
  }
  const actual = await mapLimit(candidates, HASH_CONCURRENCY, hashCandidate)
  for (let index = 0; index < actual.length; index += 1) {
    const expected = manifest.files[index]
    const found = actual[index]
    if (
      found.type !== expected.type ||
      found.size !== expected.size ||
      found.sha256 !== expected.sha256
    ) {
      throw new Error(`Bundled runtime integrity mismatch: ${expected.path}`)
    }
  }
  return {
    checkedFiles: actual.length,
    checkedBytes: actual.reduce((sum, file) => sum + file.size, 0),
  }
}

async function freeLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback smoke-test port')
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function boundedJson(url, maxBytes = 64 * 1024) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${url} exceeded the response limit`)
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`${url} exceeded the response limit`)
  return JSON.parse(text)
}

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateRevisionCommitOrder(catalog, manifest) {
  const commitOrder = catalog?.commitOrder
  if (
    !Array.isArray(commitOrder) ||
    commitOrder.length !== manifest.revisions.commitCount ||
    commitOrder.some((commit) => typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) ||
    new Set(commitOrder).size !== commitOrder.length ||
    commitOrder.at(-1) !== manifest.revisions.pinnedCommit ||
    !plainObject(catalog?.commits)
  ) {
    throw new Error('The bundled revision catalog has an invalid or incomplete commit order.')
  }
  const catalogCommits = Object.keys(catalog.commits).sort()
  const orderedCommits = [...commitOrder].sort()
  if (
    catalogCommits.length !== orderedCommits.length ||
    catalogCommits.some((commit, index) => commit !== orderedCommits[index])
  ) {
    throw new Error('The bundled revision catalog commit inventory is incomplete.')
  }
  return [...commitOrder]
}

export function selectRevisionQuestionSample(revisions, commits, expectedQuestionCount, catalog) {
  if (!Array.isArray(revisions) || revisions.length !== commits.length) {
    throw new Error('Bundled Core did not expose every immutable revision manifest')
  }
  let totalQuestions = 0
  let sample
  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index]
    const revision = revisions[index]
    const catalogQuestions = catalog?.commits?.[commit]?.questions
    if (revision?.commit !== commit || !plainObject(revision.items) || !plainObject(catalogQuestions)) {
      throw new Error(`Bundled Core did not expose immutable revision ${commit}`)
    }
    const entries = Object.entries(revision.items).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    for (const [questionId, contentHash] of entries) {
      if (!questionId || typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/u.test(contentHash)) {
        throw new Error(`Bundled Core returned invalid revision metadata for ${commit}`)
      }
    }
    const catalogEntries = Object.entries(catalogQuestions).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    if (
      entries.length !== catalogEntries.length ||
      entries.some(([questionId, contentHash], entryIndex) => {
        const [catalogQuestionId, record] = catalogEntries[entryIndex] ?? []
        return (
          questionId !== catalogQuestionId ||
          !plainObject(record) ||
          record.contentHash !== contentHash
        )
      })
    ) {
      throw new Error(`Bundled Core revision manifest does not match the catalog for ${commit}`)
    }
    totalQuestions += entries.length
    if (!sample && entries.length > 0) {
      sample = { commit, questionId: entries[0][0], contentHash: entries[0][1] }
    }
  }
  if (totalQuestions !== expectedQuestionCount) {
    throw new Error(
      `Bundled Core revision count mismatch: expected ${expectedQuestionCount}, found ${totalQuestions}`,
    )
  }
  if (!sample) throw new Error('Bundled Core revision catalog contains no historical questions')
  return sample
}

async function waitForIdentity(baseUrl, child, logs, manifest, revisionCatalog, revisionCommits) {
  const deadline = Date.now() + 30_000
  let lastError = new Error('Core did not answer the smoke test')
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Bundled Core exited before becoming ready (${child.exitCode}).\n${logs()}`)
    }
    try {
      const health = await boundedJson(`${baseUrl}/health`)
      if (health?.status !== 'ok') throw new Error('Health endpoint did not report ok')
      const info = await boundedJson(`${baseUrl}/info`)
      if (
        info?.service !== 'qed2-core' ||
        info.version !== manifest.core.version ||
        info.commit !== manifest.core.commit ||
        info.bank?.commit !== manifest.bank.commit ||
        info.bank?.revisions?.available !== true ||
        info.bank.revisions.pinnedCommit !== manifest.revisions.pinnedCommit ||
        info.bank.revisions.commitCount !== manifest.revisions.commitCount ||
        info.bank.revisions.questionRevisionCount !== manifest.revisions.questionRevisionCount ||
        !Number.isInteger(info.schemaVersionSupported?.min) ||
        !Number.isInteger(info.schemaVersionSupported?.max) ||
        manifest.bank.schemaVersions.some(
          (version) => version < info.schemaVersionSupported.min || version > info.schemaVersionSupported.max,
        )
      ) {
        throw new Error('Bundled Core identity does not match runtime-manifest.json')
      }
      const revisions = []
      for (const commit of revisionCommits) {
        revisions.push(
          await boundedJson(`${baseUrl}/content/revisions/${commit}/manifest`, 2 * 1024 * 1024),
        )
      }
      const sample = selectRevisionQuestionSample(
        revisions,
        revisionCommits,
        manifest.revisions.questionRevisionCount,
        revisionCatalog,
      )
      const sampleRecord = revisionCatalog.commits?.[sample.commit]?.questions?.[sample.questionId]
      if (
        !plainObject(sampleRecord) ||
        sampleRecord.contentHash !== sample.contentHash ||
        typeof sampleRecord.wireHash !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(sampleRecord.wireHash)
      ) {
        throw new Error('Bundled revision catalog does not match the Core manifest probe')
      }
      const question = await boundedJson(
        `${baseUrl}/content/revisions/${sample.commit}/questions/${encodeURIComponent(sample.questionId)}`,
      )
      if (
        question?.id !== sample.questionId ||
        question.contentHash !== sample.contentHash ||
        question.wireHash !== sampleRecord.wireHash
      ) {
        throw new Error('Bundled Core returned an inconsistent immutable question revision')
      }
      return info
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw new Error(`Bundled Core failed its startup smoke test: ${lastError.message}\n${logs()}`)
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  const exitPromise = new Promise((resolve) => child.once('exit', () => resolve(true)))
  child.kill()
  const exited = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve(false), 8_000)),
  ])
  if (!exited && child.exitCode === null) child.kill('SIGKILL')
}

export async function runSmoke(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const runtimeRoot = options.packaged
    ? await discoverPackagedRuntimeRoot()
    : options.runtimeRoot ?? path.resolve(desktopRoot, 'runtime')
  const manifest = validateManifest(
    JSON.parse(await readFile(path.join(runtimeRoot, 'runtime-manifest.json'), 'utf8')),
  )
  const revisionCatalog = JSON.parse(
    await readFile(path.join(runtimeRoot, ...manifest.revisions.catalog.split('/')), 'utf8'),
  )
  const revisionCommits = validateRevisionCommitOrder(revisionCatalog, manifest)
  const integrity = await verifyRuntimeInventory(runtimeRoot, manifest)
  process.stdout.write(
    `Runtime integrity smoke passed: ${integrity.checkedFiles} files, ${integrity.checkedBytes} bytes (${runtimeRoot})\n`,
  )

  const coreDirectory = path.join(runtimeRoot, 'core')
  const coreEntry = path.join(coreDirectory, manifest.core.entry)
  const bankDirectory = path.join(runtimeRoot, 'bank')
  const port = await freeLoopbackPort()
  let logText = ''
  const appendLog = (chunk) => {
    if (logText.length >= MAX_LOG_BYTES) return
    logText += String(chunk).slice(0, MAX_LOG_BYTES - logText.length)
  }
  const childEnvironment = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    BANK_PATH: bankDirectory,
    BANK_STRICT: 'true',
    REVISION_VAULT_PATH: path.join(bankDirectory, 'revisions'),
    REVISION_VAULT_REQUIRED: 'true',
    REQUEST_LOG: 'false',
    CORS_ORIGINS: 'http://127.0.0.1:*',
    CORE_SOURCE_REPO: 'https://github.com/tangxiaoyi97/qedv2-core',
    BANK_REPO: 'https://github.com/tangxiaoyi97/srdpmppr',
    BANK_BRANCH: 'pastpapers',
    QED_BUILD_COMMIT: manifest.core.commit,
    QED2_CORE_ENTRY: coreEntry,
    QED2_CORE_DIRECTORY: coreDirectory,
  }
  delete childEnvironment.NODE_OPTIONS
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [coreHost], {
    cwd: coreDirectory,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.on('data', appendLog)
  child.stderr?.on('data', appendLog)

  try {
    const info = await waitForIdentity(
      `http://127.0.0.1:${port}`,
      child,
      () => logText,
      manifest,
      revisionCatalog,
      revisionCommits,
    )
    process.stdout.write(
      `Bundled Core smoke passed: ${info.version} (${String(info.commit).slice(0, 12)}), ` +
        `bank ${String(info.bank.commit).slice(0, 12)}\n`,
    )
  } finally {
    await stopChild(child)
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  await runSmoke()
}
