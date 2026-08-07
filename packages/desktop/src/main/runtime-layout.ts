import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import {
  readRuntimeManifest,
  verifyRuntimeIntegrity,
  type RuntimeManifest,
} from './runtime-integrity.js';

export type { RuntimeManifest } from './runtime-integrity.js';

export interface RuntimeDescriptor {
  runtimeRoot?: string;
  coreDirectory: string;
  coreEntry: string;
  bankDirectory: string;
  manifest?: RuntimeManifest;
  source: 'bundled' | 'development';
}

async function mustExist(path: string, label: string): Promise<void> {
  await access(path, constants.R_OK).catch(() => {
    throw new Error(`${label} is missing or unreadable: ${path}`);
  });
}

export async function resolveRuntime(options: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RuntimeDescriptor> {
  const env = options.env ?? process.env;
  if (options.packaged) {
    const runtimeRoot = resolve(options.resourcesPath, 'runtime');
    const manifest = await readRuntimeManifest(resolve(runtimeRoot, 'runtime-manifest.json'));
    const coreDirectory = resolve(runtimeRoot, 'core');
    const coreEntry = resolve(coreDirectory, manifest.core.entry);
    const bankDirectory = resolve(runtimeRoot, 'bank');
    const runtime: RuntimeDescriptor = {
      runtimeRoot,
      coreDirectory,
      coreEntry,
      bankDirectory,
      manifest,
      source: 'bundled',
    };
    // Bootstrap verifies the manifest plus executable/provenance anchors before
    // any Core process can be created. The supervisor performs the full tree
    // verification immediately before every bundled Core launch.
    await verifyRuntimeIntegrity(runtime, 'light');
    return runtime;
  }

  const workspaceRoot = resolve(options.appPath, '../../..');
  const coreDirectory = resolve(env.QED2_DESKTOP_CORE_PATH ?? resolve(workspaceRoot, 'qedv2-core'));
  const coreEntry = resolve(env.QED2_DESKTOP_CORE_ENTRY ?? resolve(coreDirectory, 'dist/main.js'));
  const bankDirectory = resolve(env.QED2_DESKTOP_BANK_PATH ?? resolve(workspaceRoot, 'srdpmppr'));
  await Promise.all([
    mustExist(coreEntry, 'Development core entry (run pnpm build in qedv2-core)'),
    mustExist(bankDirectory, 'Development question bank'),
  ]);
  return { coreDirectory, coreEntry, bankDirectory, source: 'development' };
}
