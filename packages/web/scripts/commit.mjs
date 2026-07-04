import { execSync } from 'node:child_process';

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
