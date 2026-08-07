import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverPackagedRuntimeRoot,
  parseArguments,
  selectRevisionQuestionSample,
  validateRevisionCommitOrder,
  verifyRuntimeInventory,
} from '../scripts/smoke-runtime.mjs'

const ROOTS = [
  'core/dist',
  'core/node_modules',
  'bank/content',
  'bank/assets',
  'bank/schema',
  'bank/revisions',
]
const FILES = ['core/package.json', 'core/pnpm-lock.yaml', 'bank/VERSION']

async function runtimeFixture(root) {
  const records = []
  for (const directory of ROOTS) {
    await mkdir(path.join(root, directory), { recursive: true })
    const relativePath = `${directory}/fixture.txt`
    const bytes = Buffer.from(relativePath)
    await writeFile(path.join(root, relativePath), bytes)
    records.push({
      path: relativePath,
      type: 'file',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  for (const relativePath of FILES) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true })
    const bytes = Buffer.from(relativePath)
    await writeFile(path.join(root, relativePath), bytes)
    records.push({
      path: relativePath,
      type: 'file',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  records.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { files: records }
}

describe('runtime smoke helpers', () => {
  it('parses source, packaged and explicit runtime modes without ambiguity', () => {
    expect(parseArguments([])).toEqual({ packaged: false, runtimeRoot: undefined })
    expect(parseArguments(['--packaged'])).toEqual({ packaged: true, runtimeRoot: undefined })
    expect(parseArguments(['--', '--packaged'])).toEqual({ packaged: true, runtimeRoot: undefined })
    expect(parseArguments(['--runtime-root', '.']).runtimeRoot).toBe(process.cwd())
    expect(() => parseArguments(['--packaged', '--runtime-root', '.'])).toThrow(/cannot be combined/u)
  })

  it('discovers macOS, Windows and Linux unpacked resource layouts without fixed arch paths', async () => {
    for (const relativePath of [
      'mac-arm64/QED2.app/Contents/Resources/runtime',
      'win-unpacked/resources/runtime',
      'linux-unpacked/resources/runtime',
    ]) {
      const output = await mkdtemp(path.join(tmpdir(), 'qed2-packaged-runtime-'))
      const runtime = path.join(output, relativePath)
      await mkdir(runtime, { recursive: true })
      await writeFile(path.join(runtime, 'runtime-manifest.json'), '{}')
      await expect(discoverPackagedRuntimeRoot(output)).resolves.toBe(runtime)
    }
  })

  it('rejects ambiguous unpacked outputs instead of testing an arbitrary runtime', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'qed2-packaged-runtime-'))
    for (const relativePath of [
      'mac/QED2.app/Contents/Resources/runtime',
      'win-unpacked/resources/runtime',
    ]) {
      const runtime = path.join(output, relativePath)
      await mkdir(runtime, { recursive: true })
      await writeFile(path.join(runtime, 'runtime-manifest.json'), '{}')
    }
    await expect(discoverPackagedRuntimeRoot(output)).rejects.toThrow(/More than one packaged runtime/u)
  })

  it('detects missing, altered and unmanifested files in the copied runtime', async () => {
    const runtime = await mkdtemp(path.join(tmpdir(), 'qed2-runtime-integrity-'))
    const manifest = await runtimeFixture(runtime)
    await expect(verifyRuntimeInventory(runtime, manifest)).resolves.toMatchObject({
      checkedFiles: manifest.files.length,
    })

    await writeFile(path.join(runtime, 'bank/content/fixture.txt'), 'altered')
    await expect(verifyRuntimeInventory(runtime, manifest)).rejects.toThrow(/integrity mismatch/u)

    const extraRuntime = await mkdtemp(path.join(tmpdir(), 'qed2-runtime-integrity-'))
    const extraManifest = await runtimeFixture(extraRuntime)
    await writeFile(path.join(extraRuntime, 'bank/content/.DS_Store'), 'junk')
    await expect(verifyRuntimeInventory(extraRuntime, extraManifest)).rejects.toThrow(/inventory mismatch/u)

    const missingRuntime = await mkdtemp(path.join(tmpdir(), 'qed2-runtime-integrity-'))
    const missingManifest = await runtimeFixture(missingRuntime)
    await unlink(path.join(missingRuntime, 'bank/assets/fixture.txt'))
    await expect(verifyRuntimeInventory(missingRuntime, missingManifest)).rejects.toThrow(/inventory mismatch/u)
  })

  it('keeps an empty root commit while sampling the earliest non-empty immutable revision', () => {
    const emptyCommit = '1'.repeat(40)
    const populatedCommit = '2'.repeat(40)
    const pinnedCommit = '3'.repeat(40)
    const manifest = {
      revisions: {
        commitCount: 3,
        pinnedCommit,
        questionRevisionCount: 2,
      },
    }
    const firstHash = 'a'.repeat(64)
    const secondHash = 'b'.repeat(64)
    const catalog = {
      commitOrder: [emptyCommit, populatedCommit, pinnedCommit],
      commits: {
        [emptyCommit]: { questions: {} },
        [populatedCommit]: {
          questions: { 'question-1': { contentHash: firstHash, wireHash: 'c'.repeat(64) } },
        },
        [pinnedCommit]: {
          questions: { 'question-2': { contentHash: secondHash, wireHash: 'd'.repeat(64) } },
        },
      },
    }
    const commits = validateRevisionCommitOrder(catalog, manifest)
    expect(commits).toEqual([emptyCommit, populatedCommit, pinnedCommit])

    expect(
      selectRevisionQuestionSample(
        [
          { commit: emptyCommit, items: {} },
          { commit: populatedCommit, items: { 'question-1': firstHash } },
          { commit: pinnedCommit, items: { 'question-2': secondHash } },
        ],
        commits,
        2,
        catalog,
      ),
    ).toEqual({ commit: populatedCommit, questionId: 'question-1', contentHash: firstHash })
  })

  it('rejects incomplete commit inventories and revision counts', () => {
    const commit = '1'.repeat(40)
    const manifest = {
      revisions: { commitCount: 1, pinnedCommit: commit, questionRevisionCount: 1 },
    }
    expect(() => validateRevisionCommitOrder({ commitOrder: [commit], commits: {} }, manifest)).toThrow(
      /inventory is incomplete/u,
    )
    expect(() =>
      selectRevisionQuestionSample(
        [{ commit, items: {} }],
        [commit],
        1,
        { commits: { [commit]: { questions: {} } } },
      ),
    ).toThrow(/revision count mismatch/u)
    expect(() =>
      selectRevisionQuestionSample(
        [{ commit, items: { question: 'not-a-hash' } }],
        [commit],
        1,
        { commits: { [commit]: { questions: {} } } },
      ),
    ).toThrow(/invalid revision metadata/u)
    expect(() =>
      selectRevisionQuestionSample(
        [{ commit, items: {} }],
        [commit],
        0,
        { commits: { [commit]: { questions: {} } } },
      ),
    ).toThrow(/contains no historical questions/u)
  })

  it('rejects a repeated manifest even when every revision has the same item count', () => {
    const firstCommit = '1'.repeat(40)
    const secondCommit = '2'.repeat(40)
    const firstHash = 'a'.repeat(64)
    const secondHash = 'b'.repeat(64)
    const catalog = {
      commits: {
        [firstCommit]: { questions: { question: { contentHash: firstHash } } },
        [secondCommit]: { questions: { question: { contentHash: secondHash } } },
      },
    }
    expect(() =>
      selectRevisionQuestionSample(
        [
          { commit: firstCommit, items: { question: firstHash } },
          { commit: secondCommit, items: { question: firstHash } },
        ],
        [firstCommit, secondCommit],
        2,
        catalog,
      ),
    ).toThrow(/does not match the catalog/u)
  })
})
