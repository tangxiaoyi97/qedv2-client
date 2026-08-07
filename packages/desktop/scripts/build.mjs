import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  target: 'node24',
  platform: 'node',
  logLevel: 'info',
  external: ['electron', 'electron-updater'],
};

await Promise.all([
  build({
    ...common,
    entryPoints: [resolve(root, 'src/main.ts')],
    format: 'esm',
    outfile: resolve(out, 'main.mjs'),
  }),
  build({
    ...common,
    entryPoints: [resolve(root, 'src/preload.ts')],
    format: 'cjs',
    outfile: resolve(out, 'preload.cjs'),
  }),
  cp(resolve(root, 'src/core-host.cjs'), resolve(out, 'core-host.cjs')),
]);
