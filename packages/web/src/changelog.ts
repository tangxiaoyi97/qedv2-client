/**
 * Which release notes to show, and when.
 *
 * Split out of the store so the rules are testable without a browser — they
 * are the part that decides whether a user ever learns what changed, and the
 * old sha-keyed version silently showed nothing in three separate situations.
 */

export interface ChangelogEntry {
  version: string;
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  /** Markdown body, without the version heading. */
  body: string;
  /** True for the not-yet-released draft a preview/beta build ships. */
  draft?: boolean;
}

/**
 * Parse `dist/changelogs/index.json`.
 *
 * Returns null for anything that is not the expected shape — including the app
 * shell, which a service worker or a SPA fallback can hand back with a 200 for
 * a file that is not there. HTML is not a changelog; failing to parse is the
 * check.
 */
export function parseChangelogIndex(text: string): ChangelogEntry[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const entries: ChangelogEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const e = item as Record<string, unknown>;
    if (typeof e.version !== 'string' || typeof e.date !== 'string' || typeof e.body !== 'string') {
      return null;
    }
    entries.push({
      version: e.version,
      date: e.date,
      body: e.body,
      ...(e.draft === true ? { draft: true as const } : {}),
    });
  }
  return entries;
}

/**
 * Everything the user has not seen yet, newest first.
 *
 * Selection is by POSITION in the index, never by comparing version strings.
 * The index is newest-first by construction (CHANGELOG.md is prepended to), so
 * "newer than what you saw" is "above it in the list" — which stays correct
 * across 1.9.7 → 1.10.0, prereleases, and any numbering scheme, none of which
 * a hand-rolled semver comparator survives.
 *
 * Rules:
 *  - no entry for the running version → this build announces nothing
 *  - never seen anything → adopt silently; a fresh install is not an update
 *  - last seen is unknown (index too short, or a user migrating off the old
 *    commit-keyed marker) → show just this version, never the whole history
 *  - last seen is at or above the current one → nothing (also covers a
 *    rollback, where shouting about a version you no longer run is wrong)
 */
export function entriesToAnnounce(
  entries: ChangelogEntry[],
  currentVersion: string,
  lastSeenVersion: string | null,
): ChangelogEntry[] {
  const here = entries.findIndex((e) => e.version === currentVersion);
  if (here === -1) return [];
  if (lastSeenVersion === null) return [];
  if (lastSeenVersion === currentVersion) return [];

  const seen = entries.findIndex((e) => e.version === lastSeenVersion);
  if (seen === -1) return [entries[here]!];
  if (seen <= here) return [];
  return entries.slice(here, seen);
}
