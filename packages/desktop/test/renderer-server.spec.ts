import { EventEmitter, once } from 'node:events';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpMocks = vi.hoisted(() => ({
  servers: [] as Server[],
  nextPort: 45_678,
}));

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (handler: Parameters<typeof actual.createServer>[0]) => {
      const server = actual.createServer(handler);
      let port = 0;
      server.listen = vi.fn(
        (options: { port?: number }, callback?: () => void) => {
          port = options.port === 0 ? httpMocks.nextPort : (options.port ?? httpMocks.nextPort);
          queueMicrotask(() => {
            server.emit('listening');
            callback?.();
          });
          return server;
        },
      ) as unknown as typeof server.listen;
      server.address = vi.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port }));
      server.close = vi.fn(((callback?: (error?: Error) => void) => {
        queueMicrotask(() => callback?.());
        return server;
      }) as typeof server.close);
      server.closeAllConnections = vi.fn();
      httpMocks.servers.push(server);
      return server;
    },
  };
});

import {
  DESKTOP_TOKEN_HEADER,
  RendererServer,
  type RendererServerAddress,
  type RendererServerLogger,
} from '../src/main/renderer-server.js';

interface GatewayResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

class FakeRequest extends Readable {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  private sent = false;

  constructor(options: {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body?: string | Buffer;
  }) {
    super();
    this.method = options.method;
    this.url = options.url;
    this.headers = options.headers;
    if (options.body !== undefined) this.body = Buffer.from(options.body);
  }

  private readonly body: Buffer | undefined;

  override _read(): void {
    if (this.sent) return;
    this.sent = true;
    if (this.body) this.push(this.body);
    this.push(null);
  }
}

class FakeResponse extends Writable {
  statusCode = 200;
  headersSent = false;
  readonly headers = new Map<string, string | string[]>();
  readonly chunks: Buffer[] = [];

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? [...value] : String(value));
    return this;
  }

  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
    return this;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
}

let temporaryDirectory = '';
let webRoot = '';
let rendererServer: RendererServer | undefined;

function logger(): RendererServerLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function createRendererServer(
  getCoreUpstream: (source?: 'local' | 'remote') => string | undefined =
    () => 'http://127.0.0.1:47891/base',
): Promise<RendererServerAddress> {
  rendererServer = new RendererServer({
    webRoot,
    preferredPort: 0,
    getCoreUpstream,
    logger: logger(),
  });
  return await rendererServer.start();
}

async function gatewayRequest(
  address: RendererServerAddress,
  path: string,
  options: {
    method?: string;
    token?: string;
    host?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {},
): Promise<GatewayResponse> {
  const server = httpMocks.servers.at(-1);
  if (!server) throw new Error('Expected an in-memory renderer server');
  const headers: IncomingHttpHeaders = {
    host: options.host ?? `127.0.0.1:${address.port}`,
    ...(options.token === undefined ? {} : { [DESKTOP_TOKEN_HEADER]: options.token }),
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    ),
  };
  const request = new FakeRequest({
    method: options.method ?? 'GET',
    url: path,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  const response = new FakeResponse();
  server.emit('request', request, response);
  await once(response, 'finish');
  return {
    status: response.statusCode,
    headers: Object.fromEntries(response.headers),
    body: Buffer.concat(response.chunks),
  };
}

beforeEach(async () => {
  httpMocks.servers.length = 0;
  httpMocks.nextPort += 1;
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'qed2-renderer-server-'));
  webRoot = join(temporaryDirectory, 'web');
  await mkdir(join(webRoot, 'assets'), { recursive: true });
  await Promise.all([
    writeFile(
      join(webRoot, 'index.html'),
      '<!doctype html><html lang="de"><head>' +
        '<link rel="manifest" href="/manifest.webmanifest">' +
        '<script id="theme-bootstrap">globalThis.themeBooted=true</script>' +
        '<script id="vite-plugin-pwa:register-sw" src="/registerSW.js"></script>' +
        '</head><body><main>QED2</main></body></html>',
      'utf8',
    ),
    writeFile(join(webRoot, 'assets', 'app-ABC123.js'), 'export const app = true;\n', 'utf8'),
    writeFile(join(temporaryDirectory, 'outside.txt'), 'secret', 'utf8'),
  ]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rendererServer?.stop();
  rendererServer = undefined;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('RendererServer security boundary', () => {
  it('requires both the exact loopback Host and the per-launch token', async () => {
    const address = await createRendererServer();

    expect((await gatewayRequest(address, '/')).status).toBe(403);
    expect((await gatewayRequest(address, '/', { token: 'wrong-token' })).status).toBe(403);
    expect(
      (
        await gatewayRequest(address, '/', {
          token: address.token,
          host: `localhost:${address.port}`,
        })
      ).status,
    ).toBe(421);

    const accepted = await gatewayRequest(address, address.bootUrl.replace(address.origin, ''), {
      token: address.token,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers['x-frame-options']).toBe('DENY');
    expect(accepted.headers['x-content-type-options']).toBe('nosniff');
    expect(accepted.headers['content-security-policy']).toContain("worker-src 'none'");
    const html = accepted.body.toString('utf8');
    expect(html).toContain('data-platform="desktop"');
    expect(html).toContain('nonce="');
    expect(html).not.toContain('data-qed2-desktop');
    expect(html).not.toContain('/__desktop/');
    expect(html).not.toContain('manifest.webmanifest');
    expect(html).not.toContain('registerSW.js');
  });

  it('serves static files with safe caching and rejects traversal', async () => {
    const address = await createRendererServer();

    const asset = await gatewayRequest(address, '/assets/app-ABC123.js', {
      token: address.token,
    });
    expect(asset.status).toBe(200);
    expect(asset.body.toString('utf8')).toContain('app = true');
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.etag).toMatch(/^".+"$/);

    const head = await gatewayRequest(address, '/assets/app-ABC123.js', {
      method: 'HEAD',
      token: address.token,
    });
    expect(head.status).toBe(200);
    expect(head.body).toHaveLength(0);

    const traversal = await gatewayRequest(address, '/%2e%2e%2Foutside.txt', {
      token: address.token,
    });
    expect(traversal.status).toBe(404);

    const retiredDesktopUi = await gatewayRequest(address, '/__desktop/desktop-ui.js', {
      token: address.token,
    });
    expect(retiredDesktopUi.status).toBe(404);

    const retiredNamespace = await gatewayRequest(address, '/__desktop', {
      token: address.token,
    });
    expect(retiredNamespace.status).toBe(404);

    const desktopDeepLink = await gatewayRequest(
      address,
      '/settings?section=desktop&desktopWindow=updates',
      { token: address.token },
    );
    expect(desktopDeepLink.status).toBe(200);
    expect(desktopDeepLink.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(desktopDeepLink.body.toString('utf8')).toContain('data-platform="desktop"');
  });

  it('proxies only core routes and forwards an allow-list of request headers', async () => {
    const upstreamFetch = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () =>
      new Response('proxied-body', {
        status: 206,
        headers: {
          'Content-Type': 'application/json',
          ETag: 'upstream-etag',
          'Set-Cookie': 'must-not-leak=true',
          'X-Upstream-Secret': 'must-not-leak',
        },
      }),
    );
    vi.stubGlobal('fetch', upstreamFetch);
    const address = await createRendererServer();

    const response = await gatewayRequest(address, '/__qed2_core/content/questions?q=algebra', {
      method: 'POST',
      token: address.token,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer renderer-secret',
        Cookie: 'session=renderer-secret',
        'X-Custom': 'not-forwarded',
      },
      body: '{"ids":["q1"]}',
    });

    expect(response.status).toBe(206);
    expect(response.body.toString('utf8')).toBe('proxied-body');
    expect(response.headers.etag).toBe('upstream-etag');
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-upstream-secret']).toBeUndefined();
    expect(upstreamFetch).toHaveBeenCalledTimes(1);

    const [input, init] = upstreamFetch.mock.calls[0] ?? [];
    expect(String(input)).toBe('http://127.0.0.1:47891/base/content/questions?q=algebra');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    const forwardedHeaders = init?.headers as Headers;
    expect(forwardedHeaders.get('accept')).toBe('application/json');
    expect(forwardedHeaders.get('content-type')).toBe('application/json');
    expect(forwardedHeaders.has('authorization')).toBe(false);
    expect(forwardedHeaders.has('cookie')).toBe(false);
    expect(forwardedHeaders.has(DESKTOP_TOKEN_HEADER)).toBe(false);
    expect(forwardedHeaders.has('x-custom')).toBe(false);
    expect(Buffer.from(init?.body as Buffer).toString('utf8')).toBe('{"ids":["q1"]}');

    const unsupportedMethod = await gatewayRequest(address, '/__qed2_core/content/questions', {
      method: 'DELETE',
      token: address.token,
    });
    expect(unsupportedMethod.status).toBe(405);
    expect(unsupportedMethod.headers.allow).toBe('GET, HEAD, POST');
    expect(upstreamFetch).toHaveBeenCalledTimes(1);

    const nonCore = await gatewayRequest(address, '/__qed2_core/admin', {
      token: address.token,
    });
    expect(nonCore.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps source-pinned routes isolated and never falls local back to remote', async () => {
    const upstreamFetch = vi.fn(async (_input: unknown) => Response.json({ status: 'ok' }));
    vi.stubGlobal('fetch', upstreamFetch);
    const getCoreUpstream = vi.fn((source?: 'local' | 'remote') =>
      source === 'local' ? undefined : 'https://remote-core.example/root',
    );
    const address = await createRendererServer(getCoreUpstream);

    const unavailable = await gatewayRequest(address, '/__qed2_core/local/content/info', {
      token: address.token,
    });
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(unavailable.body.toString('utf8'))).toMatchObject({
      error: { code: 'CORE_SOURCE_UNAVAILABLE' },
    });
    expect(upstreamFetch).not.toHaveBeenCalled();

    const remote = await gatewayRequest(address, '/__qed2_core/remote/content/info?fresh=1', {
      token: address.token,
    });
    expect(remote.status).toBe(200);
    expect(String(upstreamFetch.mock.calls[0]?.[0])).toBe(
      'https://remote-core.example/root/content/info?fresh=1',
    );
    expect(getCoreUpstream).toHaveBeenNthCalledWith(1, 'local');
    expect(getCoreUpstream).toHaveBeenNthCalledWith(2, 'remote');
  });

  it('rejects non-read methods for renderer static routes', async () => {
    const address = await createRendererServer();
    const response = await gatewayRequest(address, '/assets/app-ABC123.js', {
      method: 'POST',
      token: address.token,
      body: 'ignored',
    });

    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD');
  });
});
