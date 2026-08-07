import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildApplicationArguments,
  buildLaunchCommand,
  discoverPackagedExecutable,
  parseArguments,
  redactDiagnosticText,
  verifyPackagedElectronFuses,
  verifyPackagedThemeIcons,
} from '../scripts/smoke-packaged-app.mjs'

async function executableFixture(root, relativePath) {
  const executable = path.join(root, relativePath)
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(executable, 'fixture')
  await chmod(executable, 0o755)
  return executable
}

describe('packaged application smoke helpers', () => {
  it('parses bounded launch options and rejects ambiguous sources', () => {
    expect(parseArguments(['--cdp-port', '49152', '--timeout-ms', '90000'])).toMatchObject({
      cdpPort: 49_152,
      timeoutMs: 90_000,
    })
    expect(parseArguments(['--', '--no-xvfb']).useXvfb).toBe(false)
    expect(() => parseArguments(['--cdp-port', '0'])).toThrow(/between 1 and 65535/u)
    expect(() => parseArguments(['--timeout-ms', '1000'])).toThrow(/between 5000 and 300000/u)
    expect(() =>
      parseArguments(['--executable', '/tmp/QED2', '--output-root', '/tmp/packages']),
    ).toThrow(/cannot be combined/u)
    expect(() => parseArguments(['--unknown', 'value'])).toThrow(/Unknown argument/u)
  })

  it('discovers native executables in macOS, Windows and Linux unpacked layouts', async () => {
    const cases = [
      ['darwin', 'mac-arm64/QED2.app/Contents/MacOS/QED2'],
      ['win32', 'win-unpacked/QED2.exe'],
      ['linux', 'linux-unpacked/qed2'],
    ]
    for (const [platform, relativePath] of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'qed2-packaged-app-'))
      const executable = await executableFixture(root, relativePath)
      await expect(discoverPackagedExecutable(root, platform)).resolves.toBe(executable)
    }
  })

  it('fails closed for missing and ambiguous unpacked applications', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'qed2-packaged-app-'))
    await expect(discoverPackagedExecutable(empty, 'linux')).rejects.toThrow(/No unpacked linux/u)

    const ambiguous = await mkdtemp(path.join(os.tmpdir(), 'qed2-packaged-app-'))
    await executableFixture(ambiguous, 'one/win-unpacked/QED2.exe')
    await executableFixture(ambiguous, 'two/win-unpacked/QED2.exe')
    await expect(discoverPackagedExecutable(ambiguous, 'win32')).rejects.toThrow(/More than one/u)
  })

  it('fails packaged smoke when a generated theme icon was omitted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qed2-packaged-icons-'))
    const executable = await executableFixture(root, 'linux-unpacked/qed2')
    for (const theme of ['weed', 'sky', 'raspberry', 'violette']) {
      const icon = path.join(root, 'linux-unpacked/resources/theme-icons', theme, 'icon-512.png')
      await mkdir(path.dirname(icon), { recursive: true })
      await writeFile(icon, 'icon')
    }
    await expect(verifyPackagedThemeIcons(executable, 'linux')).resolves.toContain('resources')

    const missingRoot = await mkdtemp(path.join(os.tmpdir(), 'qed2-packaged-icons-'))
    const missingExecutable = await executableFixture(missingRoot, 'linux-unpacked/qed2')
    await expect(verifyPackagedThemeIcons(missingExecutable, 'linux')).rejects.toThrow(
      /theme icon resources are incomplete/u,
    )
  })

  it('requires every Electron 42 fuse, including Wasm trap handlers, to be explicit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qed2-packaged-fuses-'))
    const executable = await executableFixture(root, 'linux-unpacked/qed2')
    const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
    const expectedStates = Buffer.from('000011001')
    await writeFile(executable, Buffer.concat([Buffer.from('prefix'), sentinel, Buffer.from([1, 9]), expectedStates]))
    await expect(verifyPackagedElectronFuses(executable, 'linux')).resolves.toMatchObject({ slices: 1 })

    const wrongWasm = Buffer.from(expectedStates)
    wrongWasm[8] = 0x30
    await writeFile(executable, Buffer.concat([sentinel, Buffer.from([1, 9]), wrongWasm]))
    await expect(verifyPackagedElectronFuses(executable, 'linux')).rejects.toThrow(/WasmTrapHandlers/u)

    await writeFile(
      executable,
      Buffer.concat([sentinel, Buffer.from([1, 10]), expectedStates, Buffer.from('1')]),
    )
    await expect(verifyPackagedElectronFuses(executable, 'linux')).rejects.toThrow(/unsupported/u)
  })

  it('uses Xvfb only for the requested Linux launch boundary', () => {
    const applicationArguments = ['--user-data-dir=/tmp/profile', '--remote-debugging-port=9223']
    expect(
      buildLaunchCommand({
        executable: '/tmp/qed2',
        applicationArguments,
        platform: 'linux',
        useXvfb: true,
      }),
    ).toEqual({
      command: 'xvfb-run',
      arguments: [
        '-a',
        '--server-args=-screen 0 1280x960x24',
        '/tmp/qed2',
        ...applicationArguments,
      ],
    })
    expect(
      buildLaunchCommand({
        executable: 'QED2.exe',
        applicationArguments,
        platform: 'win32',
        useXvfb: true,
      }),
    ).toEqual({ command: 'QED2.exe', arguments: applicationArguments })
  })

  it('isolates the profile and avoids interactive Keychain UI only on macOS', () => {
    expect(
      buildApplicationArguments({ userData: '/tmp/profile', cdpPort: 9223, platform: 'darwin' }),
    ).toEqual([
      '--user-data-dir=/tmp/profile',
      '--remote-debugging-port=9223',
      '--no-first-run',
      '--use-mock-keychain',
    ])
    expect(
      buildApplicationArguments({ userData: 'C:\\temp\\profile', cdpPort: 9223, platform: 'win32' }),
    ).not.toContain('--use-mock-keychain')
  })

  it('redacts ephemeral renderer credentials from failure diagnostics', () => {
    expect(
      redactDiagnosticText(
        'http://127.0.0.1:1122/__qed2_boot/secretBootToken?token=abc Bearer real-token',
      ),
    ).toBe(
      'http://127.0.0.1:1122/__qed2_boot/[REDACTED]?token=[REDACTED] Bearer [REDACTED]',
    )
  })
})
