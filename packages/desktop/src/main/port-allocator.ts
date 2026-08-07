import { createServer } from 'node:net';

export const LOOPBACK_HOST = '127.0.0.1';

const MAX_EPHEMERAL_SELECTION_ATTEMPTS = 16;

export async function isPortAvailable(port: number, host = LOOPBACK_HOST): Promise<boolean> {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError(`Invalid TCP port: ${String(port)}`);
  }
  if (host !== LOOPBACK_HOST) throw new Error('Desktop port probes are restricted to IPv4 loopback');
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function allocateLoopbackPort(
  preferred: number,
  attempts = 100,
  excluded: ReadonlySet<number> = new Set(),
): Promise<number> {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65_535) {
    throw new RangeError(`Invalid preferred TCP port: ${String(preferred)}`);
  }
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 65_535) {
    throw new RangeError(`Invalid port-attempt count: ${String(attempts)}`);
  }
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferred + offset;
    if (port > 65_535) break;
    if (excluded.has(port)) continue;
    if (await isPortAvailable(port)) return port;
  }
  // Port 0 asks the OS for an ephemeral loopback port. This remains a
  // short-lived selection hint rather than a reservation hand-off: the
  // external Core performs the authoritative bind, and CoreSupervisor must
  // classify/retry an actual bind collision. Avoid returning a port that the
  // same startup sequence already lost to a race.
  for (let attempt = 0; attempt < MAX_EPHEMERAL_SELECTION_ATTEMPTS; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.once('error', reject);
      server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Unable to allocate a loopback port'));
          return;
        }
        server.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
    if (!excluded.has(port)) return port;
  }
  throw new Error('Unable to allocate a new loopback port');
}
