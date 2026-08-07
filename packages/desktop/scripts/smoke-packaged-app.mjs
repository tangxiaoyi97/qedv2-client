#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..')
const defaultOutputRoot = path.join(desktopRoot, 'dist-packages')
const MAX_CAPTURE_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

function usageError(message) {
  throw new Error(
    `${message}\nUsage: node scripts/smoke-packaged-app.mjs ` +
      '[--output-root <directory> | --executable <file>] [--cdp-port <port>] ' +
      '[--timeout-ms <milliseconds>] [--diagnostics-dir <directory>] [--no-xvfb]',
  )
}

function parseIntegerOption(name, value, minimum, maximum) {
  if (!/^\d+$/u.test(value ?? '')) usageError(`${name} must be an integer.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    usageError(`${name} must be between ${minimum} and ${maximum}.`)
  }
  return parsed
}

export function parseArguments(argv) {
  let outputRootSpecified = false
  const options = {
    outputRoot: defaultOutputRoot,
    executable: undefined,
    cdpPort: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsDirectory: undefined,
    useXvfb: process.platform === 'linux' && (Boolean(process.env.CI) || !process.env.DISPLAY),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--' && index === 0) continue
    if (argument === '--no-xvfb') {
      options.useXvfb = false
      continue
    }
    const optionNames = [
      '--output-root',
      '--executable',
      '--cdp-port',
      '--timeout-ms',
      '--diagnostics-dir',
    ]
    if (!optionNames.includes(argument)) usageError(`Unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) usageError(`${argument} requires a value.`)
    index += 1
    if (argument === '--output-root') {
      options.outputRoot = path.resolve(value)
      outputRootSpecified = true
    }
    if (argument === '--executable') options.executable = path.resolve(value)
    if (argument === '--cdp-port') options.cdpPort = parseIntegerOption(argument, value, 1, 65_535)
    if (argument === '--timeout-ms') {
      options.timeoutMs = parseIntegerOption(argument, value, 5_000, 300_000)
    }
    if (argument === '--diagnostics-dir') options.diagnosticsDirectory = path.resolve(value)
  }
  if (options.executable && outputRootSpecified) {
    usageError('--executable and --output-root cannot be combined.')
  }
  return options
}

async function regularFile(candidate) {
  try {
    const info = await lstat(candidate)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function visitDirectories(root, depth, visitor) {
  if (depth < 0) return
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await visitor(candidate, entry.name)
      await visitDirectories(candidate, depth - 1, visitor)
    }
  }
}

/** Find exactly one native executable in an electron-builder unpacked tree. */
export async function discoverPackagedExecutable(outputRoot = defaultOutputRoot, platform = process.platform) {
  const root = path.resolve(outputRoot)
  const candidates = []
  try {
    if (platform === 'darwin') {
      await visitDirectories(root, 5, async (directory, name) => {
        if (name !== 'QED2.app') return
        const executable = path.join(directory, 'Contents', 'MacOS', 'QED2')
        if (await regularFile(executable)) candidates.push(executable)
      })
    } else {
      const unpackedSuffix = platform === 'win32' ? 'win-unpacked' : 'linux-unpacked'
      await visitDirectories(root, 4, async (directory, name) => {
        if (!name.endsWith(unpackedSuffix)) return
        const names = platform === 'win32' ? ['QED2.exe'] : ['qed2', 'QED2']
        for (const executableName of names) {
          const executable = path.join(directory, executableName)
          if (await regularFile(executable)) {
            candidates.push(executable)
            break
          }
        }
      })
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`Unpacked package output does not exist: ${root}`)
    }
    throw error
  }
  candidates.sort()
  if (candidates.length === 0) {
    throw new Error(`No unpacked ${platform} QED2 executable was found below ${root}.`)
  }
  if (candidates.length > 1) {
    throw new Error(`More than one unpacked QED2 executable was found below ${root}:\n${candidates.join('\n')}`)
  }
  return candidates[0]
}

export function buildLaunchCommand({ executable, applicationArguments, platform, useXvfb }) {
  if (platform === 'linux' && useXvfb) {
    return {
      command: 'xvfb-run',
      arguments: ['-a', '--server-args=-screen 0 1280x960x24', executable, ...applicationArguments],
    }
  }
  return { command: executable, arguments: applicationArguments }
}

export function buildApplicationArguments({ userData, cdpPort, platform }) {
  return [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${cdpPort}`,
    '--no-first-run',
    // A brand-new macOS profile otherwise opens a Keychain authorization UI
    // before Electron's ready event. This Chromium test boundary keeps the
    // temporary profile self-contained and never touches the user's keychain.
    ...(platform === 'darwin' ? ['--use-mock-keychain'] : []),
  ]
}

async function freeLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a DevTools port.')
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

function boundedAppender() {
  let text = ''
  return {
    append(chunk) {
      if (text.length >= MAX_CAPTURE_BYTES) return
      text += String(chunk).slice(0, MAX_CAPTURE_BYTES - text.length)
    },
    read: () => text,
  }
}

export function redactDiagnosticText(value) {
  return String(value)
    .replace(/\/__qed2_boot\/[A-Za-z0-9_-]+/gu, '/__qed2_boot/[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|secret|password)=)[^&\s"']+/giu, '$1[REDACTED]')
}

function boundedDiagnosticText(value) {
  const redacted = redactDiagnosticText(value)
  if (Buffer.byteLength(redacted) <= MAX_CAPTURE_BYTES) return redacted
  const boundary = Math.floor(MAX_CAPTURE_BYTES / 2)
  return `${redacted.slice(0, boundary)}\n[... diagnostics truncated ...]\n${redacted.slice(-boundary)}`
}

async function fetchJson(origin, pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error(`DevTools ${pathname} returned ${response.status}.`)
  return await response.json()
}

class CdpClient {
  static async connect(webSocketUrl, events = []) {
    const socket = new WebSocket(webSocketUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools WebSocket connection timed out.')), 5_000)
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('DevTools WebSocket connection failed.'))
        },
        { once: true },
      )
    })
    return new CdpClient(socket, events)
  }

  constructor(socket, events) {
    this.socket = socket
    this.events = events
    this.sequence = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(
        typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'),
      )
      if (typeof message.id !== 'number') {
        if (this.events.length < 200) this.events.push(message)
        return
      }
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error('DevTools WebSocket closed.'))
      }
      this.pending.clear()
    })
  }

  call(method, params = {}, timeoutMs = 8_000) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DevTools method timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? 'Renderer evaluation failed.')
    }
    return response.result?.value
  }

  close() {
    this.socket.close()
  }
}

async function waitFor(description, probe, deadline, child) {
  let lastError
  while (Date.now() < deadline) {
    if (child.smokeSpawnError) throw child.smokeSpawnError
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `QED2 exited before ${description} (code=${String(child.exitCode)}, signal=${String(child.signalCode)}).`,
      )
    }
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ''}.`)
}

function pageTarget(targets, predicate) {
  return targets.find((target) => {
    if (target.type !== 'page' || typeof target.url !== 'string') return false
    try {
      return predicate(new URL(target.url))
    } catch {
      return false
    }
  })
}

async function findFiles(root, predicate, depth = 7) {
  const files = []
  const visit = async (directory, remainingDepth) => {
    if (remainingDepth < 0) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(candidate, remainingDepth - 1)
      else if (entry.isFile() && predicate(candidate, entry.name)) files.push(candidate)
    }
  }
  await visit(root, depth)
  return files
}

async function desktopLogs(logRoots) {
  const discovered = await Promise.all(
    logRoots.map(async (root) => await findFiles(root, (_candidate, name) => name === 'desktop.log')),
  )
  return [...new Set(discovered.flat())]
}

async function readDesktopCoreRecord(logRoots, notBefore) {
  const logs = await desktopLogs(logRoots)
  for (const log of logs) {
    const text = await readFile(log, 'utf8')
    for (const line of text.trim().split('\n').reverse()) {
      try {
        const entry = JSON.parse(line)
        const timestamp = Date.parse(entry.at)
        if (!Number.isFinite(timestamp)) continue
        if (timestamp < notBefore) break
        if (entry.message !== 'Local core ready') continue
        const pid = entry.detail?.pid
        const endpoint = entry.detail?.endpoint
        if (Number.isInteger(pid) && pid > 0 && typeof endpoint === 'string') {
          return { pid, endpoint, log }
        }
      } catch {
        // Ignore incomplete log lines while the application is still writing.
      }
    }
  }
  return undefined
}

async function readCurrentDesktopLogs(logRoots, notBefore) {
  const lines = []
  for (const log of await desktopLogs(logRoots)) {
    const text = await readFile(log, 'utf8')
    for (const line of text.trim().split('\n')) {
      try {
        const entry = JSON.parse(line)
        const timestamp = Date.parse(entry.at)
        if (Number.isFinite(timestamp) && timestamp >= notBefore) lines.push(line)
      } catch {
        // The structured logger never intentionally writes non-JSON lines.
      }
    }
  }
  return lines.join('\n')
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && typeof error === 'object' && error.code === 'EPERM'
  }
}

async function endpointAnswers(endpoint) {
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
}

async function forceStopTree(child, platform) {
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return true
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await waitForExit(killer, 10_000)
    return await waitForExit(child, 5_000)
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  if (await waitForExit(child, 5_000)) return true
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  return await waitForExit(child, 5_000)
}

async function forceStopCore(coreRecord) {
  if (!coreRecord || !isProcessAlive(coreRecord.pid)) return
  try {
    process.kill(coreRecord.pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline && isProcessAlive(coreRecord.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!isProcessAlive(coreRecord.pid)) return
  try {
    process.kill(coreRecord.pid, 'SIGKILL')
  } catch {
    // The process exited between the final probe and the force signal.
  }
}

async function copyDiagnostics({
  destination,
  profileRoot,
  output,
  rendererEvents,
  targets,
  screenshot,
  desktopLog,
  isolation,
  error,
}) {
  await mkdir(destination, { recursive: true })
  await writeFile(path.join(destination, 'process-output.log'), boundedDiagnosticText(output), 'utf8')
  await writeFile(
    path.join(destination, 'renderer-events.json'),
    boundedDiagnosticText(JSON.stringify(rendererEvents, null, 2)),
    'utf8',
  )
  await writeFile(
    path.join(destination, 'targets.json'),
    boundedDiagnosticText(JSON.stringify(targets, null, 2)),
    'utf8',
  )
  if (screenshot) {
    await writeFile(path.join(destination, 'renderer.png'), Buffer.from(screenshot, 'base64'))
  }
  if (desktopLog) {
    await writeFile(
      path.join(destination, 'desktop-current-run.log'),
      boundedDiagnosticText(desktopLog),
      'utf8',
    )
  }
  await writeFile(
    path.join(destination, 'failure.txt'),
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    'utf8',
  )
  await writeFile(
    path.join(destination, 'smoke-context.json'),
    `${JSON.stringify(isolation, null, 2)}\n`,
    'utf8',
  )
  const logs = await findFiles(
    profileRoot,
    (_candidate, name) =>
      name === 'desktop.log' ||
      /^desktop\.log\.\d+$/u.test(name) ||
      name === 'electron.log' ||
      name === 'chrome_debug.log',
  )
  for (const [index, log] of logs.entries()) {
    await readFile(log, 'utf8')
      .then((text) =>
        writeFile(
          path.join(destination, `${index}-${path.basename(log)}`),
          boundedDiagnosticText(text),
          'utf8',
        ),
      )
      .catch(() => undefined)
  }
}

export async function runSmoke(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const executable = options.executable ?? (await discoverPackagedExecutable(options.outputRoot))
  if (!(await regularFile(executable))) throw new Error(`Packaged executable does not exist: ${executable}`)

  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'qed2-packaged-smoke-'))
  const userData = path.join(isolatedRoot, 'user-data')
  const isolatedHome = path.join(isolatedRoot, 'home')
  await mkdir(userData, { recursive: true, mode: 0o700 })
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 })
  const cdpPort = options.cdpPort ?? (await freeLoopbackPort())
  const cdpOrigin = `http://127.0.0.1:${cdpPort}`
  const applicationArguments = buildApplicationArguments({
    userData,
    cdpPort,
    platform: process.platform,
  })
  const launch = buildLaunchCommand({
    executable,
    applicationArguments,
    platform: process.platform,
    useXvfb: options.useXvfb,
  })
  const launchedAt = Date.now()
  const logRoots = [
    isolatedRoot,
    ...(process.platform === 'darwin' ? [path.join(os.homedir(), 'Library', 'Logs', 'QED2')] : []),
  ]
  const environment = {
    ...process.env,
    ...(process.platform === 'linux'
      ? {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
          XDG_CACHE_HOME: path.join(isolatedHome, '.cache'),
          XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
        }
      : {}),
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_LOG_FILE: path.join(isolatedRoot, 'electron.log'),
  }
  delete environment.NODE_OPTIONS
  delete environment.ELECTRON_RUN_AS_NODE

  const output = boundedAppender()
  const rendererEvents = []
  let latestTargets = []
  let child
  let mainClient
  let browserClient
  let coreRecord
  let failureScreenshot
  let primaryError
  const deadline = Date.now() + options.timeoutMs

  try {
    child = spawn(launch.command, launch.arguments, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,
    })
    child.stdout?.on('data', output.append)
    child.stderr?.on('data', output.append)
    child.once('error', (error) => {
      child.smokeSpawnError = error
      output.append(error)
    })

    const version = await waitFor(
      'the DevTools endpoint',
      async () => await fetchJson(cdpOrigin, '/json/version'),
      deadline,
      child,
    )
    browserClient = await CdpClient.connect(version.webSocketDebuggerUrl, rendererEvents)

    const mainTarget = await waitFor(
      'the main renderer target',
      async () => {
        latestTargets = await fetchJson(cdpOrigin, '/json/list')
        return pageTarget(
          latestTargets,
          (url) => !url.searchParams.has('desktopWindow') && url.pathname !== '/practice',
        )
      },
      deadline,
      child,
    )
    mainClient = await CdpClient.connect(mainTarget.webSocketDebuggerUrl, rendererEvents)
    await Promise.all([
      mainClient.call('Runtime.enable'),
      mainClient.call('Log.enable'),
      mainClient.call('Page.enable'),
    ])

    const shell = await waitFor(
      'the Desktop renderer shell',
      async () => {
        const value = await mainClient.evaluate(`({
          platform: document.querySelector('.app')?.dataset.platform,
          desktopEntry: Boolean(document.querySelector('[data-desktop-capability-entry]')),
          bodyText: document.body?.innerText?.slice(0, 200),
        })`)
        return value.platform === 'desktop' && value.desktopEntry ? value : undefined
      },
      deadline,
      child,
    )
    if (shell.platform !== 'desktop' || !shell.desktopEntry) {
      throw new Error('The renderer did not expose the typed Desktop capability UI.')
    }

    await mainClient.evaluate(`document.querySelector('[data-desktop-capability-entry]')?.click()`)
    await waitFor(
      'the embedded Desktop settings',
      async () => {
        const value = await mainClient.evaluate(`({
          section: new URLSearchParams(location.search).get('section'),
          actions: document.querySelectorAll('[data-desktop-window-target]').length,
        })`)
        return value.section === 'desktop' && value.actions === 3 ? value : undefined
      },
      deadline,
      child,
    )

    await waitFor(
      'the bundled local Core',
      async () => {
        const value = await mainClient.evaluate(`({
          phase: document.querySelector('.desktop-settings__state')?.dataset.phase,
          runtimeSection: Boolean(document.querySelector('#runtime-title')),
        })`)
        return value.phase === 'ready' && value.runtimeSection ? value : undefined
      },
      deadline,
      child,
    )

    coreRecord = await waitFor(
      'the isolated Core lifecycle record',
      async () => await readDesktopCoreRecord(logRoots, launchedAt),
      deadline,
      child,
    )
    if (!(await endpointAnswers(coreRecord.endpoint))) {
      throw new Error(`The ready local Core did not answer ${coreRecord.endpoint}/health.`)
    }

    await mainClient.evaluate(
      `document.querySelector('[data-desktop-window-target="node"]')?.click()`,
    )
    const nodeTarget = await waitFor(
      'the native node diagnostics window',
      async () => {
        latestTargets = await fetchJson(cdpOrigin, '/json/list')
        return pageTarget(latestTargets, (url) => url.searchParams.get('desktopWindow') === 'node')
      },
      deadline,
      child,
    )
    const nodeClient = await CdpClient.connect(nodeTarget.webSocketDebuggerUrl, rendererEvents)
    try {
      await waitFor(
        'the node diagnostics renderer',
        async () => {
          const value = await nodeClient.evaluate(`({
            platform: document.querySelector('.app')?.dataset.platform,
            title: Boolean(document.querySelector('#desktop-title')),
            runtimeSection: Boolean(document.querySelector('#runtime-title')),
          })`)
          return value.platform === 'desktop' && value.title && value.runtimeSection ? value : undefined
        },
        deadline,
        child,
      )
    } finally {
      nodeClient.close()
    }

    await mainClient.evaluate(
      `document.querySelector('[data-desktop-window-target="node"]')?.click()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    latestTargets = await fetchJson(cdpOrigin, '/json/list')
    const nodeWindows = latestTargets.filter((target) => {
      try {
        return target.type === 'page' && new URL(target.url).searchParams.get('desktopWindow') === 'node'
      } catch {
        return false
      }
    })
    if (nodeWindows.length !== 1 || nodeWindows[0].id !== nodeTarget.id) {
      throw new Error('The node diagnostics window is not a stable singleton.')
    }

    mainClient.close()
    mainClient = undefined
    await browserClient.call('Browser.close').catch(() => undefined)
    browserClient = undefined
    if (!(await waitForExit(child, 15_000))) {
      throw new Error('QED2 did not exit after the browser close request.')
    }
    if (child.exitCode !== 0) {
      throw new Error(`QED2 exited with code ${String(child.exitCode)} after a successful smoke run.`)
    }
    const lifecycleDeadline = Date.now() + 10_000
    while (
      Date.now() < lifecycleDeadline &&
      (isProcessAlive(coreRecord.pid) || (await endpointAnswers(coreRecord.endpoint)))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    if (isProcessAlive(coreRecord.pid) || (await endpointAnswers(coreRecord.endpoint))) {
      throw new Error(
        `The local Core survived Desktop shutdown (pid=${coreRecord.pid}, endpoint=${coreRecord.endpoint}).`,
      )
    }

    process.stdout.write(
      `Packaged Desktop smoke passed: ${path.basename(executable)}, renderer + preload capability + ` +
        `local Core + node-window singleton (CDP ${cdpPort}, ` +
        `temporary userData${process.platform === 'darwin' ? ', mock Keychain' : ''}).\n`,
    )
  } catch (error) {
    primaryError = error
    failureScreenshot = await mainClient
      ?.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      .then((result) => result.data)
      .catch(() => undefined)
  } finally {
    mainClient?.close()
    browserClient?.close()
    coreRecord ??= await readDesktopCoreRecord(logRoots, launchedAt).catch(() => undefined)
    const desktopStopped = child ? await forceStopTree(child, process.platform) : true
    await forceStopCore(coreRecord)
    const coreStopped =
      !coreRecord || (!isProcessAlive(coreRecord.pid) && !(await endpointAnswers(coreRecord.endpoint)))
    if ((!desktopStopped || !coreStopped) && !primaryError) {
      primaryError = new Error('The packaged smoke could not fully stop QED2 and its local Core.')
    } else if (!desktopStopped || !coreStopped) {
      output.append(
        `\n[qed2-smoke] Cleanup incomplete: desktopStopped=${desktopStopped} coreStopped=${coreStopped}\n`,
      )
    }
    if (primaryError) {
      const destination =
        options.diagnosticsDirectory ??
        path.join(os.tmpdir(), `qed2-packaged-smoke-diagnostics-${Date.now()}`)
      await copyDiagnostics({
        destination,
        profileRoot: isolatedRoot,
        output: output.read(),
        rendererEvents,
        targets: latestTargets,
        screenshot: failureScreenshot,
        desktopLog: await readCurrentDesktopLogs(logRoots, launchedAt).catch(() => ''),
        isolation: {
          temporaryUserData: true,
          macMockKeychain: process.platform === 'darwin',
          persistentProfileTouched: false,
          platformLogDirectoryUsed: process.platform === 'darwin',
        },
        error: primaryError,
      })
      process.stderr.write(`Packaged Desktop smoke diagnostics: ${destination}\n`)
      if (output.read()) {
        process.stderr.write(`--- QED2 process output ---\n${boundedDiagnosticText(output.read())}\n`)
      }
    }
    if (desktopStopped && coreStopped) {
      await rm(isolatedRoot, { recursive: true, force: true })
    } else {
      process.stderr.write(`Packaged Desktop smoke retained the live-process profile: ${isolatedRoot}\n`)
    }
  }
  if (primaryError) throw primaryError
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) await runSmoke()
