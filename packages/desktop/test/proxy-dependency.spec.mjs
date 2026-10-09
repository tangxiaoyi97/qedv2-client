import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cert, key } from './fixtures/proxy-tls.mjs';

const desktopRequire = createRequire(new URL('../package.json', import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const getPath = appBuilderRequire.resolve('@electron/get');
const getRequire = createRequire(getPath);
const payload = Buffer.from('QED2 proxy compatibility artifact\n');
const digest = createHash('sha256').update(payload).digest('hex');
const filename = 'electron-v42.10.0-linux-x64.zip';
const sockets = new Set();
const servers = [];
const proxyRequests = [];
const originRequests = [];
let temporaryDirectory, caFile, originPort, tlsPort, proxyPort;

// bootstrap() mutates Node's global http(s) agents. Exercise the actual
// @electron/get call chain in fresh processes, never the test runner's agents.
const worker = `
  const assert = require('node:assert/strict');
  const { readFile } = require('node:fs/promises');
  const { createRequire } = require('node:module');
  const input = JSON.parse(process.argv[1]);
  const get = require(input.getPath);
  const agent = createRequire(input.getPath)('global-agent');
  get.initializeProxy();
  assert.equal(typeof agent.bootstrap, 'function');
  assert.equal(typeof agent.createGlobalProxyAgent, 'function');
  assert.ok(globalThis.GLOBAL_AGENT, 'Electron downloader failed to initialize proxy support');
  assert.equal(agent.bootstrap(), false, 'duplicate bootstrap must preserve the current agents');
  (async () => {
    let path;
    try {
      path = await get.downloadArtifact({
        version: '42.10.0', platform: 'linux', arch: 'x64', artifactName: 'electron',
        cacheRoot: input.cacheRoot, force: true,
        mirrorOptions: { mirror: input.mirror },
        downloadOptions: { quiet: true, retry: { limit: 0 }, timeout: { request: 3000 } },
      });
    } catch (error) {
      if (!input.failure) throw error;
      assert.match(error.message, new RegExp(input.failure, 'i'));
      console.log(JSON.stringify({ rejected: true, message: error.message }));
      return;
    }
    // These assertions must stay outside the download-error catch: otherwise
    // their own text could satisfy the expected TLS rejection pattern.
    assert.equal(input.failure, undefined, 'download unexpectedly succeeded');
    assert.equal((await readFile(path)).toString(), input.payload);
    console.log(JSON.stringify({ ok: true }));
  })().catch((error) => { console.error(error); process.exitCode = 1; });
`;

function track(server) {
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return server;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function serveArtifact(request, response) {
  originRequests.push(request.url);
  if (request.url.endsWith('/SHASUMS256.txt')) {
    const hash = request.url.startsWith('/bad/') ? '0'.repeat(64) : digest;
    response.end(`${hash} *${filename}\n`);
  } else if (request.url.endsWith(`/${filename}`)) {
    response.end(payload);
  } else {
    response.writeHead(404).end();
  }
}

async function runDownload(name, mirror, overrides = {}, failure) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/proxy|^electron_|^npm_config_electron_|^node_(?:extra_ca_certs|tls_reject_unauthorized|options)$/i.test(key)));
  const input = { getPath, mirror, payload: payload.toString(), cacheRoot: join(temporaryDirectory, name), failure };
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', worker, JSON.stringify(input)], {
      // Disable the downloader's delayed terminal progress timer: get 3 keeps
      // it alive after an expected download rejection, independently of proxying.
      env: { ...env, ELECTRON_GET_NO_PROGRESS: '1', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Proxy check ${name} timed out`)); }, 8000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Proxy check ${name} failed (${code}): ${stderr}`));
      else { try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); } }
    });
  });
}

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'qed2-proxy-check-'));
  caFile = join(temporaryDirectory, 'test-ca.pem');
  await writeFile(caFile, cert);
  originPort = await listen(track(http.createServer(serveArtifact)));
  tlsPort = await listen(track(https.createServer({ cert, key }, serveArtifact)));
  const proxy = track(http.createServer((request, response) => {
    proxyRequests.push({ method: request.method, url: request.url, auth: request.headers['proxy-authorization'] });
    const destination = new URL(request.url);
    assert.equal(destination.hostname, 'downloads.example.test');
    const upstream = http.request({ hostname: '127.0.0.1', port: originPort, path: destination.pathname }, (incoming) => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('error', () => response.writeHead(502).end());
    request.pipe(upstream);
  }));
  proxy.on('connect', (request, socket, head) => {
    proxyRequests.push({ method: 'CONNECT', url: request.url, auth: request.headers['proxy-authorization'] });
    assert.equal(request.url, `localhost:${tlsPort}`);
    const upstream = net.connect(tlsPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
  });
  proxyPort = await listen(proxy);
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('Electron downloader proxy dependency compatibility', () => {
  it('uses the reviewed upstream package without the vulnerable logger dependency', () => {
    const info = getRequire('global-agent/package.json');
    expect(info.version).toBe('4.1.3');
    expect(info.dependencies.roarr).toBeUndefined();
    expect(info.dependencies['sprintf-js']).toBeUndefined();
  });

  it('downloads directly with no proxy and verifies a real SHA-256 manifest', async () => {
    const before = proxyRequests.length;
    expect(await runDownload('direct', `http://127.0.0.1:${originPort}/`)).toEqual({ ok: true });
    expect(proxyRequests).toHaveLength(before);
    expect(originRequests).toContain('/v42.10.0/SHASUMS256.txt');
  });

  it('downloads the artifact and checksums through an authenticated HTTP proxy', async () => {
    const before = proxyRequests.length;
    expect(await runDownload('http-proxy', 'http://downloads.example.test/', {
      GLOBAL_AGENT_HTTP_PROXY: `http://test-user:test-password@127.0.0.1:${proxyPort}`,
    })).toEqual({ ok: true });
    const requests = proxyRequests.slice(before);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.auth === `Basic ${Buffer.from('test-user:test-password').toString('base64')}`)).toBe(true);
  });

  it('honors NO_PROXY even when the configured proxy cannot be reached', async () => {
    expect(await runDownload('no-proxy', `http://127.0.0.1:${originPort}/`, {
      GLOBAL_AGENT_HTTP_PROXY: 'http://127.0.0.1:1', GLOBAL_AGENT_NO_PROXY: '127.0.0.1',
    })).toEqual({ ok: true });
  });

  it('uses HTTPS CONNECT and accepts an explicitly trusted local CA', async () => {
    const before = proxyRequests.length;
    expect(await runDownload('https-proxy', `https://localhost:${tlsPort}/`, {
      GLOBAL_AGENT_HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NODE_EXTRA_CA_CERTS: caFile,
    })).toEqual({ ok: true });
    expect(proxyRequests.slice(before).filter((request) => request.method === 'CONNECT')).toHaveLength(2);
  });

  it('rejects an untrusted HTTPS certificate through the proxy', async () => {
    const result = await runDownload('untrusted-ca', `https://localhost:${tlsPort}/`, {
      GLOBAL_AGENT_HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    }, 'self.signed|certificate');
    expect(result.rejected).toBe(true);
  });

  it('still rejects a checksum mismatch after a successful proxy download', async () => {
    const result = await runDownload('invalid-checksum', 'http://downloads.example.test/bad/', {
      GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    }, 'checksum.*(mismatch|match)');
    expect(result.rejected).toBe(true);
  });
});
