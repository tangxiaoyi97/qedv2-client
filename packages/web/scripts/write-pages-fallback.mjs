#!/usr/bin/env node

import { copyFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(packageRoot, 'dist/index.html');
const destination = resolve(packageRoot, 'dist/404.html');

await copyFile(source, destination);

// GitHub Pages serves 404.html for history-mode deep links. Fail the build if
// the fallback ever differs from the exact app shell that Vite produced.
const [appShell, fallback] = await Promise.all([readFile(source), readFile(destination)]);
if (!appShell.equals(fallback)) {
  throw new Error('GitHub Pages SPA fallback does not match dist/index.html');
}
