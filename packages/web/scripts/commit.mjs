import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The commit that identifies THIS build. Injected into the bundle as
 * __APP_COMMIT__ (vite.config) AND used to name the archived changelog
 * (archive-changelog.mjs), so the two always agree.
 *
 *  - CI: GITHUB_SHA (the pushed commit)
 *  - local build: current git HEAD
 *  - no git at all: 'dev' (changelog check is skipped)
 */
export function resolveCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

/**
 * The app version injected as __APP_VERSION__ — read from this package's
 * package.json so the settings page can never drift from the release tag.
 */
export function resolveVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}
