/**
 * Local archive store — the single durable progress document.
 *
 * PROFILE SEMANTICS: the local archive is ONE shared document regardless of
 * login state (contract: guest progress merges into an account via sync, and
 * login/logout must NEVER clear it). It therefore lives under one fixed key.
 * The profileId constructor arg is kept for future flexibility only; it does
 * not change the storage location today.
 *
 * GRADING SEMANTICS (grading supplement §1): every FSRS advance is driven by
 * a Grading value. Objective grading auto-derives it (correct→good,
 * partial→meh, incorrect→baffled); a manual pick always overrides — within
 * the same answer event that means REPLACING the auto advance, so
 * applyGrade returns the pre-advance FSRS snapshot for setGrading to rebase
 * on. `excluded` freezes the part completely (§1.4).
 */
import { STORAGE } from '../ports/index.js';
import type { StoragePort } from '../ports/index.js';
import { canonicalizeArchive, normNum } from '../model/archive.js';
import type {
  CompetencyEntry,
  FsrsState,
  Grading,
  LocalArchive,
  PartEntry,
} from '../model/archive.js';
import type { Verdict } from '../grading/types.js';
import type { RecommendUserState } from '../api/types.js';
import { archiveChecksum } from '../sync/checksum.js';
import {
  advanceFsrsForGrading,
  verdictToAutoGrading,
  placeholderFsrs,
  isPartDue,
  isPracticed,
  updateMastery,
  EXCLUDED_DUE_SENTINEL,
} from '../fsrs/index.js';

/** Single shared archive document — see profile semantics above. */
const ARCHIVE_KEY = 'current';

export interface ApplyGradeInput {
  partId: string;
  /** Competency codes attached to the graded part (each gets a mastery update). */
  competencyCodes: string[];
  verdict: Verdict;
  awardedPoints: number;
  maxPoints: number;
  now: Date;
}

export interface ApplyGradeResult {
  archive: LocalArchive;
  /** The part's grading recorded by this event (auto-derived). */
  grading: Grading;
  /**
   * FSRS state BEFORE this grade advanced it (undefined = first contact).
   * Manual re-grading of the same answer event rebases on this snapshot so
   * the auto advance is replaced, not stacked.
   */
  previousFsrs: FsrsState | undefined;
}

export interface SetGradingInput {
  partId: string;
  grading: Grading;
  now: Date;
  /**
   * When re-grading the same answer event: the pre-answer FSRS snapshot
   * (from ApplyGradeResult.previousFsrs) to rebase on. Omit for standalone
   * manual grading (list view, later sessions) — then the advance starts
   * from the current state.
   */
  baseFsrs?: FsrsState | undefined;
}

export class ArchiveStore {
  constructor(
    private readonly storage: StoragePort,
    /** Reserved for future multi-profile support; unused today (see above). */
    private readonly profileId: string = 'guest',
  ) {}

  async load(): Promise<LocalArchive> {
    const stored = await this.storage.get<LocalArchive>(STORAGE.archive, ARCHIVE_KEY);
    if (!stored) return { content: { perPart: [], perCompetency: [] }, baseVersion: 0 };
    return this.migrate(stored);
  }

  /**
   * Migration: archives written before the grading upgrade lack
   * grading/starred and used key-omitted lastReview. canonicalizeArchive
   * fills the shape; the grading itself is derived from lastResult so
   * previously practiced parts keep meaningful dots (correct→good,
   * partial→meh, wrong→baffled) instead of appearing unseen.
   */
  private migrate(archive: LocalArchive): LocalArchive {
    const needsMigration = archive.content.perPart.some(
      (p) => (p as Partial<PartEntry>).grading === undefined || (p as Partial<PartEntry>).starred === undefined,
    );
    if (!needsMigration) return archive;
    const content = canonicalizeArchive(archive.content);
    for (const p of content.perPart) {
      if (p.grading === null && p.lastResult) {
        p.grading = p.lastResult.correct ? 'good' : p.lastResult.awardedPoints > 0 ? 'meh' : 'baffled';
      }
    }
    return { content, baseVersion: archive.baseVersion };
  }

  async save(archive: LocalArchive): Promise<void> {
    await this.storage.set(STORAGE.archive, ARCHIVE_KEY, archive);
  }

  // NOTE: no reset()/clear() on purpose — login/logout must never clear the
  // local archive (iron rule); the only way content leaves is via sync merge.

  /**
   * Record one graded part: derive the auto grading from the verdict,
   * advance FSRS through the grading map, stamp lastResult, and update the
   * mastery EMA of every attached competency. All timestamps come from the
   * injected `now` (grading itself is pure and clock-free).
   */
  async applyGrade(input: ApplyGradeInput): Promise<ApplyGradeResult> {
    const archive = await this.load();
    const nowIso = input.now.toISOString();
    const grading = verdictToAutoGrading(input.verdict);

    const perPart = [...archive.content.perPart];
    const partIdx = perPart.findIndex((p) => p.partId === input.partId);
    const prev = partIdx >= 0 ? perPart[partIdx] : undefined;
    const previousFsrs = prev && isPracticed(prev) ? prev.fsrs : undefined;
    const entry: PartEntry = {
      partId: input.partId,
      grading,
      starred: prev?.starred ?? false,
      fsrs: advanceFsrsForGrading(previousFsrs, grading, input.now),
      lastResult: {
        correct: input.verdict === 'correct',
        awardedPoints: normNum(input.awardedPoints),
        gradedAt: nowIso,
      },
      updatedAt: nowIso,
    };
    if (partIdx >= 0) perPart[partIdx] = entry;
    else perPart.push(entry);

    const ratio = input.maxPoints > 0 ? input.awardedPoints / input.maxPoints : 0;
    const perCompetency = [...archive.content.perCompetency];
    for (const code of input.competencyCodes) {
      const compIdx = perCompetency.findIndex((c) => c.code === code);
      const prevMastery = compIdx >= 0 ? perCompetency[compIdx]?.mastery : undefined;
      const next: CompetencyEntry = {
        code,
        mastery: updateMastery(prevMastery, ratio),
        updatedAt: nowIso,
      };
      if (compIdx >= 0) perCompetency[compIdx] = next;
      else perCompetency.push(next);
    }

    const updated: LocalArchive = {
      content: { perPart, perCompetency },
      baseVersion: archive.baseVersion,
    };
    await this.save(updated);
    return { archive: updated, grading, previousFsrs };
  }

  /**
   * Manual grading (supplement §1.2 — always wins over the auto default).
   *
   * - With `baseFsrs` (same answer event): the advance is recomputed FROM
   *   THAT SNAPSHOT, replacing the auto advance entirely.
   * - Without: a standalone review event — advance from the current state.
   * - `excluded`: freeze — grading is stored, FSRS state kept untouched.
   * - Grading a part with no entry creates one (counts as a first review,
   *   except excluded, which creates a frozen reps-0 placeholder).
   */
  async setGrading(input: SetGradingInput): Promise<LocalArchive> {
    const archive = await this.load();
    const nowIso = input.now.toISOString();

    const perPart = [...archive.content.perPart];
    const partIdx = perPart.findIndex((p) => p.partId === input.partId);
    const prev = partIdx >= 0 ? perPart[partIdx] : undefined;

    let fsrs: FsrsState;
    if (input.grading === 'excluded') {
      fsrs = prev?.fsrs ?? placeholderFsrs(input.now);
    } else {
      const base =
        input.baseFsrs !== undefined
          ? input.baseFsrs
          : prev && isPracticed(prev)
            ? prev.fsrs
            : undefined;
      fsrs = advanceFsrsForGrading(base, input.grading, input.now);
    }

    const entry: PartEntry = {
      partId: input.partId,
      grading: input.grading,
      starred: prev?.starred ?? false,
      fsrs,
      updatedAt: nowIso,
    };
    if (prev?.lastResult) entry.lastResult = prev.lastResult;
    if (partIdx >= 0) perPart[partIdx] = entry;
    else perPart.push(entry);

    const updated: LocalArchive = {
      content: { perPart, perCompetency: archive.content.perCompetency },
      baseVersion: archive.baseVersion,
    };
    await this.save(updated);
    return updated;
  }

  /** Toggle the bookmark (independent of grading — supplement §2). */
  async setStarred(partId: string, starred: boolean, now: Date): Promise<LocalArchive> {
    const archive = await this.load();
    const nowIso = now.toISOString();

    const perPart = [...archive.content.perPart];
    const partIdx = perPart.findIndex((p) => p.partId === partId);
    const prev = partIdx >= 0 ? perPart[partIdx] : undefined;
    const entry: PartEntry = prev
      ? { ...prev, starred, updatedAt: nowIso }
      : {
          partId,
          grading: null,
          starred,
          fsrs: placeholderFsrs(now),
          updatedAt: nowIso,
        };
    if (partIdx >= 0) perPart[partIdx] = entry;
    else perPart.push(entry);

    const updated: LocalArchive = {
      content: { perPart, perCompetency: archive.content.perCompetency },
      baseVersion: archive.baseVersion,
    };
    await this.save(updated);
    return updated;
  }

  /** Server-identical checksum of the current local content. */
  async checksum(): Promise<string> {
    const archive = await this.load();
    return archiveChecksum(archive.content);
  }

  /**
   * Projection sent to POST /content/recommend.
   *
   * - reps-0 placeholders (starred/excluded without practice) are DROPPED —
   *   for core they must still count as unseen…
   * - …EXCEPT excluded placeholders, which are projected with a far-future
   *   due so core never offers them as new NOR as due review (supplement
   *   §1.4 — excluded is frozen out of every recommendation). Practiced
   *   excluded parts get the same far-future due.
   */
  async toUserState(): Promise<RecommendUserState> {
    const archive = await this.load();
    const perPart: RecommendUserState['perPart'] = [];
    for (const p of archive.content.perPart) {
      if (p.grading === 'excluded') {
        perPart.push({ partId: p.partId, fsrs: { ...p.fsrs, due: EXCLUDED_DUE_SENTINEL } });
      } else if (isPracticed(p)) {
        perPart.push({ partId: p.partId, fsrs: p.fsrs });
      }
    }
    return {
      perPart,
      perCompetency: archive.content.perCompetency.map((c) => ({ code: c.code, mastery: c.mastery })),
    };
  }

  /** Set of excluded partIds — for filtering recommendation results. */
  async excludedPartIds(): Promise<Set<string>> {
    const archive = await this.load();
    return new Set(archive.content.perPart.filter((p) => p.grading === 'excluded').map((p) => p.partId));
  }

  /** Dashboard counts: parts due for review now, and total parts practiced. */
  async dueCounts(now: Date): Promise<{ due: number; practiced: number }> {
    const archive = await this.load();
    const due = archive.content.perPart.filter((p) => isPartDue(p, now)).length;
    const practiced = archive.content.perPart.filter((p) => isPracticed(p)).length;
    return { due, practiced };
  }
}
