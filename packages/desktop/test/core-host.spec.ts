import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const hostEntry = fileURLToPath(new URL('../src/core-host.cjs', import.meta.url));
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qed2-core-host-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Core utility-process host', () => {
  it('forces explicit wildcard hosts to IPv4 loopback for every TCP listener', async () => {
    const coreDirectory = await temporaryDirectory();
    const preload = resolve(coreDirectory, 'capture-listen.cjs');
    const entry = resolve(coreDirectory, 'entry.cjs');
    await writeFile(
      preload,
      [
        "const net = require('node:net');",
        'globalThis.__qed2CapturedHosts = [];',
        'net.Server.prototype.listen = function (...args) {',
        "  const first = args[0];",
        "  globalThis.__qed2CapturedHosts.push(first && typeof first === 'object' ? first.host : args[1]);",
        '  return this;',
        '};',
      ].join('\n'),
    );
    await writeFile(
      entry,
      [
        "const net = require('node:net');",
        'const first = net.createServer();',
        "first.listen({ port: 43123, host: '0.0.0.0' });",
        'const second = net.createServer();',
        "second.listen(43124, '::');",
        'process.stdout.write(JSON.stringify(globalThis.__qed2CapturedHosts));',
      ].join('\n'),
    );

    const { stdout } = await runFile(process.execPath, ['--require', preload, hostEntry], {
      env: {
        ...process.env,
        QED2_CORE_ENTRY: entry,
        QED2_CORE_DIRECTORY: coreDirectory,
      },
      timeout: 10_000,
    });

    expect(JSON.parse(stdout) as unknown).toEqual(['127.0.0.1', '127.0.0.1']);
  });

  it('refuses to load an entry outside the declared runtime directory', async () => {
    const root = await temporaryDirectory();
    const coreDirectory = resolve(root, 'core');
    await mkdir(coreDirectory);
    const outsideEntry = resolve(root, 'outside.cjs');
    await writeFile(outsideEntry, 'module.exports = {};\n');

    await expect(
      runFile(process.execPath, [hostEntry], {
        env: {
          ...process.env,
          QED2_CORE_ENTRY: outsideEntry,
          QED2_CORE_DIRECTORY: coreDirectory,
        },
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('escaped its bundled runtime directory'),
    });
  });
});
