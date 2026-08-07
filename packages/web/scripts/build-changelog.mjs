#!/usr/bin/env node
/**
 * Compiles CHANGELOG.md into dist/changelogs/index.json. Runs after `vite build`.
 *
 * What this replaced, and why: the old script archived latest.md as
 * `dist/changelogs/<commit-sha>.md`, keyed the dialog on the build commit, and
 * only archived when CI's diff said latest.md had changed in that push. Three
 * things were wrong with it.
 *
 *  - dist is rebuilt from scratch and Pages replaces the whole site, so the
 *    server only ever held ONE changelog. Every past release was unreadable,
 *    and a hotfix pushed after a release deleted that release's notes before
 *    most people had loaded the app — the announcement was simply lost.
 *  - the CI diff looked at HEAD~1, so a push carrying several commits missed a
 *    latest.md edit that was not in the last one.
 *  - the version was typed by hand INSIDE latest.md, next to a package.json
 *    that also claimed a version. They drifted, as two sources of truth do.
 *
 * Now every released section ships on every deploy, keyed by version, and the
 * only place a version is written is the root package.json.
 *
 * The whole file is one JSON payload rather than one file per version: the
 * client wants "everything since you were last here", which is a range, and a
 * range costs one request this way instead of N. It is a few kB.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseChangelog,
  normalizeDraft,
  isPrerelease,
  releaseDate,
} from '../../../scripts/changelog.mjs';
import { resolveVersion } from './commit.mjs';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webDir, '..', '..');
const changelogPath = join(repoRoot, 'CHANGELOG.md');
const draftPath = join(webDir, 'public', 'changelogs', 'latest.md');
const distDir = join(webDir, 'dist', 'changelogs');

// The draft and its docs are working files; vite copies public/ verbatim, so
// they have to be removed from the output or they would be served.
for (const f of ['latest.md', 'README.md']) {
  const p = join(distDir, f);
  if (existsSync(p)) rmSync(p);
}

const version = resolveVersion();
const entries = existsSync(changelogPath) ? parseChangelog(readFileSync(changelogPath, 'utf8')) : [];

/*
 * Unreleased builds (a beta, or main before the version bump lands) have no
 * section yet. Ship the draft under the running version so the dialog can be
 * seen exactly as users will see it — reviewing release notes in the real
 * dialog, before the release, is the only way to catch a broken one.
 */
if (!entries.some((e) => e.version === version)) {
  const draft = existsSync(draftPath) ? readFileSync(draftPath, 'utf8') : '';
  if (draft.trim() !== '') {
    entries.unshift({
      version,
      date: releaseDate(),
      body: normalizeDraft(draft, version),
      draft: true,
    });
    console.log(`[changelog] ${version} unreleased — shipping latest.md as a draft entry`);
  }
}

if (entries.length === 0) {
  console.log('[changelog] nothing to publish');
  process.exit(0);
}

mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, 'index.json'), JSON.stringify(entries));

const here = entries.findIndex((e) => e.version === version);
console.log(
  `[changelog] ${entries.length} entries → dist/changelogs/index.json` +
    (here === -1
      ? ` (this build is ${version}${isPrerelease(version) ? ', a prerelease' : ''} — no entry, no dialog)`
      : ` (this build is ${version})`),
);
