/**
 * Archive model — the user-progress document synced with qed2-server.
 * Canonical form follows the authoritative checksum spec
 * (QED2-checksum-spec.md, refining contract §5.4) EXACTLY:
 *
 *   - timestamps: ISO 8601 UTC, millisecond precision (Date#toISOString)
 *   - `grading`: null when unset — KEY RETAINED (never omitted)
 *   - `starred`: always present (false default)
 *   - `fsrs.lastReview`: null when never reviewed — KEY RETAINED
 *   - `lastResult`: OMITTED entirely when absent (never null)
 *   - floats (stability, difficulty, mastery, awardedPoints): rounded to
 *     6 decimals, half up, BEFORE serialization; reps/lapses are integers
 *   - perPart sorted by partId, perCompetency by code (code point order,
 *     never locale collation)
 *
 * Checksums are computed over this canonical form (sync/checksum.ts) and
 * must be byte-identical to the server's.
 */

/**
 * User-facing mastery grading (grading supplement §1). `unseen` is NOT a
 * stored value — it is the absence of a grading (entry missing or null).
 */
export type Grading = 'good' | 'careless' | 'meh' | 'baffled' | 'excluded';

export type GradingOrUnseen = Grading | 'unseen';

export interface FsrsState {
  /** Next review due, ISO 8601 UTC. */
  due: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  /** null while never reviewed — key retained in canonical form. */
  lastReview: string | null;
}

export interface LastResult {
  correct: boolean;
  awardedPoints: number;
  gradedAt: string;
}

export interface PartEntry {
  partId: string;
  /** Current mastery grading; null = no grading recorded ("unseen"). */
  grading: Grading | null;
  /** Bookmark flag (independent of grading). */
  starred: boolean;
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

const GRADING_VALUES: readonly string[] = ['good', 'careless', 'meh', 'baffled', 'excluded'];

export function isGrading(v: unknown): v is Grading {
  return typeof v === 'string' && GRADING_VALUES.includes(v);
}

/**
 * Float normalization (spec §5.1): 6-decimal round, half up — exactly the
 * reference implementation's `Math.round(n * 1e6) / 1e6`. Integers pass
 * through untouched. Non-finite numbers are data corruption.
 */
export function normNum(n: number, decimals = 6): number {
  if (!Number.isFinite(n)) throw new Error('non-finite number in archive');
  if (Number.isInteger(n)) return n;
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

/** Timestamp normalization (spec §5.4): always UTC `.SSSZ` via toISOString. */
export function normTime(t: string): string;
export function normTime(t: string | null | undefined): string | null;
export function normTime(t: string | null | undefined): string | null {
  if (t == null) return null;
  return new Date(t).toISOString();
}

/**
 * Normalize archive content into the canonical form shared with the server
 * (spec §2). Tolerates loose inputs (old stored archives without
 * grading/starred, undefined lastReview) — defaults are filled per spec.
 * Always returns fresh objects (never mutates the input).
 */
export function canonicalizeArchive(content: ArchiveContent): ArchiveContent {
  return {
    perPart: content.perPart
      .map((p): PartEntry => {
        const entry: PartEntry = {
          partId: String(p.partId),
          grading: isGrading(p.grading) ? p.grading : null,
          starred: p.starred === true,
          fsrs: {
            due: normTime(p.fsrs.due),
            stability: normNum(p.fsrs.stability),
            difficulty: normNum(p.fsrs.difficulty),
            reps: p.fsrs.reps,
            lapses: p.fsrs.lapses,
            lastReview: normTime(p.fsrs.lastReview),
          },
          updatedAt: normTime(p.updatedAt),
        };
        if (p.lastResult != null) {
          entry.lastResult = {
            correct: p.lastResult.correct === true,
            awardedPoints: normNum(p.lastResult.awardedPoints),
            gradedAt: normTime(p.lastResult.gradedAt),
          };
        }
        return entry;
      })
      .sort(byPartId),
    perCompetency: content.perCompetency
      .map(
        (c): CompetencyEntry => ({
          code: String(c.code),
          mastery: normNum(c.mastery),
          updatedAt: normTime(c.updatedAt),
        }),
      )
      .sort(byCode),
  };
}
