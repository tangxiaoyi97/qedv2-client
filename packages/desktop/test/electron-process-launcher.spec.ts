import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { UtilityProcess } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeUtilityProcess extends EventEmitter {
  readonly pid = 42_424;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

const electronMocks = vi.hoisted(() => ({
  fork: vi.fn(),
}));

vi.mock('electron', () => ({
  utilityProcess: { fork: electronMocks.fork },
}));

import { ElectronCoreProcessLauncher } from '../src/main/electron-process-launcher.js';

beforeEach(() => {
  electronMocks.fork.mockReset();
});

describe('Electron Core process launcher', () => {
  it('drops Node injection flags while preserving compatible network environment settings', () => {
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child as unknown as UtilityProcess);
    const launcher = new ElectronCoreProcessLauncher('/app/core-host.cjs');

    launcher.launch({
      entry: '/runtime/core/dist/main.js',
      cwd: '/runtime/core',
      env: {
        NODE_OPTIONS: '--require=/tmp/injected.cjs',
        ELECTRON_RUN_AS_NODE: '1',
        HTTPS_PROXY: 'https://proxy.example',
        PORT: '1022',
      },
    });

    expect(electronMocks.fork).toHaveBeenCalledWith(
      '/app/core-host.cjs',
      [],
      expect.objectContaining({
        cwd: '/runtime/core',
        env: expect.objectContaining({
          HTTPS_PROXY: 'https://proxy.example',
          PORT: '1022',
          QED2_CORE_ENTRY: '/runtime/core/dist/main.js',
          QED2_CORE_DIRECTORY: '/runtime/core',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        allowLoadingUnsignedLibraries: false,
      }),
    );
    const options = electronMocks.fork.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('bounds line length and line rate before forwarding child output to the logger', async () => {
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child as unknown as UtilityProcess);
    const process = new ElectronCoreProcessLauncher('/app/core-host.cjs').launch({
      entry: '/runtime/core/dist/main.js',
      cwd: '/runtime/core',
      env: {},
    });
    const lines: string[] = [];
    process.onStdout((line) => lines.push(line));

    child.stdout.end(
      `${'x'.repeat(9_000)}\n${Array.from({ length: 101 }, (_, index) => `line-${index}`).join('\n')}\n`,
    );
    await new Promise<void>((resolve) => child.stdout.once('end', resolve));

    expect(lines[0]).toContain('[truncated]');
    expect(lines.some((line) => line.includes('excessive Core log lines suppressed'))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(101);
  });
});
