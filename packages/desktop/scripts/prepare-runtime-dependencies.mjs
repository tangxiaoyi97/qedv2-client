import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export async function installCoreProductionDependencies(source, destination, pnpm) {
  await mkdir(destination, { recursive: true });
  await Promise.all([
    cp(resolve(source, 'package.json'), resolve(destination, 'package.json')),
    cp(resolve(source, 'pnpm-lock.yaml'), resolve(destination, 'pnpm-lock.yaml')),
  ]);
  const sourceWorkspace = resolve(source, 'pnpm-workspace.yaml');
  const stagedWorkspace = resolve(destination, 'pnpm-workspace.yaml');
  const workspaceInfo = await lstat(sourceWorkspace).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (workspaceInfo) {
    if (!workspaceInfo.isFile()) throw new Error('Core pnpm-workspace.yaml must be a regular file');
    await cp(sourceWorkspace, stagedWorkspace);
  } else {
    // Older Core commits still need a boundary against the enclosing Client
    // workspace, whose overrides do not describe Core's frozen lockfile.
    await writeFile(stagedWorkspace, 'packages: []\n', 'utf8');
  }
  try {
    await runFile(
      pnpm.executable,
      [
        ...pnpm.prefix,
        '--dir',
        destination,
        'install',
        '--prod',
        '--frozen-lockfile',
        // --ignore-workspace also discards this directory's audited overrides.
        // Its own workspace boundary and a non-recursive install isolate Core.
        '--recursive=false',
        '--ignore-scripts',
        '--config.node-linker=hoisted',
        '--config.package-import-method=copy',
      ],
      { env: process.env, maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    // Workspace configuration is an installation input. The packaged runtime
    // contains the resulting integrity-protected graph and needs no pnpm.
    await rm(stagedWorkspace, { force: true });
  }
}
