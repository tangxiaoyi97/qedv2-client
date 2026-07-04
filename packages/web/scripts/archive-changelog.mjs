#!/usr/bin/env node
/**
 * Archives public/changelogs/latest.md as dist/changelogs/<sha>.md when there
 * are notes to announce for this build. Runs after `vite build`.
 *
 * Archives only when:
 *   - a real commit sha is known (skip 'dev'),
 *   - latest.md is non-empty,
 *   - and it was changed in this push — CI sets CHANGELOG_CHANGED=0 when the
 *     diff did not touch latest.md; local builds (var unset) always archive so
 *     you can preview the dialog.
 *
 * Also removes dist/changelogs/latest.md and README.md so the unreleased draft
 * and docs are not published.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommit } from './commit.mjs';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const latestPath = join(webDir, 'public', 'changelogs', 'latest.md');
const distDir = join(webDir, 'dist', 'changelogs');

// Never publish the draft/docs regardless of outcome.
for (const f of ['latest.md', 'README.md']) {
  const p = join(distDir, f);
  if (existsSync(p)) rmSync(p);
}

const sha = resolveCommit();
if (sha === 'dev') {
  console.log('[changelog] no commit sha — skip archive');
  process.exit(0);
}
if (!existsSync(latestPath)) {
  console.log('[changelog] no latest.md — skip');
  process.exit(0);
}
const content = readFileSync(latestPath, 'utf8');
if (content.trim() === '') {
  console.log('[changelog] latest.md empty — skip (no dialog for this build)');
  process.exit(0);
}
if (process.env.CHANGELOG_CHANGED === '0') {
  console.log('[changelog] latest.md unchanged this push — skip');
  process.exit(0);
}

mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, `${sha}.md`), content);
console.log(`[changelog] archived → dist/changelogs/${sha}.md`);
