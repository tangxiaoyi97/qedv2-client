import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LOOPBACK_HOST } from './port-allocator.js';

const TOKEN_HEADER = 'x-qed2-desktop-token';
const MAX_PROXY_BODY = 16 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const COPY_RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
]);

export interface RendererServerLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface RendererServerOptions {
  webRoot: string;
  preferredPort: number;
  getCoreUpstream(source?: 'local' | 'remote'): string | undefined;
  logger: RendererServerLogger;
}

export interface RendererServerAddress {
  port: number;
  origin: string;
  bootUrl: string;
  token: string;
}

function secureHeaders(csp: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
  };
}

function setHeaders(response: ServerResponse, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
}

function safeTokenEqual(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_PROXY_BODY) throw new Error('Proxy request body exceeds safety limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

interface CoreRoute {
  source?: 'local' | 'remote';
  relativePath: string;
}

function coreRoute(pathname: string): CoreRoute | undefined {
  const root = '/__qed2_core';
  if (!pathname.startsWith(`${root}/`)) return undefined;
  let relativePath = pathname.slice(root.length);
  let source: CoreRoute['source'];
  for (const candidate of ['local', 'remote'] as const) {
    const prefix = `/${candidate}`;
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) {
      source = candidate;
      relativePath = relativePath.slice(prefix.length) || '/';
      break;
    }
  }
  if (
    relativePath !== '/info' &&
    relativePath !== '/health' &&
    !relativePath.startsWith('/content/')
  ) {
    return undefined;
  }
  return { ...(source ? { source } : {}), relativePath };
}

function matchCount(value: string, expression: RegExp): number {
  return [...value.matchAll(expression)].length;
}

/**
 * Converts the ordinary Web build into the hardened desktop entry document.
 * Every invariant is checked so a future Vite/PWA output change fails loudly
 * during startup instead of silently shipping a blank or service-worker-owned
 * desktop window.
 */
export function transformDesktopIndex(rawIndex: string, nonce: string): string {
  if (matchCount(rawIndex, /<html\b[^>]*>/gi) !== 1) {
    throw new Error('Desktop Web entry must contain exactly one <html> element');
  }
  if (matchCount(rawIndex, /<\/head>/gi) !== 1 || matchCount(rawIndex, /<\/body>/gi) !== 1) {
    throw new Error('Desktop Web entry must contain exactly one closing head and body tag');
  }

  const transformed = rawIndex
    .replace(/<link\b[^>]*\brel=(['"])manifest\1[^>]*>/gi, '')
    .replace(
      /<script\b(?=[^>]*(?:\bid=(['"])vite-plugin-pwa:register-sw\1|\bsrc=(['"])[^'"]*registerSW\.js[^'"]*\2))[^>]*>\s*<\/script>/gi,
      '',
    )
    .replace(/<html\b([^>]*)>/i, (_match, attributes: string) => {
      const withoutPlatform = attributes.replace(/\sdata-platform=(['"])[^'"]*\1/gi, '');
      return `<html${withoutPlatform} data-platform="desktop">`;
    })
    .replace(/<script\b([^>]*)>/gi, (tag, attributes: string) => {
      if (/\bsrc\s*=/i.test(attributes)) return tag;
      const withoutNonce = attributes.replace(/\snonce=(['"])[^'"]*\1/gi, '');
      return `<script nonce="${nonce}"${withoutNonce}>`;
    });

  const inlineScripts = [...transformed.matchAll(/<script\b([^>]*)>/gi)]
    .map((match) => match[1] ?? '')
    .filter((attributes) => !/\bsrc\s*=/i.test(attributes));
  const valid =
    /<html\b[^>]*\bdata-platform="desktop"[^>]*>/i.test(transformed) &&
    !/data-qed2-desktop|\/__desktop\//i.test(transformed) &&
    !/<link\b[^>]*\brel=(['"])manifest\1/i.test(transformed) &&
    !/vite-plugin-pwa:register-sw|registerSW\.js|navigator\.serviceWorker/i.test(transformed) &&
    inlineScripts.every((attributes) => attributes.includes(`nonce="${nonce}"`));
  if (!valid) throw new Error('Desktop Web entry transformation failed its security invariants');
  return transformed;
}

export class RendererServer {
  private server: Server | undefined;
  private address: RendererServerAddress | undefined;
  private indexHtml = '';
  private csp = '';
  private webRootReal = '';

  constructor(private readonly options: RendererServerOptions) {}

  getAddress(): RendererServerAddress {
    if (!this.address) throw new Error('Renderer server has not started');
    return { ...this.address };
  }

  async start(): Promise<RendererServerAddress> {
    if (this.address) return this.getAddress();
    const [webRootReal, rawIndex] = await Promise.all([
      realpath(this.options.webRoot),
      readFile(resolve(this.options.webRoot, 'index.html'), 'utf8'),
    ]);
    this.webRootReal = webRootReal;
    const nonce = randomBytes(24).toString('base64');
    this.indexHtml = transformDesktopIndex(rawIndex, nonce);
    this.csp = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob: https: http:",
      "connect-src 'self' https: http:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "worker-src 'none'",
    ].join('; ');

    const token = randomBytes(32).toString('base64url');
    const server = createServer((request, response) => {
      void this.handle(request, response, token).catch((error: unknown) => {
        this.options.logger.error('Renderer gateway request failed', error);
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        setHeaders(response, secureHeaders(this.csp));
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('QED2 desktop gateway error');
      });
    });
    this.server = server;
    const port = await this.listenWithFallback(server, this.options.preferredPort);
    const origin = `http://${LOOPBACK_HOST}:${port}`;
    this.address = {
      port,
      origin,
      // The capability token is transported only in an injected request
      // header. Keep it out of URLs, history, crash reports and proxy logs.
      bootUrl: `${origin}/__qed2_boot/${randomBytes(12).toString('base64url')}`,
      token,
    };
    this.options.logger.info('Renderer gateway ready', {
      preferredPort: this.options.preferredPort,
      actualPort: port,
    });
    return this.getAddress();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    if (!server) return;
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
      server.closeAllConnections();
    });
  }

  private async listenWithFallback(server: Server, preferredPort: number): Promise<number> {
    const listen = async (port: number): Promise<number> =>
      await new Promise((resolveListen, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address === 'string') reject(new Error('Unexpected renderer server address'));
          else resolveListen(address.port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: LOOPBACK_HOST, port, exclusive: true });
      });
    try {
      return await listen(preferredPort);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      this.options.logger.warn('Preferred renderer port is occupied; using an OS-assigned port', {
        preferredPort,
      });
      return await listen(0);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    setHeaders(response, secureHeaders(this.csp));
    const address = this.getAddress();
    const host = request.headers.host;
    if (host !== `${LOOPBACK_HOST}:${address.port}`) {
      response.writeHead(421).end('Misdirected request');
      return;
    }
    const providedToken = Array.isArray(request.headers[TOKEN_HEADER])
      ? request.headers[TOKEN_HEADER][0]
      : request.headers[TOKEN_HEADER];
    if (!safeTokenEqual(token, providedToken)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const url = new URL(request.url ?? '/', address.origin);
    const matchedCoreRoute = coreRoute(url.pathname);
    if (matchedCoreRoute) {
      const method = request.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
        response.writeHead(405, { Allow: 'GET, HEAD, POST' }).end();
        return;
      }
      await this.proxyCore(request, response, url, matchedCoreRoute);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    // Desktop UI is owned by the shared Web bundle. Keep the retired private
    // asset namespace closed so an old beacon/tool URL can never reappear as
    // an accidental SPA fallback.
    if (url.pathname === '/__desktop' || url.pathname.startsWith('/__desktop/')) {
      response.writeHead(404).end('Not found');
      return;
    }
    const isAsset = url.pathname.includes('.') && !url.pathname.startsWith('/__qed2_boot/');
    if (isAsset) {
      const file = await this.resolveStaticPath(url.pathname);
      if (!file) {
        response.writeHead(404).end('Not found');
        return;
      }
      await this.serveFile(response, file, request.method === 'HEAD');
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.writeHead(200);
    response.end(request.method === 'HEAD' ? undefined : this.indexHtml);
  }

  private async proxyCore(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    route: CoreRoute,
  ): Promise<void> {
    const selectedUpstream = this.options.getCoreUpstream(route.source);
    if (!selectedUpstream) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Retry-After', '2');
      response.writeHead(503);
      response.end(JSON.stringify({
        error: {
          code: 'CORE_SOURCE_UNAVAILABLE',
          message: 'The selected content source is not ready.',
        },
      }));
      return;
    }
    const upstream = new URL(selectedUpstream);
    upstream.pathname = `${upstream.pathname.replace(/\/$/, '')}${route.relativePath}`;
    upstream.search = url.search;
    const body = await readRequestBody(request);
    const headers = new Headers();
    for (const name of ['accept', 'content-type', 'if-none-match', 'if-modified-since', 'range']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const abort = new AbortController();
    const abortRequest = () => abort.abort(new Error('Renderer request was aborted'));
    const abortResponse = () => {
      if (!response.writableEnded) abort.abort(new Error('Renderer response was closed'));
    };
    request.once('aborted', abortRequest);
    response.once('close', abortResponse);
    try {
      const upstreamResponse = await fetch(upstream, {
        method: request.method ?? 'GET',
        headers,
        credentials: 'omit',
        ...(body ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
      });
      for (const [name, value] of upstreamResponse.headers) {
        if (COPY_RESPONSE_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
      }
      response.statusCode = upstreamResponse.status;
      if (request.method === 'HEAD' || !upstreamResponse.body) {
        response.end();
        return;
      }
      await pipeline(Readable.fromWeb(upstreamResponse.body as never), response);
    } finally {
      request.off('aborted', abortRequest);
      response.off('close', abortResponse);
    }
  }

  private async resolveStaticPath(pathname: string): Promise<string | undefined> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    if (decoded.includes('\0') || decoded.split('/').includes('..')) return undefined;
    const candidate = resolve(this.webRootReal, `.${decoded}`);
    if (candidate !== this.webRootReal && !candidate.startsWith(`${this.webRootReal}${sep}`)) return undefined;
    const info = await stat(candidate).catch(() => undefined);
    if (!info?.isFile()) return undefined;
    const actual = await realpath(candidate);
    if (actual !== this.webRootReal && !actual.startsWith(`${this.webRootReal}${sep}`)) return undefined;
    return actual;
  }

  private async serveFile(response: ServerResponse, file: string, headOnly: boolean): Promise<void> {
    const info = await stat(file);
    const extension = extname(file).toLowerCase();
    response.setHeader('Content-Type', MIME[extension] ?? 'application/octet-stream');
    response.setHeader('Content-Length', String(info.size));
    const isHashedAsset = /[/\\]assets[/\\].+-[A-Za-z0-9_-]{6,}\./.test(file);
    response.setHeader('Cache-Control', isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache');
    const etag = `"${createHash('sha256').update(`${file}:${info.size}:${info.mtimeMs}`).digest('base64url')}"`;
    response.setHeader('ETag', etag);
    response.writeHead(200);
    if (headOnly) {
      response.end();
      return;
    }
    await pipeline(createReadStream(file), response);
  }
}

export const DESKTOP_TOKEN_HEADER = TOKEN_HEADER;
