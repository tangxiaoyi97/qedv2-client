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
 * What the on-open dialog announces: the running version's notes, or nothing.
 *
 * Only the newest — someone opening the app wants to know what changed in
 * front of them, not to be handed a reading list. Everything older is one tap
 * away in the settings, which is where a history belongs.
 *
 * Returns an array because the dialog renders a list either way; here it is
 * empty or one long.
 *
 * Rules:
 *  - no entry for the running version → this build announces nothing
 *  - never seen anything → adopt silently; a fresh install is not an update
 *  - already seen this version → nothing
 *  - the seen version sits at or above this one in the index → nothing, so a
 *    rollback does not pop notes for a version you are moving away from
 *
 * Position in the index, never a version-string comparison: the index is
 * newest-first by construction (CHANGELOG.md is prepended to), which stays
 * correct across 1.9.7 → 1.10.0 and prereleases, where a hand-rolled semver
 * comparator would not.
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
  if (seen !== -1 && seen <= here) return [];
  return [entries[here]!];
}
