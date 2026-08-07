import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverPackagedRuntimeRoot,
  parseArguments,
  verifyRuntimeInventory,
} from '../scripts/smoke-runtime.mjs'

const ROOTS = ['core/dist', 'core/node_modules', 'bank/content', 'bank/assets', 'bank/schema']
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
})
