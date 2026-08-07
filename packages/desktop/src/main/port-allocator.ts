import { createServer } from 'node:net';

export const LOOPBACK_HOST = '127.0.0.1';

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

export async function allocateLoopbackPort(preferred: number, attempts = 100): Promise<number> {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65_535) {
    throw new RangeError(`Invalid preferred TCP port: ${String(preferred)}`);
  }
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 65_535) {
    throw new RangeError(`Invalid port-attempt count: ${String(attempts)}`);
  }
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferred + offset;
    if (port > 65_535) break;
    if (await isPortAvailable(port)) return port;
  }
  // Port 0 asks the OS for an ephemeral loopback port. Resolve it by holding a
  // short-lived reservation; callers must still handle the unlikely race.
  return await new Promise((resolve, reject) => {
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
}
