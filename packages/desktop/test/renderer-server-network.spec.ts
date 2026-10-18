import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESKTOP_TOKEN_HEADER, RendererServer } from '../src/main/renderer-server.js';

let directory: string;
let gateway: RendererServer | undefined;
let upstream: Server | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qed-gateway-network-'));
  await writeFile(join(directory, 'index.html'), '<html><head></head><body>QED2</body></html>');
});

afterEach(async () => {
  await gateway?.stop();
  if (upstream) {
    const closed = new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream.closeAllConnections();
    await closed;
  }
  upstream = undefined;
  gateway = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function startGateway(endpoint = 'http://127.0.0.1:1') {
  gateway = new RendererServer({
    webRoot: directory,
    preferredPort: 0,
    getCoreUpstream: () => endpoint,
    logger: { info() {}, warn() {}, error() {} },
  });
  return gateway.start();
}

describe('renderer gateway real HTTP lifecycle', () => {
  it.each([true, false])('delivers 413 over a real socket (declared size: %s)', async (declared) => {
    const address = await startGateway();
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const outgoing = request(`${address.origin}/__qed2_core/content/questions/batch`, {
        method: 'POST',
        headers: {
          [DESKTOP_TOKEN_HEADER]: address.token,
          ...(declared ? { 'Content-Length': 17 * 1024 * 1024 } : { 'Transfer-Encoding': 'chunked' }),
        },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
        response.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.setTimeout(3_000, () => outgoing.destroy(new Error('Gateway did not reject the upload')));
      if (declared) outgoing.end('{}');
      else outgoing.end(Buffer.alloc(16 * 1024 * 1024 + 1));
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toMatchObject({ error: { code: 'REQUEST_TOO_LARGE' } });
  });

  it('aborts the upstream HTTP request when the renderer disconnects', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
    let upstreamStarted!: () => void;
    const started = new Promise<void>((resolve) => { upstreamStarted = resolve; });
    upstream = createServer((_request, response) => {
      response.once('close', upstreamClosed);
      upstreamStarted();
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const binding = upstream.address();
    if (!binding || typeof binding === 'string') throw new Error('Missing upstream binding');
    const address = await startGateway(`http://127.0.0.1:${binding.port}`);
    const outgoing = request(`${address.origin}/__qed2_core/content/questions`, {
      headers: { [DESKTOP_TOKEN_HEADER]: address.token },
    });
    outgoing.on('error', () => {});
    outgoing.end();
    await started;
    outgoing.destroy();
    await closed;
  });
});
