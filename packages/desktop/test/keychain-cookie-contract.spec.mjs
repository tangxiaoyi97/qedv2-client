import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')

describe('Keychain and cookie isolation contract', () => {
  it('does not initialize Chromium Cookie Encryption in a user package', async () => {
    const builder = await readFile(path.join(DESKTOP_ROOT, 'electron-builder.yml'), 'utf8')
    expect(builder).toMatch(/enableCookieEncryption:\s*false/u)
    expect(builder).not.toMatch(/enableCookieEncryption:\s*true/u)
  })

  it('clears legacy cookies and rejects future Set-Cookie headers', async () => {
    const main = await readFile(path.join(DESKTOP_ROOT, 'src/main.ts'), 'utf8')
    expect(main).toContain("normalized === 'set-cookie'")
    expect(main).toContain("storages: ['cookies', 'serviceworkers']")
  })

  it('keeps mock Keychain use confined to the isolated packaged smoke', async () => {
    const main = await readFile(path.join(DESKTOP_ROOT, 'src/main.ts'), 'utf8')
    const builder = await readFile(path.join(DESKTOP_ROOT, 'electron-builder.yml'), 'utf8')
    const unsignedBuilder = await readFile(
      path.join(DESKTOP_ROOT, 'electron-builder.unsigned.yml'),
      'utf8',
    )
    expect(`${main}\n${builder}\n${unsignedBuilder}`).not.toContain('--use-mock-keychain')

    const smoke = await readFile(
      path.join(DESKTOP_ROOT, 'scripts/smoke-packaged-app.mjs'),
      'utf8',
    )
    expect(smoke).toContain('--use-mock-keychain')
  })
})
