/**
 * Archive model — the user-progress document synced with qed2-server
 * (contract §4.2 / §5). The canonical form here matches the server's
 * normalization EXACTLY (qed2-server src/sync/archive.schema.ts):
 *
 *   - timestamps: ISO 8601 UTC, millisecond precision (Date#toISOString)
 *   - optional fields OMITTED when absent — never null
 *   - perPart sorted by partId, perCompetency by code (code point order)
 *
 * Checksums are computed over this canonical form (see sync/checksum.ts) and
 * must be byte-identical to the server's.
 */

export interface FsrsState {
  /** Next review due, ISO 8601 UTC. */
  due: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview?: string;
}

export interface LastResult {
  correct: boolean;
  awardedPoints: number;
  gradedAt: string;
}

export interface PartEntry {
  partId: string;
  fsrs: FsrsState;
  lastResult?: LastResult;
  /** Client-set at write time; drives LWW merging on the server. */
  updatedAt: string;
}

export interface CompetencyEntry {
  code: string;
  mastery: number;
  updatedAt: string;
}

/** Content that participates in checksums and merging. */
export interface ArchiveContent {
  perPart: PartEntry[];
  perCompetency: CompetencyEntry[];
}

/** Full server state shape (GET /me/state). */
export interface ServerArchiveState extends ArchiveContent {
  archiveVersion: number;
  checksum: string;
  updatedAt: string;
}

/** What the client persists locally (guests included). */
export interface LocalArchive {
  content: ArchiveContent;
  /**
   * Server archiveVersion seen at the last successful sync.
   * 0 = never synced (fresh server archives start at version 0).
   */
  baseVersion: number;
}

export const EMPTY_ARCHIVE_CONTENT: ArchiveContent = { perPart: [], perCompetency: [] };

export const byPartId = (a: PartEntry, b: PartEntry): number =>
  a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0;

export const byCode = (a: CompetencyEntry, b: CompetencyEntry): number =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

/**
 * Normalize archive content into the canonical form shared with the server:
 * sorted arrays, `toISOString()` timestamps, absent optionals omitted.
 * Always returns fresh objects (never mutates the input).
 */
export function canonicalizeArchive(content: ArchiveContent): ArchiveContent {
  const iso = (v: string): string => new Date(v).toISOString();
  return {
    perPart: content.perPart
      .map((p): PartEntry => {
        const fsrs: FsrsState = {
          due: iso(p.fsrs.due),
          stability: p.fsrs.stability,
          difficulty: p.fsrs.difficulty,
          reps: p.fsrs.reps,
          lapses: p.fsrs.lapses,
        };
        if (p.fsrs.lastReview != null) fsrs.lastReview = iso(p.fsrs.lastReview);
        const entry: PartEntry = { partId: p.partId, fsrs, updatedAt: iso(p.updatedAt) };
        if (p.lastResult != null) {
          entry.lastResult = {
            correct: p.lastResult.correct,
            awardedPoints: p.lastResult.awardedPoints,
            gradedAt: iso(p.lastResult.gradedAt),
          };
        }
        return entry;
      })
      .sort(byPartId),
    perCompetency: content.perCompetency
      .map((c): CompetencyEntry => ({ code: c.code, mastery: c.mastery, updatedAt: iso(c.updatedAt) }))
      .sort(byCode),
  };
}
