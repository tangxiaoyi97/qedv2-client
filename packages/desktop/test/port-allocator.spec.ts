import { afterEach, describe, expect, it, vi } from 'vitest';

interface ListenPlan {
  error?: NodeJS.ErrnoException;
  assignedPort?: number;
}

const netMocks = vi.hoisted(() => ({
  plans: [] as ListenPlan[],
  listens: [] as Array<{ host?: string; port?: number; exclusive?: boolean }>,
  closes: 0,
}));

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    createServer: () => {
      const server = new actual.Server();
      let assignedPort = 0;
      server.unref = vi.fn(() => server);
      server.listen = vi.fn(
        (options: { host?: string; port?: number; exclusive?: boolean }, callback?: () => void) => {
          netMocks.listens.push({ ...options });
          const plan = netMocks.plans.shift() ?? {};
          if (plan.error) {
            queueMicrotask(() => server.emit('error', plan.error));
            return server;
          }
          assignedPort = options.port === 0 ? (plan.assignedPort ?? 55_000) : (options.port ?? 55_000);
          queueMicrotask(() => callback?.());
          return server;
        },
      ) as unknown as typeof server.listen;
      server.address = vi.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: assignedPort }));
      server.close = vi.fn(((callback?: (error?: Error) => void) => {
        netMocks.closes += 1;
        queueMicrotask(() => callback?.());
        return server;
      }) as typeof server.close);
      return server;
    },
  };
});

import {
  allocateLoopbackPort,
  isPortAvailable,
  LOOPBACK_HOST,
} from '../src/main/port-allocator.js';

afterEach(() => {
  netMocks.plans.length = 0;
  netMocks.listens.length = 0;
  netMocks.closes = 0;
});

describe('loopback port allocation', () => {
  it('rejects invalid ports, attempt counts, and non-loopback probes before binding', async () => {
    await expect(isPortAvailable(-1)).rejects.toThrow('Invalid TCP port');
    await expect(isPortAvailable(41_000, '0.0.0.0')).rejects.toThrow('restricted to IPv4 loopback');
    await expect(allocateLoopbackPort(0)).rejects.toThrow('Invalid preferred TCP port');
    await expect(allocateLoopbackPort(40_000, -1)).rejects.toThrow('Invalid port-attempt count');
    expect(netMocks.listens).toHaveLength(0);
  });

  it('reports bind failures as unavailable without escaping the loopback host', async () => {
    const error = Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
    netMocks.plans.push({ error });

    await expect(isPortAvailable(41_000)).resolves.toBe(false);
    expect(netMocks.listens).toEqual([
      { host: '127.0.0.1', port: 41_000, exclusive: true },
    ]);
  });

  it('closes a successful probe before reporting the port as available', async () => {
    netMocks.plans.push({});

    await expect(isPortAvailable(41_001)).resolves.toBe(true);
    expect(netMocks.closes).toBe(1);
  });

  it('skips occupied preferred ports in ascending order', async () => {
    const occupied = Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
    netMocks.plans.push({ error: occupied }, { error: occupied }, {});

    await expect(allocateLoopbackPort(40_000, 3)).resolves.toBe(40_002);
    expect(netMocks.listens.map(({ host, port, exclusive }) => ({ host, port, exclusive }))).toEqual([
      { host: LOOPBACK_HOST, port: 40_000, exclusive: true },
      { host: LOOPBACK_HOST, port: 40_001, exclusive: true },
      { host: LOOPBACK_HOST, port: 40_002, exclusive: true },
    ]);
  });

  it('falls back to a released OS-assigned loopback port after exhausting attempts', async () => {
    netMocks.plans.push({ assignedPort: 55_123 });

    await expect(allocateLoopbackPort(40_000, 0)).resolves.toBe(55_123);
    expect(netMocks.listens).toEqual([
      { host: LOOPBACK_HOST, port: 0, exclusive: true },
    ]);
    expect(netMocks.closes).toBe(1);
  });
});
