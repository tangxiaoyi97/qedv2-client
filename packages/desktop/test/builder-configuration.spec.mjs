import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktopRoot = fileURLToPath(new URL('../', import.meta.url))
const localRequire = createRequire(import.meta.url)
const electronBuilderRequire = createRequire(localRequire.resolve('electron-builder/package.json'))
const appBuilderRequire = createRequire(electronBuilderRequire.resolve('app-builder-lib/package.json'))
const { getConfig, validateConfiguration } = appBuilderRequire('./out/util/config/config.js')
const { DebugLogger } = appBuilderRequire('builder-util')

async function configuration(name) {
  return getConfig(desktopRoot, path.join(desktopRoot, name), undefined)
}

describe('actual electron-builder configuration schema', () => {
  it.each([
    'electron-builder.yml',
    'electron-builder.unsigned.yml',
    'electron-builder.preview.yml',
  ])('accepts the fully inherited %s configuration', async (name) => {
    const config = await configuration(name)
    await expect(validateConfiguration(config, new DebugLogger(false))).resolves.toBeUndefined()
  })

  it('keeps preview Linux installation names separate through supported per-format options', async () => {
    const config = await configuration('electron-builder.preview.yml')
    expect(config).toMatchObject({
      appId: 'studio.barcarolle.qed2.preview',
      productName: 'QED2 Preview',
      publish: null,
      linux: { executableName: 'qed2-preview' },
      deb: { packageName: 'qed2-preview' },
      rpm: { packageName: 'qed2-preview' },
    })
    expect(config.linux.packageName).toBeUndefined()
  })
})
