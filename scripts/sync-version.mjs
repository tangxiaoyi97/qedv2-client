#!/usr/bin/env node
/**
 * Single source of truth for the app version: the ROOT package.json.
 * Copies it into every packages/*\/package.json (they are private workspace
 * libs whose own version fields are cosmetic; @qed2/web reads its own at
 * build time via scripts/commit.mjs).
 *
 * Wired into .githooks/pre-commit — staging a commit with a bumped root
 * version auto-syncs (and re-stages) the rest. Manual use:
 *
 *   pnpm version:sync
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = rootPkg.version;
if (typeof version !== 'string' || version === '') {
  console.error('[version:sync] root package.json has no version');
  process.exit(1);
}

const targets = ['packages/core-logic', 'packages/ui', 'packages/web', 'packages/desktop', 'packages/mobile'];
const changed = [];

for (const dir of targets) {
  const file = join(root, dir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue; // package dir doesn't exist yet (desktop/mobile are stubs)
  }
  if (pkg.version === version) continue;
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  changed.push(`${dir}/package.json`);
}

if (changed.length === 0) {
  console.log(`[version:sync] all packages already at ${version}`);
} else {
  console.log(`[version:sync] ${version} → ${changed.join(', ')}`);
  // inside the pre-commit hook: re-stage so the sync rides the same commit
  try {
    execSync(`git add ${changed.map((f) => `"${f}"`).join(' ')}`, { cwd: root, stdio: 'inherit' });
  } catch {
    /* not in a git repo (e.g. packed tarball) — nothing to stage */
  }
}
