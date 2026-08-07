import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellPort } from '@qed2/core-logic';

const globalWithPorts = globalThis as typeof globalThis & {
  __QED2_PLATFORM_PORTS__?: { shell?: ShellPort };
};

afterEach(() => {
  delete globalWithPorts.__QED2_PLATFORM_PORTS__;
  vi.resetModules();
});

describe('platform shell assembly', () => {
  it('uses the injected shell when a native wrapper provides one', async () => {
    const shell: ShellPort = {
      capabilities: { desktop: true, nativeMenu: true, nativeTitleBar: true },
      onCommand: () => () => undefined,
    };
    globalWithPorts.__QED2_PLATFORM_PORTS__ = { shell };

    const { ports } = await import('../src/services.js');

    expect(ports.shell).toBe(shell);
  }, 10_000);

  it('falls back to the inert web shell without an injection', async () => {
    const { ports } = await import('../src/services.js');

    expect(ports.shell.capabilities).toEqual({
      desktop: false,
      nativeMenu: false,
      nativeTitleBar: false,
    });
  }, 10_000);
});
