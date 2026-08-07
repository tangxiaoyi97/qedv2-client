import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { parseUpdateManifest, verifyReleaseAssets } from '../scripts/verify-release-assets.mjs'

const VERSION = '2.0.0'
const TAG = `v${VERSION}`
const CLIENT_SHA = '1'.repeat(40)
const CORE_SHA = '2'.repeat(40)
const BANK_SHA = '3'.repeat(40)
const temporaryDirectories = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function sha512(content) {
  return createHash('sha512').update(content).digest('base64')
}

function embeddedAppImage(content, inventoriedSize) {
  const payload = Buffer.from(content)
  const blockMap = {
    version: '2',
    files: [
      {
        name: 'file',
        offset: 0,
        checksums: [Buffer.alloc(18, 7).toString('base64')],
        sizes: [inventoriedSize ?? payload.length],
      },
    ],
  }
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(blockMap)), { level: 9 })
  const sizeHeader = Buffer.allocUnsafe(4)
  sizeHeader.writeUInt32BE(compressed.length, 0)
  return {
    bytes: Buffer.concat([payload, compressed, sizeHeader]),
    blockMapSize: compressed.length,
  }
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'qed2-release-assets-'))
  temporaryDirectories.push(root)
  const appImage = options.appImage ?? embeddedAppImage('appimage payload')
  const binaries = {
    [`QED2-${VERSION}-mac-arm64.dmg`]: 'arm dmg',
    [`QED2-${VERSION}-mac-arm64.zip`]: 'arm zip',
    [`QED2-${VERSION}-mac-x64.dmg`]: 'intel dmg',
    [`QED2-${VERSION}-mac-x64.zip`]: 'intel zip',
    [`QED2-${VERSION}-win-x64.exe`]: 'windows',
    [`QED2-${VERSION}-linux-x64.AppImage`]: appImage.bytes,
    [`QED2-${VERSION}-linux-x64.deb`]: 'deb',
    [`QED2-${VERSION}-linux-x64.rpm`]: 'rpm',
  }
  for (const [name, content] of Object.entries(binaries)) await writeFile(path.join(root, name), content)

  const updateFiles = [
    `QED2-${VERSION}-mac-arm64.zip`,
    `QED2-${VERSION}-mac-x64.zip`,
    `QED2-${VERSION}-win-x64.exe`,
  ]
  for (const name of updateFiles) await writeFile(path.join(root, `${name}.blockmap`), `blockmap ${name}`)

  const metadata = (names, legacy = names[0]) => {
    const lines = [`version: ${VERSION}`, 'files:']
    for (const name of names) {
      const content = binaries[name]
      lines.push(`  - url: ${name}`, `    sha512: ${sha512(content)}`, `    size: ${Buffer.byteLength(content)}`)
      if (name.endsWith('.AppImage')) lines.push(`    blockMapSize: ${appImage.blockMapSize}`)
    }
    lines.push(`path: ${legacy}`, `sha512: ${sha512(binaries[legacy])}`, "releaseDate: '2026-08-07T00:00:00.000Z'")
    return `${lines.join('\n')}\n`
  }
  await writeFile(path.join(root, 'latest.yml'), metadata([`QED2-${VERSION}-win-x64.exe`]))
  await writeFile(
    path.join(root, 'latest-mac.yml'),
    metadata([`QED2-${VERSION}-mac-arm64.zip`, `QED2-${VERSION}-mac-x64.zip`], `QED2-${VERSION}-mac-x64.zip`),
  )
  await writeFile(
    path.join(root, 'latest-linux.yml'),
    metadata([
      `QED2-${VERSION}-linux-x64.AppImage`,
      `QED2-${VERSION}-linux-x64.deb`,
      `QED2-${VERSION}-linux-x64.rpm`,
    ]),
  )
  await writeFile(
    path.join(root, 'runtime-sources.txt'),
    `QED2 desktop release ${TAG}\nclient ${CLIENT_SHA}\ncore main ${CORE_SHA}\nbank pastpapers ${BANK_SHA}\n`,
  )
  return { root, binaries, appImage }
}

describe('release asset verification', () => {
  it('parses the bounded electron-updater metadata shape', () => {
    expect(
      parseUpdateManifest(
        'version: 2.0.0\nfiles:\n  - url: app.AppImage\n    sha512: abc\n    size: 30\n    blockMapSize: 10\npath: app.AppImage\nsha512: abc\n',
      ),
    ).toMatchObject({
      version: '2.0.0',
      files: [{ url: 'app.AppImage', sha512: 'abc', size: 30, blockMapSize: 10 }],
    })
  })

  it('validates hashes and emits provenance plus checksums', async () => {
    const { root } = await fixture()
    const manifest = await verifyReleaseAssets({
      root,
      version: VERSION,
      tag: TAG,
      clientSha: CLIENT_SHA,
      coreSha: CORE_SHA,
      bankSha: BANK_SHA,
    })
    expect(manifest.updateMetadata['latest-mac.yml']).toHaveLength(2)
    expect(manifest.updateMetadata['latest-linux.yml']).toEqual([
      `QED2-${VERSION}-linux-x64.AppImage`,
      `QED2-${VERSION}-linux-x64.deb`,
      `QED2-${VERSION}-linux-x64.rpm`,
    ])
    expect(JSON.parse(await readFile(path.join(root, 'release-manifest.json'), 'utf8'))).toEqual(manifest)
    expect(await readFile(path.join(root, 'SHA256SUMS'), 'utf8')).toContain(`QED2-${VERSION}-win-x64.exe`)
  })

  it('requires the AppImage metadata to match its embedded blockmap trailer', async () => {
    const { root, appImage } = await fixture()
    const manifestPath = path.join(root, 'latest-linux.yml')
    const manifest = await readFile(manifestPath, 'utf8')
    await writeFile(
      manifestPath,
      manifest.replace(`blockMapSize: ${appImage.blockMapSize}`, `blockMapSize: ${appImage.blockMapSize - 1}`),
    )
    await expect(
      verifyReleaseAssets({
        root,
        version: VERSION,
        tag: TAG,
        clientSha: CLIENT_SHA,
        coreSha: CORE_SHA,
        bankSha: BANK_SHA,
      }),
    ).rejects.toThrow(/trailer length does not match metadata/u)
  })

  it('requires AppImage blockMapSize metadata', async () => {
    const { root, appImage } = await fixture()
    const manifestPath = path.join(root, 'latest-linux.yml')
    const manifest = await readFile(manifestPath, 'utf8')
    await writeFile(
      manifestPath,
      manifest.replace(`    blockMapSize: ${appImage.blockMapSize}\n`, ''),
    )
    await expect(
      verifyReleaseAssets({
        root,
        version: VERSION,
        tag: TAG,
        clientSha: CLIENT_SHA,
        coreSha: CORE_SHA,
        bankSha: BANK_SHA,
      }),
    ).rejects.toThrow(/invalid embedded blockMapSize/u)
  })

  it('rejects an embedded block inventory that does not cover the AppImage payload', async () => {
    const { root } = await fixture({ appImage: embeddedAppImage('appimage payload', 3) })
    await expect(
      verifyReleaseAssets({
        root,
        version: VERSION,
        tag: TAG,
        clientSha: CLIENT_SHA,
        coreSha: CORE_SHA,
        bankSha: BANK_SHA,
      }),
    ).rejects.toThrow(/block inventory does not cover the payload/u)
  })

  it('rejects an AppImage sidecar because AppImage blockmaps are embedded', async () => {
    const { root } = await fixture()
    await writeFile(path.join(root, `QED2-${VERSION}-linux-x64.AppImage.blockmap`), 'not used')
    await expect(
      verifyReleaseAssets({
        root,
        version: VERSION,
        tag: TAG,
        clientSha: CLIENT_SHA,
        coreSha: CORE_SHA,
        bankSha: BANK_SHA,
      }),
    ).rejects.toThrow(/must use its embedded blockmap/u)
  })

  it('validates full-package Linux deb/rpm hashes without inventing blockmaps', async () => {
    const { root } = await fixture()
    await writeFile(path.join(root, `QED2-${VERSION}-linux-x64.deb`), 'tampered deb')
    await expect(
      verifyReleaseAssets({
        root,
        version: VERSION,
        tag: TAG,
        clientSha: CLIENT_SHA,
        coreSha: CORE_SHA,
        bankSha: BANK_SHA,
      }),
    ).rejects.toThrow(/size mismatch|SHA-512 mismatch/u)
  })

  it('fails closed when metadata does not match the downloaded artifact', async () => {
    const { root } = await fixture()
    await writeFile(path.join(root, `QED2-${VERSION}-win-x64.exe`), 'tampered')
    await expect(
      verifyReleaseAssets({
        root,
        version: VERSION,
        tag: TAG,
        clientSha: CLIENT_SHA,
        coreSha: CORE_SHA,
        bankSha: BANK_SHA,
      }),
    ).rejects.toThrow(/size mismatch|SHA-512 mismatch/u)
  })
})
