import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '@qed2/core-logic';
import {
  CoreSupervisor,
  type CoreProcessLauncher,
  type ManagedCoreProcess,
  type RuntimeIntegrityVerifier,
  type SupervisorLogger,
} from '../src/main/core-supervisor.js';
import type { RuntimeDescriptor } from '../src/main/runtime-layout.js';
import { RuntimeIntegrityError } from '../src/main/runtime-integrity.js';

const portMocks = vi.hoisted(() => ({
  allocateLoopbackPort: vi.fn<() => Promise<number>>(),
}));

vi.mock('../src/main/port-allocator.js', () => ({
  LOOPBACK_HOST: '127.0.0.1',
  allocateLoopbackPort: portMocks.allocateLoopbackPort,
}));

class FakeCoreProcess extends EventEmitter implements ManagedCoreProcess {
  readonly pid: number;
  killCalls = 0;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    this.killCalls += 1;
    this.emit('exit', 0);
    return true;
  }

  onExit(cb: (code: number) => void): void {
    this.on('exit', cb);
  }

  onStdout(cb: (line: string) => void): void {
    this.on('stdout', cb);
  }

  onStderr(cb: (line: string) => void): void {
    this.on('stderr', cb);
  }

  crash(code = 1): void {
    this.emit('exit', code);
  }
}

class FakeLauncher implements CoreProcessLauncher {
  readonly launches: Array<{
    options: Parameters<CoreProcessLauncher['launch']>[0];
    process: FakeCoreProcess;
  }> = [];

  launch(options: Parameters<CoreProcessLauncher['launch']>[0]): ManagedCoreProcess {
    const process = new FakeCoreProcess(10_000 + this.launches.length);
    this.launches.push({ options, process });
    return process;
  }
}

const runtime: RuntimeDescriptor = {
  coreDirectory: '/runtime/core',
  coreEntry: '/runtime/core/dist/main.js',
  bankDirectory: '/runtime/bank',
  source: 'bundled',
  manifest: {
    formatVersion: 2,
    createdAt: '2026-08-07T00:00:00.000Z',
    core: { version: '2.0.0', commit: 'core-commit', entry: 'dist/main.js' },
    bank: { commit: 'bank-commit', schemaVersions: [2, 3] },
    files: [],
  },
};

const config: ClientConfig = {
  coreBaseUrl: 'https://remote-core.example',
  serverBaseUrl: 'https://sync.example',
  coreRepoUrl: 'https://git.example/core.git',
  bankRepoUrl: 'https://git.example/bank.git',
};

function logger(): SupervisorLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function successfulIntegrityVerifier(): RuntimeIntegrityVerifier {
  return vi.fn(async (_runtime, mode = 'full') => ({
    mode,
    checkedFiles: 42,
    checkedBytes: 1_024,
  }));
}

function createSupervisor(
  launcher: CoreProcessLauncher,
  integrityVerifier: RuntimeIntegrityVerifier = successfulIntegrityVerifier(),
): CoreSupervisor {
  return new CoreSupervisor(
    runtime,
    launcher,
    logger(),
    1022,
    'https://qedcore.barcarolle.studio',
    integrityVerifier,
  );
}

function healthyFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.endsWith('/health')) {
    return Promise.resolve(Response.json({ status: 'ok' }));
  }
  if (url.endsWith('/info')) {
    return Promise.resolve(
      Response.json({
        service: 'qed2-core',
        version: runtime.manifest?.core.version,
        commit: runtime.manifest?.core.commit,
        schemaVersionSupported: { min: 2, max: 3 },
        bank: { commit: runtime.manifest?.bank.commit },
      }),
    );
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}

beforeEach(() => {
  vi.useFakeTimers();
  portMocks.allocateLoopbackPort.mockReset();
  portMocks.allocateLoopbackPort.mockResolvedValue(43_123);
  vi.stubGlobal('fetch', vi.fn(healthyFetch));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CoreSupervisor', () => {
  it('deduplicates concurrent starts and launches a loopback-only local core', async () => {
    const launcher = new FakeLauncher();
    const supervisor = createSupervisor(launcher);

    const [first, second] = await Promise.all([
      supervisor.configure(config),
      supervisor.getEndpoint(),
    ]);

    expect(first).toEqual({ baseUrl: 'http://127.0.0.1:43123', source: 'local' });
    expect(second).toEqual(first);
    expect(launcher.launches).toHaveLength(1);
    expect(portMocks.allocateLoopbackPort).toHaveBeenCalledTimes(1);
    expect(launcher.launches[0]?.options).toMatchObject({
      entry: runtime.coreEntry,
      cwd: runtime.coreDirectory,
      env: {
        NODE_ENV: 'production',
        PORT: '43123',
        BANK_PATH: runtime.bankDirectory,
        BANK_STRICT: 'true',
        REQUEST_LOG: 'false',
        CORE_SOURCE_REPO: config.coreRepoUrl,
        BANK_REPO: config.bankRepoUrl,
        BANK_BRANCH: 'pastpapers',
        QED_BUILD_COMMIT: 'core-commit',
      },
    });
    expect(supervisor.getStatus()).toMatchObject({
      phase: 'ready',
      source: 'local',
      endpoint: first.baseUrl,
    });
    expect(supervisor.getProxyEndpoint()).toBe(first.baseUrl);
  });

  it('keeps the renderer gateway on the remote fallback until local identity is verified', async () => {
    const launcher = new FakeLauncher();
    let releaseVerification: ((result: Awaited<ReturnType<RuntimeIntegrityVerifier>>) => void) | undefined;
    const verifier = vi.fn<RuntimeIntegrityVerifier>(
      () =>
        new Promise((resolve) => {
          releaseVerification = resolve;
        }),
    );
    const supervisor = createSupervisor(launcher, verifier);

    const configuring = supervisor.configure(config);
    await Promise.resolve();
    expect(supervisor.getStatus()).toMatchObject({ phase: 'starting', operation: 'prepare-runtime' });
    expect(supervisor.getProxyEndpoint()).toBe(config.coreBaseUrl);

    releaseVerification?.({ mode: 'full', checkedFiles: 42, checkedBytes: 1_024 });
    await expect(configuring).resolves.toMatchObject({ source: 'local' });
    expect(supervisor.getProxyEndpoint()).toBe('http://127.0.0.1:43123');
  });

  it('backs off before restarting an unexpectedly crashed core and recovers', async () => {
    const launcher = new FakeLauncher();
    const supervisor = createSupervisor(launcher);
    await supervisor.configure(config);

    launcher.launches[0]?.process.crash(23);
    expect(supervisor.getStatus()).toMatchObject({
      phase: 'recovering',
      operation: 'restart-core',
      restartAttempt: 1,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(launcher.launches).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(supervisor.getEndpoint()).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:43123',
      source: 'local',
    });
    expect(launcher.launches).toHaveLength(2);
    expect(supervisor.getStatus()).toMatchObject({ phase: 'ready', source: 'local' });
  });

  it('cancels a scheduled crash restart when explicitly stopped', async () => {
    const launcher = new FakeLauncher();
    const supervisor = createSupervisor(launcher);
    await supervisor.configure(config);

    launcher.launches[0]?.process.crash(9);
    expect(supervisor.getStatus().phase).toBe('recovering');

    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(launcher.launches).toHaveLength(1);
    expect(supervisor.getStatus()).toMatchObject({
      phase: 'stopped',
      source: 'remote',
      endpoint: config.coreBaseUrl,
    });
  });

  it('kills a running child on stop without treating the exit as a crash', async () => {
    const launcher = new FakeLauncher();
    const supervisor = createSupervisor(launcher);
    await supervisor.configure(config);
    const child = launcher.launches[0]?.process;
    if (!child) throw new Error('Expected a launched child process');

    const stopping = supervisor.stop();
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(child.killCalls).toBe(1);
    expect(launcher.launches).toHaveLength(1);
    expect(supervisor.getStatus().phase).toBe('stopped');
  });

  it('opens the crash-loop circuit after three unstable restart attempts', async () => {
    const launcher = new FakeLauncher();
    const supervisor = createSupervisor(launcher);
    await supervisor.configure(config);

    for (const delay of [1_000, 2_000, 4_000]) {
      launcher.launches.at(-1)?.process.crash(70);
      await vi.advanceTimersByTimeAsync(delay);
      await supervisor.getEndpoint();
    }
    expect(launcher.launches).toHaveLength(4);

    launcher.launches.at(-1)?.process.crash(71);
    expect(supervisor.getStatus()).toMatchObject({
      phase: 'degraded',
      source: 'remote',
      restartAttempt: 3,
      error: { code: 'CORE_CRASH_LOOP', recoverable: true },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(launcher.launches).toHaveLength(4);
  });

  it('terminates a spawned child when its health identity never verifies', async () => {
    const launcher = new FakeLauncher();
    const supervisor = createSupervisor(launcher);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ status: 'wrong' }))));

    const configuring = supervisor.configure(config);
    await vi.advanceTimersByTimeAsync(21_000);

    await expect(configuring).resolves.toEqual({
      baseUrl: config.coreBaseUrl,
      source: 'remote',
    });
    expect(launcher.launches).toHaveLength(1);
    expect(launcher.launches[0]?.process.killCalls).toBe(1);
    expect(supervisor.getStatus()).toMatchObject({
      phase: 'degraded',
      error: { code: 'CORE_START_FAILED' },
    });
  });

  it('rejects a healthy-looking Core whose signed version or bank identity does not match', async () => {
    const launcher = new FakeLauncher();
    const supervisor = createSupervisor(launcher);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        if (String(input).endsWith('/health')) return Promise.resolve(Response.json({ status: 'ok' }));
        return Promise.resolve(
          Response.json({
            service: 'qed2-core',
            version: '9.9.9',
            commit: 'different-core',
            schemaVersionSupported: { min: 2, max: 3 },
            bank: { commit: 'different-bank' },
          }),
        );
      }),
    );

    const configuring = supervisor.configure(config);
    await vi.advanceTimersByTimeAsync(21_000);

    await expect(configuring).resolves.toEqual({ baseUrl: config.coreBaseUrl, source: 'remote' });
    expect(launcher.launches).toHaveLength(1);
    expect(launcher.launches[0]?.process.killCalls).toBe(1);
    expect(supervisor.getStatus()).toMatchObject({
      phase: 'degraded',
      error: { code: 'CORE_START_FAILED' },
    });
  });

  it('serializes overlapping repair requests instead of running lifecycle mutations concurrently', async () => {
    const launcher = new FakeLauncher();
    let activeVerifications = 0;
    let maximumActiveVerifications = 0;
    const verifier = vi.fn<RuntimeIntegrityVerifier>(async (_descriptor, mode = 'full') => {
      activeVerifications += 1;
      maximumActiveVerifications = Math.max(maximumActiveVerifications, activeVerifications);
      await Promise.resolve();
      activeVerifications -= 1;
      return { mode, checkedFiles: 42, checkedBytes: 1_024 };
    });
    const supervisor = createSupervisor(launcher, verifier);
    await supervisor.configure(config);

    await Promise.all([supervisor.recover('repair'), supervisor.recover('repair')]);

    expect(maximumActiveVerifications).toBe(1);
    expect(launcher.launches).toHaveLength(3);
    expect(launcher.launches[0]?.process.killCalls).toBe(1);
    expect(launcher.launches[1]?.process.killCalls).toBe(1);
    expect(supervisor.getStatus().phase).toBe('ready');
  });

  it('refuses to spawn a replacement when termination of the prior Core cannot be confirmed', async () => {
    class StubbornProcess extends FakeCoreProcess {
      override kill(): boolean {
        this.killCalls += 1;
        return true;
      }
    }
    class StubbornLauncher implements CoreProcessLauncher {
      readonly launches: StubbornProcess[] = [];
      launch(): ManagedCoreProcess {
        const child = new StubbornProcess(20_000 + this.launches.length);
        this.launches.push(child);
        return child;
      }
    }
    const launcher = new StubbornLauncher();
    const supervisor = createSupervisor(launcher);
    await supervisor.configure(config);

    const restarting = supervisor.restart();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_100);

    await expect(restarting).rejects.toThrow('could not be terminated safely');
    expect(launcher.launches).toHaveLength(1);
    expect(launcher.launches[0]?.killCalls).toBe(2);
    expect(supervisor.getStatus()).toMatchObject({
      phase: 'failed',
      source: 'remote',
      error: { code: 'CORE_STOP_FAILED', recoverable: true },
    });
  });

  it('refuses to launch a bundled Core whose complete integrity check fails', async () => {
    const launcher = new FakeLauncher();
    const verifier = vi.fn<RuntimeIntegrityVerifier>(() =>
      Promise.reject(new RuntimeIntegrityError('dist/main.js digest mismatch')),
    );
    const supervisor = createSupervisor(launcher, verifier);

    await expect(supervisor.configure(config)).resolves.toEqual({
      baseUrl: config.coreBaseUrl,
      source: 'remote',
    });

    expect(verifier).toHaveBeenCalledWith(runtime, 'full');
    expect(launcher.launches).toHaveLength(0);
    expect(portMocks.allocateLoopbackPort).not.toHaveBeenCalled();
    expect(supervisor.getStatus()).toMatchObject({
      phase: 'failed',
      source: 'remote',
      message: expect.stringContaining('verifizierten offiziellen GitHub-Release'),
      error: { code: 'RUNTIME_INTEGRITY_FAILED', recoverable: false },
    });
  });

  it('fails repair explicitly when no clean verified runtime copy is available', async () => {
    const launcher = new FakeLauncher();
    const verifier = vi.fn<RuntimeIntegrityVerifier>()
      .mockResolvedValueOnce({ mode: 'full', checkedFiles: 42, checkedBytes: 1_024 })
      .mockRejectedValueOnce(new RuntimeIntegrityError('bank content is missing'));
    const supervisor = createSupervisor(launcher, verifier);
    await supervisor.configure(config);

    await expect(supervisor.recover('repair')).rejects.toThrow('verifizierten offiziellen GitHub-Release');

    expect(launcher.launches).toHaveLength(1);
    expect(launcher.launches[0]?.process.killCalls).toBe(1);
    expect(supervisor.getStatus()).toMatchObject({
      phase: 'failed',
      source: 'remote',
      message: expect.stringContaining('Installieren Sie QED2 erneut'),
      error: { code: 'RUNTIME_INTEGRITY_FAILED', recoverable: false },
    });
  });
});
