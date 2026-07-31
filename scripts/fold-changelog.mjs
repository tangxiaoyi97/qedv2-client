#!/usr/bin/env node
/**
 * Cut a release section, locally, in the same commit as the version bump.
 *
 * Runs from .githooks/pre-commit right after sync-version.mjs. When the root
 * package.json carries a version that CHANGELOG.md does not have a section
 * for, the draft in packages/web/public/changelogs/latest.md is folded in
 * under `## <version> — <today>`, the draft is emptied, and both files are
 * re-staged so they ride the same commit as the bump.
 *
 * Why local and not CI: the alternative is a workflow that commits back to the
 * repository, which needs write-scoped tokens, a `[skip ci]` guard to avoid
 * triggering itself, and still races two pushes landing minutes apart. Doing
 * it in the pre-commit hook means git never sees a second writer — the release
 * is one ordinary commit that happens to have been assembled for you.
 *
 * No-ops (all silent enough to run on every commit):
 *   - prerelease versions (2.0.0-beta.10) — betas do not cut sections
 *   - the version already has a section — idempotent, re-running is free
 *   - an empty draft — a release with nothing to announce is allowed
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { isPrerelease, normalizeDraft, parseChangelog, prependSection, CHANGELOG_PREAMBLE } from './changelog.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = join(root, 'CHANGELOG.md');
const draftPath = join(root, 'packages', 'web', 'public', 'changelogs', 'latest.md');

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || version === '') {
  console.error('[changelog] root package.json has no version');
  process.exit(1);
}

if (isPrerelease(version)) {
  console.log(`[changelog] ${version} is a prerelease — no section cut`);
  process.exit(0);
}

const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : CHANGELOG_PREAMBLE;
if (parseChangelog(changelog).some((e) => e.version === version)) {
  console.log(`[changelog] ${version} already released — nothing to do`);
  process.exit(0);
}

const draft = existsSync(draftPath) ? readFileSync(draftPath, 'utf8') : '';
if (draft.trim() === '') {
  console.log(`[changelog] ${version} is new but latest.md is empty — no notes for this release`);
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
const next = prependSection(changelog, version, date, normalizeDraft(draft, version));
if (next === null) process.exit(0); // raced with the check above; impossible in practice

writeFileSync(changelogPath, next);
writeFileSync(draftPath, '');
console.log(`[changelog] ${version} — ${date} folded into CHANGELOG.md; latest.md cleared`);

try {
  execSync(`git add "${changelogPath}" "${draftPath}"`, { cwd: root, stdio: 'inherit' });
} catch {
  /* not in a git repo — the files are written, staging is a convenience */
}
