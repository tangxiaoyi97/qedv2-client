import { EventEmitter } from 'node:events';
import {
  DEFAULT_CONFIG,
  type ClientConfig,
  type CoreEndpoint,
  type CoreRecoveryAction,
  type CoreRuntimeStatus,
} from '@qed2/core-logic';
import {
  allocateLoopbackPort,
  isPortAvailable,
  LOOPBACK_HOST,
} from './port-allocator.js';
import type { RuntimeDescriptor } from './runtime-layout.js';
import {
  isRuntimeIntegrityError,
  verifyRuntimeIntegrity,
  type RuntimeIntegrityResult,
} from './runtime-integrity.js';

export interface ManagedCoreProcess {
  readonly pid?: number | undefined;
  kill(force?: boolean): boolean;
  onExit(cb: (code: number) => void): void;
  onStdout(cb: (line: string) => void): void;
  onStderr(cb: (line: string) => void): void;
}

export interface CoreProcessLauncher {
  launch(options: {
    entry: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): ManagedCoreProcess;
}

export interface SupervisorLogger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

const RESTART_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const STABLE_RUNTIME_MS = 60_000;
const PORT_CANDIDATE_ATTEMPTS = 100;
const MAX_BIND_COLLISION_RETRIES = 8;
const VERIFIED_REINSTALL_MESSAGE =
  'Die gebündelte lokale Laufzeit ist beschädigt oder unvollständig. Installieren Sie QED2 erneut aus einem verifizierten offiziellen GitHub-Release.';
const CORE_START_ERROR_MESSAGE =
  'Der lokale Core konnte die sichere Startprüfung nicht abschließen.';
const CORE_CRASH_LOOP_ERROR_MESSAGE =
  'Der lokale Core wurde nach wiederholten Abstürzen angehalten.';
const CORE_STOP_ERROR_MESSAGE =
  'Der vorherige lokale Core konnte nicht sicher beendet werden.';
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;

export type RuntimeIntegrityVerifier = (
  runtime: RuntimeDescriptor,
  mode?: 'light' | 'full',
) => Promise<RuntimeIntegrityResult>;

export interface CoreSupervisorOptions {
  preferredPort?: number;
  initialConfig?: ClientConfig;
  integrityVerifier?: RuntimeIntegrityVerifier;
}

class CorePortBindCollisionError extends Error {
  constructor(readonly port: number, options?: ErrorOptions) {
    super(`Local Core could not bind loopback port ${port}`, options);
    this.name = 'CorePortBindCollisionError';
  }
}

function errorPayload(
  code: string,
  message: string,
  recoverable = true,
): NonNullable<CoreRuntimeStatus['error']> {
  return {
    code,
    message,
    recoverable,
  };
}

function isPortBindCollisionEvidence(value: unknown): boolean {
  if (value && typeof value === 'object' && 'code' in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && code.toUpperCase() === 'EADDRINUSE') return true;
  }
  const message = value instanceof Error ? value.message : String(value);
  return /\bEADDRINUSE\b|address (?:is )?already in use|only one usage of each socket address/i.test(message);
}

async function sleep(ms: number, unref = false): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (unref) timer.unref();
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HEALTH_RESPONSE_BYTES) {
    throw new Error('Local Core health response exceeded the size limit');
  }
  if (!response.body) throw new Error('Local Core health response had no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HEALTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Local Core health response exceeded the size limit');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.includes('size limit')) throw error;
    throw new Error('Local Core health response was malformed or incomplete', { cause: error });
  } finally {
    reader.releaseLock();
  }
}

export class CoreSupervisor extends EventEmitter {
  private process: ManagedCoreProcess | undefined;
  private startPromise: Promise<CoreEndpoint> | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private intentionalStop = false;
  private restartAttempt = 0;
  private generation = 0;
  private stableTimer: NodeJS.Timeout | undefined;
  private readonly preferredPort: number;
  private readonly integrityVerifier: RuntimeIntegrityVerifier;
  private config: ClientConfig;
  private status: CoreRuntimeStatus;

  constructor(
    private readonly runtime: RuntimeDescriptor,
    private readonly launcher: CoreProcessLauncher,
    private readonly logger: SupervisorLogger,
    options: CoreSupervisorOptions = {},
  ) {
    super();
    this.preferredPort = options.preferredPort ?? 1022;
    this.integrityVerifier = options.integrityVerifier ?? verifyRuntimeIntegrity;
    this.config = structuredClone(options.initialConfig ?? DEFAULT_CONFIG);
    this.status = {
      phase: 'idle',
      source: 'remote',
      endpoint: this.config.coreBaseUrl,
      message: 'Lokaler Core ist noch nicht gestartet.',
    };
  }

  getStatus(): CoreRuntimeStatus {
    return structuredClone(this.status);
  }

  /**
   * The renderer gateway must only forward requests to a Core that completed
   * both health and identity checks. During startup/recovery the configured
   * remote endpoint remains the usable fallback.
   */
  getProxyEndpoint(): string {
    return this.status.phase === 'ready' && this.status.source === 'local'
      ? this.status.endpoint
      : this.config.coreBaseUrl;
  }

  configure(config: ClientConfig): Promise<CoreEndpoint> {
    return this.runLifecycle(async () => {
      this.config = structuredClone(config);
      return await this.currentOrStart();
    });
  }

  getEndpoint(): Promise<CoreEndpoint> {
    return this.runLifecycle(async () => await this.currentOrStart());
  }

  recover(action: CoreRecoveryAction): Promise<CoreEndpoint> {
    return this.runLifecycle(async () => {
      if (action === 'use-remote') {
        this.restartAttempt = 0;
        this.startPromise = undefined;
        this.intentionalStop = true;
        this.generation += 1;
        const stopped = await this.stopProcessOnly();
        if (!stopped) this.throwStopFailure();
        this.setStatus({
          phase: 'degraded',
          source: 'remote',
          endpoint: this.config.coreBaseUrl,
          message: 'Der entfernte Core wird vorübergehend verwendet.',
        });
        return { baseUrl: this.config.coreBaseUrl, source: 'remote' };
      }
      this.restartAttempt = 0;
      this.startPromise = undefined;
      await this.replaceRunningProcess();
      if (action === 'repair') {
        this.setStatus({
          phase: 'recovering',
          source: 'remote',
          endpoint: this.config.coreBaseUrl,
          operation: 'repair-runtime',
          progress: { completed: 0, total: 1, unit: 'steps' },
          message: 'Die gebündelte lokale Laufzeit wird vollständig neu verifiziert …',
        });
        try {
          await this.verifyBundledRuntime();
        } catch (error) {
          this.reportIntegrityFailure(error);
          throw new Error(VERIFIED_REINSTALL_MESSAGE, { cause: error });
        }
      }
      return await this.ensureStarted();
    });
  }

  restart(): Promise<CoreEndpoint> {
    return this.runLifecycle(async () => {
      this.restartAttempt = 0;
      this.startPromise = undefined;
      await this.replaceRunningProcess();
      return await this.ensureStarted();
    });
  }

  stop(): Promise<void> {
    return this.runLifecycle(async () => {
      this.intentionalStop = true;
      this.generation += 1;
      const stopped = await this.stopProcessOnly();
      this.startPromise = undefined;
      if (!stopped) this.throwStopFailure();
      this.setStatus({
        phase: 'stopped',
        source: 'remote',
        endpoint: this.config.coreBaseUrl,
        message: 'Lokaler Core wurde beendet.',
      });
    });
  }

  private currentOrStart(): Promise<CoreEndpoint> {
    if (this.status.phase === 'ready' && this.status.source === 'local') {
      return Promise.resolve({ baseUrl: this.status.endpoint, source: 'local' });
    }
    return this.ensureStarted();
  }

  /** Serializes renderer/menu lifecycle commands while preserving failures. */
  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private ensureStarted(): Promise<CoreEndpoint> {
    if (this.startPromise) return this.startPromise;
    this.intentionalStop = false;
    const rawStart = this.startOnce();
    let managedStart: Promise<CoreEndpoint>;
    managedStart = rawStart.catch(async (error: unknown) => {
      // An exit/restart may already have superseded this startup. Its recovery
      // promise owns state now; an obsolete health-check must not overwrite it.
      if (this.startPromise !== managedStart) {
        return { baseUrl: this.config.coreBaseUrl, source: 'remote' };
      }
      await this.replaceRunningProcess();
      this.startPromise = undefined;
      this.logger.error('Local core failed to start', error);
      if (isRuntimeIntegrityError(error)) {
        this.reportIntegrityFailure(error);
        return { baseUrl: this.config.coreBaseUrl, source: 'remote' };
      }
      this.setStatus({
        phase: 'degraded',
        source: 'remote',
        endpoint: this.config.coreBaseUrl,
        message: 'Der lokale Core ist nicht verfügbar. Der entfernte Core wird verwendet.',
        error: errorPayload('CORE_START_FAILED', CORE_START_ERROR_MESSAGE),
      });
      return { baseUrl: this.config.coreBaseUrl, source: 'remote' };
    });
    this.startPromise = managedStart;
    return managedStart;
  }

  private async startOnce(): Promise<CoreEndpoint> {
    const generation = ++this.generation;
    const verifiesBundledRuntime = this.runtime.source === 'bundled';
    const totalSteps = verifiesBundledRuntime ? 4 : 3;
    const stepOffset = verifiesBundledRuntime ? 1 : 0;
    if (verifiesBundledRuntime) {
      this.setStatus({
        phase: 'starting',
        source: 'local',
        endpoint: this.config.coreBaseUrl,
        operation: 'prepare-runtime',
        progress: { completed: 0, total: totalSteps, unit: 'steps' },
        message: 'Die Integrität der lokalen Laufzeit wird überprüft …',
        ...(this.restartAttempt > 0 ? { restartAttempt: this.restartAttempt } : {}),
      });
      await this.verifyBundledRuntime();
      if (generation !== this.generation) throw new Error('Core startup was superseded');
    }
    const attemptedPorts = new Set<number>();
    for (let attempt = 1; attempt <= MAX_BIND_COLLISION_RETRIES; attempt += 1) {
      const port = await allocateLoopbackPort(
        this.preferredPort,
        PORT_CANDIDATE_ATTEMPTS,
        new Set(attemptedPorts),
      );
      attemptedPorts.add(port);
      try {
        return await this.startOnPort(port, generation, totalSteps, stepOffset);
      } catch (error) {
        if (!(error instanceof CorePortBindCollisionError)) throw error;
        this.logger.warn('Local Core lost a loopback bind race; selecting another port', {
          port,
          attempt,
          maximumAttempts: MAX_BIND_COLLISION_RETRIES,
          error,
        });
        if (generation !== this.generation) throw new Error('Core startup was superseded');
      }
    }
    throw new Error('Local Core exhausted its bounded loopback bind-collision retries');
  }

  private async startOnPort(
    port: number,
    generation: number,
    totalSteps: number,
    stepOffset: number,
  ): Promise<CoreEndpoint> {
    const endpoint = `http://${LOOPBACK_HOST}:${port}`;
    if (port !== this.preferredPort) {
      this.logger.warn('Preferred local core port is unavailable; using controlled fallback', {
        preferredPort: this.preferredPort,
        actualPort: port,
      });
    }
    this.setStatus({
      phase: 'starting',
      source: 'local',
      endpoint,
      operation: 'start-core',
      progress: { completed: 1 + stepOffset, total: totalSteps, unit: 'steps' },
      message: 'Lokaler Core wird gestartet …',
      ...(this.restartAttempt > 0 ? { restartAttempt: this.restartAttempt } : {}),
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      BANK_PATH: this.runtime.bankDirectory,
      BANK_STRICT: 'true',
      REQUEST_LOG: 'false',
      CORS_ORIGINS: `http://${LOOPBACK_HOST}:*`,
      CORE_SOURCE_REPO: this.config.coreRepoUrl,
      BANK_REPO: this.config.bankRepoUrl,
      BANK_BRANCH: 'pastpapers',
      ...(this.runtime.manifest?.core.commit
        ? { QED_BUILD_COMMIT: this.runtime.manifest.core.commit }
        : {}),
    };
    let child: ManagedCoreProcess;
    try {
      child = this.launcher.launch({
        entry: this.runtime.coreEntry,
        cwd: this.runtime.coreDirectory,
        env,
      });
    } catch (error) {
      if (isPortBindCollisionEvidence(error)) {
        throw new CorePortBindCollisionError(port, { cause: error });
      }
      throw error;
    }
    this.process = child;
    let startupPhase: 'pending' | 'ready' | 'disposed' = 'pending';
    let sawBindCollision = false;
    let resolveStartupExit: ((code: number) => void) | undefined;
    const startupExit = new Promise<number>((resolve) => {
      resolveStartupExit = resolve;
    });
    child.onStdout((line) => this.logger.debug('core stdout', line.trim()));
    child.onStderr((line) => {
      if (startupPhase === 'pending' && isPortBindCollisionEvidence(line)) {
        sawBindCollision = true;
      }
      this.logger.warn('core stderr', line.trim());
    });
    child.onExit((code) => {
      if (startupPhase === 'pending') {
        if (this.process === child) this.process = undefined;
        resolveStartupExit?.(code);
        return;
      }
      if (startupPhase === 'ready') this.handleExit(generation, code);
    });

    this.setStatus({
      phase: 'starting',
      source: 'local',
      endpoint,
      operation: 'health-check',
      progress: { completed: 2 + stepOffset, total: totalSteps, unit: 'steps' },
      message: 'Lokaler Core wird überprüft …',
      ...(this.restartAttempt > 0 ? { restartAttempt: this.restartAttempt } : {}),
    });
    const healthAbort = new AbortController();
    const healthCheck = this.waitUntilHealthy(endpoint, generation, healthAbort.signal);
    let outcome: { kind: 'healthy' } | { kind: 'exit'; code: number };
    try {
      outcome = await Promise.race([
        healthCheck.then(() => ({ kind: 'healthy' as const })),
        startupExit.then((code) => ({ kind: 'exit' as const, code })),
      ]);
    } catch (error) {
      startupPhase = 'disposed';
      healthAbort.abort();
      throw error;
    }
    if (outcome.kind === 'exit') {
      startupPhase = 'disposed';
      healthAbort.abort();
      const occupiedAfterExit = !(await isPortAvailable(port));
      if (sawBindCollision || occupiedAfterExit) {
        throw new CorePortBindCollisionError(port, {
          cause: new Error(`Local Core exited with code ${outcome.code}`),
        });
      }
      throw new Error(`Local Core exited during startup with code ${outcome.code}`);
    }
    startupPhase = 'ready';
    if (generation !== this.generation) throw new Error('Core startup was superseded');
    this.setStatus({
      phase: 'ready',
      source: 'local',
      endpoint,
      progress: { completed: 3 + stepOffset, total: totalSteps, unit: 'steps' },
      message:
        port === this.preferredPort
          ? 'Lokaler Core ist bereit.'
          : `Lokaler Core ist bereit (Port ${port}; ${this.preferredPort} war nicht verfügbar).`,
    });
    this.armStableRuntimeReset(generation);
    this.logger.info('Local core ready', { endpoint, pid: child.pid, source: this.runtime.source });
    return { baseUrl: endpoint, source: 'local' };
  }

  private async waitUntilHealthy(
    endpoint: string,
    generation: number,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 20_000;
    let lastError: unknown = new Error('Health check did not run');
    while (
      Date.now() < deadline &&
      generation === this.generation &&
      !abortSignal.aborted
    ) {
      try {
        const health = await fetch(`${endpoint}/health`, {
          signal: AbortSignal.any([abortSignal, AbortSignal.timeout(1_500)]),
          cache: 'no-store',
        });
        if (!health.ok) throw new Error(`Health endpoint returned ${health.status}`);
        const healthBody = await readBoundedJson(health);
        if (
          !healthBody ||
          typeof healthBody !== 'object' ||
          Array.isArray(healthBody) ||
          (healthBody as Record<string, unknown>).status !== 'ok'
        ) {
          throw new Error('Health endpoint did not identify a ready core');
        }
        const info = await fetch(`${endpoint}/info`, {
          signal: AbortSignal.any([abortSignal, AbortSignal.timeout(1_500)]),
          cache: 'no-store',
        });
        const infoBody = await readBoundedJson(info);
        this.assertCoreIdentity(info.ok, infoBody);
        return;
      } catch (error) {
        lastError = error;
        if (abortSignal.aborted) break;
        await sleep(200);
      }
    }
    throw lastError;
  }

  private handleExit(generation: number, code: number): void {
    if (generation !== this.generation) return;
    this.clearStableTimer();
    // Invalidate any in-flight health loop and callbacks for this process.
    const recoveryGeneration = ++this.generation;
    this.process = undefined;
    this.startPromise = undefined;
    if (this.intentionalStop) return;
    this.logger.warn('Local core exited unexpectedly', { code, restartAttempt: this.restartAttempt });
    if (this.restartAttempt >= RESTART_DELAYS_MS.length) {
      this.setStatus({
        phase: 'degraded',
        source: 'remote',
        endpoint: this.config.coreBaseUrl,
        message: 'Der lokale Core ist wiederholt abgestürzt. Automatische Neustarts wurden angehalten.',
        restartAttempt: this.restartAttempt,
        error: errorPayload('CORE_CRASH_LOOP', CORE_CRASH_LOOP_ERROR_MESSAGE),
      });
      return;
    }
    const delay = RESTART_DELAYS_MS[this.restartAttempt] ?? 4_000;
    this.restartAttempt += 1;
    this.setStatus({
      phase: 'recovering',
      source: 'local',
      endpoint: this.status.endpoint,
      operation: 'restart-core',
      message: `Lokaler Core wird wiederhergestellt (Versuch ${this.restartAttempt}/3) …`,
      restartAttempt: this.restartAttempt,
    });
    let recovery: Promise<CoreEndpoint>;
    recovery = sleep(delay, true).then(async () => {
      if (recoveryGeneration !== this.generation || this.intentionalStop) {
        return { baseUrl: this.config.coreBaseUrl, source: 'remote' };
      }
      if (this.startPromise === recovery) this.startPromise = undefined;
      return await this.ensureStarted();
    });
    this.startPromise = recovery;
  }

  private async stopProcessOnly(): Promise<boolean> {
    const child = this.process;
    this.process = undefined;
    if (!child) return true;
    let exited = false;
    const exit = new Promise<void>((resolve) => {
      child.onExit(() => {
        exited = true;
        if (this.process === child) this.process = undefined;
        resolve();
      });
    });
    try {
      child.kill();
    } catch (error) {
      this.logger.warn('Graceful local Core termination threw an exception', { pid: child.pid, error });
    }
    await Promise.race([exit, sleep(2_000)]);
    if (!exited) {
      this.logger.warn('Local core did not exit after SIGTERM; forcing termination', { pid: child.pid });
      try {
        child.kill(true);
      } catch (error) {
        this.logger.error('Forced local Core termination threw an exception', { pid: child.pid, error });
      }
      await Promise.race([exit, sleep(1_000)]);
    }
    if (!exited) {
      // Retain the handle so a later explicit recovery can retry termination.
      // Most importantly, never launch a second Core beside an unconfirmed one.
      this.process = child;
      this.logger.error('Local core termination could not be confirmed', { pid: child.pid });
    }
    return exited;
  }

  /** Supersede exit callbacks before terminating a process for a manual restart. */
  private async replaceRunningProcess(): Promise<void> {
    this.clearStableTimer();
    this.generation += 1;
    if (!(await this.stopProcessOnly())) this.throwStopFailure();
  }

  private throwStopFailure(): never {
    const error = new Error(CORE_STOP_ERROR_MESSAGE);
    this.setStatus({
      phase: 'failed',
      source: 'remote',
      endpoint: this.config.coreBaseUrl,
      message:
        'Der vorherige lokale Core konnte nicht sicher beendet werden. ' +
        'QED2 startet keinen zweiten lokalen Prozess.',
      error: errorPayload('CORE_STOP_FAILED', CORE_STOP_ERROR_MESSAGE),
    });
    throw error;
  }

  private assertCoreIdentity(responseOk: boolean, value: unknown): void {
    if (!responseOk || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Unexpected process on core port');
    }
    const info = value as Record<string, unknown>;
    if (info.service !== 'qed2-core') throw new Error('Unexpected process on core port');
    const manifest = this.runtime.manifest;
    if (this.runtime.source !== 'bundled' || !manifest) return;
    const bank = info.bank;
    const schemas = info.schemaVersionSupported;
    if (
      info.version !== manifest.core.version ||
      info.commit !== manifest.core.commit ||
      !bank ||
      typeof bank !== 'object' ||
      Array.isArray(bank) ||
      (bank as Record<string, unknown>).commit !== manifest.bank.commit ||
      !schemas ||
      typeof schemas !== 'object' ||
      Array.isArray(schemas)
    ) {
      throw new Error('Local Core identity does not match the verified bundled runtime');
    }
    const minimum = (schemas as Record<string, unknown>).min;
    const maximum = (schemas as Record<string, unknown>).max;
    if (
      !Number.isInteger(minimum) ||
      !Number.isInteger(maximum) ||
      manifest.bank.schemaVersions.some(
        (version) => version < (minimum as number) || version > (maximum as number),
      )
    ) {
      throw new Error('Local Core schema support does not match the verified question bank');
    }
  }

  private armStableRuntimeReset(generation: number): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      if (generation !== this.generation || this.status.phase !== 'ready') return;
      this.restartAttempt = 0;
      this.logger.debug('Local core passed the stable-runtime window');
    }, STABLE_RUNTIME_MS);
    this.stableTimer.unref();
  }

  private clearStableTimer(): void {
    if (!this.stableTimer) return;
    clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
  }

  private async verifyBundledRuntime(): Promise<void> {
    if (this.runtime.source !== 'bundled') return;
    const result = await this.integrityVerifier(this.runtime, 'full');
    this.logger.info('Bundled runtime integrity verified', {
      checkedFiles: result.checkedFiles,
      checkedBytes: result.checkedBytes,
    });
  }

  private reportIntegrityFailure(error: unknown): void {
    this.logger.error('Bundled runtime integrity verification failed; verified reinstall required', error);
    this.setStatus({
      phase: 'failed',
      source: 'remote',
      endpoint: this.config.coreBaseUrl,
      message: VERIFIED_REINSTALL_MESSAGE,
      error: errorPayload('RUNTIME_INTEGRITY_FAILED', VERIFIED_REINSTALL_MESSAGE, false),
    });
  }

  private setStatus(status: CoreRuntimeStatus): void {
    this.status = status;
    this.emit('status', this.getStatus());
  }
}
